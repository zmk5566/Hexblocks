from __future__ import annotations

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from logger_profile import decode_profile, encode_profile, encode_profile_base64


def test_logger_profile_round_trip():
    payload = encode_profile([{
        "source_uid": "FACE0006",
        "channel_id": 41,
        "record_type": "sensor",
        "mode": "on_change",
        "min_interval_ms": 1000,
        "threshold": 0.05,
        "flags": 2,
    }], config_rev=123)

    assert payload[:4] == b"WBLG"
    assert len(payload) == 32  # 12-byte header + 1 entry + 4-byte CRC
    decoded = decode_profile(payload)
    assert decoded["config_rev"] == 123
    assert decoded["subscriptions"][0]["source_uid"] == "FACE0006"
    assert decoded["subscriptions"][0]["channel_id"] == 41
    assert decoded["subscriptions"][0]["record_type"] == "sensor"
    assert decoded["subscriptions"][0]["mode"] == "on_change"
    assert decoded["subscriptions"][0]["min_interval_ms"] == 1000
    assert decoded["subscriptions"][0]["threshold"] == pytest.approx(0.05)
    assert decoded["subscriptions"][0]["flags"] == 2


def test_logger_profile_rejects_bad_crc():
    payload = bytearray(encode_profile([], config_rev=1))
    payload[-1] ^= 0xFF

    with pytest.raises(ValueError, match="crc"):
        decode_profile(bytes(payload))


def test_logger_profile_base64_returns_decoded_shape():
    b64, decoded = encode_profile_base64([], config_rev=9)

    assert b64
    assert decoded == {"config_rev": 9, "subscriptions": []}
