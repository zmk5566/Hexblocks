/**
 * eca-encoder.js — WearBlocks ECA bytecode encoder.
 *
 * Converts a JSON Rules object into the binary bytecode format
 * understood by the Hub's ECA engine, then encodes as base64
 * for the $P serial command.
 *
 * JSON Rules schema:
 *   {
 *     version: 1,
 *     variables: [0.0, ...],        // initial values for var0-var7
 *     virtual_channels: [
 *       { vc_id, op, a: {type,slot,ch}, b: {type,slot,ch,value}, c_const }
 *     ],
 *     rules: [
 *       {
 *         conditions: [
 *           { ref: {type,slot,ch}, op, threshold, hold_ms, cooldown_ms }
 *         ],
 *         logic: "AND"|"OR",
 *         actions: [
 *           { slot, cmd, p: [p0,p1,...p9] }
 *         ]
 *       }
 *     ]
 *   }
 */

// ── Channel IDs (must match WearBlocksECA.h) ──
export const CH = {
  AX: 0, AY: 1, AZ: 2, GX: 3, GY: 4, GZ: 5,
  ACC_MAG: 6, GYRO_MAG: 7, PITCH: 8, ROLL: 9,
  AX_LPF: 10, AY_LPF: 11, AZ_LPF: 12, ACC_MAG_LPF: 13, JERK: 14,
  SHAKE: 16, STEP: 17, FREEFALL: 18,
  BPM: 24, SPO2: 25, BPM_AVG: 26, HR_HIGH: 27, HR_SPIKE: 28,
  CELSIUS: 32, HUMIDITY: 33, HEAT_INDEX: 34,
  KNOB: 40,
  LIGHT: 41,
};

export const REF = { SLOT: 0, CONST: 1, VC: 2, VAR: 3 };

export const VC_OP = {
  ADD: 0, SUB: 1, MUL: 2, DIV: 3, ABS: 4, NEG: 5,
  MIN: 6, MAX: 7, MAP: 8, CLAMP: 9, DIFF: 10,
};

export const COND_OP = { GT: 0, LT: 1, GTE: 2, LTE: 3, EQ: 4, NEQ: 5 };
export const LOGIC = { AND: 0, OR: 1 };

export const ACT = {
  LED_OFF: 0, LED_SOLID: 1, LED_RAMP: 2, LED_BREATHE: 3,
  LED_BLINK: 4, LED_RAINBOW: 5, LED_STOP: 6,
  VIBRATE: 16, VIBRATE_PULSE: 17, VIBRATE_RAMP: 18, VIBRATE_STOP: 19,
  VAR_SET: 32, VAR_INC: 33, VAR_RESET: 34, VAR_TOGGLE: 35,
  AUDIO_SET_TONE: 48, AUDIO_STOP: 49,
};

// ── Binary helpers ──

class ByteWriter {
  constructor() { this.buf = []; }
  u8(v)  { this.buf.push(v & 0xFF); }
  u16(v) { this.u8((v >> 8) & 0xFF); this.u8(v & 0xFF); }
  u32(v) {
    // little-endian, matches the C++ packed structs (memcpy on ARM/x86).
    this.u8(v & 0xFF);
    this.u8((v >>> 8) & 0xFF);
    this.u8((v >>> 16) & 0xFF);
    this.u8((v >>> 24) & 0xFF);
  }
  f32(v) {
    const ab = new ArrayBuffer(4);
    new Float32Array(ab)[0] = v;
    const bytes = new Uint8Array(ab);
    for (const b of bytes) this.u8(b);
  }
  bytes(arr, len) {
    for (let i = 0; i < len; i++) this.u8(arr[i] || 0);
  }
  toUint8Array() { return new Uint8Array(this.buf); }
}

// Caller-side helper: hex string ("a1b2c3d4") → uint32. Accepts numbers
// (passes through), null/undefined (→ 0), or strings (parsed as base-16).
function refIdToU32(id) {
  if (id == null) return 0;
  if (typeof id === 'number') return id >>> 0;
  // Strip optional 0x prefix; parseInt with radix 16 handles the rest.
  const s = String(id).replace(/^0x/i, '');
  const n = parseInt(s, 16);
  return Number.isNaN(n) ? 0 : (n >>> 0);
}

// ── Condition encoder (15 bytes) ──

function encodeCondition(w, cond) {
  const ref = cond.ref || {};
  w.u8(ref.type ?? REF.SLOT);
  // v3: ref.id is the module UID (4 bytes) for SLOT, or vc_id/var_id for VC/VAR.
  // Accepts hex string or number.
  w.u32(refIdToU32(ref.id ?? ref.uid));
  w.u8(ref.ch ?? 0);
  w.u8(typeof cond.op === 'string' ? (COND_OP[cond.op] ?? 0) : (cond.op ?? 0));
  w.f32(cond.threshold ?? 0);
  w.u16(cond.hold_ms ?? 0);
  w.u16(cond.cooldown_ms ?? 0);
}

// ── Virtual Channel encoder (22 bytes) ──

function encodeVC(w, vc) {
  w.u8(vc.vc_id ?? 0);
  w.u8(typeof vc.op === 'string' ? (VC_OP[vc.op] ?? 0) : (vc.op ?? 0));
  const a = vc.a || {};
  w.u8(a.type ?? REF.SLOT);
  w.u32(refIdToU32(a.id ?? a.uid));
  w.u8(a.ch ?? 0);
  const b = vc.b || {};
  w.u8(b.type ?? REF.CONST);
  w.u32(refIdToU32(b.id ?? b.uid));
  w.u8(b.ch ?? 0);
  w.f32(b.value ?? 0);       // b_const
  w.f32(vc.c_const ?? 0);    // c_const
}

// ── Action encoder (v3: variable length) ──
//
// Per action: [target:4][cmd:1][numParams:1][param×N]
// Each param: [type:1][id:4][ch:1][value:f32]  (10 bytes)
//
// `target` is a module UID (for actuator cmds) or var_id (for VAR_*, low
// byte only). Param semantics per cmd are spelled out in
// WearBlocksECA.h:WBActCmd. `act.params` is a list of {type, id, ch, value}
// objects. For pure constants, callers can use shorthand `{value: 42}` (type
// defaults to CONST).

function encodeActionParam(w, p) {
  w.u8(p?.type ?? REF.CONST);
  w.u32(refIdToU32(p?.id ?? p?.uid));
  w.u8(p?.ch ?? 0);
  w.f32(p?.value ?? 0);
}

function encodeAction(w, act) {
  w.u32(refIdToU32(act.target ?? act.uid ?? act.slot));
  w.u8(typeof act.cmd === 'string' ? (ACT[act.cmd] ?? 0) : (act.cmd ?? 0));
  const params = act.params || [];
  w.u8(params.length);
  for (const p of params) encodeActionParam(w, p);
}

// ── Main encoder ──

export function encodeProgram(rules) {
  const w = new ByteWriter();

  // Magic + version
  w.u8(0x57); w.u8(0x42);  // "WB"
  w.u8(rules.version ?? 3);

  // Variables
  const vars = rules.variables || [];
  w.u8(vars.length);
  for (const v of vars) w.f32(v);

  // Virtual channels
  const vcs = rules.virtual_channels || [];
  w.u8(vcs.length);
  for (const vc of vcs) encodeVC(w, vc);

  // Rules
  const ruleList = rules.rules || [];
  w.u8(ruleList.length);
  for (const rule of ruleList) {
    const conds = rule.conditions || [];
    const acts = rule.actions || [];
    w.u8(conds.length);
    w.u8(typeof rule.logic === 'string' ? (LOGIC[rule.logic] ?? 0) : (rule.logic ?? 0));
    w.u8(acts.length);
    for (const c of conds) encodeCondition(w, c);
    for (const a of acts)  encodeAction(w, a);
  }

  // Checksum
  const data = w.toUint8Array();
  let chk = 0;
  for (const b of data) chk = (chk + b) & 0xFF;
  w.u8(chk);

  return w.toUint8Array();
}

// ── Base64 ──

export function programToBase64(rules) {
  const bytes = encodeProgram(rules);
  // Use btoa for browser env
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ── Convenience: build a simple rule from shorthand ──
//
// `actParams` is a list of constant-valued numbers (or already-shaped param
// objects). Plain numbers are wrapped as {type: CONST, value: n}.
// `uid` / `actUid` are module UIDs (hex string or number) — v3 keys refs by
// UID, not slot.

export function simpleRule({ uid, channel, op, threshold, cooldown_ms = 2000,
                             actUid, actCmd, actParams = [] }) {
  const params = actParams.map(p =>
    (typeof p === 'number')
      ? { type: REF.CONST, id: 0, ch: 0, value: p }
      : p);
  return {
    version: 3,
    variables: [],
    virtual_channels: [],
    rules: [{
      conditions: [{
        ref: { type: REF.SLOT, id: uid, ch: channel },
        op: op ?? 'GT',
        threshold: threshold ?? 1.0,
        hold_ms: 0,
        cooldown_ms,
      }],
      logic: 'AND',
      actions: [{
        target: actUid,
        cmd: actCmd,
        params,
      }],
    }],
  };
}
