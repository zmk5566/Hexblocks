import assert from 'node:assert/strict';

let hasHubPresence;
let modulesAfterTransportStatus;
try {
  ({ hasHubPresence, modulesAfterTransportStatus } =
    await import('../js/hub-presence.js'));
} catch (_) {
  hasHubPresence = undefined;
  modulesAfterTransportStatus = undefined;
}

assert.equal(
  typeof hasHubPresence,
  'function',
  'frontend must expose a Hub-presence decision independent of bridge WebSocket state',
);
assert.equal(hasHubPresence({ connected: false }, []), false);
assert.equal(hasHubPresence({ connected: true }, []), true);
assert.equal(
  hasHubPresence({ connected: false }, [{ uid: 'FACE0001', active: true }]),
  true,
);

assert.equal(
  typeof modulesAfterTransportStatus,
  'function',
  'frontend must discard module records when the hardware transport disconnects',
);
const staleBuiltinMotor = [{
  uid: 'FACE0000', active: true, face: 0, name: 'Built-in Dual Motor',
}];
const afterDisconnect = modulesAfterTransportStatus(
  staleBuiltinMotor,
  { type: 'transport_status', transport: null, connected: false },
);
assert.deepEqual(afterDisconnect, []);
assert.equal(hasHubPresence({ connected: false }, afterDisconnect), false);
assert.equal(
  modulesAfterTransportStatus(
    staleBuiltinMotor,
    { type: 'transport_status', transport: 'ble', connected: true },
  ),
  staleBuiltinMotor,
  'a live transport must retain its discovered modules',
);

console.log('hub presence: ok');
