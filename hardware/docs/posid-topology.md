# PosID Wiring — Topology B (Symmetric)

This is the canonical wiring spec for the 6-face PosID circuit on every WearBlocks hex (hub or module).  
It's the **only** topology (out of the three we considered) that supports **both** connection modes:

- **A. Hub ↔ Module** — module plugs into any of the hub's 6 faces.
- **B. Module ↔ Module stack** — one module's face docks to another module's face.

Rationale: since a module can play either role (host or guest in a stack), every face on every hex needs to be electrically self-sufficient. If one side relies on the neighbor to provide the pull-up (or pull-down), the circuit collapses whenever that neighbor happens not to have it — exactly what breaks module-on-module stacking.

## Per-face schematic

Every hex face (on hub **and** on every module) is wired identically:

```
                VCC  (3.3V rail)
                 │
                 │
                ┌┴┐
                │ │   R_face_N     ← unique per face position N = 1..6
                │ │   (1k / 2.2k / 3.3k / 4.7k / 6.8k / 10k)
                └┬┘
                 │
                 ├─────o POS_ID   ─── pogo pin ───►  to neighbor's POS_ID
                 │
                 ├─────o ADC_N    (only connected on sides that read this face;
                 │                 hub reads all 6; proto-module reads its 1 active face)
                 │
                ┌┴┐
                │ │   10 kΩ       (pull-down, same value on every face)
                │ │
                └┬┘
                 │
                 │
                GND
                 │
                 └─────o POS_GND  ─── pogo pin ───►  common ground reference
```

Per face you need **exactly 2 resistors**:
- `R_face_N` (pull-up to VCC) — identifies the face position
- `10 kΩ` (pull-down to GND) — shared reference

## R_face values by position

| Face N | R_face_N | V_idle (no neighbor docked) | ADC_idle (12-bit, 3.3V ref) |
|---|---|---|---|
| 1 | 1.0 kΩ | **3.00 V** | ~3720 |
| 2 | 2.2 kΩ | **2.70 V** | ~3350 |
| 3 | 3.3 kΩ | **2.48 V** | ~3080 |
| 4 | 4.7 kΩ | **2.24 V** | ~2780 |
| 5 | 6.8 kΩ | **1.96 V** | ~2440 |
| 6 | 10 kΩ | **1.65 V** | ~2050 |

`V_idle(N) = 3.3 × 10k / (R_face_N + 10k)`

## Docked state — two faces connected through pogo

When face P (on side A) docks with face Q (on side B), the POS_ID lines merge. The combined network has:

- Two pull-ups in parallel: `R_eq = R_P × R_Q / (R_P + R_Q)`
- Two pull-downs in parallel: `5 kΩ` (10k ∥ 10k)

Resulting voltage on the shared POS_ID line:

```
V_docked(P, Q) = 3.3 × 5k / (R_eq + 5k)
```

Both sides' ADCs (if connected) see the **same** voltage. Each side knows its own R value and the universal pull-down scheme, so each side can in principle solve for the neighbor's R (and therefore its face index).

### Voltage table, V_docked(P, Q)

Rows = P (this side), columns = Q (neighbor). Diagonal highlighted because it collides with V_idle(P).

| P\Q | 1 (1k) | 2 (2.2k) | 3 (3.3k) | 4 (4.7k) | 5 (6.8k) | 6 (10k) | V_idle(P) |
|---|---|---|---|---|---|---|---|
| **1** | **3.00** | 2.90 | 2.86 | 2.83 | 2.81 | 2.79 | 3.00 |
| **2** | 2.90 | **2.70** | 2.61 | 2.54 | 2.48 | 2.43 | 2.70 |
| **3** | 2.86 | 2.61 | **2.48** | 2.38 | 2.28 | 2.21 | 2.48 |
| **4** | 2.83 | 2.54 | 2.38 | **2.24** | 2.12 | 2.01 | 2.24 |
| **5** | 2.81 | 2.48 | 2.28 | 2.12 | **1.96** | 1.82 | 1.96 |
| **6** | 2.79 | 2.43 | 2.21 | 2.01 | 1.82 | **1.65** | 1.65 |

### Two observations

1. **Diagonal collision**: `V_docked(N, N) = V_idle(N)` for every N. Symmetric face-to-same-face dock looks identical to "not docked at all." This is a fundamental consequence of the symmetric divider and cannot be avoided with this resistor scheme alone. For the current prototype where each module has only **one active face** of a **fixed index**, this only matters if you try to stack two modules whose active faces happen to be the same index — avoid that by assigning different face indices to different module types (e.g., IMU=face 1, LED=face 2, etc.).

2. **Row 1 is compressed**: when R_P = 1k (face 1), all V_docked values fall in a 0.21 V band (2.79–3.00 V). The small pull-up dominates and swamps the neighbor's signal. Face 1 can tell "docked or not" but cannot reliably identify which face it's docked to, unless the ADC is very clean. Rows with larger R_P spread out more (row 6 spans 1.14 V).

## Detection rules for firmware

### Occupancy (`isFaceOccupied` replacement)

The current `adc > 200` rule assumes pull-down-only-when-empty, which is topology C and is wrong for topology B. Correct rule:

> Face N is occupied iff `|V_measured − V_idle(N)|` > `V_TOL`.

With `V_TOL ≈ 0.10 V` (about 125 ADC counts), the diagonal-collision edge cases are misdetected as "empty", but all other dock combinations are cleanly detected. Good enough for the hub↔module case where the hub has 6 different faces and the module tag maps to a single R.

### Face identification of neighbor

Given a measurement V on this-side face P, solve for R_Q:

```
R_eq = 5k × V / (3.3 − V) × (1/5k - 1/R_eq) ...  // closed form below
```

Closed form: let `x = V / 3.3`, then `R_eq = 5 × x / (1 − x)` (kΩ), and
`R_Q = R_P × R_eq / (R_P − R_eq)`.

Match R_Q to the nearest value in {1.0, 2.2, 3.3, 4.7, 6.8, 10} kΩ within 20 % tolerance. If no match, treat as "unknown face / no dock."

This decode works well for P = 4, 5, 6 (large R_P); may be ambiguous for P = 1, 2. For the prototype, the hub has 6 different R_P, so at least 4 of them decode reliably — good enough to cover most plug positions.

## Wiring checklist

Per hex PCB (whether hub or module):

- [ ] **6 × face-specific pull-ups** to VCC, values {1.0k, 2.2k, 3.3k, 4.7k, 6.8k, 10k}, one per face position.
- [ ] **6 × 10kΩ pull-downs** to GND, one per face position.
- [ ] All 6 POS_ID lines routed to their respective pogo pin (pin 5 of the 6-pin face connector).
- [ ] POS_GND (pin 6) tied to GND — dedicated return so face-to-face current doesn't share the digital GND plane.
- [ ] On the **hub**: all 6 POS_ID lines also tap the MCU's 6 ADC pins (GPIO {1, 2, 3, 6, 7, 8}).
- [ ] On a **prototype module** (single active face): POS_ID of the active face taps the MCU's single ADC pin (GPIO 2 on ESP32-C3); the other 5 faces only need the R_face + 10k + POS_ID wiring for the stack case — they don't need ADC taps unless you want the module to be able to host another module on those faces.

Sanity reading with a multimeter **before flashing**:

With the board powered (3.3V rail up) and nothing docked into any face, measure each POS_ID pin to GND. You should see six distinct voltages matching the `V_idle` column above, within ~5 %. If any pin reads 0 V → pull-up missing or shorted. If any reads VCC → pull-down missing.

## Code impact summary

Files to update once you've confirmed topology B on the actual board:

| File | Change |
|---|---|
| `hardware/firmware/lib/WearBlocksPosID/WearBlocksPosID.cpp` | Rewrite `isFaceOccupied` to compare against `V_idle(N)` table with a tolerance; optionally add `decodeNeighborFace(uint8_t myFace)` that returns the neighbor's face index via the closed-form decode above. |
| `hardware/docs/pin-assignment.md` | Replace the "POS_ID Resistor Values" section with a cross-reference to this doc (and keep only the R_face_N list there). |
