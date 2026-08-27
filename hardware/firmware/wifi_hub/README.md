# WearBlocks Wi-Fi Hub

This is the six-face Hub build with the optional Wi-Fi/OSC module transport.
It shares the complete runtime and `ModuleRegistry` implementation with
`../hub`; this directory only selects the wireless adapter at compile time.

Choose one six-face Hub target:

| Target | Runtime links | Wi-Fi SoftAP / OSC |
|---|---|---|
| `hardware/firmware/hub` | CAN + USB/BLE | No |
| `hardware/firmware/wifi_hub` | CAN + USB/BLE + Wi-Fi | Yes |

Compile this variant with:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32c3 \
  --libraries hardware/firmware/lib hardware/firmware/wifi_hub
```

The Wi-Fi Hub provisions supported modules over CAN, runs a WPA2 SoftAP, and
accepts UID-keyed OSC-over-UDP samples. ECA execution remains on the Hub. See
[`hardware/docs/wifi-osc-fallback.md`](../../docs/wifi-osc-fallback.md) for the
transport modes and wire protocol.
