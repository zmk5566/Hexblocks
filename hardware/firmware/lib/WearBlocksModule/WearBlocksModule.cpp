#include "WearBlocksModule.h"
#include <esp_mac.h>

WBModule* WBModule::_instance = nullptr;

WBModule::WBModule(WearBlocksCAN& can,
                   WearBlocksProtocol& proto,
                   WearBlocksDescriptor& desc)
    : _can(can),
      _protocol(proto),
      _descriptor(desc),
      _uid(0),
      _fwHash(0),
      _slot(0),
      _registered(false),
      _lastHello(0),
      _helloFlags(0),
      _started(false),
      _afterAckCb(nullptr) {
    _instance = this;
}

bool WBModule::begin(uint8_t canTx, uint8_t canRx) {
    if (!_can.begin(canTx, canRx)) {
        return false;
    }
    _protocol.begin(_can, false, 0);
    _protocol.onAck(&WBModule::_ackThunk);
    _protocol.onDescriptorRequested(&WBModule::_descRequestedThunk);
    _uid = deriveUid();
    return true;
}

void WBModule::start() {
    uint8_t buf[WB_DESC_MAX_SERIALIZED];
    uint16_t len = _descriptor.serialize(buf, sizeof(buf));
    _fwHash = crc16(buf, len);

    _protocol.sendHello(_uid, _fwHash, _helloFlags);
    _lastHello = millis();
    _started = true;
}

void WBModule::tick() {
    _protocol.processIncoming();

    if (!_started) return;

    // Two regimes:
    //   - Pre-registration: aggressive 500ms HELLO retry until ACK lands.
    //   - Post-registration: low-frequency 7s keepalive HELLO so the hub
    //     can rebuild its registry after a hub-only reboot. The hub treats
    //     keepalive HELLOs as idempotent (re-ACK only, no attach consumed),
    //     so this costs nothing during steady-state operation.
    uint32_t now = millis();
    uint32_t period = _registered ? KEEPALIVE_HELLO_MS : HELLO_RETRY_MS;
    if (now - _lastHello >= period) {
        _lastHello = now;
        _protocol.sendHello(_uid, _fwHash, _helloFlags);
    }
}

void WBModule::handleAck(uint8_t assignedSlot, uint32_t uid, bool cached) {
    if (uid != _uid) return;             // ACK for someone else
    if (assignedSlot == 0) return;       // sanity

    bool firstAck = !_registered;
    _slot = assignedSlot;
    _registered = true;
    _protocol.setModuleSlot(_slot);

    if (firstAck && _afterAckCb) {
        _afterAckCb(_slot, cached);
    }
}

void WBModule::handleDescriptorRequested() {
    _protocol.sendDescriptor(_descriptor);
}

void WBModule::_ackThunk(uint8_t assignedSlot, uint32_t uid, bool cached) {
    if (_instance) _instance->handleAck(assignedSlot, uid, cached);
}

void WBModule::_descRequestedThunk() {
    if (_instance) _instance->handleDescriptorRequested();
}

// Per-chip UID. ESP.getEfuseMac() & 0xFFFFFFFF was unreliable: the low 32
// bits are mostly the Espressif OUI (identical on every chip) plus only
// 8 bits of per-chip uniqueness, which collided in our 2-board test.
// esp_read_mac(ESP_MAC_WIFI_STA) returns the actual 6-byte factory MAC;
// bytes 3..5 are the per-chip unique suffix (24 bits of entropy).
uint32_t WBModule::deriveUid() {
    uint8_t mac[6] = {};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    return ((uint32_t)mac[3] << 16) | ((uint32_t)mac[4] << 8) | mac[5];
}

// CRC16-CCITT — small, deterministic, good enough as a descriptor cache key.
uint16_t WBModule::crc16(const uint8_t* data, uint16_t len) {
    uint16_t crc = 0xFFFF;
    for (uint16_t i = 0; i < len; i++) {
        crc ^= ((uint16_t)data[i]) << 8;
        for (uint8_t b = 0; b < 8; b++) {
            crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021)
                                 : (uint16_t)(crc << 1);
        }
    }
    return crc;
}
