#!/usr/bin/env python3
"""WearBlocks Serial-to-WebSocket bridge.

Reads $-prefixed lines from ESP32 hub serial, broadcasts JSON over WebSocket.

Usage:
  python serial_bridge.py /dev/cu.usbmodem14101   # real hardware
  python serial_bridge.py --mock                   # single IMU simulator
  python serial_bridge.py --sim                    # interactive multi-module simulator
  python serial_bridge.py --sim-demo               # auto-load demo (HR stacked on IMU)
"""
import argparse, asyncio, base64, json, math, os, random, re, sys, time, threading
from collections import deque
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, HTTPServer
from pathlib import Path

import serial
import websockets

from wb_eca import ECAEngine, Act, CH, Action as EcaAction
from wb_protocol import parse_line as _parse_wire
import serial_io
from transport import (
    Transport, SerialTransport, BleTransport, ble_scan as ble_scan_devices,
)
from osc_forwarder import (
    OscForwarder, schema_to_default_mappings, load_channel_catalog,
)

WS_PORT, HTTP_PORT, BAUD = 8765, 3000, 115200

PAIRED_DEVICES_PATH = Path(__file__).parent / "paired_devices.json"


def _load_paired() -> list[dict]:
    """Return list of {address, name, last_seen, auto_reconnect}."""
    try:
        if PAIRED_DEVICES_PATH.exists():
            data = json.loads(PAIRED_DEVICES_PATH.read_text())
            if isinstance(data, list):
                return data
    except Exception as e:
        print(f"[bridge] failed to load paired devices: {e!r}")
    return []


def _save_paired(devices: list[dict]) -> None:
    try:
        PAIRED_DEVICES_PATH.write_text(json.dumps(devices, indent=2))
    except Exception as e:
        print(f"[bridge] failed to save paired devices: {e!r}")


def _upsert_paired(address: str, name: str, *, auto_reconnect: bool | None = None):
    devs = _load_paired()
    now = int(time.time())
    found = None
    for d in devs:
        if d.get("address") == address:
            found = d
            break
    if found is None:
        found = {"address": address, "name": name,
                 "last_seen": now, "auto_reconnect": False}
        devs.append(found)
    else:
        found["name"] = name or found.get("name", "")
        found["last_seen"] = now
    if auto_reconnect is not None:
        found["auto_reconnect"] = bool(auto_reconnect)
    _save_paired(devs)
    return found


def _forget_paired(address: str) -> bool:
    devs = _load_paired()
    new = [d for d in devs if d.get("address") != address]
    if len(new) == len(devs):
        return False
    _save_paired(new)
    return True


# ── Debug recorder ───────────────────────────────────────────────
# When `--log <path>` is passed, every serial line in/out, every parsed
# event, and every WS-inbound command is appended to the file with an
# ISO timestamp and a one-letter direction tag:
#   RX  hub → bridge (raw serial line, with or without $)
#   TX  bridge → hub (write queue commands)
#   EV  parsed event broadcast to WS clients
#   WS  WS client → bridge inbound JSON
#   ..  bridge diagnostics (transport connect/drop, reset markers)
# Writes are flushed per line so an unclean shutdown still leaves a
# usable trail.
class LogRecorder:
    def __init__(self, path: str | None):
        self._fh = None
        if path:
            self._fh = open(path, "a", buffering=1, encoding="utf-8")
            self._write("--", f"--- bridge start pid={__import__('os').getpid()} ---")

    def _write(self, tag: str, text: str):
        if self._fh is None:
            return
        try:
            ts = datetime.now().isoformat(timespec="milliseconds")
            self._fh.write(f"{ts} {tag} {text}\n")
        except Exception:
            pass  # never let logging crash the bridge

    def rx(self, line: str):
        self._write("RX", line.rstrip("\r\n"))

    def tx(self, line: str):
        self._write("TX", line.rstrip("\r\n"))

    def event(self, msg: dict):
        try:
            self._write("EV", json.dumps(msg, ensure_ascii=False))
        except Exception:
            self._write("EV", repr(msg))

    def ws(self, raw: str):
        self._write("WS", raw if isinstance(raw, str) else repr(raw))

    def note(self, text: str):
        self._write("..", text)

    def close(self):
        if self._fh is not None:
            try:
                self._fh.close()
            except Exception:
                pass


recorder = LogRecorder(None)  # replaced in main() if --log given

HUB_RESET_MARKERS = (
    "WearBlocks Hub",
    "ESP-ROM",
    "rst:",
    "boot:",
    "Brownout",
    "Guru Meditation",
    "Rebooting",
)
HUB_READY_MARKERS = (
    "[WAIT] Listening for HELLO",
    "[WAIT] Listening for module HELLO",
)


def _classify_debug_line(line: str) -> str | None:
    """Return a compact diagnostic tag for notable hub debug output."""
    if any(marker in line for marker in HUB_RESET_MARKERS):
        return "hub_reset_marker"
    if any(marker in line for marker in HUB_READY_MARKERS):
        return "hub_ready_marker"
    return None

DEFAULT_MODULE_COLOR = "#888888"
COLOR_MAP = {
    "imu": "#7CA1BB", "imuv": "#7CA1BB",
    "motion_sensing": "#7CA1BB", "acc": "#7CA1BB",
    "acceleration": "#7CA1BB", "accelerometer": "#7CA1BB",
    "hr": "#7B68EE", "spo": "#7B68EE",
    "biometric": "#7B68EE", "heart": "#7B68EE",
    "tmp": "#F5A623", "temp": "#F5A623", "bme": "#F5A623",
    "environmental": "#F5A623",
    "vib": "#50C878", "vibration": "#50C878",
    "haptic": "#50C878", "haptic_output": "#50C878",
    "led": "#C68E9E", "visual_output": "#C68E9E",
    "rgb": "#C68E9E", "neopixel": "#C68E9E",
    "light": "#C1B496", "light_sensing": "#C1B496",
    "audio": "#9885BF", "audio_output": "#9885BF",
    "audio_synth": "#9885BF", "amp": "#9885BF",
    "amplifier": "#9885BF", "speaker": "#9885BF",
    "tone": "#9885BF", "tone_generation": "#9885BF",
    "tone_generator": "#9885BF",
    "knob": "#98AF6F", "rotary": "#98AF6F",
    "input_control": "#98AF6F", "pot": "#98AF6F",
    "hub": "#989898",
}
COLOR_PREFIXES = (
    "imu", "acc", "hr", "spo", "tmp", "temp", "bme",
    "vib", "led", "light", "audio", "amp", "knob", "hub",
)

# Category → sensor type shorthand (for WebSocket "sensor" field)
CAT_MAP = {
    "motion_sensing": "imu",
    "biometric":      "hr",
    "environmental":  "temp",
    "visual_output":  "led",
    "haptic_output":  "vibration",
    "light_sensing":  "light",
    "audio_output":   "audio",
}

clients: set = set()

# ── Identity model ────────────────────────────────────────────────
# The hub's v2 wire protocol is UID-keyed: every $H/$D/$I/$S/$X/$U/$F/$C/$c/$T
# line carries the module's 8-hex-char UID. Slot is a hub-internal concept;
# it never appears on the wire after the v2 refactor. The bridge therefore
# keys all caches by UID. The sim modes (which still need slot for the ECA
# engine's action dispatch) keep their own slot-keyed bookkeeping via the
# uid_by_slot / slot_by_uid side indexes.

# UID-keyed caches (populated by parse_line from real hardware and, after
# commit 3, by the sim's synthetic-UID broadcast path).
modules_by_uid: dict = {}           # uid → mod_id
module_types_by_uid: dict = {}      # uid → sensor type shorthand
msg_cache_by_uid: dict = {}         # uid → {"hello": msg, "descriptor": msg}
# Stack relationships keyed by parent UID + face.
stack_cache_by_uid: dict = {}       # (parent_uid, parent_face) → child_stack msg
# Latest actuator state per uid (LED + vib).
actuator_cache_by_uid: dict = {}    # uid → actuator_state msg

# `$Q,DONE` is intentionally compact on the firmware wire, so the bridge tracks
# the outbound query commands that are known to terminate with DONE and annotates
# the inbound JSON event with `command`. This lets browser clients distinguish an
# empty TOPO snapshot from a STATUS/ECA completion with no topology rows.
QUERY_DONE_COMMANDS = {"STATUS", "TOPO", "ECA"}
pending_query_done_commands: deque[str] = deque()
topo_snapshot_uids: set[str] = set()

# Side indexes for sim / ECA dispatch — slot is CAN-bus addressing concept,
# not exposed on the v2 wire. Populated by sim in commit 3.
uid_by_slot: dict = {}              # slot → uid (sim authoritative)
slot_by_uid: dict = {}              # uid → slot (sim authoritative)

# Legacy slot-keyed caches — retained only so the existing sim path keeps
# working during this transitional commit. Commit 3 removes these by
# migrating the sim to emit uid-keyed frames via the _by_uid dicts above.
modules: dict = {}
module_types: dict = {}
msg_cache: dict = {}
stack_cache: dict = {}
actuator_cache: dict = {}

serial_write_queue: asyncio.Queue = asyncio.Queue()

# ── Active transport (USB or BLE — mutually exclusive) ─────────
# Set by serial_loop / ble_loop. The transport_supervisor coroutine
# watches `transport_request` for switch commands from WS clients.
current_transport: Transport | None = None
transport_request: asyncio.Queue = asyncio.Queue()
# Cached for the next client that connects so the UI can render the
# current transport without a fresh status push.
last_transport_status: dict = {"type": "transport_status",
                                "transport": None, "address": None,
                                "label": None, "connected": False}

# Latest ECA status + bytecode from the hub. Cached so a freshly-
# connected WS client gets a full snapshot without waiting for the
# next $Q,ECA round-trip.
last_eca_status:   dict | None = None
last_eca_bytecode: dict | None = None

# ── ECA engine (used in --sim modes only) ──────────────────────
# Per-module-type mapping from sensor data field name → ECA channel id.
# `sim_sensor_data` reuses `ax`/`ay`/`az` as a generic 3-axis payload for
# every module type (see lines ~395-415), so HR/temp need explicit remaps.
SIM_CHANNEL_MAP = {
    "imu":  {"ax": CH.AX, "ay": CH.AY, "az": CH.AZ,
             "gx": CH.GX, "gy": CH.GY, "gz": CH.GZ},
    "hr":   {"ax": CH.BPM, "ay": CH.SPO2},
    "temp": {"ax": CH.CELSIUS, "ay": CH.HUMIDITY},
    "knob": {"ax": CH.KNOB},
    "light": {"ax": CH.LIGHT},
}

# One global engine. The on_action callback is set later (after dispatch_action
# is defined) to avoid forward-reference noise.
eca = ECAEngine()

# Embedded OSC forwarder (Mode B: hub → bridge → UDP/OSC sink). Started in
# main() so it binds to the running asyncio loop. forward(msg) is called
# from broadcast(); see osc_forwarder.py for queue + drop-oldest design.
# `allow_remote` is patched in main() from the CLI flag before start().
osc_forwarder = OscForwarder()


def _is_hex_color(value) -> bool:
    if not isinstance(value, str):
        return False
    value = value.strip()
    return (
        len(value) == 7
        and value.startswith("#")
        and all(ch in "0123456789abcdefABCDEF" for ch in value[1:])
    )


def _color_tokens(value):
    raw = str(value or "").strip().lower()
    if not raw:
        return
    normalized = re.sub(r"[^a-z0-9]+", "_", raw).strip("_")
    if not normalized:
        return
    yield normalized
    for part in normalized.split("_"):
        if not part:
            continue
        yield part
        prefix = re.match(r"[a-z]+", part)
        if prefix:
            yield prefix.group(0)


def _descriptor_color(desc: dict | None) -> str | None:
    if not isinstance(desc, dict):
        return None
    if _is_hex_color(desc.get("color")):
        return desc["color"].strip()
    signals = [
        desc.get("id"),
        desc.get("moduleId"),
        desc.get("name"),
        desc.get("type"),
        desc.get("cat"),
        desc.get("category"),
    ]
    for cap in desc.get("caps", []) or []:
        if not isinstance(cap, dict):
            continue
        signals.extend([
            cap.get("m"),
            cap.get("modality"),
            cap.get("t"),
            cap.get("type"),
        ])
    color = color_for(*signals)
    return None if color == DEFAULT_MODULE_COLOR else color


def color_for(*signals) -> str:
    for signal in signals:
        for token in _color_tokens(signal) or ():
            if token in COLOR_MAP:
                return COLOR_MAP[token]
            for prefix in COLOR_PREFIXES:
                if token.startswith(prefix):
                    return COLOR_MAP[prefix]
    return DEFAULT_MODULE_COLOR


def _track_query_command(command: str) -> None:
    cmd = str(command or "").strip().upper()
    if cmd in QUERY_DONE_COMMANDS:
        pending_query_done_commands.append(cmd)


def _clear_pending_query_state(reason: str) -> None:
    pending = len(pending_query_done_commands)
    topo_rows = len(topo_snapshot_uids)
    if not pending and not topo_rows:
        return
    pending_query_done_commands.clear()
    topo_snapshot_uids.clear()
    recorder.note(
        f"cleared pending query state ({pending} done marker(s), "
        f"{topo_rows} topo row(s)): {reason}"
    )


async def _queue_query_command(command: str) -> None:
    """Queue a hub query and remember which compact $Q,DONE it will finish."""
    cmd = str(command or "").strip().upper()
    if not cmd:
        return
    _track_query_command(cmd)
    await serial_write_queue.put(f"$Q,{cmd}\n")


def _drop_pending_query_writes(reason: str) -> int:
    """Remove stale queued $Q commands before a newly opened transport sync."""
    kept = []
    dropped = 0
    while True:
        try:
            cmd = serial_write_queue.get_nowait()
        except asyncio.QueueEmpty:
            break
        if str(cmd).lstrip().upper().startswith("$Q,"):
            dropped += 1
        else:
            kept.append(cmd)
    for cmd in kept:
        serial_write_queue.put_nowait(cmd)
    if dropped:
        _clear_pending_query_state(reason)
        recorder.note(f"dropped {dropped} queued query command(s): {reason}")
        print(f"[bridge] dropped {dropped} queued query command(s): {reason}")
    else:
        _clear_pending_query_state(reason)
    return dropped


def _consume_tracked_query_done(command: str) -> None:
    cmd = str(command or "").strip().upper()
    if pending_query_done_commands and pending_query_done_commands[0] == cmd:
        pending_query_done_commands.popleft()


def _prune_uid_caches_to(live_uids: set[str]) -> None:
    """Drop bridge replay caches for UIDs absent from an authoritative TOPO."""
    cached_uids = (set(modules_by_uid) | set(module_types_by_uid)
                   | set(msg_cache_by_uid) | set(actuator_cache_by_uid)
                   | set(slot_by_uid))
    dead_uids = cached_uids - live_uids
    for uid in dead_uids:
        modules_by_uid.pop(uid, None)
        module_types_by_uid.pop(uid, None)
        msg_cache_by_uid.pop(uid, None)
        actuator_cache_by_uid.pop(uid, None)
        slot = slot_by_uid.pop(uid, None)
        if slot is not None:
            uid_by_slot.pop(slot, None)

    for key, stack_msg in list(stack_cache_by_uid.items()):
        parent_uid, _parent_face = key
        child_uid = stack_msg.get("child_uid")
        if parent_uid not in live_uids or (child_uid and child_uid not in live_uids):
            stack_cache_by_uid.pop(key, None)

    if dead_uids:
        print(f"[bridge] TOPO pruned stale cache: {sorted(dead_uids)}")


def parse_line(raw: str):
    """Parse a $-prefixed hub line into the bridge's JSON-shaped event.

    Wire decoding is delegated to `wb_protocol.parse_line`; this wrapper
    adds bridge-layer concerns: slot crosswalk via `slot_by_uid`, color
    derivation, descriptor field normalization, the `face` back-compat
    alias, and the cache cleanup triggered by `$U`.
    """
    msg = _parse_wire(raw)
    if msg is None:
        return None
    mtype = msg["type"]

    if mtype == "hello":
        uid = msg["uid"]
        if msg["id"]:
            modules_by_uid[uid] = msg["id"]
        mod_id = msg["id"] or modules_by_uid.get(uid, "")
        cached_desc = msg_cache_by_uid.get(uid, {}).get("descriptor", {}).get("data")
        msg["id"] = mod_id
        msg["slot"] = slot_by_uid.get(uid)
        msg["color"] = _descriptor_color(cached_desc) \
            or color_for(mod_id, module_types_by_uid.get(uid))
        # Legacy `face` alias is the *hub* face the module sits on, or 0
        # for a stacked child (which has no hub face — its position is
        # described by parent_uid + parent_face, not by its own face).
        # Setting face=parent_face unconditionally would make the canvas
        # draw stacked children at hub.F<parent_face> for the brief
        # window between cache replay and TOPO reconcile, which looks
        # exactly like an orphan module.
        msg["face"] = msg["parent_face"] if msg["parent_is_hub"] else 0
        return msg

    if mtype == "descriptor":
        uid = msg["uid"]
        desc = dict(msg["data"])
        if "type" not in desc:
            cat = desc.get("cat", "")
            desc["type"] = CAT_MAP.get(cat, cat)
            caps = desc.get("caps", [])
            if caps and not desc["type"]:
                desc["type"] = caps[0].get("m", "unknown")
        if "name" not in desc and "nm" in desc:
            desc["name"] = desc["nm"]
        if "version" not in desc and "ver" in desc:
            desc["version"] = desc["ver"]
        if "rate" not in desc:
            caps = desc.get("caps", [])
            if caps:
                sr = caps[0].get("sr", [])
                desc["rate"] = sr[0] if sr else 0
        derived_color = _descriptor_color(desc)
        if derived_color:
            desc["color"] = derived_color
        module_types_by_uid[uid] = desc.get("type", "imu")
        msg["data"] = desc
        msg["slot"] = slot_by_uid.get(uid)
        return msg

    if mtype == "module_info":
        uid = msg["uid"]
        if msg["id"]:
            modules_by_uid[uid] = msg["id"]
        cached_desc = msg_cache_by_uid.get(uid, {}).get("descriptor", {}).get("data")
        msg["slot"] = slot_by_uid.get(uid)
        msg["color"] = _descriptor_color(cached_desc) \
            or color_for(msg["id"], modules_by_uid.get(uid), module_types_by_uid.get(uid))
        return msg

    if mtype == "sensor":
        uid = msg["uid"]
        msg["sensor"] = module_types_by_uid.get(uid, "imu")
        msg["slot"] = slot_by_uid.get(uid)
        msg["ts"] = int(time.time() * 1000)
        return msg

    if mtype == "detach_pending":
        msg["slot"] = slot_by_uid.get(msg["uid"])
        return msg

    if mtype == "unplug":
        uid = msg["uid"]
        modules_by_uid.pop(uid, None)
        module_types_by_uid.pop(uid, None)
        msg_cache_by_uid.pop(uid, None)
        actuator_cache_by_uid.pop(uid, None)
        dead_keys = [k for k in stack_cache_by_uid if k[0] == uid]
        for k in dead_keys:
            stack_cache_by_uid.pop(k, None)
        slot = slot_by_uid.pop(uid, None)
        if slot is not None:
            uid_by_slot.pop(slot, None)
        msg["slot"] = slot
        return msg

    if mtype == "face_swap":
        msg["slot"] = slot_by_uid.get(msg["uid"])
        return msg

    if mtype == "topology":
        msg["slot"] = slot_by_uid.get(msg["uid"])
        topo_snapshot_uids.add(msg["uid"])
        return msg

    if mtype == "query_done":
        cmd = pending_query_done_commands.popleft() if pending_query_done_commands else None
        # Back-compat for manually typed `$Q,TOPO` on the serial console or old
        # paths that did not call _track_query_command(): if topology rows were
        # just seen, the DONE must belong to that snapshot.
        if cmd is None and topo_snapshot_uids:
            cmd = "TOPO"
        if cmd:
            msg["command"] = cmd
        if cmd == "TOPO":
            _prune_uid_caches_to(set(topo_snapshot_uids))
        topo_snapshot_uids.clear()
        return msg

    # child_stack, child_unstack, command_ack: pass through unchanged.
    return msg


def cache_msg(msg: dict):
    """Cache hello/descriptor/module_info/child_stack/actuator_state messages for replay
    to new clients.

    Real-hardware child_stack/child_unstack messages don't carry a top-level
    `uid` (only `parent_uid`/`child_uid`), so they're routed by parent_uid
    rather than uid. hello/descriptor/module_info/actuator_state are routed by uid;
    legacy slot-keyed sim variants (parent_slot/slot) are honoured as a
    fallback for older sim builds that haven't been migrated yet."""
    mtype = msg["type"]

    # Stack relationships — key by parent identity, not message uid.
    if mtype == "child_stack":
        parent_uid = msg.get("parent_uid")
        parent_face = msg.get("parent_face")
        if parent_uid and parent_face is not None:
            # Cache resolved links only (child_uid non-null / not pending).
            if not msg.get("pending"):
                stack_cache_by_uid[(parent_uid, parent_face)] = msg
        elif "parent_slot" in msg and "parent_face" in msg:
            if msg.get("child_slot", -1) >= 0:
                stack_cache[(msg["parent_slot"], msg["parent_face"])] = msg
        return

    if mtype == "child_unstack":
        parent_uid = msg.get("parent_uid")
        parent_face = msg.get("parent_face")
        if parent_uid and parent_face is not None:
            stack_cache_by_uid.pop((parent_uid, parent_face), None)
        elif "parent_slot" in msg and "parent_face" in msg:
            stack_cache.pop((msg["parent_slot"], msg["parent_face"]), None)
        return

    uid = msg.get("uid")
    if uid:
        if mtype == "hello":
            msg_cache_by_uid.setdefault(uid, {})["hello"] = msg
        elif mtype == "descriptor":
            msg_cache_by_uid.setdefault(uid, {})["descriptor"] = msg
        elif mtype == "module_info":
            msg_cache_by_uid.setdefault(uid, {})["module_info"] = msg
        elif mtype == "actuator_state":
            actuator_cache_by_uid[uid] = msg
        return

    # Legacy slot-keyed sim path (hello/descriptor/actuator only — stack
    # variants handled above).
    slot = msg.get("slot")
    if slot is None:
        return
    if mtype == "hello":
        msg_cache.setdefault(slot, {})["hello"] = msg
    elif mtype == "descriptor":
        msg_cache.setdefault(slot, {})["descriptor"] = msg
    elif mtype == "actuator_state":
        actuator_cache[slot] = msg


async def broadcast(msg: dict):
    if msg["type"] in ("hello", "descriptor", "module_info", "child_stack",
                       "child_unstack", "actuator_state"):
        try:
            cache_msg(msg)
        except Exception as e:
            # A malformed message should never bring the serial loop down.
            # Log loudly and keep going so the WS clients still get the
            # event (and so the next valid line still reaches the bridge).
            print(f"[bridge] cache_msg failed for {msg.get('type')}: "
                  f"{e!r}; msg keys={list(msg.keys())}")
    elif msg["type"] == "eca_status":
        global last_eca_status
        last_eca_status = msg
    elif msg["type"] == "eca_bytecode":
        global last_eca_bytecode
        last_eca_bytecode = msg
    recorder.event(msg)
    payload = json.dumps(msg)
    dead = set()
    for ws in clients:
        try:
            await ws.send(payload)
        except websockets.exceptions.ConnectionClosed:
            dead.add(ws)
    clients.difference_update(dead)
    # Mode B fan-out: synchronous, non-blocking, drops oldest on overflow.
    # Only sensor + actuator_state are forwardable; other types are filtered
    # inside forward() so the cost here stays O(targets).
    osc_forwarder.forward(msg)


def _parse_line_selftest() -> None:
    """Assert the bridge's parse_line wrapper adds slot crosswalk, color,
    descriptor normalization, the `face` alias, and runs $U cleanup. Wire
    decoding is covered by `wb_protocol._selftest`, which we invoke first."""
    from wb_protocol import _selftest as _wire_selftest
    _wire_selftest()

    def clear_state():
        for d in (modules_by_uid, module_types_by_uid, msg_cache_by_uid,
                  stack_cache_by_uid, actuator_cache_by_uid,
                  uid_by_slot, slot_by_uid):
            d.clear()
        pending_query_done_commands.clear()
        topo_snapshot_uids.clear()

    clear_state()
    # Pre-seed slot crosswalk so we can verify enrichment.
    uid_by_slot[3] = "A1B2C3D4"
    slot_by_uid["A1B2C3D4"] = 3

    h = parse_line("$H,A1B2C3D4,imuv2,HUB,1")
    assert h["slot"] == 3 and h["face"] == 1 \
        and h["color"] == "#7CA1BB" and h["id"] == "imuv2", h
    # Orphan $H recalls the cached module-id.
    assert parse_line("$H,A1B2C3D4,,HUB,1")["id"] == "imuv2"

    d = parse_line('$D,A1B2C3D4,{"id":"imuv2","nm":"IMU","cat":"motion_sensing","caps":[{"m":"acceleration","ax":3,"sr":[50]}]}')
    assert d["data"]["type"] == "imu" and d["data"]["name"] == "IMU" \
        and d["data"]["rate"] == 50 and d["slot"] == 3, d
    assert module_types_by_uid["A1B2C3D4"] == "imu"

    i = parse_line("$I,A1B2C3D4,imuv2,3.1,8F0A")
    assert i["slot"] == 3 and i["version"] == "3.1" \
        and i["fw_hash"] == "8F0A" and i["color"] == "#7CA1BB", i
    assert color_for("amp_009B7750") == "#9885BF"
    assert color_for("audiov1") == "#9885BF"
    assert _descriptor_color({
        "id": "custom_sound",
        "cat": "audio_output",
        "caps": [{"m": "audio_synth"}],
    }) == "#9885BF"

    s = parse_line("$S,A1B2C3D4,5,0.1234")
    assert s["sensor"] == "imu" and s["slot"] == 3 and "ts" in s, s

    u = parse_line("$U,A1B2C3D4")
    assert u["slot"] == 3
    assert "A1B2C3D4" not in modules_by_uid  # cleanup ran
    assert 3 not in uid_by_slot                # crosswalk torn down
    assert "A1B2C3D4" not in slot_by_uid

    # Resolve-target back-compat: slot → uid via side index.
    uid_by_slot[7] = "FEEDBEEF"
    assert _resolve_target({"uid": "ABC"}) == "ABC"
    assert _resolve_target({"slot": 7}) == "FEEDBEEF"
    assert _resolve_target({"slot": 99}) is None
    assert _resolve_target({}) is None

    # DONE is annotated with the tracked query command, and an authoritative
    # TOPO completion prunes stale replay caches for future WS clients.
    clear_state()
    modules_by_uid["FEEDBEEF"] = "imuv2"
    modules_by_uid["DEADCAFE"] = "ledv3"
    msg_cache_by_uid["DEADCAFE"] = {"hello": {"type": "hello", "uid": "DEADCAFE"}}
    _track_query_command("TOPO")
    t = parse_line("$T,FEEDBEEF,HUB,2")
    assert t["type"] == "topology" and t["uid"] == "FEEDBEEF"
    done = parse_line("$Q,DONE")
    assert done == {"type": "query_done", "command": "TOPO"}, done
    assert set(modules_by_uid) == {"FEEDBEEF"}
    assert "DEADCAFE" not in msg_cache_by_uid

    clear_state()
    _track_query_command("STATUS")
    assert parse_line("$Q,DONE") == {"type": "query_done", "command": "STATUS"}

    clear_state()
    print("[bridge] parse_line self-test OK")


async def ws_handler(ws):
    clients.add(ws)
    total_modules = len(modules_by_uid) + len(modules)
    await ws.send(json.dumps({"type": "status", "connected": True,
                               "modules": total_modules}))
    # Replay current transport state so the UI can render it immediately.
    if last_transport_status.get("transport") is not None or \
       last_transport_status.get("connected"):
        await ws.send(json.dumps(last_transport_status))
    # Replay paired-devices list so the Devices panel can render it
    # without an extra round-trip.
    await ws.send(json.dumps({"type": "paired_devices",
                               "devices": _load_paired()}))
    # Replay current OSC target list so the panel renders without
    # an explicit osc_list round-trip.
    await ws.send(json.dumps({"type": "osc_state",
                               "targets": osc_forwarder.snapshot()}))
    # Replay last-known ECA snapshot so a reconnecting client can render
    # "what's running" immediately, even before the next $Q,ECA fires.
    if last_eca_status is not None:
        await ws.send(json.dumps(last_eca_status))
    if last_eca_bytecode is not None:
        await ws.send(json.dumps(last_eca_bytecode))
    # Replay UID-keyed caches first (real-hardware and, after commit 3, sim).
    for uid in sorted(msg_cache_by_uid):
        cached = msg_cache_by_uid[uid]
        if "hello" in cached:
            await ws.send(json.dumps(cached["hello"]))
        if "module_info" in cached:
            await ws.send(json.dumps(cached["module_info"]))
        if "descriptor" in cached:
            await ws.send(json.dumps(cached["descriptor"]))
    for stack_msg in stack_cache_by_uid.values():
        await ws.send(json.dumps(stack_msg))
    for act_msg in actuator_cache_by_uid.values():
        await ws.send(json.dumps(act_msg))
    # Legacy slot-keyed replay — currently populated only by the sim path.
    for slot in sorted(msg_cache):
        cached = msg_cache[slot]
        if "hello" in cached:
            await ws.send(json.dumps(cached["hello"]))
        if "descriptor" in cached:
            await ws.send(json.dumps(cached["descriptor"]))
    for stack_msg in stack_cache.values():
        await ws.send(json.dumps(stack_msg))
    for act_msg in actuator_cache.values():
        await ws.send(json.dumps(act_msg))
    try:
        async for raw in ws:
            recorder.ws(raw)
            try:
                inbound = json.loads(raw)
                action = inbound.get("action")
                if action == "query":
                    cmd = str(inbound.get("command", "")).strip().upper()
                    if cmd == "DISCOVER":
                        print("[bridge] WS query ignored: $Q,DISCOVER is not implemented by firmware")
                        continue
                    if current_transport is None or not current_transport.is_open:
                        print(f"[bridge] WS query ignored (no active transport): $Q,{cmd}")
                        continue
                    await _queue_query_command(cmd)
                    print(f"[bridge] WS→serial: $Q,{cmd}")
                elif action == "program":
                    # Upload + auto-run an ECA bytecode program (base64).
                    b64 = inbound.get("data", "")
                    await serial_write_queue.put(f"$P {b64}\n")
                    print(f"[bridge] WS→serial: $P (<{len(b64)} chars>)")
                elif action == "program_run":
                    await serial_write_queue.put("$PR\n")
                elif action == "program_stop":
                    await serial_write_queue.put("$PS\n")
                elif action == "program_clear":
                    await serial_write_queue.put("$PC\n")
                elif action == "program_erase_nvs":
                    # Hub keeps the program running this session but won't
                    # auto-restore on next boot. See $PE in hub.ino.
                    await serial_write_queue.put("$PE\n")
                elif action == "actuator":
                    target = _resolve_target(inbound)
                    if target is None:
                        print(f"[bridge] actuator: no uid/slot in {inbound}")
                        continue
                    cmd  = int(inbound.get("cmd", 0))
                    params = inbound.get("params", []) or []
                    parts = " ".join(str(int(p)) for p in params)
                    line = f"$A {target} {cmd}" + (f" {parts}" if parts else "")
                    await serial_write_queue.put(line + "\n")
                    print(f"[bridge] WS→serial: {line}")
                elif action == "topic_enable":
                    target = _resolve_target(inbound)
                    if target is None: continue
                    ch   = int(inbound.get("channel", 0))
                    await serial_write_queue.put(f"$TE {target} {ch}\n")
                elif action == "topic_disable":
                    target = _resolve_target(inbound)
                    if target is None: continue
                    ch   = int(inbound.get("channel", 0))
                    await serial_write_queue.put(f"$TD {target} {ch}\n")
                elif action == "topic_enable_all":
                    target = _resolve_target(inbound)
                    if target is None: continue
                    await serial_write_queue.put(f"$TA {target}\n")
                elif action == "sim_command":
                    # Browser-side preset buttons (D1/D2/D3, clear, etc.)
                    # in --sim modes only. Silently no-op when not in sim.
                    sim_cmd = str(inbound.get("command", "")).strip()
                    if sim_cmd_queue is not None and sim_cmd:
                        await sim_cmd_queue.put(sim_cmd)
                        print(f"[bridge] WS→sim: {sim_cmd}")
                elif action == "ble_scan":
                    duration = float(inbound.get("duration", 5))
                    asyncio.create_task(_run_ble_scan(duration))
                elif action == "ble_connect":
                    addr = str(inbound.get("address", "")).strip()
                    name = str(inbound.get("name", "")).strip() or addr
                    if addr:
                        _upsert_paired(addr, name)
                        await transport_request.put(("ble", addr, name))
                        await broadcast({"type": "paired_devices",
                                          "devices": _load_paired()})
                elif action == "ble_disconnect":
                    await transport_request.put(("none",))
                elif action == "ble_forget":
                    addr = str(inbound.get("address", "")).strip()
                    if addr and _forget_paired(addr):
                        await broadcast({"type": "paired_devices",
                                          "devices": _load_paired()})
                elif action == "ble_set_auto_reconnect":
                    addr = str(inbound.get("address", "")).strip()
                    enable = bool(inbound.get("enable", False))
                    if addr:
                        # When turning one on, turn the others off — at most
                        # one device should auto-reconnect.
                        if enable:
                            for d in _load_paired():
                                if d.get("address") != addr and d.get("auto_reconnect"):
                                    _upsert_paired(d["address"], d.get("name", ""),
                                                    auto_reconnect=False)
                        _upsert_paired(addr, inbound.get("name", "") or addr,
                                        auto_reconnect=enable)
                        await broadcast({"type": "paired_devices",
                                          "devices": _load_paired()})
                elif action == "transport_use_serial":
                    port = str(inbound.get("port", "")).strip()
                    if not port:
                        candidates = serial_io.find_ports()
                        port = candidates[0] if candidates else ""
                    if port:
                        await transport_request.put(("serial", port))
                elif action == "osc_list":
                    await ws.send(json.dumps({"type": "osc_state",
                                               "targets": osc_forwarder.snapshot()}))
                elif action == "osc_add":
                    tgt = inbound.get("target") or {}
                    if "host" in tgt and "port" in tgt:
                        added, err = osc_forwarder.add(tgt)
                        if err is not None:
                            await ws.send(json.dumps({"type": "osc_error",
                                                       "action": "add",
                                                       "error": err}))
                        else:
                            await broadcast({"type": "osc_state",
                                              "targets": osc_forwarder.snapshot()})
                elif action == "osc_update":
                    tid = str(inbound.get("id", "")).strip()
                    tgt = inbound.get("target") or {}
                    if tid and "host" in tgt and "port" in tgt:
                        updated, err = osc_forwarder.update(tid, tgt)
                        if err is not None:
                            await ws.send(json.dumps({"type": "osc_error",
                                                       "action": "update",
                                                       "id": tid,
                                                       "error": err}))
                        elif updated is not None:
                            await broadcast({"type": "osc_state",
                                              "targets": osc_forwarder.snapshot()})
                elif action == "osc_remove":
                    tid = str(inbound.get("id", "")).strip()
                    if tid and osc_forwarder.remove(tid):
                        await broadcast({"type": "osc_state",
                                          "targets": osc_forwarder.snapshot()})
                elif action == "osc_auto_populate":
                    tid = str(inbound.get("id", "")).strip()
                    if tid:
                        try:
                            catalog = load_channel_catalog(CHANNEL_CATALOG_PATH)
                        except (OSError, json.JSONDecodeError) as exc:
                            await ws.send(json.dumps({"type": "osc_error",
                                                       "action": "auto_populate",
                                                       "id": tid,
                                                       "error": f"channel_catalog: {exc}"}))
                            continue
                        rows = schema_to_default_mappings(
                            modules_by_uid, module_types_by_uid, catalog)
                        if osc_forwarder.auto_populate(tid, rows) is not None:
                            await broadcast({"type": "osc_state",
                                              "targets": osc_forwarder.snapshot()})
            except (json.JSONDecodeError, ValueError, TypeError) as e:
                print(f"[bridge] bad WS message: {e}")
    finally:
        clients.discard(ws)


def _resolve_target(inbound: dict) -> str | None:
    """Resolve an inbound WS command to a UID token the hub accepts.

    Prefers explicit `uid`; falls back to `slot` via uid_by_slot for one
    deprecation cycle while frontend migrates. Returns None if neither
    resolves — caller logs and skips the command.
    """
    uid = inbound.get("uid")
    if uid:
        return str(uid)
    slot_val = inbound.get("slot")
    if slot_val is None:
        return None
    try:
        slot_int = int(slot_val)
    except (ValueError, TypeError):
        return None
    return uid_by_slot.get(slot_int)


async def _emit_transport_status(transport: Transport | None, *, connected: bool):
    """Cache + broadcast the current transport state."""
    msg = {
        "type": "transport_status",
        "transport": transport.name if transport else None,
        "address":   transport.address if transport else None,
        "label":     transport.label if transport else None,
        "connected": connected,
    }
    last_transport_status.update(msg)
    await broadcast(msg)


async def _run_ble_scan(duration: float):
    """Scan for HEX-* peripherals and broadcast each result + a 'done'
    sentinel so the UI can stop the spinner."""
    await broadcast({"type": "ble_scan_started", "duration": duration})
    try:
        results = await ble_scan_devices(duration=duration)
    except Exception as e:
        print(f"[bridge] BLE scan failed: {e!r}")
        await broadcast({"type": "ble_scan_error", "error": str(e)})
        return
    for r in results:
        await broadcast({"type": "ble_scan_result", **r})
    await broadcast({"type": "ble_scan_done", "count": len(results)})


async def _drive_transport(transport: Transport):
    """One read/write loop bound to a single open transport. Returns
    when the link drops or a switch is requested."""
    global current_transport
    exit_reason = "loop_ended"
    current_transport = transport
    await _emit_transport_status(transport, connected=True)
    _drop_pending_query_writes("fresh transport sync")
    # Layer 1 of rediscovery: first ask for authoritative topology, then
    # replay descriptors/status. Putting TOPO first keeps the small $T
    # snapshot ahead of larger descriptor bursts on BLE notify links.
    for cmd in ("TOPO", "STATUS", "ECA"):
        await _queue_query_command(cmd)
    recorder.note(f"transport connected: {transport.name} "
                  f"{transport.label} ({transport.address}); "
                  "queued $Q,TOPO + $Q,STATUS + $Q,ECA")
    print(f"[bridge] {transport.name} connected: {transport.label} "
          f"({transport.address}) — queued $Q,TOPO + $Q,STATUS + $Q,ECA")
    try:
        while transport.is_open:
            # Drain write queue
            while not serial_write_queue.empty():
                cmd = serial_write_queue.get_nowait()
                recorder.tx(cmd)
                try:
                    await transport.write(cmd.encode())
                    if transport.name == "ble":
                        await asyncio.sleep(0.08)
                except Exception as e:
                    exit_reason = f"write_failed: {e!r}"
                    recorder.note(exit_reason)
                    return
            # Switch requested?
            if not transport_request.empty():
                exit_reason = "switch_requested"
                return
            raw = await transport.read_line()
            if raw is None:
                err = getattr(transport, "last_error", None)
                exit_reason = "read_eof_or_disconnect"
                if err:
                    exit_reason += f": {err}"
                return  # EOF / disconnect
            if not raw:
                continue  # timeout — loop and re-check write queue
            recorder.rx(raw)
            if not raw.startswith("$"):
                line = raw.rstrip()
                if line:
                    marker = _classify_debug_line(line)
                    if marker:
                        recorder.note(f"{marker}: {line}")
                    print(f"[debug] {line}")
                    await broadcast({"type": "log", "line": line,
                                      "ts": int(time.time() * 1000)})
                continue
            try:
                msg = parse_line(raw)
            except Exception as e:
                print(f"[bridge] parse failed: {e!r} on {raw!r}")
                continue
            if msg:
                try:
                    await broadcast(msg)
                except Exception as e:
                    print(f"[bridge] broadcast failed: {e!r} "
                          f"type={msg.get('type')}")
    finally:
        recorder.note(f"transport disconnected: {transport.name} "
                      f"{transport.label} ({transport.address}); "
                      f"reason={exit_reason}")
        current_transport = None
        _clear_pending_query_state(f"transport disconnected: {exit_reason}")
        try:
            await transport.close()
        except Exception:
            pass
        await _emit_transport_status(None, connected=False)


async def transport_supervisor(initial_port: str | None = None):
    """Drives whichever transport is currently selected. Mutual-exclusion
    is intrinsic: there is at most one active `_drive_transport()` at a
    time. Switching is requested via `transport_request.put(spec)`:

        spec = ("serial", port_path)        # use SerialTransport
        spec = ("ble",    address, label)   # use BleTransport
        spec = ("none",)                    # disconnect, idle
    """
    pending = None
    if initial_port:
        pending = ("serial", initial_port)
    else:
        # If a paired BLE device is marked auto_reconnect, try it first.
        for d in _load_paired():
            if d.get("auto_reconnect"):
                pending = ("ble", d["address"], d.get("name") or d["address"])
                break

    while True:
        if pending is None:
            # Idle — wait for a request.
            await _emit_transport_status(None, connected=False)
            spec = await transport_request.get()
        else:
            spec = pending
            pending = None

        kind = spec[0]
        if kind == "none":
            recorder.note("transport request: none")
            continue

        # Build transport
        if kind == "serial":
            port = spec[1]
            transport: Transport = SerialTransport(port, BAUD)
        elif kind == "ble":
            addr = spec[1]
            label = spec[2] if len(spec) > 2 else addr
            transport = BleTransport(addr, label=label)
        else:
            print(f"[bridge] unknown transport spec: {spec!r}")
            recorder.note(f"unknown transport spec: {spec!r}")
            continue

        # Open with retry/wait semantics appropriate to each kind
        recorder.note(f"transport opening: {kind} {transport.label} "
                      f"({transport.address})")
        opened = await transport.open()
        if not opened:
            if kind == "serial":
                # Mirror old behaviour: wait for the port to reappear, but
                # bail out if a different transport is requested first.
                print(f"[bridge] {port} not present, polling…")
                recorder.note(f"serial open failed: {port}; polling")
                loop = asyncio.get_event_loop()
                while not opened:
                    if not transport_request.empty():
                        recorder.note(f"serial polling aborted by switch: {port}")
                        break
                    ser = await loop.run_in_executor(
                        None, lambda: serial_io.open_serial(port, BAUD, timeout=0.1))
                    if ser is not None:
                        try:
                            ser.close()
                        except Exception:
                            pass
                        recorder.note(f"serial port reappeared: {port}")
                        opened = await transport.open()
                        break
                    await asyncio.sleep(0.5)
                if not opened:
                    recorder.note(f"serial open abandoned: {port}")
                    continue
            else:
                print(f"[bridge] BLE open failed; staying idle")
                recorder.note(f"BLE open failed: {transport.label} "
                              f"({transport.address}); "
                              f"last_error={getattr(transport, 'last_error', None)}")
                await _emit_transport_status(None, connected=False)
                continue

        # Drive until disconnect or switch
        await _drive_transport(transport)

        # If the loop exited because of a switch request, pop it.
        if not transport_request.empty():
            try:
                pending = transport_request.get_nowait()
            except asyncio.QueueEmpty:
                pending = None
        elif kind == "serial":
            # Serial dropped on its own — auto-reconnect to same port.
            pending = ("serial", spec[1])
            recorder.note(f"serial auto-reconnect scheduled: {spec[1]}")
        elif kind == "ble":
            # BLE dropped — go idle (user must reconnect from UI).
            pending = None
            recorder.note("BLE disconnected; staying idle")


async def serial_loop(port: str):
    """Back-compat entry point used by main()."""
    await transport_supervisor(initial_port=port)


# Legacy single-transport implementation kept here as reference for the
# behavioural contract (write-queue draining, $Q,STATUS resync). Live code
# now goes through transport_supervisor → _drive_transport.
async def _serial_loop_legacy(port: str):
    loop = asyncio.get_event_loop()
    while True:
        ser = serial_io.open_serial(port, BAUD, timeout=0.1)
        if ser is None:
            print(f"[bridge] {port} not present, polling…")
            ser = await loop.run_in_executor(
                None, lambda: serial_io.wait_for_port(
                    port, BAUD, max_wait=float("inf")))
            if ser is None:
                continue
        try:
            print(f"[bridge] serial connected: {port}")
            # Layer 1 of rediscovery: hub may already have modules registered
            # from before we connected. Ask it to re-emit $H/$D for everything
            # in its registry so our msg_cache is populated for any browser
            # that connects later. Replays don't trigger re-discovery on the
            # CAN bus — they only dump what hub already knows.
            _drop_pending_query_writes("fresh serial sync")
            for cmd in ("TOPO", "STATUS", "ECA"):
                await _queue_query_command(cmd)
            print("[bridge] sent $Q,TOPO + $Q,STATUS + $Q,ECA to hub (initial sync)")
            while True:
                # Drain write queue → send commands to hub
                while not serial_write_queue.empty():
                    cmd = serial_write_queue.get_nowait()
                    recorder.tx(cmd)
                    await loop.run_in_executor(
                        None, lambda c=cmd: ser.write(c.encode()))
                # Run blocking readline in executor so event loop stays free
                raw = await loop.run_in_executor(
                    None, lambda: ser.readline().decode("utf-8", errors="replace"))
                if not raw:
                    continue
                recorder.rx(raw)
                if not raw.startswith("$"):
                    line = raw.rstrip()
                    if line:
                        print(f"[debug] {line}")
                        await broadcast({"type": "log",
                                          "line": line,
                                          "ts": int(time.time() * 1000)})
                    continue
                try:
                    msg = parse_line(raw)
                except Exception as e:
                    # Defensive: a malformed hub line should never bring
                    # the serial loop down. Real serial drops still raise
                    # SerialException and trigger reconnect below.
                    print(f"[bridge] parse failed: {e!r} on {raw!r}")
                    continue
                if msg:
                    try:
                        await broadcast(msg)
                    except serial.SerialException:
                        raise
                    except Exception as e:
                        print(f"[bridge] broadcast failed: {e!r} "
                              f"type={msg.get('type')}")
        except serial.SerialException as e:
            print(f"[bridge] serial dropped: {e} — reconnecting…")
            try:
                ser.close()
            except Exception:
                pass


# ── Simple mock (backward-compatible) ────────────────────────────

async def mock_loop():
    print("[bridge] mock mode -- generating fake IMU data at 50 Hz")
    slot, mod_id = 1, "imuv2"
    modules[slot] = mod_id
    await broadcast({"type": "hello", "id": mod_id, "face": 1, "slot": slot,
                      "color": color_for(mod_id)})
    await broadcast({"type": "descriptor", "slot": slot,
                      "data": {"id": mod_id, "type": "imu", "rate": 50}})
    t0 = time.time()
    while True:
        t = time.time() - t0
        await broadcast({
            "type": "sensor", "slot": slot, "sensor": "imu",
            "ts": int(time.time() * 1000),
            "data": {"ax": round(math.sin(t * 2) * 0.1, 4),
                     "ay": round(math.cos(t * 2) * 0.1, 4),
                     "az": round(1.0 + math.sin(t) * 0.02, 4),
                     "gx": round(math.sin(t * 3) * 5, 2),
                     "gy": round(math.cos(t * 3) * 5, 2),
                     "gz": round(math.sin(t) * 2, 2)}})
        await asyncio.sleep(0.02)


# ── Interactive multi-module simulator ───────────────────────────

# Standard module face layout: 1P + 3R (P opposite + the two R adjacent to
# that opposite cluster on the half facing away from P). Faces 2 and 6 are
# physically closed (no connector). Hub has all 6 faces as R.
MODULE_FACE_KINDS = {1: "P", 3: "R", 4: "R", 5: "R"}
HUB_FACE_KINDS    = {1: "R", 2: "R", 3: "R", 4: "R", 5: "R", 6: "R"}

# Full descriptors matching WearBlocksDescriptor::serialize() output
SIM_MODULE_DEFS = {
    "imu": {
        "id": "imuv2", "slot": 1, "face": 1, "color": "#7CA1BB",
        "descriptor": {
            "id": "imuv2", "name": "6-Axis IMU", "cat": "motion_sensing",
            "color": "#7CA1BB", "ver": "2.0",
            "caps": [
                {"t": "sensor", "m": "acceleration", "ax": 3,
                 "rn": -16, "rx": 16, "res": 0.001, "dt": "float32[3]", "sr": [50]},
                {"t": "sensor", "m": "angular_velocity", "ax": 3,
                 "rn": -2000, "rx": 2000, "res": 0.1, "dt": "float32[3]", "sr": [50]},
            ],
            "affs": ["detect_gesture", "track_orientation", "count_repetitions"],
            "pwr": {"v": 3.3, "i": 3.5, "ip": 10},
            "phy": {"w": 4.2, "dim": [15, 15, 5], "plc": ["wrist", "forearm"]},
        },
        "hz": 50,
    },
    "hr": {
        "id": "hrv1", "slot": 2, "face": 2, "color": "#7B68EE",
        "descriptor": {
            "id": "hrv1", "name": "Heart Rate", "cat": "biometric",
            "color": "#7B68EE", "ver": "1.0",
            "caps": [
                {"t": "sensor", "m": "heart_rate", "ax": 1,
                 "rn": 30, "rx": 220, "res": 1, "dt": "float32", "sr": [10]},
                {"t": "sensor", "m": "spo2", "ax": 1,
                 "rn": 70, "rx": 100, "res": 0.1, "dt": "float32", "sr": [10]},
            ],
            "affs": ["monitor_heart", "detect_stress"],
            "pwr": {"v": 3.3, "i": 5.0, "ip": 20},
            "phy": {"w": 3.0, "dim": [15, 15, 5], "plc": ["wrist", "finger"]},
        },
        "hz": 10,
    },
    "temp": {
        "id": "tmpv1", "slot": 3, "face": 3, "color": "#F5A623",
        "descriptor": {
            "id": "tmpv1", "name": "Temp/Humidity", "cat": "environmental",
            "color": "#F5A623", "ver": "1.0",
            "caps": [
                {"t": "sensor", "m": "temperature", "ax": 1,
                 "rn": -40, "rx": 85, "res": 0.01, "dt": "float32", "sr": [1]},
                {"t": "sensor", "m": "humidity", "ax": 1,
                 "rn": 0, "rx": 100, "res": 0.1, "dt": "float32", "sr": [1]},
            ],
            "affs": ["measure_temperature", "measure_humidity"],
            "pwr": {"v": 3.3, "i": 1.0, "ip": 3},
            "phy": {"w": 2.5, "dim": [15, 15, 4], "plc": ["chest", "wrist"]},
        },
        "hz": 1,
    },
    "led": {
        "id": "ledv1", "slot": 5, "face": 5, "color": "#C68E9E",
        "descriptor": {
            "id": "ledv1", "name": "RGB LED Ring", "cat": "visual_output",
            "color": "#C68E9E", "ver": "1.0",
            "caps": [
                {"t": "actuator", "m": "rgb_light", "ax": 3,
                 "rn": 0, "rx": 255, "res": 1, "dt": "uint8[3]", "sr": []},
            ],
            "affs": ["visual_feedback", "status_indicator", "notification"],
            "pwr": {"v": 3.3, "i": 20, "ip": 400},
            "phy": {"w": 3.8, "dim": [20, 20, 4], "plc": ["wrist", "chest"]},
        },
        "hz": 0,  # actuator, no streaming
    },
    "vib": {
        "id": "vibv1", "slot": 4, "face": 4, "color": "#50C878",
        "descriptor": {
            "id": "vibv1", "name": "Vibration Motor", "cat": "haptic_output",
            "color": "#50C878", "ver": "1.0",
            "caps": [
                {"t": "actuator", "m": "vibration", "ax": 1,
                 "rn": 0, "rx": 255, "res": 1, "dt": "uint8", "sr": []},
            ],
            "affs": ["haptic_feedback", "notification", "guidance"],
            "pwr": {"v": 3.3, "i": 50, "ip": 150},
            "phy": {"w": 5.0, "dim": [15, 15, 6], "plc": ["wrist", "ankle"]},
        },
        "hz": 0,  # actuator, no streaming
    },
    "light": {
        "id": "lightv3", "slot": 6, "face": 6, "color": "#C1B496",
        "descriptor": {
            "id": "lightv3", "name": "Light Sensor", "cat": "light_sensing",
            "color": "#C1B496", "ver": "3.0",
            "caps": [
                {"t": "sensor", "m": "light", "ax": 1,
                 "rn": 0, "rx": 1, "res": 0.001, "dt": "float32", "sr": [25]},
            ],
            "affs": ["detect_ambient_light", "detect_cover"],
            "pwr": {"v": 3.3, "i": 1.0, "ip": 1.0},
            "phy": {"w": 2.0, "dim": [15, 15, 4], "plc": ["wrist", "chest"]},
        },
        "hz": 25,
    },
    "audio": {
        "id": "audiov1", "slot": 7, "face": 2, "color": "#9885BF",
        "descriptor": {
            "id": "audiov1", "name": "Audio Synth", "cat": "audio_output",
            "color": "#9885BF", "ver": "1.0",
            "caps": [
                {"t": "actuator", "m": "audio_synth", "ax": 2,
                 "rn": 0, "rx": 5000, "res": 1, "dt": "uint16[2]", "sr": []},
            ],
            "affs": ["audio_feedback", "tone_generation", "notification"],
            "pwr": {"v": 3.3, "i": 100, "ip": 500},
            "phy": {"w": 4.5, "dim": [20, 20, 5], "plc": ["wrist", "chest"]},
        },
        "hz": 0,  # actuator, no streaming
    },
}


def _noise(scale: float = 0.01) -> float:
    return random.gauss(0, scale)


def sim_sensor_data(mod_type: str, t: float) -> dict | None:
    """Generate realistic sensor data for a given module type."""
    if mod_type == "imu":
        return {
            "ax": round(math.sin(t * 2.1) * 0.15 + _noise(0.02), 4),
            "ay": round(math.cos(t * 1.7) * 0.12 + _noise(0.02), 4),
            "az": round(1.0 + math.sin(t * 0.5) * 0.03 + _noise(0.01), 4),
            "gx": round(math.sin(t * 3.3) * 8.0 + _noise(0.5), 2),
            "gy": round(math.cos(t * 2.8) * 6.0 + _noise(0.5), 2),
            "gz": round(math.sin(t * 1.2) * 3.0 + _noise(0.3), 2),
        }
    if mod_type == "light":
        # Simulate ambient light: slow changes (day/night cycle) + small noise
        # Range 0..1 (normalized), mimics LDR voltage divider output
        base = 0.5 + math.sin(t * 0.05) * 0.3  # slow drift
        light = max(0.0, min(1.0, base + _noise(0.01)))
        return {
            "ax": round(light, 3),
            "ay": 0, "az": 0, "gx": 0, "gy": 0, "gz": 0,
        }
    if mod_type == "hr":
        bpm = 72 + math.sin(t * 0.1) * 8 + _noise(2)
        spo2 = 97.5 + math.sin(t * 0.05) * 0.8 + _noise(0.2)
        return {
            "ax": round(bpm, 1),        # repurpose ax for BPM
            "ay": round(spo2, 1),       # repurpose ay for SpO2
            "az": 0, "gx": 0, "gy": 0, "gz": 0,
        }
    if mod_type == "temp":
        temp = 22.5 + math.sin(t * 0.02) * 1.5 + _noise(0.1)
        hum = 45.0 + math.sin(t * 0.03) * 5.0 + _noise(0.5)
        pres = 1013.25 + math.sin(t * 0.01) * 2.0 + _noise(0.1)
        return {
            "ax": round(temp, 2),       # repurpose ax for temperature
            "ay": round(hum, 1),        # repurpose ay for humidity
            "az": round(pres, 1),       # repurpose az for pressure
            "gx": 0, "gy": 0, "gz": 0,
        }
    return None


class SimModule:
    """A simulated module that streams data."""

    def __init__(self, mod_type: str):
        defn = SIM_MODULE_DEFS[mod_type]
        self.mod_type = mod_type
        self.mod_id = defn["id"]
        self.slot = defn["slot"]
        # Stable synthetic UID per slot — matches the 8-hex-char format the
        # real hub emits. Letting slot drive the uid keeps sim messages
        # deterministic across runs (the spike-injection CLI still addresses
        # by slot or module-type name; uid is for the wire only).
        # Chars must be valid hex (0-9, a-f) so the ECA bytecode encoder
        # can parse uid → u32. "FACE" is the prefix; slot fills the low 16 bits.
        self.uid = f"FACE{self.slot:04X}"
        self.face = defn["face"]
        self.color = defn["color"]
        self.descriptor = defn["descriptor"]
        self.hz = defn["hz"]
        self.active = True
        self.t0 = time.time()
        # Register uid ↔ slot both ways so the bridge's inbound-WS routing
        # (host commands) and parse_line (future hub echoes) both resolve
        # correctly. Populate before first broadcast.
        uid_by_slot[self.slot] = self.uid
        slot_by_uid[self.uid] = self.slot
        modules_by_uid[self.uid] = self.mod_id
        # Actuator runtime state (only meaningful for LED/VIB modules; harmless
        # to carry on sensors). until_ms == 0 means "no expiry scheduled".
        self.led = {"r": 0, "g": 0, "b": 0, "brightness": 0,
                    "mode": "off", "until_ms": 0}
        self.vib = {"intensity": 0, "mode": "off", "until_ms": 0}
        # One-shot sensor spike: {channel_id: (override_value, expires_ms)}.
        # Consumed by sim_sensor_data via _spike_override; auto-cleared.
        self.spikes: dict[int, tuple[float, int]] = {}

    async def send_hello(self):
        await broadcast({
            "type": "hello", "uid": self.uid,
            "id": self.mod_id, "face": self.face,
            "slot": self.slot, "color": self.color,
            "parent_uid": None, "parent_is_hub": True,
            "parent_face": self.face,
        })

    async def send_descriptor(self):
        # Inject face-kind layout (P/R per face) so the frontend can render
        # connector orientation badges. Stringify keys to match JSON behavior.
        desc = dict(self.descriptor)
        desc["face_kinds"] = {str(k): v for k, v in MODULE_FACE_KINDS.items()}
        await broadcast({"type": "descriptor", "uid": self.uid,
                          "slot": self.slot, "data": desc})

    async def send_sensor_tick(self):
        if self.hz <= 0 or not self.active:
            return
        t = time.time() - self.t0
        data = sim_sensor_data(self.mod_type, t)
        if not data:
            return
        # Apply any one-shot spike overrides. A spike replaces the generator
        # output for a single channel until its expiry time passes.
        now_ms = int(time.time() * 1000)
        ch_map = SIM_CHANNEL_MAP.get(self.mod_type, {})
        if self.spikes:
            # Reverse lookup channel_id → data key so spikes can target CH.AX
            # directly regardless of the module's per-type remap.
            key_for = {v: k for k, v in ch_map.items()}
            expired = []
            for ch_id, (value, until) in self.spikes.items():
                if now_ms >= until:
                    expired.append(ch_id)
                    continue
                key = key_for.get(ch_id)
                if key is not None and key in data:
                    data[key] = value
            for ch_id in expired:
                self.spikes.pop(ch_id, None)
        # Feed the ECA engine so rule conditions can see the same values
        # the WS clients see. Map this module's per-type data keys to the
        # canonical channel ids.
        for key, ch_id in ch_map.items():
            if key in data:
                eca.update_sensor(self.slot, int(ch_id), float(data[key]))
        sensor_type = CAT_MAP.get(self.descriptor.get("cat", ""), self.mod_type)
        # Emit one v2-shaped per-channel frame per channel in this module's
        # capability map — this is what the real hub emits on the wire. Keep
        # the legacy batched frame as a secondary broadcast during the
        # frontend migration window so the sensor panel keeps rendering
        # until commit 4 switches it over.
        for key, ch_id in ch_map.items():
            if key not in data:
                continue
            await broadcast({
                "type": "sensor", "uid": self.uid, "slot": self.slot,
                "sensor": sensor_type, "channel_id": int(ch_id),
                "value": float(data[key]), "ts": now_ms,
            })
        await broadcast({
            "type": "sensor", "uid": self.uid, "slot": self.slot,
            "sensor": sensor_type, "ts": now_ms, "data": data,
            "legacy": True,
        })


# Active simulated modules
sim_modules: dict[int, SimModule] = {}  # slot → SimModule
# Parent tracking for stacked modules:  child_slot → (parent_slot, parent_face)
sim_parents: dict[int, tuple[int, int]] = {}
sim_eca_b64: str = ""
sim_eca_raw_len: int = 0

# Set by sim_loop() so the WS handler can inject sim commands (e.g.
# "demo1") from the browser preset buttons.
sim_cmd_queue: asyncio.Queue | None = None


def _slot_for_type(mod_type: str) -> int | None:
    defn = SIM_MODULE_DEFS.get(mod_type)
    return defn["slot"] if defn else None


def _resolve_slot(token: str) -> int | None:
    """Accept either a numeric slot or a module-type name."""
    token = token.strip().lower()
    if not token:
        return None
    if token.isdigit():
        return int(token)
    return _slot_for_type(token)


async def sim_stack(child_slot: int, parent_slot: int, parent_face: int):
    if child_slot not in sim_modules:
        print(f"  [sim] stack: child slot {child_slot} not connected")
        return
    if parent_slot not in sim_modules:
        print(f"  [sim] stack: parent slot {parent_slot} not connected")
        return
    if child_slot == parent_slot:
        print(f"  [sim] stack: cannot stack module on itself")
        return
    # Remember the child's original hub face so we can restore it on unstack.
    child = sim_modules[child_slot]
    parent = sim_modules[parent_slot]
    orig_face = child.face
    sim_parents[child_slot] = (parent_slot, parent_face)
    # Mirror real hub behaviour: a stacked child does not occupy any hub face.
    # We broadcast face_swap(old → 0) first so the frontend removes the module
    # from the hub face bar, *then* broadcast child_stack to link it visually
    # as a child of the parent.
    if orig_face != 0:
        child._orig_hub_face = orig_face  # stash for unstack
        child.face = 0
        await broadcast({"type": "face_swap", "uid": child.uid,
                         "slot": child_slot,
                         "old_parent_uid": None, "old_parent_is_hub": True,
                         "old_face": orig_face,
                         "new_parent_uid": parent.uid,
                         "new_parent_is_hub": False,
                         "new_face": 0})
        # Late-joining WS clients replay the cached hello — update it so
        # they don't see the child re-appearing on its old hub face.
        cached = (msg_cache_by_uid.get(child.uid, {}).get("hello")
                  or msg_cache.get(child_slot, {}).get("hello"))
        if cached:
            cached["face"] = 0
            cached["parent_face"] = 0
    await broadcast({"type": "child_stack",
                     "parent_uid": parent.uid, "child_uid": child.uid,
                     "pending": False,
                     "parent_slot": parent_slot, "child_slot": child_slot,
                     "parent_face": parent_face})
    c = child.mod_type
    p = parent.mod_type
    print(f"  [sim] ⬆ stacked {c} (slot {child_slot}) onto "
          f"{p} (slot {parent_slot}) face {parent_face}")


async def sim_unstack(child_slot: int):
    if child_slot not in sim_parents:
        print(f"  [sim] unstack: slot {child_slot} is not stacked")
        return
    parent_slot, parent_face = sim_parents.pop(child_slot)
    child = sim_modules.get(child_slot)
    parent = sim_modules.get(parent_slot)
    child_uid = child.uid if child else None
    parent_uid = parent.uid if parent else None
    await broadcast({"type": "child_unstack",
                     "parent_uid": parent_uid, "child_uid": child_uid,
                     "pending": False,
                     "parent_slot": parent_slot, "child_slot": child_slot,
                     "parent_face": parent_face})
    # Restore child's original hub face (if we stashed one on stack).
    if child is not None:
        restored = getattr(child, "_orig_hub_face", None)
        if restored and child.face == 0:
            child.face = restored
            await broadcast({"type": "face_swap", "uid": child.uid,
                             "slot": child_slot,
                             "old_parent_uid": parent_uid,
                             "old_parent_is_hub": False, "old_face": 0,
                             "new_parent_uid": None,
                             "new_parent_is_hub": True,
                             "new_face": restored})
            cached = (msg_cache_by_uid.get(child.uid, {}).get("hello")
                      or msg_cache.get(child_slot, {}).get("hello"))
            if cached:
                cached["face"] = restored
                cached["parent_face"] = restored
    print(f"  [sim] ⬇ unstacked slot {child_slot} from "
          f"slot {parent_slot} face {parent_face}")


# ── ECA action dispatch + sim command consumer ──────────────────

def _u16_be(b0: int, b1: int) -> int:
    """Decode a big-endian u16 from two bytes — matches eca-encoder.js u16()."""
    return ((b0 & 0xFF) << 8) | (b1 & 0xFF)


def dispatch_action(act: EcaAction) -> None:
    """ECA on_action callback — apply an actuator action to SimModule state.

    Param semantics (v3): the engine has already resolved each typed-ref
    param to a float in `act.vals`. The action's `target` is a module UID;
    we translate it via slot_by_uid to find the sim's slot.
    See WearBlocksECA.h:WBActCmd for the per-cmd param schema.
    """
    # Translate uid → sim slot. UIDs are stored as 8-hex-char strings in
    # slot_by_uid, while the engine carries them as a u32 — same value.
    uid_hex = f"{act.target:08X}"
    target_slot = slot_by_uid.get(uid_hex)
    if target_slot is None:
        print(f"  [sim] ECA action for unknown uid={uid_hex} — ignored")
        return
    mod = sim_modules.get(target_slot)
    if mod is None:
        print(f"  [sim] ECA action for empty slot {target_slot} — ignored")
        return
    cmd = act.cmd
    now_ms = int(time.time() * 1000)
    vals = act.vals or []

    def vget(i: int, default: float = 0.0) -> float:
        return vals[i] if i < len(vals) else default

    def vbyte(i: int) -> int:
        return max(0, min(255, int(vget(i) + 0.5)))

    # ── LED commands ───────────────────────────────
    if cmd in (Act.LED_OFF, Act.LED_STOP):
        mod.led = {"r": 0, "g": 0, "b": 0, "brightness": 0,
                   "mode": "off", "until_ms": 0}
    elif cmd == Act.LED_SOLID:
        # 3 params: R, G, B (each 0..255). No duration in v2 — SOLID is
        # set-and-hold; subsequent SOLID/OFF replaces it.
        mod.led = {"r": vbyte(0), "g": vbyte(1), "b": vbyte(2),
                   "brightness": 255, "mode": "solid", "until_ms": 0}
    elif cmd in (Act.LED_BLINK, Act.LED_BREATHE, Act.LED_RAMP, Act.LED_RAINBOW):
        # Reserved — module_led v3 doesn't implement these. Treat as SOLID
        # with the first 3 params (forward-compatible passthrough).
        mod.led = {"r": vbyte(0), "g": vbyte(1), "b": vbyte(2),
                   "brightness": 255, "mode": "solid", "until_ms": 0}

    # ── Vibration commands ─────────────────────────
    elif cmd == Act.VIBRATE:
        intensity = vbyte(0)
        dur_ms = max(0, int(vget(1) + 0.5))
        mod.vib = {"intensity": intensity, "mode": "on",
                   "until_ms": (now_ms + dur_ms) if dur_ms > 0 else 0}
    elif cmd == Act.VIBRATE_PULSE:
        intensity = vbyte(0)
        on_10ms = vbyte(1); off_10ms = vbyte(2); count = vbyte(3) or 1
        total = (on_10ms + off_10ms) * 10 * max(1, count)
        mod.vib = {"intensity": intensity, "mode": "pulse",
                   "on_ms": on_10ms * 10, "off_ms": off_10ms * 10,
                   "count": count, "until_ms": now_ms + total}
    elif cmd == Act.VIBRATE_STOP:
        mod.vib = {"intensity": 0, "mode": "off", "until_ms": 0}

    print(f"  [sim] ECA fired: target_uid={uid_hex} (slot={target_slot}) cmd={cmd}")


# Bind the engine to the dispatcher now that dispatch_action exists.
eca._on_action = dispatch_action

# v3 ECA bytecode is uid-keyed; the engine asks back via this hook to
# translate uid (u32) → sim slot for sensor cache lookups inside SLOT refs.
# Same shape as the real hub's registry.findByUid().
def _sim_uid_to_slot(uid_u32: int) -> int:
    return slot_by_uid.get(f"{uid_u32:08X}", 0) or 0
eca.set_uid_resolver(_sim_uid_to_slot)


def _resolve_sim_target(token: str) -> int | None:
    """Resolve a $A/$TE/$TD/$TA argument to a sim slot.

    Accepts a UID (8-hex), a numeric slot, or a module-type name — the sim
    command surface is historically lenient and the real hub's UID format
    is already handled via slot_by_uid.
    """
    token = token.strip()
    if not token:
        return None
    if token in slot_by_uid:
        slot = slot_by_uid[token]
        return slot if slot in sim_modules else None
    if token.isdigit():
        slot = int(token)
        return slot if slot in sim_modules else None
    return _slot_for_type(token.lower())


def _parse_sim_command(line: str) -> None:
    """Route a $-prefixed serial line synchronously into the ECA engine.
    Called from sim_command_consumer; safe to also call from anywhere that
    has already parsed a serial line. Returns None; emits log + ack via
    broadcast (scheduled as a task)."""
    line = line.strip()
    if not line.startswith("$"):
        return
    global sim_eca_b64, sim_eca_raw_len

    async def _ack(text: str, ok: bool = True):
        await broadcast({"type": "command_ack",
                         "status": "ok" if ok else "err",
                         "text": text,
                         "ts": int(time.time() * 1000)})

    try:
        if line.startswith("$P "):
            b64 = line[3:].strip()
            raw = base64.b64decode(b64)
            ok = eca.load_program(raw)
            text = (f"P loaded ({len(raw)} bytes, {eca.num_vcs()} VCs, "
                    f"{eca.num_rules()} rules)" if ok else "P load failed")
            asyncio.create_task(_ack(text, ok))
            print(f"  [sim] {text}")
            if ok:
                sim_eca_b64 = b64
                sim_eca_raw_len = len(raw)
                # Match real hub: $P also auto-runs.
                eca.run_program()
                asyncio.create_task(_ack("running"))
        elif line == "$PR":
            eca.run_program()
            asyncio.create_task(_ack("running"))
            print("  [sim] ECA running")
        elif line == "$PS":
            eca.stop_program()
            asyncio.create_task(_ack("stopped"))
            print("  [sim] ECA stopped")
        elif line == "$PC":
            eca.clear_program()
            sim_eca_b64 = ""
            sim_eca_raw_len = 0
            # Reset all actuators when program cleared.
            for s, m in sim_modules.items():
                m.led = {"r": 0, "g": 0, "b": 0, "brightness": 0,
                         "mode": "off", "until_ms": 0}
                m.vib = {"intensity": 0, "mode": "off", "until_ms": 0}
            asyncio.create_task(_ack("cleared"))
            print("  [sim] ECA cleared")
        elif line.startswith("$A "):
            # $A <uid|slot> <cmd> <p0..p9>   — v2 hub addresses by UID; we
            # still accept a numeric slot for legacy host commands until the
            # frontend migration lands.
            parts = line[3:].split()
            if len(parts) < 2:
                asyncio.create_task(_ack("$A: need target + cmd", ok=False))
                return
            target = parts[0]
            slot = _resolve_sim_target(target)
            if slot is None:
                asyncio.create_task(_ack(f"$A bad_target {target}", ok=False))
                return
            cmd = int(parts[1])
            # $A's free-form params are positional bytes — wrap each as a
            # CONST-typed action param so the float-resolving dispatch path
            # gives the same byte values as the legacy raw-bytes path.
            # v3 actions take a u32 target (uid). _resolve_sim_target() above
            # already gave us the sim slot; we look up its uid here.
            from wb_eca import ActionParam, REF as _REF
            mod = sim_modules.get(slot)
            target_uid = int(mod.uid, 16) if (mod and mod.uid) else 0
            raw = [int(p) for p in parts[2:]][:4]  # cap at WB_ACTION_MAX_PARAMS
            params_typed = [ActionParam(type=_REF.CONST, id=0, ch=0,
                                        value=float(b)) for b in raw]
            dispatch_action(EcaAction(target=target_uid, cmd=cmd,
                                      params=params_typed,
                                      vals=[float(b) for b in raw]))
            asyncio.create_task(_ack(f"A slot={slot} cmd={cmd}"))
        elif line.startswith(("$TE", "$TD", "$TA")):
            # $TE/$TD <uid|slot> <ch>   /   $TA <uid|slot>
            # Sim has no CAN to forward to; resolve-and-ack so the frontend
            # sees the ack shape it expects from the real hub.
            parts = line.split()
            op = parts[0][1:]  # "TE", "TD", "TA"
            target = parts[1] if len(parts) >= 2 else ""
            slot = _resolve_sim_target(target) if target else None
            if target and slot is None:
                asyncio.create_task(_ack(f"{op} bad_target {target}", ok=False))
            else:
                print(f"  [sim] (topic op ignored in sim) {line}")
                asyncio.create_task(_ack(f"{op} slot={slot}"))
        elif line.startswith("$Q,") or line == "$Q":
            # $Q,TOPO / $Q,STATUS / $Q,DISCOVER — sim has no real registry
            # to replay, but TOPO matters for frontend reconciliation
            # testing: emit one $T row per active module + a trailing
            # $Q,DONE so the frontend's reconcile path fires.
            cmd = line[3:].strip() if "," in line else ""
            if cmd == "ECA":
                asyncio.create_task(_emit_sim_eca_snapshot())
            elif cmd == "TOPO":
                asyncio.create_task(_emit_sim_topology())
            else:
                # STATUS/DISCOVER: modules already broadcast on +type, so
                # there's nothing to replay. Just terminate so the
                # frontend's pending query state resolves cleanly.
                asyncio.create_task(_emit_sim_query_done(cmd or "Q"))
        else:
            print(f"  [sim] unhandled serial line: {line}")
    except Exception as e:
        print(f"  [sim] error handling {line!r}: {e}")
        asyncio.create_task(_ack(f"error: {e}", ok=False))


async def _emit_sim_topology():
    """Mirror the real hub's $Q,TOPO reply: one topology message per
    sim_module, then query_done. Lets the frontend reconcile its
    _children + module.face from the sim's authoritative state."""
    for slot, mod in sorted(sim_modules.items()):
        if slot in sim_parents:
            parent_slot, parent_face = sim_parents[slot]
            parent = sim_modules.get(parent_slot)
            parent_uid = parent.uid if parent else None
            await broadcast({
                "type": "topology", "uid": mod.uid, "slot": slot,
                "parent_uid": parent_uid, "parent_is_hub": False,
                "parent_face": parent_face,
            })
        else:
            await broadcast({
                "type": "topology", "uid": mod.uid, "slot": slot,
                "parent_uid": None, "parent_is_hub": True,
                "parent_face": mod.face,
            })
    _consume_tracked_query_done("TOPO")
    await broadcast({"type": "query_done", "command": "TOPO"})
    print(f"  [sim] $Q,TOPO replied: {len(sim_modules)} rows + DONE")


async def _emit_sim_query_done(cmd: str):
    command = str(cmd or "").upper()
    _consume_tracked_query_done(command)
    await broadcast({"type": "query_done", "command": command})
    print(f"  [sim] $Q,{cmd} → DONE (no replay)")


async def _emit_sim_eca_snapshot():
    _consume_tracked_query_done("ECA")
    await broadcast({
        "type": "eca_status",
        "running": eca.is_running,
        "has_program": eca.has_program,
        "num_rules": eca.num_rules(),
        "num_vcs": eca.num_vcs(),
        "raw_len": sim_eca_raw_len,
        "nvs_stored": False,
    })
    if eca.has_program and sim_eca_b64:
        await broadcast({"type": "eca_bytecode", "base64": sim_eca_b64})
    await broadcast({"type": "query_done", "command": "ECA"})
    print(f"  [sim] $Q,ECA replied: {eca.num_rules()} rules + DONE")


async def sim_command_consumer():
    """Drain serial_write_queue in --sim modes. Without this, every
    $P/$PR/$A from the WS handler accumulates unread."""
    while True:
        cmd = await serial_write_queue.get()
        for line in cmd.splitlines():
            _parse_sim_command(line)


async def sim_add_module(mod_type: str):
    if mod_type not in SIM_MODULE_DEFS:
        print(f"  [sim] unknown type: {mod_type}")
        print(f"  [sim] available: {', '.join(SIM_MODULE_DEFS.keys())}")
        return
    defn = SIM_MODULE_DEFS[mod_type]
    slot = defn["slot"]
    if slot in sim_modules:
        print(f"  [sim] {mod_type} already connected (slot {slot})")
        return
    mod = SimModule(mod_type)
    sim_modules[slot] = mod
    modules[slot] = mod.mod_id
    await mod.send_hello()
    await asyncio.sleep(0.1)
    await mod.send_descriptor()
    hz_str = f"{mod.hz} Hz" if mod.hz > 0 else "actuator (no streaming)"
    print(f"  [sim] + {mod_type} connected → slot {slot}, face {mod.face}, {hz_str}")


async def sim_remove_module(slot: int):
    if slot not in sim_modules:
        print(f"  [sim] no module in slot {slot}")
        return
    # Auto-unstack if this module was a child of another
    if slot in sim_parents:
        await sim_unstack(slot)
    # Auto-unstack any children docked on this module
    for child_slot, (parent_slot, _pf) in list(sim_parents.items()):
        if parent_slot == slot:
            await sim_unstack(child_slot)
    mod = sim_modules.pop(slot)
    modules.pop(slot, None)
    module_types.pop(slot, None)
    # Clean up UID side-indexes + caches so a subsequent +type reuse starts
    # from a clean state.
    uid_by_slot.pop(slot, None)
    slot_by_uid.pop(mod.uid, None)
    modules_by_uid.pop(mod.uid, None)
    module_types_by_uid.pop(mod.uid, None)
    msg_cache_by_uid.pop(mod.uid, None)
    actuator_cache_by_uid.pop(mod.uid, None)
    # Send goodbye via status update + explicit $U-style unplug so the
    # frontend drops the module from its state.
    await broadcast({"type": "unplug", "uid": mod.uid, "slot": slot})
    await broadcast({"type": "status", "connected": True,
                      "modules": len(sim_modules)})
    print(f"  [sim] - {mod.mod_type} removed from slot {slot}")


def sim_print_status():
    if not sim_modules:
        print("  [sim] no modules connected")
        return
    print("  [sim] active modules:")
    for slot, mod in sorted(sim_modules.items()):
        hz_str = f"{mod.hz} Hz" if mod.hz > 0 else "actuator"
        stack_str = ""
        if slot in sim_parents:
            ps, pf = sim_parents[slot]
            stack_str = f"  ⬆ on slot {ps} F{pf}"
        print(f"    slot {slot}: {mod.mod_id} ({mod.mod_type}) "
              f"face={mod.face} {hz_str}{stack_str}")


def sim_print_help():
    print()
    print("  ╔══════════════════════════════════════════════╗")
    print("  ║  WearBlocks Simulator Commands               ║")
    print("  ╠══════════════════════════════════════════════╣")
    print("  ║  +imu   +hr   +temp   +led   +vib           ║")
    print("  ║     Connect a module                         ║")
    print("  ║  -1  -2  -3  -4  -5                         ║")
    print("  ║     Disconnect module by slot number         ║")
    print("  ║  stack hr on imu [F4]                        ║")
    print("  ║     Dock child onto parent face (default F4) ║")
    print("  ║  unstack hr   |  unstack 2                   ║")
    print("  ║     Remove stack link                        ║")
    print("  ║  spike imu ax 0.8 [dur_ms]                   ║")
    print("  ║     Inject a one-shot sensor spike (ECA test)║")
    print("  ║  demo    IMU+HR+Temp+LED+Vib, HR on IMU F4  ║")
    print("  ║  clear   Disconnect all modules              ║")
    print("  ║  status  Show active modules + stacks        ║")
    print("  ║  help    Show this help                      ║")
    print("  ║  quit    Exit simulator                      ║")
    print("  ╚══════════════════════════════════════════════╝")
    print()


async def sim_stdin_reader(cmd_queue: asyncio.Queue):
    """Read stdin in a thread, push commands to async queue."""
    loop = asyncio.get_event_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        await cmd_queue.put(line.strip())


async def sim_run_demo():
    """Load real hardware modules and stack light on IMU face 4."""
    for mt in ["imu", "light", "led", "vib", "audio"]:
        await sim_add_module(mt)
        await asyncio.sleep(0.3)
    imu_slot = _slot_for_type("imu")
    light_slot = _slot_for_type("light")
    if imu_slot is not None and light_slot is not None:
        await asyncio.sleep(0.2)
        await sim_stack(light_slot, imu_slot, parent_face=4)
    print("  [sim] demo: 5 real hardware modules, light stacked on IMU F4")


async def sim_clear_all():
    """Disconnect every module so a preset starts from a clean hub."""
    for s in list(sim_modules.keys()):
        await sim_remove_module(s)


async def sim_run_demo_d1():
    """Demo preset 1: adaptive night light.
    Hub starts empty; then a light sensor and an LED snap on. This preset
    exercises live-schema regrounding before a two-rule program runs."""
    await sim_clear_all()
    await asyncio.sleep(0.2)
    for mt in ["light", "led"]:
        await sim_add_module(mt)
        await asyncio.sleep(0.3)
    print("  [sim] D1: light + LED attached - adaptive night light")


async def sim_run_demo_d2():
    """Demo preset 2: light-driven theremin.
    Light sensor and audio module start attached. The preset exercises
    virtual-channel mapping and Blockly-level repair."""
    await sim_clear_all()
    await asyncio.sleep(0.2)
    for mt in ["light", "audio"]:
        await sim_add_module(mt)
        await asyncio.sleep(0.3)
    print("  [sim] D2: light + audio attached - light-driven theremin")


async def sim_run_demo_d3():
    """Demo preset 3: remote motion alert with IMU extension.
    Hub with LED and audio attached, plus an IMU representing a remote
    mount. The IMU's UID-keyed binding lets the rule survive relocation."""
    await sim_clear_all()
    await asyncio.sleep(0.2)
    for mt in ["led", "audio", "imu"]:
        await sim_add_module(mt)
        await asyncio.sleep(0.3)
    print("  [sim] D3: LED + audio + remote IMU - motion alert")


async def sim_command_handler(cmd_queue: asyncio.Queue):
    """Process commands from the stdin queue."""
    while True:
        cmd = await cmd_queue.get()
        if not cmd:
            continue

        if cmd.startswith("+"):
            mod_type = cmd[1:].strip().lower()
            await sim_add_module(mod_type)
        elif cmd.startswith("-") and not cmd.lower().startswith("-h"):
            try:
                slot = int(cmd[1:].strip())
                await sim_remove_module(slot)
            except ValueError:
                print(f"  [sim] usage: -<slot_number>  (e.g., -1)")
        elif cmd.lower().startswith("stack"):
            # stack <child> on <parent> [F<face>]   e.g. "stack hr on imu F2"
            tokens = cmd.split()
            if len(tokens) < 4 or tokens[2].lower() != "on":
                print("  [sim] usage: stack <child> on <parent> [F<face>]")
                continue
            child_slot  = _resolve_slot(tokens[1])
            parent_slot = _resolve_slot(tokens[3])
            face = 4  # default — opposite-of-P, the canonical outward R face
            if len(tokens) >= 5:
                f_tok = tokens[4].lower().lstrip("f")
                try:
                    face = int(f_tok)
                except ValueError:
                    print(f"  [sim] bad face token: {tokens[4]}")
                    continue
            if child_slot is None or parent_slot is None:
                print("  [sim] stack: unknown child or parent")
                continue
            await sim_stack(child_slot, parent_slot, face)
        elif cmd.lower().startswith("unstack"):
            tokens = cmd.split()
            if len(tokens) < 2:
                print("  [sim] usage: unstack <child_slot_or_type>")
                continue
            child_slot = _resolve_slot(tokens[1])
            if child_slot is None:
                print(f"  [sim] unstack: unknown target {tokens[1]}")
                continue
            await sim_unstack(child_slot)
        elif cmd == "demo":
            await sim_run_demo()
        elif cmd in ("demo1", "d1"):
            await sim_run_demo_d1()
        elif cmd in ("demo2", "d2"):
            await sim_run_demo_d2()
        elif cmd in ("demo3", "d3"):
            await sim_run_demo_d3()
        elif cmd.lower().startswith("spike"):
            # spike <module_or_slot> <channel> <value> [duration_ms]
            tokens = cmd.split()
            if len(tokens) < 4:
                print("  [sim] usage: spike <module_or_slot> <channel> <value> [duration_ms]")
                print("  [sim]   e.g. spike imu ax 0.8       # 50 ms default")
                print("  [sim]        spike 1 ax 0.8 200     # explicit duration")
                continue
            slot = _resolve_slot(tokens[1])
            if slot is None or slot not in sim_modules:
                print(f"  [sim] spike: unknown or empty slot/type: {tokens[1]}")
                continue
            mod = sim_modules[slot]
            ch_name = tokens[2].lower()
            ch_map = SIM_CHANNEL_MAP.get(mod.mod_type, {})
            if ch_name not in ch_map:
                print(f"  [sim] spike: '{ch_name}' not a channel of {mod.mod_type}; "
                      f"valid: {', '.join(ch_map.keys())}")
                continue
            try:
                value = float(tokens[3])
            except ValueError:
                print(f"  [sim] spike: bad value: {tokens[3]}")
                continue
            duration_ms = 50
            if len(tokens) >= 5:
                try:
                    duration_ms = int(tokens[4])
                except ValueError:
                    print(f"  [sim] spike: bad duration: {tokens[4]}")
                    continue
            ch_id = int(ch_map[ch_name])
            until = int(time.time() * 1000) + duration_ms
            mod.spikes[ch_id] = (value, until)
            print(f"  [sim] ⚡ spike slot={slot} {ch_name}={value} for {duration_ms}ms")
        elif cmd == "clear":
            slots = list(sim_modules.keys())
            for s in slots:
                await sim_remove_module(s)
            print("  [sim] all modules disconnected")
        elif cmd == "status":
            sim_print_status()
        elif cmd in ("help", "?", "h"):
            sim_print_help()
        elif cmd in ("quit", "exit", "q"):
            print("  [sim] shutting down...")
            sys.exit(0)
        else:
            print(f"  [sim] unknown command: {cmd}")
            print(f"  [sim] type 'help' for available commands")


async def sim_data_loop():
    """Main data generation loop — ticks each active sensor module, drives
    the ECA engine, and broadcasts auto-expired actuator state."""
    last_send: dict[int, float] = {}
    last_broadcast: dict[int, dict] = {}  # slot → last actuator snapshot we sent

    while True:
        now = time.time()
        now_ms = int(now * 1000)

        # 1. Emit sensor frames at each module's native rate.
        for slot, mod in list(sim_modules.items()):
            if mod.hz <= 0 or not mod.active:
                continue
            interval = 1.0 / mod.hz
            if now - last_send.get(slot, 0) >= interval:
                last_send[slot] = now
                await mod.send_sensor_tick()

        # 2. Tick the ECA engine. dispatch_action() will mutate sim_modules
        #    and queue actuator_state diffs we'll detect below.
        eca.tick(now_ms)

        # 3. Auto-expire actuator state and broadcast diffs.
        for slot, mod in list(sim_modules.items()):
            led_until = mod.led.get("until_ms", 0)
            if led_until and now_ms >= led_until:
                mod.led = {"r": 0, "g": 0, "b": 0, "brightness": 0,
                           "mode": "off", "until_ms": 0}
            vib_until = mod.vib.get("until_ms", 0)
            if vib_until and now_ms >= vib_until:
                mod.vib = {"intensity": 0, "mode": "off", "until_ms": 0}
            snapshot = {"led": dict(mod.led), "vib": dict(mod.vib)}
            if last_broadcast.get(slot) != snapshot:
                last_broadcast[slot] = snapshot
                await broadcast({"type": "actuator_state",
                                 "uid": mod.uid, "slot": slot,
                                 "led": snapshot["led"],
                                 "vib": snapshot["vib"]})

        await asyncio.sleep(0.005)  # 200 Hz tick resolution


async def sim_loop(auto_demo: bool = False):
    """Interactive multi-module simulator."""
    print()
    print("  ╔══════════════════════════════════════════════╗")
    print("  ║       WearBlocks Interactive Simulator        ║")
    print("  ╠════════════════════════════════════���═════════╣")
    print("  ║  Multi-module, hot-plug, realistic data      ║")
    print("  ║                                              ║")
    print("  ║  Quick start:                                ��")
    print("  ║    demo     → 5 modules, HR stacked on IMU   ║")
    print("  ║    +imu     → connect just an IMU            ║")
    print("  ║    stack hr on imu F4                        ║")
    print("  ║    help     → see all commands                ║")
    print("  ╚══════════════════════════════════════════════╝")
    print()
    if auto_demo:
        print("  [sim] --sim-demo: auto-loading demo (HR on IMU F4)...")
    else:
        print("  [sim] ready. type a command (or 'demo' to start):")
    print()

    cmd_queue: asyncio.Queue = asyncio.Queue()
    global sim_cmd_queue
    sim_cmd_queue = cmd_queue

    if auto_demo:
        async def _kick():
            await asyncio.sleep(0.4)
            await cmd_queue.put("demo")
        asyncio.create_task(_kick())

    # Run stdin reader, command handler, data loop, and (critically for
    # --sim) the queue consumer that routes WS $P/$A commands to the engine.
    await asyncio.gather(
        sim_stdin_reader(cmd_queue),
        sim_command_handler(cmd_queue),
        sim_data_loop(),
        sim_command_consumer(),
    )


# ── HTTP + main ──────────────────────────────────────────────────

def _load_env():
    """Load KEY=VALUE pairs into os.environ (no overwrite).
    Searches: frontend/bridge/.env, then project root .env."""
    candidates = [
        Path(__file__).parent / '.env',           # frontend/bridge/.env
        Path(__file__).parent.parent.parent / '.env',  # project root .env
    ]
    for env_path in candidates:
        if not env_path.exists():
            continue
        print(f"[bridge] loading env from {env_path}")
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())


CHANNEL_CATALOG_PATH = Path(__file__).resolve().parent.parent / "channel_catalog.json"


class WBHTTPHandler(SimpleHTTPRequestHandler):
    """Static file server + /api/chat streaming proxy to DeepSeek."""

    def log_message(self, fmt, *args):
        # Suppress per-request access logs to keep terminal readable.
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        # Stable URL for the shared channel catalog. Decoupled from the
        # on-disk filename so a future move (e.g. into a standalone schema
        # service) doesn't break the JS fetch — keep callers on /api/...
        if self.path == '/api/channel_catalog':
            try:
                payload = CHANNEL_CATALOG_PATH.read_bytes()
            except OSError as exc:
                self.send_error(500, f'channel_catalog unreadable: {exc}')
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        return super().do_GET()

    def do_POST(self):
        if self.path != '/api/chat':
            self.send_error(404, 'Not found')
            return
        try:
            import requests as _req
        except ImportError:
            self.send_error(500, 'requests not installed: pip install requests')
            return

        api_key = os.environ.get('DEEPSEEK_API_KEY', '')
        if not api_key:
            self.send_error(500, 'DEEPSEEK_API_KEY not set in bridge/.env')
            return

        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)

        try:
            resp = _req.post(
                'https://api.deepseek.com/v1/chat/completions',
                headers={
                    'Authorization': f'Bearer {api_key}',
                    'Content-Type': 'application/json',
                },
                data=body,
                stream=True,
                timeout=120,
            )
        except Exception as exc:
            self.send_error(502, f'DeepSeek request failed: {exc}')
            return

        self.send_response(resp.status_code)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            for chunk in resp.iter_content(chunk_size=None):
                if chunk:
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # client disconnected mid-stream


def start_http(directory: str):
    handler = partial(WBHTTPHandler, directory=directory)
    srv = HTTPServer(("0.0.0.0", HTTP_PORT), handler)
    print(f"[bridge] HTTP serving {directory} on :{HTTP_PORT}")
    srv.serve_forever()


async def _osc_stats_loop():
    """Push per-target sent/dropped/Hz to all WS clients at 1 Hz so the
    OSC panel can render live counters without hammering the bridge."""
    while True:
        await asyncio.sleep(1.0)
        stats = osc_forwarder.stats_snapshot()
        if stats:
            await broadcast({"type": "osc_stats", "stats": stats})


async def main():
    _load_env()
    ap = argparse.ArgumentParser(description="WearBlocks serial bridge")
    ap.add_argument("port", nargs="?", help="Serial port path")
    ap.add_argument("--mock", action="store_true", help="Single IMU fake data")
    ap.add_argument("--sim", action="store_true",
                    help="Interactive multi-module simulator")
    ap.add_argument("--sim-demo", dest="sim_demo", action="store_true",
                    help="Simulator mode, auto-run demo (HR stacked on IMU)")
    ap.add_argument("--ble", metavar="ADDRESS",
                    help="Connect to a BLE hub by MAC/UUID at startup. "
                         "If omitted, the bridge starts idle and waits for "
                         "the frontend to issue ble_scan/ble_connect.")
    ap.add_argument("--idle", action="store_true",
                    help="Start with no transport; UI controls connection.")
    ap.add_argument("--selftest", action="store_true",
                    help="Run parse_line self-test and exit")
    ap.add_argument("--log", metavar="PATH",
                    help="Append every RX/TX/EV/WS line to PATH for "
                         "post-mortem debugging (timestamped, line-flushed).")
    ap.add_argument("--osc-allow-remote", dest="osc_allow_remote",
                    action="store_true",
                    help="Allow OSC forwarding to non-loopback hosts. "
                         "Default policy is loopback-only because the bridge "
                         "WS listens on 0.0.0.0; without this flag the "
                         "forwarder cannot be turned into a UDP reflector.")
    args = ap.parse_args()
    if args.selftest:
        _parse_line_selftest()
        return
    have_port = bool(args.port)
    have_ble = bool(args.ble)
    have_idle = bool(args.idle)
    if not args.mock and not args.sim and not args.sim_demo \
       and not have_port and not have_ble and not have_idle:
        ap.error("provide a serial port, --ble ADDRESS, --idle, --mock, "
                 "--sim, --sim-demo, or --selftest")

    if args.log:
        global recorder
        recorder = LogRecorder(args.log)
        print(f"[bridge] logging to {args.log}")

    frontend_dir = str(Path(__file__).resolve().parent.parent)
    threading.Thread(target=start_http, args=(frontend_dir,), daemon=True).start()

    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        print(f"[bridge] WebSocket on :{WS_PORT}")
        osc_forwarder.allow_remote = bool(args.osc_allow_remote)
        if osc_forwarder.allow_remote:
            print("[bridge] OSC: --osc-allow-remote set; non-loopback targets allowed")
        await osc_forwarder.start()
        asyncio.create_task(_osc_stats_loop())
        if args.sim or args.sim_demo:
            await sim_loop(auto_demo=args.sim_demo)
        elif args.mock:
            await mock_loop()
        elif args.ble:
            # Seed the request queue so the supervisor connects immediately.
            await transport_request.put(("ble", args.ble, args.ble))
            await transport_supervisor(initial_port=None)
        elif args.idle:
            await transport_supervisor(initial_port=None)
        else:
            await serial_loop(args.port)

if __name__ == "__main__":
    asyncio.run(main())
