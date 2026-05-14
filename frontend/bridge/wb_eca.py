"""WearBlocks ECA (Event-Condition-Action) engine — Python reference port.

Mirrors hardware/firmware/lib/WearBlocksECA/WearBlocksECA.{h,cpp} so that a
bytecode program encoded by frontend/js/eca-encoder.js can be loaded and
evaluated entirely in software, without flashing the hub.

Wire format v3 (little-endian u32, big-endian u16, little-endian f32):

    [magic:2=0x57,0x42][version:1=0x03]
    [num_vars:1][var_inits:4f×n]
    [num_vc:1][vc_defs:22B×n]
    [num_rules:1]
      per rule: [num_cond:1][logic:1][num_act:1]
                [cond×n:15B each]
                per action: [target:4][cmd:1][numParams:1][param×N: 10B each]
                  param = [type:1][id:4][ch:1][value:f32]
    [checksum:1]              # sum of all prior bytes, mod 256

v3 vs v2: refs are keyed by **module UID** (4-byte stable id) rather than
the hub-internal slot (1 byte, runtime-assigned). The engine asks the host
(`set_uid_resolver`) to translate uid→slot at execute time. Frontend stores
UIDs in saved workspaces — they survive replug/restart.
"""
from __future__ import annotations

import logging
import math
import struct
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Callable, Optional

logger = logging.getLogger(__name__)


# ── Constants (must mirror eca-encoder.js:29-54) ──────────────────

class CH(IntEnum):
    AX = 0; AY = 1; AZ = 2; GX = 3; GY = 4; GZ = 5
    ACC_MAG = 6; GYRO_MAG = 7; PITCH = 8; ROLL = 9
    AX_LPF = 10; AY_LPF = 11; AZ_LPF = 12; ACC_MAG_LPF = 13; JERK = 14
    SHAKE = 16; STEP = 17; FREEFALL = 18
    BPM = 24; SPO2 = 25; BPM_AVG = 26; HR_HIGH = 27; HR_SPIKE = 28
    CELSIUS = 32; HUMIDITY = 33; HEAT_INDEX = 34
    KNOB = 40
    LIGHT = 41


class REF(IntEnum):
    SLOT = 0; CONST = 1; VC = 2; VAR = 3


class VCOp(IntEnum):
    ADD = 0; SUB = 1; MUL = 2; DIV = 3
    ABS = 4; NEG = 5; MIN = 6; MAX = 7
    MAP = 8; CLAMP = 9; DIFF = 10


class CondOp(IntEnum):
    GT = 0; LT = 1; GTE = 2; LTE = 3; EQ = 4; NEQ = 5


class Logic(IntEnum):
    AND = 0; OR = 1


class Act(IntEnum):
    LED_OFF = 0; LED_SOLID = 1; LED_RAMP = 2; LED_BREATHE = 3
    LED_BLINK = 4; LED_RAINBOW = 5; LED_STOP = 6
    VIBRATE = 16; VIBRATE_PULSE = 17; VIBRATE_RAMP = 18; VIBRATE_STOP = 19
    VAR_SET = 32; VAR_INC = 33; VAR_RESET = 34; VAR_TOGGLE = 35


TRANSIENT_CHANNELS = {
    CH.SHAKE,
    CH.STEP,
    CH.FREEFALL,
    CH.HR_HIGH,
    CH.HR_SPIKE,
}


# Engine limits — mirror WearBlocksECA.h:190-193
MAX_RULES = 16
MAX_VCS = 8
MAX_VARS = 8
MAX_SLOTS = 7  # slots 1-6; index 0 unused
MAX_CH = 48    # WB_CH_MAX
MAGIC_0 = 0x57  # 'W'
MAGIC_1 = 0x42  # 'B'
VERSION = 0x03


# ── Packed record dataclasses ─────────────────────────────────────

@dataclass
class Condition:
    ref_type: int = REF.SLOT
    id: int = 0           # uid (for SLOT), vc_id (VC), var_id (VAR)
    channel_id: int = 0
    op: int = CondOp.GT
    threshold: float = 0.0
    hold_ms: int = 0
    cooldown_ms: int = 0


@dataclass
class VirtualChannel:
    vc_id: int = 0
    op: int = VCOp.ADD
    a_type: int = REF.SLOT
    a_id: int = 0
    a_ch: int = 0
    b_type: int = REF.CONST
    b_id: int = 0
    b_ch: int = 0
    b_const: float = 0.0
    c_const: float = 0.0


@dataclass
class ActionParam:
    """One typed inlet of an action — either a live ref or a CONST."""
    type: int = REF.CONST
    id: int = 0           # uid (SLOT), vc_id (VC), var_id (VAR)
    ch: int = 0
    value: float = 0.0


@dataclass
class Action:
    target: int = 0       # module uid (actuator) or var_id (VAR_*, low byte)
    cmd: int = Act.LED_OFF
    params: list[ActionParam] = field(default_factory=list)
    # Filled by the engine right before on_action fires: resolved floats,
    # one per param. Per-cmd interpretation lives downstream (the bridge's
    # dispatch_action). Length matches `params`.
    vals: list[float] = field(default_factory=list)


@dataclass
class Rule:
    logic: int = Logic.AND
    conditions: list[Condition] = field(default_factory=list)
    actions: list[Action] = field(default_factory=list)


# ── Binary parsers ────────────────────────────────────────────────
#
# Byte order follows eca-encoder.js exactly:
#   u8:  trivial
#   u16: BIG-endian (encoder writes MSB first at line 61)
#   u32: LITTLE-endian (matches C++ memcpy on ARM/x86)
#   f32: LITTLE-endian (Float32Array native order on all common hosts)

def _parse_condition(buf: bytes, off: int) -> Condition:
    return Condition(
        ref_type=buf[off + 0],
        id=struct.unpack_from("<I", buf, off + 1)[0],
        channel_id=buf[off + 5],
        op=buf[off + 6],
        threshold=struct.unpack_from("<f", buf, off + 7)[0],
        hold_ms=struct.unpack_from(">H", buf, off + 11)[0],
        cooldown_ms=struct.unpack_from(">H", buf, off + 13)[0],
    )  # 15 bytes


def _parse_vc(buf: bytes, off: int) -> VirtualChannel:
    return VirtualChannel(
        vc_id=buf[off + 0],
        op=buf[off + 1],
        a_type=buf[off + 2],
        a_id=struct.unpack_from("<I", buf, off + 3)[0],
        a_ch=buf[off + 7],
        b_type=buf[off + 8],
        b_id=struct.unpack_from("<I", buf, off + 9)[0],
        b_ch=buf[off + 13],
        b_const=struct.unpack_from("<f", buf, off + 14)[0],
        c_const=struct.unpack_from("<f", buf, off + 18)[0],
    )  # 22 bytes


def _parse_action(buf: bytes, off: int) -> tuple[Action, int]:
    """Parse a v3 action; return (Action, bytes_consumed).
    Header is 6B (target u32 + cmd u8 + numParams u8); each param is 10B."""
    target = struct.unpack_from("<I", buf, off)[0]
    cmd = buf[off + 4]
    n = buf[off + 5]
    consumed = 6
    params: list[ActionParam] = []
    for _ in range(n):
        p_off = off + consumed
        params.append(ActionParam(
            type=buf[p_off],
            id=struct.unpack_from("<I", buf, p_off + 1)[0],
            ch=buf[p_off + 5],
            value=struct.unpack_from("<f", buf, p_off + 6)[0],
        ))
        consumed += 10
    return Action(target=target, cmd=cmd, params=params), consumed


# ── ECA Engine ────────────────────────────────────────────────────

ActionCallback = Callable[[Action], None]


class ECAEngine:
    """Software port of WearBlocksECA (ESP32 firmware).

    Usage:
        eca = ECAEngine(on_action=my_dispatch)
        eca.load_program(bytes_from_base64)
        eca.run_program()
        while running:
            eca.update_sensor(slot=1, channel_id=CH.AX, value=0.8)
            eca.tick(now_ms=int(time.time() * 1000))
    """

    def __init__(self, on_action: Optional[ActionCallback] = None):
        self._on_action: Optional[ActionCallback] = on_action
        # Host-supplied uid→slot resolver. Returns 0 if uid unknown.
        # Without it, all SLOT-typed refs resolve to 0.
        self._uid_to_slot: Optional[Callable[[int], int]] = None

        # Sensor cache: [slot][channel_id] → float. Slot 0 unused.
        self._cache: list[list[float]] = [
            [0.0] * MAX_CH for _ in range(MAX_SLOTS)
        ]
        self._prev_cache: list[list[float]] = [
            [0.0] * MAX_CH for _ in range(MAX_SLOTS)
        ]
        self._event_fresh: list[list[bool]] = [
            [False] * MAX_CH for _ in range(MAX_SLOTS)
        ]
        self._vc_val: list[float] = [0.0] * MAX_VCS
        self._vars: list[float] = [0.0] * MAX_VARS

        # Program storage
        self._vcs: list[VirtualChannel] = []
        self._rules: list[Rule] = []

        # Per-rule timing
        self._hold_start: list[int] = [0] * MAX_RULES
        self._last_trigger: list[int] = [0] * MAX_RULES
        self._cond_active: list[bool] = [False] * MAX_RULES
        self._last_trigger_valid: list[bool] = [False] * MAX_RULES
        self._rule_latched: list[bool] = [False] * MAX_RULES

        self._running = False
        self._has_program = False

    # ── Host-side wiring ─────────────────────────────────────

    def set_uid_resolver(self, fn: Callable[[int], int]) -> None:
        """Bind the uid→slot lookup. Mirrors WearBlocksECA::setUidResolver."""
        self._uid_to_slot = fn

    # ── Program management ────────────────────────────────────

    def load_program(self, data: bytes) -> bool:
        """Parse + install a bytecode program. Returns False on bad magic,
        bad checksum, truncation, or over-limit counts. Matches
        WearBlocksECA.cpp:91-150."""
        if len(data) < 4:
            logger.error("[ECA] program too short (%d bytes)", len(data))
            return False
        if data[0] != MAGIC_0 or data[1] != MAGIC_1:
            logger.error("[ECA] bad magic: %02X %02X", data[0], data[1])
            return False
        if data[2] != VERSION:
            logger.error("[ECA] bad version: got 0x%02X expected 0x%02X",
                         data[2], VERSION)
            return False
        # Checksum: sum of all bytes except last, mod 256
        chk = sum(data[:-1]) & 0xFF
        if chk != data[-1]:
            logger.error("[ECA] checksum fail: got 0x%02X expected 0x%02X",
                         chk, data[-1])
            return False

        idx = 2                    # skip magic
        # idx[2] is version byte — currently unused but consumed.
        idx += 1

        # Variables
        vars_new = [0.0] * MAX_VARS
        if idx >= len(data) - 1:
            logger.error("[ECA] truncated before num_vars")
            return False
        num_vars = data[idx]; idx += 1
        for i in range(num_vars):
            if idx + 4 > len(data) - 1:
                break
            if i < MAX_VARS:
                vars_new[i] = struct.unpack_from("<f", data, idx)[0]
            idx += 4

        # Virtual channels
        if idx >= len(data) - 1:
            logger.error("[ECA] truncated before num_vc")
            return False
        num_vc = data[idx]; idx += 1
        if num_vc > MAX_VCS:
            logger.error("[ECA] too many VCs: %d", num_vc)
            return False
        vcs_new: list[VirtualChannel] = []
        for _ in range(num_vc):
            if idx + 22 > len(data) - 1:
                break
            vcs_new.append(_parse_vc(data, idx))
            idx += 22

        # Rules
        if idx >= len(data) - 1:
            logger.error("[ECA] truncated before num_rules")
            return False
        num_rules = data[idx]; idx += 1
        if num_rules > MAX_RULES:
            logger.error("[ECA] too many rules: %d", num_rules)
            return False
        rules_new: list[Rule] = []
        for _ in range(num_rules):
            if idx + 3 > len(data) - 1:
                break
            nc = data[idx]; logic = data[idx + 1]; na = data[idx + 2]
            idx += 3
            nc_bounded = min(nc, 4)
            na_bounded = min(na, 4)
            conditions: list[Condition] = []
            for _c in range(nc_bounded):
                if idx + 15 > len(data) - 1:
                    break
                conditions.append(_parse_condition(data, idx))
                idx += 15
            actions: list[Action] = []
            for _a in range(na_bounded):
                if idx + 6 > len(data) - 1:
                    break
                act, consumed = _parse_action(data, idx)
                idx += consumed
                actions.append(act)
            # Skip any actions beyond na_bounded (preserve stream alignment).
            for _a in range(na_bounded, na):
                if idx + 6 > len(data) - 1:
                    break
                _act, consumed = _parse_action(data, idx)
                idx += consumed
            rules_new.append(Rule(logic=logic, conditions=conditions,
                                  actions=actions))

        # Commit
        self._vars = vars_new
        self._vcs = vcs_new
        self._rules = rules_new
        self._hold_start = [0] * MAX_RULES
        self._last_trigger = [0] * MAX_RULES
        self._cond_active = [False] * MAX_RULES
        self._last_trigger_valid = [False] * MAX_RULES
        self._rule_latched = [False] * MAX_RULES
        self._event_fresh = [[False] * MAX_CH for _ in range(MAX_SLOTS)]
        self._vc_val = [0.0] * MAX_VCS
        self._has_program = True
        logger.info("[ECA] loaded: %d VCs, %d rules, %d vars",
                    len(self._vcs), len(self._rules), num_vars)
        return True

    def run_program(self) -> None:
        if self._has_program:
            self._rule_latched = [False] * MAX_RULES
            self._running = True
            logger.info("[ECA] running")

    def stop_program(self) -> None:
        self._running = False
        self._rule_latched = [False] * MAX_RULES
        logger.info("[ECA] stopped")

    def clear_program(self) -> None:
        self._running = False
        self._has_program = False
        self._vcs = []
        self._rules = []
        self._vars = [0.0] * MAX_VARS
        self._rule_latched = [False] * MAX_RULES
        logger.info("[ECA] cleared")

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def has_program(self) -> bool:
        return self._has_program

    def num_rules(self) -> int:
        return len(self._rules)

    def num_vcs(self) -> int:
        return len(self._vcs)

    # ── Sensor cache ─────────────────────────────────────────

    def update_sensor(self, slot: int, channel_id: int, value: float) -> None:
        if not (0 < slot < MAX_SLOTS) or not (0 <= channel_id < MAX_CH):
            return
        self._prev_cache[slot][channel_id] = self._cache[slot][channel_id]
        self._cache[slot][channel_id] = float(value)
        if channel_id in TRANSIENT_CHANNELS:
            self._event_fresh[slot][channel_id] = float(value) >= 0.5

    def get_sensor(self, slot: int, channel_id: int) -> float:
        if not (0 < slot < MAX_SLOTS) or not (0 <= channel_id < MAX_CH):
            return 0.0
        return self._cache[slot][channel_id]

    # ── Value resolution ─────────────────────────────────────

    def _resolve_ref(self, ref_type: int, id_: int,
                     channel_id: int) -> float:
        if ref_type == REF.SLOT:
            # id_ is the module UID (4 bytes). Translate to slot.
            # Unresolved UID ⇒ NaN (not 0) so rules referencing an absent
            # module are skipped instead of firing on a placeholder zero.
            slot = self._uid_to_slot(id_) if self._uid_to_slot else 0
            if 0 < slot < MAX_SLOTS and 0 <= channel_id < MAX_CH:
                if (channel_id in TRANSIENT_CHANNELS
                        and not self._event_fresh[slot][channel_id]):
                    return 0.0
                return self._cache[slot][channel_id]
            return math.nan
        if ref_type == REF.VC:
            vid = id_ & 0xFF
            return self._vc_val[vid] if vid < MAX_VCS else 0.0
        if ref_type == REF.VAR:
            vid = id_ & 0xFF
            return self._vars[vid] if vid < MAX_VARS else 0.0
        # REF.CONST is not resolvable without the inlined value — callers
        # handle it separately (matches WearBlocksECA.cpp:162-173).
        return 0.0

    def _compute_vc(self, vc_idx: int) -> float:
        vc = self._vcs[vc_idx]
        a = self._resolve_ref(vc.a_type, vc.a_id, vc.a_ch)
        b = vc.b_const if vc.b_type == REF.CONST else self._resolve_ref(
            vc.b_type, vc.b_id, vc.b_ch)
        # Unavailable operand ⇒ VC is unavailable. Some ops (MIN/MAX/MAP/CLAMP)
        # would otherwise mask NaN with a finite value; short-circuit instead.
        if math.isnan(a) or math.isnan(b):
            return math.nan
        op = vc.op
        if op == VCOp.ADD: return a + b
        if op == VCOp.SUB: return a - b
        if op == VCOp.MUL: return a * b
        if op == VCOp.DIV: return a / b if b != 0.0 else 0.0
        if op == VCOp.ABS: return abs(a)
        if op == VCOp.NEG: return -a
        if op == VCOp.MIN: return min(a, b)
        if op == VCOp.MAX: return max(a, b)
        if op == VCOp.MAP:
            rng = vc.c_const - vc.b_const
            if abs(rng) < 1e-6:
                return 0.0
            v = (a - vc.b_const) / rng
            return max(0.0, min(1.0, v))
        if op == VCOp.CLAMP:
            return max(vc.b_const, min(vc.c_const, a))
        if op == VCOp.DIFF:
            if vc.a_type == REF.SLOT and self._uid_to_slot:
                slot = self._uid_to_slot(vc.a_id)
                if 0 < slot < MAX_SLOTS and vc.a_ch < MAX_CH:
                    prev = self._prev_cache[slot][vc.a_ch]
                else:
                    prev = 0.0
            else:
                prev = 0.0
            return a - prev
        return 0.0

    # ── Condition evaluation ─────────────────────────────────

    def _evaluate_conditions(self, rule: Rule, rule_idx: int,
                             now_ms: int) -> bool:
        if not rule.conditions:
            return False
        result = True if rule.logic == Logic.AND else False
        for cond in rule.conditions:
            val = self._resolve_ref(cond.ref_type, cond.id, cond.channel_id)
            # Unavailable ref ⇒ rule is undefined this tick. Reset hold state
            # so the timer restarts cleanly when the module reappears.
            if math.isnan(val):
                self._cond_active[rule_idx] = False
                return False
            op = cond.op
            if   op == CondOp.GT:  met = val >  cond.threshold
            elif op == CondOp.LT:  met = val <  cond.threshold
            elif op == CondOp.GTE: met = val >= cond.threshold
            elif op == CondOp.LTE: met = val <= cond.threshold
            elif op == CondOp.EQ:  met = abs(val - cond.threshold) <  0.001
            elif op == CondOp.NEQ: met = abs(val - cond.threshold) >= 0.001
            else:                  met = False
            if rule.logic == Logic.AND:
                result = result and met
            else:
                result = result or met

        # hold_ms: condition must stay true for N ms before firing
        hold = rule.conditions[0].hold_ms
        if hold > 0:
            if result:
                if not self._cond_active[rule_idx]:
                    self._hold_start[rule_idx] = now_ms
                    self._cond_active[rule_idx] = True
                if (now_ms - self._hold_start[rule_idx]) < hold:
                    return False
            else:
                self._cond_active[rule_idx] = False
                return False
        return result

    def _rule_needs_continuous_updates(self, rule: Rule) -> bool:
        for act in rule.actions:
            for p in act.params:
                if p.type != REF.CONST:
                    return True
        return False

    def _clear_transient_events(self) -> None:
        for slot in range(1, MAX_SLOTS):
            for ch in TRANSIENT_CHANNELS:
                self._event_fresh[slot][int(ch)] = False
                self._cache[slot][int(ch)] = 0.0

    # ── Action execution ─────────────────────────────────────

    def _execute_action(self, act: Action) -> None:
        # Resolve all typed params to floats up-front. The C++ engine does
        # the same thing in WearBlocksECA.cpp:executeAction().
        vals: list[float] = []
        for p in act.params:
            if p.type == REF.CONST:
                vals.append(p.value)
            else:
                vals.append(self._resolve_ref(p.type, p.id, p.ch))
        act.vals = vals

        # Unavailable param ⇒ action is meaningless (RGB byte / ms duration /
        # intensity would clamp to garbage). Skip rather than emit nonsense.
        for i, v in enumerate(vals):
            if math.isnan(v):
                logger.info("[ECA] ACT skip: param %d unavailable", i)
                return

        # Variable operations stay inside the engine. For VAR_*, the target's
        # low byte is the var_id.
        vid = act.target & 0xFF
        if act.cmd == Act.VAR_RESET:
            if vid < MAX_VARS:
                self._vars[vid] = 0.0
            logger.info("[ECA] VAR[%d] = 0.0", vid)
            return
        if act.cmd == Act.VAR_TOGGLE:
            if vid < MAX_VARS:
                self._vars[vid] = 0.0 if self._vars[vid] >= 0.5 else 1.0
                logger.info("[ECA] VAR[%d] = %.2f", vid, self._vars[vid])
            return
        if act.cmd == Act.VAR_INC:
            if vid < MAX_VARS and vals:
                self._vars[vid] += vals[0]
                logger.info("[ECA] VAR[%d] += %.2f → %.2f",
                            vid, vals[0], self._vars[vid])
            return
        if act.cmd == Act.VAR_SET:
            if vid < MAX_VARS and vals:
                self._vars[vid] = vals[0]
                logger.info("[ECA] VAR[%d] = %.2f", vid, self._vars[vid])
            return

        # Everything else (LED_*, VIBRATE_*) is an outbound actuator
        # command — delegate to the host via callback. Host is responsible
        # for resolving act.target (uid) → its own slot and applying.
        logger.info("[ECA] ACT target=%08X cmd=%d", act.target, act.cmd)
        if self._on_action is not None:
            self._on_action(act)

    # ── Main tick ────────────────────────────────────────────

    def tick(self, now_ms: int) -> None:
        if not (self._running and self._has_program):
            self._clear_transient_events()
            return
        # 1. compute virtual channels in declaration order
        for i, vc in enumerate(self._vcs):
            if vc.vc_id < MAX_VCS:
                self._vc_val[vc.vc_id] = self._compute_vc(i)
        # 2. evaluate rules
        for r_idx, rule in enumerate(self._rules):
            if not self._evaluate_conditions(rule, r_idx, now_ms):
                self._rule_latched[r_idx] = False
                continue
            cd = rule.conditions[0].cooldown_ms if rule.conditions else 0
            if (cd > 0 and self._last_trigger_valid[r_idx]
                    and (now_ms - self._last_trigger[r_idx]) < cd):
                continue
            continuous = self._rule_needs_continuous_updates(rule)
            if not continuous and self._rule_latched[r_idx]:
                continue
            self._last_trigger[r_idx] = now_ms
            self._last_trigger_valid[r_idx] = True
            self._rule_latched[r_idx] = True
            if continuous:
                self._cond_active[r_idx] = False
            for act in rule.actions:
                self._execute_action(act)
        self._clear_transient_events()

    # ── Topic auto-enable (what channels does the program need) ──

    def required_topics(self) -> set[tuple[int, int]]:
        """Return {(uid, channel_id)} tuples referenced by conditions, action
        params, or VCs. Matches WearBlocksECA::autoEnableTopics. Tuples are
        keyed by UID (not slot) — host is responsible for uid→slot lookup
        before sending sendTopicEnable."""
        out: set[tuple[int, int]] = set()
        for rule in self._rules:
            for cond in rule.conditions:
                if cond.ref_type == REF.SLOT:
                    out.add((cond.id, cond.channel_id))
            for act in rule.actions:
                for p in act.params:
                    if p.type == REF.SLOT:
                        out.add((p.id, p.ch))
        for vc in self._vcs:
            if vc.a_type == REF.SLOT:
                out.add((vc.a_id, vc.a_ch))
            if vc.b_type == REF.SLOT:
                out.add((vc.b_id, vc.b_ch))
        return out
