#!/usr/bin/env python3
"""Validated, reply-capable OSC actuator ingress for the WearBlocks bridge.

The bridge already exposes a UID-keyed ``$A`` command surface.  This module
adds a small OSC contract around it without bypassing the normal simulator,
USB, BLE, Hub routing, or Wi-Fi fallback paths.

Request (preferred form)::

    /hex/control/<uid>/actuator  <request_id:str> <cmd:int> <semantic ints...>

For compatibility, callers may omit ``request_id`` and start with ``cmd``;
the ingress generates an ID. Replies are unicast to the UDP sender::

    /hex/control/<uid>/ack   request_id, stage, detail
    /hex/control/<uid>/nack  request_id, stage, reason
    /hex/control/<uid>/state request_id, JSON state
"""
from __future__ import annotations

import asyncio
import inspect
import ipaddress
import json
import re
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any

from pythonosc.osc_message_builder import OscMessageBuilder
from pythonosc.osc_packet import OscPacket, ParseError


MAX_PACKET_BYTES = 1024
MAX_REQUEST_ID_LEN = 64
ACTUATOR_ADDRESS = re.compile(r"^/hex/control/([0-9A-Fa-f]{8})/actuator$")
REQUEST_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")

Enqueue = Callable[["ControlRequest"], Awaitable[None] | None]
KnownUids = Callable[[], Iterable[str]]
ErrorHandler = Callable[[str], None]


class OscIngressError(ValueError):
    """Rejected OSC actuator packet or unsafe ingress configuration."""


@dataclass(frozen=True)
class ControlRequest:
    request_id: str
    uid: str
    cmd: int
    params: tuple[int, ...]
    wire_params: tuple[int, ...]
    remote: tuple[str, int]
    created_at: float
    legacy_id: bool = False

    @property
    def serial_line(self) -> str:
        suffix = "" if not self.wire_params else " " + " ".join(
            str(value) for value in self.wire_params)
        # $AO is the request-ID-bearing form of the Hub's existing $A
        # actuator command. It runs through the same dispatcher but gives the
        # bridge an unambiguous result even when WS and OSC controls interleave.
        return f"$AO {self.request_id} {self.uid} {self.cmd}{suffix}\n"


def _is_loopback(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def _require_ints(values: list[Any]) -> list[int]:
    if any(type(value) is not int for value in values):
        raise OscIngressError("OSC actuator command and parameters must be integers")
    return [int(value) for value in values]


def _expect(params: list[int], allowed: tuple[int, ...], label: str) -> None:
    if len(params) not in allowed:
        choices = " or ".join(str(value) for value in allowed)
        raise OscIngressError(
            f"{label} expects {choices} semantic parameters; got {len(params)}")


def _in_range(value: int, lo: int, hi: int, label: str) -> int:
    if value < lo or value > hi:
        raise OscIngressError(f"{label} must be in {lo}..{hi}")
    return value


def _be32(value: int) -> tuple[int, int, int, int]:
    return ((value >> 24) & 0xFF, (value >> 16) & 0xFF,
            (value >> 8) & 0xFF, value & 0xFF)


def _be16(value: int) -> tuple[int, int]:
    return ((value >> 8) & 0xFF, value & 0xFF)


def encode_wire_params(command: int, params: list[int]) -> tuple[int, ...]:
    """Translate current ECA-v4 semantic parameters to module wire bytes."""
    if command in (0, 6, 19, 49):  # LED off/stop, vibration stop, audio stop
        _expect(params, (0,), f"actuator command {command}")
        return ()

    if command == 1:  # LED solid: R G B [duration_ms]
        _expect(params, (3, 4), "LED_SOLID")
        red, green, blue = (
            _in_range(value, 0, 255, name)
            for value, name in zip(params[:3], ("red", "green", "blue")))
        duration = _in_range(params[3], 0, 0xFFFFFFFF, "duration_ms") \
            if len(params) == 4 else 0
        return (red, green, blue, *_be32(duration), 0)

    if command == 16:  # VIBRATE: intensity [duration_ms]
        _expect(params, (1, 2), "VIBRATE")
        intensity = _in_range(params[0], 0, 100, "intensity")
        duration = _in_range(params[1], 0, 0xFFFFFFFF, "duration_ms") \
            if len(params) == 2 else 200
        return (intensity, *_be32(duration), 0)

    if command == 17:  # VIBRATE_PULSE: intensity on_ms off_ms count
        _expect(params, (4,), "VIBRATE_PULSE")
        intensity = _in_range(params[0], 0, 100, "intensity")
        on_ms = _in_range(params[1], 1, 2550, "on_ms")
        off_ms = _in_range(params[2], 1, 2550, "off_ms")
        count = _in_range(params[3], 1, 255, "count")
        on_10ms = min(255, (on_ms + 9) // 10)
        off_10ms = min(255, (off_ms + 9) // 10)
        return (intensity, on_10ms, off_10ms, count, 0)

    if command == 18:  # VIBRATE_RAMP: from_pct to_pct [duration_ms]
        _expect(params, (2, 3), "VIBRATE_RAMP")
        start = _in_range(params[0], 0, 100, "from_pct")
        end = _in_range(params[1], 0, 100, "to_pct")
        duration = _in_range(params[2], 0, 0xFFFFFFFF, "duration_ms") \
            if len(params) == 3 else 1000
        return (start, end, *_be32(duration), 0)

    if command == 48:  # AUDIO_SET_TONE: frequency_hz amplitude [duration_ms]
        _expect(params, (2, 3), "AUDIO_SET_TONE")
        frequency = _in_range(params[0], 0, 65535, "frequency_hz")
        amplitude = _in_range(params[1], 0, 255, "amplitude")
        duration = _in_range(params[2], 0, 0xFFFFFFFF, "duration_ms") \
            if len(params) == 3 else 0
        return (frequency & 0xFF, (frequency >> 8) & 0xFF, amplitude,
                *_be32(duration), 0)

    if command == 64:  # MOTOR_SET: motor mode speed duration_ms
        _expect(params, (4,), "MOTOR_SET")
        motor = _in_range(params[0], 1, 2, "motor")
        mode = _in_range(params[1], 0, 2, "mode")
        speed = _in_range(params[2], 0, 255, "speed")
        duration = _in_range(params[3], 0, 65535, "duration_ms")
        return (motor, mode, speed, *_be16(duration))

    raise OscIngressError(f"unsupported actuator command: {command}")


def parse_control_request(
    address: str,
    arguments: list[Any],
    known_uids: Iterable[str],
    remote: tuple[str, int] = ("127.0.0.1", 0),
    generated_id: str = "legacy-1",
) -> ControlRequest:
    match = ACTUATOR_ADDRESS.fullmatch(address)
    if match is None:
        raise OscIngressError("OSC actuator address must be /hex/control/<uid>/actuator")
    uid = match.group(1).upper()
    known = {str(value).upper() for value in known_uids}
    if uid not in known:
        raise OscIngressError(f"unknown UID: {uid}")
    if not arguments:
        raise OscIngressError("OSC actuator command argument is required")

    legacy = type(arguments[0]) is int
    if legacy:
        request_id = generated_id
        raw = arguments
    else:
        if type(arguments[0]) is not str or not REQUEST_ID.fullmatch(arguments[0]):
            raise OscIngressError(
                "request_id must contain only letters, digits, _, ., :, or -")
        request_id = arguments[0]
        raw = arguments[1:]
    ints = _require_ints(list(raw))
    if not ints:
        raise OscIngressError("OSC actuator command argument is required")
    command = ints[0]
    params = ints[1:]
    wire = encode_wire_params(command, params)
    return ControlRequest(
        request_id=request_id,
        uid=uid,
        cmd=command,
        params=tuple(params),
        wire_params=wire,
        remote=remote,
        created_at=time.monotonic(),
        legacy_id=legacy,
    )


def actuator_line(address: str, arguments: list[Any], known_uids: Iterable[str]) -> str:
    """Compatibility helper used by callers that only need the serial line."""
    return parse_control_request(address, arguments, known_uids).serial_line


class _OscIngressProtocol(asyncio.DatagramProtocol):
    def __init__(self, ingress: "OscIngress") -> None:
        self.ingress = ingress

    def datagram_received(self, data: bytes, address: tuple[str, int]) -> None:
        asyncio.create_task(self.ingress.handle_datagram(data, address))

    def error_received(self, error: Exception) -> None:
        self.ingress._reject(f"UDP receive error: {error}")


class OscIngress:
    """OSC input that feeds the bridge queue and replies to each sender."""

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
            raise OscIngressError(
                "OSC ingress host must be loopback unless remote access is enabled")
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
        self._sequence = 0
        self._requests: dict[str, ControlRequest] = {}

    async def start(self) -> None:
        if self._transport is not None:
            return
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            lambda: _OscIngressProtocol(self), local_addr=(self.host, self.port))
        self._transport = transport
        socket_name = transport.get_extra_info("sockname")
        self.port = int(socket_name[1])

    async def stop(self) -> None:
        if self._transport is None:
            return
        self._transport.close()
        self._transport = None
        self._requests.clear()
        await asyncio.sleep(0)

    def _next_id(self) -> str:
        self._sequence = (self._sequence + 1) & 0xFFFFFFFF
        return f"legacy-{self._sequence}"

    def _reject(self, message: str) -> None:
        self.rejected += 1
        self.last_error = message
        if self.on_error is not None:
            self.on_error(message)

    def _send(self, remote: tuple[str, int], address: str, arguments: list[Any]) -> bool:
        if self._transport is None or not remote[1]:
            return False
        builder = OscMessageBuilder(address=address)
        for argument in arguments:
            if type(argument) is int:
                builder.add_arg(argument, "i")
            elif type(argument) is float:
                builder.add_arg(argument, "f")
            else:
                builder.add_arg(str(argument), "s")
        self._transport.sendto(builder.build().dgram, remote)
        return True

    def _reply(self, request: ControlRequest, kind: str,
               stage: str, detail: str) -> bool:
        address = f"/hex/control/{request.uid}/{kind}"
        return self._send(
            request.remote, address, [request.request_id, stage, detail])

    def result(self, request_id: str, *, ok: bool,
               stage: str, detail: str) -> bool:
        request = self._requests.get(request_id)
        if request is None:
            return False
        return self._reply(request, "ack" if ok else "nack", stage, detail)

    def state(self, request_id: str, state: dict[str, Any]) -> bool:
        request = self._requests.get(request_id)
        if request is None:
            return False
        payload = json.dumps(state, separators=(",", ":"), ensure_ascii=True)
        address = f"/hex/control/{request.uid}/state"
        return self._send(request.remote, address, [request.request_id, payload])

    def forget(self, request_id: str) -> None:
        self._requests.pop(request_id, None)

    async def handle_datagram(self, data: bytes, remote: tuple[str, int]) -> None:
        if not self.allow_remote and not _is_loopback(remote[0]):
            self._reject(f"rejected non-loopback OSC sender: {remote[0]}")
            return
        if len(data) > MAX_PACKET_BYTES:
            self._reject(f"OSC packet exceeds {MAX_PACKET_BYTES} bytes")
            return
        request: ControlRequest | None = None
        registered = False
        try:
            packet = OscPacket(data)
            messages = packet.messages
            if len(messages) != 1:
                raise OscIngressError("OSC ingress accepts exactly one message per packet")
            message = messages[0].message
            request = parse_control_request(
                message.address, message.params, self.known_uids(), remote,
                generated_id=self._next_id())
            if request.request_id in self._requests:
                raise OscIngressError(f"duplicate request_id: {request.request_id}")
            # Register before invoking the queue seam so a fast simulator or
            # test double can correlate an immediate result safely.
            self._requests[request.request_id] = request
            registered = True
            result = self.enqueue(request)
            if inspect.isawaitable(result):
                await result
        except Exception as error:
            if registered and request is not None:
                self._requests.pop(request.request_id, None)
            message_text = str(error) or error.__class__.__name__
            self._reject(message_text)
            request_id = "unknown"
            uid = "UNKNOWN"
            try:
                if 'message' in locals():
                    match = ACTUATOR_ADDRESS.fullmatch(message.address)
                    if match:
                        uid = match.group(1).upper()
                    if message.params and type(message.params[0]) is str:
                        request_id = message.params[0][:MAX_REQUEST_ID_LEN]
            except Exception:
                pass
            self._send(remote, f"/hex/control/{uid}/nack",
                       [request_id, "rejected", message_text])
            return

        self.accepted += 1
        self._reply(request, "ack", "queued", "accepted")
