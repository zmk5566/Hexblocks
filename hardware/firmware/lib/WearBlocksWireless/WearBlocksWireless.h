#ifndef WEARBLOCKS_WIRELESS_H
#define WEARBLOCKS_WIRELESS_H

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <WearBlocksProtocol.h>
#include <WearBlocksModule.h>
#include <WearBlocksTransport.h>

#define WB_WIFI_DEFAULT_PORT 9000
#define WB_WIFI_MAX_TOKEN_LEN 32
#define WB_WIFI_MAX_SSID_LEN 32
#define WB_WIFI_MAX_PASS_LEN 64
#define WB_WIFI_PROFILE_VERSION 1
#define WB_WIFI_PROFILE_MAX_ENCODED 192

struct WBWirelessConfig {
    WBTransportMode mode;
    uint32_t hubId;
    char ssid[WB_WIFI_MAX_SSID_LEN];
    char pass[WB_WIFI_MAX_PASS_LEN];
    char token[WB_WIFI_MAX_TOKEN_LEN + 1];
    uint16_t port;
    uint8_t enabled;
};

uint32_t wbFnv1a32(const uint8_t* data, size_t len);

void wbWirelessConfigDefaults(WBWirelessConfig& cfg);
bool wbWirelessConfigEncode(const WBWirelessConfig& cfg, uint8_t* buffer,
                            uint16_t maxLen, uint16_t& outLen);
bool wbWirelessConfigDecode(const uint8_t* data, uint16_t len,
                            WBWirelessConfig& cfg);
bool wbWirelessConfigSave(const WBWirelessConfig& cfg,
                          const char* nsName = "wbwifi");
bool wbWirelessConfigLoad(WBWirelessConfig& cfg,
                          const char* nsName = "wbwifi");

// Minimal OSC 1.0 decoder/encoder for WearBlocks UDP packets.
// Supported argument tags: i, f, s, b.
#define WB_OSC_MAX_ADDRESS 48
#define WB_OSC_MAX_TAGS 16
#define WB_OSC_MAX_ARGS 10
#define WB_OSC_MAX_STRING 96

struct WBOscArg {
    char type;
    int32_t i;
    float f;
    char s[WB_OSC_MAX_STRING];
    const uint8_t* b;
    uint16_t bLen;
};

struct WBOscMessage {
    char address[WB_OSC_MAX_ADDRESS];
    char tags[WB_OSC_MAX_TAGS];
    uint8_t argc;
    WBOscArg args[WB_OSC_MAX_ARGS];
};

bool wbOscDecode(const uint8_t* data, size_t len, WBOscMessage& msg);

struct WBOscEncoder {
    uint8_t* data;
    size_t len;
    size_t cap;
};

bool wbOscStart(WBOscEncoder& enc, uint8_t* data, size_t cap,
                const char* address, const char* tags);
bool wbOscAddInt(WBOscEncoder& enc, int32_t value);
bool wbOscAddFloat(WBOscEncoder& enc, float value);
bool wbOscAddString(WBOscEncoder& enc, const char* value);
bool wbOscAddBlob(WBOscEncoder& enc, const uint8_t* value, uint16_t len);

typedef void (*WBWirelessActuatorCallback)(uint8_t cmd, const uint8_t* params,
                                           uint8_t paramLen);
typedef void (*WBWirelessTopicCallback)(uint8_t channelId, bool enable);

class WBWirelessModule {
public:
    WBWirelessModule(WBModule& module,
                     WearBlocksProtocol& protocol,
                     WearBlocksDescriptor& descriptor);

    void begin();
    void tick();

    bool sendSensorChannel(uint8_t channelId, float value);

    void onActuatorCommand(WBWirelessActuatorCallback cb);
    void onTopic(WBWirelessTopicCallback cb);

    bool wifiReady() const;
    bool runtimeReady() const;
    const WBWirelessConfig& config() const { return _config; }

private:
    static WBWirelessModule* _instance;
    static void _sysConfigThunk(const uint8_t* payload, uint16_t payloadLen,
                                uint8_t sessionId);
    static void _actuatorThunk(uint8_t cmd, const uint8_t* params, uint8_t paramLen);
    static void _topicThunk(uint8_t channelId, bool enable);

    void handleSysConfig(const uint8_t* payload, uint16_t payloadLen,
                         uint8_t sessionId);
    void handleCanActuator(uint8_t cmd, const uint8_t* params, uint8_t paramLen);
    void handleCanTopic(uint8_t channelId, bool enable);

    void ensureWifiStarted();
    void processUdp();
    void processOsc(const WBOscMessage& msg, IPAddress ip, uint16_t port);
    bool sendOsc(const uint8_t* data, size_t len);
    bool sendHello();
    bool sendHeartbeat();
    bool sendDescriptorBlob(int32_t msgId);
    bool sendAck(const char* kind, int32_t msgId);
    bool sendNack(const char* reason, int32_t msgId);
    bool sendWifiSensor(uint8_t channelId, float value);
    bool tokenOk(const WBOscMessage& msg, uint8_t idx) const;
    void uidHex(char* out, size_t len) const;

    WBModule& _module;
    WearBlocksProtocol& _protocol;
    WearBlocksDescriptor& _descriptor;
    WBWirelessConfig _config;
    WiFiUDP* _udp;
    uint8_t _rxBuf[1024];
    uint8_t _txBuf[1024];
    uint32_t _lastWifiAttemptMs;
    uint32_t _lastHelloMs;
    uint32_t _lastHeartbeatMs;
    uint16_t _msgSeq;
    uint32_t _sensorSeq;
    bool _begun;
    bool _wifiStarted;
    bool _udpStarted;
    bool _helloAcked;
    WBWirelessActuatorCallback _actuatorCb;
    WBWirelessTopicCallback _topicCb;
};

#endif
