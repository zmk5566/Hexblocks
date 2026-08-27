# Empty Topology and Dual Motor Demo Design

## Goal

Make the frontend distinguish an available Hub from an empty bridge connection, and add a Blockly example that demonstrates independent control of the two motor channels.

## Hub Presence

The browser's WebSocket connection only means that the frontend can reach the Python bridge. It does not prove that a physical Hub exists. The topology therefore considers a Hub present when either:

- the bridge reports an active USB or BLE transport; or
- at least one module is visible, as happens after a simulator preset attaches its modules.

When neither condition is true, the palette does not render a Hub row and the topology canvas does not render the Hub, face edges, or face ghosts. Both areas show a short connection prompt instead. A connected physical Hub remains visible even when it has no attached modules.

## Dual Motor Blockly Example

The status bar gains `D4 Dual Motor Test` beside the existing Night Light, Theremin, and Motion Alert examples. In simulator mode, D4 clears the topology and attaches a built-in `motor_hub` actuator. After module discovery settles, the frontend loads one Blockly rule containing two chained motor actions:

1. M1 forward, speed 160, duration 2000 ms.
2. M2 reverse, speed 120, duration 3000 ms.

The two actions target the same discovered dual-motor actuator but preserve separate motor number, direction, speed, and duration fields. The demo state is rebound to the first active motor-capable module at load time, so the visible dropdown contains the live UID for either a motor-hub's built-in actuator or an external motor module. If no motor is present, the saved placeholder remains visible and upload validation reports the unresolved target.

## Scope

This change only affects initial Hub visibility and the demonstration preset. It does not add encoder feedback, vehicle-level movement blocks, acceleration ramps, braking modes, or nFAULT handling.

## Verification

- A pure frontend test covers Hub-presence decisions for disconnected, transport-connected, and simulator-module states.
- A JavaScript demo test verifies the two motor blocks, their independent fields, and live-UID rebinding.
- A Python simulator test verifies that D4 clears the old topology and attaches the built-in motor actuator.
- Existing frontend protocol tests and bridge tests remain green.
