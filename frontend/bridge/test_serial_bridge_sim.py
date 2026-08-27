"""Regression tests for the interactive simulator in serial_bridge.py."""
from __future__ import annotations

import asyncio
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import serial_bridge
from wb_eca import Act, Action, ActionMode, CH


@pytest.fixture(autouse=True)
def reset_sim_globals():
    maps = [
        serial_bridge.sim_modules,
        serial_bridge.sim_parents,
        serial_bridge.sim_transport_modes,
        serial_bridge.modules,
        serial_bridge.module_types,
        serial_bridge.uid_by_slot,
        serial_bridge.slot_by_uid,
        serial_bridge.modules_by_uid,
        serial_bridge.module_types_by_uid,
        serial_bridge.msg_cache_by_uid,
        serial_bridge.link_cache_by_uid,
        serial_bridge.actuator_cache_by_uid,
        serial_bridge.logger_status_by_uid,
        serial_bridge.logger_config_by_uid,
        serial_bridge.sim_logger_profiles,
        serial_bridge.sim_logger_status,
    ]
    for mapping in maps:
        mapping.clear()
    yield
    for mapping in maps:
        mapping.clear()


def test_demo_d4_clears_topology_then_attaches_builtin_motor(monkeypatch):
    calls = []

    async def fake_clear():
        calls.append("clear")

    async def fake_add(module_type):
        calls.append(module_type)

    async def fake_sleep(_seconds):
        return None

    monkeypatch.setattr(serial_bridge, "sim_clear_all", fake_clear)
    monkeypatch.setattr(serial_bridge, "sim_add_module", fake_add)
    monkeypatch.setattr(serial_bridge.asyncio, "sleep", fake_sleep)

    demo = getattr(serial_bridge, "sim_run_demo_d4", None)
    assert callable(demo), "simulator must provide the D4 motor preset"
    asyncio.run(demo())

    assert calls == ["clear", "motor_hub"]


def test_transport_disconnect_clears_builtin_motor_replay_state(monkeypatch):
    builtin_uid = "FACE0000"
    monkeypatch.setattr(serial_bridge, "modules_by_uid", {
        builtin_uid: "motor_builtin",
    })
    monkeypatch.setattr(serial_bridge, "module_types_by_uid", {
        builtin_uid: "motor_builtin",
    })
    monkeypatch.setattr(serial_bridge, "msg_cache_by_uid", {
        builtin_uid: {"hello": {"type": "hello", "uid": builtin_uid}},
    })
    monkeypatch.setattr(serial_bridge, "actuator_cache_by_uid", {
        builtin_uid: {"type": "actuator_state", "uid": builtin_uid},
    })
    monkeypatch.setattr(serial_bridge, "slot_by_uid", {builtin_uid: 0})
    monkeypatch.setattr(serial_bridge, "uid_by_slot", {0: builtin_uid})

    clear = getattr(serial_bridge, "clear_hub_runtime_state", None)
    assert callable(clear), "bridge must clear Hub-owned replay state on disconnect"
    clear()

    assert serial_bridge.modules_by_uid == {}
    assert serial_bridge.module_types_by_uid == {}
    assert serial_bridge.msg_cache_by_uid == {}
    assert serial_bridge.actuator_cache_by_uid == {}
    assert serial_bridge.slot_by_uid == {}
    assert serial_bridge.uid_by_slot == {}


def test_transport_loop_exit_removes_stale_builtin_motor(monkeypatch):
    class ClosedTransport:
        name = "ble"
        label = "Motor Hub"
        address = "test-address"
        is_open = False

        async def close(self):
            return None

    monkeypatch.setattr(serial_bridge, "modules_by_uid", {
        "FACE0000": "motor_builtin",
    })
    monkeypatch.setattr(serial_bridge, "msg_cache_by_uid", {
        "FACE0000": {"hello": {"type": "hello", "uid": "FACE0000"}},
    })
    monkeypatch.setattr(serial_bridge, "serial_write_queue", asyncio.Queue())

    asyncio.run(serial_bridge._drive_transport(ClosedTransport()))

    assert serial_bridge.modules_by_uid == {}
    assert serial_bridge.msg_cache_by_uid == {}
    assert serial_bridge.last_transport_status["connected"] is False


def test_builtin_motor_wire_identity_keeps_face_zero_internal(monkeypatch):
    monkeypatch.setattr(serial_bridge, "modules_by_uid", {})
    monkeypatch.setattr(serial_bridge, "slot_by_uid", {})

    msg = serial_bridge.parse_line("$H,1234ABCD,motor_builtin,HUB,0")

    assert msg["type"] == "hello"
    assert msg["uid"] == "1234ABCD"
    assert msg["parent_is_hub"] is True
    assert msg["parent_face"] == 0
    assert msg["face"] == 0
    assert msg["slot"] is None


def test_wired_hub_disables_wifi_capability():
    assert serial_bridge.parse_line("$WIFI,DISABLED") == {
        "type": "wifi_disabled",
    }


def test_light_sim_payload_uses_light_field(monkeypatch):
    monkeypatch.setattr(serial_bridge, "_noise", lambda scale=0.01: 0.0)

    data = serial_bridge.sim_sensor_data("light", t=0.0)

    assert set(data) == {"light"}
    assert data["light"] == 0.5
    assert serial_bridge.SIM_CHANNEL_MAP["light"] == {"light": CH.LIGHT}


def test_non_imu_sim_payloads_use_catalog_labels(monkeypatch):
    monkeypatch.setattr(serial_bridge, "_noise", lambda scale=0.01: 0.0)

    assert set(serial_bridge.sim_sensor_data("hr", t=0.0)) == {"bpm", "spo2"}
    assert set(serial_bridge.sim_sensor_data("temp", t=0.0)) == {"celsius", "humidity"}
    assert serial_bridge.SIM_CHANNEL_MAP["hr"] == {"bpm": CH.BPM, "spo2": CH.SPO2}
    assert serial_bridge.SIM_CHANNEL_MAP["temp"] == {
        "celsius": CH.CELSIUS,
        "humidity": CH.HUMIDITY,
    }


def test_sim_audio_and_vibration_use_v4_lifecycle_timing(monkeypatch):
    monkeypatch.setattr(serial_bridge, "_sim_monotonic_ms", lambda: 10_000)
    monkeypatch.setattr(serial_bridge.time, "time", lambda: 20.0)

    audio = serial_bridge.SimModule("audio")
    vib = serial_bridge.SimModule("vib")
    serial_bridge.sim_modules[audio.slot] = audio
    serial_bridge.sim_modules[vib.slot] = vib

    tone = Action(target=int(audio.uid, 16), cmd=Act.AUDIO_SET_TONE,
                  duration_ms=500)
    tone.vals = [880.0, 200.0]
    serial_bridge.dispatch_action(tone)
    assert audio.audio == {
        "frequency_hz": 880, "amplitude": 200, "mode": "tone",
        "until_ms": 20_500, "_deadline_ms": 10_500,
    }

    stream_tone = Action(target=int(audio.uid, 16), cmd=Act.AUDIO_SET_TONE,
                         mode=ActionMode.STREAM, update_interval_ms=100)
    stream_tone.vals = [440.0, 100.0]
    serial_bridge.dispatch_action(stream_tone)
    assert audio.audio["until_ms"] == 20_300
    assert audio.audio["_deadline_ms"] == 10_300

    pulse = Action(target=int(vib.uid, 16), cmd=Act.VIBRATE_PULSE)
    pulse.vals = [80.0, 100.0, 50.0, 3.0]
    serial_bridge.dispatch_action(pulse)
    assert vib.vib["on_ms"] == 100
    assert vib.vib["off_ms"] == 50
    assert vib.vib["until_ms"] == 20_450
    assert vib.vib["_deadline_ms"] == 10_450


@pytest.mark.asyncio
async def test_sim_wireless_info_and_config(monkeypatch):
    events = []

    async def fake_broadcast(msg):
        events.append(msg)

    monkeypatch.setattr(serial_bridge, "broadcast", fake_broadcast)
    mod = serial_bridge.SimModule("imu")
    serial_bridge.sim_modules[mod.slot] = mod
    serial_bridge.sim_transport_modes[mod.uid] = serial_bridge.SIM_DEFAULT_TRANSPORT_MODE

    await serial_bridge._emit_sim_wireless_info()

    assert events[0] == {
        "type": "wifi_ap",
        "ssid": serial_bridge.SIM_WIFI_SSID,
        "ip": serial_bridge.SIM_WIFI_IP,
        "port": serial_bridge.SIM_WIFI_PORT,
    }
    link = [e for e in events if e["type"] == "link_state"][0]
    assert link["uid"] == mod.uid
    assert link["active_link"] == "can"
    assert link["transport_mode"] == serial_bridge.SIM_DEFAULT_TRANSPORT_MODE

    events.clear()
    serial_bridge._parse_sim_command(f"$W,CONFIG {mod.uid} wifi_only")
    await asyncio.sleep(0)

    assert serial_bridge.sim_transport_modes[mod.uid] == "wifi_only"
    link = [e for e in events if e["type"] == "link_state"][0]
    assert link["active_link"] == "wifi"
    assert link["ip"] == f"192.168.4.{100 + mod.slot}"


@pytest.mark.asyncio
async def test_sim_remote_module_reports_remote_wifi(monkeypatch):
    events = []

    async def fake_broadcast(msg):
        events.append(msg)

    monkeypatch.setattr(serial_bridge, "broadcast", fake_broadcast)
    mod = serial_bridge.SimModule("remote_temp")
    serial_bridge.sim_modules[mod.slot] = mod
    serial_bridge.sim_transport_modes[mod.uid] = "wifi_only"

    await serial_bridge._emit_sim_topology()
    topo = [e for e in events if e["type"] == "topology"][0]
    assert topo["uid"] == mod.uid
    assert topo["parent_is_hub"] is False
    assert topo["parent_remote"] is True
    assert topo["parent_face"] == 0

    events.clear()
    await serial_bridge._emit_sim_link_state(mod.uid)
    link = [e for e in events if e["type"] == "link_state"][0]
    assert link["active_link"] == "wifi"
    assert link["topology_state"] == "remote_unplaced"


@pytest.mark.asyncio
async def test_sim_logger_config_filters_selected_topics(monkeypatch):
    events = []

    async def fake_broadcast(msg):
        events.append(msg)

    monkeypatch.setattr(serial_bridge, "broadcast", fake_broadcast)
    src = serial_bridge.SimModule("light")
    logger = serial_bridge.SimModule("loralog")
    serial_bridge.sim_modules[src.slot] = src
    serial_bridge.sim_modules[logger.slot] = logger
    serial_bridge.modules_by_uid[src.uid] = src.mod_id
    serial_bridge.modules_by_uid[logger.uid] = logger.mod_id
    serial_bridge.msg_cache_by_uid[logger.uid] = {
        "descriptor": {"data": logger.descriptor}
    }

    b64, decoded = serial_bridge.encode_profile_base64([{
        "source_uid": src.uid,
        "channel_id": CH.LIGHT,
        "record_type": "sensor",
        "mode": "latest_interval",
        "min_interval_ms": 0,
        "threshold": 0,
    }], config_rev=7)
    serial_bridge._parse_sim_command(f"$L,CONFIG {logger.uid} {b64}")
    await asyncio.sleep(0)

    assert serial_bridge.sim_logger_profiles[logger.uid]["config_rev"] == 7
    await serial_bridge._sim_logger_consume_sensor(src.uid, CH.LIGHT, 0.42, 1000)
    await serial_bridge._sim_logger_consume_sensor(src.uid, CH.AX, 0.99, 1001)

    statuses = [e for e in events if e["type"] == "logger_status"]
    assert statuses[-1]["uid"] == logger.uid
    assert statuses[-1]["queue_depth"] == 1

    await serial_bridge._sim_logger_ack_tick(2000)
    statuses = [e for e in events if e["type"] == "logger_status"]
    assert statuses[-1]["queue_depth"] == 0
    assert statuses[-1]["last_ack_ms"] == 2000


def test_motor_actions_keep_motor_state_and_expiry_independent(monkeypatch):
    """Changing or expiring M1 must not change M2, and vice versa."""
    assert "motor" in serial_bridge.SIM_MODULE_DEFS
    assert getattr(Act, "MOTOR_SET", None) == 64
    assert hasattr(serial_bridge, "expire_actuator_state")

    monkeypatch.setattr(serial_bridge, "sim_modules", {})
    monkeypatch.setattr(serial_bridge, "uid_by_slot", {})
    monkeypatch.setattr(serial_bridge, "slot_by_uid", {})
    monkeypatch.setattr(serial_bridge, "modules_by_uid", {})
    monkeypatch.setattr(serial_bridge.time, "time", lambda: 10.0)
    monkeypatch.setattr(serial_bridge, "_sim_monotonic_ms", lambda: 20_000)

    module = serial_bridge.SimModule("motor")
    serial_bridge.sim_modules[module.slot] = module
    target = int(module.uid, 16)

    serial_bridge.dispatch_action(Action(
        target=target,
        cmd=Act.MOTOR_SET,
        vals=[1, 1, 180, 1000],
    ))
    serial_bridge.dispatch_action(Action(
        target=target,
        cmd=Act.MOTOR_SET,
        vals=[2, 2, 90, 5000],
    ))

    assert module.motors[1] == {
        "mode": "forward", "speed": 180, "until_ms": 11000,
        "_deadline_ms": 21000,
    }
    assert module.motors[2] == {
        "mode": "reverse", "speed": 90, "until_ms": 15000,
        "_deadline_ms": 25000,
    }

    serial_bridge.expire_actuator_state(module, now_ms=21001)

    assert module.motors[1] == {
        "mode": "stop", "speed": 0, "until_ms": 0,
        "_deadline_ms": 0,
    }
    assert module.motors[2] == {
        "mode": "reverse", "speed": 90, "until_ms": 15000,
        "_deadline_ms": 25000,
    }


def test_motor_hub_builtin_motor_is_local_and_does_not_consume_face_one(monkeypatch):
    """The onboard actuator is local/face 0; an external motor still routes by CAN."""
    monkeypatch.setattr(serial_bridge, "sim_modules", {})
    monkeypatch.setattr(serial_bridge, "uid_by_slot", {})
    monkeypatch.setattr(serial_bridge, "slot_by_uid", {})
    monkeypatch.setattr(serial_bridge, "modules_by_uid", {})

    builtin = serial_bridge.SimModule("motor_hub")
    external = serial_bridge.SimModule("motor")
    serial_bridge.sim_modules[builtin.slot] = builtin
    serial_bridge.sim_modules[external.slot] = external

    assert builtin.slot == 0
    assert builtin.face == 0
    assert "built_in" in builtin.descriptor["affs"]
    assert external.face == 1

    serial_bridge.dispatch_action(Action(
        target=int(builtin.uid, 16), cmd=Act.MOTOR_SET,
        vals=[1, 1, 160, 0],
    ))
    serial_bridge.dispatch_action(Action(
        target=int(external.uid, 16), cmd=Act.MOTOR_SET,
        vals=[2, 2, 80, 0],
    ))

    assert builtin.last_action_route == "local"
    assert external.last_action_route == "can"
    assert builtin.motors[1]["speed"] == 160
    assert external.motors[2]["speed"] == 80
