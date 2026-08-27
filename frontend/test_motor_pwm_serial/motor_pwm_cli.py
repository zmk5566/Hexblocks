#!/usr/bin/env python3
"""Minimal serial console for the DRV8833 PWM test sketch."""

import glob
import sys
import time

import serial


def find_port():
    if len(sys.argv) > 1:
        return sys.argv[1]

    ports = sorted(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/cu.usbserial*"))
    if len(ports) == 1:
        return ports[0]
    if not ports:
        raise RuntimeError("no /dev/cu.usbmodem* or /dev/cu.usbserial* port found")
    raise RuntimeError("multiple serial ports found; pass one as the first argument")


def read_output(device, duration):
    deadline = time.monotonic() + duration
    data = bytearray()
    while time.monotonic() < deadline:
        waiting = device.in_waiting
        if waiting:
            data.extend(device.read(waiting))
            deadline = time.monotonic() + 0.05
        else:
            time.sleep(0.01)
    if data:
        print(data.decode("utf-8", errors="replace"), end="")


def send(device, command):
    device.write(f"{command}\n".encode("ascii"))
    device.flush()
    read_output(device, 0.2)


def expand(command):
    lower = command.lower()
    if lower in {"s", "stop"}:
        return "STOP"
    if lower in {"p", "status"}:
        return "STATUS"
    if lower in {"h", "help"}:
        return "HELP"

    parts = command.replace(",", " ").split()
    if len(parts) == 1:
        try:
            int(parts[0])
            return f"BOTH,{parts[0]}"
        except ValueError:
            return command
    if len(parts) == 2 and parts[0].lower() in {"1", "m1"}:
        return f"M1,{parts[1]}"
    if len(parts) == 2 and parts[0].lower() in {"2", "m2"}:
        return f"M2,{parts[1]}"
    if len(parts) == 2 and parts[0].lower() in {"b", "both"}:
        return f"BOTH,{parts[1]}"
    return command


def main():
    port = find_port()
    print(f"Opening {port} at 115200 baud")

    with serial.Serial(port, 115200, timeout=0, write_timeout=1) as device:
        read_output(device, 1.0)
        print("120=both | 1 120=motor1 | 2 120=motor2 | s=stop | p=status | q=quit")

        try:
            while True:
                command = input("motor> ").strip()
                if not command:
                    continue
                if command.lower() in {"q", "quit", "exit"}:
                    break
                send(device, expand(command))
        finally:
            send(device, "STOP")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, serial.SerialException) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
