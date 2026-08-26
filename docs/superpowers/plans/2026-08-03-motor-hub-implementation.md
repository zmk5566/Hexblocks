# Motor Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a BLE/USB-capable one-face motor-hub firmware with locally driven dual motors while retaining the standard hub and external motor module as separate targets.

**Architecture:** Keep `hub/` and `module_motor/` working independently. Add a shared ECA local-actuator dispatch seam, then create `motor_hub/` as a separately compiled hub firmware variant whose built-in motor UID is handled locally and whose external module actions still use CAN.

**Tech Stack:** ESP32-C3 Arduino, C++, WearBlocks CAN/ECA protocol, NimBLE Nordic UART Service, JavaScript Blockly frontend, Python bridge simulator, pytest, Arduino CLI.

## Global Constraints

- Do not push or create a remote PR; all source changes and tests remain local.
- The standard six-face `hardware/firmware/hub/` target must retain its existing hardware behavior.
- The external `hardware/firmware/module_motor/` target must remain supported.
- Motor-hub external Face 1 uses GPIO5; onboard motors use GPIO0/1 and GPIO3/4; CAN uses RX GPIO6 and TX GPIO7; nSLEEP uses GPIO10.
- M1 and M2 state and duration expiry are independent.
- `MOTOR_SET = 64` and payload `[motor, mode, speed, duration_hi, duration_lo]` remain unchanged.
- `nFAULT`, encoders, braking modes, ramps, and closed-loop control remain out of scope.

---

### Task 1: Add a local actuator routing seam to ECA

**Files:**
- Modify: `hardware/firmware/lib/WearBlocksECA/WearBlocksECA.h`
- Modify: `hardware/firmware/lib/WearBlocksECA/WearBlocksECA.cpp`
- Create: `frontend/tools/test_motor_hub_source.mjs`

**Interfaces:**
- Produces: `WBLocalActuatorCallback`, receiving `(targetUid, cmd, payload, payloadLen)` and returning `true` only when handled locally.
- Produces: `WearBlocksECA::setLocalActuatorHandler(WBLocalActuatorCallback)`.
- Preserves: `WearBlocksProtocol::sendActuatorCommand()` as the fallback.

- [ ] **Step 1: Write the failing source-contract test**

Create a Node test that reads the ECA header/source and checks for the callback API, local dispatch before UID-to-slot failure, and the CAN fallback.

```js
assert.match(header, /typedef bool \(\*WBLocalActuatorCallback\)/);
assert.match(header, /setLocalActuatorHandler/);
assert.ok(source.indexOf('_localActuator') < source.indexOf('not registered'));
assert.match(source, /sendActuatorCommand/);
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node frontend/tools/test_motor_hub_source.mjs`

Expected: FAIL because the local actuator callback does not exist.

- [ ] **Step 3: Implement payload-first local/CAN dispatch**

Add the callback type, setter, and nullable member. Refactor action execution so each command first produces a byte payload. Call the local handler with the target UID; if it returns `true`, stop. Otherwise resolve the UID to a registered slot and emit the same CAN command as before. The standard hub installs no callback, so it remains CAN-only.

- [ ] **Step 4: Run the source-contract and existing protocol tests**

Run `node frontend/tools/test_motor_hub_source.mjs`, `node frontend/tools/test_motor_protocol.mjs`, and `frontend/bridge/.venv/bin/python -m pytest -q frontend/bridge/test_wb_eca.py`.

Expected: all tests pass.

### Task 2: Create the standalone motor-hub firmware

**Files:**
- Create: `hardware/firmware/motor_hub/motor_hub.ino`
- Create: `hardware/firmware/motor_hub/ModuleRegistry.h`
- Create: `hardware/firmware/motor_hub/ModuleRegistry.cpp`
- Preserve: `hardware/firmware/hub/*`
- Preserve: `hardware/firmware/module_motor/module_motor.ino`

**Interfaces:**
- Produces: the same USB/BLE line protocol and NUS UUIDs as `hub/`.
- Produces: a built-in `dual_motor` descriptor keyed by a stable UID derived from the motor-hub ESP32 eFuse MAC.
- Consumes: `WearBlocksECA::setLocalActuatorHandler()` and the existing five-byte `MOTOR_SET` payload.

- [ ] **Step 1: Extend the failing source-contract test**

Assert that `motor_hub.ino` declares GPIO5 as its face pin, initializes NimBLE, registers a local handler, emits `Built-in Dual Motor`, handles `ACT_MOTOR_SET`, and retains `protocol.onHello` for CAN modules.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node frontend/tools/test_motor_hub_source.mjs`

Expected: FAIL because `hardware/firmware/motor_hub/` does not exist.

- [ ] **Step 3: Add the separate firmware target**

Use the existing hub runtime as the behavioral baseline, but keep the files in `motor_hub/`. Change face handling from six pins to one GPIO5 face. Add the DRV8410 PWM driver with boot-safe `nSLEEP` behavior and independent motor timers.

Generate a stable built-in motor UID from the chip UID. Append its `$H`, `$D`, `$I`, and `$T` records during initial synchronization and status/topology snapshots. Use Hub face `0` to mean local/internal, leaving physical Face 1 free.

Register the ECA local handler. Return `true` only for the built-in UID and `ACT_MOTOR_SET`; all other targets fall through to CAN. Apply the same routing to direct `$A` commands.

- [ ] **Step 4: Compile all firmware targets**

Compile `hardware/firmware/hub`, `hardware/firmware/module_motor`, and `hardware/firmware/motor_hub` with `arduino-cli compile --fqbn esp32:esp32:esp32c3 --libraries hardware/firmware/lib`.

Expected: all three commands exit 0.

### Task 3: Model built-in and external motors in the simulator/frontend

**Files:**
- Modify: `frontend/bridge/serial_bridge.py`
- Modify: `frontend/bridge/test_serial_bridge_sim.py`
- Modify: `frontend/js/components/wb-app.js` only if face `0` needs normalization
- Modify: `frontend/js/components/wb-sensor-panel.js` only if the label/state needs differentiation
- Modify: `frontend/tools/test_motor_capability.mjs`

**Interfaces:**
- Produces: a simulator motor-hub with a local `Built-in Dual Motor` that occupies neither a normal slot nor Face 1.
- Preserves: external `Dual DC Motor` simulator behavior and shared capability-based Blockly selection.

- [ ] **Step 1: Write failing simulator tests**

Add assertions that the local motor uses face `0`, Face 1 remains available, built-in UID actions route locally, and external motor UID actions route through the simulated CAN path.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `frontend/bridge/.venv/bin/python -m pytest -q frontend/bridge/test_serial_bridge_sim.py`

Expected: FAIL because built-in motor-hub state is not modeled.

- [ ] **Step 3: Implement the simulator/frontend distinction**

Retain the external motor module definition. Add a motor-hub simulation definition with a local descriptor, face `0`, and independent motor state. Both descriptors map to the same motor Blockly role, while their display names distinguish them.

- [ ] **Step 4: Run frontend and bridge regressions**

Run all three motor Node tests plus `test_wb_eca.py`, `test_serial_bridge_sim.py`, `test_llm_bridge.py`, and `test_osc_bridge.py`.

Expected: all tests pass.

### Task 4: Document and verify the local implementation

**Files:**
- Modify: `README.md`
- Verify: every file changed by Tasks 1–3

**Interfaces:**
- Documents: separate `hub`, `module_motor`, and `motor_hub` firmware targets and compile commands.

- [ ] **Step 1: Correct repository layout documentation**

List the external motor module alongside module firmware and list `motor_hub` separately as a hub variant.

- [ ] **Step 2: Run syntax and regression verification**

Run Node syntax checks, motor Node tests, the complete bridge pytest suite, `serial_bridge.py --selftest`, and `git diff --check`.

- [ ] **Step 3: Recompile the firmware matrix**

Compile standard hub, external motor module, and motor-hub again and record flash/RAM usage.

- [ ] **Step 4: Review the local diff without pushing**

Run `git status --short`, `git diff --stat`, and focused diffs. Confirm unrelated existing user files remain untouched. Do not run `git push`.
