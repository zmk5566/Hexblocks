"""WearBlocks logger subscription profile codec.

Matches hardware/firmware/lib/WearBlocksLogger exactly:
  WBLG, version, config_rev, count, entries, FNV-1a CRC32.
"""
from __future__ import annotations

import base64
import math
import struct
import time
from typing import Iterable

MAGIC = b"WBLG"
VERSION = 1
MAX_SUBSCRIPTIONS = 12
MAX_ENCODED = 224

RECORD_TYPES = {
    "sensor": 0,
    "hub_event": 1,
    "eca_event": 2,
    "topology_event": 3,
}
RECORD_TYPE_NAMES = {v: k for k, v in RECORD_TYPES.items()}

MODES = {
    "latest_interval": 0,
    "on_change": 1,
    "aggregate_avg": 2,
    "aggregate_minmax": 3,
    "event_only": 4,
}
MODE_NAMES = {v: k for k, v in MODES.items()}


def fnv1a32(data: bytes) -> int:
    h = 2166136261
    for b in data:
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def default_config_rev() -> int:
    return int(time.time() * 1000) & 0xFFFFFFFF


def normalize_subscription(raw: dict) -> dict:
    source_uid = str(raw.get("source_uid", "")).strip().upper().replace("0X", "")
    if len(source_uid) != 8 or any(c not in "0123456789ABCDEF" for c in source_uid):
        raise ValueError(f"bad source_uid {source_uid!r}")

    try:
        channel_id = int(raw.get("channel_id", 0))
    except (TypeError, ValueError):
        raise ValueError("bad channel_id") from None
    if not 0 <= channel_id < 48:
        raise ValueError("channel_id must be 0..47")

    record_type = str(raw.get("record_type", "sensor")).strip()
    if record_type not in RECORD_TYPES:
        raise ValueError(f"bad record_type {record_type!r}")

    mode = str(raw.get("mode", "latest_interval")).strip()
    if mode not in MODES:
        raise ValueError(f"bad mode {mode!r}")

    try:
        min_interval_ms = int(raw.get("min_interval_ms", 0))
    except (TypeError, ValueError):
        raise ValueError("bad min_interval_ms") from None
    if not 0 <= min_interval_ms <= 86_400_000:
        raise ValueError("min_interval_ms out of range")

    try:
        threshold = float(raw.get("threshold", 0.0))
    except (TypeError, ValueError):
        raise ValueError("bad threshold") from None
    if not math.isfinite(threshold):
        raise ValueError("threshold must be finite")

    try:
        flags = int(raw.get("flags", 0))
    except (TypeError, ValueError):
        raise ValueError("bad flags") from None
    if not 0 <= flags <= 255:
        raise ValueError("flags must be 0..255")

    return {
        "source_uid": source_uid,
        "channel_id": channel_id,
        "record_type": record_type,
        "mode": mode,
        "min_interval_ms": min_interval_ms,
        "threshold": threshold,
        "flags": flags,
    }


def encode_profile(subscriptions: Iterable[dict],
                   config_rev: int | None = None) -> bytes:
    subs = [normalize_subscription(s) for s in subscriptions]
    if len(subs) > MAX_SUBSCRIPTIONS:
        raise ValueError(f"too many subscriptions, max {MAX_SUBSCRIPTIONS}")
    if config_rev is None:
        config_rev = default_config_rev()
    config_rev = int(config_rev) & 0xFFFFFFFF

    out = bytearray()
    out += MAGIC
    out += struct.pack("<BBI", VERSION, 0, config_rev)
    out += struct.pack("<BB", len(subs), 0)
    for sub in subs:
        out += struct.pack(
            "<IBBBBIf",
            int(sub["source_uid"], 16),
            sub["channel_id"],
            RECORD_TYPES[sub["record_type"]],
            MODES[sub["mode"]],
            sub["flags"],
            sub["min_interval_ms"],
            sub["threshold"],
        )
    out += struct.pack("<I", fnv1a32(bytes(out)))
    if len(out) > MAX_ENCODED:
        raise ValueError("encoded logger profile exceeds SYS_CONFIG limit")
    return bytes(out)


def decode_profile(data: bytes) -> dict:
    if len(data) < 16 or len(data) > MAX_ENCODED:
        raise ValueError("bad profile length")
    if data[:4] != MAGIC:
        raise ValueError("bad profile magic")
    version, _reserved, config_rev = struct.unpack_from("<BBI", data, 4)
    if version != VERSION:
        raise ValueError(f"unsupported version {version}")
    got_crc = struct.unpack_from("<I", data, len(data) - 4)[0]
    want_crc = fnv1a32(data[:-4])
    if got_crc != want_crc:
        raise ValueError("bad profile crc")
    count, _reserved2 = struct.unpack_from("<BB", data, 10)
    if count > MAX_SUBSCRIPTIONS:
        raise ValueError("too many subscriptions")
    if 16 + count * 16 != len(data):
        raise ValueError("profile length/count mismatch")

    subs = []
    off = 12
    for _ in range(count):
        source_uid, channel_id, record_type, mode, flags, min_interval_ms, threshold = \
            struct.unpack_from("<IBBBBIf", data, off)
        off += 16
        if record_type not in RECORD_TYPE_NAMES:
            raise ValueError("bad record type")
        if mode not in MODE_NAMES:
            raise ValueError("bad mode")
        subs.append({
            "source_uid": f"{source_uid:08X}",
            "channel_id": channel_id,
            "record_type": RECORD_TYPE_NAMES[record_type],
            "mode": MODE_NAMES[mode],
            "min_interval_ms": min_interval_ms,
            "threshold": threshold,
            "flags": flags,
        })
    return {"config_rev": config_rev, "subscriptions": subs}


def encode_profile_base64(subscriptions: Iterable[dict],
                          config_rev: int | None = None) -> tuple[str, dict]:
    payload = encode_profile(subscriptions, config_rev=config_rev)
    decoded = decode_profile(payload)
    return base64.b64encode(payload).decode("ascii"), decoded
