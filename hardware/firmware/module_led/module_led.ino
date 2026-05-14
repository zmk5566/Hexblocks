/*
 * WearBlocks Module — RGB LED (Rose #C68E9E), v3
 * Target: ESP32-C3-MINI-1
 * Actuator: WS2811/WS2812 strip on GPIO 5
 *
 * v3 vs v2:
 *   - Registration via WBModule (UID/fwHash/HELLO retry/onAck shared with IMU v3)
 *   - FastLED replaces Adafruit_NeoPixel
 *   - Single command: SET_RGB(r, g, b) with id 0x01 (== ACT_LED_SOLID)
 *     - Drops CONFIG/EXECUTE split — all params inline on the EXECUTE frame
 *     - Drops RAMP/BREATHE/BLINK/RAINBOW state machines (will return later
 *       once descriptor command schema (step 3) is in place)
 *
 * Phase 2 — Child-stack reporting unchanged.
 */

#include <WearBlocksCAN.h>
#include <WearBlocksProtocol.h>
#include <WearBlocksDescriptor.h>
#include <WearBlocksModule.h>
#include <WearBlocksECA.h>
#define FASTLED_INTERNAL          // suppress pragma version banner
#include <FastLED.h>

#define CAN_TX   6
#define CAN_RX   7
#define LED_PIN  5
#define NUM_LEDS 8

#ifndef CHILD_DETECT
#define CHILD_DETECT 1
#endif

// LED data on GPIO 5; child pins avoid it.
#if CHILD_DETECT
struct ChildFacePin { uint8_t face; uint8_t gpio; };
const ChildFacePin CHILD_PINS[3] = {
    {1, 4},
    {2, 8},
    {3, 10},
};
#endif

// ── Components ───────────────────────────────────────────────
WearBlocksCAN        can;
WearBlocksProtocol   protocol;
WearBlocksDescriptor descriptor;
WBModule             module(can, protocol, descriptor);
CRGB                 leds[NUM_LEDS];

static const char FW_VERSION[] = "3.0";

// ── Command ids ──────────────────────────────────────────────
// 0x01 matches ACT_LED_SOLID in WearBlocksECA so the existing debug console
// fallback (free-text bytes) keeps working until step 3 surfaces the
// descriptor command schema.
static const uint8_t ACT_LED_SET_RGB = 0x01;

// ── Child-presence debounce ──────────────────────────────────
#if CHILD_DETECT
const uint32_t CHILD_SCAN_TICK         = 20;
const uint8_t  CHILD_DEBOUNCE          = 5;
const uint32_t CHILD_KEEPALIVE_MS      = 2000;
struct ChildTrack { bool committed; uint8_t streak; };
ChildTrack childTracks[3] = {};
uint32_t   lastChildScan = 0;
uint32_t   lastChildBroadcast[3] = {0, 0, 0};

void scanChildren() {
    uint32_t now = millis();
    if (now - lastChildScan < CHILD_SCAN_TICK) return;
    lastChildScan = now;
    static uint8_t cursor = 0;

    bool occ = (digitalRead(CHILD_PINS[cursor].gpio) == LOW);
    ChildTrack& t = childTracks[cursor];
    if (occ == t.committed) {
        t.streak = 0;
    } else {
        t.streak++;
        if (t.streak >= CHILD_DEBOUNCE) {
            t.committed = occ;
            t.streak = 0;
            uint8_t myFaceWhereChildIs = CHILD_PINS[cursor].face;
            Serial.printf("[CHILD] my face %d → %s\n",
                          myFaceWhereChildIs, occ ? "OCCUPIED" : "empty");
            if (module.registered()) {
                protocol.sendChildEvent(myFaceWhereChildIs, occ);
                lastChildBroadcast[cursor] = now;
            }
        }
    }
    cursor = (cursor + 1) % 3;

    if (module.registered()) {
        for (uint8_t i = 0; i < 3; i++) {
            if (childTracks[i].committed &&
                now - lastChildBroadcast[i] >= CHILD_KEEPALIVE_MS) {
                protocol.sendChildEvent(CHILD_PINS[i].face, true);
                lastChildBroadcast[i] = now;
            }
        }
    }
}
#endif

// ── LED helpers ──────────────────────────────────────────────
void setAll(uint8_t r, uint8_t g, uint8_t b) {
    fill_solid(leds, NUM_LEDS, CRGB(r, g, b));
    FastLED.show();
}

// ── Descriptor ───────────────────────────────────────────────
void setupDescriptor() {
    char uid[16];
    snprintf(uid, sizeof(uid), "led_%08lX", (unsigned long)module.uid());
    strlcpy(descriptor.moduleId, uid, sizeof(descriptor.moduleId));
    strlcpy(descriptor.name, "RGB LED", sizeof(descriptor.name));
    strlcpy(descriptor.category, "visual_output", sizeof(descriptor.category));
    strlcpy(descriptor.color, "#C68E9E", sizeof(descriptor.color));
    strlcpy(descriptor.version, FW_VERSION, sizeof(descriptor.version));

    descriptor.numCapabilities = 1;
    WBCapability& led = descriptor.capabilities[0];
    strlcpy(led.type, "actuator", 16);
    strlcpy(led.modality, "rgb_light", 24);
    led.axes = 3;
    led.rangeMin = 0.0f;
    led.rangeMax = 255.0f;
    led.resolution = 1.0f;
    strlcpy(led.dataType, "uint8[3]", 16);
    led.numSampleRates = 0;

    descriptor.numAffordances = 3;
    strlcpy(descriptor.affordances[0], "visual_feedback", 24);
    strlcpy(descriptor.affordances[1], "status_indicator", 24);
    strlcpy(descriptor.affordances[2], "ambient_light", 24);

    descriptor.power.voltage = 3.3f;
    descriptor.power.currentTypical = 20.0f;
    descriptor.power.currentPeak = 400.0f;

    descriptor.physical.weight = 3.8f;
    descriptor.physical.dimensions[0] = 20.0f;
    descriptor.physical.dimensions[1] = 20.0f;
    descriptor.physical.dimensions[2] = 4.0f;
    descriptor.physical.numPlacements = 3;
    strlcpy(descriptor.physical.placements[0], "wrist", 16);
    strlcpy(descriptor.physical.placements[1], "chest", 16);
    strlcpy(descriptor.physical.placements[2], "shoulder", 16);
}

// ── Actuator callback ────────────────────────────────────────
void onActuatorCmd(uint8_t cmd, const uint8_t* p, uint8_t pLen) {
    if (cmd == ACT_LED_SET_RGB) {
        if (pLen < 3) {
            Serial.printf("[LED] SET_RGB: short params (len=%d)\n", pLen);
            return;
        }
        Serial.printf("[LED] SET_RGB r=%d g=%d b=%d\n", p[0], p[1], p[2]);
        setAll(p[0], p[1], p[2]);
        return;
    }
    Serial.printf("[LED] unknown cmd=0x%02X (ignored)\n", cmd);
}

void onRegistered(uint8_t slot, bool descriptorCached) {
    Serial.printf("[LED] Registered slot=%d uid=%08lX cached=%d\n",
                  slot, (unsigned long)module.uid(), descriptorCached);
}

// ── Setup ─────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println();
    Serial.printf("=== WearBlocks LED Module v%s ===\n", FW_VERSION);

    if (!module.begin(CAN_TX, CAN_RX)) {
        Serial.println("[LED] CAN init FAILED!");
        while (1) delay(1000);
    }
    Serial.printf("[LED] uid=%08lX\n", (unsigned long)module.uid());

    protocol.onActuatorCommand(onActuatorCmd);
    module.onAfterAck(onRegistered);

#if CHILD_DETECT
    for (uint8_t i = 0; i < 3; i++) {
        pinMode(CHILD_PINS[i].gpio, INPUT_PULLUP);
    }
    delay(20);
    for (uint8_t i = 0; i < 3; i++) {
        childTracks[i].committed = false;
    }
#endif

    FastLED.addLeds<WS2812B, LED_PIN, GRB>(leds, NUM_LEDS);
    FastLED.setBrightness(64);
    FastLED.clear(true);

    setupDescriptor();
    module.start();
    Serial.printf("[LED] fwVersion=%s fwHash=%04X\n", FW_VERSION, module.fwHash());

    Serial.println("[LED] Ready");
}

// ── Loop ──────────────────────────────────────────────────────
void loop() {
    module.tick();
#if CHILD_DETECT
    scanChildren();
#endif
    protocol.sendHeartbeat();
    delay(1);
}
