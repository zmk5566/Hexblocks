import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(
  await readFile(new URL('../channel_catalog.json', import.meta.url), 'utf8'),
);
globalThis.fetch = async () => ({ ok: true, json: async () => catalog });

const moduleMap = await import('../js/module-channel-map.js');
await moduleMap.loadChannelCatalog();
const demos = await import('../js/demo-programs.js');
let shouldKeepRule;
try {
  ({ shouldKeepRule } = await import('../js/eca-rule-utils.js'));
} catch (_) {
  shouldKeepRule = undefined;
}

assert.equal(
  typeof demos.getDemoProgram,
  'function',
  'demo loader must be able to bind a preset to discovered hardware',
);

const motorModule = {
  uid: 'A1B2C3D4',
  slot: 0,
  active: true,
  name: 'Built-in Dual Motor',
  capabilities: ['motor_output', 'dual_motor'],
  descriptor: {
    cat: 'motor_output',
    caps: [{ t: 'actuator', m: 'dual_motor', ax: 2 }],
  },
};
const state = demos.getDemoProgram('demo4', [motorModule]);
const rules = state?.blocks?.blocks || [];

assert.equal(rules.length, 1, 'D4 must load one readable Blockly rule');
const first = rules[0]?.inputs?.ACTIONS?.block;
const second = first?.next?.block;
assert.equal(first?.type, 'motor_action');
assert.equal(second?.type, 'motor_action');
assert.deepEqual(first.fields, {
  SLOT: 'A1B2C3D4', MOTOR: '1', MODE: '1', SPEED: 160, DURATION: 2000,
});
assert.deepEqual(second.fields, {
  SLOT: 'A1B2C3D4', MOTOR: '2', MODE: '2', SPEED: 120, DURATION: 3000,
});
assert.equal(
  rules[0]?.inputs?.CONDITIONS,
  undefined,
  'D4 must be an action-only rule because condition constants are not encoded',
);
assert.equal(
  typeof shouldKeepRule,
  'function',
  'Blockly conversion must explicitly support action-only rules',
);
assert.equal(shouldKeepRule([], [{ cmd: 'MOTOR_SET' }]), true);
assert.equal(shouldKeepRule([], []), false);

const fresh = demos.getDemoProgram('demo4', [motorModule]);
first.fields.SPEED = 1;
assert.equal(
  fresh.blocks.blocks[0].inputs.ACTIONS.block.fields.SPEED,
  160,
  'each demo load must return a fresh workspace state',
);

console.log('dual motor demo: ok');
