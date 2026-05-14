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
