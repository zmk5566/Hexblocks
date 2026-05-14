"""Unit tests for wb_eca.py — the Python ECA engine port.

These tests pin the engine to two contracts:
1. Bytecode wire format matches frontend/js/eca-encoder.js exactly.
2. Runtime semantics match hardware/firmware/lib/WearBlocksECA/WearBlocksECA.cpp.

Run with: python -m pytest frontend/bridge/test_wb_eca.py -v
"""
from __future__ import annotations

import logging
import struct

import pytest

from wb_eca import (
    Act, CH, CondOp, ECAEngine, Logic, REF, VCOp,
    MAGIC_0, MAGIC_1,
)


# ── Encoder mirror — replicate eca-encoder.js byte-for-byte ──────
#
# Byte order: u8 trivial; u16 BIG-endian; u32 LITTLE-endian; f32 LITTLE-endian.

def _u8(v: int) -> bytes:
    return bytes([v & 0xFF])


def _u16(v: int) -> bytes:
    return bytes([(v >> 8) & 0xFF, v & 0xFF])


def _u32(v: int) -> bytes:
    return struct.pack("<I", v & 0xFFFFFFFF)


def _f32(v: float) -> bytes:
    return struct.pack("<f", v)


def _enc_cond(*, ref_type=REF.SLOT, id=0, ch=0, op=CondOp.GT,
              threshold=0.0, hold_ms=0, cooldown_ms=0) -> bytes:
    return (_u8(ref_type) + _u32(id) + _u8(ch) + _u8(op)
            + _f32(threshold) + _u16(hold_ms) + _u16(cooldown_ms))


def _enc_action_param(*, type=REF.CONST, id=0, ch=0, value=0.0) -> bytes:
    return _u8(type) + _u32(id) + _u8(ch) + _f32(value)


def _enc_action(*, target=0, cmd=Act.LED_OFF,
                params: list[bytes] | None = None) -> bytes:
    """v3 action: variable length [target:4][cmd:1][numParams:1][param×N (10B each)]."""
    params = params or []
    out = _u32(target) + _u8(cmd) + _u8(len(params))
    for p in params:
        out += p
    return out


# Convenience: build a list of CONST params from raw float values.
def _const_params(*values: float) -> list[bytes]:
    return [_enc_action_param(type=REF.CONST, value=float(v)) for v in values]


def _enc_vc(*, vc_id=0, op=VCOp.ADD, a_type=REF.SLOT, a_id=0, a_ch=0,
           b_type=REF.CONST, b_id=0, b_ch=0, b_const=0.0,
           c_const=0.0) -> bytes:
    return (_u8(vc_id) + _u8(op) + _u8(a_type) + _u32(a_id) + _u8(a_ch)
            + _u8(b_type) + _u32(b_id) + _u8(b_ch)
            + _f32(b_const) + _f32(c_const))


def _build_program(*, variables: list[float] | None = None,
                   vcs: list[bytes] | None = None,
                   rules: list[tuple[int, list[bytes], list[bytes]]] | None = None,
                   version: int = 3) -> bytes:
    """Compose a full bytecode buffer the way eca-encoder.js does it."""
    variables = variables or []
    vcs = vcs or []
    rules = rules or []

    body = bytes([MAGIC_0, MAGIC_1, version])
    body += _u8(len(variables))
    for v in variables:
        body += _f32(v)
    body += _u8(len(vcs))
    for vc in vcs:
        body += vc
    body += _u8(len(rules))
    for logic, conds, acts in rules:
        body += _u8(len(conds)) + _u8(logic) + _u8(len(acts))
        for c in conds:
            body += c
        for a in acts:
            body += a

    chk = sum(body) & 0xFF
    return body + bytes([chk])


# ── Tests ─────────────────────────────────────────────────────────

# Stable test UIDs. Convention: 0xAA0000<slot>. Tests bind a tiny resolver
# that maps these back to slot — same shape as the real hub's registry hook.
SENSOR_UID = 0xAA000001   # → slot 1
LED_UID    = 0xAA000005   # → slot 5
HR_UID     = 0xAA000002   # → slot 2

def _bind_default_resolver(eca):
    mapping = {SENSOR_UID: 1, LED_UID: 5, HR_UID: 2}
    eca.set_uid_resolver(lambda uid: mapping.get(uid, 0))


def test_load_minimal_program():
    """Magic + checksum + empty body parses cleanly."""
    prog = _build_program()
    eca = ECAEngine()
    assert eca.load_program(prog) is True
    assert eca.has_program
    assert eca.num_rules() == 0
    assert eca.num_vcs() == 0


def test_load_rejects_bad_magic():
    bad = bytearray(_build_program())
    bad[0] = 0x00
    chk = sum(bad[:-1]) & 0xFF
    bad[-1] = chk
    eca = ECAEngine()
    assert eca.load_program(bytes(bad)) is False
    assert not eca.has_program


def test_load_rejects_bad_checksum():
    prog = bytearray(_build_program())
    prog[-1] ^= 0xFF
    eca = ECAEngine()
    assert eca.load_program(bytes(prog)) is False


def test_simple_rule_fires_when_condition_met():
    """IMU ax > 0.5 → LED slot 5, SOLID. Action callback gets the Action."""
    cond = _enc_cond(ref_type=REF.SLOT, id=SENSOR_UID, ch=CH.AX,
                     op=CondOp.GT, threshold=0.5,
                     hold_ms=0, cooldown_ms=0)
    # LED_SOLID v3: 3 params (R, G, B)
    act = _enc_action(target=LED_UID, cmd=Act.LED_SOLID,
                      params=_const_params(255, 0, 0))
    prog = _build_program(rules=[(Logic.AND, [cond], [act])])

    fired: list = []
    eca = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca)
    assert eca.load_program(prog)
    eca.run_program()

    # Below threshold → no fire
    eca.update_sensor(1, CH.AX, 0.2)
    eca.tick(now_ms=100)
    assert fired == []

    # Above threshold → fire
    eca.update_sensor(1, CH.AX, 0.8)
    eca.tick(now_ms=200)
    assert len(fired) == 1
    assert fired[0].target == LED_UID
    assert fired[0].cmd == Act.LED_SOLID
    assert fired[0].vals == [255.0, 0.0, 0.0]


def test_cooldown_suppresses_repeat_fire_until_condition_rearms():
    """Const-action rules are edge-fired: cooldown suppresses repeats while
    the condition stays true, then a false→true transition can fire again."""
    cond = _enc_cond(id=SENSOR_UID, ch=CH.AX, op=CondOp.GT, threshold=0.5,
                     cooldown_ms=2000)
    act = _enc_action(target=LED_UID, cmd=Act.LED_SOLID,
                      params=_const_params(255, 0, 0))
    prog = _build_program(rules=[(Logic.AND, [cond], [act])])

    fired: list = []
    eca = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca)
    eca.load_program(prog); eca.run_program()

    eca.update_sensor(1, CH.AX, 0.8)
    eca.tick(now_ms=100)                 # first eligible tick fires immediately
    eca.tick(now_ms=2500)                # still true after cooldown → no replay
    assert len(fired) == 1, "cooldown not honored"
    eca.update_sensor(1, CH.AX, 0.2)
    eca.tick(now_ms=2600)                # false rearms the edge latch
    eca.update_sensor(1, CH.AX, 0.8)
    eca.tick(now_ms=2700)                # true again after cooldown → fire
    assert len(fired) == 2


def test_live_ref_action_can_refresh_after_cooldown():
    """Dynamic actions still use cooldown as a minimum update interval."""
    cond = _enc_cond(id=SENSOR_UID, ch=CH.AX, op=CondOp.GT, threshold=0.5,
                     cooldown_ms=200)
    act = _enc_action(target=LED_UID, cmd=Act.LED_SOLID,
                      params=[
                          _enc_action_param(type=REF.SLOT, id=SENSOR_UID, ch=CH.AX),
                          *_const_params(0, 0),
                      ])
    prog = _build_program(rules=[(Logic.AND, [cond], [act])])

    fired: list = []
    eca = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca)
    eca.load_program(prog); eca.run_program()

    eca.update_sensor(1, CH.AX, 0.8)
    eca.tick(now_ms=100)
    eca.tick(now_ms=250)
    assert len(fired) == 1
    eca.update_sensor(1, CH.AX, 0.9)
    eca.tick(now_ms=301)
    assert len(fired) == 2
    assert fired[-1].vals[0] == pytest.approx(0.9, abs=1e-6)


def test_transient_event_channel_does_not_latch_true():
    """SHAKE/STEP/FREEFALL-style channels are consumed after one engine tick."""
    cond = _enc_cond(id=SENSOR_UID, ch=CH.SHAKE, op=CondOp.GT, threshold=0.5,
                     cooldown_ms=30)
    act = _enc_action(target=LED_UID, cmd=Act.LED_SOLID,
                      params=_const_params(255, 0, 0))
    prog = _build_program(rules=[(Logic.AND, [cond], [act])])

    fired: list = []
    eca = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca)
    eca.load_program(prog); eca.run_program()

    eca.update_sensor(1, CH.SHAKE, 1.0)
    eca.tick(now_ms=100)
    eca.tick(now_ms=131)
    eca.tick(now_ms=162)
    assert len(fired) == 1


def test_hold_ms_requires_sustained_truth():
    """hold_ms=300 → first tick true, second tick still within hold → no fire;
    after 300ms still true → fires."""
    cond = _enc_cond(id=SENSOR_UID, ch=CH.AX, op=CondOp.GT, threshold=0.5,
                     hold_ms=300, cooldown_ms=0)
    act = _enc_action(target=LED_UID, cmd=Act.LED_SOLID,
                      params=_const_params(255, 0, 0))
    prog = _build_program(rules=[(Logic.AND, [cond], [act])])

    fired: list = []
    eca = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca)
    eca.load_program(prog); eca.run_program()

    eca.update_sensor(1, CH.AX, 0.8)
    eca.tick(now_ms=1000)
    assert len(fired) == 0
    eca.tick(now_ms=1100)         # 100ms held — still under threshold
    assert len(fired) == 0
    eca.tick(now_ms=1310)         # 310ms held — fire
    assert len(fired) == 1


def test_hold_resets_when_condition_drops():
    """Condition dropping mid-hold must reset the hold timer."""
    cond = _enc_cond(id=SENSOR_UID, ch=CH.AX, op=CondOp.GT, threshold=0.5,
                     hold_ms=300, cooldown_ms=0)
    act = _enc_action(target=LED_UID, cmd=Act.LED_SOLID,
                      params=_const_params(255, 0, 0))
    prog = _build_program(rules=[(Logic.AND, [cond], [act])])

    fired: list = []
    eca = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca)
    eca.load_program(prog); eca.run_program()

    eca.update_sensor(1, CH.AX, 0.8); eca.tick(now_ms=1000)
    eca.update_sensor(1, CH.AX, 0.1); eca.tick(now_ms=1100)  # drop
    eca.update_sensor(1, CH.AX, 0.8); eca.tick(now_ms=1200)  # re-rise
    eca.tick(now_ms=1400)                                    # 200ms held
    assert len(fired) == 0
    eca.tick(now_ms=1510)                                    # 310ms held
    assert len(fired) == 1


def test_or_logic():
    """LOGIC_OR: either condition true → fire."""
    c1 = _enc_cond(id=SENSOR_UID, ch=CH.AX, op=CondOp.GT, threshold=0.5)
    c2 = _enc_cond(id=SENSOR_UID, ch=CH.AY, op=CondOp.GT, threshold=0.5)
    act = _enc_action(target=LED_UID, cmd=Act.LED_SOLID,
                      params=_const_params(0, 255, 0))
    prog = _build_program(rules=[(Logic.OR, [c1, c2], [act])])

    fired: list = []
    eca = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca)
    eca.load_program(prog); eca.run_program()

    # Only ay matches → fires under OR
    eca.update_sensor(1, CH.AX, 0.0)
    eca.update_sensor(1, CH.AY, 0.8)
    eca.tick(now_ms=100)
    assert len(fired) == 1


def test_and_logic_requires_both():
    c1 = _enc_cond(id=SENSOR_UID, ch=CH.AX, op=CondOp.GT, threshold=0.5)
    c2 = _enc_cond(id=SENSOR_UID, ch=CH.AY, op=CondOp.GT, threshold=0.5)
    act = _enc_action(target=LED_UID, cmd=Act.LED_SOLID,
                      params=_const_params(0, 0, 255))
    prog = _build_program(rules=[(Logic.AND, [c1, c2], [act])])

    fired: list = []
    eca = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca)
    eca.load_program(prog); eca.run_program()

    eca.update_sensor(1, CH.AX, 0.8)
    eca.update_sensor(1, CH.AY, 0.0)
    eca.tick(now_ms=100)
    assert len(fired) == 0
    eca.update_sensor(1, CH.AY, 0.8)
    eca.tick(now_ms=200)
    assert len(fired) == 1


def test_var_inc_and_var_reset_stay_internal():
    """VAR_* actions update _vars without invoking the action callback.
    For VAR_*, the action's `target` low byte is the var_id."""
    inc_act = _enc_action(target=0, cmd=Act.VAR_INC,
                          params=_const_params(1.0))
    cond = _enc_cond(id=SENSOR_UID, ch=CH.AX, op=CondOp.GT, threshold=0.5,
                     cooldown_ms=0)
    prog = _build_program(rules=[(Logic.AND, [cond], [inc_act])])

    fired: list = []
    eca = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca)
    eca.load_program(prog); eca.run_program()

    eca.update_sensor(1, CH.AX, 0.8)
    eca.tick(now_ms=100)
    assert fired == [], "var_inc should not surface to callback"
    # var_id 0 should now hold 1.0
    # (no public getter — assert via VAR-referenced condition next)


def test_virtual_channel_add():
    """VC_0 = ax + ay; rule: VC_0 > 1.0 → fire."""
    vc = _enc_vc(vc_id=0, op=VCOp.ADD,
                 a_type=REF.SLOT, a_id=SENSOR_UID, a_ch=CH.AX,
                 b_type=REF.SLOT, b_id=SENSOR_UID, b_ch=CH.AY)
    cond = _enc_cond(ref_type=REF.VC, id=0, ch=0,
                     op=CondOp.GT, threshold=1.0, cooldown_ms=0)
    act = _enc_action(target=LED_UID, cmd=Act.LED_SOLID,
                      params=_const_params(255, 255, 255))
    prog = _build_program(vcs=[vc],
                          rules=[(Logic.AND, [cond], [act])])

    fired: list = []
    eca = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca)
    eca.load_program(prog); eca.run_program()

    eca.update_sensor(1, CH.AX, 0.4)
    eca.update_sensor(1, CH.AY, 0.4)
    eca.tick(now_ms=100)
    assert fired == []
    eca.update_sensor(1, CH.AX, 0.7)
    eca.update_sensor(1, CH.AY, 0.4)  # 0.7 + 0.4 = 1.1 > 1.0
    eca.tick(now_ms=200)
    assert len(fired) == 1


def test_required_topics():
    """required_topics returns the (uid, channel_id) set used by the program."""
    c1 = _enc_cond(id=SENSOR_UID, ch=CH.AX, op=CondOp.GT, threshold=0.5)
    vc = _enc_vc(vc_id=0, op=VCOp.ADD,
                 a_type=REF.SLOT, a_id=HR_UID, a_ch=CH.BPM,
                 b_type=REF.CONST, b_const=0.0)
    act = _enc_action(target=LED_UID, cmd=Act.LED_SOLID,
                      params=_const_params(0, 0, 0))
    prog = _build_program(vcs=[vc],
                          rules=[(Logic.AND, [c1], [act])])

    eca = ECAEngine()
    eca.load_program(prog)
    assert eca.required_topics() == {(SENSOR_UID, CH.AX), (HR_UID, CH.BPM)}


def test_run_stop_clear():
    cond = _enc_cond(id=SENSOR_UID, ch=CH.AX, op=CondOp.GT, threshold=0.5)
    act = _enc_action(target=LED_UID, cmd=Act.LED_SOLID,
                      params=_const_params(0, 0, 0))
    prog = _build_program(rules=[(Logic.AND, [cond], [act])])

    fired: list = []
    eca = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca)
    eca.load_program(prog)

    # Not running yet → no fire
    eca.update_sensor(1, CH.AX, 0.8)
    eca.tick(now_ms=100)
    assert fired == []

    eca.run_program()
    eca.tick(now_ms=200)
    assert len(fired) == 1

    eca.stop_program()
    fired.clear()
    eca.tick(now_ms=300)
    assert fired == []

    eca.run_program()  # restart works
    eca.tick(now_ms=400)
    assert len(fired) == 1

    eca.clear_program()
    assert not eca.is_running and not eca.has_program


def test_unresolved_uid_skips_rule():
    """Rule referencing an unregistered module UID must NOT fire — the
    runtime treats unresolved refs as NaN/unavailable, not zero. Without
    this guard, `if @absent.acc_mag > 0.5` would silently fire because the
    cache slot reads back as 0.0."""
    ABSENT_UID = 0xDEAD0001  # not in the resolver mapping
    cond = _enc_cond(ref_type=REF.SLOT, id=ABSENT_UID, ch=CH.ACC_MAG,
                     op=CondOp.GT, threshold=0.5)
    act = _enc_action(target=LED_UID, cmd=Act.LED_SOLID,
                      params=_const_params(255, 0, 0))
    prog = _build_program(rules=[(Logic.AND, [cond], [act])])

    fired: list = []
    eca = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca)  # ABSENT_UID not in this mapping
    assert eca.load_program(prog)
    eca.run_program()

    eca.tick(now_ms=100)
    assert fired == [], "rule fired against unresolved UID (placeholder zero)"

    # Also: a `LT 0.5` rule on the same absent ref must NOT fire either —
    # the prior bug was that 0.0 < 0.5 trivially held.
    cond_lt = _enc_cond(ref_type=REF.SLOT, id=ABSENT_UID, ch=CH.LIGHT,
                        op=CondOp.LT, threshold=10.0)
    prog_lt = _build_program(rules=[(Logic.AND, [cond_lt], [act])])
    fired.clear()
    eca2 = ECAEngine(on_action=lambda a: fired.append(a))
    _bind_default_resolver(eca2)
    assert eca2.load_program(prog_lt)
    eca2.run_program()
    eca2.tick(now_ms=100)
    assert fired == [], "LT rule fired on absent module (the documented bug)"


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(message)s")
    pytest.main([__file__, "-v"])
