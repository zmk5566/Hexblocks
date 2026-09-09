from __future__ import annotations

import base64
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from audio_patch import ENCODED_LEN, decode_patch, encode_patch, hub_command


PATCH = {
    "config_rev": 123,
    "envelope_enabled": True,
    "oscillators": {
        "a": "saw",
        "b": "square",
        "mix": 0.35,
        "noise": 0.05,
        "b_octave": -1,
        "b_detune_cents": 7,
    },
    "filter": {"mode": "lowpass", "cutoff_hz": 1800, "resonance": 0.4},
    "lfo": {
        "wave": "triangle",
        "targets": ["filter", "amplitude"],
        "rate_hz": 0.4,
        "depth": 0.3,
    },
    "envelope": {"attack_ms": 10, "decay_ms": 140, "sustain": 0.7,
                 "release_ms": 260},
    "delay": {"time_ms": 60, "feedback": 0.25, "mix": 0.15},
    "master_gain": 0.75,
}


def test_audio_patch_round_trip():
    payload = encode_patch(PATCH)

    assert len(payload) == ENCODED_LEN
    assert payload[:4] == b"WBAP"
    # Golden vector shared with the documented C++ offsets. This catches an
    # encode/decode pair drifting together while still passing a round trip.
    assert base64.b64encode(payload).decode("ascii") == (
        "V0JBUAEBewAAAAIDWQ3/BwEIB2YEBigATAoAjACyBAE8AEAmvwB/luIq"
    )
    decoded = decode_patch(payload)
    assert decoded["config_rev"] == 123
    assert decoded["oscillators"]["a"] == "saw"
    assert decoded["oscillators"]["b_octave"] == -1
    assert decoded["filter"]["cutoff_hz"] == 1800
    assert decoded["lfo"]["targets"] == ["filter", "amplitude"]
    assert decoded["delay"]["time_ms"] == 60
    assert decoded["master_gain"] == pytest.approx(round(0.75 * 255) / 255)


def test_audio_patch_rejects_bad_crc():
    payload = bytearray(encode_patch(PATCH))
    payload[-1] ^= 0xFF

    with pytest.raises(ValueError, match="crc"):
        decode_patch(bytes(payload))


def test_audio_patch_rejects_over_budget_delay():
    patch = {**PATCH, "delay": {"time_ms": 81, "feedback": 0, "mix": 0}}

    with pytest.raises(ValueError, match="delay.time_ms"):
        encode_patch(patch)


def test_audio_patch_rejects_string_boolean():
    patch = {**PATCH, "envelope_enabled": "false"}

    with pytest.raises(ValueError, match="true or false"):
        encode_patch(patch)


def test_hub_command_contains_valid_payload():
    payload = encode_patch(PATCH)
    command = hub_command(payload, "c0ffee01")

    prefix, uid, encoded = command.split()
    assert prefix == "$AP"
    assert uid == "C0FFEE01"
    assert base64.b64decode(encoded, validate=True) == payload


def test_hub_command_rejects_bad_uid():
    with pytest.raises(ValueError, match="uid"):
        hub_command(encode_patch(PATCH), "1234")
