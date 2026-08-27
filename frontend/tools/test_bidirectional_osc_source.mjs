import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const bridge = read('frontend/bridge/serial_bridge.py');
const ingress = read('frontend/bridge/osc_ingress.py');
const protocol = read('frontend/bridge/wb_protocol.py');
const hub = read('hardware/firmware/hub/hub.ino');
const motorHub = read('hardware/firmware/motor_hub/motor_hub.ino');
const wirelessCpp = read('hardware/firmware/lib/WearBlocksWireless/WearBlocksWireless.cpp');
const wirelessH = read('hardware/firmware/lib/WearBlocksWireless/WearBlocksWireless.h');
const app = read('frontend/js/components/wb-app.js');
const status = read('frontend/js/components/wb-status-bar.js');
const panel = read('frontend/js/components/wb-osc-panel.js');

assert.match(ingress, /\/hex\/control\/<uid>\/actuator/,
  'OSC ingress must expose the UID-keyed actuator address');
assert.match(ingress, /\$AO \{self\.request_id\}/,
  'OSC ingress must preserve request IDs on the serial command');
assert.match(bridge, /_handle_osc_bridge_event/,
  'the bridge must correlate Hub results back to OSC callers');
assert.match(protocol, /wireless_command_result/,
  'the wire parser must expose module ACK and NACK results');

for (const source of [hub, motorHub]) {
  assert.match(source, /strncmp\(cmd, "\$AO ", 4\)/,
    'each Hub variant must accept correlated actuator commands');
  assert.match(source, /\$AS,/,
    'each Hub variant must emit the routed actuator state');
}

assert.match(hub, /WB_WIFI_COMMAND_MAX_ATTEMPTS/,
  'wifi_hub must bound command retries');
assert.match(hub, /handleWirelessCommandResult/,
  'wifi_hub must consume module ACK and NACK packets');
assert.match(hub, /wifiFindPendingAction/,
  'stream updates must coalesce while an ACK is outstanding');
assert.match(wirelessH, /_lastActionMsgId/,
  'wireless modules must retain the last action message ID');
assert.match(wirelessCpp, /msgId == _lastActionMsgId/,
  'retried actions must be ACKed without executing twice');
assert.match(wirelessCpp, /msgId == _lastTopicMsgId/,
  'retried topic changes must be ACKed without executing twice');

for (const sketch of [
  'module_led', 'module_vibration', 'module_amplifier',
  'module_motor', 'module_imu',
]) {
  const source = read(`hardware/firmware/${sketch}/${sketch}.ino`);
  assert.match(source, /WearBlocksWireless\.h/,
    `${sketch} must use the shared wireless runtime`);
  assert.match(source, /wireless\.(begin|tick)/,
    `${sketch} must run the wireless lifecycle`);
}

assert.match(app, /wb-sim-stage/,
  'the app must mount the Three.js digital twin');
assert.match(status, /3D Twin/,
  'the status bar must expose the digital twin');
assert.match(panel, /Control return path/,
  'the OSC panel must document the bidirectional control address');

console.log('bidirectional OSC: ingress, correlation, retry, dedup, and twin wiring ok');
