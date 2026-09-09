#!/usr/bin/env python3
"""Compile, inspect, and upload WearBlocks AudioPatch V1 profiles."""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time

BRIDGE_DIR = pathlib.Path(__file__).resolve().parents[1] / "bridge"
sys.path.insert(0, str(BRIDGE_DIR))

from audio_patch import decode_patch, encode_patch, hub_command  # noqa: E402


def read_json(path: pathlib.Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("top-level patch JSON must be an object")
    return value


def compile_payload(path: pathlib.Path, config_rev: int | None) -> bytes:
    return encode_patch(read_json(path), config_rev=config_rev)


def print_summary(payload: bytes) -> None:
    print(json.dumps(decode_patch(payload), indent=2, ensure_ascii=False))


def command_compile(args: argparse.Namespace) -> int:
    payload = compile_payload(args.input, args.config_rev)
    if args.output:
        args.output.write_bytes(payload)
        print(f"wrote {len(payload)} bytes: {args.output}")
    print_summary(payload)
    if args.uid:
        print(f"hub_command: {hub_command(payload, args.uid)}")
    return 0


def command_inspect(args: argparse.Namespace) -> int:
    print_summary(args.input.read_bytes())
    return 0


def command_upload(args: argparse.Namespace) -> int:
    try:
        import serial
    except ImportError:
        print("upload requires pyserial (pip install -r frontend/bridge/requirements.txt)",
              file=sys.stderr)
        return 2

    payload = compile_payload(args.input, args.config_rev)
    command = hub_command(payload, args.uid)
    expected_rev = decode_patch(payload)["config_rev"]
    with serial.Serial(args.port, args.baud, timeout=0.1) as connection:
        connection.reset_input_buffer()
        connection.write((command + "\n").encode("ascii"))
        connection.flush()
        print(f"sent {len(payload)} bytes to {args.uid.upper()}; waiting for module ACK")
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            raw = connection.readline()
            if not raw:
                continue
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            print(line)
            if line.startswith("$ERR AP"):
                return 2
            if line.startswith("$AP,ACK,"):
                parts = line.split(",")
                if len(parts) == 5:
                    status = int(parts[3])
                    revision = int(parts[4])
                    if revision != expected_rev:
                        print("received ACK for a different patch revision", file=sys.stderr)
                        continue
                    return 0 if status == 0 else 2
        print("timed out waiting for $AP,ACK", file=sys.stderr)
        return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    compile_parser = subparsers.add_parser("compile", help="compile JSON to WBAP")
    compile_parser.add_argument("input", type=pathlib.Path)
    compile_parser.add_argument("--output", type=pathlib.Path)
    compile_parser.add_argument("--uid", help="print a UID-addressed Hub command")
    compile_parser.add_argument("--config-rev", type=int,
                                help="override JSON revision (default: current time)")
    compile_parser.set_defaults(func=command_compile)

    inspect_parser = subparsers.add_parser("inspect", help="decode a WBAP file")
    inspect_parser.add_argument("input", type=pathlib.Path)
    inspect_parser.set_defaults(func=command_inspect)

    upload_parser = subparsers.add_parser("upload", help="send JSON through Hub serial")
    upload_parser.add_argument("input", type=pathlib.Path)
    upload_parser.add_argument("--uid", required=True)
    upload_parser.add_argument("--port", required=True)
    upload_parser.add_argument("--baud", type=int, default=115200)
    upload_parser.add_argument("--timeout", type=float, default=5.0)
    upload_parser.add_argument("--config-rev", type=int,
                               help="override JSON revision (default: current time)")
    upload_parser.set_defaults(func=command_upload)
    return parser


def main() -> int:
    try:
        args = build_parser().parse_args()
        return args.func(args)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
