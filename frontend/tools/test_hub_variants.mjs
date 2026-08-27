import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

const sharedHub = read('hardware/firmware/hub/hub.ino');
const wifiHub = read('hardware/firmware/wifi_hub/wifi_hub.ino');
const wifiRegistry = read('hardware/firmware/wifi_hub/ModuleRegistry.cpp');
const transport = read('hardware/firmware/lib/WearBlocksTransport/WearBlocksTransport.h');
const wireless = read('hardware/firmware/lib/WearBlocksWireless/WearBlocksWireless.h');
const app = read('frontend/js/components/wb-app.js');
const palette = read('frontend/js/components/wb-palette.js');
const configPanel = read('frontend/js/components/wb-config-panel.js');

assert.match(sharedHub, /#define WB_HUB_ENABLE_WIFI_OSC 0/,
  'the standard Hub must default to a wired build');
assert.match(sharedHub, /#if WB_HUB_ENABLE_WIFI_OSC\s+#include <WearBlocksWireless\.h>/,
  'wireless headers must stay behind the variant switch');
assert.match(sharedHub, /unavailable_on_wired_hub/,
  'the wired Hub must reject wireless host commands explicitly');
assert.match(sharedHub, /\$WIFI,DISABLED/,
  'the wired Hub must advertise the missing Wi-Fi capability');
assert.match(sharedHub, /wired CAN only \(Wi-Fi\/OSC disabled\)/,
  'the wired Hub must report its transport choice at boot');

assert.match(wifiHub, /#define WB_HUB_ENABLE_WIFI_OSC 1/,
  'wifi_hub must enable the shared Wi-Fi/OSC adapter');
assert.match(wifiHub, /#include "\.\.\/hub\/hub\.ino"/,
  'wifi_hub must reuse the shared six-face Hub source');
assert.doesNotMatch(wifiHub, /void\s+setup\s*\(/,
  'wifi_hub must not copy the Hub runtime');
assert.match(wifiRegistry, /#include "\.\.\/hub\/ModuleRegistry\.cpp"/,
  'wifi_hub must reuse the shared registry implementation');

assert.doesNotMatch(transport, /#include <WiFi/,
  'transport metadata must not pull Wi-Fi into the wired Hub');
assert.match(wireless, /#include <WearBlocksTransport\.h>/,
  'the Wi-Fi runtime must consume the shared transport policy types');
assert.match(app, /case 'wifi_disabled':/,
  'the companion must consume the wired Hub capability response');
assert.match(palette, /wifiSupported \? html`/,
  'the Hub palette must expose Wi-Fi details only on wifi_hub');
assert.match(configPanel, /wifiSupported \? html`\s*<section>\s*<h3>Transport mode<\/h3>/,
  'module wireless transport controls must stay hidden on the wired Hub');

console.log('hub variants: wired core + Wi-Fi adapter ok');
