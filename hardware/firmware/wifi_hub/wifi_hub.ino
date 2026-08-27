/*
 * WearBlocks Wi-Fi Hub
 *
 * This sketch selects the Wi-Fi/OSC transport adapter while sharing the
 * complete six-face Hub runtime with ../hub/hub.ino.
 */
#define WB_HUB_ENABLE_WIFI_OSC 1
#define WB_HUB_VARIANT_NAME "WearBlocks Wi-Fi Hub v2 (UID-keyed)"

#include "../hub/hub.ino"
