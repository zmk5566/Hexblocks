import assert from 'node:assert/strict';

import { encodeProgram, REF } from '../js/eca-encoder.js';
import { decodeBytecode } from '../js/eca-decoder.js';

const constant = (value) => ({ type: REF.CONST, id: 0, ch: 0, value });

const program = {
  version: 3,
  variables: [],
  virtual_channels: [],
  rules: [{
    conditions: [],
    logic: 'AND',
    actions: [{
      target: 'FACE0006',
      cmd: 'MOTOR_SET',
      params: [constant(2), constant(2), constant(90), constant(5000)],
    }],
  }],
};

const decoded = decodeBytecode(encodeProgram(program));
const action = decoded.rules[0].actions[0];

assert.equal(action.target, 'FACE0006');
assert.equal(action.cmd, 64, 'MOTOR_SET must use wire command 64');
assert.deepEqual(
  action.params.map((param) => param.value),
  [2, 2, 90, 5000],
  'motor number, mode, speed, and duration must survive bytecode round-trip',
);

console.log('motor protocol round-trip: ok');
