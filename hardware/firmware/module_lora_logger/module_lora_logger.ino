/*
 * WearBlocks LoRa Logger v1
 * Target: ESP32-S3 + SX1262 + CAN transceiver
 *
 * v1 is a raw LoRa star-network logger. The module is still a normal
 * WearBlocks module on CAN: the hub discovers it, sends a logger
 * subscription profile over chunked SYS_CONFIG, and uses LOG_RECORD for
 * records that are not visible on CAN. Sensor frames from CAN modules are
 * passively sniffed and filtered locally by explicit allowlist.
 *
 * The SX1262 uplink uses RadioLib. Batches are kept in LittleFS until the
 * LoRa base station uploads them and returns an ACK for the batch sequence.
 */

#include <Arduino.h>
#include <LittleFS.h>
#include <RadioLib.h>
#include <esp_system.h>
#include <math.h>
#include <WearBlocksCAN.h>
#include <WearBlocksDescriptor.h>
#include <WearBlocksLogger.h>
#include <WearBlocksModule.h>
#include <WearBlocksProtocol.h>

#define FW_VERSION "1.0"

// Board pin placeholders for an ESP32-S3 logger carrier. Update these to
// the final PCB pinout before hardware bring-up.
#define CAN_TX_PIN 7
#define CAN_RX_PIN 6
#define STATUS_LED 9

#define LORA_NSS_PIN 10
#define LORA_DIO1_PIN 11
#define LORA_RST_PIN 12
#define LORA_BUSY_PIN 13
#define LORA_FREQ_MHZ 470.3
#define LORA_BW_KHZ 125.0
#define LORA_SF 9
#define LORA_CR 7
#define LORA_SYNC_WORD 0x12
#define LORA_POWER_DBM 14
#define LORA_PREAMBLE_LEN 8
#define LORA_ACK_TIMEOUT_MS 2500
#define LORA_UPLOAD_INTERVAL_MS 3000
#define LORA_BATCH_RECORD_LIMIT 8

#define LOG_PATH "/lora-log.bin"
#define LOG_TMP_PATH "/lora-log.tmp"
#define LOG_MAX_BYTES (512UL * 1024UL)

WearBlocksCAN can;
WearBlocksProtocol protocol;
WearBlocksDescriptor descriptor;
WBModule module(can, protocol, descriptor);
SX1262 lora = new Module(LORA_NSS_PIN, LORA_DIO1_PIN, LORA_RST_PIN, LORA_BUSY_PIN);

struct StoredLogRecord {
    uint32_t sourceUid;
    uint32_t timestampMs;
    uint32_t bootId;
    uint8_t channelId;
    uint8_t recordType;
    uint8_t flags;
    uint8_t timeQuality;
    float value;
};

struct SourceSlotMap {
    uint8_t slot;
    uint32_t uid;
    uint32_t lastSeenMs;
};

WBLoggerProfile profile;
WBLoggerStatus status;
SourceSlotMap sourceMaps[12] = {};
float lastValues[WB_LOGGER_PROFILE_MAX_SUBS] = {};
uint32_t lastEmitMs[WB_LOGGER_PROFILE_MAX_SUBS] = {};
bool lastValueValid[WB_LOGGER_PROFILE_MAX_SUBS] = {};
uint32_t bootId = 0;
uint32_t nextBatchSequence = 1;
uint32_t lastStatusPrintMs = 0;
uint32_t lastUploadAttemptMs = 0;
bool loraReady = false;
volatile bool loraRxFlag = false;

void onLoRaRx() {
    loraRxFlag = true;
}

static void setupDescriptor() {
    memset(&descriptor, 0, sizeof(descriptor));
    strlcpy(descriptor.moduleId, "loralogv1", sizeof(descriptor.moduleId));
    strlcpy(descriptor.name, "LoRa Logger", sizeof(descriptor.name));
    strlcpy(descriptor.category, "wireless_uplink", sizeof(descriptor.category));
    strlcpy(descriptor.color, "#4FA7A1", sizeof(descriptor.color));
    strlcpy(descriptor.version, FW_VERSION, sizeof(descriptor.version));

    descriptor.numCapabilities = 2;
    WBCapability& radio = descriptor.capabilities[0];
    strlcpy(radio.type, "transport", sizeof(radio.type));
    strlcpy(radio.modality, "lora_uplink", sizeof(radio.modality));
    radio.axes = 1;
    radio.rangeMin = 0;
    radio.rangeMax = 1;
    radio.resolution = 1;
    strlcpy(radio.dataType, "batch", sizeof(radio.dataType));

    WBCapability& logger = descriptor.capabilities[1];
    strlcpy(logger.type, "logger", sizeof(logger.type));
    strlcpy(logger.modality, "batch_log", sizeof(logger.modality));
    logger.axes = 1;
    logger.rangeMin = 0;
    logger.rangeMax = WB_LOGGER_PROFILE_MAX_SUBS;
    logger.resolution = 1;
    strlcpy(logger.dataType, "record_batch", sizeof(logger.dataType));

    descriptor.numAffordances = 3;
    strlcpy(descriptor.affordances[0], "log_sensor_topics", 24);
    strlcpy(descriptor.affordances[1], "uplink_batches", 24);
    strlcpy(descriptor.affordances[2], "cache_offline", 24);

    descriptor.power.voltage = 3.3f;
    descriptor.power.currentTypical = 38.0f;
    descriptor.power.currentPeak = 140.0f;
    descriptor.physical.weight = 8.0f;
    descriptor.physical.dimensions[0] = 28.0f;
    descriptor.physical.dimensions[1] = 28.0f;
    descriptor.physical.dimensions[2] = 8.0f;
    descriptor.physical.numPlacements = 2;
    strlcpy(descriptor.physical.placements[0], "belt", 16);
    strlcpy(descriptor.physical.placements[1], "backpack", 16);

    descriptor.numConfigFields = 1;
    strlcpy(descriptor.configFields[0].key, "logger_profile",
            sizeof(descriptor.configFields[0].key));
    strlcpy(descriptor.configFields[0].type, "bytes",
            sizeof(descriptor.configFields[0].type));
    strlcpy(descriptor.configFields[0].defaultValue, "empty",
            sizeof(descriptor.configFields[0].defaultValue));
    strlcpy(descriptor.configFields[0].label, "Forward topics",
            sizeof(descriptor.configFields[0].label));
}

static void updateSlotMap(uint8_t slot, uint32_t uid) {
    if (slot == 0 || uid == 0) return;
    for (SourceSlotMap& m : sourceMaps) {
        if (m.slot == slot || m.uid == uid || m.slot == 0) {
            m.slot = slot;
            m.uid = uid;
            m.lastSeenMs = millis();
            return;
        }
    }
}

static uint32_t uidForSlot(uint8_t slot) {
    for (const SourceSlotMap& m : sourceMaps) {
        if (m.slot == slot && m.uid != 0) return m.uid;
    }
    return 0;
}

static int findSubscription(uint32_t sourceUid, uint8_t channelId,
                            uint8_t recordType) {
    for (uint8_t i = 0; i < profile.count; i++) {
        const WBLoggerSubscription& sub = profile.subscriptions[i];
        if (sub.sourceUid == sourceUid &&
            sub.channelId == channelId &&
            (uint8_t)sub.recordType == recordType) {
            return i;
        }
    }
    return -1;
}

static bool shouldEmit(uint8_t subIndex, float value, uint32_t now) {
    WBLoggerSubscription& sub = profile.subscriptions[subIndex];
    uint32_t elapsed = now - lastEmitMs[subIndex];
    switch (sub.mode) {
        case WB_LOGGER_MODE_EVENT_ONLY:
            return true;

        case WB_LOGGER_MODE_ON_CHANGE:
            if (!lastValueValid[subIndex]) return true;
            if (fabsf(value - lastValues[subIndex]) >= sub.threshold) {
                return sub.minIntervalMs == 0 || elapsed >= sub.minIntervalMs;
            }
            return false;

        case WB_LOGGER_MODE_AGGREGATE_AVG:
        case WB_LOGGER_MODE_AGGREGATE_MINMAX:
        case WB_LOGGER_MODE_LATEST_INTERVAL:
        default:
            return sub.minIntervalMs == 0 || elapsed >= sub.minIntervalMs;
    }
}

static void rotateLogIfNeeded() {
    File f = LittleFS.open(LOG_PATH, "r");
    size_t size = f ? f.size() : 0;
    if (f) f.close();
    if (size < LOG_MAX_BYTES) return;
    LittleFS.remove("/lora-log.prev");
    LittleFS.rename(LOG_PATH, "/lora-log.prev");
    status.droppedCount++;
}

static bool appendRecord(const StoredLogRecord& rec) {
    rotateLogIfNeeded();
    File f = LittleFS.open(LOG_PATH, "a");
    if (!f) {
        status.droppedCount++;
        return false;
    }
    size_t wrote = f.write((const uint8_t*)&rec, sizeof(rec));
    f.close();
    if (wrote != sizeof(rec)) {
        status.droppedCount++;
        return false;
    }
    if (status.queueDepth < 0xFFFF) status.queueDepth++;
    return true;
}

static uint16_t recalcQueueDepth() {
    File f = LittleFS.open(LOG_PATH, "r");
    if (!f) {
        status.queueDepth = 0;
        return 0;
    }
    size_t size = f.size();
    f.close();
    uint32_t count = size / sizeof(StoredLogRecord);
    status.queueDepth = count > 0xFFFF ? 0xFFFF : (uint16_t)count;
    return status.queueDepth;
}

static bool dropQueuedPrefix(uint8_t count) {
    if (count == 0) return true;
    File in = LittleFS.open(LOG_PATH, "r");
    if (!in) {
        status.queueDepth = 0;
        return true;
    }
    size_t total = in.size() / sizeof(StoredLogRecord);
    if (count >= total) {
        in.close();
        LittleFS.remove(LOG_PATH);
        status.queueDepth = 0;
        return true;
    }

    LittleFS.remove(LOG_TMP_PATH);
    File out = LittleFS.open(LOG_TMP_PATH, "w");
    if (!out) {
        in.close();
        return false;
    }
    in.seek((uint32_t)count * sizeof(StoredLogRecord), SeekSet);
    uint8_t buf[128];
    while (in.available()) {
        size_t n = in.read(buf, sizeof(buf));
        if (n == 0) break;
        if (out.write(buf, n) != n) {
            in.close();
            out.close();
            LittleFS.remove(LOG_TMP_PATH);
            return false;
        }
    }
    in.close();
    out.close();
    LittleFS.remove(LOG_PATH);
    if (!LittleFS.rename(LOG_TMP_PATH, LOG_PATH)) return false;
    recalcQueueDepth();
    return true;
}

static bool readBatchFromLog(WBLoRaBatch& batch, uint8_t& storedCount) {
    memset(&batch, 0, sizeof(batch));
    storedCount = 0;
    File f = LittleFS.open(LOG_PATH, "r");
    if (!f) {
        status.queueDepth = 0;
        return false;
    }

    uint32_t total = f.size() / sizeof(StoredLogRecord);
    status.queueDepth = total > 0xFFFF ? 0xFFFF : (uint16_t)total;
    if (total == 0) {
        f.close();
        return false;
    }

    batch.nodeUid = module.uid();
    batch.bootId = bootId;
    batch.sequence = nextBatchSequence;
    batch.flags = 0;

    while (storedCount < LORA_BATCH_RECORD_LIMIT &&
           storedCount < WB_LORA_MAX_RECORDS &&
           f.available()) {
        StoredLogRecord rec = {};
        if (f.read((uint8_t*)&rec, sizeof(rec)) != sizeof(rec)) break;
        WBLoRaRecord& out = batch.records[storedCount];
        out.sourceUid = rec.sourceUid;
        out.timestampMs = rec.timestampMs;
        out.channelId = rec.channelId;
        out.recordType = (WBLoggerRecordType)rec.recordType;
        out.flags = rec.flags;
        out.timeQuality = (WBLoggerTimeQuality)rec.timeQuality;
        out.value = rec.value;
        if (storedCount == 0) batch.baseTimestampMs = out.timestampMs;
        storedCount++;
    }
    f.close();
    batch.recordCount = storedCount;
    return storedCount > 0;
}

static void queueRecord(uint32_t sourceUid, uint8_t channelId,
                        uint8_t recordType, uint8_t flags, float value) {
    int subIndex = findSubscription(sourceUid, channelId, recordType);
    if (subIndex < 0) return;

    uint32_t now = millis();
    if (!shouldEmit((uint8_t)subIndex, value, now)) return;

    StoredLogRecord rec = {};
    rec.sourceUid = sourceUid;
    rec.timestampMs = now;
    rec.bootId = bootId;
    rec.channelId = channelId;
    rec.recordType = recordType;
    rec.flags = flags;
    rec.timeQuality = status.timeQuality;
    rec.value = value;
    if (appendRecord(rec)) {
        lastValues[subIndex] = value;
        lastValueValid[subIndex] = true;
        lastEmitMs[subIndex] = now;
    }
}

static void onSysConfig(const uint8_t* payload, uint16_t payloadLen,
                        uint8_t sessionId) {
    WBLoggerProfile next;
    if (!wbLoggerProfileDecode(payload, payloadLen, next)) {
        protocol.sendSysConfigAck(20, sessionId);
        return;
    }
    profile = next;
    memset(lastValueValid, 0, sizeof(lastValueValid));
    memset(lastEmitMs, 0, sizeof(lastEmitMs));
    status.configRev = profile.configRev;
    protocol.sendSysConfigAck(0, sessionId);
    Serial.printf("[LORA-LOG] profile rev=%lu subs=%u\n",
                  (unsigned long)profile.configRev, profile.count);
}

static void onPassiveSensor(uint32_t sourceCanId, uint8_t channelId,
                            const uint8_t* payload, uint8_t payloadLen) {
    if (payloadLen < 4) return;
    uint8_t sourceSlot = (uint8_t)(sourceCanId - WB_MSG_SENSOR_BASE);
    if (sourceSlot == module.slot()) return;
    uint32_t sourceUid = uidForSlot(sourceSlot);
    if (sourceUid == 0) return;
    float value = 0.0f;
    memcpy(&value, payload, sizeof(float));
    queueRecord(sourceUid, channelId, WB_LOGGER_RECORD_SENSOR, 0, value);
}

static void onHubRecord(uint32_t sourceUid, uint8_t channelId,
                        uint8_t recordType, uint8_t flags, float value) {
    queueRecord(sourceUid, channelId, recordType, flags, value);
}

static void onSlotUidMap(uint8_t slot, uint32_t uid) {
    updateSlotMap(slot, uid);
}

static bool initLoRaRadio() {
    int state = lora.begin(LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_CR,
                           LORA_SYNC_WORD, LORA_POWER_DBM, LORA_PREAMBLE_LEN);
    if (state != RADIOLIB_ERR_NONE) {
        Serial.printf("[LORA-LOG] radio init failed state=%d\n", state);
        return false;
    }
    lora.setDio1Action(onLoRaRx);
    lora.startReceive();
    Serial.printf("[LORA-LOG] radio ready %.1f MHz BW=%.0f SF=%d CR=4/%d\n",
                  LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_CR);
    return true;
}

static bool waitForAck(uint32_t sequence, uint32_t deadlineMs) {
    uint8_t rx[WB_LORA_MAX_FRAME_BYTES];
    while ((int32_t)(millis() - deadlineMs) < 0) {
        if (!loraRxFlag) {
            delay(10);
            continue;
        }
        loraRxFlag = false;
        size_t len = lora.getPacketLength();
        if (len == 0) {
            delay(10);
            continue;
        }
        if (len > sizeof(rx)) len = sizeof(rx);
        int state = lora.readData(rx, len);
        lora.startReceive();
        if (state != RADIOLIB_ERR_NONE) {
            delay(10);
            continue;
        }
        WBLoRaAck ack;
        if (!wbLoRaDecodeAck(rx, (uint16_t)len, ack)) continue;
        if (ack.nodeUid != module.uid() || ack.sequence != sequence) continue;
        status.lastAckMs = millis();
        status.configRev = ack.configRev ? ack.configRev : status.configRev;
        status.rssiDbm = (int16_t)lora.getRSSI();
        status.snrCentiDb = (int16_t)(lora.getSNR() * 100.0f);
        status.timeQuality = WB_LOGGER_TIME_GATEWAY_SYNC;
        return true;
    }
    return false;
}

static bool tryUploadBatch() {
    if (!loraReady || !module.registered()) return false;
    uint32_t now = millis();
    if (now - lastUploadAttemptMs < LORA_UPLOAD_INTERVAL_MS) return false;
    lastUploadAttemptMs = now;

    WBLoRaBatch batch;
    uint8_t storedCount = 0;
    if (!readBatchFromLog(batch, storedCount)) return false;

    uint8_t tx[WB_LORA_MAX_FRAME_BYTES];
    uint16_t txLen = 0;
    if (!wbLoRaEncodeBatch(batch, tx, sizeof(tx), txLen)) {
        status.droppedCount++;
        return false;
    }

    lora.standby();
    loraRxFlag = false;
    int state = lora.transmit(tx, txLen);
    lora.startReceive();
    if (state != RADIOLIB_ERR_NONE) {
        Serial.printf("[LORA-LOG] transmit failed state=%d len=%u\n",
                      state, (unsigned)txLen);
        return false;
    }

    bool acked = waitForAck(batch.sequence, millis() + LORA_ACK_TIMEOUT_MS);
    if (!acked) {
        Serial.printf("[LORA-LOG] no ack seq=%lu records=%u\n",
                      (unsigned long)batch.sequence, (unsigned)storedCount);
        return false;
    }

    if (!dropQueuedPrefix(storedCount)) {
        Serial.println("[LORA-LOG] failed to compact acked log records");
        return false;
    }
    nextBatchSequence++;
    if (nextBatchSequence == 0) nextBatchSequence = 1;
    Serial.printf("[LORA-LOG] uploaded seq=%lu records=%u remaining=%u\n",
                  (unsigned long)batch.sequence,
                  (unsigned)storedCount,
                  (unsigned)status.queueDepth);
    return true;
}

static void printStatus() {
    uint32_t now = millis();
    if (now - lastStatusPrintMs < 5000) return;
    lastStatusPrintMs = now;
    Serial.printf("[LORA-LOG] q=%u dropped=%lu rev=%lu maps=",
                  status.queueDepth,
                  (unsigned long)status.droppedCount,
                  (unsigned long)status.configRev);
    for (const SourceSlotMap& m : sourceMaps) {
        if (m.slot) Serial.printf(" %u:%08lX", m.slot, (unsigned long)m.uid);
    }
    Serial.println();
}

void setup() {
    Serial.begin(115200);
    delay(300);
    pinMode(STATUS_LED, OUTPUT);
    digitalWrite(STATUS_LED, HIGH);

    wbLoggerProfileDefaults(profile);
    memset(&status, 0, sizeof(status));
    status.rssiDbm = 0;
    status.snrCentiDb = 0;
    status.timeQuality = WB_LOGGER_TIME_HUB_SYNC;
    bootId = esp_random();

    if (!LittleFS.begin(true)) {
        Serial.println("[LORA-LOG] LittleFS mount failed");
    }
    recalcQueueDepth();

    if (!module.begin(CAN_TX_PIN, CAN_RX_PIN)) {
        Serial.println("[LORA-LOG] CAN init failed");
        while (1) delay(1000);
    }
    loraReady = initLoRaRadio();

    setupDescriptor();
    protocol.onSysConfig(onSysConfig);
    protocol.onSensorData(onPassiveSensor);
    protocol.onLoggerRecord(onHubRecord);
    protocol.onSlotUidMap(onSlotUidMap);
    module.start();

    digitalWrite(STATUS_LED, LOW);
    Serial.println("[LORA-LOG] ready");
}

void loop() {
    module.tick();
    tryUploadBatch();
    printStatus();
}
