<h1 align="center">HexBlocks</h1>

<p align="center">
  <em>Open-Source Prototyping of Reconfigurable Physical Interfaces with Semantic Continuity</em>
</p>

<p align="center">
  <a href="https://zmk5566.github.io/Hexblocks/">Walkthrough</a>
</p>

<p align="center">
  <img src="https://zmk5566.github.io/Hexblocks/pics/ending-pic.jpg" alt="HexBlocks modules arranged for a live prototype" width="320">
</p>

HexBlocks is an open-source software-hardware framework for rapid, on-the-fly prototyping of reconfigurable physical interfaces. It combines magnetic sensor/actuator modules, a battery-powered hub, a browser authoring UI, and a live schema in one workspace.

The core design goal is semantic continuity: physical modules, authoring references, and runtime targets stay bound to stable UID-keyed entities as the assembly changes. The reference implementation supports hub-resident Event-Condition-Action execution for standalone prototypes and sensor-stream integration through a Python bridge for browser and OSC workflows.

## Interface

<p align="center">
  <img src="https://zmk5566.github.io/Hexblocks/pics/introduction-to-sections/8.png" alt="HexBlocks interface" width="720">
</p>

## Links

- Video walkthrough: <https://zmk5566.github.io/Hexblocks/>
- Schematics: [`schematics/`](schematics/) (KiCad project `schematics.kicad_pro`)
- Enclosures: [`openscad-model/`](openscad-model/) (OpenSCAD sources + STL)
- Hardware sources: [`hardware/`](hardware/) (firmware + PCB)
- Firmware topology runtime: [`hardware/docs/topology-runtime.md`](hardware/docs/topology-runtime.md)

## Repo layout

```
hardware/             ESP32-C3 firmware (hub + 6 module types) and PCB
  firmware/hub/       hub.ino, ModuleRegistry — CAN master, BLE/USB companion link
  firmware/module_*/  per-module sketches (imu, led, vibration,
                      amplifier, light_resistor, resistor)
  firmware/lib/       shared C++ libraries: WearBlocksCAN, *Protocol,
                      *Descriptor, *Module, *ECA (bytecode interpreter)
  pcb/                board files
schematics/           KiCad project (board + schematic)
openscad-model/       hex enclosure SCAD sources + exported STL
frontend/
  bridge/             Python bridge runtime: serial_bridge.py (WS + HTTP), wb_protocol.py,
                      wb_eca.py, transport.py (USB-CDC + BLE)
  js/                 ES modules: ws-client, eca-encoder/decoder,
                      llm-catalog, recommendation-plan, demo-programs
  js/components/      Lit UI: wb-app, wb-block-canvas, wb-llm-panel,
                      wb-sensor-panel, wb-eca-inspector, wb-status-bar,
                      wb-devices-panel, wb-debug-console
  tools/              frontend smoke/debug utilities
  index.html          static entry point, served by the bridge
```

## Quickstart - Simulator

Use simulator mode first if you do not have hardware attached.

1. **Install bridge dependencies.**

   ```bash
   cd frontend/bridge
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

2. **Run the bridge simulator.**

   ```bash
   python serial_bridge.py --sim --sim-demo
   ```

3. **Open the UI.** Browse to `http://localhost:3000`.

The bridge serves the static frontend on port 3000 and broadcasts live events
on `ws://localhost:8765`. The simulator creates a demo topology for testing
Blockly upload, ECA execution, actuator state replay, and OSC forwarding
without flashing a hub.

Run the core bridge checks:

```bash
cd frontend/bridge
python serial_bridge.py --selftest
python -m pytest test_wb_eca.py test_osc_bridge.py test_llm_bridge.py
```

## Quickstart - Hardware Hub-Resident ECA

The hub evaluates rules locally. A companion computer is only needed to author or inspect the program.

1. **Flash the hub.** Connect the hub board over USB-C and flash `hardware/firmware/hub/hub.ino` for the ESP32-C3 target. With `arduino-cli`:

   ```bash
   # Install the core once
   arduino-cli core install esp32:esp32

   # Compile and upload (replace /dev/cu.usbmodem* with your port)
   arduino-cli compile --fqbn esp32:esp32:esp32c3 \
     --libraries hardware/firmware/lib hardware/firmware/hub
   arduino-cli upload --fqbn esp32:esp32:esp32c3 \
     -p /dev/cu.usbmodem* hardware/firmware/hub
   ```

2. **Flash each module.** Same flow, one sketch per module type. Example for the IMU module:

   ```bash
   arduino-cli compile --fqbn esp32:esp32:esp32c3 \
     --libraries hardware/firmware/lib hardware/firmware/module_imu
   arduino-cli upload --fqbn esp32:esp32:esp32c3 \
     -p /dev/cu.usbmodem* hardware/firmware/module_imu
   ```

   Repeat for `module_led`, `module_vibration`, `module_amplifier`, `module_light_resistor`, `module_resistor`.

3. **Power up.** Snap modules onto the hub. The hub enumerates them over CAN, allocates slots, and (if a program is in NVS) starts evaluating immediately. No companion computer required.

4. **Author or replace the program (optional).** Run the bridge (see Mode B), open the browser UI, write rules in the Blockly canvas or via the LLM panel, and click upload. The encoded bytecode is sent as `$P <base64>` over the active transport, persisted in NVS, and runs on every boot until cleared with `$PC` (clear) or `$PE` (erase NVS).

## Quickstart - Sensor Stream + Browser

Same hardware setup as Mode A. The hub keeps any uploaded program running; the bridge subscribes to the same `$S/$D/$H/$T` stream and forwards it to the browser. Clearing the program (`$PC`) gives a pure stream-only configuration.

1. **Install the bridge dependencies.**

   ```bash
   cd frontend/bridge
   pip install -r requirements.txt   # websockets, pyserial, requests, bleak
   ```

2. **Run the bridge.** The bridge serves the static frontend on `http://localhost:3000` and pushes events on `ws://localhost:8765`.

   ```bash
   # USB-CDC (auto-detect or pass a port)
   python serial_bridge.py /dev/cu.usbmodem*

   # BLE (pair address discovered via the devices panel, then)
   python serial_bridge.py --ble <BLE_ADDRESS>

   # No hardware? Headless simulator with three demo programs:
   python serial_bridge.py --sim --sim-demo
   ```

3. **Open the UI.** Browse to `http://localhost:3000`. Sparklines appear in `wb-sensor-panel`; raw bridge traffic in `wb-debug-console`; the program currently on the hub in `wb-eca-inspector`.

4. **Optional: LLM authoring.** Set `DEEPSEEK_API_KEY` in `frontend/bridge/.env` so the bridge's `/api/chat` proxy can reach the model. The chat panel translates utterances into `<workspace_update>` envelopes that the canvas validates against the live module schema before letting you accept.

5. **Optional: OSC forwarding.** Open the OSC panel from the status bar, add a loopback target, and use auto-populate to seed one address per live sensor channel. Non-loopback targets require launching the bridge with `--osc-allow-remote`.

## Build Instructions

### Firmware

No `platformio.ini` is committed — the canonical build path is `arduino-cli` against the per-sketch directories under `hardware/firmware/`. Shared libraries live in `hardware/firmware/lib/` and must be passed via `--libraries` (see commands above). Target board: `esp32:esp32:esp32c3` (ESP32-C3-MINI-1). The hub additionally requires NimBLE-Arduino; install it once with `arduino-cli lib install "NimBLE-Arduino"`.

PlatformIO users can build the same sketches by adding each `module_*` and `hub` directory as a PlatformIO environment with `framework = arduino` and `board = esp32-c3-devkitm-1`; no project file is provided.

### Bridge

```bash
cd frontend/bridge
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python serial_bridge.py --selftest    # parser + ECA round-trip checks
```

Tested with CPython 3.11. No `pyproject.toml`; the bridge is a small set of scripts driven by `requirements.txt`.

### Frontend

The frontend is plain ES modules. There is no bundler and no build step.
`serial_bridge.py` serves `frontend/index.html` and `frontend/js/` directly
over HTTP on port 3000. Open `http://localhost:3000` in a Chromium-based
browser. The BLE pairing UI is mediated by the Python bridge, so Firefox also
works for the bridge-mediated path.

## License

- Code: MIT. See [`LICENSE`](LICENSE).
- Hardware design files and enclosure models: CC BY 4.0. See
  [`LICENSE-hardware`](LICENSE-hardware).
