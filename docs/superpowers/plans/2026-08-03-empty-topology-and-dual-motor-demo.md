# Empty Topology and Dual Motor Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the topology's synthetic Hub until a real/simulated Hub context exists and add a live-targeted dual-motor Blockly demo.

**Architecture:** A small pure helper derives Hub presence from physical transport state and visible modules, and `wb-app` passes that result to the palette and topology canvas. The D4 preset uses a demo-state factory that binds both motor actions to the first active motor-capable UID after the simulator attaches `motor_hub`.

**Tech Stack:** Lit web components, Blockly workspace JSON, Node.js assertion scripts, Python asyncio simulator, pytest.

## Global Constraints

- Keep all changes local; do not push.
- Preserve Night Light, Theremin, and Motion Alert behavior.
- Motor 1 and Motor 2 must remain independently configurable.
- Use only direction, speed, stop/start, and duration controls; no encoder layer.

---

### Task 1: Hub Presence State

**Files:**
- Create: `frontend/js/hub-presence.js`
- Create: `frontend/tools/test_hub_presence.mjs`
- Modify: `frontend/js/components/wb-app.js`
- Modify: `frontend/js/components/wb-palette.js`
- Modify: `frontend/js/components/wb-block-canvas.js`

**Interfaces:**
- Consumes: `{connected: boolean}` transport status and the visible module array.
- Produces: `hasHubPresence(transport, modules): boolean` and `hubPresent` Lit properties on the two topology components.

- [ ] **Step 1: Write the failing pure-state test**

Create assertions that no transport plus no modules is false, connected transport plus no modules is true, and no transport plus one simulator module is true.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node frontend/tools/test_hub_presence.mjs`

Expected: FAIL because `frontend/js/hub-presence.js` does not exist.

- [ ] **Step 3: Implement the state helper and pass the property through `wb-app`**

Implement:

```js
export function hasHubPresence(transport, modules = []) {
  return !!transport?.connected || modules.length > 0;
}
```

Compute it from `_transport` and `visibleModules`, then bind `.hubPresent` on `wb-palette` and `wb-block-canvas`.

- [ ] **Step 4: Render the disconnected empty state**

Give both components a Boolean `hubPresent` property defaulting to `false`. Omit the Hub row, central Hub, faces, and topology controls while false, and render the copy `Connect a hub to begin`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node frontend/tools/test_hub_presence.mjs`

Expected: PASS with `hub presence: ok`.

### Task 2: Dual Motor Demo State

**Files:**
- Create: `frontend/tools/test_dual_motor_demo.mjs`
- Modify: `frontend/js/demo-programs.js`
- Modify: `frontend/js/components/wb-status-bar.js`
- Modify: `frontend/js/components/wb-app.js`
- Modify: `frontend/js/ws-client.js`

**Interfaces:**
- Consumes: active frontend module records and `moduleHasRole(module, 'motor')`.
- Produces: `getDemoProgram(name, modules)` returning Blockly workspace JSON whose D4 motor targets use a live motor UID when available.

- [ ] **Step 1: Write the failing demo-state test**

Assert that `getDemoProgram('demo4', [motorModule])` returns one rule with chained `motor_action` blocks targeting the same live UID, with M1/forward/160/2000 and M2/reverse/120/3000 fields.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node frontend/tools/test_dual_motor_demo.mjs`

Expected: FAIL because D4 and `getDemoProgram` do not exist.

- [ ] **Step 3: Implement the D4 factory**

Add `DEMO_D4`, include `demo4` in `DEMO_PROGRAMS`, and export `getDemoProgram(name, modules)`. Clone the stored state before replacing both motor `SLOT` fields with the first active motor-capable module UID.

- [ ] **Step 4: Add the D4 status-bar button**

Pass visible modules from `wb-app` to `wb-status-bar`. Add `D4 Dual Motor Test`, send `demo4` to the simulator, and call `getDemoProgram` after the existing discovery delay so the live motor UID is available.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node frontend/tools/test_dual_motor_demo.mjs`

Expected: PASS with `dual motor demo: ok`.

### Task 3: Simulator Preset

**Files:**
- Modify: `frontend/bridge/test_serial_bridge_sim.py`
- Modify: `frontend/bridge/serial_bridge.py`

**Interfaces:**
- Consumes: `sim_clear_all()` and `sim_add_module('motor_hub')`.
- Produces: `async sim_run_demo_d4()` and `demo4`/`d4` simulator command routing.

- [ ] **Step 1: Write the failing simulator test**

Monkeypatch the clear/add helpers, run `sim_run_demo_d4()`, and assert the call sequence is `clear`, then `motor_hub`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `frontend/bridge/.venv/bin/python -m pytest -q frontend/bridge/test_serial_bridge_sim.py -k demo_d4`

Expected: FAIL because `sim_run_demo_d4` does not exist.

- [ ] **Step 3: Implement and route D4**

Clear the simulator, wait briefly, attach `motor_hub`, and accept both `demo4` and `d4` in the command handler.

- [ ] **Step 4: Run the focused simulator test**

Run: `frontend/bridge/.venv/bin/python -m pytest -q frontend/bridge/test_serial_bridge_sim.py -k demo_d4`

Expected: PASS.

### Task 4: Regression Verification

**Files:**
- Modify only if a regression is discovered in an in-scope file.

**Interfaces:**
- Consumes: all changes from Tasks 1-3.
- Produces: verified frontend and bridge behavior without publishing changes.

- [ ] **Step 1: Run all focused frontend tests**

Run: `node frontend/tools/test_hub_presence.mjs && node frontend/tools/test_dual_motor_demo.mjs && node frontend/tools/test_motor_protocol.mjs && node frontend/tools/test_motor_capability.mjs`

Expected: all print `ok` and exit 0.

- [ ] **Step 2: Run the bridge suite**

Run: `frontend/bridge/.venv/bin/python -m pytest -q frontend/bridge`

Expected: all tests pass.

- [ ] **Step 3: Inspect the local diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only local files are changed and nothing is pushed.
