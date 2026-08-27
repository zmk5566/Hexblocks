# Simulator ECA Validation Guide

End-to-end validation of the WearBlocks ECA pipeline **without physical
hardware**, using the built-in Python ECA engine (`wb_eca.py`) inside the
simulator.

## Architecture

```
┌──────────────┐      WS       ┌──────────────────┐       ┌────────────┐
│  Blockly UI  │ ──$P/$PR/$A─▶ │ serial_bridge.py │──────▶│ wb_eca.py  │
│ (wb-block-   │               │  (--sim modes)   │       │  engine    │
│   canvas)    │◀── actuator ──│                  │◀──────│            │
└──────────────┘    _state     └──────────────────┘       └────────────┘
          OSC control :7001 ──────────▶│
          ◀──── ack/nack/state ────────┘
                                      │
                         SimModule actuator state
                                      │
                                      ▼
                       sensor panel + Three.js twin
```

The Python engine is a 1:1 port of
`hardware/firmware/lib/WearBlocksECA/WearBlocksECA.cpp`, so bytecode that
works in sim should also work on hardware (and vice versa — divergences
are bugs in one engine or the other).

## Quick start

```bash
cd frontend/bridge
python serial_bridge.py --sim-demo
```

This auto-loads the 5-module demo (IMU + HR stacked on IMU F4 + Temp + LED + Vib)
and starts the WebSocket bridge on `:8765` plus HTTP on `:3000`.

Open `http://localhost:3000` in the browser.

Click **3D Twin** in the status bar to open the live Three.js view. It uses the
same UID-keyed topology and sensor/actuator caches as the 2D canvas, so a
physical Hub, the simulator, WebSocket controls, and OSC controls all update
one model.

## Unit tests

```bash
cd frontend/bridge
python -m pytest test_wb_eca.py -v
```

13 tests cover: bytecode parsing, magic/checksum rejection, condition
evaluation (GT/LT/AND/OR), `hold_ms`, `cooldown_ms`, `VAR_INC`,
virtual channels, topic extraction, run/stop/clear lifecycle.

## Golden end-to-end test

**Rule**: `IF imu.ax > 0.5 THEN LED[slot=5] SOLID red (cooldown 2000ms)`

### Steps

1. **Launch sim**

   ```bash
   python serial_bridge.py --sim-demo
   ```

   Expect:
   ```
   [bridge] HTTP serving ... on :3000
   [bridge] WebSocket on :8765
     [sim] demo: 5 CAN modules + 2 remote Wi-Fi modules, light stacked on IMU F4
   ```

2. **Open the UI**: `http://localhost:3000`. You should see 5 CAN modules,
   2 remote Wi-Fi modules, light stacked on IMU's F4, and an LED module on
   one of the hub faces.
   The right pane is the **ECA Rules** Blockly workspace (default 320 px
   wide — drag the `⸽` divider on its left edge to widen).

3. **Build the rule** (two paths — pick whichever is less friction):

   **Path A — Blockly drag-and-drop**

   - Open the toolbox categories on the left edge of the ECA Rules pane.
     Blockly boots from the unpkg CDN; if the categories do not appear,
     check DevTools for a `blockly_compressed.js` 404.
   - From **Rules**: drag out the `IF … THEN` block onto the workspace.
   - From **Sensors**: drag `slot 1 . ax > 1.0 cooldown 2000 ms` into
     the `IF` slot. Change `1.0` → `0.5`.
   - From **LED**: drag `LED slot 5 solid R:255 G:255 B:255 period … dur …`
     into the `THEN` slot. Set `R=255`, `G=0`, `B=0`; leave `period`/`dur`
     at defaults (LED_SOLID ignores the timing fields at the hub level).

   **Path B — raw JSON (recommended for quick testing / LLM-generated rules)**

   - Click the `{ } JSON` toggle in the ECA Rules header. The Blockly host
     is replaced by a textarea seeded with the current workspace's JSON.
   - Paste the golden rule directly:

     ```json
     {
       "version": 1,
       "variables": [],
       "virtual_channels": [],
       "rules": [
         {
           "logic": "AND",
           "conditions": [
             { "ref": { "type": 0, "slot": 1, "ch": 0 },
               "op": "GT", "threshold": 0.5,
               "hold_ms": 0, "cooldown_ms": 2000 }
           ],
           "actions": [
             { "slot": 5, "cmd": "LED_SOLID",
               "p": [255, 0, 0, 255, 0, 0, 0, 0, 0, 0] }
           ]
         }
       ]
     }
     ```

     `ref.type: 0` = `REF.SLOT`, `ch: 0` = `CH.AX`. `cmd` accepts the
     string name (see `eca-encoder.js:49-54`) or the numeric value.
     The `p[]` array is the 10-byte action payload: for LED_SOLID it's
     `[R, G, B, brightness, 0, 0, 0, 0, 0, 0]`.
   - Note: edits in JSON mode do NOT sync back to the Blockly workspace.
     Switching back with `⬛ Blocks` discards JSON edits. Upload while
     the JSON toggle is active — the button uses whichever source mode
     is visible.

4. **Upload**: click `⬆ Upload`. The bridge terminal prints:
   ```
     [sim] P loaded (NN bytes, 0 VCs, 1 rules)
     [sim] ECA running
   ```

5. **Trigger via REPL** (paste into the bridge terminal):
   ```
   spike imu ax 0.8
   ```
   Terminal prints:
   ```
     [sim] ⚡ spike slot=1 ax=0.8 for 50ms
     [sim] ECA fired: slot=5 cmd=1
   ```

6. **Visual confirmation**: click `view` on the **LED module card** in the
   left palette. The sensor panel opens at the bottom. The **LED swatch**
   at the top shows **solid red** with a subtle red glow. `mode` shows
   `solid`. Because LED_SOLID has no duration, the swatch stays red until
   you either send `LED_OFF` manually or clear the program.

7. **Reload-persistence test**: hard-reload the browser tab. The LED swatch should
   come back red after ~100ms (replay via `actuator_cache`).

8. **Cooldown test**: send `spike imu ax 0.8` again within 2 seconds —
   no new `ECA fired` log (cooldown enforced). After 2s, a second spike
   should fire again.

If all eight steps pass, the ECA pipeline is validated end-to-end in
software.

## Manual actuator test (bypasses Blockly)

From the debug console (🔧 floating button):

- Slot: 5, cmd: 1 (LED_SOLID), params: `255 0 0 255 0 0 0 0 0 0`
- Click `send`.
- LED swatch turns red immediately — same dispatch path, just without
  going through bytecode. Useful for isolating engine bugs from UI bugs.

## Troubleshooting

- **"spike" says "unknown channel"**: the channel name must match the
  per-type data key (`ax`/`ay`/`az`/`gx`/`gy`/`gz` for IMU, `bpm`/`spo2`
  for HR, `celsius`/`humidity` for temp, `light` for light sensors).
  See `SIM_CHANNEL_MAP` in `serial_bridge.py`.
- **LED swatch stays red after page reload but no events arrive**: the
  WS `actuator_cache` replay is working. Send `$PC` (clear) from the
  debug console to reset.
- **"ECA fired" log but no LED swatch**: check the browser DevTools
  Network tab for a `{"type":"actuator_state",...}` WS frame. If it's
  present but the swatch is wrong, it's a `wb-sensor-panel.js` bug;
  if absent, it's a `dispatch_action` bug in `serial_bridge.py`.

## Why this port exists

The hub's ECA engine on ESP32 is real and has already been verified
against actual CAN modules (see `WearBlocksECA.cpp` comments). But any
frontend/bytecode iteration that relied only on hardware flashing would
be slow and opaque about which layer failed. This Python port makes
the ECA contract testable in seconds, which unlocks:

- Blockly UX redesign that iterates without a soldering iron nearby.
- LLM Assistant trials (LLM emits JSON rules → sim validates → promote
  to hardware only for confirmed-good programs).
- Cross-checks: if the C++ and Python engines diverge on a golden
  bytecode, one of them has a bug and the mismatch becomes discoverable.

## OSC forwarding (Mode B)

The bridge can fan sensor + actuator events out as UDP/OSC to any
creative-coding host (TouchDesigner, Max/MSP, Pd, Unity). This runs
*in addition* to the WebSocket broadcast — Mode A (Blockly hub program)
and Mode B (OSC sink) are not mutually exclusive.

Configure from the **OSC Forwarding** modal in the status bar (`⤳ OSC`
button). Each target has:

- `host:port` (default `127.0.0.1:7000`)
- `enabled` toggle
- `sensors_filter` — comma-separated sensor types (`imu`, `hr`, ...) or
  slot numbers; empty = pass all sensor messages
- `actuators` — also forward `actuator_state` events
- `rate_limit_hz` — per-OSC-address cap (0 = unlimited)
- mappings table: `source_pattern` → `OSC address` with `scale` + `offset`

Source patterns use slash segments with `*` wildcards:

- `sensor/<slot>/<channel_id>` (e.g. `sensor/3/0`, `sensor/*/0`)
- `actuator/<slot>` (e.g. `actuator/5`, `actuator/*`)

Click **Auto-populate** to generate one mapping per channel for every
plugged-in module (uses live hub schema + `SIM_CHANNEL_MAP`).
Default address scheme: `/hex/<sensor_type>/<slot>/<channel_name>`.

Config persists to `~/.wearblocks/osc_targets.json` and reloads on
bridge restart.

### Smoke test

```bash
python serial_bridge.py --sim --sim-demo
# In another terminal:
oscdump 7000     # liblo, or pip install python-osc and use a dispatcher
```

Add a target `127.0.0.1:7000`, enable, click Auto-populate, and
oscdump should start printing one line per IMU sample.

Limitations (v1): UDP only; per-channel messages only (no bundling);
actuator messages emit the `cmd` code as their scalar arg.

## OSC control return path

The same bridge also listens for external actuator controls. By default it is
loopback-only on `127.0.0.1:7001`; this is independent of forwarding targets.

```text
/hex/control/<uid>/actuator  request_id:string, cmd:int, semantic_params:int...
```

The preferred form always includes a caller-supplied `request_id`. The bridge
validates the UID, command, parameter count, and value ranges, translates the
semantic values to the current ECA-v4 module wire layout, and routes a
correlated `$AO` command through the normal simulator/USB/BLE/Hub path. Legacy
senders may omit the ID; the bridge assigns `legacy-N`.

Replies are unicast to the UDP source port:

```text
/hex/control/<uid>/ack    request_id, stage, detail
/hex/control/<uid>/nack   request_id, stage, reason
/hex/control/<uid>/state  request_id, json_state
```

Every successful request progresses through `queued` and `routed`. The `$AS`
reply carries the Hub's commanded state; for ordinary CAN modules it is marked
unconfirmed because the current CAN action frame has no module-level ACK. A
local motor or simulator can report `applied` immediately. A Wi-Fi module
returns `/wb/ack`, so it also reports `applied`; the Wi-Fi Hub retries a missing
ACK and reports timeout/NACK with the same external request ID.

Supported semantic command arguments:

| cmd | action | parameters |
|---:|---|---|
| `0`, `6` | LED off/stop | none |
| `1` | LED solid | `r g b [duration_ms]` |
| `16` | vibration | `intensity [duration_ms]` |
| `17` | vibration pulse | `intensity on_ms off_ms count` |
| `18` | vibration ramp | `from_pct to_pct [duration_ms]` |
| `19` | vibration stop | none |
| `48` | audio tone | `frequency_hz amplitude [duration_ms]` |
| `49` | audio stop | none |
| `64` | dual motor set | `motor(1/2) mode(0/1/2) speed duration_ms` |

To change the listener:

```bash
python serial_bridge.py --sim-demo \
  --osc-input-host 127.0.0.1 --osc-input-port 7001
```

Binding either OSC direction outside loopback requires the explicit
`--osc-allow-remote` switch.
