#ifndef WEARBLOCKS_PROTOCOL_H
#define WEARBLOCKS_PROTOCOL_H

#include <Arduino.h>
#include "WearBlocksCAN.h"
#include "WearBlocksDescriptor.h"

// --- CAN Message ID Ranges ---
enum WBMessageType : uint32_t {
    WB_MSG_HELLO            = 0x010,
    WB_MSG_DESCRIBE_REQ     = 0x020,
    WB_MSG_DESCRIBE_RSP     = 0x030,  // 0x030-0x03B per-slot (1..12), chunked
    WB_MSG_ACK              = 0x040,
    WB_MSG_HEARTBEAT        = 0x050,
    WB_MSG_CHILD_EVENT_BASE = 0x060,  // 0x060-0x07F: module reports child dock/undock
    WB_MSG_TOPIC_ENABLE     = 0x080,
    WB_MSG_TOPIC_DISABLE    = 0x081,
    WB_MSG_GOODBYE          = 0x0F0,
    WB_MSG_SENSOR_BASE      = 0x100,  // 0x100-0x1FF per module
    WB_MSG_ACTUATOR_BASE    = 0x200,  // 0x200-0x2FF per module: EXECUTE
    WB_MSG_ACT_CFG_BASE     = 0x300,  // 0x300-0x3FF per module: CONFIG
};

// --- HELLO frame (8 bytes) ---
// v2 layout: module identity + descriptor-cache key.
// face is NOT sent — modules always attach via their fixed P-face (face 1),
// and the hub derives which parent.face this is via its pendingAttach FIFO.
struct HelloMessage {
    uint32_t uid;           // efuse MAC low 32 bits — stable module identity
    uint16_t fwHash;        // CRC16 of descriptor bytes — cache key for hub
    uint8_t  flags;         // bit0: hasChildDocked (debug / sanity only)
    uint8_t  reserved;
};

// --- ACK frame (6 bytes) ---
// Module filters by uid (slot may still be 0 on first registration).
struct AckMessage {
    uint32_t uid;
    uint8_t  assignedSlot;
    uint8_t  descriptorCached;   // 1 → module skips sendDescriptor
};

// --- Sensor frame layout (unchanged) ---
// byte 0: channelId (0..47)   byte 1: seq   bytes 2-5: float32

// --- Callbacks ---
typedef void (*WBHelloCallback)(const HelloMessage& msg);
typedef void (*WBSensorDataCallback)(uint32_t sourceCanId, uint8_t channelId,
                                     const uint8_t* payload, uint8_t payloadLen);
typedef void (*WBActuatorCmdCallback)(uint8_t cmd, const uint8_t* params, uint8_t paramLen);
typedef void (*WBActuatorCfgCallback)(const uint8_t* params, uint8_t paramLen);
typedef void (*WBDescriptorCallback)(uint8_t sourceSlot, const WearBlocksDescriptor& desc);
typedef void (*WBDescriptorRequestCallback)();
typedef void (*WBAckCallback)(uint8_t assignedSlot, uint32_t uid, bool descriptorCached);
typedef void (*WBTopicCallback)(uint8_t channelId, bool enable);
typedef void (*WBChildEventCallback)(uint8_t sourceSlot, uint8_t childFace, bool occupied);

#define WB_DESC_SESSIONS 4  // concurrent reassembly sessions (LRU)

class WearBlocksProtocol {
public:
    WearBlocksProtocol();

    void begin(WearBlocksCAN& can, bool isHub, uint8_t moduleSlot = 0);

    // --- Module-side API ---
    void sendHello(uint32_t uid, uint16_t fwHash, uint8_t flags = 0);
    void sendSensorChannel(uint8_t channelId, float value);
    void sendDescriptor(const WearBlocksDescriptor& desc);
    void sendGoodbye();
    void sendChildEvent(uint8_t childFace, bool occupied);

    // --- Hub-side API ---
    void requestDescriptor(uint8_t moduleSlot);
    void sendActuatorConfig(uint8_t moduleSlot, const uint8_t* params, uint8_t paramLen);
    void sendActuatorCommand(uint8_t moduleSlot, uint8_t cmd,
                             const uint8_t* params, uint8_t paramLen);
    void sendAck(uint8_t moduleSlot, uint32_t uid, bool descriptorCached);

    // --- Topic control ---
    void sendTopicEnable(uint8_t moduleSlot, uint8_t channelId);
    void sendTopicDisable(uint8_t moduleSlot, uint8_t channelId);
    void sendTopicEnableAll(uint8_t moduleSlot);

    // --- Both ---
    void sendHeartbeat();
    void processIncoming();

    void setHeartbeatInterval(uint32_t ms);
    uint32_t getHeartbeatInterval() const;

    // Module-side: let the module know its assigned slot after ACK so that
    // it can emit DESCRIBE_RSP on a slot-specific CAN ID.
    void setModuleSlot(uint8_t slot) { _moduleSlot = slot; }

    // --- Register callbacks ---
    void onHello(WBHelloCallback cb);
    void onSensorData(WBSensorDataCallback cb);
    void onActuatorCommand(WBActuatorCmdCallback cb);
    void onActuatorConfig(WBActuatorCfgCallback cb);
    void onDescriptorReceived(WBDescriptorCallback cb);
    void onDescriptorRequested(WBDescriptorRequestCallback cb);
    void onAck(WBAckCallback cb);
    void onChildEvent(WBChildEventCallback cb);
    void onTopic(WBTopicCallback cb);

private:
    void handleMessage(uint32_t canId, const uint8_t* data, uint8_t len);
    uint32_t sensorCanId(uint8_t moduleSlot);
    uint32_t actuatorCanId(uint8_t moduleSlot);

    // Multi-session descriptor reassembly (hub side only).
    struct DescSession {
        bool     active;
        uint8_t  slot;
        uint32_t lastChunkMs;
        uint8_t  expectedChunks;
        uint8_t  receivedChunks;
        uint16_t bufferLen;
        uint8_t  buffer[WB_DESC_MAX_SERIALIZED];
    };
    DescSession _descSessions[WB_DESC_SESSIONS];
    DescSession* findOrAllocSession(uint8_t slot);

    WearBlocksCAN* _can;
    bool _isHub;
    uint8_t _moduleSlot;
    uint32_t _heartbeatInterval;
    uint32_t _lastHeartbeat;
    uint8_t _sensorSeq;

    WBHelloCallback _onHello;
    WBSensorDataCallback _onSensorData;
    WBActuatorCmdCallback _onActuatorCmd;
    WBActuatorCfgCallback _onActuatorCfg;
    WBDescriptorCallback _onDescriptor;
    WBDescriptorRequestCallback _onDescriptorReq;
    WBAckCallback _onAck;
    WBChildEventCallback _onChildEvent;
    WBTopicCallback _onTopic;
};

#endif
