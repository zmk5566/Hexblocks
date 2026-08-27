# Wi-Fi / OSC Fallback Runtime

Status: first end-to-end implementation for simple sensor modules
(`module_resistor` and `module_light_resistor`).

The reference system still treats CAN as the deterministic local module bus,
but each module can carry a transport policy. The hub can run a WPA2 SoftAP and
accept OSC-over-UDP packets from Wi-Fi modules. ECA execution remains on the
hub; CAN and Wi-Fi sensor samples update the same UID-keyed ECA cache.

## Transport modes

Configured per module:

| Mode | Behavior |
|---|---|
| `can_only` | Use CAN only. Ignore Wi-Fi sensor samples. |
| `wifi_only` | Use Wi-Fi for runtime data even if CAN is physically present. |
| `can_primary_wifi_fallback` | Default. Use CAN while healthy; switch to Wi-Fi after CAN detach/fail. |
| `wifi_primary_can_fallback` | Prefer Wi-Fi when the endpoint is known; use CAN if Wi-Fi is unavailable. |
| `dual_send_debug` | Send actuator/topic commands over both links and accept both sensor paths for debugging. |

Hub commands:

```text
$W,INFO
$W,CONFIG ALL <mode>
$W,CONFIG <uidHex> <mode>
```

`$W,INFO` emits the SoftAP SSID, AP IP, UDP port, AP password, and pairing
token. The first module provisioning and recovery path is still CAN: attach the
module, use the hub command path to set the module configuration, then let the
module persist it in NVS.

## CAN provisioning

Wi-Fi profile data is sent over CAN with a dedicated system config path, not
the actuator config path:

```text
WB_MSG_SYS_CONFIG      0x090
WB_MSG_SYS_CONFIG_ACK  0x091
```

The hub sends a chunked binary profile to the assigned module slot after ACK
and whenever `$W,CONFIG` changes a module's transport mode. The profile
contains `hubId`, `ssid`, `pass`, `token`, `udpPort`, `transportMode`, an
enabled flag, and a FNV32 checksum. Modules save the profile in NVS and can
reconnect to the same hub SoftAP without CAN on later boots.

The hub SoftAP SSID is unique by default:

```text
HEX-<hubShortId>
```

The AP password and OSC token are generated once and persisted in hub NVS.

## Hub wire output

The hub adds link-state lines to the existing `$` protocol:

```text
$W,<uid>,<activeLink>,<transportMode>,<topologyState>,<ip>,<port>
$WIFI,AP,<ssid>,<ip>,<port>
$WIFI,PASS,<password>
$WIFI,TOKEN,<token>
```

Wireless-only modules use `REMOTE,0` as their parent label in `$H` and `$T`
rows. The bridge maps that to `parent_remote=true` and the UI renders the module
as remote/unplaced rather than attached to a hub face.

## OSC messages

All OSC messages use typed arguments. Runtime samples are latest-value wins;
configuration and actions carry IDs so the receiver can ACK, NACK, retry, and
deduplicate.

Module to hub:

```text
/wb/module/hello       s i s i s   uid, fwHash, transportMode, seq, token
/wb/module/heartbeat   s i s s     uid, seq, linkState, token
/wb/sensor             s i f i s   uid, channel, value, seq, token
/wb/descriptor/blob    s i i b s   uid, fwHash, seq, serializedDescriptor, token
```

Hub to module:

```text
/wb/ack                s i s       uid, msgId, status
/wb/nack               s i s       uid, msgId, reason
/wb/descriptor/request s i i s     uid, fwHash, msgId, token
/wb/action             s i i i b s uid, cmd, msgId, paramLen, params, token
/wb/topic              s i i i s   uid, channel, enable, msgId, token
```

Broadcast is intentionally reserved for discovery and low-frequency status.
Runtime sensor and actuator/control messages should be unicast between a module
and the hub.

## Current limitations

- `module_resistor` and `module_light_resistor` use `WBWirelessModule` for
  CAN/Wi-Fi sensor routing. IMU, LED, vibration, and audio sketches still need
  to be moved onto the wrapper for Wi-Fi topic/action handling.
- Hub action/topic packets are ACKed by the module, but hub-side retry and
  dedup bookkeeping are still minimal.
- Descriptor transfer is implemented as a single OSC blob. If descriptor or
  config payloads grow beyond one safe UDP datagram, promote this to chunked
  `seq/index/total/crc` transfer.
- ESP32-C3 can run CAN, Wi-Fi, and BLE, but Wi-Fi and BLE share the 2.4 GHz RF.
  During Wi-Fi fallback, BLE should stay on low-frequency status/config traffic.
