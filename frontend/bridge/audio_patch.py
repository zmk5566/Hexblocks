"""WearBlocks fixed-resource audio patch codec.

This is the host-side reference for hardware/firmware/lib/WearBlocksAudio.
It deliberately compiles a bounded parameter set, not an arbitrary DSP graph.
"""
from __future__ import annotations

import base64
import math
import struct
import time
from collections.abc import Mapping

MAGIC = b"WBAP"
VERSION = 1
ENCODED_LEN = 42

FLAG_ENVELOPE = 0x01

WAVEFORMS = {
    "off": 0,
    "sine": 1,
    "saw": 2,
    "square": 3,
    "triangle": 4,
}
WAVEFORM_NAMES = {value: key for key, value in WAVEFORMS.items()}

FILTER_MODES = {"bypass": 0, "lowpass": 1}
FILTER_MODE_NAMES = {value: key for key, value in FILTER_MODES.items()}

LFO_TARGETS = {"pitch": 0x01, "filter": 0x02, "amplitude": 0x04}


def fnv1a32(data: bytes) -> int:
    h = 2166136261
    for byte in data:
        h ^= byte
        h = (h * 16777619) & 0xFFFFFFFF
    return h


def default_config_rev() -> int:
    return int(time.time() * 1000) & 0xFFFFFFFF


def _mapping(value: object, name: str) -> Mapping:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be an object")
    return value


def _number(value: object, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be numeric")
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{name} must be numeric") from None
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _boolean(value: object, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be true or false")
    return value


def _integer(value: object, name: str, lo: int, hi: int) -> int:
    number = _number(value, name)
    if number != math.trunc(number):
        raise ValueError(f"{name} must be an integer")
    result = int(number)
    if not lo <= result <= hi:
        raise ValueError(f"{name} must be {lo}..{hi}")
    return result


def _unit_byte(value: object, name: str) -> int:
    number = _number(value, name)
    if not 0.0 <= number <= 1.0:
        raise ValueError(f"{name} must be 0.0..1.0")
    return round(number * 255.0)


def _enum(value: object, name: str, choices: Mapping[str, int]) -> int:
    key = str(value).strip().lower()
    if key not in choices:
        raise ValueError(f"{name} must be one of: {', '.join(choices)}")
    return choices[key]


def normalize_patch(raw: Mapping, config_rev: int | None = None) -> dict:
    raw = _mapping(raw, "patch")
    oscillators = _mapping(raw.get("oscillators", {}), "oscillators")
    filter_cfg = _mapping(raw.get("filter", {}), "filter")
    lfo = _mapping(raw.get("lfo", {}), "lfo")
    envelope = _mapping(raw.get("envelope", {}), "envelope")
    delay = _mapping(raw.get("delay", {}), "delay")

    if config_rev is None:
        config_rev = raw.get("config_rev", default_config_rev())
    config_rev = _integer(config_rev, "config_rev", 0, 0xFFFFFFFF)

    osc_a = _enum(oscillators.get("a", "sine"), "oscillators.a", WAVEFORMS)
    osc_b = _enum(oscillators.get("b", "off"), "oscillators.b", WAVEFORMS)
    osc_mix = _unit_byte(oscillators.get("mix", 0.0), "oscillators.mix")
    noise_mix = _unit_byte(
        oscillators.get("noise", 0.0), "oscillators.noise"
    )
    b_octave = _integer(
        oscillators.get("b_octave", 0), "oscillators.b_octave", -2, 2
    )
    b_detune = _integer(
        oscillators.get("b_detune_cents", 0),
        "oscillators.b_detune_cents",
        -100,
        100,
    )

    filter_mode = _enum(
        filter_cfg.get("mode", "bypass"), "filter.mode", FILTER_MODES
    )
    filter_cutoff = _integer(
        filter_cfg.get("cutoff_hz", 2000), "filter.cutoff_hz", 40, 8000
    )
    filter_resonance = _unit_byte(
        filter_cfg.get("resonance", 0.125), "filter.resonance"
    )

    lfo_wave = _enum(lfo.get("wave", "sine"), "lfo.wave", WAVEFORMS)
    if lfo_wave == WAVEFORMS["off"]:
        raise ValueError("lfo.wave cannot be off")
    raw_targets = lfo.get("targets", [])
    if not isinstance(raw_targets, list):
        raise ValueError("lfo.targets must be a list")
    lfo_target_mask = 0
    for target in raw_targets:
        key = str(target).strip().lower()
        if key not in LFO_TARGETS:
            raise ValueError(
                f"lfo target {target!r} must be one of: "
                f"{', '.join(LFO_TARGETS)}"
            )
        lfo_target_mask |= LFO_TARGETS[key]
    lfo_rate_hz = _number(lfo.get("rate_hz", 2.0), "lfo.rate_hz")
    lfo_rate_centi_hz = round(lfo_rate_hz * 100.0)
    if not 1 <= lfo_rate_centi_hz <= 2000:
        raise ValueError("lfo.rate_hz must round into 0.01..20.00 Hz")
    lfo_depth = _unit_byte(lfo.get("depth", 0.0), "lfo.depth")

    attack_ms = _integer(envelope.get("attack_ms", 5), "envelope.attack_ms", 0, 5000)
    decay_ms = _integer(envelope.get("decay_ms", 80), "envelope.decay_ms", 0, 5000)
    sustain = _unit_byte(envelope.get("sustain", 0.86), "envelope.sustain")
    release_ms = _integer(
        envelope.get("release_ms", 120), "envelope.release_ms", 0, 5000
    )

    delay_ms = _integer(delay.get("time_ms", 0), "delay.time_ms", 0, 80)
    delay_feedback = _unit_byte(delay.get("feedback", 0.0), "delay.feedback")
    delay_mix = _unit_byte(delay.get("mix", 0.0), "delay.mix")
    master_gain = _unit_byte(raw.get("master_gain", 0.86), "master_gain")

    return {
        "config_rev": config_rev,
        "envelope_enabled": _boolean(
            raw.get("envelope_enabled", False), "envelope_enabled"
        ),
        "osc_a": osc_a,
        "osc_b": osc_b,
        "osc_mix": osc_mix,
        "noise_mix": noise_mix,
        "b_octave": b_octave,
        "b_detune_cents": b_detune,
        "filter_mode": filter_mode,
        "filter_cutoff_hz": filter_cutoff,
        "filter_resonance": filter_resonance,
        "lfo_wave": lfo_wave,
        "lfo_target_mask": lfo_target_mask,
        "lfo_rate_centi_hz": lfo_rate_centi_hz,
        "lfo_depth": lfo_depth,
        "attack_ms": attack_ms,
        "decay_ms": decay_ms,
        "sustain": sustain,
        "release_ms": release_ms,
        "delay_ms": delay_ms,
        "delay_feedback": delay_feedback,
        "delay_mix": delay_mix,
        "master_gain": master_gain,
    }


def encode_patch(raw: Mapping, config_rev: int | None = None) -> bytes:
    patch = normalize_patch(raw, config_rev=config_rev)
    out = bytearray(ENCODED_LEN)
    out[:4] = MAGIC
    out[4] = VERSION
    out[5] = FLAG_ENVELOPE if patch["envelope_enabled"] else 0
    struct.pack_into("<I", out, 6, patch["config_rev"])
    out[10] = patch["osc_a"]
    out[11] = patch["osc_b"]
    out[12] = patch["osc_mix"]
    out[13] = patch["noise_mix"]
    struct.pack_into("<bb", out, 14, patch["b_octave"], patch["b_detune_cents"])
    out[16] = patch["filter_mode"]
    struct.pack_into("<H", out, 17, patch["filter_cutoff_hz"])
    out[19] = patch["filter_resonance"]
    out[20] = patch["lfo_wave"]
    out[21] = patch["lfo_target_mask"]
    struct.pack_into("<H", out, 22, patch["lfo_rate_centi_hz"])
    out[24] = patch["lfo_depth"]
    struct.pack_into("<HHBHH", out, 25,
                     patch["attack_ms"], patch["decay_ms"], patch["sustain"],
                     patch["release_ms"], patch["delay_ms"])
    out[34] = patch["delay_feedback"]
    out[35] = patch["delay_mix"]
    out[36] = patch["master_gain"]
    out[37] = 0
    struct.pack_into("<I", out, 38, fnv1a32(bytes(out[:38])))
    return bytes(out)


def decode_patch(data: bytes) -> dict:
    if len(data) != ENCODED_LEN:
        raise ValueError(f"audio patch must be exactly {ENCODED_LEN} bytes")
    if data[:4] != MAGIC:
        raise ValueError("bad audio patch magic")
    if data[4] != VERSION:
        raise ValueError(f"unsupported audio patch version {data[4]}")
    if data[5] & ~FLAG_ENVELOPE:
        raise ValueError("unknown audio patch flags")
    if data[37] != 0:
        raise ValueError("audio patch reserved byte must be zero")
    got_crc = struct.unpack_from("<I", data, 38)[0]
    if got_crc != fnv1a32(data[:38]):
        raise ValueError("bad audio patch crc")

    config_rev = struct.unpack_from("<I", data, 6)[0]
    osc_a, osc_b, osc_mix, noise_mix = data[10:14]
    b_octave, b_detune = struct.unpack_from("<bb", data, 14)
    filter_mode = data[16]
    filter_cutoff = struct.unpack_from("<H", data, 17)[0]
    filter_resonance = data[19]
    lfo_wave, lfo_target_mask = data[20:22]
    lfo_rate = struct.unpack_from("<H", data, 22)[0]
    lfo_depth = data[24]
    attack_ms, decay_ms, sustain, release_ms, delay_ms = struct.unpack_from(
        "<HHBHH", data, 25
    )

    if osc_a not in WAVEFORM_NAMES or osc_b not in WAVEFORM_NAMES:
        raise ValueError("bad oscillator waveform")
    if lfo_wave == 0 or lfo_wave not in WAVEFORM_NAMES:
        raise ValueError("bad LFO waveform")
    if filter_mode not in FILTER_MODE_NAMES:
        raise ValueError("bad filter mode")
    if lfo_target_mask & ~0x07:
        raise ValueError("bad LFO target mask")
    if not -2 <= b_octave <= 2 or not -100 <= b_detune <= 100:
        raise ValueError("oscillator B transpose out of range")
    if not 40 <= filter_cutoff <= 8000:
        raise ValueError("filter cutoff out of range")
    if not 1 <= lfo_rate <= 2000:
        raise ValueError("LFO rate out of range")
    if attack_ms > 5000 or decay_ms > 5000 or release_ms > 5000:
        raise ValueError("envelope time out of range")
    if delay_ms > 80:
        raise ValueError("delay time out of range")

    targets = [
        name for name, mask in LFO_TARGETS.items() if lfo_target_mask & mask
    ]
    return {
        "config_rev": config_rev,
        "envelope_enabled": bool(data[5] & FLAG_ENVELOPE),
        "oscillators": {
            "a": WAVEFORM_NAMES[osc_a],
            "b": WAVEFORM_NAMES[osc_b],
            "mix": osc_mix / 255.0,
            "noise": noise_mix / 255.0,
            "b_octave": b_octave,
            "b_detune_cents": b_detune,
        },
        "filter": {
            "mode": FILTER_MODE_NAMES[filter_mode],
            "cutoff_hz": filter_cutoff,
            "resonance": filter_resonance / 255.0,
        },
        "lfo": {
            "wave": WAVEFORM_NAMES[lfo_wave],
            "targets": targets,
            "rate_hz": lfo_rate / 100.0,
            "depth": lfo_depth / 255.0,
        },
        "envelope": {
            "attack_ms": attack_ms,
            "decay_ms": decay_ms,
            "sustain": sustain / 255.0,
            "release_ms": release_ms,
        },
        "delay": {
            "time_ms": delay_ms,
            "feedback": data[34] / 255.0,
            "mix": data[35] / 255.0,
        },
        "master_gain": data[36] / 255.0,
    }


def encode_patch_base64(raw: Mapping,
                        config_rev: int | None = None) -> tuple[str, dict]:
    payload = encode_patch(raw, config_rev=config_rev)
    return base64.b64encode(payload).decode("ascii"), decode_patch(payload)


def normalize_uid(uid: str) -> str:
    normalized = str(uid).strip().upper()
    if normalized.startswith("0X"):
        normalized = normalized[2:]
    if len(normalized) != 8 or any(c not in "0123456789ABCDEF" for c in normalized):
        raise ValueError("uid must be exactly 8 hexadecimal characters")
    return normalized


def hub_command(payload: bytes, uid: str) -> str:
    decoded = decode_patch(payload)
    del decoded  # Validation is the purpose of decoding here.
    return f"$AP {normalize_uid(uid)} {base64.b64encode(payload).decode('ascii')}"
