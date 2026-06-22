#ifndef WEARBLOCKS_LOGGER_H
#define WEARBLOCKS_LOGGER_H

#include <Arduino.h>

#define WB_LOGGER_PROFILE_VERSION 1
#define WB_LOGGER_PROFILE_MAX_SUBS 12
#define WB_LOGGER_PROFILE_MAX_ENCODED 224
#define WB_LORA_AIR_VERSION 1
#define WB_LORA_MAX_RECORDS 12
#define WB_LORA_MAX_FRAME_BYTES 255

enum WBLoggerRecordType : uint8_t {
    WB_LOGGER_RECORD_SENSOR = 0,
    WB_LOGGER_RECORD_HUB_EVENT = 1,
    WB_LOGGER_RECORD_ECA_EVENT = 2,
    WB_LOGGER_RECORD_TOPOLOGY_EVENT = 3,
};

enum WBLoggerMode : uint8_t {
    WB_LOGGER_MODE_LATEST_INTERVAL = 0,
    WB_LOGGER_MODE_ON_CHANGE = 1,
    WB_LOGGER_MODE_AGGREGATE_AVG = 2,
    WB_LOGGER_MODE_AGGREGATE_MINMAX = 3,
    WB_LOGGER_MODE_EVENT_ONLY = 4,
};

enum WBLoggerTimeQuality : uint8_t {
    WB_LOGGER_TIME_UNSYNCED = 0,
    WB_LOGGER_TIME_HUB_SYNC = 1,
    WB_LOGGER_TIME_GATEWAY_SYNC = 2,
};

struct WBLoggerSubscription {
    uint32_t sourceUid;
    uint8_t channelId;
    WBLoggerRecordType recordType;
    WBLoggerMode mode;
    uint8_t flags;
    uint32_t minIntervalMs;
    float threshold;
};

struct WBLoggerProfile {
    uint32_t configRev;
    uint8_t count;
    WBLoggerSubscription subscriptions[WB_LOGGER_PROFILE_MAX_SUBS];
};

struct WBLoggerStatus {
    uint16_t queueDepth;
    uint32_t droppedCount;
    uint32_t lastAckMs;
    int16_t rssiDbm;
    int16_t snrCentiDb;
    WBLoggerTimeQuality timeQuality;
    uint32_t configRev;
};

struct WBLoRaRecord {
    uint32_t sourceUid;
    uint32_t timestampMs;
    uint8_t channelId;
    WBLoggerRecordType recordType;
    uint8_t flags;
    WBLoggerTimeQuality timeQuality;
    float value;
};

struct WBLoRaBatch {
    uint32_t nodeUid;
    uint32_t bootId;
    uint32_t sequence;
    uint32_t baseTimestampMs;
    uint8_t flags;
    uint8_t recordCount;
    WBLoRaRecord records[WB_LORA_MAX_RECORDS];
};

struct WBLoRaAck {
    uint32_t nodeUid;
    uint32_t sequence;
    uint32_t gatewayTimestampMs;
    uint32_t configRev;
    uint8_t flags;
};

const char* wbLoggerRecordTypeName(WBLoggerRecordType type);
bool wbLoggerRecordTypeFromName(const char* name, WBLoggerRecordType& out);
const char* wbLoggerModeName(WBLoggerMode mode);
bool wbLoggerModeFromName(const char* name, WBLoggerMode& out);

uint32_t wbLoggerFnv1a32(const uint8_t* data, size_t len);
void wbLoggerProfileDefaults(WBLoggerProfile& profile);
bool wbLoggerProfileIsPayload(const uint8_t* data, uint16_t len);
bool wbLoggerProfileEncode(const WBLoggerProfile& profile, uint8_t* buffer,
                           uint16_t maxLen, uint16_t& outLen);
bool wbLoggerProfileDecode(const uint8_t* data, uint16_t len,
                           WBLoggerProfile& profile);

bool wbLoRaEncodeBatch(const WBLoRaBatch& batch, uint8_t* buffer,
                       uint16_t maxLen, uint16_t& outLen);
bool wbLoRaDecodeBatch(const uint8_t* data, uint16_t len, WBLoRaBatch& batch);
bool wbLoRaEncodeAck(const WBLoRaAck& ack, uint8_t* buffer,
                     uint16_t maxLen, uint16_t& outLen);
bool wbLoRaDecodeAck(const uint8_t* data, uint16_t len, WBLoRaAck& ack);

#endif
