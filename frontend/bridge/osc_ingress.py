#!/usr/bin/env python3
"""Loopback OSC actuator ingress for the HexBlocks bridge.

Accepted packets are converted to the existing hub command surface and passed
to an injected enqueue callback. This module never writes to USB or BLE.
"""
from __future__ import annotations

import asyncio
import inspect
import ipaddress
import re
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

from pythonosc.osc_packet import OscPacket, ParseError


MAX_PACKET_BYTES = 1024
ACTUATOR_ADDRESS = re.compile(r"^/hex/control/([0-9A-Fa-f]{8})/actuator$")
COMMAND_PARAM_COUNTS = {
    0: 0,   # LED off
    1: 3,   # LED solid: R G B
    16: 3,  # vibration tap: intensity duration_hi duration_lo
    17: 4,  # vibration pulse: intensity on_10ms off_10ms count
    19: 0,  # vibration stop
    48: 3,  # audio tone: freq_lo freq_hi amplitude
    49: 0,  # audio stop
}

Enqueue = Callable[[str], Awaitable[None] | None]
KnownUids = Callable[[], Iterable[str]]
ErrorHandler = Callable[[str], None]


class OscIngressError(ValueError):
    """Rejected OSC actuator packet or unsafe ingress configuration."""


def _is_loopback(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def actuator_line(address: str, arguments: list[Any], known_uids: Iterable[str]) -> str:
    """Validate one actuator OSC message and return its `$A` serial line."""
    match = ACTUATOR_ADDRESS.fullmatch(address)
    if match is None:
        raise OscIngressError("OSC actuator address must be /hex/control/<uid>/actuator")
    uid = match.group(1).upper()
    known = {str(value).upper() for value in known_uids}
    if uid not in known:
        raise OscIngressError(f"unknown UID: {uid}")
    if not arguments:
        raise OscIngressError("OSC actuator command argument is required")
    if type(arguments[0]) is not int:
        raise OscIngressError("OSC actuator command and parameters must be integers")
    command = arguments[0]
    expected = COMMAND_PARAM_COUNTS.get(command)
    if expected is None:
        raise OscIngressError(f"unsupported actuator command: {command}")
    params = arguments[1:]
    if len(params) != expected:
        raise OscIngressError(
            f"actuator command {command} expects {expected} parameters; got {len(params)}"
        )
    if any(type(value) is not int for value in params):
        raise OscIngressError("OSC actuator command and parameters must be integers")
    if any(value < 0 or value > 255 for value in params):
        raise OscIngressError("OSC actuator parameters must be in 0..255")
    suffix = "" if not params else " " + " ".join(str(value) for value in params)
    return f"$A {uid} {command}{suffix}\n"


class _OscIngressProtocol(asyncio.DatagramProtocol):
    def __init__(self, ingress: "OscIngress") -> None:
        self.ingress = ingress

    def datagram_received(self, data: bytes, address: tuple[str, int]) -> None:
        asyncio.create_task(self.ingress.handle_datagram(data, address))

    def error_received(self, error: Exception) -> None:
        self.ingress._reject(f"UDP receive error: {error}")


class OscIngress:
    """Validated OSC/UDP input that feeds the bridge serial command queue."""

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        port: int = 7001,
        known_uids: KnownUids,
        enqueue: Enqueue,
        allow_remote: bool = False,
        on_error: ErrorHandler | None = None,
    ) -> None:
        if not isinstance(port, int) or port < 0 or port > 65_535:
            raise OscIngressError("OSC ingress port must be an integer in 0..65535")
        if not allow_remote and not _is_loopback(host):
            raise OscIngressError("OSC ingress host must be loopback unless remote access is enabled")
        self.host = host
        self.port = port
        self.known_uids = known_uids
        self.enqueue = enqueue
        self.allow_remote = allow_remote
        self.on_error = on_error
        self.accepted = 0
        self.rejected = 0
        self.last_error = ""
        self._transport: asyncio.DatagramTransport | None = None

    async def start(self) -> None:
        if self._transport is not None:
            return
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            lambda: _OscIngressProtocol(self),
            local_addr=(self.host, self.port),
        )
        self._transport = transport
        socket_name = transport.get_extra_info("sockname")
        self.port = int(socket_name[1])

    async def stop(self) -> None:
        if self._transport is None:
            return
        self._transport.close()
        self._transport = None
        await asyncio.sleep(0)

    def _reject(self, message: str) -> None:
        self.rejected += 1
        self.last_error = message
        if self.on_error is not None:
            self.on_error(message)

    async def handle_datagram(self, data: bytes, remote: tuple[str, int]) -> None:
        if not self.allow_remote and not _is_loopback(remote[0]):
            self._reject(f"rejected non-loopback OSC sender: {remote[0]}")
            return
        if len(data) > MAX_PACKET_BYTES:
            self._reject(f"OSC packet exceeds {MAX_PACKET_BYTES} bytes")
            return
        try:
            packet = OscPacket(data)
            messages = packet.messages
            if len(messages) != 1:
                raise OscIngressError("OSC ingress accepts exactly one message per packet")
            message = messages[0].message
            line = actuator_line(message.address, message.params, self.known_uids())
        except (ParseError, OscIngressError, ValueError, TypeError) as error:
            self._reject(str(error) or error.__class__.__name__)
            return

        result = self.enqueue(line)
        if inspect.isawaitable(result):
            await result
        self.accepted += 1
