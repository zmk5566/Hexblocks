// Phase 2 smoke: a rule driven by virtual channels over UID-keyed refs.
import { encodeProgram, programToBase64, REF } from '../js/eca-encoder.js';

const IMU_UID = 'FACE0001';
const HR_UID = 'FACE0002';
const LED_UID = 'FACE0005';
const c = (value) => ({ type: REF.CONST, id: 0, ch: 0, value });

const rules = {
  version: 3,
  variables: [],
  virtual_channels: [
    // vc0 := DIFF(imu.ax)  → one-sample derivative
    { vc_id: 0, op: 'DIFF',
      a: { type: REF.SLOT, id: IMU_UID, ch: 0 },
      b: c(0),
      c_const: 0 },
    // vc1 := MAP(hr.bpm, 60 → 100) → normalised 0..1
    { vc_id: 1, op: 'MAP',
      a: { type: REF.SLOT, id: HR_UID, ch: 24 /* BPM */ },
      b: c(60),
      c_const: 100 },
  ],
  rules: [{
    conditions: [
      { ref: { type: REF.VC, id: 0, ch: 0 },
        op: 'GT', threshold: 0.8, hold_ms: 0, cooldown_ms: 500 },
      { ref: { type: REF.VC, id: 1, ch: 0 },
        op: 'GT', threshold: 0.5, hold_ms: 200, cooldown_ms: 1000 },
    ],
    logic: 'AND',
    actions: [{ target: LED_UID, cmd: 'LED_BREATHE',
                params: [c(255), c(0), c(255), c(100)] }],
  }],
};

const bytes = encodeProgram(rules);
const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ');
console.log(`bytes(${bytes.length}): ${hex}`);
console.log(`b64: ${programToBase64(rules)}`);
