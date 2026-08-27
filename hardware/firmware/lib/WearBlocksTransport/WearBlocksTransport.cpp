#include "WearBlocksTransport.h"

const char* wbTransportModeName(WBTransportMode mode) {
    switch (mode) {
        case WB_TRANSPORT_CAN_ONLY: return "can_only";
        case WB_TRANSPORT_WIFI_ONLY: return "wifi_only";
        case WB_TRANSPORT_CAN_PRIMARY_WIFI_FALLBACK: return "can_primary_wifi_fallback";
        case WB_TRANSPORT_WIFI_PRIMARY_CAN_FALLBACK: return "wifi_primary_can_fallback";
        case WB_TRANSPORT_DUAL_SEND_DEBUG: return "dual_send_debug";
        default: return "can_primary_wifi_fallback";
    }
}

WBTransportMode wbTransportModeFromName(const char* name) {
    if (!name || !*name) return WB_TRANSPORT_CAN_PRIMARY_WIFI_FALLBACK;
    if (strcmp(name, "can_only") == 0) return WB_TRANSPORT_CAN_ONLY;
    if (strcmp(name, "wifi_only") == 0) return WB_TRANSPORT_WIFI_ONLY;
    if (strcmp(name, "can_primary_wifi_fallback") == 0) {
        return WB_TRANSPORT_CAN_PRIMARY_WIFI_FALLBACK;
    }
    if (strcmp(name, "wifi_primary_can_fallback") == 0) {
        return WB_TRANSPORT_WIFI_PRIMARY_CAN_FALLBACK;
    }
    if (strcmp(name, "dual_send_debug") == 0) return WB_TRANSPORT_DUAL_SEND_DEBUG;
    return WB_TRANSPORT_CAN_PRIMARY_WIFI_FALLBACK;
}

const char* wbActiveLinkName(WBActiveLink link) {
    switch (link) {
        case WB_LINK_CAN: return "can";
        case WB_LINK_WIFI: return "wifi";
        case WB_LINK_NONE:
        default: return "none";
    }
}

const char* wbTopologyStateName(WBTopologyState state) {
    return state == WB_TOPO_REMOTE_UNPLACED ? "remote_unplaced" : "physical";
}

bool wbTransportAllowsCan(WBTransportMode mode) {
    return mode != WB_TRANSPORT_WIFI_ONLY;
}

bool wbTransportAllowsWifi(WBTransportMode mode) {
    return mode != WB_TRANSPORT_CAN_ONLY;
}
