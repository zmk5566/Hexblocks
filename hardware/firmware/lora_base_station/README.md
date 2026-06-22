# WearBlocks LoRa Base Station

Firmware target: ESP32-S3 + SX1262.

Install Arduino libraries before compiling:

- RadioLib
- ArduinoJson

Edit these constants at the top of `lora_base_station.ino` before flashing:

- `WIFI_SSID`
- `WIFI_PASS`
- `HTTP_ENDPOINT`
- `HTTP_BEARER_TOKEN`
- SX1262 pins
- LoRa frequency/power parameters

Runtime behavior:

- Receives `WBLR` batch frames from LoRa logger modules.
- Uploads each new batch with `HTTP POST`.
- Sends a LoRa ACK only after the HTTP API returns 2xx.
- Re-ACKs duplicate `(node_uid, boot_id, sequence)` batches from a short RAM cache.

RF defaults are CN470-like placeholders. Confirm the final frequency, power,
antenna, duty-cycle assumptions, and SRRC requirements before field use.
