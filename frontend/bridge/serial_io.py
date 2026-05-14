"""Serial port discovery + open-with-reconnect helpers.

Cross-platform port enumeration and a `wait_for_port` helper that polls
until a disconnected port reappears. Used by both `serial_bridge.py` and
`tools/wb_debug.py` so reconnect behaviour stays consistent.

Importing this module does not import pyserial — that's deferred to the
functions that actually need it, so callers without pyserial installed
can still use `find_ports()` / `auto_find()`.
"""
import glob
import sys
import time


RECONNECT_POLL_S = 0.5
DEFAULT_MAX_WAIT_S = 30


def find_ports() -> list[str]:
    """Return likely serial-port device paths for the current platform."""
    candidates: list[str] = []
    if sys.platform == "darwin":
        candidates += glob.glob("/dev/cu.usbserial*")
        candidates += glob.glob("/dev/cu.usbmodem*")
        candidates += glob.glob("/dev/cu.SLAB*")
        candidates += glob.glob("/dev/cu.wchusbserial*")
    elif sys.platform.startswith("linux"):
        candidates += glob.glob("/dev/ttyUSB*")
        candidates += glob.glob("/dev/ttyACM*")
    elif sys.platform.startswith("win"):
        candidates += [f"COM{i}" for i in range(1, 31)]
    return sorted(set(candidates))


def auto_find(hint: str) -> str | None:
    """Return the first port whose path contains `hint`, or None."""
    for p in find_ports():
        if hint in p:
            return p
    return None


def open_serial(port: str, baud: int, timeout: float = 0.2):
    """Try to open `port`; return the Serial object or None on failure.

    Imports pyserial lazily so non-serial callers don't need it.
    """
    import serial
    try:
        return serial.Serial(port, baud, timeout=timeout)
    except serial.SerialException:
        return None


def wait_for_port(port: str, baud: int, *,
                  on_poll=None,
                  max_wait: float = DEFAULT_MAX_WAIT_S,
                  poll_s: float = RECONNECT_POLL_S):
    """Poll until `port` reappears, then return an open Serial object.

    `on_poll`, if given, is called once per poll iteration with the
    elapsed seconds since the wait started. It may return True to abort
    the wait (e.g. user pressed q); in that case this returns None.

    Returns None if the port doesn't reappear within `max_wait` seconds
    or if `on_poll` requested abort.
    """
    t0 = time.time()
    while True:
        if on_poll is not None and on_poll(time.time() - t0):
            return None
        time.sleep(poll_s)
        ser = open_serial(port, baud)
        if ser is not None:
            return ser
        if time.time() - t0 > max_wait:
            return None
