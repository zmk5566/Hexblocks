#!/usr/bin/env python3
"""WearBlocks bridge OSC forwarder.

Embedded UDP/OSC sink that subscribes to the bridge's `broadcast(msg)` stream
and fans messages out to one or more user-configured creative-coding hosts
(TouchDesigner, Max/MSP, Pd, Unity).

Design:
- Per-target asyncio queue (maxsize=256) + consumer task. The hot path
  `forward(msg)` is non-blocking (`put_nowait`) and drops the oldest entry
  on overflow so a stalled / unreachable target cannot back up the bridge's
  200 Hz IMU broadcast.
- Mappings are user-editable (source_pattern → OSC address, scale, offset).
  Default rows come from the live hub schema (no static catalog fallback).
- Settings persist as JSON under `~/.wearblocks/osc_targets.json` and apply
  live on add/update/remove.
- UDP only (no TCP/SLIP); per-channel messages only (no bundling) - sensor
  wire format is already one channel per `$S` line.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import socket
import time
import uuid
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, Iterable

try:
    from pythonosc.udp_client import SimpleUDPClient
except ImportError:  # pragma: no cover - surfaced at import time
    SimpleUDPClient = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

CONFIG_PATH = Path.home() / ".wearblocks" / "osc_targets.json"
QUEUE_MAXSIZE = 256
STATS_INTERVAL_S = 1.0
FORWARDABLE_TYPES = ("sensor", "actuator_state")
DNS_RESOLVE_TIMEOUT_S = 2.0


# ── Host resolution + loopback policy ──────────────────────────────

def _resolve_host(host: str, port: int) -> str:
    """Resolve `host` to an IPv4/IPv6 literal with a short timeout.

    Raises OSError on failure. Uses socket.getaddrinfo with a global
    socket timeout so a slow DNS server can't stall add()/update().
    """
    old_to = socket.getdefaulttimeout()
    socket.setdefaulttimeout(DNS_RESOLVE_TIMEOUT_S)
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_DGRAM)
    finally:
        socket.setdefaulttimeout(old_to)
    if not infos:
        raise OSError(f"no address for host {host!r}")
    # Prefer IPv4 if available (matches SimpleUDPClient default behaviour).
    for fam, _t, _p, _c, sockaddr in infos:
        if fam == socket.AF_INET:
            return sockaddr[0]
    return infos[0][4][0]


def _is_loopback(ip: str) -> bool:
    try:
        return ipaddress.ip_address(ip).is_loopback
    except ValueError:
        return False


# ── Dataclasses ────────────────────────────────────────────────────

@dataclass(frozen=True)
class OscMapping:
    """One source-to-address mapping inside an OSC target.

    `source_pattern` is a slash-delimited string with `*` wildcard support:
        "sensor/<uid>/<channel_id>"   e.g. "sensor/FACE0003/0", "sensor/*/0"
        "actuator/<uid>"              e.g. "actuator/FACE0005", "actuator/*"

    UID is the hub's 8-hex module identifier (the same value carried on every
    $H/$D/$S/$X line). Slot is intentionally absent: it's a hub-internal
    concept that doesn't appear on the v2 wire protocol, and the sim's local
    slot numbering should not leak into the OSC addressing surface.
    """
    source_pattern: str
    address: str
    scale: float = 1.0
    offset: float = 0.0


@dataclass(frozen=True)
class OscTarget:
    id: str
    host: str
    port: int
    enabled: bool = True
    # `sensors_filter` is a coarse pre-queue gate. Empty list = pass all
    # sensor messages. Entries may be sensor-type strings ("imu", "hr") or
    # slot ints (encoded as int in JSON).
    sensors_filter: tuple = ()
    actuators_enabled: bool = False
    mappings: tuple = ()  # tuple[OscMapping, ...]
    rate_limit_hz: float = 0.0  # 0 = unlimited; applied per OSC address


def _target_from_dict(d: dict) -> OscTarget:
    raw_maps = d.get("mappings") or []
    maps = tuple(OscMapping(**m) for m in raw_maps)
    return OscTarget(
        id=str(d.get("id") or uuid.uuid4()),
        host=str(d["host"]),
        port=int(d["port"]),
        enabled=bool(d.get("enabled", True)),
        sensors_filter=tuple(d.get("sensors_filter") or ()),
        actuators_enabled=bool(d.get("actuators_enabled", False)),
        mappings=maps,
        rate_limit_hz=float(d.get("rate_limit_hz", 0.0)),
    )


def _target_to_dict(t: OscTarget) -> dict:
    return {
        "id": t.id,
        "host": t.host,
        "port": t.port,
        "enabled": t.enabled,
        "sensors_filter": list(t.sensors_filter),
        "actuators_enabled": t.actuators_enabled,
        "mappings": [asdict(m) for m in t.mappings],
        "rate_limit_hz": t.rate_limit_hz,
    }


# ── Filter + match helpers ─────────────────────────────────────────

def _coarse_match(target: OscTarget, msg: dict) -> bool:
    """Return True iff this target subscribes to this msg type at all."""
    mtype = msg.get("type")
    if mtype == "sensor":
        if target.sensors_filter:
            sensor_type = msg.get("sensor")
            slot = msg.get("slot")
            for entry in target.sensors_filter:
                if entry == sensor_type or entry == slot:
                    return True
            return False
        return True
    if mtype == "actuator_state":
        return target.actuators_enabled
    return False


def _msg_to_source_keys(msg: dict) -> list[str]:
    """Render a forwardable msg as one or more concrete source keys.

    Each `$S` arrives as a single-channel sensor message and yields exactly
    one key. `actuator_state` yields one key per module.
    """
    mtype = msg.get("type")
    if mtype == "sensor":
        uid = msg.get("uid")
        ch = msg.get("channel_id")
        uid_tok = "*" if not uid else str(uid)
        if ch is None:
            return []
        return [f"sensor/{uid_tok}/{ch}"]
    if mtype == "actuator_state":
        uid = msg.get("uid")
        uid_tok = "*" if not uid else str(uid)
        return [f"actuator/{uid_tok}"]
    return []


def _pattern_matches(pattern: str, key: str) -> bool:
    """Glob-style match with `*` wildcard per slash segment."""
    p_parts = pattern.split("/")
    k_parts = key.split("/")
    if len(p_parts) != len(k_parts):
        return False
    for p, k in zip(p_parts, k_parts):
        if p != "*" and p != k:
            return False
    return True


def _msg_value(msg: dict) -> float | None:
    """Extract a scalar payload from a forwardable msg, or None to skip."""
    mtype = msg.get("type")
    if mtype == "sensor":
        v = msg.get("value")
        return None if v is None else float(v)
    if mtype == "actuator_state":
        # Actuator state lacks a single canonical scalar — emit cmd code so
        # the receiver can at least see "something fired". Richer field
        # forwarding can come later; out of v1 scope.
        cmd = msg.get("cmd")
        return None if cmd is None else float(cmd)
    return None


# ── Auto-populate from live schema ─────────────────────────────────

def load_channel_catalog(path: Path) -> dict:
    """Load `frontend/channel_catalog.json`. Returns the parsed dict.

    Raises `FileNotFoundError`/`OSError`/`json.JSONDecodeError` on failure —
    callers (auto-populate handler) should swallow + surface as an osc_error
    so a malformed catalog doesn't crash the bridge.
    """
    return json.loads(Path(path).read_text())


def schema_to_default_mappings(
    modules_by_uid: dict,
    module_types_by_uid: dict,
    catalog: dict,
) -> list[OscMapping]:
    """Generate one OscMapping per (uid, channel) currently plugged in.

    `catalog` is the parsed `channel_catalog.json`:
        {"channels": {"BPM": {"id": 24, "label": "bpm"}, ...},
         "sensor_capabilities": {"hr": ["BPM", "SPO2", ...], ...},
         "actuator_capabilities": {"led": [...], "vibration": [...], ...}}

    Default OSC address: `/hex/<sensor_type>/<uid>/<channel_label>` for sensor
    modules, `/hex/<sensor_type>/<uid>` for actuators (led/vibration/audio).
    Module types unknown to the catalog are skipped silently — the user
    can still add manual rows in the UI.
    """
    channels = catalog.get("channels", {})
    sensor_caps = catalog.get("sensor_capabilities", {})
    actuator_caps = set(catalog.get("actuator_capabilities", {}).keys())

    rows: list[OscMapping] = []
    for uid in modules_by_uid:
        sensor_type = module_types_by_uid.get(uid)
        if not sensor_type:
            continue
        if sensor_type in actuator_caps:
            rows.append(OscMapping(
                source_pattern=f"actuator/{uid}",
                address=f"/hex/{sensor_type}/{uid}",
                scale=1.0,
                offset=0.0,
            ))
            continue
        names = sensor_caps.get(sensor_type, [])
        for ch_name in names:
            entry = channels.get(ch_name)
            if entry is None:
                continue
            ch_id = int(entry["id"])
            label = entry.get("label") or ch_name.lower()
            rows.append(OscMapping(
                source_pattern=f"sensor/{uid}/{ch_id}",
                address=f"/hex/{sensor_type}/{uid}/{label}",
                scale=1.0,
                offset=0.0,
            ))
    return rows


# ── Per-target worker ──────────────────────────────────────────────

class OscWorker:
    def __init__(self, target: OscTarget, resolved_ip: str | None = None):
        self.target = target
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
        self._client: Any = None
        # `resolved_ip` is an already-resolved IP literal (see OscForwarder.add).
        # If None, fall back to the host string so unit-test paths that bypass
        # add() still construct a usable client.
        ip_for_client = resolved_ip if resolved_ip else target.host
        if SimpleUDPClient is not None:
            try:
                self._client = SimpleUDPClient(ip_for_client, target.port)
            except Exception as e:
                logger.error("[osc] %s:%d client init failed: %r",
                             target.host, target.port, e)
        # Stats. Updated by the consumer; read by the forwarder snapshot.
        self.sent = 0
        self.dropped = 0
        self.last_err: str | None = None
        # Per-address last-send timestamps for rate limiting.
        self._last_send: dict[str, float] = {}
        # Sliding 1-second send count for Hz reporting.
        # NOTE: unbounded between stats reads; bridge calls hz() at 1 Hz so it
        # self-prunes. Skip W3 fix for this pass.
        self._send_window: list[float] = []
        self._loop: asyncio.AbstractEventLoop | None = None

    def hz(self) -> float:
        now = time.monotonic()
        self._send_window = [t for t in self._send_window if now - t < 1.0]
        return float(len(self._send_window))

    async def run(self) -> None:
        self._loop = asyncio.get_running_loop()
        while True:
            try:
                msg = await self.queue.get()
            except asyncio.CancelledError:
                return
            try:
                await self._dispatch(msg)
            except Exception as e:  # never let a bad msg kill the worker
                self.last_err = repr(e)
                logger.warning("[osc] %s:%d dispatch failed: %r",
                               self.target.host, self.target.port, e)

    async def _dispatch(self, msg: dict) -> None:
        if self._client is None:
            return
        keys = _msg_to_source_keys(msg)
        if not keys:
            return
        value = _msg_value(msg)
        if value is None:
            return
        rate = self.target.rate_limit_hz
        now = time.monotonic()
        for key in keys:
            for m in self.target.mappings:
                if not _pattern_matches(m.source_pattern, key):
                    continue
                if rate > 0:
                    last = self._last_send.get(m.address, 0.0)
                    if (now - last) < (1.0 / rate):
                        continue
                await self._send(m, value, now)

    async def _send(self, m: OscMapping, value: float, now: float) -> None:
        out = value * m.scale + m.offset
        # UDP sendto on an unreachable host can stall the calling thread for
        # tens to hundreds of ms (kernel routing / ICMP). Offload to the
        # default executor so it never blocks the asyncio loop driving the
        # 200 Hz IMU broadcast.
        loop = self._loop or asyncio.get_running_loop()
        try:
            await loop.run_in_executor(
                None, self._client.send_message, m.address, out)
        except OSError as e:
            self.last_err = repr(e)
            return
        except Exception as e:  # pythonosc can raise non-OSError too
            self.last_err = repr(e)
            return
        self.sent += 1
        self._last_send[m.address] = now
        self._send_window.append(now)


# ── Forwarder (singleton, owned by serial_bridge) ──────────────────

class OscForwarder:
    def __init__(self, config_path: Path = CONFIG_PATH,
                 allow_remote: bool = False):
        self.config_path = config_path
        # When False (default), only loopback OSC targets are accepted. The
        # bridge runs as an open WebSocket on 0.0.0.0, so any LAN client
        # could otherwise turn this forwarder into a UDP reflector with
        # attacker-controlled OSC payload. Flip via --osc-allow-remote on
        # the bridge CLI when you actually need cross-host forwarding.
        self.allow_remote = allow_remote
        self._targets: dict[str, OscTarget] = {}
        self._workers: dict[str, OscWorker] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    # ── Lifecycle ────────────────────────────────────────────────

    async def start(self) -> None:
        """Bind to current loop and spawn workers from saved config."""
        self._loop = asyncio.get_running_loop()
        for t in self._load_from_disk():
            try:
                ip = _resolve_host(t.host, t.port)
            except OSError as e:
                logger.error("[osc] skipping saved target %s:%d — DNS failed: %r",
                             t.host, t.port, e)
                continue
            if not self.allow_remote and not _is_loopback(ip):
                logger.error("[osc] skipping saved target %s:%d — non-loopback "
                             "and --osc-allow-remote not set", t.host, t.port)
                continue
            self._spawn(t, resolved_ip=ip)

    async def stop(self) -> None:
        for tid in list(self._tasks):
            self._cancel(tid)
        self._targets.clear()
        self._workers.clear()
        self._tasks.clear()

    # ── Mutation API ─────────────────────────────────────────────

    def _check_host_policy(self, host: str, port: int) -> tuple[str | None, str | None]:
        """Resolve `host` and apply loopback policy.

        Returns (resolved_ip, None) on accept, (None, error_message) on
        refusal. Error strings are surfaced back to the WS panel.
        """
        try:
            ip = _resolve_host(host, port)
        except OSError as e:
            return None, f"could not resolve host {host!r}: {e}"
        if not self.allow_remote and not _is_loopback(ip):
            return None, (f"non-loopback target {host!r} ({ip}) refused — "
                          "start the bridge with --osc-allow-remote to enable")
        return ip, None

    def add(self, target_dict: dict) -> tuple[OscTarget | None, str | None]:
        """Add a target. Returns (target, None) or (None, error_message)."""
        host = str(target_dict.get("host", "")).strip()
        port = int(target_dict.get("port", 0))
        if not host or port <= 0:
            return None, "host and port required"
        ip, err = self._check_host_policy(host, port)
        if err is not None:
            return None, err
        target = _target_from_dict({**target_dict,
                                     "id": target_dict.get("id") or str(uuid.uuid4())})
        self._spawn(target, resolved_ip=ip)
        self._save_to_disk()
        return target, None

    def update(self, tid: str, target_dict: dict) -> tuple[OscTarget | None, str | None]:
        if tid not in self._targets:
            return None, "unknown target id"
        host = str(target_dict.get("host", "")).strip()
        port = int(target_dict.get("port", 0))
        if not host or port <= 0:
            return None, "host and port required"
        ip, err = self._check_host_policy(host, port)
        if err is not None:
            return None, err
        merged = {**target_dict, "id": tid}
        target = _target_from_dict(merged)
        self._cancel(tid)
        self._spawn(target, resolved_ip=ip)
        self._save_to_disk()
        return target, None

    def remove(self, tid: str) -> bool:
        if tid not in self._targets:
            return False
        self._cancel(tid)
        self._save_to_disk()
        return True

    def auto_populate(self, tid: str, mappings: Iterable[OscMapping]) -> OscTarget | None:
        if tid not in self._targets:
            return None
        existing = self._targets[tid]
        merged = replace(existing, mappings=tuple(mappings))
        target, _err = self.update(tid, _target_to_dict(merged))
        return target

    # ── Hot path ────────────────────────────────────────────────

    def forward(self, msg: dict) -> None:
        """Synchronous, non-blocking dispatch from broadcast()."""
        mtype = msg.get("type")
        if mtype not in FORWARDABLE_TYPES:
            return
        for tid, target in self._targets.items():
            if not target.enabled:
                continue
            if not _coarse_match(target, msg):
                continue
            worker = self._workers.get(tid)
            if worker is None:
                continue
            try:
                worker.queue.put_nowait(msg)
            except asyncio.QueueFull:
                # Drop oldest (real-time stream — stale frames are useless).
                try:
                    worker.queue.get_nowait()
                    worker.dropped += 1
                except asyncio.QueueEmpty:
                    pass
                try:
                    worker.queue.put_nowait(msg)
                except asyncio.QueueFull:
                    worker.dropped += 1

    # ── Snapshots for WS broadcast ───────────────────────────────

    def snapshot(self) -> list[dict]:
        return [_target_to_dict(t) for t in self._targets.values()]

    def stats_snapshot(self) -> dict[str, dict]:
        return {
            tid: {
                "sent": w.sent,
                "dropped": w.dropped,
                "hz": w.hz(),
                "last_err": w.last_err,
            }
            for tid, w in self._workers.items()
        }

    # ── Internals ────────────────────────────────────────────────

    def _spawn(self, target: OscTarget, resolved_ip: str | None = None) -> None:
        worker = OscWorker(target, resolved_ip=resolved_ip)
        self._targets[target.id] = target
        self._workers[target.id] = worker
        if self._loop is not None:
            self._tasks[target.id] = self._loop.create_task(worker.run())

    def _cancel(self, tid: str) -> None:
        task = self._tasks.pop(tid, None)
        if task is not None and not task.done():
            task.cancel()
        self._targets.pop(tid, None)
        self._workers.pop(tid, None)

    def _load_from_disk(self) -> list[OscTarget]:
        try:
            if not self.config_path.exists():
                return []
            data = json.loads(self.config_path.read_text())
        except Exception as e:
            logger.error("[osc] failed to read %s: %r", self.config_path, e)
            return []
        if not isinstance(data, list):
            return []
        # Wrap each row separately so one corrupt entry does not drop all
        # targets — common after a hand-edit or schema change.
        out: list[OscTarget] = []
        for i, d in enumerate(data):
            try:
                out.append(_target_from_dict(d))
            except Exception as e:
                logger.warning("[osc] config row %d skipped: %r (row=%r)",
                               i, e, d)
        return out

    def _save_to_disk(self) -> None:
        try:
            self.config_path.parent.mkdir(parents=True, exist_ok=True)
            self.config_path.write_text(json.dumps(self.snapshot(), indent=2))
        except Exception as e:
            logger.error("[osc] failed to save %s: %r", self.config_path, e)
