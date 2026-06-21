#include "WearBlocksProtocol.h"

#define WB_HEARTBEAT_DEFAULT_MS 1000
#define WB_DESC_CHUNK_DATA_SIZE 7
#define WB_DESC_SESSION_TIMEOUT_MS 2000

WearBlocksProtocol::WearBlocksProtocol()
    : _can(nullptr), _isHub(false), _moduleSlot(0),
      _heartbeatInterval(WB_HEARTBEAT_DEFAULT_MS), _lastHeartbeat(0),
      _sensorSeq(0),
      _onHello(nullptr), _onSensorData(nullptr), _onActuatorCmd(nullptr),
      _onActuatorCfg(nullptr),
      _onDescriptor(nullptr), _onDescriptorReq(nullptr), _onAck(nullptr),
      _onChildEvent(nullptr), _onTopic(nullptr),
      _onSysConfig(nullptr), _onSysConfigAck(nullptr) {
    for (uint8_t i = 0; i < WB_DESC_SESSIONS; i++) _descSessions[i] = {};
    _sysConfigSession = {};
}

void WearBlocksProtocol::begin(WearBlocksCAN& can, bool isHub, uint8_t moduleSlot) {
    _can = &can;
    _isHub = isHub;
    _moduleSlot = moduleSlot;
    _lastHeartbeat = millis();
    Serial.printf("[WB-PROTO] Started as %s (slot %d)\n",
                  isHub ? "HUB" : "MODULE", moduleSlot);
}

// --- Module-side ---

void WearBlocksProtocol::sendHello(uint32_t uid, uint16_t fwHash, uint8_t flags) {
    HelloMessage msg = {};
    msg.uid = uid;
    msg.fwHash = fwHash;
    msg.flags = flags;
    _can->send(WB_MSG_HELLO, (const uint8_t*)&msg, sizeof(msg));
    Serial.printf("[WB-PROTO] HELLO uid=%08lX fwHash=%04X flags=0x%02X\n",
                  (unsigned long)uid, fwHash, flags);
}

bool WearBlocksProtocol::sendSensorChannel(uint8_t channelId, float value) {
    uint8_t buf[8];
    buf[0] = channelId;
    buf[1] = _sensorSeq++;
    memcpy(&buf[2], &value, 4);
    return _can->send(sensorCanId(_moduleSlot), buf, 6);
}

void WearBlocksProtocol::sendDescriptor(const WearBlocksDescriptor& desc) {
    uint8_t serialized[WB_DESC_MAX_SERIALIZED];
    uint16_t totalLen = desc.serialize(serialized, sizeof(serialized));

    uint8_t numChunks;
    if (totalLen <= 6) {
        numChunks = 1;
    } else {
        numChunks = 1 + (uint8_t)((totalLen - 6 + WB_DESC_CHUNK_DATA_SIZE - 1)
                                   / WB_DESC_CHUNK_DATA_SIZE);
    }

    // Slot-specific CAN ID: lets hub reassemble N modules concurrently without
    // interleaving chunks of different descriptors into the same buffer.
    uint32_t rspId = WB_MSG_DESCRIBE_RSP + _moduleSlot;

    Serial.printf("[WB-PROTO] Sending descriptor: %d bytes in %d chunks (slot %d, id=0x%03lX)\n",
                  totalLen, numChunks, _moduleSlot, (unsigned long)rspId);

    uint16_t offset = 0;
    for (uint8_t i = 0; i < numChunks; i++) {
        uint8_t buf[8];
        buf[0] = i;

        bool ok;
        if (i == 0) {
            buf[1] = numChunks;
            uint8_t chunkLen = min((uint16_t)6, totalLen);
            memcpy(&buf[2], &serialized[0], chunkLen);
            ok = _can->send(rspId, buf, 2 + chunkLen);
            offset = chunkLen;
        } else {
            uint8_t chunkLen = min((uint16_t)WB_DESC_CHUNK_DATA_SIZE,
                                   (uint16_t)(totalLen - offset));
            memcpy(&buf[1], &serialized[offset], chunkLen);
            ok = _can->send(rspId, buf, 1 + chunkLen);
            offset += chunkLen;
        }
        // If a single chunk fails, the bus is either full or off. Continuing
        // to hammer it just stacks 60+ more "TX failed" lines and keeps TEC
        // pinned high. Bail out — hub's descriptor session will time out and
        // the caller (module loop) will re-attempt on the next DESCRIBE_REQ,
        // by which point WearBlocksCAN::send() will have initiated bus-off
        // recovery if needed.
        if (!ok) {
            Serial.printf("[WB-PROTO] descriptor send aborted at chunk %d/%d\n",
                          i + 1, numChunks);
            return;
        }
        delay(2);
    }
}

void WearBlocksProtocol::sendGoodbye() {
    uint8_t data[1] = {_moduleSlot};
    _can->send(WB_MSG_GOODBYE, data, 1);
    Serial.println("[WB-PROTO] GOODBYE sent");
}

void WearBlocksProtocol::sendChildEvent(uint8_t childFace, bool occupied) {
    uint32_t canId = WB_MSG_CHILD_EVENT_BASE + _moduleSlot;
    uint8_t data[2] = {childFace, (uint8_t)(occupied ? 1 : 0)};
    _can->send(canId, data, 2);
    Serial.printf("[WB-PROTO] CHILD_EVENT: my face=%d %s\n",
                  childFace, occupied ? "OCCUPIED" : "empty");
}

bool WearBlocksProtocol::sendSysConfigAck(uint8_t status, uint8_t sessionId) {
    if (_isHub || _moduleSlot == 0) return false;
    uint8_t data[3] = {_moduleSlot, status, sessionId};
    return _can->send(WB_MSG_SYS_CONFIG_ACK, data, sizeof(data));
}

// --- Hub-side ---

void WearBlocksProtocol::requestDescriptor(uint8_t moduleSlot) {
    uint8_t data[1] = {moduleSlot};
    _can->send(WB_MSG_DESCRIBE_REQ, data, 1);
    // Preallocate a reassembly session for this slot so the first chunk can
    // go straight in. Old session data for this slot is discarded.
    DescSession* s = findOrAllocSession(moduleSlot);
    if (s) {
        s->active = true;
        s->slot = moduleSlot;
        s->lastChunkMs = millis();
        s->expectedChunks = 0;
        s->receivedChunks = 0;
        s->bufferLen = 0;
    }
    Serial.printf("[WB-PROTO] Requesting descriptor from slot %d\n", moduleSlot);
}

void WearBlocksProtocol::sendActuatorConfig(uint8_t moduleSlot,
                                             const uint8_t* params, uint8_t paramLen) {
    uint8_t buf[8];
    uint8_t copyLen = min(paramLen, (uint8_t)8);
    if (copyLen > 0) memcpy(buf, params, copyLen);
    _can->send(WB_MSG_ACT_CFG_BASE + moduleSlot, buf, copyLen);
}

void WearBlocksProtocol::sendActuatorCommand(uint8_t moduleSlot, uint8_t cmd,
                                              const uint8_t* params, uint8_t paramLen) {
    uint8_t buf[8];
    buf[0] = cmd;
    uint8_t copyLen = min(paramLen, (uint8_t)7);
    if (copyLen > 0) memcpy(&buf[1], params, copyLen);
    _can->send(actuatorCanId(moduleSlot), buf, 1 + copyLen);
}

void WearBlocksProtocol::sendAck(uint8_t moduleSlot, uint32_t uid, bool descriptorCached) {
    AckMessage msg = {};
    msg.uid = uid;
    msg.assignedSlot = moduleSlot;
    msg.descriptorCached = descriptorCached ? 1 : 0;
    _can->send(WB_MSG_ACK, (const uint8_t*)&msg, sizeof(msg));
}

bool WearBlocksProtocol::sendSysConfig(uint8_t moduleSlot, const uint8_t* payload,
                                       uint16_t payloadLen, uint8_t sessionId) {
    if (!_isHub || moduleSlot == 0 || !payload || payloadLen == 0 ||
        payloadLen > WB_SYS_CONFIG_MAX_PAYLOAD) {
        return false;
    }

    uint16_t rawLen = payloadLen + 2;
    uint8_t totalChunks = (uint8_t)((rawLen + 3) / 4);
    if (totalChunks == 0) totalChunks = 1;
    if (sessionId == 0) sessionId = (uint8_t)(millis() & 0xFF);

    for (uint8_t chunk = 0; chunk < totalChunks; chunk++) {
        uint8_t data[8] = {};
        data[0] = moduleSlot;
        data[1] = chunk;
        data[2] = totalChunks;
        data[3] = sessionId;
        for (uint8_t j = 0; j < 4; j++) {
            uint16_t rawOff = (uint16_t)chunk * 4 + j;
            if (rawOff == 0) {
                data[4 + j] = (uint8_t)(payloadLen & 0xFF);
            } else if (rawOff == 1) {
                data[4 + j] = (uint8_t)((payloadLen >> 8) & 0xFF);
            } else {
                uint16_t payloadOff = rawOff - 2;
                data[4 + j] = payloadOff < payloadLen ? payload[payloadOff] : 0;
            }
        }
        if (!_can->send(WB_MSG_SYS_CONFIG, data, sizeof(data))) {
            Serial.printf("[WB-PROTO] SYS_CONFIG abort slot=%d chunk=%d/%d\n",
                          moduleSlot, chunk + 1, totalChunks);
            return false;
        }
        delay(2);
    }
    Serial.printf("[WB-PROTO] SYS_CONFIG slot=%d len=%u chunks=%u session=%u\n",
                  moduleSlot, (unsigned)payloadLen, (unsigned)totalChunks,
                  (unsigned)sessionId);
    return true;
}

// --- Topic control ---

void WearBlocksProtocol::sendTopicEnable(uint8_t moduleSlot, uint8_t channelId) {
    uint8_t data[3] = {moduleSlot, channelId, 1};
    _can->send(WB_MSG_TOPIC_ENABLE, data, 3);
    Serial.printf("[WB-PROTO] TOPIC_ENABLE slot=%d ch=%d\n", moduleSlot, channelId);
}

void WearBlocksProtocol::sendTopicDisable(uint8_t moduleSlot, uint8_t channelId) {
    uint8_t data[3] = {moduleSlot, channelId, 0};
    _can->send(WB_MSG_TOPIC_DISABLE, data, 3);
    Serial.printf("[WB-PROTO] TOPIC_DISABLE slot=%d ch=%d\n", moduleSlot, channelId);
}

void WearBlocksProtocol::sendTopicEnableAll(uint8_t moduleSlot) {
    uint8_t data[2] = {moduleSlot, 0xFF};
    _can->send(WB_MSG_TOPIC_ENABLE, data, 2);
    Serial.printf("[WB-PROTO] TOPIC_ENABLE_ALL slot=%d\n", moduleSlot);
}

// --- Both ---

void WearBlocksProtocol::sendHeartbeat() {
    uint32_t now = millis();
    if (now - _lastHeartbeat >= _heartbeatInterval) {
        uint8_t data[2] = {_isHub ? (uint8_t)0xFF : _moduleSlot,
                           (uint8_t)(now / 1000)};
        _can->send(WB_MSG_HEARTBEAT, data, 2);
        _lastHeartbeat = now;
    }
}

void WearBlocksProtocol::processIncoming() {
    uint32_t canId;
    uint8_t data[8];
    uint8_t len;

    while (_can->receive(canId, data, len, 0)) {
        handleMessage(canId, data, len);
    }

    // Reap stale descriptor sessions.
    if (_isHub) {
        uint32_t now = millis();
        for (uint8_t i = 0; i < WB_DESC_SESSIONS; i++) {
            DescSession& s = _descSessions[i];
            if (s.active && (now - s.lastChunkMs) > WB_DESC_SESSION_TIMEOUT_MS) {
                Serial.printf("[WB-PROTO] desc session slot %d timed out (%u/%u chunks)\n",
                              s.slot, s.receivedChunks, s.expectedChunks);
                s.active = false;
            }
        }
    }
}

WearBlocksProtocol::DescSession* WearBlocksProtocol::findOrAllocSession(uint8_t slot) {
    // Exact match first.
    for (uint8_t i = 0; i < WB_DESC_SESSIONS; i++) {
        if (_descSessions[i].active && _descSessions[i].slot == slot) {
            return &_descSessions[i];
        }
    }
    // Free slot next.
    for (uint8_t i = 0; i < WB_DESC_SESSIONS; i++) {
        if (!_descSessions[i].active) return &_descSessions[i];
    }
    // LRU evict.
    uint8_t oldest = 0;
    for (uint8_t i = 1; i < WB_DESC_SESSIONS; i++) {
        if (_descSessions[i].lastChunkMs < _descSessions[oldest].lastChunkMs) oldest = i;
    }
    Serial.printf("[WB-PROTO] desc session LRU evict slot %d for slot %d\n",
                  _descSessions[oldest].slot, slot);
    return &_descSessions[oldest];
}

void WearBlocksProtocol::handleMessage(uint32_t canId, const uint8_t* data, uint8_t len) {
    // HELLO (hub receives)
    if (canId == WB_MSG_HELLO && _onHello && len >= sizeof(HelloMessage)) {
        HelloMessage msg;
        memcpy(&msg, data, sizeof(msg));
        _onHello(msg);
        return;
    }

    // DESCRIBE_REQ (module receives; slot-targeted)
    if (canId == WB_MSG_DESCRIBE_REQ && _onDescriptorReq && !_isHub && len >= 1) {
        if (data[0] == _moduleSlot && _moduleSlot != 0) {
            _onDescriptorReq();
        }
        return;
    }

    // DESCRIBE_RSP (hub receives; CAN ID carries sourceSlot in low nibble)
    if (canId >= WB_MSG_DESCRIBE_RSP && canId < WB_MSG_DESCRIBE_RSP + 0x10
        && _isHub && len > 0) {
        uint8_t srcSlot = (uint8_t)(canId - WB_MSG_DESCRIBE_RSP);
        DescSession* s = findOrAllocSession(srcSlot);
        if (!s) return;
        if (!s->active || s->slot != srcSlot) {
            // Unsolicited (no prior requestDescriptor call for this slot) —
            // start a fresh session anyway so the hub isn't dependent on
            // request-reply ordering. Guards against module re-sending
            // descriptor on reboot before hub asks.
            s->active = true;
            s->slot = srcSlot;
            s->expectedChunks = 0;
            s->receivedChunks = 0;
            s->bufferLen = 0;
        }
        s->lastChunkMs = millis();

        uint8_t chunkIndex = data[0];
        if (chunkIndex == 0 && len >= 2) {
            s->expectedChunks = data[1];
            s->bufferLen = 0;
            s->receivedChunks = 0;
            uint8_t chunkLen = len - 2;
            if (chunkLen > 0 && s->bufferLen + chunkLen <= WB_DESC_MAX_SERIALIZED) {
                memcpy(&s->buffer[s->bufferLen], &data[2], chunkLen);
                s->bufferLen += chunkLen;
            }
        } else if (chunkIndex > 0) {
            uint8_t chunkLen = len - 1;
            if (s->bufferLen + chunkLen <= WB_DESC_MAX_SERIALIZED) {
                memcpy(&s->buffer[s->bufferLen], &data[1], chunkLen);
                s->bufferLen += chunkLen;
            }
        }
        s->receivedChunks++;

        if (s->expectedChunks > 0 &&
            s->receivedChunks >= s->expectedChunks && _onDescriptor) {
            WearBlocksDescriptor desc;
            if (desc.deserialize(s->buffer, s->bufferLen)) {
                _onDescriptor(s->slot, desc);
            } else {
                Serial.printf("[WB-PROTO] Descriptor parse failed (slot %d)\n", s->slot);
            }
            s->active = false;
        }
        return;
    }

    // ACK (module receives) — caller compares uid in the callback to filter.
    if (canId == WB_MSG_ACK && _onAck && !_isHub && len >= sizeof(AckMessage)) {
        AckMessage msg;
        memcpy(&msg, data, sizeof(msg));
        _onAck(msg.assignedSlot, msg.uid, msg.descriptorCached != 0);
        return;
    }

    // SYS_CONFIG (module receives; slot-targeted, chunked 4 bytes/frame).
    if (canId == WB_MSG_SYS_CONFIG && !_isHub && len >= 8) {
        uint8_t targetSlot = data[0];
        uint8_t chunkIndex = data[1];
        uint8_t totalChunks = data[2];
        uint8_t sessionId = data[3];
        if (targetSlot != _moduleSlot || _moduleSlot == 0 || totalChunks == 0) return;

        if (chunkIndex == 0) {
            _sysConfigSession = {};
            _sysConfigSession.active = true;
            _sysConfigSession.sessionId = sessionId;
            _sysConfigSession.expectedChunks = totalChunks;
        }

        SysConfigSession& s = _sysConfigSession;
        if (!s.active || s.sessionId != sessionId ||
            s.expectedChunks != totalChunks ||
            chunkIndex != s.receivedChunks) {
            return;
        }

        uint16_t rawOff = (uint16_t)chunkIndex * 4;
        if (rawOff + 4 > sizeof(s.raw)) {
            s.active = false;
            sendSysConfigAck(2, sessionId);
            return;
        }
        memcpy(&s.raw[rawOff], &data[4], 4);
        s.rawLen = rawOff + 4;
        s.receivedChunks++;

        if (s.receivedChunks >= s.expectedChunks) {
            if (s.rawLen < 2) {
                s.active = false;
                sendSysConfigAck(3, sessionId);
                return;
            }
            s.payloadLen = (uint16_t)s.raw[0] | ((uint16_t)s.raw[1] << 8);
            if (s.payloadLen == 0 ||
                s.payloadLen > WB_SYS_CONFIG_MAX_PAYLOAD ||
                s.payloadLen + 2 > s.rawLen) {
                s.active = false;
                sendSysConfigAck(4, sessionId);
                return;
            }
            if (_onSysConfig) {
                _onSysConfig(&s.raw[2], s.payloadLen, sessionId);
            } else {
                sendSysConfigAck(5, sessionId);
            }
            s.active = false;
        }
        return;
    }

    // SYS_CONFIG_ACK (hub receives)
    if (canId == WB_MSG_SYS_CONFIG_ACK && _isHub && _onSysConfigAck && len >= 3) {
        _onSysConfigAck(data[0], data[1], data[2]);
        return;
    }

    // CHILD_EVENT (hub receives)
    if (canId >= WB_MSG_CHILD_EVENT_BASE &&
        canId < WB_MSG_CHILD_EVENT_BASE + 0x20 &&
        _onChildEvent && _isHub && len >= 2) {
        uint8_t srcSlot   = (uint8_t)(canId - WB_MSG_CHILD_EVENT_BASE);
        uint8_t childFace = data[0];
        bool occupied     = data[1] != 0;
        _onChildEvent(srcSlot, childFace, occupied);
        return;
    }

    // TOPIC_ENABLE / TOPIC_DISABLE (module receives)
    if ((canId == WB_MSG_TOPIC_ENABLE || canId == WB_MSG_TOPIC_DISABLE)
        && _onTopic && !_isHub && len >= 2) {
        uint8_t targetSlot = data[0];
        if (targetSlot != _moduleSlot) return;
        bool enable = (canId == WB_MSG_TOPIC_ENABLE);
        if (len >= 3) {
            _onTopic(data[1], enable);
        } else if (data[1] == 0xFF) {
            for (uint8_t ch = 0; ch < 48; ch++) _onTopic(ch, enable);
        }
        return;
    }

    // SENSOR_DATA (hub receives)
    if (canId >= WB_MSG_SENSOR_BASE && canId < WB_MSG_ACTUATOR_BASE
        && _onSensorData && _isHub && len >= 2) {
        _onSensorData(canId, data[0], &data[2], len - 2);
        return;
    }

    // ACTUATOR_CMD (module receives EXECUTE)
    if (canId >= WB_MSG_ACTUATOR_BASE && canId < WB_MSG_ACT_CFG_BASE
        && _onActuatorCmd && !_isHub && len >= 1) {
        uint32_t myActuatorId = actuatorCanId(_moduleSlot);
        if (canId == myActuatorId) {
            _onActuatorCmd(data[0], &data[1], len - 1);
        }
        return;
    }

    // ACTUATOR_CFG (module receives CONFIG)
    if (canId >= WB_MSG_ACT_CFG_BASE && canId < WB_MSG_ACT_CFG_BASE + 0x100
        && _onActuatorCfg && !_isHub && len > 0) {
        uint32_t myCfgId = WB_MSG_ACT_CFG_BASE + _moduleSlot;
        if (canId == myCfgId) {
            _onActuatorCfg(data, len);
        }
        return;
    }
}

// --- Helpers ---

uint32_t WearBlocksProtocol::sensorCanId(uint8_t moduleSlot) {
    return WB_MSG_SENSOR_BASE + moduleSlot;
}

uint32_t WearBlocksProtocol::actuatorCanId(uint8_t moduleSlot) {
    return WB_MSG_ACTUATOR_BASE + moduleSlot;
}

void WearBlocksProtocol::setHeartbeatInterval(uint32_t ms) { _heartbeatInterval = ms; }
uint32_t WearBlocksProtocol::getHeartbeatInterval() const { return _heartbeatInterval; }

void WearBlocksProtocol::onHello(WBHelloCallback cb) { _onHello = cb; }
void WearBlocksProtocol::onSensorData(WBSensorDataCallback cb) { _onSensorData = cb; }
void WearBlocksProtocol::onActuatorCommand(WBActuatorCmdCallback cb) { _onActuatorCmd = cb; }
void WearBlocksProtocol::onActuatorConfig(WBActuatorCfgCallback cb) { _onActuatorCfg = cb; }
void WearBlocksProtocol::onDescriptorReceived(WBDescriptorCallback cb) { _onDescriptor = cb; }
void WearBlocksProtocol::onDescriptorRequested(WBDescriptorRequestCallback cb) { _onDescriptorReq = cb; }
void WearBlocksProtocol::onAck(WBAckCallback cb) { _onAck = cb; }
void WearBlocksProtocol::onChildEvent(WBChildEventCallback cb) { _onChildEvent = cb; }
void WearBlocksProtocol::onTopic(WBTopicCallback cb) { _onTopic = cb; }
void WearBlocksProtocol::onSysConfig(WBSysConfigCallback cb) { _onSysConfig = cb; }
void WearBlocksProtocol::onSysConfigAck(WBSysConfigAckCallback cb) { _onSysConfigAck = cb; }
