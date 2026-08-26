# Motor Hub BLE Car Test

Standalone bring-up sketch for the two-motor `motor_hub` prototype. This folder is intentionally separate from the normal WearBlocks hub/module firmware.

Scope:

- Tests BLE control and two DRV8833 motor channels only.
- Does not initialize CAN.
- Does not scan the single magnetic face on GPIO0.

## Arduino IDE

1. Install ESP32 board support.
2. Install the `NimBLE-Arduino` library.
3. Open `test_motor_car_ble.ino`.
4. Select an ESP32-C3 board target.
5. Upload.

Recommended first power-up:

1. Keep the magnetic face empty.
2. Power the board and confirm serial output reaches `advertising as HexMotorCar`.
3. Connect from the test webpage.
4. Test at low speed before raising the slider.

BLE device name: `HexMotorCar`

Custom BLE service:

| UUID | Direction | Purpose |
|------|-----------|---------|
| `6f8f0001-b5a3-f393-e0a9-e50e24dcca9e` | service | car test service |
| `6f8f0002-b5a3-f393-e0a9-e50e24dcca9e` | browser -> car | write commands |
| `6f8f0003-b5a3-f393-e0a9-e50e24dcca9e` | car -> browser | notify status |

Commands:

```text
D,<left>,<right>
S
B
P
```

`left` and `right` are signed speeds from `-255` to `255`.

## CLI Controller

The CLI connects through the computer's native BLE stack and does not require a
browser or Web Bluetooth. It discovers the car by service UUID, even when the
BLE advertisement does not contain a local name.

```bash
cd frontend/test_motor_car_ble
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python motor_car_cli.py
```

Controls:

| Key | Action |
|-----|--------|
| `W` | Forward |
| `S` | Reverse |
| `A` / `D` | Turn left / right |
| `Space` | Coast stop |
| `B` | Brief brake, then stop |
| `+` / `-` | Increase / decrease speed |
| `P` | Request current motor status |
| `Q` | Stop, disconnect, and quit |

Use `--scan-only` to confirm that the BLE service is visible without connecting:

```bash
.venv/bin/python motor_car_cli.py --scan-only
```

Use `--address <BLE_IDENTIFIER>` to bypass scanning and connect directly. On
macOS the CoreBluetooth identifier is a UUID rather than a MAC address.

## Browser Test Frontend

Serve this repo directory from localhost and open:

```text
http://127.0.0.1:4173/index.html
```

The page is in:

```text
frontend/test_motor_car_ble/index.html
```

Web Bluetooth requires a secure context and a Chromium-based browser;
`localhost` / `127.0.0.1` satisfies the secure-context requirement. Firefox and
Safari do not expose Web Bluetooth, so use the CLI controller with those
browsers.
