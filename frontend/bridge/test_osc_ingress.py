"""OSC control ingress, v4 payload encoding, and reply-path tests."""
from __future__ import annotations

import asyncio

import pytest
from pythonosc.osc_message_builder import OscMessageBuilder
from pythonosc.osc_packet import OscPacket

from osc_ingress import (
    ControlRequest,
    OscIngress,
    OscIngressError,
    actuator_line,
    encode_wire_params,
    parse_control_request,
)
import serial_bridge


UID = "FACE0005"
ADDRESS = f"/hex/control/{UID}/actuator"


def _packet(args: list[object], address: str = ADDRESS) -> bytes:
    builder = OscMessageBuilder(address=address)
    for value in args:
        if type(value) is int:
            builder.add_arg(value, "i")
        elif type(value) is float:
            builder.add_arg(value, "f")
        else:
            builder.add_arg(value, "s")
    return builder.build().dgram


def _decode(data: bytes) -> tuple[str, list[object]]:
    message = OscPacket(data).messages[0].message
    return message.address, list(message.params)


class ReplyReceiver(asyncio.DatagramProtocol):
    def __init__(self):
        self.messages: list[tuple[str, list[object]]] = []

    def datagram_received(self, data: bytes, _remote) -> None:
        self.messages.append(_decode(data))


def test_v4_semantic_params_encode_to_current_wire_contracts():
    assert encode_wire_params(1, [255, 40, 5, 1000]) == (
        255, 40, 5, 0, 0, 3, 232, 0)
    assert encode_wire_params(16, [80, 150]) == (80, 0, 0, 0, 150, 0)
    assert encode_wire_params(17, [70, 100, 50, 3]) == (70, 10, 5, 3, 0)
    assert encode_wire_params(18, [20, 90, 500]) == (20, 90, 0, 0, 1, 244, 0)
    assert encode_wire_params(48, [440, 90, 250]) == (
        184, 1, 90, 0, 0, 0, 250, 0)
    assert encode_wire_params(64, [2, 2, 200, 1500]) == (2, 2, 200, 5, 220)
    assert encode_wire_params(0, []) == ()


def test_request_id_is_preserved_in_correlated_ao_command():
    request = parse_control_request(
        ADDRESS, ["req-42", 64, 1, 1, 180, 2000], {UID})
    assert request.request_id == "req-42"
    assert request.uid == UID
    assert request.cmd == 64
    assert request.params == (1, 1, 180, 2000)
    assert request.serial_line == (
        "$AO req-42 FACE0005 64 1 1 180 7 208\n")


def test_legacy_command_gets_generated_request_id():
    request = parse_control_request(
        ADDRESS, [1, 255, 40, 5], {UID}, generated_id="legacy-9")
    assert request.legacy_id
    assert request.request_id == "legacy-9"
    assert actuator_line(ADDRESS, [0], {UID}).startswith("$AO legacy-1 ")


@pytest.mark.parametrize(
    ("address", "args", "error"),
    [
        ("/hex/control/FACE0005/other", ["r", 0], "address"),
        ("/hex/control/DEADBEEF/actuator", ["r", 0], "unknown UID"),
        (ADDRESS, [], "command"),
        (ADDRESS, ["bad id", 0], "request_id"),
        (ADDRESS, ["r", 99], "unsupported"),
        (ADDRESS, ["r", 1, 255, 0], "expects"),
        (ADDRESS, ["r", 1, 255.0, 0, 0], "integers"),
        (ADDRESS, ["r", 16, 101], "intensity"),
        (ADDRESS, ["r", 64, 3, 1, 100, 0], "motor"),
        (ADDRESS, ["r", 64, 1, 3, 100, 0], "mode"),
    ],
)
def test_invalid_controls_are_rejected(address, args, error):
    with pytest.raises(OscIngressError, match=error):
        parse_control_request(address, args, {UID})


@pytest.mark.asyncio
async def test_real_udp_request_receives_queued_routed_and_state_replies():
    requests: list[ControlRequest] = []
    ingress = OscIngress(
        host="127.0.0.1", port=0,
        known_uids=lambda: {UID}, enqueue=requests.append)
    await ingress.start()
    loop = asyncio.get_running_loop()
    receiver = ReplyReceiver()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: receiver, local_addr=("127.0.0.1", 0))
    client_port = transport.get_extra_info("sockname")[1]
    try:
        transport.sendto(
            _packet(["req-udp", 1, 255, 40, 5]),
            ("127.0.0.1", ingress.port))
        await asyncio.sleep(0.05)
        assert len(requests) == 1
        assert requests[0].remote == ("127.0.0.1", client_port)
        assert receiver.messages[0] == (
            f"/hex/control/{UID}/ack", ["req-udp", "queued", "accepted"])

        assert ingress.result("req-udp", ok=True, stage="routed",
                              detail="route=sent")
        assert ingress.state("req-udp", {
            "type": "actuator_state", "uid": UID,
            "cmd": 1, "confirmed": True,
        })
        await asyncio.sleep(0.05)
        assert receiver.messages[1] == (
            f"/hex/control/{UID}/ack",
            ["req-udp", "routed", "route=sent"])
        state_addr, state_args = receiver.messages[2]
        assert state_addr == f"/hex/control/{UID}/state"
        assert state_args[0] == "req-udp"
        assert '"confirmed":true' in state_args[1]
    finally:
        transport.close()
        await ingress.stop()


@pytest.mark.asyncio
async def test_rejected_packet_returns_nack_and_never_enqueues():
    requests: list[ControlRequest] = []
    ingress = OscIngress(
        host="127.0.0.1", port=0,
        known_uids=lambda: {UID}, enqueue=requests.append)
    await ingress.start()
    loop = asyncio.get_running_loop()
    receiver = ReplyReceiver()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: receiver, local_addr=("127.0.0.1", 0))
    try:
        transport.sendto(
            _packet(["bad-motor", 64, 3, 1, 200, 0]),
            ("127.0.0.1", ingress.port))
        await asyncio.sleep(0.05)
        assert requests == []
        assert ingress.rejected == 1
        assert receiver.messages[0][0] == f"/hex/control/{UID}/nack"
        assert receiver.messages[0][1][:2] == ["bad-motor", "rejected"]
    finally:
        transport.close()
        await ingress.stop()


@pytest.mark.asyncio
async def test_bridge_simulator_closes_request_with_state_and_applied_ack():
    for mapping in (
        serial_bridge.sim_modules, serial_bridge.modules_by_uid,
        serial_bridge.module_types_by_uid, serial_bridge.uid_by_slot,
        serial_bridge.slot_by_uid, serial_bridge.actuator_cache_by_uid,
    ):
        mapping.clear()
    serial_bridge.osc_control_pending.clear()
    while not serial_bridge.serial_write_queue.empty():
        serial_bridge.serial_write_queue.get_nowait()

    module = serial_bridge.SimModule("led")
    serial_bridge.sim_modules[module.slot] = module
    ingress = serial_bridge.create_osc_ingress(port=0)
    serial_bridge.osc_ingress = ingress
    await ingress.start()
    loop = asyncio.get_running_loop()
    receiver = ReplyReceiver()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: receiver, local_addr=("127.0.0.1", 0))
    try:
        transport.sendto(
            _packet(["bridge-e2e", 1, 10, 20, 30]),
            ("127.0.0.1", ingress.port))
        line = await asyncio.wait_for(
            serial_bridge.serial_write_queue.get(), timeout=0.5)
        assert line == (
            "$AO bridge-e2e FACE0005 1 10 20 30 0 0 0 0 0\n")
        serial_bridge._parse_sim_command(line)
        await asyncio.sleep(0.08)

        addresses = [address for address, _args in receiver.messages]
        assert addresses.count(f"/hex/control/{UID}/ack") == 3
        assert f"/hex/control/{UID}/state" in addresses
        ack_stages = [args[1] for address, args in receiver.messages
                      if address.endswith("/ack")]
        assert ack_stages == ["queued", "routed", "applied"]
        assert "bridge-e2e" not in serial_bridge.osc_control_pending
        assert module.led["r"] == 10 and module.led["g"] == 20
        assert module.led["b"] == 30
    finally:
        transport.close()
        await ingress.stop()
        serial_bridge.osc_ingress = None
        serial_bridge.osc_control_pending.clear()
        serial_bridge.sim_modules.clear()


def test_non_loopback_bind_requires_explicit_permission():
    with pytest.raises(OscIngressError, match="loopback"):
        OscIngress(host="0.0.0.0", port=7001,
                   known_uids=lambda: {UID}, enqueue=lambda _request: None)


@pytest.mark.asyncio
async def test_request_is_registered_before_enqueue_and_removed_on_failure():
    registered_during_enqueue: list[bool] = []
    ingress: OscIngress

    def observe(request: ControlRequest):
        registered_during_enqueue.append(
            request.request_id in ingress._requests)

    ingress = OscIngress(
        host="127.0.0.1", port=0,
        known_uids=lambda: {UID}, enqueue=observe)
    await ingress.handle_datagram(
        _packet(["immediate", 0]), ("127.0.0.1", 12345))
    assert registered_during_enqueue == [True]
    assert ingress.accepted == 1

    def fail(_request: ControlRequest):
        raise RuntimeError("queue closed")

    failed = OscIngress(
        host="127.0.0.1", port=0,
        known_uids=lambda: {UID}, enqueue=fail)
    await failed.handle_datagram(
        _packet(["will-fail", 0]), ("127.0.0.1", 12345))
    assert failed.rejected == 1
    assert failed._requests == {}
