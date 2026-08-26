"""Regression tests for the interactive simulator in serial_bridge.py."""
from __future__ import annotations

import asyncio
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import serial_bridge
from wb_eca import Act, Action, CH


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
    }
    assert module.motors[2] == {
        "mode": "reverse", "speed": 90, "until_ms": 15000,
    }

    serial_bridge.expire_actuator_state(module, now_ms=11001)

    assert module.motors[1] == {
        "mode": "stop", "speed": 0, "until_ms": 0,
    }
    assert module.motors[2] == {
        "mode": "reverse", "speed": 90, "until_ms": 15000,
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
