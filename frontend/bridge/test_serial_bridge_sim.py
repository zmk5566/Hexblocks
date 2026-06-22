"""Regression tests for the interactive simulator in serial_bridge.py."""
from __future__ import annotations

import asyncio
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import serial_bridge
from wb_eca import CH


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
