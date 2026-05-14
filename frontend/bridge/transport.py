"""Transport abstraction for the WearBlocks bridge.

Both USB-CDC serial and BLE GATT (Nordic UART Service) speak the same
$-prefixed line protocol. This module exposes a uniform `Transport`
interface so `serial_bridge.py` can drive either one with the same loop.

USB and BLE are mutually exclusive at runtime — only one transport is
active at a time. Switching transports tears down the previous one
cleanly before opening the next.

NUS UUIDs (Nordic UART Service) — used by the hub firmware:
  service  6E400001-B5A3-F393-E0A9-E50E24DCCA9E
  RX char  6E400002-B5A3-F393-E0A9-E50E24DCCA9E   host → hub  (write)
  TX char  6E400003-B5A3-F393-E0A9-E50E24DCCA9E   hub  → host  (notify)
"""
from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from typing import Optional

import serial_io


# Nordic UART Service — de-facto standard for "serial over BLE".
NUS_SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
NUS_RX_CHAR_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  # host → hub
NUS_TX_CHAR_UUID = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # hub  → host

# Default scan window when the frontend asks for a device list.
DEFAULT_SCAN_DURATION_S = 5.0
BLE_FALLBACK_WRITE_CHUNK = 20
BLE_MAX_WRITE_CHUNK = 180


class Transport(ABC):
    """Common interface for serial and BLE transports.

    Implementations are async-friendly: `read_line()` is awaitable and
    yields one line (without trailing newline) or returns None when the
    underlying link is closed/dropped. `write()` is awaitable and accepts
    raw bytes (caller is responsible for line termination).
    """

    name: str          # "serial" | "ble"
    address: str       # port path or BLE MAC/UUID
    label: str         # human-readable: "USB cu.usbmodem…" or "HEX-A3F2"

    @abstractmethod
    async def open(self) -> bool:
        """Open the link. Return True on success."""

    @abstractmethod
    async def close(self) -> None:
        """Best-effort close. Safe to call multiple times."""

    @abstractmethod
    async def read_line(self) -> Optional[str]:
        """Return next line (decoded str, no trailing newline) or None
        on EOF / disconnect / unrecoverable error."""

    @abstractmethod
    async def write(self, data: bytes) -> None:
        """Send raw bytes to the hub. Caller adds '\\n' as needed."""

    @property
    @abstractmethod
    def is_open(self) -> bool:
        ...


# ── Serial backend ───────────────────────────────────────────────


class SerialTransport(Transport):
    """USB-CDC serial via pyserial. Blocking I/O is offloaded to the
    default executor so it cooperates with asyncio."""

    name = "serial"

    def __init__(self, port: str, baud: int = 115200):
        self.address = port
        self.label = f"USB {port.rsplit('/', 1)[-1]}"
        self._baud = baud
        self._ser = None
        self.last_error = None

    @property
    def is_open(self) -> bool:
        return self._ser is not None and getattr(self._ser, "is_open", False)

    async def open(self) -> bool:
        loop = asyncio.get_event_loop()
        ser = await loop.run_in_executor(
            None, lambda: serial_io.open_serial(self.address, self._baud, timeout=0.1))
        if ser is None:
            self.last_error = "open_failed"
            return False
        self._ser = ser
        self.last_error = None
        return True

    async def close(self) -> None:
        ser = self._ser
        self._ser = None
        if ser is None:
            return
        try:
            ser.close()
        except Exception:
            pass

    async def read_line(self) -> Optional[str]:
        if self._ser is None:
            return None
        loop = asyncio.get_event_loop()
        try:
            raw = await loop.run_in_executor(
                None, lambda: self._ser.readline().decode("utf-8", errors="replace"))
        except Exception as e:
            self.last_error = repr(e)
            return None
        if not raw:
            # Timeout — return empty string so caller can poll write queue
            return ""
        return raw

    async def write(self, data: bytes) -> None:
        if self._ser is None:
            return
        loop = asyncio.get_event_loop()
        try:
            await loop.run_in_executor(None, lambda: self._ser.write(data))
        except Exception as e:
            self.last_error = repr(e)
            raise


# ── BLE backend ──────────────────────────────────────────────────


class BleTransport(Transport):
    """BLE GATT central. Connects to a Nordic-UART-Service peripheral,
    subscribes to TX notifications, and writes to RX. `bleak` is imported
    lazily so users without it can still run the serial path."""

    name = "ble"

    def __init__(self, address: str, label: Optional[str] = None):
        self.address = address
        self.label = label or address
        self._client = None
        self._rx_queue: "asyncio.Queue[Optional[bytes]]" = asyncio.Queue(maxsize=4096)
        self._buf = bytearray()
        self._disconnected = False
        self.last_error = None

    @property
    def is_open(self) -> bool:
        return self._client is not None and not self._disconnected

    async def open(self) -> bool:
        try:
            from bleak import BleakClient
        except ImportError:
            print("[bridge] bleak not installed; pip install bleak")
            self.last_error = "bleak_not_installed"
            return False

        def _on_disconnect(_client):
            self._disconnected = True
            self.last_error = "ble_disconnect_callback"
            try:
                self._rx_queue.put_nowait(None)
            except asyncio.QueueFull:
                pass

        client = BleakClient(self.address, disconnected_callback=_on_disconnect)
        try:
            await client.connect()
        except Exception as e:
            print(f"[bridge] BLE connect failed for {self.address}: {e!r}")
            self.last_error = repr(e)
            return False
        if not client.is_connected:
            self.last_error = "ble_connect_returned_false"
            return False

        async def _on_notify(_char, data: bytearray):
            try:
                self._rx_queue.put_nowait(bytes(data))
            except asyncio.QueueFull:
                # Drop oldest to keep up — visualization is best-effort
                try:
                    self._rx_queue.get_nowait()
                    self._rx_queue.put_nowait(bytes(data))
                except Exception:
                    pass

        try:
            await client.start_notify(NUS_TX_CHAR_UUID, _on_notify)
        except Exception as e:
            print(f"[bridge] BLE notify subscribe failed: {e!r}")
            self.last_error = repr(e)
            try:
                await client.disconnect()
            except Exception:
                pass
            return False

        self._client = client
        self._disconnected = False
        self.last_error = None
        return True

    async def close(self) -> None:
        client = self._client
        self._client = None
        self._disconnected = True
        if client is None:
            return
        try:
            await client.stop_notify(NUS_TX_CHAR_UUID)
        except Exception:
            pass
        try:
            await client.disconnect()
        except Exception:
            pass
        # Wake any pending reader.
        try:
            self._rx_queue.put_nowait(None)
        except Exception:
            pass

    async def read_line(self) -> Optional[str]:
        # Pull complete '\n'-terminated lines out of the rolling buffer.
        while True:
            nl = self._buf.find(b"\n")
            if nl >= 0:
                line = bytes(self._buf[: nl + 1])
                del self._buf[: nl + 1]
                return line.decode("utf-8", errors="replace")
            if self._disconnected and not self._rx_queue.qsize():
                return None
            try:
                chunk = await asyncio.wait_for(self._rx_queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                # Match SerialTransport semantics — empty string lets the
                # outer loop service the write queue.
                return ""
            if chunk is None:
                # Flush any trailing partial line (best-effort) then EOF.
                if self._buf:
                    line = bytes(self._buf)
                    self._buf.clear()
                    if not line.endswith(b"\n"):
                        line += b"\n"
                    return line.decode("utf-8", errors="replace")
                return None
            self._buf.extend(chunk)

    def _write_chunk_size(self) -> int:
        if self._client is None:
            return BLE_FALLBACK_WRITE_CHUNK
        try:
            char = self._client.services.get_characteristic(NUS_RX_CHAR_UUID)
            size = int(getattr(char, "max_write_without_response_size", 0) or 0)
            if size > 0:
                return max(BLE_FALLBACK_WRITE_CHUNK,
                           min(BLE_MAX_WRITE_CHUNK, size))
        except Exception:
            pass
        return BLE_FALLBACK_WRITE_CHUNK

    async def write(self, data: bytes) -> None:
        if self._client is None or self._disconnected:
            return
        try:
            # NUS is conventionally driven with write-without-response.
            # Keep writes chunked for long commands, but avoid response=True:
            # some macOS/Bleak + ESP32 NimBLE combinations disconnect on the
            # first response write even though WRITE is advertised.
            chunk_size = self._write_chunk_size()
            for off in range(0, len(data), chunk_size):
                await self._client.write_gatt_char(
                    NUS_RX_CHAR_UUID, data[off: off + chunk_size],
                    response=False)
                if len(data) > chunk_size:
                    await asyncio.sleep(0.01)
        except Exception as e:
            print(f"[bridge] BLE write failed: {e!r}")
            self.last_error = repr(e)
            self._disconnected = True
            raise


# ── Discovery helpers ────────────────────────────────────────────


async def ble_scan(duration: float = DEFAULT_SCAN_DURATION_S,
                   name_prefix: str = "HEX-"):
    """Scan for advertising BLE peripherals. Yields dicts with
    {address, name, rssi}. Filters to advertisements whose name starts
    with `name_prefix` (set to '' to disable)."""
    try:
        from bleak import BleakScanner
    except ImportError:
        print("[bridge] bleak not installed; pip install bleak")
        return []

    devices = await BleakScanner.discover(timeout=duration, return_adv=True)
    out = []
    for addr, (dev, adv) in devices.items():
        name = (dev.name or adv.local_name or "") or ""
        if name_prefix and not name.startswith(name_prefix):
            continue
        out.append({
            "address": addr,
            "name": name,
            "rssi": getattr(adv, "rssi", None) or getattr(dev, "rssi", None) or 0,
        })
    # Strongest signal first.
    out.sort(key=lambda d: d["rssi"], reverse=True)
    return out
