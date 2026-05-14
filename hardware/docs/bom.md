# WearBlocks Hardware BOM

> Reflects the prototype shipping on `main` as of 2026-04. Hub is
> ESP32-C3-MINI-1 (not S3); PosID is **digital presence** (per-face
> pull-up on hub + GND tie on the module's docking face), so there is
> **no resistor ladder** on either side. See `pin-assignment.md` and
> `posid-topology.md` for the wiring rationale.

## Hub (1 unit)

| # | Component | Part Number | Qty | Unit Cost | Subtotal | Source |
|---|-----------|-------------|-----|-----------|----------|--------|
| 1 | MCU | ESP32-C3-MINI-1-N4 | 1 | $1.50 | $1.50 | LCSC |
| 2 | CAN Transceiver | SN65HVD230DR | 1 | $0.50 | $0.50 | LCSC |
| 3 | USB-C Connector | USB-C 16-pin SMD | 1 | $0.30 | $0.30 | LCSC |
| 4 | LiPo Charger | TP4056 module | 1 | $0.50 | $0.50 | LCSC |
| 5 | 3.3V Regulator | AMS1117-3.3 | 1 | $0.10 | $0.10 | LCSC |
| 6 | LiPo Battery | 3.7V 1000mAh w/ JST | 1 | $3.00 | $3.00 | Amazon |
| 7 | PosID Pull-ups (6 faces) | 10kΩ 0603 | 6 | $0.01 | $0.06 | LCSC |
| 8 | Pogo Pins (6-pin × 6 faces) | P75-B1 spring-loaded | 36 | $0.10 | $3.60 | AliExpress |
| 9 | Neodymium Magnets | 6mm × 2mm N52 disc | 12 | $0.10 | $1.20 | AliExpress |
| 10 | PCB (hex shape) | JLCPCB 2-layer | 1 | $1.00 | $1.00 | JLCPCB |
| 11 | 3D Printed Enclosure | PLA, white/gray | 1 | $0.50 | $0.50 | Self |
| 12 | Misc (caps, LEDs, headers) | Various 0603 | – | $1.00 | $1.00 | LCSC |
|   |   |   |   | **Hub Total** | **$13.26** |   |

## Per-Module Base (× 6 module types)

Common to every module before the sensor/actuator add-on.

| # | Component | Part Number | Qty | Unit Cost | Subtotal | Source |
|---|-----------|-------------|-----|-----------|----------|--------|
| 1 | MCU | ESP32-C3-MINI-1-N4 | 1 | $1.50 | $1.50 | LCSC |
| 2 | CAN Transceiver | SN65HVD230DR | 1 | $0.50 | $0.50 | LCSC |
| 3 | PosID GND traces (6 faces) | trace + pad | 6 | $0.00 | $0.00 | PCB |
| 4 | Pogo Pins (6-pin × 2–3 active faces) | P75-B1 | 12–18 | $0.10 | $1.50 | AliExpress |
| 5 | Neodymium Magnets | 6mm × 2mm N52 | 4–6 | $0.10 | $0.50 | AliExpress |
| 6 | PCB (hex shape) | JLCPCB 2-layer | 1 | $0.50 | $0.50 | JLCPCB |
| 7 | 3D Printed Enclosure | PLA, color-coded | 1 | $0.50 | $0.50 | Self |
| 8 | Misc (caps, headers) | Various 0603 | – | $0.50 | $0.50 | LCSC |
|   |   |   |   | **Base Module** | **$5.50** |   |

## Sensor / Actuator Add-on (per module type)

Identity columns (`module name`, `descriptor color`) match what the hub
emits in `$H` and what the frontend renders on the canvas. Folder paths
are under `hardware/firmware/`.

| Module | Folder | Identity → name / color | Sensor/Actuator | Breakout | Add-on Cost |
|---|---|---|---|---|---|
| IMU | `module_imu/` | 6-Axis IMU / `#7CA1BB` Slate | MPU6050 6-axis | GY-521 | $1.50 |
| LED | `module_led/` | RGB LED / `#C68E9E` Rose | WS2812B × 8 | NeoPixel Ring 8 | $2.50 |
| Vibration | `module_vibration/` | Vibration Motor / `#50C878` Green | ERM motor + DRV2605L | DRV2605L breakout + motor | $4.00 |
| Audio Synth | `module_amplifier/` | Audio Synth / `#9885BF` Purple | MAX98357A I2S amp + 8Ω speaker | MAX98357A breakout + speaker | $3.50 |
| Light Sensor | `module_light_resistor/` | Light Sensor / `#C1B496` Tan | GL5528 LDR + 10kΩ divider | discrete | $0.50 |
| Rotary Knob | `module_resistor/` | Rotary Knob / `#98AF6F` Olive | WH148 B100K rotary pot | discrete | $0.80 |

> Note on the two greens: vibration uses `#50C878` (sea green), knob uses
> `#98AF6F` (olive). They are deliberately distinct on the canvas; if you
> change one, update the other so they don't collide.

## Total Project Cost

| Item | Cost |
|------|------|
| Hub × 1 | $13.26 |
| IMU module | $7.00 |
| LED module | $8.00 |
| Vibration module | $9.50 |
| Audio Synth module | $9.00 |
| Light Sensor module | $6.00 |
| Rotary Knob module | $6.30 |
| Spare parts / shipping | ~$20.00 |
| **Grand Total** | **~$79** |

## Ordering Checklist

- [ ] LCSC: ESP32-C3-MINI-1 ×7, SN65HVD230 ×7, 10kΩ pull-ups, caps, AMS1117-3.3, TP4056, USB-C
- [ ] AliExpress: P75-B1 pogo pins ×100, 6mm×2mm N52 magnets ×50
- [ ] Sensor/actuator breakouts: GY-521, NeoPixel Ring 8, DRV2605L + ERM, MAX98357A + 8Ω speaker, GL5528 LDR, WH148 B100K
- [ ] JLCPCB: Hub PCB ×2, Module PCB ×10
- [ ] 3D printing filament: white/gray (hub) + Blue / Coral / Green / Teal / Yellow / Lime PLA (one per module type)
- [ ] LiPo battery: 3.7V 1000mAh with JST connector
