#!/usr/bin/env python3
"""
wb_debug.py — high-signal debug monitor for the WearBlocks hub (v2 protocol).

Renders a colored event timeline + a 6-cell hub-face bar, suppresses the
high-rate $S sensor stream (counted as a rate), and lets you trigger
$Q,STATUS / $Q,TOPO and ECA controls with single keypresses.

Two source modes — pick exactly one:
  --port /dev/cu.usbmodemXXX     direct serial (parses v2 hub lines).
                                  Bridge MUST NOT be holding the port.
  --ws ws://localhost:8765       WebSocket client to a running bridge.
                                  NOTE: WS mode still speaks the v1 event
                                  vocabulary (slot-based) until the M5
                                  bridge refactor lands. Use --port for
                                  v2 firmware testing.

Keys (both modes):
  t   $Q,TOPO          dump topology tree
  s   $Q,STATUS        replay registered modules
  r   $PR              run loaded ECA program
  p   $PS              stop ECA program
  c   $PC              clear ECA program
  q   quit

Usage examples:
  python3 wb_debug.py --port /dev/cu.usbserial-11201
  python3 wb_debug.py --ws ws://localhost:8765
  python3 wb_debug.py --list
  python3 wb_debug.py --port auto --hint 11201

Requires: pyserial (--port), websockets (--ws).
"""

import argparse
import asyncio
import json
import os
import select
import sys
import termios
import time
import tty

# Pull in the shared parser + serial helpers from the bridge package so
# the wire-format and reconnect logic only live in one place.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "bridge"))
from wb_protocol import parse_line as parse_wire  # noqa: E402
import serial_io  # noqa: E402


# ── ANSI colors ────────────────────────────────────────────────
class C:
    RESET = "\033[0m"
    DIM = "\033[2m"
    BOLD = "\033[1m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"


# ── Port discovery ─────────────────────────────────────────────
# Delegate to serial_io so behaviour matches serial_bridge.py.
find_ports = serial_io.find_ports
auto_find = serial_io.auto_find


# ── State (v2: UID-keyed) ──────────────────────────────────────
class State:
    def __init__(self):
        self.faces = ["?"] * 6              # "○"/"●"/"?" per hub face
        self.face_uid = [None] * 6          # uid hex at hub.F1..F6 or None
        # modules: uid_hex -> {"id": str, "parent": "HUB"|uid, "pface": int,
        #                      "detached": bool, "since": float}
        self.modules = {}
        self.s_count = 0
        self.last_summary = time.time()
        self.start = time.time()


def now_str(state):
    elapsed = time.time() - state.start
    h = int(elapsed // 3600)
    m = int((elapsed % 3600) // 60)
    s = elapsed % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"


def short_uid(uid):
    return uid[-4:] if uid and len(uid) >= 4 else uid


def render_face_bar(state):
    cells = []
    for i, f in enumerate(state.faces):
        sym = {"○": C.DIM + "○" + C.RESET,
               "●": C.GREEN + "●" + C.RESET,
               "?": C.YELLOW + "?" + C.RESET}[f]
        uid = state.face_uid[i]
        if uid:
            cells.append(f"F{i+1}[{sym}→{short_uid(uid)}]")
        else:
            cells.append(f"F{i+1}[{sym}]")
    return " ".join(cells)


def print_summary(state):
    bar = render_face_bar(state)
    parts = []
    for uid, m in sorted(state.modules.items()):
        tag = f"{C.YELLOW}[detached]{C.RESET}" if m.get("detached") else ""
        label = m.get("id") or "(no-desc)"
        parent = m.get("parent", "?")
        if parent != "HUB":
            parent = short_uid(parent)
        parts.append(f"{short_uid(uid)}={label}@{parent}.F{m.get('pface','?')}{tag}")
    mods = ", ".join(parts) if parts else (C.DIM + "(none)" + C.RESET)
    print(f"{C.BOLD}{C.CYAN}━━━ STATE @ {now_str(state)} ━━━{C.RESET}")
    print(f"  {bar}")
    print(f"  modules: {mods}")
    if state.s_count > 0:
        elapsed = time.time() - state.last_summary
        rate = state.s_count / elapsed if elapsed > 0 else 0
        print(f"  $S rate: {C.DIM}{rate:.1f} samples/s{C.RESET}")
    print()


# ── Regex (hub stderr, not v2 wire) ────────────────────────────
# These three match informational hub log lines, not the $-prefixed wire
# protocol — that is handled by `wb_protocol.parse_line`. We still need
# `re` here, so import it lazily-late instead of up top.
import re  # noqa: E402

RE_FACE_OCC   = re.compile(r"\[FACE\]\s+F(\d+)\s+occupied")
RE_FACE_EMPTY = re.compile(r"\[FACE\]\s+F(\d+)\s+empty")
RE_INITIAL    = re.compile(r"\s*F(\d+)\s+initial:\s*(OCCUPIED|empty)")


def update_face_index(state, uid, parent, pface):
    """Maintain state.face_uid[] from a module's (parent, pface) binding."""
    # Clear any previous occupancy for this uid.
    for i in range(6):
        if state.face_uid[i] == uid:
            state.face_uid[i] = None
    if parent == "HUB" and 1 <= pface <= 6:
        state.face_uid[pface - 1] = uid


def _parent_label(parent_uid, is_hub):
    """Render a parent token for display: 'HUB', the uid, or '?' (orphan)."""
    if is_hub:
        return "HUB"
    return parent_uid or "?"


def _render_event(msg, state, ts, mutate_state):
    """Render one canonical wb_protocol event. Mirrors the original
    handle_line output for parity with previous wb_debug.py runs."""
    mtype = msg["type"]

    if mtype == "sensor":
        # High-rate $S — count only, no print.
        state.s_count += 1
        return

    if mtype == "hello":
        uid = msg["uid"]
        mid = msg["id"]
        parent = _parent_label(msg["parent_uid"], msg["parent_is_hub"])
        pface = msg["parent_face"]
        if mutate_state:
            mod = state.modules.get(uid, {})
            mod.update({"id": mid or mod.get("id", ""),
                        "parent": parent, "pface": pface,
                        "detached": False, "since": time.time()})
            state.modules[uid] = mod
            update_face_index(state, uid, parent, pface)
        label = mid or "(no-desc)"
        print(f"{C.DIM}[{ts}]{C.RESET} {C.GREEN}$H{C.RESET} "
              f"uid={C.BOLD}{uid}{C.RESET} id={label} "
              f"parent={parent}.F{pface}")
        if mutate_state:
            print_summary(state)
        return

    if mtype == "descriptor":
        uid = msg["uid"]
        desc = msg["data"]
        name = (desc.get("name") or desc.get("nm")
                or desc.get("moduleId") or desc.get("id") or "?")
        if mutate_state and uid in state.modules:
            mod_id = (desc.get("moduleId") or desc.get("id")
                      or state.modules[uid].get("id", ""))
            state.modules[uid]["id"] = mod_id
        print(f"{C.DIM}[{ts}]{C.RESET} {C.DIM}$D uid={uid} name={name}{C.RESET}")
        return

    if mtype == "module_info":
        uid = msg["uid"]
        mid = msg.get("id") or "(no-desc)"
        ver = msg.get("version") or "?"
        fw_hash = msg.get("fw_hash") or "????"
        if mutate_state and uid in state.modules and msg.get("id"):
            state.modules[uid]["id"] = msg["id"]
        print(f"{C.DIM}[{ts}]{C.RESET} {C.CYAN}$I{C.RESET} "
              f"uid={C.BOLD}{uid}{C.RESET} id={mid} "
              f"ver={ver} fwHash={fw_hash}")
        return

    if mtype == "detach_pending":
        uid = msg["uid"]
        if mutate_state and uid in state.modules:
            state.modules[uid]["detached"] = True
            state.modules[uid]["since"] = time.time()
            for i in range(6):
                if state.face_uid[i] == uid:
                    state.face_uid[i] = None
        print(f"{C.DIM}[{ts}]{C.RESET} {C.YELLOW}$X uid={uid} (detached, 8s TTL){C.RESET}")
        if mutate_state:
            print_summary(state)
        return

    if mtype == "unplug":
        uid = msg["uid"]
        if mutate_state:
            state.modules.pop(uid, None)
            for i in range(6):
                if state.face_uid[i] == uid:
                    state.face_uid[i] = None
        print(f"{C.DIM}[{ts}]{C.RESET} {C.BOLD}{C.RED}✕ $U uid={uid}{C.RESET}")
        if mutate_state:
            print_summary(state)
        return

    if mtype == "face_swap":
        uid = msg["uid"]
        op = _parent_label(msg["old_parent_uid"], msg["old_parent_is_hub"])
        of = msg["old_face"]
        np = _parent_label(msg["new_parent_uid"], msg["new_parent_is_hub"])
        nf = msg["new_face"]
        if mutate_state and uid in state.modules:
            state.modules[uid].update({"parent": np, "pface": nf,
                                        "detached": False})
            update_face_index(state, uid, np, nf)
        print(f"{C.DIM}[{ts}]{C.RESET} {C.BOLD}{C.MAGENTA}↔ $F{C.RESET} "
              f"uid={uid} {op}.F{of} → {np}.F{nf}")
        if mutate_state:
            print_summary(state)
        return

    if mtype == "child_stack":
        parent = msg["parent_uid"]
        child = msg["child_uid"] or "PENDING"
        pface = msg["parent_face"]
        print(f"{C.DIM}[{ts}]{C.RESET} {C.BOLD}{C.MAGENTA}⬆ $C{C.RESET} "
              f"child={child} on {short_uid(parent)}.F{pface}")
        return

    if mtype == "child_unstack":
        parent = msg["parent_uid"]
        child = msg["child_uid"] or "PENDING"
        pface = msg["parent_face"]
        print(f"{C.DIM}[{ts}]{C.RESET} {C.MAGENTA}⬇ $c child={child} from "
              f"{short_uid(parent)}.F{pface}{C.RESET}")
        return

    if mtype == "topology":
        uid = msg["uid"]
        parent = _parent_label(msg["parent_uid"], msg["parent_is_hub"])
        pface = msg["parent_face"]
        print(f"{C.CYAN}  $T uid={uid} parent={parent}.F{pface}{C.RESET}")
        return

    if mtype == "query_done":
        print(f"{C.DIM}[{ts}] $Q DONE{C.RESET}")
        return

    if mtype == "command_ack":
        if msg["status"] == "ok":
            print(f"{C.DIM}[{ts}]{C.RESET} {C.DIM}$OK {msg['text']}{C.RESET}")
        else:
            print(f"{C.DIM}[{ts}]{C.RESET} {C.BOLD}{C.RED}$ERR {msg['text']}{C.RESET}")
        return


def handle_line(line, state, raw=False, mutate_state=True):
    """Parse one raw v2 hub line, render a colored event."""
    line = line.rstrip("\r\n")
    if not line:
        return
    ts = now_str(state)

    # Wire-format events go through the shared parser.
    msg = parse_wire(line)
    if msg is not None:
        _render_event(msg, state, ts, mutate_state)
        return

    # Hub face GPIO transitions — informational, also a sanity check.
    m = RE_FACE_OCC.match(line)
    if m:
        fnum = int(m.group(1))
        if mutate_state and 1 <= fnum <= 6:
            state.faces[fnum - 1] = "●"
        print(f"{C.DIM}[{ts}]{C.RESET} {C.GREEN}● FACE F{fnum} OCCUPIED{C.RESET}")
        return

    m = RE_FACE_EMPTY.match(line)
    if m:
        fnum = int(m.group(1))
        if mutate_state and 1 <= fnum <= 6:
            state.faces[fnum - 1] = "○"
            state.face_uid[fnum - 1] = None
        print(f"{C.DIM}[{ts}]{C.RESET} {C.YELLOW}○ FACE F{fnum} EMPTY{C.RESET}")
        return

    m = RE_INITIAL.match(line)
    if m:
        fnum = int(m.group(1))
        occ = m.group(2) == "OCCUPIED"
        if mutate_state and 1 <= fnum <= 6:
            state.faces[fnum - 1] = "●" if occ else "○"
        print(f"{C.DIM}[{ts}]{C.RESET} {line}")
        return

    # Errors loud.
    if "FAIL" in line or "ERROR" in line:
        print(f"{C.DIM}[{ts}]{C.RESET} {C.BOLD}{C.RED}{line}{C.RESET}")
        return

    # Quiet logs from hub (registry, descriptor, attach queue, ECA, OK).
    if any(k in line for k in ("[REG]", "[DESC]", "[STATS]", "[CMD]", "[ECA]",
                                "[OK]", "[ATT]", "[HELLO]", "[WB-PROTO]",
                                "[ACK]")):
        print(f"{C.DIM}[{ts}]{C.RESET} {C.DIM}{line}{C.RESET}")
        return

    if raw:
        print(f"{C.DIM}[{ts}] {line}{C.RESET}")


def periodic_sample_rate(state, interval=2.0):
    elapsed = time.time() - state.last_summary
    if elapsed >= interval and state.s_count > 0:
        rate = state.s_count / elapsed
        print(f"{C.DIM}[{now_str(state)}] $S rate: {rate:.1f} samples/s "
              f"({state.s_count} in {elapsed:.1f}s){C.RESET}")
        state.s_count = 0
        state.last_summary = time.time()


# ── WebSocket event dispatcher (v1 vocab — stale until M5) ────
def handle_ws_event(msg, state, raw=False):
    """Render a JSON event from the bridge.

    The bridge still emits v1 slot-based events. This handler is kept for
    backward compatibility while M5 (frontend UID refactor) is pending —
    treat the rendered slot/face values as legacy and prefer --port.
    """
    ts = now_str(state)
    mtype = msg.get("type")

    if mtype == "log":
        # Forward raw hub line through the v2 parser; bridge passes the
        # original $-line untouched in `line`.
        handle_line(msg.get("line", ""), state, raw=raw, mutate_state=True)
        return

    if mtype == "sensor":
        state.s_count += 1
        return

    if mtype == "command_ack":
        status = msg.get("status", "ok")
        text = msg.get("text", "")
        col = C.GREEN if status == "ok" else C.RED
        tag = "$OK" if status == "ok" else "$ERR"
        print(f"{C.DIM}[{ts}]{C.RESET} {C.BOLD}{col}{tag}{C.RESET} {text}")
        return

    if mtype == "query_done":
        print(f"{C.DIM}[{ts}] $Q DONE{C.RESET}")
        return

    if mtype == "status":
        return

    # Anything else is a v1-vocab event that the bridge may still emit.
    # Print verbatim as a hint that M5 hasn't landed.
    if raw or mtype not in {"hello", "descriptor", "module_info",
                             "detach_pending",
                             "face_swap", "unplug", "child_stack",
                             "child_unstack"}:
        print(f"{C.DIM}[{ts}] [ws-v1] {json.dumps(msg)}{C.RESET}")


# ── Stdin keypress (cbreak) ────────────────────────────────────
def setup_stdin_cbreak():
    fd = sys.stdin.fileno()
    if not os.isatty(fd):
        return None, None
    old = termios.tcgetattr(fd)
    tty.setcbreak(fd)
    return fd, old


def restore_stdin(fd, old):
    if old is not None:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


KEY_TO_SERIAL_CMD = {
    "t": "$Q,TOPO",
    "s": "$Q,STATUS",
    "r": "$PR",
    "p": "$PS",
    "c": "$PC",
}

KEY_TO_WS_ACTION = {
    "t": {"action": "query", "command": "TOPO"},
    "s": {"action": "query", "command": "STATUS"},
    "r": {"action": "program_run"},
    "p": {"action": "program_stop"},
    "c": {"action": "program_clear"},
}


# ── Direct-serial loop ─────────────────────────────────────────
RECONNECT_POLL_S = serial_io.RECONNECT_POLL_S
MAX_RECONNECT_WAIT_S = serial_io.DEFAULT_MAX_WAIT_S


def _wait_for_port_with_keypress(port, baud, fd, state):
    """Wrap serial_io.wait_for_port with a keypress poll so q/Ctrl-C
    aborts the wait. Returns the reopened Serial or None on quit/timeout."""
    def on_poll(elapsed):
        if fd is None:
            return False
        ready, _, _ = select.select([fd], [], [], 0)
        if ready:
            ch = os.read(fd, 1).decode("utf-8", errors="replace")
            if ch in ("q", "\x03"):
                return True
        return False

    ser = serial_io.wait_for_port(port, baud,
                                  on_poll=on_poll,
                                  max_wait=MAX_RECONNECT_WAIT_S,
                                  poll_s=RECONNECT_POLL_S)
    if ser is None:
        # Distinguish quit from timeout by checking elapsed.
        # The user-visible message is the same; keep the timeout note.
        print(f"{C.RED}Port {port} did not reappear after "
              f"{MAX_RECONNECT_WAIT_S}s — giving up "
              f"(or you pressed q).{C.RESET}")
    return ser


def run_serial(port, baud, raw):
    try:
        import serial
    except ImportError:
        print("ERROR: pyserial not installed. Run: pip install pyserial",
              file=sys.stderr)
        sys.exit(1)

    ser = serial_io.open_serial(port, baud)
    if ser is None:
        print(f"{C.RED}Failed to open {port}{C.RESET}", file=sys.stderr)
        sys.exit(1)

    print(f"{C.BOLD}{C.CYAN}━━━ wb_debug v2 — serial {port} @ {baud} ━━━{C.RESET}")
    print(f"{C.DIM}Keys:  t=topo  s=status  r=run  p=stop  c=clear  q=quit{C.RESET}\n")

    state = State()
    buf = b""
    fd, old = setup_stdin_cbreak()

    def send(cmd):
        try:
            ser.write((cmd + "\n").encode())
            print(f"{C.DIM}[{now_str(state)}] → sent: {cmd}{C.RESET}")
        except serial.SerialException:
            print(f"{C.YELLOW}[{now_str(state)}] send failed (port down){C.RESET}")

    try:
        while True:
            read_fds = [ser.fd] if hasattr(ser, "fd") else []
            if fd is not None:
                read_fds.append(fd)
            try:
                ready, _, _ = select.select(read_fds, [], [], 0.2)
            except (OSError, ValueError):
                ready = []

            if fd is not None and fd in ready:
                ch = os.read(fd, 1).decode("utf-8", errors="replace")
                if ch in ("q", "\x03"):
                    break
                cmd = KEY_TO_SERIAL_CMD.get(ch)
                if cmd:
                    send(cmd)

            try:
                chunk = ser.read(256)
            except (serial.SerialException, OSError):
                print(f"\n{C.BOLD}{C.YELLOW}⚡ Serial dropped — "
                      f"reconnecting to {port} …{C.RESET}")
                try:
                    ser.close()
                except Exception:
                    pass
                buf = b""
                ser = _wait_for_port_with_keypress(port, baud, fd, state)
                if ser is None:
                    break
                print(f"{C.BOLD}{C.GREEN}✓ Reconnected to {port}{C.RESET}\n")
                print_summary(state)
                continue

            if chunk:
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    handle_line(line.decode("utf-8", errors="replace"),
                                state, raw=raw)
            periodic_sample_rate(state)
    except KeyboardInterrupt:
        pass
    finally:
        restore_stdin(fd, old)
        ser.close()
        print(f"\n{C.DIM}— stopped —{C.RESET}")


# ── WebSocket loop ─────────────────────────────────────────────
async def run_ws(url, raw):
    try:
        import websockets
    except ImportError:
        print("ERROR: websockets not installed. Run: pip install websockets",
              file=sys.stderr)
        sys.exit(1)

    print(f"{C.BOLD}{C.CYAN}━━━ wb_debug v2 — ws {url} ━━━{C.RESET}")
    print(f"{C.YELLOW}Note: bridge still emits v1 slot-based events. Use --port "
          f"for clean v2 testing until M5 lands.{C.RESET}")
    print(f"{C.DIM}Keys:  t=topo  s=status  r=run  p=stop  c=clear  q=quit{C.RESET}\n")

    state = State()
    fd, old = setup_stdin_cbreak()
    loop = asyncio.get_event_loop()
    quit_evt = asyncio.Event()

    try:
        async with websockets.connect(url) as ws:
            print(f"{C.DIM}[{now_str(state)}] connected to {url}{C.RESET}")

            async def reader():
                async for raw_msg in ws:
                    try:
                        msg = json.loads(raw_msg)
                    except json.JSONDecodeError:
                        continue
                    handle_ws_event(msg, state, raw=raw)

            async def keypress():
                if fd is None:
                    return
                while not quit_evt.is_set():
                    ready = await loop.run_in_executor(
                        None, lambda: select.select([fd], [], [], 0.2)[0])
                    if not ready:
                        periodic_sample_rate(state)
                        continue
                    ch = os.read(fd, 1).decode("utf-8", errors="replace")
                    if ch in ("q", "\x03"):
                        quit_evt.set()
                        return
                    action = KEY_TO_WS_ACTION.get(ch)
                    if action:
                        await ws.send(json.dumps(action))
                        print(f"{C.DIM}[{now_str(state)}] → sent: {action}{C.RESET}")

            reader_task = asyncio.create_task(reader())
            key_task = asyncio.create_task(keypress())
            wait_task = asyncio.create_task(quit_evt.wait())

            done, pending = await asyncio.wait(
                {reader_task, key_task, wait_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"{C.RED}WebSocket error: {e}{C.RESET}", file=sys.stderr)
    finally:
        restore_stdin(fd, old)
        print(f"\n{C.DIM}— stopped —{C.RESET}")


# ── Main ───────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--port", help="Direct-serial mode. 'auto' = first match for --hint.")
    src.add_argument("--ws", help="WebSocket bridge mode (e.g. ws://localhost:8765)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--raw", action="store_true",
                    help="Don't filter — print every line / event")
    ap.add_argument("--list", action="store_true",
                    help="List available serial ports and exit")
    ap.add_argument("--hint", default="11201",
                    help="Substring used by --port auto (default: 11201)")
    args = ap.parse_args()

    if args.list:
        for p in find_ports() or ["(no serial ports found)"]:
            print(p)
        return

    if args.ws:
        asyncio.run(run_ws(args.ws, args.raw))
        return

    port = args.port
    if port == "auto" or not port:
        port = auto_find(args.hint)
        if not port:
            print(f"{C.RED}Couldn't auto-find a port containing '{args.hint}'.{C.RESET}",
                  file=sys.stderr)
            print("Available ports:", file=sys.stderr)
            for p in find_ports():
                print(f"  {p}", file=sys.stderr)
            print("Pick one with --port <path>, or use --ws <url>.", file=sys.stderr)
            sys.exit(1)
    run_serial(port, args.baud, args.raw)


if __name__ == "__main__":
    main()
