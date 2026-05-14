"""Tests for osc_forwarder.py.

Run with:  python -m pytest frontend/bridge/test_osc_bridge.py -v

Spins up a real asyncio UDP listener on 127.0.0.1:<ephemeral_port> for each
case so we exercise the end-to-end pythonosc path instead of mocking
SimpleUDPClient. Slow-consumer cases are simulated by stalling the worker
queue, not by holding the UDP socket.
"""
from __future__ import annotations

import asyncio
import json
import socket
import struct
import time

import pytest

from pathlib import Path

from osc_forwarder import (
    OscForwarder,
    OscMapping,
    OscTarget,
    OscWorker,
    _coarse_match,
    _msg_to_source_keys,
    _pattern_matches,
    load_channel_catalog,
    schema_to_default_mappings,
)

REAL_CATALOG_PATH = Path(__file__).resolve().parent.parent / "channel_catalog.json"


# ── UDP listener helper ────────────────────────────────────────────

class OscRx(asyncio.DatagramProtocol):
    """Tiny OSC parser — single-message, float32 arg, no bundles."""

    def __init__(self):
        self.received: list[tuple[str, float]] = []

    def datagram_received(self, data: bytes, addr) -> None:
        self.received.append(self._parse(data))

    @staticmethod
    def _parse(data: bytes) -> tuple[str, float]:
        # OSC: address (null-padded to 4) + type tag (",f" padded) + 4-byte float
        idx = data.index(b"\x00")
        address = data[:idx].decode("ascii")
        # round up to next multiple of 4 after the null
        addr_end = (idx + 4) & ~3
        # type tag starts at addr_end, e.g. b",f\x00\x00"
        tag_end = addr_end + 4
        value = struct.unpack(">f", data[tag_end:tag_end + 4])[0]
        return address, float(value)


async def _listener_on_free_port():
    loop = asyncio.get_running_loop()
    rx = OscRx()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: rx, local_addr=("127.0.0.1", 0))
    port = transport.get_extra_info("sockname")[1]
    return rx, transport, port


async def _drain(timeout=0.2):
    """Yield the loop a few times so queued sends actually leave the socket."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        await asyncio.sleep(0.01)


# ── Pure-function tests (no socket) ────────────────────────────────

def test_pattern_matches_exact_and_wildcard():
    assert _pattern_matches("sensor/FACE0003/0", "sensor/FACE0003/0")
    assert _pattern_matches("sensor/*/0", "sensor/FACE0003/0")
    assert _pattern_matches("sensor/FACE0003/*", "sensor/FACE0003/9")
    assert _pattern_matches("sensor/*/*", "sensor/FACE0003/9")
    assert not _pattern_matches("sensor/FACE0003/0", "sensor/FACE0003/1")
    assert not _pattern_matches("sensor/FACE0003", "sensor/FACE0003/0")
    assert not _pattern_matches("actuator/FACE0003", "sensor/FACE0003/0")


def test_msg_to_source_keys():
    assert _msg_to_source_keys({"type": "sensor", "uid": "FACE0003",
                                 "channel_id": 0, "value": 1.0}) == ["sensor/FACE0003/0"]
    # No uid (e.g., raw schema-less probe) → wildcard slot.
    assert _msg_to_source_keys({"type": "sensor",
                                 "channel_id": 5, "value": 1.0}) == ["sensor/*/5"]
    assert _msg_to_source_keys({"type": "actuator_state",
                                 "uid": "FACE0002", "cmd": 1}) == ["actuator/FACE0002"]
    assert _msg_to_source_keys({"type": "hello"}) == []


def test_coarse_match_sensors_filter():
    t = OscTarget(id="x", host="h", port=1, sensors_filter=("imu",))
    assert _coarse_match(t, {"type": "sensor", "sensor": "imu", "slot": 3})
    assert not _coarse_match(t, {"type": "sensor", "sensor": "hr", "slot": 3})
    # Empty filter passes all sensor msgs.
    t2 = OscTarget(id="x", host="h", port=1)
    assert _coarse_match(t2, {"type": "sensor", "sensor": "anything"})


def test_coarse_match_actuators_gate():
    t_off = OscTarget(id="x", host="h", port=1, actuators_enabled=False)
    t_on = OscTarget(id="x", host="h", port=1, actuators_enabled=True)
    msg = {"type": "actuator_state", "slot": 2, "cmd": 1}
    assert not _coarse_match(t_off, msg)
    assert _coarse_match(t_on, msg)


_MINI_CATALOG = {
    "channels": {
        "AX":      {"id": 0,  "label": "ax"},
        "AY":      {"id": 1,  "label": "ay"},
        "AZ":      {"id": 2,  "label": "az"},
        "BPM":     {"id": 24, "label": "bpm"},
        "SPO2":    {"id": 25, "label": "spo2"},
        "LIGHT":   {"id": 41, "label": "light"},
    },
    "sensor_capabilities": {
        "imu":   ["AX", "AY", "AZ"],
        "hr":    ["BPM", "SPO2"],
        "light": ["LIGHT"],
    },
    "actuator_capabilities": {
        "led":       ["led"],
        "vibration": ["vib"],
    },
}


def test_schema_to_default_mappings():
    modules_by_uid = {"FACE0003": "imu_v2", "FACE0005": "hr_v1"}
    module_types_by_uid = {"FACE0003": "imu", "FACE0005": "hr"}
    rows = schema_to_default_mappings(modules_by_uid, module_types_by_uid,
                                       _MINI_CATALOG)
    addresses = {m.address for m in rows}
    sources = {m.source_pattern for m in rows}
    assert "/hex/imu/FACE0003/ax" in addresses
    assert "/hex/imu/FACE0003/az" in addresses
    assert "/hex/hr/FACE0005/spo2" in addresses
    assert "sensor/FACE0003/0" in sources
    assert "sensor/FACE0005/25" in sources
    assert len(rows) == 5


def test_schema_uses_catalog_label_not_capability_first_field():
    """Light sensor must address as /hex/light/<uid>/light — not /.../ax.
    Regression: the previous SIM_CHANNEL_MAP-driven path put 'ax' here
    because sim's payload field name leaked into the OSC label.
    """
    rows = schema_to_default_mappings(
        {"FACE0010": "light_v1"}, {"FACE0010": "light"}, _MINI_CATALOG)
    assert len(rows) == 1
    assert rows[0].source_pattern == "sensor/FACE0010/41"
    assert rows[0].address == "/hex/light/FACE0010/light"


def test_schema_emits_actuator_row_for_led_and_vibration():
    """Actuator modules get a single actuator/<uid> row, not sensor channels."""
    rows = schema_to_default_mappings(
        {"FACE0007": "ledv1", "FACE0008": "vibv1", "FACE0009": "imuv2"},
        {"FACE0007": "led", "FACE0008": "vibration", "FACE0009": "imu"},
        _MINI_CATALOG)
    by_source = {m.source_pattern: m.address for m in rows}
    assert by_source["actuator/FACE0007"] == "/hex/led/FACE0007"
    assert by_source["actuator/FACE0008"] == "/hex/vibration/FACE0008"
    assert by_source["sensor/FACE0009/0"] == "/hex/imu/FACE0009/ax"
    # imu has 3 channels in mini catalog + 2 actuators = 5.
    assert len(rows) == 5


def test_schema_skips_modules_with_unknown_type():
    rows = schema_to_default_mappings(
        {"FACE0003": "imu_v2"}, {}, _MINI_CATALOG)
    assert rows == []


def test_real_catalog_drives_light_sensor_correctly():
    """End-to-end: parse the real shipped channel_catalog.json and verify
    a real-hardware light module produces the expected /hex/light/<uid>/light
    row instead of the historical /hex/light/<uid>/ax bug."""
    catalog = load_channel_catalog(REAL_CATALOG_PATH)
    rows = schema_to_default_mappings(
        {"009DA270": "lightv1"}, {"009DA270": "light"}, catalog)
    assert len(rows) == 1
    assert rows[0].source_pattern == "sensor/009DA270/41"
    assert rows[0].address == "/hex/light/009DA270/light"


# ── Integration: rename, scale, offset over real UDP ───────────────

@pytest.mark.asyncio
async def test_mapping_rename_scale_offset_end_to_end():
    rx, tr, port = await _listener_on_free_port()
    try:
        f = _make_forwarder_no_disk()
        await f.start()
        f.add({
            "host": "127.0.0.1", "port": port, "enabled": True,
            "sensors_filter": [], "actuators_enabled": False,
            "rate_limit_hz": 0.0,
            "mappings": [
                {"source_pattern": "sensor/FACE0003/0",
                 "address": "/td/hand/ax",
                 "scale": 2.0, "offset": 1.0},
            ],
        })
        f.forward({"type": "sensor", "sensor": "imu", "uid": "FACE0003",
                    "slot": 3, "channel_id": 0, "value": 0.5})
        await _drain(0.3)
        assert rx.received, "no OSC packet arrived"
        addr, val = rx.received[0]
        assert addr == "/td/hand/ax"
        assert abs(val - (0.5 * 2.0 + 1.0)) < 1e-6
        await f.stop()
    finally:
        tr.close()


@pytest.mark.asyncio
async def test_filter_drops_non_matching_sensor_type():
    rx, tr, port = await _listener_on_free_port()
    try:
        f = _make_forwarder_no_disk()
        await f.start()
        f.add({
            "host": "127.0.0.1", "port": port, "enabled": True,
            "sensors_filter": ["imu"], "actuators_enabled": False,
            "mappings": [
                {"source_pattern": "sensor/*/*",
                 "address": "/all", "scale": 1.0, "offset": 0.0},
            ],
        })
        f.forward({"type": "sensor", "sensor": "hr", "uid": "FACE0005",
                    "slot": 5, "channel_id": 10, "value": 80.0})
        f.forward({"type": "sensor", "sensor": "imu", "uid": "FACE0003",
                    "slot": 3, "channel_id": 0, "value": 1.0})
        await _drain(0.3)
        assert len(rx.received) == 1
        assert rx.received[0][0] == "/all"
        assert rx.received[0][1] == 1.0
        await f.stop()
    finally:
        tr.close()


@pytest.mark.asyncio
async def test_rate_limit_reduces_throughput():
    rx, tr, port = await _listener_on_free_port()
    try:
        f = _make_forwarder_no_disk()
        await f.start()
        f.add({
            "host": "127.0.0.1", "port": port, "enabled": True,
            "rate_limit_hz": 50.0,  # 20 ms minimum spacing per address
            "mappings": [
                {"source_pattern": "sensor/FACE0003/0", "address": "/x",
                 "scale": 1.0, "offset": 0.0},
            ],
        })
        # Push 100 frames as fast as we can — expect no more than ~3
        # to slip through within ~50 ms (rate cap + scheduling slack).
        for _ in range(100):
            f.forward({"type": "sensor", "sensor": "imu", "uid": "FACE0003",
                        "slot": 3, "channel_id": 0, "value": 1.0})
        await _drain(0.05)
        assert 1 <= len(rx.received) <= 5
        await f.stop()
    finally:
        tr.close()


@pytest.mark.asyncio
async def test_drop_oldest_increments_counter():
    f = _make_forwarder_no_disk()
    await f.start()
    t, err = f.add({
        "host": "127.0.0.1", "port": 9,  # discard port; we won't drain
        "enabled": True,
        "mappings": [{"source_pattern": "sensor/FACE0003/0", "address": "/x",
                       "scale": 1.0, "offset": 0.0}],
    })
    assert err is None
    worker = f._workers[t.id]
    # Cancel the consumer so the queue stalls.
    f._tasks[t.id].cancel()
    try:
        await f._tasks[t.id]
    except asyncio.CancelledError:
        pass
    msg = {"type": "sensor", "sensor": "imu", "uid": "FACE0003",
            "slot": 3, "channel_id": 0, "value": 1.0}
    # Push 2× queue capacity. Once full, every additional push trips
    # drop-oldest, so dropped >= QUEUE_MAXSIZE.
    for _ in range(600):
        f.forward(msg)
    assert worker.dropped > 0
    await f.stop()


# ── New tests: resilience, persistence, loopback policy ────────────

@pytest.mark.asyncio
async def test_unreachable_target_does_not_break_others():
    """A closed UDP port surfaces in last_err but other targets keep working."""
    rx, tr, good_port = await _listener_on_free_port()
    try:
        f = _make_forwarder_no_disk()
        await f.start()
        # 127.0.0.1:1 is reserved/closed — sendto will typically succeed at
        # the syscall level (UDP is connectionless), but ICMP unreachable can
        # surface as ECONNREFUSED on a subsequent call. We just need the
        # bridge to stay up and the good target to keep flowing.
        bad, err1 = f.add({
            "host": "127.0.0.1", "port": 1, "enabled": True,
            "mappings": [{"source_pattern": "sensor/FACE0003/0", "address": "/bad",
                           "scale": 1.0, "offset": 0.0}],
        })
        good, err2 = f.add({
            "host": "127.0.0.1", "port": good_port, "enabled": True,
            "mappings": [{"source_pattern": "sensor/FACE0003/0", "address": "/good",
                           "scale": 1.0, "offset": 0.0}],
        })
        assert err1 is None and err2 is None
        # Push a few frames so any ICMP-driven errors have a chance to surface.
        for _ in range(5):
            f.forward({"type": "sensor", "sensor": "imu", "uid": "FACE0003",
                        "slot": 3, "channel_id": 0, "value": 1.0})
            await _drain(0.05)
        # Good target must still be receiving packets.
        assert rx.received, "good target stopped receiving"
        assert all(addr == "/good" for addr, _ in rx.received)
        # Bridge must not have crashed: workers + tasks intact.
        assert bad.id in f._workers and good.id in f._workers
        assert not f._tasks[good.id].done()
        await f.stop()
    finally:
        tr.close()


@pytest.mark.asyncio
async def test_config_persist_round_trip(tmp_path):
    """Save targets to disk, reinstantiate forwarder, verify round-trip."""
    cfg = tmp_path / "osc_targets.json"
    f1 = OscForwarder(config_path=cfg, allow_remote=False)
    await f1.start()
    t1, err1 = f1.add({
        "host": "127.0.0.1", "port": 7001, "enabled": True,
        "sensors_filter": ["imu"], "actuators_enabled": True,
        "rate_limit_hz": 30.0,
        "mappings": [{"source_pattern": "sensor/FACE0003/0", "address": "/a",
                       "scale": 2.0, "offset": -1.0}],
    })
    t2, err2 = f1.add({
        "host": "127.0.0.1", "port": 7002, "enabled": False,
        "mappings": [{"source_pattern": "actuator/*", "address": "/b",
                       "scale": 1.0, "offset": 0.0}],
    })
    assert err1 is None and err2 is None
    await f1.stop()
    assert cfg.exists()

    f2 = OscForwarder(config_path=cfg, allow_remote=False)
    await f2.start()
    snap = {t["id"]: t for t in f2.snapshot()}
    assert t1.id in snap and t2.id in snap
    assert snap[t1.id]["host"] == "127.0.0.1"
    assert snap[t1.id]["port"] == 7001
    assert snap[t1.id]["sensors_filter"] == ["imu"]
    assert snap[t1.id]["actuators_enabled"] is True
    assert snap[t1.id]["rate_limit_hz"] == 30.0
    assert snap[t1.id]["mappings"][0]["address"] == "/a"
    assert snap[t1.id]["mappings"][0]["scale"] == 2.0
    assert snap[t2.id]["enabled"] is False
    await f2.stop()


@pytest.mark.asyncio
async def test_loopback_policy_refuses_remote_when_not_allowed():
    f = _make_forwarder_no_disk()
    f.allow_remote = False
    await f.start()
    # 8.8.8.8 is non-loopback; bridge must refuse when allow_remote=False.
    t, err = f.add({
        "host": "8.8.8.8", "port": 7000, "enabled": True,
        "mappings": [],
    })
    assert t is None
    assert err is not None
    assert "non-loopback" in err.lower() or "loopback" in err.lower()
    assert f.snapshot() == []
    await f.stop()


@pytest.mark.asyncio
async def test_loopback_policy_allows_remote_when_flag_set():
    f = _make_forwarder_no_disk()
    f.allow_remote = True
    await f.start()
    t, err = f.add({
        "host": "8.8.8.8", "port": 7000, "enabled": False,  # disabled, no traffic
        "mappings": [],
    })
    assert err is None
    assert t is not None
    assert len(f.snapshot()) == 1
    await f.stop()


@pytest.mark.asyncio
async def test_corrupt_row_does_not_drop_good_rows(tmp_path):
    """One malformed config row must not erase the others."""
    cfg = tmp_path / "osc_targets.json"
    cfg.write_text(json.dumps([
        {"id": "good1", "host": "127.0.0.1", "port": 7001, "mappings": []},
        {"id": "bad",   "port": 7002},  # missing host → will raise in dataclass
        {"id": "good2", "host": "127.0.0.1", "port": 7003, "mappings": []},
    ]))
    f = OscForwarder(config_path=cfg, allow_remote=False)
    await f.start()
    ids = {t["id"] for t in f.snapshot()}
    assert "good1" in ids and "good2" in ids
    assert "bad" not in ids
    await f.stop()


# ── Helpers ────────────────────────────────────────────────────────

def _make_forwarder_no_disk() -> OscForwarder:
    f = OscForwarder.__new__(OscForwarder)
    f._targets = {}
    f._workers = {}
    f._tasks = {}
    f._loop = None
    f.allow_remote = False

    class _NullPath:
        def exists(self): return False
        @property
        def parent(self): return self
        def mkdir(self, *a, **k): pass
        def write_text(self, *a, **k): pass
        def read_text(self): return "[]"
    f.config_path = _NullPath()  # type: ignore[assignment]
    return f
