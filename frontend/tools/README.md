# frontend/tools/

Operator-side helpers that don't fit in the bridge or the browser.

## `wb_debug.py`

High-signal debug monitor for the hub. Renders a colored event timeline
plus a 6-cell face-occupancy bar; suppresses the high-rate `$S` sensor
stream (counted as a rate); single-key shortcuts for `$Q,STATUS` /
`$Q,TOPO` and ECA program controls.

Two modes — pick one:

```bash
# Direct serial (bridge MUST NOT be holding the port)
python3 wb_debug.py --port /dev/cu.usbserial-11201

# Auto-discover a serial port whose name contains "11201"
python3 wb_debug.py --port auto --hint 11201

# WebSocket client to a running bridge (coexists with the frontend)
python3 wb_debug.py --ws ws://localhost:8765

# Inspect available ports
python3 wb_debug.py --list
```

Keys (both modes): `t` topology, `s` status, `r` run program, `p` stop,
`c` clear, `q` quit. `--raw` shows everything (no filtering).

Dependencies: `pyserial` for `--port`, `websockets` for `--ws`. Both come
in via the bridge's existing requirements.

## `audio_patch.py`

Reference compiler for the fixed-resource ESP32-C3 audio rack. Values such as
mix, resonance, depth, sustain, feedback, and gain use normalized `0.0..1.0`
JSON numbers. Compiling validates the hardware limits and emits the exact
42-byte `WBAP` profile accepted by the Hub and audio module.

```bash
# Inspect the normalized result and print a copy/pasteable Hub command.
python3 frontend/tools/audio_patch.py compile \
  frontend/tools/audio_patches/subtractive_bass.json --uid C0FFEE01

# Keep the binary artifact for inspection or versioned releases.
python3 frontend/tools/audio_patch.py compile patch.json \
  --output patch.wbap --uid C0FFEE01

# Direct update; the bridge must not be holding the serial port.
python3 frontend/tools/audio_patch.py upload patch.json \
  --uid C0FFEE01 --port /dev/cu.usbmodemXXXX
```

Success has two stages: `$OK AP ...` means the Hub accepted and sent the
profile; `$AP,ACK,<uid>,0,<revision>` means the module validated and persisted
it. A nonzero ACK status leaves the failure visible to the upload command.
