#include "WearBlocksWireless.h"
#include <Preferences.h>

static size_t oscAlign4(size_t n) {
    return (n + 3) & ~((size_t)3);
}

static void writeU16LE(uint8_t* p, uint16_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
}

static void writeU32LE(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
    p[2] = (uint8_t)((v >> 16) & 0xFF);
    p[3] = (uint8_t)((v >> 24) & 0xFF);
}

static uint16_t readU16LE(const uint8_t* p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static uint32_t readU32LE(const uint8_t* p) {
    return (uint32_t)p[0] |
           ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static size_t boundedStrLen(const char* s, size_t maxLen) {
    size_t n = 0;
    if (!s) return 0;
    while (n < maxLen && s[n] != '\0') n++;
    return n;
}

const char* wbTransportModeName(WBTransportMode mode) {
    switch (mode) {
        case WB_TRANSPORT_CAN_ONLY: return "can_only";
        case WB_TRANSPORT_WIFI_ONLY: return "wifi_only";
        case WB_TRANSPORT_CAN_PRIMARY_WIFI_FALLBACK: return "can_primary_wifi_fallback";
        case WB_TRANSPORT_WIFI_PRIMARY_CAN_FALLBACK: return "wifi_primary_can_fallback";
        case WB_TRANSPORT_DUAL_SEND_DEBUG: return "dual_send_debug";
        default: return "can_primary_wifi_fallback";
    }
}

WBTransportMode wbTransportModeFromName(const char* name) {
    if (!name || !*name) return WB_TRANSPORT_CAN_PRIMARY_WIFI_FALLBACK;
    if (strcmp(name, "can_only") == 0) return WB_TRANSPORT_CAN_ONLY;
    if (strcmp(name, "wifi_only") == 0) return WB_TRANSPORT_WIFI_ONLY;
    if (strcmp(name, "can_primary_wifi_fallback") == 0) {
        return WB_TRANSPORT_CAN_PRIMARY_WIFI_FALLBACK;
    }
    if (strcmp(name, "wifi_primary_can_fallback") == 0) {
        return WB_TRANSPORT_WIFI_PRIMARY_CAN_FALLBACK;
    }
    if (strcmp(name, "dual_send_debug") == 0) return WB_TRANSPORT_DUAL_SEND_DEBUG;
    return WB_TRANSPORT_CAN_PRIMARY_WIFI_FALLBACK;
}

const char* wbActiveLinkName(WBActiveLink link) {
    switch (link) {
        case WB_LINK_CAN: return "can";
        case WB_LINK_WIFI: return "wifi";
        case WB_LINK_NONE:
        default: return "none";
    }
}

const char* wbTopologyStateName(WBTopologyState state) {
    return state == WB_TOPO_REMOTE_UNPLACED ? "remote_unplaced" : "physical";
}

bool wbTransportAllowsCan(WBTransportMode mode) {
    return mode != WB_TRANSPORT_WIFI_ONLY;
}

bool wbTransportAllowsWifi(WBTransportMode mode) {
    return mode != WB_TRANSPORT_CAN_ONLY;
}

uint32_t wbFnv1a32(const uint8_t* data, size_t len) {
    uint32_t h = 2166136261UL;
    for (size_t i = 0; i < len; i++) {
        h ^= data[i];
        h *= 16777619UL;
    }
    return h;
}

void wbWirelessConfigDefaults(WBWirelessConfig& cfg) {
    memset(&cfg, 0, sizeof(cfg));
    cfg.mode = WB_TRANSPORT_CAN_PRIMARY_WIFI_FALLBACK;
    cfg.port = WB_WIFI_DEFAULT_PORT;
    cfg.enabled = 0;
}

bool wbWirelessConfigEncode(const WBWirelessConfig& cfg, uint8_t* buffer,
                            uint16_t maxLen, uint16_t& outLen) {
    outLen = 0;
    if (!buffer || maxLen < 24) return false;
    size_t ssidLen = boundedStrLen(cfg.ssid, WB_WIFI_MAX_SSID_LEN);
    size_t passLen = boundedStrLen(cfg.pass, WB_WIFI_MAX_PASS_LEN);
    size_t tokenLen = boundedStrLen(cfg.token, WB_WIFI_MAX_TOKEN_LEN + 1);
    if (ssidLen >= WB_WIFI_MAX_SSID_LEN ||
        passLen >= WB_WIFI_MAX_PASS_LEN ||
        tokenLen > WB_WIFI_MAX_TOKEN_LEN) {
        return false;
    }

    size_t len = 0;
    buffer[len++] = 'W';
    buffer[len++] = 'B';
    buffer[len++] = 'W';
    buffer[len++] = 'F';
    buffer[len++] = WB_WIFI_PROFILE_VERSION;
    buffer[len++] = (uint8_t)cfg.mode;
    writeU16LE(&buffer[len], cfg.port); len += 2;
    writeU32LE(&buffer[len], cfg.hubId); len += 4;
    buffer[len++] = (uint8_t)ssidLen;
    buffer[len++] = (uint8_t)passLen;
    buffer[len++] = (uint8_t)tokenLen;
    buffer[len++] = cfg.enabled ? 1 : 0;
    if (len + ssidLen + passLen + tokenLen + 4 > maxLen) return false;
    memcpy(&buffer[len], cfg.ssid, ssidLen); len += ssidLen;
    memcpy(&buffer[len], cfg.pass, passLen); len += passLen;
    memcpy(&buffer[len], cfg.token, tokenLen); len += tokenLen;
    uint32_t crc = wbFnv1a32(buffer, len);
    writeU32LE(&buffer[len], crc); len += 4;
    outLen = (uint16_t)len;
    return true;
}

bool wbWirelessConfigDecode(const uint8_t* data, uint16_t len,
                            WBWirelessConfig& cfg) {
    if (!data || len < 20) return false;
    if (data[0] != 'W' || data[1] != 'B' || data[2] != 'W' || data[3] != 'F') {
        return false;
    }
    if (data[4] != WB_WIFI_PROFILE_VERSION) return false;
    uint32_t gotCrc = readU32LE(&data[len - 4]);
    uint32_t wantCrc = wbFnv1a32(data, len - 4);
    if (gotCrc != wantCrc) return false;

    WBWirelessConfig out;
    wbWirelessConfigDefaults(out);
    if (data[5] > WB_TRANSPORT_DUAL_SEND_DEBUG) return false;
    out.mode = (WBTransportMode)data[5];
    out.port = readU16LE(&data[6]);
    out.hubId = readU32LE(&data[8]);
    uint8_t ssidLen = data[12];
    uint8_t passLen = data[13];
    uint8_t tokenLen = data[14];
    out.enabled = data[15] ? 1 : 0;
    if (ssidLen >= WB_WIFI_MAX_SSID_LEN ||
        passLen >= WB_WIFI_MAX_PASS_LEN ||
        tokenLen > WB_WIFI_MAX_TOKEN_LEN) {
        return false;
    }
    size_t off = 16;
    if (off + ssidLen + passLen + tokenLen + 4 != len) return false;
    memcpy(out.ssid, &data[off], ssidLen); out.ssid[ssidLen] = '\0';
    off += ssidLen;
    memcpy(out.pass, &data[off], passLen); out.pass[passLen] = '\0';
    off += passLen;
    memcpy(out.token, &data[off], tokenLen); out.token[tokenLen] = '\0';
    cfg = out;
    return true;
}

bool wbWirelessConfigSave(const WBWirelessConfig& cfg, const char* nsName) {
    uint8_t buf[WB_WIFI_PROFILE_MAX_ENCODED];
    uint16_t len = 0;
    if (!wbWirelessConfigEncode(cfg, buf, sizeof(buf), len)) return false;
    Preferences prefs;
    if (!prefs.begin(nsName, false)) return false;
    size_t wrote = prefs.putBytes("profile", buf, len);
    prefs.putUShort("profile_len", len);
    prefs.end();
    return wrote == len;
}

bool wbWirelessConfigLoad(WBWirelessConfig& cfg, const char* nsName) {
    wbWirelessConfigDefaults(cfg);
    Preferences prefs;
    if (!prefs.begin(nsName, true)) return false;
    uint16_t len = prefs.getUShort("profile_len", 0);
    if (len == 0 || len > WB_WIFI_PROFILE_MAX_ENCODED) {
        prefs.end();
        return false;
    }
    uint8_t buf[WB_WIFI_PROFILE_MAX_ENCODED];
    size_t got = prefs.getBytes("profile", buf, len);
    prefs.end();
    if (got != len) return false;
    return wbWirelessConfigDecode(buf, len, cfg);
}

static bool readPaddedString(const uint8_t* data, size_t len, size_t& off,
                             char* out, size_t outLen) {
    if (off >= len || outLen == 0) return false;
    size_t start = off;
    while (off < len && data[off] != 0) off++;
    if (off >= len) return false;
    size_t n = off - start;
    if (n >= outLen) n = outLen - 1;
    memcpy(out, data + start, n);
    out[n] = '\0';
    off = oscAlign4(off + 1);
    return off <= len;
}

static bool readU32BE(const uint8_t* data, size_t len, size_t& off, uint32_t& out) {
    if (off + 4 > len) return false;
    out = ((uint32_t)data[off] << 24) |
          ((uint32_t)data[off + 1] << 16) |
          ((uint32_t)data[off + 2] << 8) |
          (uint32_t)data[off + 3];
    off += 4;
    return true;
}

bool wbOscDecode(const uint8_t* data, size_t len, WBOscMessage& msg) {
    memset(&msg, 0, sizeof(msg));
    size_t off = 0;
    if (!readPaddedString(data, len, off, msg.address, sizeof(msg.address))) return false;
    if (!readPaddedString(data, len, off, msg.tags, sizeof(msg.tags))) return false;
    if (msg.tags[0] != ',') return false;

    for (size_t ti = 1; msg.tags[ti] != '\0'; ti++) {
        if (msg.argc >= WB_OSC_MAX_ARGS) return false;
        WBOscArg& arg = msg.args[msg.argc++];
        arg.type = msg.tags[ti];
        uint32_t raw = 0;
        switch (arg.type) {
            case 'i':
                if (!readU32BE(data, len, off, raw)) return false;
                arg.i = (int32_t)raw;
                break;
            case 'f':
                if (!readU32BE(data, len, off, raw)) return false;
                memcpy(&arg.f, &raw, sizeof(float));
                break;
            case 's':
                if (!readPaddedString(data, len, off, arg.s, sizeof(arg.s))) return false;
                break;
            case 'b': {
                if (!readU32BE(data, len, off, raw)) return false;
                if (raw > 65535 || off + raw > len) return false;
                arg.b = data + off;
                arg.bLen = (uint16_t)raw;
                off = oscAlign4(off + raw);
                if (off > len) return false;
                break;
            }
            default:
                return false;
        }
    }
    return true;
}

static bool writePaddedString(WBOscEncoder& enc, const char* value) {
    if (!value) value = "";
    size_t rawLen = strlen(value) + 1;
    size_t paddedLen = oscAlign4(rawLen);
    if (enc.len + paddedLen > enc.cap) return false;
    memcpy(enc.data + enc.len, value, rawLen);
    memset(enc.data + enc.len + rawLen, 0, paddedLen - rawLen);
    enc.len += paddedLen;
    return true;
}

static bool writeU32BE(WBOscEncoder& enc, uint32_t value) {
    if (enc.len + 4 > enc.cap) return false;
    enc.data[enc.len++] = (uint8_t)((value >> 24) & 0xFF);
    enc.data[enc.len++] = (uint8_t)((value >> 16) & 0xFF);
    enc.data[enc.len++] = (uint8_t)((value >> 8) & 0xFF);
    enc.data[enc.len++] = (uint8_t)(value & 0xFF);
    return true;
}

bool wbOscStart(WBOscEncoder& enc, uint8_t* data, size_t cap,
                const char* address, const char* tags) {
    enc.data = data;
    enc.len = 0;
    enc.cap = cap;
    if (!writePaddedString(enc, address)) return false;
    char tagBuf[WB_OSC_MAX_TAGS];
    snprintf(tagBuf, sizeof(tagBuf), ",%s", tags ? tags : "");
    return writePaddedString(enc, tagBuf);
}

bool wbOscAddInt(WBOscEncoder& enc, int32_t value) {
    return writeU32BE(enc, (uint32_t)value);
}

bool wbOscAddFloat(WBOscEncoder& enc, float value) {
    uint32_t raw;
    memcpy(&raw, &value, sizeof(float));
    return writeU32BE(enc, raw);
}

bool wbOscAddString(WBOscEncoder& enc, const char* value) {
    return writePaddedString(enc, value);
}

bool wbOscAddBlob(WBOscEncoder& enc, const uint8_t* value, uint16_t len) {
    if (!writeU32BE(enc, len)) return false;
    size_t paddedLen = oscAlign4(len);
    if (enc.len + paddedLen > enc.cap) return false;
    if (len > 0 && value) memcpy(enc.data + enc.len, value, len);
    memset(enc.data + enc.len + len, 0, paddedLen - len);
    enc.len += paddedLen;
    return true;
}

// ─────────────────────────────────────────────────────────────
//  Module-side Wi-Fi runtime
// ─────────────────────────────────────────────────────────────

static const uint32_t WB_WIFI_CONNECT_RETRY_MS = 5000;
static const uint32_t WB_WIFI_HELLO_MS = 1000;
static const uint32_t WB_WIFI_HEARTBEAT_MS = 2000;

WBWirelessModule* WBWirelessModule::_instance = nullptr;

static const char* wbOscStringArg(const WBOscMessage& msg, uint8_t idx) {
    if (idx >= msg.argc || msg.args[idx].type != 's') return "";
    return msg.args[idx].s;
}

static int32_t wbOscIntArg(const WBOscMessage& msg, uint8_t idx, int32_t fallback = 0) {
    if (idx >= msg.argc || msg.args[idx].type != 'i') return fallback;
    return msg.args[idx].i;
}

WBWirelessModule::WBWirelessModule(WBModule& module,
                                   WearBlocksProtocol& protocol,
                                   WearBlocksDescriptor& descriptor)
    : _module(module),
      _protocol(protocol),
      _descriptor(descriptor),
      _udp(nullptr),
      _lastWifiAttemptMs(0),
      _lastHelloMs(0),
      _lastHeartbeatMs(0),
      _msgSeq(1),
      _sensorSeq(1),
      _begun(false),
      _wifiStarted(false),
      _udpStarted(false),
      _helloAcked(false),
      _actuatorCb(nullptr),
      _topicCb(nullptr) {
    wbWirelessConfigDefaults(_config);
    _instance = this;
}

void WBWirelessModule::begin() {
    static WiFiUDP udp;
    _udp = &udp;
    wbWirelessConfigLoad(_config);
    _protocol.onSysConfig(&WBWirelessModule::_sysConfigThunk);
    _begun = true;
    ensureWifiStarted();
}

void WBWirelessModule::onActuatorCommand(WBWirelessActuatorCallback cb) {
    _actuatorCb = cb;
    _protocol.onActuatorCommand(&WBWirelessModule::_actuatorThunk);
}

void WBWirelessModule::onTopic(WBWirelessTopicCallback cb) {
    _topicCb = cb;
    _protocol.onTopic(&WBWirelessModule::_topicThunk);
}

bool WBWirelessModule::wifiReady() const {
    return _begun && _udpStarted && _config.enabled &&
           wbTransportAllowsWifi(_config.mode) &&
           WiFi.status() == WL_CONNECTED;
}

bool WBWirelessModule::runtimeReady() const {
    return _module.registered() || wifiReady();
}

void WBWirelessModule::tick() {
    ensureWifiStarted();
    processUdp();
    if (!wifiReady()) return;

    uint32_t now = millis();
    if (!_helloAcked && now - _lastHelloMs >= WB_WIFI_HELLO_MS) {
        _lastHelloMs = now;
        sendHello();
    }
    if (now - _lastHeartbeatMs >= WB_WIFI_HEARTBEAT_MS) {
        _lastHeartbeatMs = now;
        sendHeartbeat();
    }
}

bool WBWirelessModule::sendSensorChannel(uint8_t channelId, float value) {
    bool sent = false;
    bool canOk = false;
    switch (_config.mode) {
        case WB_TRANSPORT_CAN_ONLY:
            return _module.registered() ?
                   _protocol.sendSensorChannel(channelId, value) : false;

        case WB_TRANSPORT_WIFI_ONLY:
            return sendWifiSensor(channelId, value);

        case WB_TRANSPORT_WIFI_PRIMARY_CAN_FALLBACK:
            if (wifiReady()) sent = sendWifiSensor(channelId, value);
            if (!sent && _module.registered()) {
                sent = _protocol.sendSensorChannel(channelId, value);
            }
            return sent;

        case WB_TRANSPORT_DUAL_SEND_DEBUG:
            if (_module.registered()) {
                sent = _protocol.sendSensorChannel(channelId, value) || sent;
            }
            sent = sendWifiSensor(channelId, value) || sent;
            return sent;

        case WB_TRANSPORT_CAN_PRIMARY_WIFI_FALLBACK:
        default:
            if (_module.registered()) {
                canOk = _protocol.sendSensorChannel(channelId, value);
                sent = canOk || sent;
            }
            if (!canOk) {
                sent = sendWifiSensor(channelId, value) || sent;
            }
            return sent;
    }
}

void WBWirelessModule::handleSysConfig(const uint8_t* payload, uint16_t payloadLen,
                                       uint8_t sessionId) {
    WBWirelessConfig next;
    if (!wbWirelessConfigDecode(payload, payloadLen, next)) {
        _protocol.sendSysConfigAck(10, sessionId);
        return;
    }
    _config = next;
    bool saved = wbWirelessConfigSave(_config);
    _helloAcked = false;
    _udpStarted = false;
    _wifiStarted = false;
    WiFi.disconnect(true);
    ensureWifiStarted();
    _protocol.sendSysConfigAck(saved ? 0 : 11, sessionId);
    Serial.printf("[WB-WIFI] config mode=%s ssid=%s port=%u saved=%d\n",
                  wbTransportModeName(_config.mode), _config.ssid,
                  (unsigned)_config.port, saved ? 1 : 0);
}

void WBWirelessModule::handleCanActuator(uint8_t cmd, const uint8_t* params,
                                         uint8_t paramLen) {
    if (_actuatorCb) _actuatorCb(cmd, params, paramLen);
}

void WBWirelessModule::handleCanTopic(uint8_t channelId, bool enable) {
    if (_topicCb) _topicCb(channelId, enable);
}

void WBWirelessModule::_sysConfigThunk(const uint8_t* payload, uint16_t payloadLen,
                                       uint8_t sessionId) {
    if (_instance) _instance->handleSysConfig(payload, payloadLen, sessionId);
}

void WBWirelessModule::_actuatorThunk(uint8_t cmd, const uint8_t* params,
                                      uint8_t paramLen) {
    if (_instance) _instance->handleCanActuator(cmd, params, paramLen);
}

void WBWirelessModule::_topicThunk(uint8_t channelId, bool enable) {
    if (_instance) _instance->handleCanTopic(channelId, enable);
}

void WBWirelessModule::ensureWifiStarted() {
    if (!_begun || !_udp) return;
    if (!_config.enabled || !wbTransportAllowsWifi(_config.mode) || !_config.ssid[0]) {
        return;
    }

    if (WiFi.status() == WL_CONNECTED) {
        if (!_udpStarted) {
            _udpStarted = _udp->begin(_config.port) == 1;
            if (_udpStarted) {
                Serial.printf("[WB-WIFI] connected ssid=%s ip=%s port=%u\n",
                              _config.ssid, WiFi.localIP().toString().c_str(),
                              (unsigned)_config.port);
                _lastHelloMs = 0;
                _lastHeartbeatMs = 0;
            }
        }
        return;
    }

    uint32_t now = millis();
    if (!_wifiStarted || now - _lastWifiAttemptMs >= WB_WIFI_CONNECT_RETRY_MS) {
        _lastWifiAttemptMs = now;
        _wifiStarted = true;
        _udpStarted = false;
        _helloAcked = false;
        WiFi.mode(WIFI_STA);
        WiFi.begin(_config.ssid, _config.pass);
        Serial.printf("[WB-WIFI] connecting ssid=%s\n", _config.ssid);
    }
}

void WBWirelessModule::processUdp() {
    if (!wifiReady() || !_udp) return;
    int packetLen = _udp->parsePacket();
    while (packetLen > 0) {
        if ((size_t)packetLen > sizeof(_rxBuf)) {
            while (_udp->available()) _udp->read();
        } else {
            int n = _udp->read(_rxBuf, sizeof(_rxBuf));
            if (n > 0) {
                WBOscMessage msg;
                if (wbOscDecode(_rxBuf, (size_t)n, msg)) {
                    processOsc(msg, _udp->remoteIP(), _udp->remotePort());
                }
            }
        }
        packetLen = _udp->parsePacket();
    }
}

void WBWirelessModule::processOsc(const WBOscMessage& msg, IPAddress, uint16_t) {
    const char* addr = msg.address;
    const char* uid = wbOscStringArg(msg, 0);
    char myUid[9];
    uidHex(myUid, sizeof(myUid));

    if (strcmp(addr, "/wb/ack") == 0) {
        int32_t msgId = wbOscIntArg(msg, 1);
        const char* status = wbOscStringArg(msg, 2);
        (void)msgId;
        if (strcmp(uid, myUid) == 0 && strcmp(status, "hello") == 0) {
            _helloAcked = true;
        }
        return;
    }

    if (strcmp(addr, "/wb/nack") == 0) return;

    if (strcmp(uid, myUid) != 0) return;

    if (strcmp(addr, "/wb/descriptor/request") == 0) {
        int32_t msgId = wbOscIntArg(msg, 2);
        if (!tokenOk(msg, 3)) {
            sendNack("bad_token", msgId);
            return;
        }
        sendDescriptorBlob(msgId);
        return;
    }

    if (strcmp(addr, "/wb/action") == 0) {
        int32_t cmd = wbOscIntArg(msg, 1);
        int32_t msgId = wbOscIntArg(msg, 2);
        int32_t paramLen = wbOscIntArg(msg, 3);
        if (msg.argc < 6 || msg.args[4].type != 'b' || !tokenOk(msg, 5)) {
            sendNack("bad_action", msgId);
            return;
        }
        uint8_t n = msg.args[4].bLen;
        if (paramLen >= 0 && paramLen < n) n = (uint8_t)paramLen;
        if (_actuatorCb) _actuatorCb((uint8_t)cmd, msg.args[4].b, n);
        sendAck("action", msgId);
        return;
    }

    if (strcmp(addr, "/wb/topic") == 0) {
        int32_t ch = wbOscIntArg(msg, 1);
        int32_t enable = wbOscIntArg(msg, 2);
        int32_t msgId = wbOscIntArg(msg, 3);
        if (!tokenOk(msg, 4)) {
            sendNack("bad_token", msgId);
            return;
        }
        if (_topicCb) _topicCb((uint8_t)ch, enable != 0);
        sendAck("topic", msgId);
        return;
    }
}

bool WBWirelessModule::sendOsc(const uint8_t* data, size_t len) {
    if (!wifiReady() || !_udp || !data || len == 0) return false;
    IPAddress host = WiFi.gatewayIP();
    if ((uint32_t)host == 0) host = IPAddress(192, 168, 4, 1);
    if (!_udp->beginPacket(host, _config.port)) return false;
    _udp->write(data, len);
    return _udp->endPacket() == 1;
}

bool WBWirelessModule::sendHello() {
    char uid[9];
    uidHex(uid, sizeof(uid));
    WBOscEncoder enc;
    if (!wbOscStart(enc, _txBuf, sizeof(_txBuf), "/wb/module/hello", "sisis")) {
        return false;
    }
    if (!wbOscAddString(enc, uid)) return false;
    if (!wbOscAddInt(enc, _module.fwHash())) return false;
    if (!wbOscAddString(enc, wbTransportModeName(_config.mode))) return false;
    if (!wbOscAddInt(enc, _msgSeq++)) return false;
    if (!wbOscAddString(enc, _config.token)) return false;
    return sendOsc(enc.data, enc.len);
}

bool WBWirelessModule::sendHeartbeat() {
    char uid[9];
    uidHex(uid, sizeof(uid));
    WBOscEncoder enc;
    if (!wbOscStart(enc, _txBuf, sizeof(_txBuf), "/wb/module/heartbeat", "siss")) {
        return false;
    }
    if (!wbOscAddString(enc, uid)) return false;
    if (!wbOscAddInt(enc, _msgSeq++)) return false;
    if (!wbOscAddString(enc, _module.registered() ? "can_seen" : "wifi_only")) return false;
    if (!wbOscAddString(enc, _config.token)) return false;
    return sendOsc(enc.data, enc.len);
}

bool WBWirelessModule::sendDescriptorBlob(int32_t msgId) {
    char uid[9];
    uidHex(uid, sizeof(uid));
    uint8_t descBuf[WB_DESC_MAX_SERIALIZED];
    uint16_t descLen = _descriptor.serialize(descBuf, sizeof(descBuf));
    WBOscEncoder enc;
    if (!wbOscStart(enc, _txBuf, sizeof(_txBuf), "/wb/descriptor/blob", "siibs")) {
        return false;
    }
    if (!wbOscAddString(enc, uid)) return false;
    if (!wbOscAddInt(enc, _module.fwHash())) return false;
    if (!wbOscAddInt(enc, msgId)) return false;
    if (!wbOscAddBlob(enc, descBuf, descLen)) return false;
    if (!wbOscAddString(enc, _config.token)) return false;
    return sendOsc(enc.data, enc.len);
}

bool WBWirelessModule::sendAck(const char* kind, int32_t msgId) {
    char uid[9];
    uidHex(uid, sizeof(uid));
    WBOscEncoder enc;
    if (!wbOscStart(enc, _txBuf, sizeof(_txBuf), "/wb/ack", "sis")) return false;
    if (!wbOscAddString(enc, uid)) return false;
    if (!wbOscAddInt(enc, msgId)) return false;
    if (!wbOscAddString(enc, kind ? kind : "ok")) return false;
    return sendOsc(enc.data, enc.len);
}

bool WBWirelessModule::sendNack(const char* reason, int32_t msgId) {
    char uid[9];
    uidHex(uid, sizeof(uid));
    WBOscEncoder enc;
    if (!wbOscStart(enc, _txBuf, sizeof(_txBuf), "/wb/nack", "sis")) return false;
    if (!wbOscAddString(enc, uid)) return false;
    if (!wbOscAddInt(enc, msgId)) return false;
    if (!wbOscAddString(enc, reason ? reason : "err")) return false;
    return sendOsc(enc.data, enc.len);
}

bool WBWirelessModule::sendWifiSensor(uint8_t channelId, float value) {
    if (!wifiReady()) return false;
    char uid[9];
    uidHex(uid, sizeof(uid));
    WBOscEncoder enc;
    if (!wbOscStart(enc, _txBuf, sizeof(_txBuf), "/wb/sensor", "sifis")) {
        return false;
    }
    if (!wbOscAddString(enc, uid)) return false;
    if (!wbOscAddInt(enc, channelId)) return false;
    if (!wbOscAddFloat(enc, value)) return false;
    if (!wbOscAddInt(enc, (int32_t)_sensorSeq++)) return false;
    if (!wbOscAddString(enc, _config.token)) return false;
    return sendOsc(enc.data, enc.len);
}

bool WBWirelessModule::tokenOk(const WBOscMessage& msg, uint8_t idx) const {
    const char* token = wbOscStringArg(msg, idx);
    return token[0] && strcmp(token, _config.token) == 0;
}

void WBWirelessModule::uidHex(char* out, size_t len) const {
    snprintf(out, len, "%08lX", (unsigned long)_module.uid());
}
