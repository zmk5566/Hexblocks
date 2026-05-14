/**
 * eca-decoder.js — Inverse of eca-encoder.js.
 *
 * Decodes WearBlocks ECA bytecode (the same bytes the hub stores in NVS
 * and emits via $EB) back into the JSON Rules schema documented in
 * eca-encoder.js. Pure module — no Blockly, no DOM. Output of
 * decodeBytecode() can be fed straight back to encodeProgram() and must
 * round-trip byte-for-byte; the selftest at the bottom asserts this on
 * every browser load so any drift between encoder and decoder is caught
 * at startup.
 *
 * Also exports describeRules() — turns the rules JSON into human-readable
 * lines for the inspector modal.
 */

import {
  CH, REF, VC_OP, COND_OP, LOGIC, ACT,
  encodeProgram,
} from './eca-encoder.js';

// ── Reverse lookup tables (built from the canonical CH/REF/etc enums) ──

function invert(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[v] = k;
  return out;
}

const CH_NAME      = invert(CH);        // 0  → 'AX'
const REF_NAME     = invert(REF);       // 0  → 'SLOT'
const VC_OP_NAME   = invert(VC_OP);     // 0  → 'ADD'
const COND_OP_NAME = invert(COND_OP);   // 0  → 'GT'
const LOGIC_NAME   = invert(LOGIC);     // 0  → 'AND'
const ACT_NAME     = invert(ACT);       // 1  → 'LED_SOLID'

// Human-friendly channel labels for the inspector. Falls back to CH_NAME
// when a channel id isn't in the table (e.g. future additions).
const CHANNEL_LABEL = {
  [CH.AX]: 'Acc X',  [CH.AY]: 'Acc Y',  [CH.AZ]: 'Acc Z',
  [CH.GX]: 'Gyro X', [CH.GY]: 'Gyro Y', [CH.GZ]: 'Gyro Z',
  [CH.ACC_MAG]: 'Acc magnitude', [CH.GYRO_MAG]: 'Gyro magnitude',
  [CH.PITCH]: 'Pitch', [CH.ROLL]: 'Roll',
  [CH.AX_LPF]: 'Acc X (LPF)', [CH.AY_LPF]: 'Acc Y (LPF)', [CH.AZ_LPF]: 'Acc Z (LPF)',
  [CH.ACC_MAG_LPF]: 'Acc mag (LPF)', [CH.JERK]: 'Jerk',
  [CH.SHAKE]: 'Shake', [CH.STEP]: 'Steps', [CH.FREEFALL]: 'Free-fall',
  [CH.BPM]: 'BPM', [CH.SPO2]: 'SpO₂',
  [CH.BPM_AVG]: 'BPM avg', [CH.HR_HIGH]: 'HR high', [CH.HR_SPIKE]: 'HR spike',
  [CH.CELSIUS]: '°C', [CH.HUMIDITY]: 'Humidity', [CH.HEAT_INDEX]: 'Heat index',
  [CH.KNOB]: 'Knob', [CH.LIGHT]: 'Light',
};

// Per-cmd metadata for the inspector. Names are display text; param names
// label the f32 values inline. Unknown cmds are rendered as "Cmd #<n>".
const ACT_CMD_INFO = {
  [ACT.LED_OFF]:        { name: 'LED off',        params: [] },
  [ACT.LED_SOLID]:      { name: 'LED solid',      params: ['R', 'G', 'B'] },
  [ACT.LED_RAMP]:       { name: 'LED ramp',       params: [] },
  [ACT.LED_BREATHE]:    { name: 'LED breathe',    params: [] },
  [ACT.LED_BLINK]:      { name: 'LED blink',      params: [] },
  [ACT.LED_RAINBOW]:    { name: 'LED rainbow',    params: [] },
  [ACT.LED_STOP]:       { name: 'LED stop',       params: [] },
  [ACT.VIBRATE]:        { name: 'Vibrate',        params: ['intensity%', 'ms'] },
  [ACT.VIBRATE_PULSE]:  { name: 'Vibrate pulse',  params: ['intensity%', 'on×10ms', 'off×10ms', 'count'] },
  [ACT.VIBRATE_RAMP]:   { name: 'Vibrate ramp',   params: ['from%', 'to%', '×100ms'] },
  [ACT.VIBRATE_STOP]:   { name: 'Vibrate stop',   params: [] },
  [ACT.VAR_SET]:        { name: 'Var set',        params: ['value'] },
  [ACT.VAR_INC]:        { name: 'Var inc',        params: ['delta'] },
  [ACT.VAR_RESET]:      { name: 'Var reset',      params: [] },
  [ACT.VAR_TOGGLE]:     { name: 'Var toggle',     params: [] },
  [ACT.AUDIO_SET_TONE]: { name: 'Audio tone',     params: ['freq_lo', 'freq_hi', 'amp'] },
  [ACT.AUDIO_STOP]:     { name: 'Audio stop',     params: [] },
};

const COND_OP_SYM = {
  [COND_OP.GT]: '>', [COND_OP.LT]: '<',
  [COND_OP.GTE]: '≥', [COND_OP.LTE]: '≤',
  [COND_OP.EQ]: '==', [COND_OP.NEQ]: '!=',
};

// ── Binary helpers ──

class ByteReader {
  constructor(bytes) { this.bytes = bytes; this.idx = 0; }
  remaining() { return this.bytes.length - this.idx; }
  u8()  { return this.bytes[this.idx++]; }
  u16() {
    // big-endian (matches ByteWriter.u16 in encoder).
    const hi = this.u8(); const lo = this.u8();
    return (hi << 8) | lo;
  }
  u32() {
    // little-endian (matches encoder's u32; C++ packed struct on ARM/x86).
    const a = this.u8(); const b = this.u8();
    const c = this.u8(); const d = this.u8();
    return ((a) | (b << 8) | (c << 16) | (d << 24)) >>> 0;
  }
  f32() {
    const ab = new ArrayBuffer(4);
    const u = new Uint8Array(ab);
    for (let i = 0; i < 4; i++) u[i] = this.u8();
    return new Float32Array(ab)[0];
  }
}

function uidToHex(n) {
  return (n >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

// Mirror of encoder's refIdToU32: SLOT carries a UID (32-bit), VC/VAR
// carry a small id (low byte). For the decoded JSON we keep SLOT ids as
// uppercase 8-char hex strings (matches what the bridge emits in $H/$D
// and what the frontend's _workspaceToRules already uses), and VC/VAR
// ids as plain integers.
function refIdFromU32(refType, n) {
  if (refType === REF.SLOT) return uidToHex(n);
  return n & 0xFF;
}

// ── Decoder primitives ──

function decodeCondition(r) {
  const ref_type  = r.u8();
  const ref_id    = r.u32();
  const ref_ch    = r.u8();
  const op        = r.u8();
  const threshold = r.f32();
  const hold_ms   = r.u16();
  const cooldown_ms = r.u16();
  return {
    ref: { type: ref_type, id: refIdFromU32(ref_type, ref_id), ch: ref_ch },
    op,
    threshold,
    hold_ms,
    cooldown_ms,
  };
}

function decodeVC(r) {
  const vc_id = r.u8();
  const op    = r.u8();
  const a_type = r.u8(); const a_id = r.u32(); const a_ch = r.u8();
  const b_type = r.u8(); const b_id = r.u32(); const b_ch = r.u8();
  const b_value = r.f32();
  const c_const = r.f32();
  return {
    vc_id, op,
    a: { type: a_type, id: refIdFromU32(a_type, a_id), ch: a_ch },
    b: { type: b_type, id: refIdFromU32(b_type, b_id), ch: b_ch, value: b_value },
    c_const,
  };
}

function decodeActionParam(r) {
  const type  = r.u8();
  const id    = r.u32();
  const ch    = r.u8();
  const value = r.f32();
  return { type, id: refIdFromU32(type, id), ch, value };
}

function decodeAction(r) {
  const target_u32 = r.u32();
  const cmd        = r.u8();
  const numParams  = r.u8();
  const params = [];
  for (let i = 0; i < numParams; i++) params.push(decodeActionParam(r));
  // Target is a UID for actuator cmds; for VAR_* it's a var_id (low byte).
  // We always preserve as 8-char hex so re-encoding produces the same u32.
  return { target: uidToHex(target_u32), cmd, params };
}

// ── Main decoder ──

/**
 * decodeBytecode(input) — Decode WearBlocks ECA bytecode.
 *
 * @param {Uint8Array | string} input — raw bytes or base64 string
 * @returns {object} rules JSON (encoder-compatible)
 * @throws {Error} on bad magic / version / checksum / truncation
 */
export function decodeBytecode(input) {
  let bytes;
  if (typeof input === 'string') {
    const bin = atob(input);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    throw new Error('decodeBytecode: input must be Uint8Array or base64 string');
  }

  if (bytes.length < 4) throw new Error('decodeBytecode: too short');
  if (bytes[0] !== 0x57 || bytes[1] !== 0x42) {
    throw new Error(`decodeBytecode: bad magic 0x${bytes[0].toString(16)}${bytes[1].toString(16)}`);
  }
  const version = bytes[2];
  if (version !== 0x03) throw new Error(`decodeBytecode: bad version 0x${version.toString(16)}`);

  // Verify checksum (sum of all bytes except last == last byte)
  let chk = 0;
  for (let i = 0; i < bytes.length - 1; i++) chk = (chk + bytes[i]) & 0xFF;
  if (chk !== bytes[bytes.length - 1]) {
    throw new Error(`decodeBytecode: checksum mismatch got=0x${chk.toString(16)} want=0x${bytes[bytes.length-1].toString(16)}`);
  }

  // Parse over a slice excluding the final checksum byte so the reader
  // can't accidentally consume it as part of a payload.
  const r = new ByteReader(bytes.subarray(0, bytes.length - 1));
  r.idx = 3;  // skip magic + version

  const numVars = r.u8();
  const variables = [];
  for (let i = 0; i < numVars; i++) variables.push(r.f32());

  const numVCs = r.u8();
  const virtual_channels = [];
  for (let i = 0; i < numVCs; i++) virtual_channels.push(decodeVC(r));

  const numRules = r.u8();
  const rules = [];
  for (let i = 0; i < numRules; i++) {
    const num_cond = r.u8();
    const logic    = r.u8();
    const num_act  = r.u8();
    const conditions = [];
    for (let c = 0; c < num_cond; c++) conditions.push(decodeCondition(r));
    const actions = [];
    for (let a = 0; a < num_act; a++) actions.push(decodeAction(r));
    rules.push({ conditions, logic, actions });
  }

  return { version, variables, virtual_channels, rules };
}

// ── Human-readable formatting (for the inspector) ──

// f32 round-trips introduce tiny noise (0.3 → 0.30000001192...). Rounding
// to 7 significant digits, then back to a Number, restores the human
// representation without harming faithful values.
function fmtNum(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  return String(Number.parseFloat(v.toPrecision(7)));
}

function fmtRef(ref, modulesByUid) {
  if (!ref) return '?';
  switch (ref.type) {
    case REF.SLOT: {
      const uid = String(ref.id || '').toUpperCase();
      const mod = modulesByUid && modulesByUid[uid];
      const modName = mod ? (mod.name || mod.id || uid) : uid;
      const chLabel = CHANNEL_LABEL[ref.ch] ?? CH_NAME[ref.ch] ?? `ch${ref.ch}`;
      return `${modName}.${chLabel}`;
    }
    case REF.CONST: return fmtNum(ref.value ?? 0);
    case REF.VC:    return `vc${ref.id}`;
    case REF.VAR:   return `var${ref.id}`;
    default:        return `?(type${ref.type})`;
  }
}

function fmtCondition(c, modulesByUid) {
  const sym = COND_OP_SYM[c.op] ?? `?op${c.op}`;
  const hold = c.hold_ms ? ` hold ${c.hold_ms}ms` : '';
  const cd   = c.cooldown_ms ? ` cooldown ${c.cooldown_ms}ms` : '';
  return `${fmtRef(c.ref, modulesByUid)} ${sym} ${fmtNum(c.threshold)}${hold}${cd}`;
}

function fmtAction(a, modulesByUid) {
  const info = ACT_CMD_INFO[a.cmd] || { name: `Cmd #${a.cmd}`, params: [] };
  const targetMod = modulesByUid && modulesByUid[a.target];
  const targetName = targetMod ? (targetMod.name || targetMod.id || a.target) : a.target;
  const isVarCmd = a.cmd === ACT.VAR_SET || a.cmd === ACT.VAR_INC ||
                   a.cmd === ACT.VAR_RESET || a.cmd === ACT.VAR_TOGGLE;
  const target = isVarCmd ? `var${parseInt(a.target, 16) & 0xFF}` : targetName;
  const paramTexts = (a.params || []).map((p, i) => {
    const label = info.params[i];
    const val = (p.type === REF.CONST) ? fmtNum(p.value) : `(${fmtRef(p, modulesByUid)})`;
    return label ? `${label}=${val}` : String(val);
  });
  const paramStr = paramTexts.length ? ` [${paramTexts.join(', ')}]` : '';
  return `${target} → ${info.name}${paramStr}`;
}

function fmtVC(vc, modulesByUid) {
  const opName = VC_OP_NAME[vc.op] ?? `op${vc.op}`;
  const a = fmtRef(vc.a, modulesByUid);
  const b = (vc.b.type === REF.CONST) ? fmtNum(vc.b.value) : fmtRef(vc.b, modulesByUid);
  const tail = (vc.op === VC_OP.MAP || vc.op === VC_OP.CLAMP) ? `, c=${fmtNum(vc.c_const)}` : '';
  return `vc${vc.vc_id} = ${opName}(${a}, ${b}${tail})`;
}

/**
 * describeRules(rules, modulesByUid?) — Render rules JSON as readable lines.
 *
 * @param {object} rules — output of decodeBytecode()
 * @param {object} [modulesByUid] — optional map { "A1B2C3D4": {id, name} }
 *   used to display module names instead of raw UIDs.
 * @returns {string[]} one human-readable line per rule / VC / variable.
 */
export function describeRules(rules, modulesByUid) {
  const out = [];
  const vars = rules.variables || [];
  vars.forEach((v, i) => out.push(`var${i} = ${fmtNum(v)}`));
  const vcs = rules.virtual_channels || [];
  vcs.forEach(vc => out.push(fmtVC(vc, modulesByUid)));
  const ruleList = rules.rules || [];
  ruleList.forEach((rule, i) => {
    const logicWord = LOGIC_NAME[rule.logic] || 'AND';
    const condLines = (rule.conditions || []).map(c => fmtCondition(c, modulesByUid));
    const condStr = condLines.length === 1
      ? condLines[0]
      : condLines.join(`  [${logicWord}]  `);
    out.push(`Rule ${i + 1}: When ${condStr}`);
    (rule.actions || []).forEach(a => out.push(`         → ${fmtAction(a, modulesByUid)}`));
  });
  return out;
}

// ── Self-test ──

// Hand-crafted fixtures that exercise every part of the binary format:
// variables, multiple VC ops, multiple conditions per rule (AND/OR),
// each ref type, and one action of each major category.
const SELFTEST_FIXTURES = [
  // Minimal: no vars, no vcs, single rule with one cond + one LED action.
  {
    version: 3,
    variables: [],
    virtual_channels: [],
    rules: [{
      conditions: [{
        ref: { type: REF.SLOT, id: 'A1B2C3D4', ch: CH.LIGHT },
        op: COND_OP.LT, threshold: 0.3, hold_ms: 0, cooldown_ms: 1000,
      }],
      logic: LOGIC.AND,
      actions: [{
        target: 'DEADBEEF', cmd: ACT.LED_SOLID,
        params: [
          { type: REF.CONST, id: '00000000', ch: 0, value: 255 },
          { type: REF.CONST, id: '00000000', ch: 0, value: 220 },
          { type: REF.CONST, id: '00000000', ch: 0, value: 160 },
        ],
      }],
    }],
  },
  // VC + audio + non-CONST action param (vc-driven freq).
  {
    version: 3,
    variables: [],
    virtual_channels: [{
      vc_id: 0, op: VC_OP.MAP,
      a: { type: REF.SLOT, id: 'A1B2C3D4', ch: CH.LIGHT },
      b: { type: REF.CONST, id: '00000000', ch: 0, value: 0 },
      c_const: 1,
    }],
    rules: [{
      conditions: [{
        ref: { type: REF.CONST, id: '00000000', ch: 0 },
        op: COND_OP.GTE, threshold: 0, hold_ms: 0, cooldown_ms: 0,
      }],
      logic: LOGIC.AND,
      actions: [{
        target: 'CAFEBABE', cmd: ACT.AUDIO_SET_TONE,
        params: [
          { type: REF.VC, id: 0, ch: 0, value: 0 },
          { type: REF.CONST, id: '00000000', ch: 0, value: 2000 },
          { type: REF.CONST, id: '00000000', ch: 0, value: 200 },
        ],
      }],
    }],
  },
  // Variables + var actions + 2-cond OR + vibrate.
  {
    version: 3,
    variables: [0.0, 1.5, -3.25],
    virtual_channels: [
      { vc_id: 1, op: VC_OP.MUL,
        a: { type: REF.SLOT, id: 'AABBCCDD', ch: CH.AX },
        b: { type: REF.CONST, id: '00000000', ch: 0, value: 2.5 },
        c_const: 0,
      },
      { vc_id: 2, op: VC_OP.CLAMP,
        a: { type: REF.VC, id: 1, ch: 0 },
        b: { type: REF.CONST, id: '00000000', ch: 0, value: -10 },
        c_const: 10,
      },
    ],
    rules: [{
      conditions: [
        { ref: { type: REF.SLOT, id: 'A1B2C3D4', ch: CH.ACC_MAG },
          op: COND_OP.GT, threshold: 1.5, hold_ms: 100, cooldown_ms: 500 },
        { ref: { type: REF.VAR, id: 0, ch: 0 },
          op: COND_OP.EQ, threshold: 0, hold_ms: 0, cooldown_ms: 0 },
      ],
      logic: LOGIC.OR,
      actions: [
        { target: 'DEADBEEF', cmd: ACT.VIBRATE,
          params: [
            { type: REF.CONST, id: '00000000', ch: 0, value: 80 },
            { type: REF.CONST, id: '00000000', ch: 0, value: 200 },
          ],
        },
        { target: '00000000', cmd: ACT.VAR_SET,  // target's low byte = var_id 0
          params: [{ type: REF.CONST, id: '00000000', ch: 0, value: 1 }],
        },
      ],
    }],
  },
];

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function selftest() {
  for (let i = 0; i < SELFTEST_FIXTURES.length; i++) {
    const original = SELFTEST_FIXTURES[i];
    const enc1 = encodeProgram(original);
    let decoded;
    try {
      decoded = decodeBytecode(enc1);
    } catch (e) {
      throw new Error(`[eca-decoder] selftest fixture ${i}: decode threw ${e.message}`);
    }
    const enc2 = encodeProgram(decoded);
    if (!bytesEqual(enc1, enc2)) {
      throw new Error(`[eca-decoder] selftest fixture ${i}: round-trip mismatch ` +
                      `(${enc1.length} → ${enc2.length} bytes)`);
    }
  }
  return SELFTEST_FIXTURES.length;
}

// Run on import so any drift between encoder and decoder is caught at
// page load time. Failure logs loudly but does not throw — a broken
// inspector is preferable to a blank app.
try {
  const n = selftest();
  console.log(`[eca-decoder] selftest OK (${n} fixtures × encode→decode→encode)`);
} catch (e) {
  console.error(e.message);
}
