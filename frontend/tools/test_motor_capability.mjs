import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(
  await readFile(new URL('../channel_catalog.json', import.meta.url), 'utf8'),
);
globalThis.fetch = async () => ({ ok: true, json: async () => catalog });

const { loadChannelCatalog, moduleHasRole } = await import('../js/module-channel-map.js');
await loadChannelCatalog();

const motorModule = {
  uid: 'FACE0008',
  active: true,
  capabilities: ['motor_output', 'dual_motor'],
  descriptor: {
    cat: 'motor_output',
    caps: [{ t: 'actuator', m: 'dual_motor', ax: 2 }],
  },
};

assert.equal(
  moduleHasRole(motorModule, 'motor'),
  true,
  'dual-motor descriptors must be selectable by Motor Blockly blocks',
);
assert.equal(moduleHasRole(motorModule, 'led'), false);

const builtinMotor = {
  uid: 'FACE0000',
  active: true,
  face: 0,
  name: 'Built-in Dual Motor',
  descriptor: {
    cat: 'motor_output',
    caps: [{ t: 'actuator', m: 'dual_motor', ax: 2 }],
    affs: ['independent_motor_control', 'built_in'],
  },
};
assert.equal(
  moduleHasRole(builtinMotor, 'motor'),
  true,
  'a face-0 built-in motor must use the same Motor Blockly role',
);

console.log('motor capability role: ok');
