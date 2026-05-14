// Smoke test for Phase 1 — round-trip a few rules through encodeProgram and
// dump them so wb_eca.py can decode and compare. Run with:
//   cd frontend && node tools/smoke_phase1.mjs > /tmp/phase1_bytes.txt
// then in Python:
//   python -c "import base64; from bridge.wb_eca import ECAEngine; e=ECAEngine(); \
//              e.load_program(base64.b64decode(open('/tmp/b64.txt').read().strip()))"
//
// NB: v3 bytecode refs are UID-keyed. The hub resolves UID → current CAN slot
// at runtime, so these examples use stable synthetic UIDs from the simulator.

import { encodeProgram, programToBase64, REF } from '../js/eca-encoder.js';

const IMU_UID = 'FACE0001';
const LED_UID = 'FACE0005';
const VIB_UID = 'FACE0006';

const c = (value) => ({ type: REF.CONST, id: 0, ch: 0, value });

function dump(name, rules) {
  const bytes = encodeProgram(rules);
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ');
  const b64 = programToBase64(rules);
  console.log(`-- ${name} --`);
  console.log(`bytes(${bytes.length}): ${hex}`);
  console.log(`b64: ${b64}`);
}

// (1) UID-keyed SLOT ref, hold_ms = 0.
dump('uid_ref_led', {
  version: 3, variables: [], virtual_channels: [],
  rules: [{
    conditions: [{
      ref: { type: REF.SLOT, id: IMU_UID, ch: 0 },
      op: 'GT', threshold: 0.5, hold_ms: 0, cooldown_ms: 2000,
    }],
    logic: 'AND',
    actions: [{ target: LED_UID, cmd: 'LED_SOLID',
      params: [c(255), c(100), c(0)] }],
  }],
});

// (2) New: VAR ref + hold_ms (Phase 1 capability).
dump('var_ref_with_hold', {
  version: 3, variables: [], virtual_channels: [],
  rules: [{
    conditions: [{
      ref: { type: REF.VAR, id: 3, ch: 0 },
      op: 'GTE', threshold: 1.0, hold_ms: 250, cooldown_ms: 1000,
    }],
    logic: 'AND',
    actions: [{ target: VIB_UID, cmd: 'VIBRATE', params: [c(80), c(300)] }],
  }],
});

// (3) New: VC ref.
dump('vc_ref', {
  version: 3, variables: [], virtual_channels: [],
  rules: [{
    conditions: [{
      ref: { type: REF.VC, id: 2, ch: 0 },
      op: 'LT', threshold: -0.25, hold_ms: 0, cooldown_ms: 500,
    }],
    logic: 'AND',
    actions: [{ target: LED_UID, cmd: 'LED_OFF', params: [] }],
  }],
});

// (4) New: CONST ref (lhs = const, threshold carries value).
dump('const_ref', {
  version: 3, variables: [], virtual_channels: [],
  rules: [{
    conditions: [{
      ref: { type: REF.CONST, id: 0, ch: 0 },
      op: 'EQ', threshold: 3.14, hold_ms: 0, cooldown_ms: 0,
    }],
    logic: 'AND',
    actions: [{ target: LED_UID, cmd: 'LED_OFF', params: [] }],
  }],
});
