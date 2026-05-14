#ifndef WEARBLOCKS_MODULE_H
#define WEARBLOCKS_MODULE_H

#include <Arduino.h>
#include "WearBlocksCAN.h"
#include "WearBlocksProtocol.h"
#include "WearBlocksDescriptor.h"

// WBModule — registration lifecycle wrapper for v3 modules.
//
// Owns the boilerplate every module would otherwise copy-paste from the
// IMU v2 reference: deriving the per-chip UID from the factory MAC,
// computing the descriptor fwHash for the hub's cache key, the default
// onAck / onDescriptorRequested handlers, and the HELLO retry loop until
// the hub assigns a slot.
//
// Module .ino code keeps owning everything domain-specific: the
// descriptor contents, sensor sampling, actuator handlers, topic mask,
// and child-detect (those vary too much between modules to abstract
// without picking arbitrary trade-offs).
//
// Usage:
//   WearBlocksCAN        can;
//   WearBlocksProtocol   protocol;
//   WearBlocksDescriptor descriptor;
//   WBModule             module(can, protocol, descriptor);
//
//   void setup() {
//     module.begin(CAN_TX, CAN_RX);   // CAN + protocol up, UID computed
//     setupDescriptor();              // user fills descriptor (may use module.uid())
//     module.start();                 // fwHash + first HELLO
//   }
//   void loop() {
//     module.tick();                  // processIncoming + HELLO retry
//     // ... module-specific work, gated on module.registered() if needed
//   }
//
// Only one WBModule per sketch (singleton — needed because the protocol
// layer uses C function-pointer callbacks).

typedef void (*WBAfterAckCallback)(uint8_t assignedSlot, bool descriptorCached);

class WBModule {
public:
    WBModule(WearBlocksCAN& can,
             WearBlocksProtocol& proto,
             WearBlocksDescriptor& desc);

    // Init CAN + protocol, derive UID, install default callbacks. Returns
    // false if CAN init failed (caller should hang or reset).
    bool begin(uint8_t canTx, uint8_t canRx);

    // Compute fwHash from the now-populated descriptor and send first
    // HELLO. Must be called after the .ino has filled the descriptor.
    void start();

    // Drive incoming messages and re-send HELLO every HELLO_RETRY_MS
    // until ACK'd. Call every loop().
    void tick();

    // Optional: hook for module-specific behavior after slot assignment
    // (e.g., serial print, LED pulse). Default onAck already handles
    // slot bookkeeping and protocol.setModuleSlot().
    void onAfterAck(WBAfterAckCallback cb) { _afterAckCb = cb; }

    // HELLO flags byte (bit0 = hasChildDocked, sanity only). Default 0.
    void setHelloFlags(uint8_t flags) { _helloFlags = flags; }

    uint32_t uid() const          { return _uid; }
    uint16_t fwHash() const       { return _fwHash; }
    uint8_t  slot() const         { return _slot; }
    bool     registered() const   { return _registered; }

    static const uint32_t HELLO_RETRY_MS     = 500;
    // Low-frequency keepalive after registration. Lets the hub recover
    // its registry across reboots while the module stays powered: the
    // hub's onModuleHello treats a HELLO from an already-REGISTERED UID
    // as idempotent (re-ACK only, no attach consumed), and an unknown
    // UID (because the hub forgot us) takes the first-time-insertion
    // path — where the hub's hub-face keepalive (every ~4s) keeps a
    // fresh attach in the queue and topology memory in NVS resolves
    // multi-module reboot ambiguity.
    static const uint32_t KEEPALIVE_HELLO_MS = 7000;

private:
    static WBModule* _instance;
    static void _ackThunk(uint8_t assignedSlot, uint32_t uid, bool cached);
    static void _descRequestedThunk();

    void handleAck(uint8_t assignedSlot, uint32_t uid, bool cached);
    void handleDescriptorRequested();

    static uint32_t deriveUid();
    static uint16_t crc16(const uint8_t* data, uint16_t len);

    WearBlocksCAN&        _can;
    WearBlocksProtocol&   _protocol;
    WearBlocksDescriptor& _descriptor;

    uint32_t _uid;
    uint16_t _fwHash;
    uint8_t  _slot;
    bool     _registered;
    uint32_t _lastHello;
    uint8_t  _helloFlags;
    bool     _started;

    WBAfterAckCallback _afterAckCb;
};

#endif
