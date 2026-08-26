#!/usr/bin/env python3
"""Interactive BLE controller for the HexBlocks two-motor test firmware."""

import argparse
import asyncio
import os
import sys
import termios
import tty
from contextlib import contextmanager


SERVICE_UUID = "6f8f0001-b5a3-f393-e0a9-e50e24dcca9e"
RX_UUID = "6f8f0002-b5a3-f393-e0a9-e50e24dcca9e"
TX_UUID = "6f8f0003-b5a3-f393-e0a9-e50e24dcca9e"
DEVICE_NAME = "HexMotorCar"

MIN_SPEED = 40
MAX_SPEED = 255
SPEED_STEP = 5


def clamp_speed(value):
    return max(MIN_SPEED, min(MAX_SPEED, value))


def motor_speeds(direction, speed):
    turn = max(45, round(speed * 0.72))
    if direction == "forward":
        return speed, speed
    if direction == "back":
        return -speed, -speed
    if direction == "left":
        return -turn, turn
    if direction == "right":
        return turn, -turn
    return 0, 0


def parse_args():
    parser = argparse.ArgumentParser(
        description="Control the HexMotorCar test firmware over BLE."
    )
    parser.add_argument(
        "--address",
        help="BLE address/identifier to connect directly (macOS uses a UUID).",
    )
    parser.add_argument(
        "--scan-timeout",
        type=float,
        default=8.0,
        help="BLE scan duration in seconds (default: 8).",
    )
    parser.add_argument(
        "--speed",
        type=int,
        default=150,
        help="Initial motor speed from 40 to 255 (default: 150).",
    )
    parser.add_argument(
        "--scan-only",
        action="store_true",
        help="Report matching advertisements without connecting.",
    )
    return parser.parse_args()


async def scan_for_car(timeout):
    try:
        from bleak import BleakScanner
    except ImportError as exc:
        raise RuntimeError(
            "bleak is not installed; run: python3 -m pip install -r requirements.txt"
        ) from exc

    print(f"[BLE] scanning for service {SERVICE_UUID} ({timeout:g}s)...")
    discovered = await BleakScanner.discover(timeout=timeout, return_adv=True)
    matches = []

    for device, advertisement in discovered.values():
        service_uuids = {
            uuid.lower() for uuid in (advertisement.service_uuids or [])
        }
        name = device.name or advertisement.local_name or ""
        if SERVICE_UUID not in service_uuids and name != DEVICE_NAME:
            continue
        rssi = getattr(advertisement, "rssi", -999)
        matches.append((rssi, device, name))

    matches.sort(key=lambda item: item[0], reverse=True)
    for rssi, device, name in matches:
        label = name or "<name missing>"
        print(f"[BLE] found {label} address={device.address} rssi={rssi} dBm")

    return matches


@contextmanager
def keyboard_input(queue):
    fd = sys.stdin.fileno()
    if not os.isatty(fd):
        raise RuntimeError("interactive control requires a terminal")

    loop = asyncio.get_running_loop()
    old_settings = termios.tcgetattr(fd)

    def on_input():
        data = os.read(fd, 32)
        for byte in data:
            queue.put_nowait(chr(byte))

    tty.setcbreak(fd)
    loop.add_reader(fd, on_input)
    try:
        yield
    finally:
        loop.remove_reader(fd)
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)


def print_controls(speed):
    print()
    print("Controls:")
    print("  W forward    S reverse    A left    D right")
    print("  Space coast stop    B brake    P status")
    print("  + / - speed         Q quit")
    print()
    print(f"[CTRL] speed={speed}")


async def run_controller(target, initial_speed):
    try:
        from bleak import BleakClient
    except ImportError as exc:
        raise RuntimeError(
            "bleak is not installed; run: python3 -m pip install -r requirements.txt"
        ) from exc

    disconnected = asyncio.Event()

    def on_disconnect(_client):
        print("\n[BLE] disconnected; firmware should stop both motors")
        disconnected.set()

    def on_notification(_characteristic, data):
        message = bytes(data).decode("utf-8", errors="replace").strip()
        if message:
            print(f"\n[CAR] {message}")

    print(f"[BLE] connecting to {getattr(target, 'address', target)}...")
    client = BleakClient(target, disconnected_callback=on_disconnect)
    key_queue = asyncio.Queue()
    speed = clamp_speed(initial_speed)
    active_direction = None

    async def send(command):
        await client.write_gatt_char(
            RX_UUID, f"{command}\n".encode("ascii"), response=False
        )
        print(f"[SEND] {command}")

    try:
        await client.connect()
        print("[BLE] connected")
        await client.start_notify(TX_UUID, on_notification)
        await send("P")
        print_controls(speed)

        with keyboard_input(key_queue):
            while client.is_connected and not disconnected.is_set():
                key_task = asyncio.create_task(key_queue.get())
                disconnect_task = asyncio.create_task(disconnected.wait())
                done, pending = await asyncio.wait(
                    (key_task, disconnect_task),
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                if disconnect_task in done:
                    break

                key = key_task.result().lower()
                if key in ("q", "\x03"):
                    break
                if key == "w":
                    active_direction = "forward"
                elif key == "s":
                    active_direction = "back"
                elif key == "a":
                    active_direction = "left"
                elif key == "d":
                    active_direction = "right"
                elif key == " ":
                    active_direction = None
                    await send("S")
                    continue
                elif key == "b":
                    active_direction = None
                    await send("B")
                    continue
                elif key == "p":
                    await send("P")
                    continue
                elif key in ("+", "="):
                    speed = clamp_speed(speed + SPEED_STEP)
                    print(f"[CTRL] speed={speed}")
                elif key in ("-", "_"):
                    speed = clamp_speed(speed - SPEED_STEP)
                    print(f"[CTRL] speed={speed}")
                else:
                    continue

                if active_direction:
                    left, right = motor_speeds(active_direction, speed)
                    await send(f"D,{left},{right}")
    finally:
        if client.is_connected:
            try:
                await send("S")
                await asyncio.sleep(0.05)
            except Exception as exc:
                print(f"[BLE] final stop failed: {exc}", file=sys.stderr)
            try:
                await client.disconnect()
            except Exception as exc:
                print(f"[BLE] disconnect failed: {exc}", file=sys.stderr)

    print("[CTRL] stopped")


async def async_main(args):
    speed = clamp_speed(args.speed)
    if speed != args.speed:
        print(f"[CTRL] clamped initial speed to {speed}")

    if args.address:
        if args.scan_only:
            print("--scan-only cannot be combined with --address", file=sys.stderr)
            return 2
        target = args.address
    else:
        matches = await scan_for_car(max(0.1, args.scan_timeout))
        if not matches:
            print("[BLE] HexMotorCar service not found", file=sys.stderr)
            return 1
        if args.scan_only:
            return 0
        target = matches[0][1]

    await run_controller(target, speed)
    return 0


def main():
    args = parse_args()
    try:
        return asyncio.run(async_main(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
