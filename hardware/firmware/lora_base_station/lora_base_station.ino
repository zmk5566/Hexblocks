/*
 * WearBlocks LoRa Base Station v1
 * Target: ESP32-S3 + SX1262 + Wi-Fi
 *
 * Receives raw LoRa logger batches, uploads them to an HTTP API, and ACKs
 * only after a successful 2xx POST. Duplicate batches are ACKed immediately
 * from a short in-memory dedupe cache.
 *
 * Dependencies:
 *   - RadioLib for SX1262
 *   - ArduinoJson
 *
 * RF defaults are CN470-like placeholders for mainland-China hardware.
 * Confirm module vendor limits and applicable SRRC requirements before
 * shipping hardware or running high duty-cycle tests.
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <RadioLib.h>
#include <WiFi.h>
#include <time.h>
#include <WearBlocksLogger.h>

// ── User configuration ──────────────────────────────────────────
static const char* WIFI_SSID = "YOUR_WIFI_SSID";
static const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
static const char* HTTP_ENDPOINT = "https://example.com/api/wearblocks/lora";
static const char* HTTP_BEARER_TOKEN = "YOUR_UPLOAD_TOKEN";
static const char* GATEWAY_ID = "hex-lora-gw-001";
static const char* NTP_SERVER = "pool.ntp.org";

// Board pin placeholders for an ESP32-S3 SX1262 base-station carrier.
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

#define WIFI_RETRY_MS 5000
#define DEDUPE_SIZE 32

SX1262 radio = new Module(LORA_NSS_PIN, LORA_DIO1_PIN, LORA_RST_PIN, LORA_BUSY_PIN);
volatile bool loraRxFlag = false;
uint32_t lastWifiAttemptMs = 0;

struct DedupeEntry {
    bool valid;
    uint32_t nodeUid;
    uint32_t bootId;
    uint32_t sequence;
    uint32_t lastSeenMs;
};

DedupeEntry dedupe[DEDUPE_SIZE] = {};
uint8_t dedupeCursor = 0;

void onLoRaRx() {
    loraRxFlag = true;
}

static void uidHex(uint32_t uid, char* out, size_t len) {
    snprintf(out, len, "%08lX", (unsigned long)uid);
}

static void ensureWiFi() {
    if (WiFi.status() == WL_CONNECTED) return;
    uint32_t now = millis();
    if (now - lastWifiAttemptMs < WIFI_RETRY_MS) return;
    lastWifiAttemptMs = now;
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.printf("[WIFI] connecting ssid=%s\n", WIFI_SSID);
}

static bool wifiReady() {
    ensureWiFi();
    return WiFi.status() == WL_CONNECTED;
}

static void formatReceivedAt(char* out, size_t len) {
    time_t now = time(nullptr);
    if (now < 1700000000) {
        snprintf(out, len, "ms:%lu", (unsigned long)millis());
        return;
    }
    struct tm tmv;
    gmtime_r(&now, &tmv);
    strftime(out, len, "%Y-%m-%dT%H:%M:%SZ", &tmv);
}

static bool isDuplicate(const WBLoRaBatch& batch) {
    for (const DedupeEntry& e : dedupe) {
        if (!e.valid) continue;
        if (e.nodeUid == batch.nodeUid &&
            e.bootId == batch.bootId &&
            e.sequence == batch.sequence) {
            return true;
        }
    }
    return false;
}

static void rememberBatch(const WBLoRaBatch& batch) {
    DedupeEntry& e = dedupe[dedupeCursor];
    e.valid = true;
    e.nodeUid = batch.nodeUid;
    e.bootId = batch.bootId;
    e.sequence = batch.sequence;
    e.lastSeenMs = millis();
    dedupeCursor = (uint8_t)((dedupeCursor + 1) % DEDUPE_SIZE);
}

static bool postBatch(const WBLoRaBatch& batch, float rssi, float snr) {
    if (!wifiReady()) {
        Serial.println("[HTTP] skip: Wi-Fi offline");
        return false;
    }

    char nodeUid[9];
    uidHex(batch.nodeUid, nodeUid, sizeof(nodeUid));
    char receivedAt[32];
    formatReceivedAt(receivedAt, sizeof(receivedAt));

    JsonDocument doc;
    doc["gateway_id"] = GATEWAY_ID;
    doc["node_uid"] = nodeUid;
    doc["seq"] = batch.sequence;
    doc["boot_id"] = batch.bootId;
    doc["received_at"] = receivedAt;
    doc["rssi"] = rssi;
    doc["snr"] = snr;

    JsonArray records = doc["records"].to<JsonArray>();
    for (uint8_t i = 0; i < batch.recordCount; i++) {
        const WBLoRaRecord& rec = batch.records[i];
        char sourceUid[9];
        uidHex(rec.sourceUid, sourceUid, sizeof(sourceUid));
        JsonObject row = records.add<JsonObject>();
        row["source_uid"] = sourceUid;
        row["channel_id"] = rec.channelId;
        row["type"] = wbLoggerRecordTypeName(rec.recordType);
        row["timestamp"] = rec.timestampMs;
        row["value"] = rec.value;
        row["flags"] = rec.flags;
        row["time_quality"] = (uint8_t)rec.timeQuality;
    }

    String payload;
    serializeJson(doc, payload);

    HTTPClient http;
    if (!http.begin(HTTP_ENDPOINT)) {
        Serial.println("[HTTP] begin failed");
        return false;
    }
    http.addHeader("Content-Type", "application/json");
    if (HTTP_BEARER_TOKEN && HTTP_BEARER_TOKEN[0]) {
        String auth = "Bearer ";
        auth += HTTP_BEARER_TOKEN;
        http.addHeader("Authorization", auth);
    }
    int code = http.POST(payload);
    String body = http.getString();
    http.end();

    bool ok = code >= 200 && code < 300;
    Serial.printf("[HTTP] POST node=%s seq=%lu records=%u code=%d %s\n",
                  nodeUid,
                  (unsigned long)batch.sequence,
                  (unsigned)batch.recordCount,
                  code,
                  ok ? "ok" : "fail");
    if (!ok && body.length()) {
        Serial.printf("[HTTP] body: %s\n", body.c_str());
    }
    return ok;
}

static bool sendAck(const WBLoRaBatch& batch) {
    WBLoRaAck ack = {};
    ack.nodeUid = batch.nodeUid;
    ack.sequence = batch.sequence;
    ack.gatewayTimestampMs = millis();
    ack.configRev = 0;
    ack.flags = 0;

    uint8_t tx[WB_LORA_MAX_FRAME_BYTES];
    uint16_t txLen = 0;
    if (!wbLoRaEncodeAck(ack, tx, sizeof(tx), txLen)) return false;

    radio.standby();
    int state = radio.transmit(tx, txLen);
    radio.startReceive();
    if (state != RADIOLIB_ERR_NONE) {
        Serial.printf("[LORA] ACK tx failed state=%d\n", state);
        return false;
    }
    Serial.printf("[LORA] ACK node=%08lX seq=%lu\n",
                  (unsigned long)batch.nodeUid,
                  (unsigned long)batch.sequence);
    return true;
}

static void handleBatch(const WBLoRaBatch& batch, float rssi, float snr) {
    char nodeUid[9];
    uidHex(batch.nodeUid, nodeUid, sizeof(nodeUid));

    if (isDuplicate(batch)) {
        Serial.printf("[LORA] duplicate node=%s boot=%lu seq=%lu; re-ack\n",
                      nodeUid,
                      (unsigned long)batch.bootId,
                      (unsigned long)batch.sequence);
        sendAck(batch);
        return;
    }

    Serial.printf("[LORA] batch node=%s boot=%lu seq=%lu records=%u rssi=%.1f snr=%.1f\n",
                  nodeUid,
                  (unsigned long)batch.bootId,
                  (unsigned long)batch.sequence,
                  (unsigned)batch.recordCount,
                  rssi,
                  snr);

    if (!postBatch(batch, rssi, snr)) {
        Serial.println("[LORA] upload failed; no ACK so node retries");
        return;
    }

    rememberBatch(batch);
    sendAck(batch);
}

static bool initRadio() {
    int state = radio.begin(LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_CR,
                            LORA_SYNC_WORD, LORA_POWER_DBM, LORA_PREAMBLE_LEN);
    if (state != RADIOLIB_ERR_NONE) {
        Serial.printf("[LORA] init failed state=%d\n", state);
        return false;
    }
    radio.setDio1Action(onLoRaRx);
    state = radio.startReceive();
    if (state != RADIOLIB_ERR_NONE) {
        Serial.printf("[LORA] startReceive failed state=%d\n", state);
        return false;
    }
    Serial.printf("[LORA] listening %.1f MHz BW=%.0f SF=%d CR=4/%d\n",
                  LORA_FREQ_MHZ, LORA_BW_KHZ, LORA_SF, LORA_CR);
    return true;
}

static void processLoRa() {
    if (!loraRxFlag) return;
    loraRxFlag = false;

    uint8_t rx[WB_LORA_MAX_FRAME_BYTES];
    size_t len = radio.getPacketLength();
    if (len == 0 || len > sizeof(rx)) {
        radio.startReceive();
        return;
    }

    int state = radio.readData(rx, len);
    float rssi = radio.getRSSI();
    float snr = radio.getSNR();
    radio.startReceive();
    if (state != RADIOLIB_ERR_NONE) {
        Serial.printf("[LORA] rx read failed state=%d\n", state);
        return;
    }

    WBLoRaBatch batch;
    if (!wbLoRaDecodeBatch(rx, (uint16_t)len, batch)) {
        Serial.printf("[LORA] bad frame len=%u rssi=%.1f snr=%.1f\n",
                      (unsigned)len, rssi, snr);
        return;
    }
    handleBatch(batch, rssi, snr);
}

void setup() {
    Serial.begin(115200);
    delay(500);
    pinMode(STATUS_LED, OUTPUT);
    digitalWrite(STATUS_LED, HIGH);

    Serial.println();
    Serial.println("WearBlocks LoRa Base Station v1");

    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    configTime(0, 0, NTP_SERVER);

    if (!initRadio()) {
        while (1) {
            digitalWrite(STATUS_LED, !digitalRead(STATUS_LED));
            delay(250);
        }
    }

    digitalWrite(STATUS_LED, LOW);
}

void loop() {
    ensureWiFi();
    processLoRa();
    delay(2);
}
