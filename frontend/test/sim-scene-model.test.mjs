import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSceneLayout,
  faceAngle,
  moduleRole,
  stateForModule,
} from '../js/sim-scene-model.js';

const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9,
  `${actual} should be close to ${expected}`);

test('face angles follow the existing clockwise six-face convention', () => {
  closeTo(faceAngle(1), -Math.PI / 3);
  closeTo(faceAngle(2), 0);
  closeTo(faceAngle(6), Math.PI * 4 / 3);
});

test('layout places root and stacked modules from authoritative topology', () => {
  const modules = [
    { uid: 'FACE0001', face: 2, parent_is_hub: true, parent_face: 2 },
    { uid: 'FACE0002', face: 0, parent_is_hub: false, parent_uid: 'FACE0001', parent_face: 3 },
  ];
  const children = new Map([
    ['FACE0001', new Map([[3, 'FACE0002']])],
  ]);

  const layout = buildSceneLayout(modules, children, 2);
  const root = layout.items.find(item => item.key === 'FACE0001');
  const child = layout.items.find(item => item.key === 'FACE0002');

  closeTo(root.x, 2);
  closeTo(root.z, 0);
  assert.equal(root.parentKey, 'HUB');
  assert.equal(child.parentKey, 'FACE0001');
  assert.equal(child.depth, 2);
  assert.deepEqual(layout.edges, [
    { from: 'HUB', to: 'FACE0001' },
    { from: 'FACE0001', to: 'FACE0002' },
  ]);
});

test('layout retains incomplete topology modules on an orphan rail', () => {
  const layout = buildSceneLayout([{ uid: 'FACE0009', face: 0 }], new Map());
  assert.equal(layout.items.length, 1);
  assert.equal(layout.items[0].orphan, true);
  assert.equal(layout.items[0].parentKey, null);
});

test('module state resolves stable uid maps and role from capabilities', () => {
  const module = { uid: 'FACE0005', capabilities: ['visual', 'LED'] };
  const sensorByUid = new Map([['FACE0005', { data: { light: 0.4 } }]]);
  const actuatorByUid = new Map([['FACE0005', { led: { r: 255, g: 0, b: 0 } }]]);
  assert.deepEqual(stateForModule(module, sensorByUid, actuatorByUid), {
    sensor: { data: { light: 0.4 } },
    actuator: { led: { r: 255, g: 0, b: 0 } },
  });
  assert.equal(moduleRole(module), 'led');
  assert.equal(moduleRole({ id: 'motor', capabilities: ['dual motor'] }), 'motor');
});
