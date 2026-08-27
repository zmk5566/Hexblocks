#include "WearBlocksLogger.h"

static void writeU32LE(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)(v & 0xFF);
    p[1] = (uint8_t)((v >> 8) & 0xFF);
    p[2] = (uint8_t)((v >> 16) & 0xFF);
    p[3] = (uint8_t)((v >> 24) & 0xFF);
}

static void writeU8(uint8_t*& p, uint8_t v) {
    *p++ = v;
}

static void writeU32(uint8_t*& p, uint32_t v) {
    writeU32LE(p, v);
    p += 4;
}

static void writeF32(uint8_t*& p, float v) {
    memcpy(p, &v, sizeof(float));
    p += 4;
}

static uint32_t readU32LE(const uint8_t* p) {
    return (uint32_t)p[0] |
           ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static uint8_t readU8(const uint8_t*& p) {
    return *p++;
}

static uint32_t readU32(const uint8_t*& p) {
    uint32_t v = readU32LE(p);
    p += 4;
    return v;
}

static float readF32(const uint8_t*& p) {
    float v = 0.0f;
    memcpy(&v, p, sizeof(float));
    p += 4;
    return v;
}

static void writeF32LE(uint8_t* p, float v) {
    memcpy(p, &v, sizeof(float));
}

static float readF32LE(const uint8_t* p) {
    float v = 0.0f;
    memcpy(&v, p, sizeof(float));
    return v;
}

const char* wbLoggerRecordTypeName(WBLoggerRecordType type) {
    switch (type) {
        case WB_LOGGER_RECORD_SENSOR: return "sensor";
        case WB_LOGGER_RECORD_HUB_EVENT: return "hub_event";
        case WB_LOGGER_RECORD_ECA_EVENT: return "eca_event";
        case WB_LOGGER_RECORD_TOPOLOGY_EVENT: return "topology_event";
        default: return "sensor";
    }
}

bool wbLoggerRecordTypeFromName(const char* name, WBLoggerRecordType& out) {
    if (!name || !*name) return false;
    if (strcmp(name, "sensor") == 0) {
        out = WB_LOGGER_RECORD_SENSOR;
        return true;
    }
    if (strcmp(name, "hub_event") == 0) {
        out = WB_LOGGER_RECORD_HUB_EVENT;
        return true;
    }
    if (strcmp(name, "eca_event") == 0) {
        out = WB_LOGGER_RECORD_ECA_EVENT;
        return true;
    }
    if (strcmp(name, "topology_event") == 0) {
        out = WB_LOGGER_RECORD_TOPOLOGY_EVENT;
        return true;
    }
    return false;
}

const char* wbLoggerModeName(WBLoggerMode mode) {
    switch (mode) {
        case WB_LOGGER_MODE_LATEST_INTERVAL: return "latest_interval";
        case WB_LOGGER_MODE_ON_CHANGE: return "on_change";
        case WB_LOGGER_MODE_AGGREGATE_AVG: return "aggregate_avg";
        case WB_LOGGER_MODE_AGGREGATE_MINMAX: return "aggregate_minmax";
        case WB_LOGGER_MODE_EVENT_ONLY: return "event_only";
        default: return "latest_interval";
    }
}

bool wbLoggerModeFromName(const char* name, WBLoggerMode& out) {
    if (!name || !*name) return false;
    if (strcmp(name, "latest_interval") == 0) {
        out = WB_LOGGER_MODE_LATEST_INTERVAL;
        return true;
    }
    if (strcmp(name, "on_change") == 0) {
        out = WB_LOGGER_MODE_ON_CHANGE;
        return true;
    }
    if (strcmp(name, "aggregate_avg") == 0) {
        out = WB_LOGGER_MODE_AGGREGATE_AVG;
        return true;
    }
    if (strcmp(name, "aggregate_minmax") == 0) {
        out = WB_LOGGER_MODE_AGGREGATE_MINMAX;
        return true;
    }
    if (strcmp(name, "event_only") == 0) {
        out = WB_LOGGER_MODE_EVENT_ONLY;
        return true;
    }
    return false;
}

uint32_t wbLoggerFnv1a32(const uint8_t* data, size_t len) {
    uint32_t h = 2166136261UL;
    for (size_t i = 0; i < len; i++) {
        h ^= data[i];
        h *= 16777619UL;
    }
    return h;
}

void wbLoggerProfileDefaults(WBLoggerProfile& profile) {
    memset(&profile, 0, sizeof(profile));
}

bool wbLoggerProfileIsPayload(const uint8_t* data, uint16_t len) {
    return data && len >= 16 &&
           data[0] == 'W' && data[1] == 'B' &&
           data[2] == 'L' && data[3] == 'G';
}

bool wbLoggerProfileEncode(const WBLoggerProfile& profile, uint8_t* buffer,
                           uint16_t maxLen, uint16_t& outLen) {
    outLen = 0;
    if (!buffer) return false;
    if (profile.count > WB_LOGGER_PROFILE_MAX_SUBS) return false;

    uint16_t needed = (uint16_t)(16 + ((uint16_t)profile.count * 16));
    if (needed > maxLen || needed > WB_LOGGER_PROFILE_MAX_ENCODED) return false;

    uint16_t off = 0;
    buffer[off++] = 'W';
    buffer[off++] = 'B';
    buffer[off++] = 'L';
    buffer[off++] = 'G';
    buffer[off++] = WB_LOGGER_PROFILE_VERSION;
    buffer[off++] = 0;
    writeU32LE(&buffer[off], profile.configRev); off += 4;
    buffer[off++] = profile.count;
    buffer[off++] = 0;

    for (uint8_t i = 0; i < profile.count; i++) {
        const WBLoggerSubscription& sub = profile.subscriptions[i];
        if (sub.channelId >= 48) return false;
        if (sub.recordType > WB_LOGGER_RECORD_TOPOLOGY_EVENT) return false;
        if (sub.mode > WB_LOGGER_MODE_EVENT_ONLY) return false;
        writeU32LE(&buffer[off], sub.sourceUid); off += 4;
        buffer[off++] = sub.channelId;
        buffer[off++] = (uint8_t)sub.recordType;
        buffer[off++] = (uint8_t)sub.mode;
        buffer[off++] = sub.flags;
        writeU32LE(&buffer[off], sub.minIntervalMs); off += 4;
        writeF32LE(&buffer[off], sub.threshold); off += 4;
    }

    uint32_t crc = wbLoggerFnv1a32(buffer, off);
    writeU32LE(&buffer[off], crc); off += 4;
    outLen = off;
    return true;
}

bool wbLoggerProfileDecode(const uint8_t* data, uint16_t len,
                           WBLoggerProfile& profile) {
    wbLoggerProfileDefaults(profile);
    if (!wbLoggerProfileIsPayload(data, len)) return false;
    if (data[4] != WB_LOGGER_PROFILE_VERSION) return false;
    if (len > WB_LOGGER_PROFILE_MAX_ENCODED) return false;

    uint32_t gotCrc = readU32LE(&data[len - 4]);
    uint32_t wantCrc = wbLoggerFnv1a32(data, len - 4);
    if (gotCrc != wantCrc) return false;

    uint16_t off = 6;
    profile.configRev = readU32LE(&data[off]); off += 4;
    profile.count = data[off++];
    off++;  // reserved
    if (profile.count > WB_LOGGER_PROFILE_MAX_SUBS) return false;
    if ((uint16_t)(16 + ((uint16_t)profile.count * 16)) != len) return false;

    for (uint8_t i = 0; i < profile.count; i++) {
        WBLoggerSubscription& sub = profile.subscriptions[i];
        sub.sourceUid = readU32LE(&data[off]); off += 4;
        sub.channelId = data[off++];
        sub.recordType = (WBLoggerRecordType)data[off++];
        sub.mode = (WBLoggerMode)data[off++];
        sub.flags = data[off++];
        sub.minIntervalMs = readU32LE(&data[off]); off += 4;
        sub.threshold = readF32LE(&data[off]); off += 4;
        if (sub.channelId >= 48) return false;
        if (sub.recordType > WB_LOGGER_RECORD_TOPOLOGY_EVENT) return false;
        if (sub.mode > WB_LOGGER_MODE_EVENT_ONLY) return false;
    }
    return true;
}

static bool wbLoRaHasMagic(const uint8_t* data, uint16_t len, uint8_t frameType) {
    return data && len >= 10 &&
           data[0] == 'W' && data[1] == 'B' &&
           data[2] == 'L' && data[3] == 'R' &&
           data[4] == WB_LORA_AIR_VERSION &&
           data[5] == frameType;
}

bool wbLoRaEncodeBatch(const WBLoRaBatch& batch, uint8_t* buffer,
                       uint16_t maxLen, uint16_t& outLen) {
    outLen = 0;
    if (!buffer) return false;
    if (batch.recordCount == 0 || batch.recordCount > WB_LORA_MAX_RECORDS) {
        return false;
    }
    uint16_t needed = (uint16_t)(28 + ((uint16_t)batch.recordCount * 16));
    if (needed > maxLen || needed > WB_LORA_MAX_FRAME_BYTES) return false;

    uint8_t* p = buffer;
    writeU8(p, 'W');
    writeU8(p, 'B');
    writeU8(p, 'L');
    writeU8(p, 'R');
    writeU8(p, WB_LORA_AIR_VERSION);
    writeU8(p, 1);  // batch
    writeU32(p, batch.nodeUid);
    writeU32(p, batch.bootId);
    writeU32(p, batch.sequence);
    writeU32(p, batch.baseTimestampMs);
    writeU8(p, batch.recordCount);
    writeU8(p, batch.flags);

    for (uint8_t i = 0; i < batch.recordCount; i++) {
        const WBLoRaRecord& r = batch.records[i];
        if (r.channelId >= 48) return false;
        if (r.recordType > WB_LOGGER_RECORD_TOPOLOGY_EVENT) return false;
        if (r.timeQuality > WB_LOGGER_TIME_GATEWAY_SYNC) return false;
        writeU32(p, r.sourceUid);
        writeU8(p, r.channelId);
        writeU8(p, (uint8_t)r.recordType);
        writeU32(p, r.timestampMs - batch.baseTimestampMs);
        writeU8(p, r.flags);
        writeU8(p, (uint8_t)r.timeQuality);
        writeF32(p, r.value);
    }

    uint16_t withoutCrc = (uint16_t)(p - buffer);
    uint32_t crc = wbLoggerFnv1a32(buffer, withoutCrc);
    writeU32(p, crc);
    outLen = (uint16_t)(p - buffer);
    return true;
}

bool wbLoRaDecodeBatch(const uint8_t* data, uint16_t len, WBLoRaBatch& batch) {
    memset(&batch, 0, sizeof(batch));
    if (!wbLoRaHasMagic(data, len, 1)) return false;
    if (len < 44) return false;
    if (len > WB_LORA_MAX_FRAME_BYTES) return false;
    uint32_t gotCrc = readU32LE(&data[len - 4]);
    uint32_t wantCrc = wbLoggerFnv1a32(data, len - 4);
    if (gotCrc != wantCrc) return false;

    const uint8_t* p = data + 6;
    batch.nodeUid = readU32(p);
    batch.bootId = readU32(p);
    batch.sequence = readU32(p);
    batch.baseTimestampMs = readU32(p);
    batch.recordCount = readU8(p);
    batch.flags = readU8(p);
    if (batch.recordCount == 0 || batch.recordCount > WB_LORA_MAX_RECORDS) {
        return false;
    }
    if ((uint16_t)(28 + ((uint16_t)batch.recordCount * 16)) != len) return false;

    for (uint8_t i = 0; i < batch.recordCount; i++) {
        WBLoRaRecord& r = batch.records[i];
        r.sourceUid = readU32(p);
        r.channelId = readU8(p);
        r.recordType = (WBLoggerRecordType)readU8(p);
        uint32_t delta = readU32(p);
        r.timestampMs = batch.baseTimestampMs + delta;
        r.flags = readU8(p);
        r.timeQuality = (WBLoggerTimeQuality)readU8(p);
        r.value = readF32(p);
        if (r.channelId >= 48) return false;
        if (r.recordType > WB_LOGGER_RECORD_TOPOLOGY_EVENT) return false;
        if (r.timeQuality > WB_LOGGER_TIME_GATEWAY_SYNC) return false;
    }
    return true;
}

bool wbLoRaEncodeAck(const WBLoRaAck& ack, uint8_t* buffer,
                     uint16_t maxLen, uint16_t& outLen) {
    outLen = 0;
    if (!buffer || maxLen < 28) return false;
    uint8_t* p = buffer;
    writeU8(p, 'W');
    writeU8(p, 'B');
    writeU8(p, 'L');
    writeU8(p, 'R');
    writeU8(p, WB_LORA_AIR_VERSION);
    writeU8(p, 2);  // ack
    writeU32(p, ack.nodeUid);
    writeU32(p, ack.sequence);
    writeU32(p, ack.gatewayTimestampMs);
    writeU32(p, ack.configRev);
    writeU8(p, ack.flags);
    writeU8(p, 0);
    uint32_t crc = wbLoggerFnv1a32(buffer, (size_t)(p - buffer));
    writeU32(p, crc);
    outLen = (uint16_t)(p - buffer);
    return true;
}

bool wbLoRaDecodeAck(const uint8_t* data, uint16_t len, WBLoRaAck& ack) {
    memset(&ack, 0, sizeof(ack));
    if (!wbLoRaHasMagic(data, len, 2)) return false;
    if (len != 28) return false;
    uint32_t gotCrc = readU32LE(&data[len - 4]);
    uint32_t wantCrc = wbLoggerFnv1a32(data, len - 4);
    if (gotCrc != wantCrc) return false;

    const uint8_t* p = data + 6;
    ack.nodeUid = readU32(p);
    ack.sequence = readU32(p);
    ack.gatewayTimestampMs = readU32(p);
    ack.configRev = readU32(p);
    ack.flags = readU8(p);
    return true;
}
