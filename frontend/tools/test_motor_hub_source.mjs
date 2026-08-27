import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const header = readFileSync(
  new URL('../../hardware/firmware/lib/WearBlocksECA/WearBlocksECA.h', import.meta.url),
  'utf8',
);
const source = readFileSync(
  new URL('../../hardware/firmware/lib/WearBlocksECA/WearBlocksECA.cpp', import.meta.url),
  'utf8',
);

assert.match(
  header,
  /typedef bool \(\*WBLocalActuatorCallback\)\(uint32_t targetUid, uint8_t cmd,/,
  'ECA must expose a UID-keyed local actuator callback',
);
assert.match(
  header,
  /void setLocalActuatorHandler\(WBLocalActuatorCallback cb\)/,
  'ECA must let a hub install its local actuator handler',
);

const localDispatch = source.indexOf('_localActuator(');
const unresolvedTarget = source.indexOf('not registered');
assert.ok(localDispatch >= 0, 'ECA must attempt local actuator dispatch');
assert.ok(
  localDispatch < unresolvedTarget,
  'local targets must be handled before a missing CAN slot rejects them',
);
assert.match(
  source,
  /_proto->sendActuatorCommand\(/,
  'unhandled targets must retain the CAN actuator fallback',
);

const motorHubUrl = new URL(
  '../../hardware/firmware/motor_hub/motor_hub.ino',
  import.meta.url,
);
assert.ok(existsSync(motorHubUrl), 'motor-hub must be a separate firmware target');
const motorHub = readFileSync(motorHubUrl, 'utf8');
assert.match(motorHub, /FACE_PIN\s*=\s*5/, 'motor-hub Face 1 must use GPIO5');
assert.match(motorHub, /NimBLEDevice/, 'motor-hub must provide direct BLE transport');
assert.match(
  motorHub,
  /setLocalActuatorHandler/,
  'motor-hub must register local ECA actuator routing',
);
assert.match(
  motorHub,
  /Built-in Dual Motor/,
  'motor-hub must advertise its onboard motors to the frontend',
);
assert.match(motorHub, /ACT_MOTOR_SET/, 'motor-hub must execute MOTOR_SET locally');
assert.match(
  motorHub,
  /protocol\.onHello/,
  'motor-hub must retain CAN enumeration for external modules',
);

console.log('motor hub ECA routing contract: ok');
