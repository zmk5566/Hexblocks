"""Regression tests for the interactive simulator in serial_bridge.py."""
from __future__ import annotations

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import serial_bridge
from wb_eca import CH


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
async def test_broadcast_survives_client_removal_during_send(monkeypatch):
    class ClosingClient:
        async def send(self, _payload):
            serial_bridge.clients.discard(self)

    closing = ClosingClient()
    serial_bridge.clients.clear()
    serial_bridge.clients.add(closing)
    monkeypatch.setattr(serial_bridge.osc_forwarder, "forward", lambda _msg: None)

    await serial_bridge.broadcast({"type": "command_ack", "status": "ok"})

    assert closing not in serial_bridge.clients
