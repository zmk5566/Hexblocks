# WearBlocks Pin Assignment

> **2026-04 update — digital-presence PosID**
> Hub is now **ESP32-C3-MINI-1** (not S3). PosID uses **digital presence**
> (internal pull-up on hub + POS_ID tied to GND on module's docking face),
> not ADC + resistor network. See `posid-topology.md` for historical notes
> and the current scheme.

## Hub: ESP32-C3-MINI-1

| GPIO | Function | Notes |
|------|----------|-------|
| GPIO6 | TWAI_TX (CAN TX) | To SN65HVD230 TXD. Repurposes JTAG MTCK. |
| GPIO7 | TWAI_RX (CAN RX) | From SN65HVD230 RXD. Repurposes JTAG MTDO. |
| GPIO0 | Face 1 presence | digital INPUT_PULLUP. **Boot strap — caution**: module must not short this to GND at power-up. |
| GPIO2 | Face 2 presence | digital INPUT_PULLUP. **Boot strap — caution** as above. |
| GPIO3 | Face 3 presence | digital INPUT_PULLUP. Clean ADC1_CH3 line per user test. |
| GPIO4 | Face 4 presence | digital INPUT_PULLUP. Clean. |
| GPIO8 | Face 5 presence | digital INPUT_PULLUP. **Boot strap — caution.** Sometimes wired to onboard LED on dev boards — test first. |
| GPIO10 | Face 6 presence | digital INPUT_PULLUP. |
| GPIO9 | Status LED (optional) | Boot button on most dev boards; OK to drive as output after boot. |
| GPIO18 | USB D- | USB-OTG if using native USB as serial |
| GPIO19 | USB D+ | |
| GPIO20/21 | UART0 RX/TX | For flashing + serial console via USB-UART |

**ADC note**: ESP32-C3 only has 5 usable ADC1 pins (GPIO 0–4) and ADC2 (GPIO 5) is unsupported by the Arduino-ESP32 core. For the face count to reach 6 on C3, we switched PosID from analog to digital; this also sidesteps dev-board ADC pin contamination and calibration.

**Strap pin caveat**: GPIO 0/2/8/9 are boot-mode strapping pins. A module plugged into its corresponding face at power-up will short the strap pin to GND, which can force the MCU into download mode. Boot procedure in firmware:
- Power hub on with all faces empty, wait for `[WAIT] Listening for module HELLO`
- Then plug modules in

Once the bootloader has handed off, these pins are free to read LOW. A future PCB respin should avoid strap pins for face presence; for breadboard prototypes the workaround above is acceptable.

## Module: ESP32-C3-MINI-1

| GPIO | Function | Notes |
|------|----------|-------|
| GPIO0 | TWAI_TX (CAN TX) | To SN65HVD230 TXD. Strap pin — must not boot low; default TWAI idles high. |
| GPIO1 | TWAI_RX (CAN RX) | From SN65HVD230 RXD |
| GPIO3 | I2C SDA | For MPU6050, MAX30102, BME280 |
| GPIO4 | I2C SCL | |
| GPIO2 | Child-presence face A (down-half stack detect) | INPUT_PULLUP. Strap pin caveat applies when a child module is stacked at boot. |
| GPIO5 | Child-presence face B (down-half stack detect) | INPUT_PULLUP. ADC2 unreliable but digital is fine. |
| GPIO10 | Child-presence face C (down-half stack detect) | INPUT_PULLUP. |
| GPIO8 | Status LED | Module state indicator |
| GPIO9 | Boot button / reserved | |

**PosID behaviour**:
- Module's docking face has its POS_ID pin **hard-tied to GND on the PCB** (or equivalently to POS_GND pin of the connector — they're both ground).
- Module does not need to read its own POS_ID; `MY_FACE` is a compile-time constant baked in firmware per PCB variant.
- Module's three "down-half" faces have POS_ID routed to INPUT_PULLUP GPIOs (above), so the module detects when someone stacks onto it, and broadcasts `WB_MSG_CHILD_EVENT` on CAN.

## SN65HVD230 CAN Transceiver Wiring

| Pin | Connection |
|-----|-----------|
| TXD | ESP32 TWAI_TX GPIO |
| RXD | ESP32 TWAI_RX GPIO |
| CANH | Bus CAN-H (to pogo pin) |
| CANL | Bus CAN-L (to pogo pin) |
| VCC | 3.3V |
| GND | GND |
| Rs | GND (slope control = high speed) |
| Vref | NC (unused) |

**Bus termination:** 120Ω between CAN-H and CAN-L on the hub only.

## 6-Pin Hex Face Connector (unchanged physically; POS_ID role changed)

| Pin # | Signal | Direction | Notes |
|-------|--------|-----------|-------|
| 1 | CAN-H | Bidirectional | Shared bus |
| 2 | CAN-L | Bidirectional | Shared bus |
| 3 | VCC | Power out (hub / host module) | 3.3V |
| 4 | GND | Common ground | |
| 5 | POS_ID | **Digital low = dock present** | On child side: tied to GND. On host side: GPIO with internal pull-up. |
| 6 | POS_GND | GND reference | Dedicated ground alongside POS_ID for clean digital reference |

## PosID detection logic

```
Host side (hub or parent module):
    pinMode(FACE_PIN_N, INPUT_PULLUP);
    bool occupied = (digitalRead(FACE_PIN_N) == LOW);

Child side (docking face):
    POS_ID pin on the PCB is a solder trace to GND. No MCU code involved.

Identity:
    Module sends CAN HELLO with MY_FACE (compile-time constant encoded in firmware).
    Host cross-checks: "I saw my face N just become occupied AND this HELLO just arrived → they correlate."

Stack:
    Each host module has 3 child-presence GPIOs (down-half faces only).
    When any goes LOW, module sends WB_MSG_CHILD_EVENT_BASE+mySlot on CAN.
    Hub consumes these events to maintain the parent-child tree.
```

