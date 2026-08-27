#ifndef WEARBLOCKS_TRANSPORT_H
#define WEARBLOCKS_TRANSPORT_H

#include <Arduino.h>

// Link policy is shared metadata. Keeping it separate from the Wi-Fi runtime
// lets the wired Hub describe CAN state without pulling in WiFi/UDP headers.
enum WBTransportMode : uint8_t {
    WB_TRANSPORT_CAN_ONLY = 0,
    WB_TRANSPORT_WIFI_ONLY = 1,
    WB_TRANSPORT_CAN_PRIMARY_WIFI_FALLBACK = 2,
    WB_TRANSPORT_WIFI_PRIMARY_CAN_FALLBACK = 3,
    WB_TRANSPORT_DUAL_SEND_DEBUG = 4,
};

enum WBActiveLink : uint8_t {
    WB_LINK_NONE = 0,
    WB_LINK_CAN = 1,
    WB_LINK_WIFI = 2,
};

enum WBTopologyState : uint8_t {
    WB_TOPO_PHYSICAL = 0,
    WB_TOPO_REMOTE_UNPLACED = 1,
};

const char* wbTransportModeName(WBTransportMode mode);
WBTransportMode wbTransportModeFromName(const char* name);
const char* wbActiveLinkName(WBActiveLink link);
const char* wbTopologyStateName(WBTopologyState state);
bool wbTransportAllowsCan(WBTransportMode mode);
bool wbTransportAllowsWifi(WBTransportMode mode);

#endif
