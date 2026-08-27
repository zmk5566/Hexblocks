# DRV8833 Serial PWM Test

Minimal two-motor bench test for the `motor_hub`. This sketch intentionally has
no BLE, CAN, face detection, car steering logic, heartbeat, or browser code.

## Wiring

| DRV8833 module | ESP32-C3 Super Mini |
|---|---|
| `IN1` | `GPIO1` |
| `IN2` | `GPIO2` |
| `IN3` | `GPIO3` |
| `IN4` | `GPIO4` |
| `GND` | Common GND |

`OUT1/OUT2` drive Motor 1 and `OUT3/OUT4` drive Motor 2. Supply the DRV8833
`VCC` from the motor supply in parallel with the Super Mini supply; do not route
motor current through the Super Mini. Keep all grounds connected.

## Serial Monitor

Flash `test_motor_pwm_serial.ino`, then open Arduino Serial Monitor with:

- Baud: `115200`
- Line ending: `Newline` or `Both NL & CR`

Alternatively, run the minimal serial CLI:

```bash
cd frontend/test_motor_pwm_serial
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python motor_pwm_cli.py
```

The CLI auto-detects a single `/dev/cu.usbmodem*` or
`/dev/cu.usbserial*` port. Pass a port path as its first argument when more than
one is connected. CLI shorthand: `120` controls both motors, `1 120` controls
Motor 1, `2 120` controls Motor 2, `s` stops, `p` prints status, and `q` sends
`STOP` before exiting.

Expected startup output:

```text
=== HexBlocks DRV8833 Serial PWM Test ===
PWM_ATTACH,GPIO1=ok,GPIO2=ok,GPIO3=ok,GPIO4=ok
STATUS,M1=0,M2=0,PWM=20000Hz,READY=yes
```

Commands:

```text
M1,120       Motor 1 forward at PWM 120/255
M1,-120      Motor 1 reverse at PWM 120/255
M2,120       Motor 2 forward at PWM 120/255
M2,-120      Motor 2 reverse at PWM 120/255
BOTH,120     Both motors at the same signed PWM
STOP         Stop both motors
STATUS       Print current commanded values
HELP         Print command help
```

## Test Order

Lift the wheels or disconnect the drivetrain before testing.

1. Send `STOP`.
2. Test Motor 1 at `M1,80`, `M1,120`, `M1,160`, and `M1,255`, stopping between values.
3. Send `STOP`, then repeat the same sequence with Motor 2.
4. Test reverse only after stopping: `M1,-160`, then `M2,-160`.
5. Send `STOP`, then test `BOTH,160`.

If both motors run at `255` but only one runs at a low value, the likely cause is
different motor starting thresholds rather than serial or PWM timing. If one
motor never runs, power off and swap the two motor output pairs:

- Failure follows the motor: inspect that motor, gearbox, and its wires.
- Failure stays on the same DRV8833 output pair: inspect that driver channel and
  its `IN1/IN2` or `IN3/IN4` wiring.
