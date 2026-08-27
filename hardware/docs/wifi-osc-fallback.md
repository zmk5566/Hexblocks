# Wi-Fi / OSC Fallback Runtime

Status: end-to-end sensor, actuator, topic, ACK/retry, and duplicate-suppression
runtime for the explicit `wifi_hub` variant.

This runtime belongs to the explicit `hardware/firmware/wifi_hub` build. The
default `hardware/firmware/hub` build shares the same CAN/BLE/USB/ECA core but
does not include Wi-Fi, create a SoftAP, or listen for OSC/UDP packets.

```bash
arduino-cli compile --fqbn esp32:esp32:esp32c3 \
  --libraries hardware/firmware/lib hardware/firmware/wifi_hub
```

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
/wb/ack                s i s       uid, msgId, status
/wb/nack               s i s       uid, msgId, reason
```

Hub to module:

```text
/wb/descriptor/request s i i s     uid, fwHash, msgId, token
/wb/action             s i i i b s uid, cmd, msgId, paramLen, params, token
/wb/topic              s i i i s   uid, channel, enable, msgId, token
```

Broadcast is intentionally reserved for discovery and low-frequency status.
Runtime sensor and actuator/control messages should be unicast between a module
and the hub.

For actions and topic changes, the Hub keeps a fixed pending table and retries
after 250 ms, up to three sends. Modules remember the most recent action and
topic message IDs: a retry is ACKed again but its callback is not executed a
second time. ECA `STREAM` action updates and repeated desired topic state are
coalesced while an ACK is outstanding, preventing a slow Wi-Fi link from
turning into an unbounded queue.

The companion-visible correlated wire lines are:

```text
$AO <requestId> <uid> <cmd> [wire params...]       host control request
$AS,<uid>,<cmd>,<paramLen>,<hex>[,<requestId>]     routed state echo
$WA,<uid>,<msgId>,<detail>[,<requestId>]           module ACK
$WN,<uid>,<msgId>,<reason>[,<requestId>]           module NACK/timeout
```

The standard wired Hub understands `$AO` and emits `$AS` too, but never starts
Wi-Fi. This keeps `hub` deterministic while `wifi_hub` owns the wireless
fallback policy.

## Module coverage

- `module_resistor`, `module_light_resistor`, and `module_imu` route sensor
  samples through `WBWirelessModule`.
- `module_led`, `module_vibration`, `module_amplifier`, and `module_motor`
  receive Wi-Fi actuator commands through the same wrapper.
- CAN remains active according to each module's transport policy; the wrapper
  does not fork the application-level actuator implementation.

## Current limitations

- Descriptor transfer is implemented as a single OSC blob. If descriptor or
  config payloads grow beyond one safe UDP datagram, promote this to chunked
  `seq/index/total/crc` transfer.
- ESP32-C3 can run CAN, Wi-Fi, and BLE, but Wi-Fi and BLE share the 2.4 GHz RF.
  During Wi-Fi fallback, BLE should stay on low-frequency status/config traffic.
