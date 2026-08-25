"""OSC actuator ingress contract and real UDP regression tests."""
from __future__ import annotations

import asyncio

import pytest
from pythonosc.osc_message_builder import OscMessageBuilder
from pythonosc.udp_client import SimpleUDPClient

from osc_ingress import OscIngress, OscIngressError, actuator_line
import serial_bridge


UID = "FACE0005"
ADDRESS = f"/hex/control/{UID}/actuator"


def _packet(address: str = ADDRESS, args: list[object] | None = None) -> bytes:
    builder = OscMessageBuilder(address=address)
    for value in args or []:
        if type(value) is int:
            builder.add_arg(value, "i")
        elif type(value) is float:
            builder.add_arg(value, "f")
        else:
            builder.add_arg(value)
    return builder.build().dgram


def test_actuator_line_accepts_documented_commands():
    known = {UID}
    assert actuator_line(ADDRESS, [0], known) == f"$A {UID} 0\n"
    assert actuator_line(ADDRESS, [1, 255, 40, 5], known) == (
        f"$A {UID} 1 255 40 5\n"
    )
    assert actuator_line(ADDRESS, [16, 80, 0, 150], known) == (
        f"$A {UID} 16 80 0 150\n"
    )
    assert actuator_line(ADDRESS, [17, 70, 10, 10, 3], known) == (
        f"$A {UID} 17 70 10 10 3\n"
    )
    assert actuator_line(ADDRESS, [19], known) == f"$A {UID} 19\n"
    assert actuator_line(ADDRESS, [48, 184, 1, 90], known) == (
        f"$A {UID} 48 184 1 90\n"
    )
    assert actuator_line(ADDRESS, [49], known) == f"$A {UID} 49\n"


@pytest.mark.parametrize(
    ("address", "args", "error"),
    [
        ("/hex/control/FACE0005/other", [0], "address"),
        ("/hex/control/NOTAUID/actuator", [0], "address"),
        ("/hex/control/DEADBEEF/actuator", [0], "unknown UID"),
        (ADDRESS, [], "command"),
        (ADDRESS, [99], "unsupported"),
        (ADDRESS, [1, 255, 0], "expects 3"),
        (ADDRESS, [0, 1], "expects 0"),
        (ADDRESS, [1, 255.0, 0, 0], "integers"),
        (ADDRESS, [1, 256, 0, 0], "0..255"),
        (ADDRESS, [17, 1, 2, 3, 4, 5], "expects 4"),
    ],
)
def test_actuator_line_rejects_invalid_packets(address, args, error):
    with pytest.raises(OscIngressError, match=error):
        actuator_line(address, args, {UID})


@pytest.mark.asyncio
async def test_real_udp_packet_reaches_enqueue_callback():
    received: list[str] = []
    ingress = OscIngress(
        host="127.0.0.1",
        port=0,
        known_uids=lambda: {UID},
        enqueue=received.append,
    )
    await ingress.start()
    try:
        client = SimpleUDPClient("127.0.0.1", ingress.port)
        client.send_message(ADDRESS, [1, 255, 40, 5])
        await asyncio.sleep(0.08)
        assert received == [f"$A {UID} 1 255 40 5\n"]
        assert ingress.accepted == 1
        assert ingress.rejected == 0
    finally:
        await ingress.stop()


@pytest.mark.asyncio
async def test_rejected_real_udp_packets_never_reach_queue():
    received: list[str] = []
    ingress = OscIngress(
        host="127.0.0.1",
        port=0,
        known_uids=lambda: {UID},
        enqueue=received.append,
    )
    await ingress.start()
    try:
        client = SimpleUDPClient("127.0.0.1", ingress.port)
        client.send_message(ADDRESS, [1, 300, 0, 0])
        client.send_message(ADDRESS, [17, 70, 10])
        client.send_message("/hex/control/DEADBEEF/actuator", [0])
        transport = ingress._transport
        transport.sendto(b"not osc", ("127.0.0.1", ingress.port))
        await asyncio.sleep(0.1)
        assert received == []
        assert ingress.accepted == 0
        assert ingress.rejected == 4
    finally:
        await ingress.stop()


@pytest.mark.asyncio
async def test_non_loopback_sender_is_rejected_before_enqueue():
    received: list[str] = []
    ingress = OscIngress(
        host="127.0.0.1",
        port=0,
        known_uids=lambda: {UID},
        enqueue=received.append,
    )

    await ingress.handle_datagram(_packet(args=[0]), ("192.0.2.20", 9000))

    assert received == []
    assert ingress.rejected == 1
    assert "non-loopback" in ingress.last_error


def test_non_loopback_bind_requires_explicit_permission():
    with pytest.raises(OscIngressError, match="loopback"):
        OscIngress(
            host="0.0.0.0",
            port=7001,
            known_uids=lambda: {UID},
            enqueue=lambda _line: None,
        )


@pytest.mark.asyncio
async def test_serial_bridge_factory_enqueues_on_shared_write_queue(monkeypatch):
    while not serial_bridge.serial_write_queue.empty():
        serial_bridge.serial_write_queue.get_nowait()
    monkeypatch.setitem(serial_bridge.modules_by_uid, UID, "ledv1")
    ingress = serial_bridge.create_osc_ingress(port=0)
    await ingress.start()
    try:
        SimpleUDPClient("127.0.0.1", ingress.port).send_message(ADDRESS, [0])
        line = await asyncio.wait_for(serial_bridge.serial_write_queue.get(), 0.5)
        assert line == f"$A {UID} 0\n"
    finally:
        await ingress.stop()
