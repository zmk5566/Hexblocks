# Dual Motor Module and Motor Hub Design

## Goal

Support the same independently controlled two-motor actuator in two hardware forms:

1. An external CAN actuator module that connects to any WearBlocks hub.
2. A standalone motor-hub that provides the normal hub runtime and drives its two onboard motors locally.

The existing non-motor hub remains a separate firmware target and does not acquire onboard motor hardware behavior.

## Hardware Roles

### Standard Hub

`hardware/firmware/hub/` remains the six-face WearBlocks hub. It provides USB, BLE, CAN module enumeration, topology management, ECA execution, and NVS persistence. It has no onboard motor actuator.

### External Motor Module

`hardware/firmware/module_motor/` remains a normal CAN actuator module. It registers with a hub, publishes a `dual_motor` actuator descriptor, receives `MOTOR_SET` over CAN, and controls its own M1 and M2 outputs independently.

### Motor Hub

`hardware/firmware/motor_hub/` is a separate firmware target for the ESP32-C3FH4 + DRV8410 motor board. It provides:

- direct USB serial and BLE Nordic UART Service connectivity;
- Blockly bytecode upload and ECA execution;
- NVS program persistence;
- CAN enumeration and control of external WearBlocks modules;
- one external module face, detected on GPIO5 and represented as Hub Face 1;
- a built-in dual-motor actuator executed locally.

The motor-hub pin assignments are:

| Function | GPIO |
|---|---:|
| Motor 1 IN1 / IN2 | 0 / 1 |
| Motor 2 IN1 / IN2 | 3 / 4 |
| External Face 1 presence | 5 |
| CAN RX / TX | 6 / 7 |
| DRV8410 nSLEEP | 10 |

`nFAULT` is outside this initial protocol test scope.

## Frontend Model

Both motor forms expose the same `dual_motor` actuator capability and use the same Blockly block. The module dropdown distinguishes targets by stable UID and display name:

- `Built-in Dual Motor` for the motor-hub's local actuator;
- `Dual DC Motor` for each external motor module.

The built-in actuator is advertised as a local device associated with the motor-hub. It does not consume Face 1 or a CAN module slot. Face 1 remains available for a physical external module.

A motor-hub may therefore control its two onboard motors and one or more external motor modules from the same Blockly workspace.

## Control Protocol

Both forms use action command `MOTOR_SET = 64` with four ECA parameters:

| Parameter | Values |
|---|---|
| motor | `1` or `2` |
| mode | `0` stop, `1` forward, `2` reverse |
| speed | `0..255` PWM duty |
| duration_ms | `0..65535`; `0` means continuous |

The packed actuator payload is:

```text
[motor, mode, speed, duration_hi, duration_lo]
```

M1 and M2 maintain separate mode, speed, and expiry state. Expiration of one motor must not modify the other motor.

## Action Routing

The shared ECA layer continues to encode `MOTOR_SET` consistently. The motor-hub adds a local actuator dispatch path:

1. Resolve the action target UID.
2. If it is the built-in motor UID, execute the packed command through the local DRV8410 driver.
3. Otherwise resolve the target to a registered CAN slot and send the normal actuator frame.

The standard hub does not register a local motor handler, so all module actuator actions retain their existing CAN behavior. The external motor module continues to receive the same five-byte payload through `WearBlocksProtocol`.

Direct `$A` commands follow the same routing rule as ECA actions.

## Bluetooth and USB Data Flow

The motor-hub uses the same Nordic UART Service UUIDs and line protocol as the standard hub. The frontend bridge can therefore connect through BLE or USB without a motor-specific transport mode.

```text
Blockly -> ECA bytecode -> BLE or USB -> motor-hub
                                      |-> local DRV8410 M1/M2
                                      `-> CAN external modules
```

The motor-hub emits its built-in motor identity and descriptor during status synchronization so the existing capability-based Blockly dropdown can discover it.

## Safety and Runtime Behavior

- Boot starts with `nSLEEP` low and all PWM outputs at zero.
- `nSLEEP` goes high only after PWM initialization succeeds.
- Invalid motor numbers or modes are ignored.
- A stop command or speed zero clears that motor's timer and drives both corresponding inputs low.
- Duration expiry is non-blocking and independently checked for each motor.
- Motor control never delays CAN processing, BLE handling, ECA evaluation, or face detection.

## Testing

The implementation must verify:

- JavaScript encode/decode round-trip preserves motor, mode, speed, and duration;
- capability mapping recognizes built-in and external motor descriptors;
- simulator independently controls and expires M1 and M2;
- standard hub behavior remains unchanged when no local motor handler is installed;
- local motor targets do not emit CAN actuator frames;
- external motor targets from a motor-hub do emit CAN actuator frames;
- the standard hub, external motor module, and motor-hub firmware targets all compile for ESP32-C3;
- physical bring-up verifies BLE connection, Blockly upload, local M1/M2 operation, and an external module on GPIO5 Face 1.

## Scope

This phase implements direction, speed, stop/start, and optional duration only. Encoder feedback, nFAULT handling, braking modes, acceleration ramps, closed-loop speed control, and higher-level vehicle movement blocks remain outside scope.
