"""WearBlocks v2 wire-protocol parser.

Pure decoder for the hub's $-prefixed line protocol. No I/O, no globals,
no side effects. Returns a canonical dict per recognised line, or None.

Canonical events carry the wire-level identity (`uid`) and protocol
fields only. Bridge-layer concerns (slot crosswalk, color, caching) live
in the bridge wrapper.

Wire grammar (v2):
  $H,<uid>,<moduleId>,<parentLabel>,<parentFace>
  $D,<uid>,<descriptorJSON>
  $I,<uid>,<moduleId>,<version>,<fwHash>
  $S,<uid>,<channelId>,<float>
  $X,<uid>
  $U,<uid>
  $F,<uid>,<oldParent>,<oldFace>,<newParent>,<newFace>
  $C,<parentUid>,<childUid|PENDING>,<parentFace>
  $c,<parentUid>,<childUid|PENDING>,<parentFace>
  $T,<uid>,<parentLabel>,<parentFace>
  $W,<uid>,<activeLink>,<transportMode>,<topologyState>,<ip>,<port>
  $AS,<uid>,<cmd>,<paramLen>,<paramsHex>[,<requestId>]
  $WA,<uid>,<msgId>,<kind>[,<requestId>]
  $WN,<uid>,<msgId>,<reason>[,<requestId>]
  $L,<uid>,<queueDepth>,<dropped>,<lastAckMs>,<rssi>,<snr>,<timeQuality>,<configRev>
  $Q,DONE
  $OK <text>     (space-separated, not comma)
  $ERR <text>    (space-separated, not comma)

`parentLabel` is `HUB`, an 8-hex UID, `PENDING`, or empty.
"""
import json


def _parse_parent(label: str) -> tuple[str | None, bool, bool]:
    """Interpret a $H/$F/$T parentLabel token.

    Returns (parent_uid, is_hub, is_remote). parent_uid is None when
    parent is the hub or a remote/unplaced wireless node.
    """
    label = (label or "").strip()
    if not label:
        return None, False, False
    if label == "HUB":
        return None, True, False
    if label == "REMOTE":
        return None, False, True
    return label, False, False


def parse_line(raw: str) -> dict | None:
    """Decode a single $-prefixed hub line into a canonical event dict.

    Returns None for blank input, non-$ lines, malformed lines, or
    unknown tags. The returned dict always carries `type` and (when the
    tag is uid-keyed) `uid`.
    """
    line = raw.strip()
    if not line.startswith("$"):
        return None

    # OK/ERR lines are space-separated; all other tags use commas.
    if line.startswith("$OK"):
        return {"type": "command_ack", "status": "ok",
                "text": line[3:].lstrip()}
    if line.startswith("$ERR"):
        return {"type": "command_ack", "status": "err",
                "text": line[4:].lstrip()}

    tag = line[1:].split(",", 1)[0]

    if tag == "H":
        # $H,<uid>,<moduleId>,<parentLabel>,<parentFace>
        parts = line[1:].split(",", 4)
        if len(parts) < 5:
            return None
        uid, mod_id, parent_label, parent_face_s = (
            parts[1], parts[2], parts[3], parts[4])
        try:
            parent_face = int(parent_face_s)
        except ValueError:
            return None
        parent_uid, parent_is_hub, parent_remote = _parse_parent(parent_label)
        return {
            "type": "hello",
            "uid": uid,
            "id": mod_id,
            "parent_uid": parent_uid,
            "parent_is_hub": parent_is_hub,
            "parent_remote": parent_remote,
            "parent_face": parent_face,
        }

    if tag == "D":
        # $D,<uid>,<descriptorJSON>
        parts = line[1:].split(",", 2)
        if len(parts) < 3:
            return None
        try:
            desc = json.loads(parts[2])
        except json.JSONDecodeError:
            return None
        return {"type": "descriptor", "uid": parts[1], "data": desc}

    if tag == "I":
        # $I,<uid>,<moduleId>,<version>,<fwHash>
        parts = line[1:].split(",", 4)
        if len(parts) < 5:
            return None
        fw_hash = parts[4].strip().upper()
        try:
            int(fw_hash, 16)
        except ValueError:
            return None
        return {
            "type": "module_info",
            "uid": parts[1],
            "id": parts[2],
            "version": parts[3],
            "fw_hash": fw_hash,
        }

    if tag == "S":
        # $S,<uid>,<channelId>,<float>
        parts = line[1:].split(",")
        if len(parts) < 4:
            return None
        try:
            channel_id = int(parts[2])
            value = float(parts[3])
        except ValueError:
            return None
        return {"type": "sensor", "uid": parts[1],
                "channel_id": channel_id, "value": value}

    if tag == "X":
        # $X,<uid>
        parts = line[1:].split(",")
        if len(parts) >= 2:
            return {"type": "detach_pending", "uid": parts[1]}
        return None

    if tag == "U":
        # $U,<uid>
        parts = line[1:].split(",")
        if len(parts) >= 2:
            return {"type": "unplug", "uid": parts[1]}
        return None

    if tag == "F":
        # $F,<uid>,<oldParent>,<oldFace>,<newParent>,<newFace>
        parts = line[1:].split(",", 5)
        if len(parts) < 6:
            return None
        try:
            old_face = int(parts[3])
            new_face = int(parts[5])
        except ValueError:
            return None
        old_parent_uid, old_is_hub, old_remote = _parse_parent(parts[2])
        new_parent_uid, new_is_hub, new_remote = _parse_parent(parts[4])
        return {
            "type": "face_swap",
            "uid": parts[1],
            "old_parent_uid": old_parent_uid,
            "old_parent_is_hub": old_is_hub,
            "old_parent_remote": old_remote,
            "old_face": old_face,
            "new_parent_uid": new_parent_uid,
            "new_parent_is_hub": new_is_hub,
            "new_parent_remote": new_remote,
            "new_face": new_face,
        }

    if tag in ("C", "c"):
        # $C / $c, <parentUid>, <childUid|PENDING>, <parentFace>
        parts = line[1:].split(",")
        if len(parts) < 4:
            return None
        try:
            parent_face = int(parts[3])
        except ValueError:
            return None
        pending = (parts[2] == "PENDING")
        mtype = "child_stack" if tag == "C" else "child_unstack"
        return {
            "type": mtype,
            "parent_uid": parts[1],
            "child_uid": None if pending else parts[2],
            "pending": pending,
            "parent_face": parent_face,
        }

    if tag == "T":
        # $T,<uid>,<parentLabel>,<parentFace>
        parts = line[1:].split(",", 3)
        if len(parts) < 4:
            return None
        try:
            parent_face = int(parts[3])
        except ValueError:
            return None
        parent_uid, parent_is_hub, parent_remote = _parse_parent(parts[2])
        return {
            "type": "topology",
            "uid": parts[1],
            "parent_uid": parent_uid,
            "parent_is_hub": parent_is_hub,
            "parent_remote": parent_remote,
            "parent_face": parent_face,
        }

    if tag == "W":
        # $W,<uid>,<activeLink>,<transportMode>,<topologyState>,<ip>,<port>
        parts = line[1:].split(",", 6)
        if len(parts) < 7:
            return None
        try:
            port = int(parts[6]) if parts[6] else 0
        except ValueError:
            return None
        return {
            "type": "link_state",
            "uid": parts[1],
            "active_link": parts[2],
            "transport_mode": parts[3],
            "topology_state": parts[4],
            "ip": parts[5],
            "port": port,
        }

    if tag == "L":
        # $L,<uid>,<queueDepth>,<dropped>,<lastAckMs>,<rssi>,<snr>,<timeQuality>,<configRev>
        parts = line[1:].split(",")
        if len(parts) < 9:
            return None
        try:
            return {
                "type": "logger_status",
                "uid": parts[1],
                "queue_depth": int(parts[2]),
                "dropped_count": int(parts[3]),
                "last_ack_ms": int(parts[4]),
                "rssi": float(parts[5]),
                "snr": float(parts[6]),
                "time_quality": int(parts[7]),
                "config_rev": int(parts[8]),
            }
        except ValueError:
            return None

    if tag == "WIFI":
        parts = line[1:].split(",", 4)
        if len(parts) >= 2 and parts[1] == "DISABLED":
            return {"type": "wifi_disabled"}
        if len(parts) >= 4 and parts[1] == "AP":
            try:
                port = int(parts[4]) if len(parts) >= 5 else 0
            except ValueError:
                return None
            return {
                "type": "wifi_ap",
                "ssid": parts[2],
                "ip": parts[3],
                "port": port,
            }
        if len(parts) >= 3 and parts[1] == "TOKEN":
            return {"type": "wifi_token", "token": parts[2]}
        if len(parts) >= 3 and parts[1] == "PASS":
            return {"type": "wifi_pass", "password": parts[2]}
        return None

    if tag == "AS":
        # Commanded actuator state emitted by the Hub after routing.
        # $AS,<uid>,<cmd>,<paramLen>,<paramsHex>[,<requestId>]
        parts = line[1:].split(",", 5)
        if len(parts) < 5:
            return None
        try:
            command = int(parts[2])
            param_len = int(parts[3])
            params = bytes.fromhex(parts[4]) if parts[4] else b""
        except (ValueError, TypeError):
            return None
        if param_len < 0 or param_len > 10 or len(params) != param_len:
            return None
        result = {
            "type": "actuator_state",
            "uid": parts[1],
            "cmd": command,
            "params": list(params),
            "source": "hub_command",
            "confirmed": False,
        }
        if len(parts) >= 6 and parts[5]:
            result["request_id"] = parts[5]
        return result

    if tag in ("WA", "WN"):
        # Module-side ACK/NACK for a Hub→module Wi-Fi OSC command.
        parts = line[1:].split(",", 4)
        if len(parts) < 4:
            return None
        try:
            message_id = int(parts[2])
        except ValueError:
            return None
        result = {
            "type": "wireless_command_result",
            "uid": parts[1],
            "message_id": message_id,
            "status": "ack" if tag == "WA" else "nack",
            "detail": parts[3],
        }
        if len(parts) >= 5 and parts[4]:
            result["request_id"] = parts[4]
        return result

    if tag == "Q":
        parts = line[1:].split(",", 1)
        if len(parts) >= 2 and parts[1] == "DONE":
            return {"type": "query_done"}
        return None

    if tag == "E":
        # $E,<running>,<has>,<rules>,<vcs>,<rawLen>,<nvsHas>
        parts = line[1:].split(",")
        if len(parts) < 7:
            return None
        try:
            return {
                "type": "eca_status",
                "running":     int(parts[1]) != 0,
                "has_program": int(parts[2]) != 0,
                "num_rules":   int(parts[3]),
                "num_vcs":     int(parts[4]),
                "raw_len":     int(parts[5]),
                "nvs_stored":  int(parts[6]) != 0,
            }
        except ValueError:
            return None

    if tag == "EB":
        # $EB,<base64> — current ECA bytecode echoed back. The bridge
        # forwards as-is so the frontend can decode rules with the same
        # encoder/decoder it uses to build $P uploads.
        parts = line[1:].split(",", 1)
        if len(parts) < 2:
            return None
        return {"type": "eca_bytecode", "base64": parts[1]}

    return None


def _selftest() -> None:
    """Assert parse_line handles every v2 tag. Run via the bridge's
    --selftest entrypoint."""
    h = parse_line("$H,A1B2C3D4,imuv2,HUB,1")
    assert h == {"type": "hello", "uid": "A1B2C3D4", "id": "imuv2",
                 "parent_uid": None, "parent_is_hub": True,
                 "parent_remote": False,
                 "parent_face": 1}, h

    h2 = parse_line("$H,A1B2C3D4,,HUB,1")
    assert h2["id"] == "" and h2["parent_is_hub"] is True, h2

    d = parse_line('$D,A1B2C3D4,{"id":"imuv2","nm":"IMU"}')
    assert d == {"type": "descriptor", "uid": "A1B2C3D4",
                 "data": {"id": "imuv2", "nm": "IMU"}}, d

    i = parse_line("$I,A1B2C3D4,imuv2,3.1,8f0a")
    assert i == {"type": "module_info", "uid": "A1B2C3D4",
                 "id": "imuv2", "version": "3.1",
                 "fw_hash": "8F0A"}, i

    s = parse_line("$S,A1B2C3D4,5,0.1234")
    assert s == {"type": "sensor", "uid": "A1B2C3D4",
                 "channel_id": 5, "value": 0.1234}, s

    x = parse_line("$X,A1B2C3D4")
    assert x == {"type": "detach_pending", "uid": "A1B2C3D4"}, x

    f = parse_line("$F,A1B2C3D4,HUB,1,DEADBEEF,3")
    assert (f["type"] == "face_swap" and f["old_parent_is_hub"]
            and f["new_parent_uid"] == "DEADBEEF"
            and f["new_face"] == 3), f

    c = parse_line("$C,DEADBEEF,PENDING,4")
    assert (c["type"] == "child_stack" and c["pending"]
            and c["child_uid"] is None and c["parent_face"] == 4), c
    c2 = parse_line("$C,DEADBEEF,A1B2C3D4,4")
    assert not c2["pending"] and c2["child_uid"] == "A1B2C3D4", c2

    uc = parse_line("$c,DEADBEEF,A1B2C3D4,4")
    assert (uc["type"] == "child_unstack"
            and uc["child_uid"] == "A1B2C3D4"), uc

    t = parse_line("$T,A1B2C3D4,DEADBEEF,2")
    assert (t["type"] == "topology" and t["parent_uid"] == "DEADBEEF"
            and t["parent_face"] == 2), t

    u = parse_line("$U,A1B2C3D4")
    assert u == {"type": "unplug", "uid": "A1B2C3D4"}, u

    assert parse_line("$OK P loaded (12 bytes)") == {
        "type": "command_ack", "status": "ok",
        "text": "P loaded (12 bytes)"}
    assert parse_line("$ERR bad_uid") == {
        "type": "command_ack", "status": "err", "text": "bad_uid"}
    assert parse_line("$Q,DONE") == {"type": "query_done"}

    rh = parse_line("$H,FACE0001,imuv2,REMOTE,0")
    assert rh["parent_remote"] and rh["parent_uid"] is None and not rh["parent_is_hub"], rh

    w = parse_line("$W,FACE0001,wifi,wifi_only,remote_unplaced,192.168.4.2,9000")
    assert (w["type"] == "link_state" and w["active_link"] == "wifi"
            and w["transport_mode"] == "wifi_only" and w["port"] == 9000), w

    lg = parse_line("$L,FACE0010,2,1,12345,-92,7.5,1,42")
    assert (lg["type"] == "logger_status" and lg["uid"] == "FACE0010"
            and lg["queue_depth"] == 2 and lg["dropped_count"] == 1
            and lg["last_ack_ms"] == 12345 and lg["rssi"] == -92.0
            and lg["snr"] == 7.5 and lg["time_quality"] == 1
            and lg["config_rev"] == 42), lg

    ap = parse_line("$WIFI,AP,HEX-1234,192.168.4.1,9000")
    assert ap == {"type": "wifi_ap", "ssid": "HEX-1234",
                  "ip": "192.168.4.1", "port": 9000}, ap
    pw = parse_line("$WIFI,PASS,hex-ABCDEF0123456789")
    assert pw == {"type": "wifi_pass", "password": "hex-ABCDEF0123456789"}, pw
    assert parse_line("$WIFI,DISABLED") == {"type": "wifi_disabled"}
    actuator = parse_line("$AS,FACE0005,1,8,FF28050000000000")
    assert actuator == {
        "type": "actuator_state", "uid": "FACE0005", "cmd": 1,
        "params": [255, 40, 5, 0, 0, 0, 0, 0],
        "source": "hub_command", "confirmed": False,
    }, actuator
    assert parse_line("$WA,FACE0005,17,action") == {
        "type": "wireless_command_result", "uid": "FACE0005",
        "message_id": 17, "status": "ack", "detail": "action",
    }
    assert parse_line("$WN,FACE0005,18,timeout") == {
        "type": "wireless_command_result", "uid": "FACE0005",
        "message_id": 18, "status": "nack", "detail": "timeout",
    }
    assert parse_line("$AS,FACE0005,0,0,,osc-7")["request_id"] == "osc-7"
    assert parse_line("$WA,FACE0005,19,action,osc-7")["request_id"] == "osc-7"

    e = parse_line("$E,1,1,3,2,128,1")
    assert (e["type"] == "eca_status" and e["running"] and e["has_program"]
            and e["num_rules"] == 3 and e["num_vcs"] == 2
            and e["raw_len"] == 128 and e["nvs_stored"]), e
    e0 = parse_line("$E,0,0,0,0,0,0")
    assert (not e0["running"] and not e0["has_program"]
            and not e0["nvs_stored"]), e0
    eb = parse_line("$EB,V0IB...")
    assert eb == {"type": "eca_bytecode", "base64": "V0IB..."}, eb

    assert parse_line("garbage") is None
    assert parse_line("") is None
    assert parse_line("$H,onlyone") is None
    assert parse_line("$S,uid,notanint,0.1") is None
    assert parse_line("$Z,uid") is None  # unknown tag

    print("[wb_protocol] parse_line self-test OK")


if __name__ == "__main__":
    _selftest()
