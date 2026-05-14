/*
 * WearBlocks Module — Vibration Motor (Green #50C878)
 * Target: ESP32-C3-MINI-1
 * Actuator: ERM motor via DRV2605L haptic driver
 *
 * CONFIG+EXECUTE two-frame protocol:
 *   CONFIG (0x300+slot): [intensity(0-100)]
 *   EXECUTE (0x200+slot): [cmd, ...time_params]
 *
 * Supported behaviors:
 *   ACT_VIBRATE       — single buzz (cfg: intensity, exe: dur_ms)
 *   ACT_VIBRATE_PULSE — repeated on/off (cfg: intensity, exe: on,off,count)
 *   ACT_VIBRATE_RAMP  — intensity ramp (exe: from%,to%,dur)
 *   ACT_VIBRATE_STOP  — immediate stop
 *
 * Phase 2 — Child-stack reporting:
 *   Three down-half POS_ID GPIOs sampled with debounced state machine.
 */

#include <WearBlocksCAN.h>
#include <WearBlocksProtocol.h>
#include <WearBlocksDescriptor.h>
#include <WearBlocksECA.h>
#include <Wire.h>
#include <Adafruit_DRV2605.h>

#define CAN_TX  0
#define CAN_RX  1
#define I2C_SDA 3
#define I2C_SCL 4

#ifndef MY_FACE
#define MY_FACE 4
#endif

#ifndef CHILD_DETECT
#define CHILD_DETECT 1
#endif

#if CHILD_DETECT
struct ChildFacePin { uint8_t face; uint8_t gpio; };
const ChildFacePin CHILD_PINS[3] = {
    {1, 2},
    {2, 8},
    {3, 10},
};
#endif

WearBlocksCAN        can;
WearBlocksProtocol   protocol;
WearBlocksDescriptor descriptor;
Adafruit_DRV2605     haptic;

uint8_t mySlot = 4;
bool    registered = false;
uint32_t lastHello = 0;
const uint32_t HELLO_RETRY_MS = 3000;   // re-announce every 3 s until ACK'd
static const char FW_VERSION[] = "2.0";

// ── CONFIG state ────────────────────────────────────────────
uint8_t cfgIntensity = 80;

// ── Behavior state ──────────────────────────────────────────
enum VibState : uint8_t { VIB_IDLE, VIB_BUZZ, VIB_PULSE, VIB_RAMP };
VibState vibState = VIB_IDLE;
uint32_t vibStart = 0;

uint16_t buzzDur = 0;

uint16_t pulseOn = 0, pulseOff = 0;
uint8_t  pulseCount = 0, pulsesDone = 0;
bool     pulseActive = false;
uint32_t lastPulseToggle = 0;

uint8_t  rampFrom = 0, rampTo = 100;
uint16_t rampDur = 0;

// ── Child-presence debounce (Phase 2) ───────────────────────
#if CHILD_DETECT
const uint32_t CHILD_SCAN_TICK = 20;
const uint8_t  CHILD_DEBOUNCE  = 5;

struct ChildTrack { bool committed; uint8_t streak; };
ChildTrack childTracks[3] = {};
uint32_t   lastChildScan = 0;

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
            if (registered) {
                protocol.sendChildEvent(myFaceWhereChildIs, occ);
            }
        }
    }
    cursor = (cursor + 1) % 3;
}
#endif

// ── Motor helpers ───────────────────────────────────────────
void motorOn(uint8_t intensity) {
    haptic.setMode(DRV2605_MODE_REALTIME);
    uint8_t rtpVal = (uint8_t)((float)intensity / 100.0f * 127.0f);
    haptic.setRealtimeValue(rtpVal);
}

void motorOff() {
    haptic.setRealtimeValue(0);
    haptic.setMode(DRV2605_MODE_INTTRIG);
    vibState = VIB_IDLE;
}

// ── Descriptor ──────────────────────────────────────────────
void setupDescriptor() {
    strlcpy(descriptor.moduleId, "vib_v2", sizeof(descriptor.moduleId));
    strlcpy(descriptor.name, "Vibration Motor", sizeof(descriptor.name));
    strlcpy(descriptor.category, "haptic_output", sizeof(descriptor.category));
    strlcpy(descriptor.color, "#50C878", sizeof(descriptor.color));
    strlcpy(descriptor.version, FW_VERSION, sizeof(descriptor.version));

    descriptor.numCapabilities = 1;
    WBCapability& vib = descriptor.capabilities[0];
    strlcpy(vib.type, "actuator", 16);
    strlcpy(vib.modality, "vibration", 24);
    vib.axes = 1;
    vib.rangeMin = 0.0f;
    vib.rangeMax = 100.0f;
    vib.resolution = 1.0f;
    strlcpy(vib.dataType, "uint8", 16);
    vib.numSampleRates = 0;

    descriptor.numAffordances = 3;
    strlcpy(descriptor.affordances[0], "haptic_feedback", 24);
    strlcpy(descriptor.affordances[1], "alert_user", 24);
    strlcpy(descriptor.affordances[2], "rhythmic_pattern", 24);

    descriptor.power.voltage = 3.3f;
    descriptor.power.currentTypical = 5.0f;
    descriptor.power.currentPeak = 150.0f;

    descriptor.physical.weight = 5.0f;
    descriptor.physical.dimensions[0] = 15.0f;
    descriptor.physical.dimensions[1] = 15.0f;
    descriptor.physical.dimensions[2] = 8.0f;
    descriptor.physical.numPlacements = 3;
    strlcpy(descriptor.physical.placements[0], "wrist", 16);
    strlcpy(descriptor.physical.placements[1], "forearm", 16);
    strlcpy(descriptor.physical.placements[2], "upper_arm", 16);
}

// ── Protocol callbacks ──────────────────────────────────────
void onDescriptorRequested() { protocol.sendDescriptor(descriptor); }

void onAck() {
    registered = true;
    Serial.println("[VIB] Registered!");
}

void onActuatorConfig(const uint8_t* params, uint8_t len) {
    if (len >= 1) cfgIntensity = params[0];
    Serial.printf("[VIB] CFG: intensity=%d\n", cfgIntensity);
}

void onActuatorCmd(uint8_t cmd, const uint8_t* p, uint8_t pLen) {
    vibStart = millis();

    switch ((WBActCmd)cmd) {
        case ACT_VIBRATE:
            buzzDur = (pLen >= 2) ? ((p[0] << 8) | p[1]) : 200;
            motorOn(cfgIntensity);
            vibState = VIB_BUZZ;
            Serial.printf("[VIB] BUZZ %dms @%d%%\n", buzzDur, cfgIntensity);
            break;

        case ACT_VIBRATE_PULSE:
            pulseOn  = (pLen >= 1) ? p[0] * 10 : 100;
            pulseOff = (pLen >= 2) ? p[1] * 10 : 100;
            pulseCount = (pLen >= 3) ? p[2] : 3;
            pulsesDone = 0;
            pulseActive = true;
            lastPulseToggle = vibStart;
            motorOn(cfgIntensity);
            vibState = VIB_PULSE;
            Serial.printf("[VIB] PULSE on=%d off=%d count=%d\n",
                          pulseOn, pulseOff, pulseCount);
            break;

        case ACT_VIBRATE_RAMP:
            rampFrom = (pLen >= 1) ? p[0] : 0;
            rampTo   = (pLen >= 2) ? p[1] : 100;
            rampDur  = (pLen >= 4) ? ((p[2] << 8) | p[3]) * 100 : 1000;
            motorOn(rampFrom);
            vibState = VIB_RAMP;
            Serial.printf("[VIB] RAMP %d→%d%% in %dms\n", rampFrom, rampTo, rampDur);
            break;

        case ACT_VIBRATE_STOP:
            motorOff();
            Serial.println("[VIB] STOP");
            break;

        default:
            break;
    }
}

// ── Behavior tick ───────────────────────────────────────────
void tickBehavior() {
    if (vibState == VIB_IDLE) return;

    uint32_t now = millis();
    uint32_t elapsed = now - vibStart;

    switch (vibState) {
        case VIB_BUZZ:
            if (elapsed >= buzzDur) motorOff();
            break;

        case VIB_PULSE: {
            uint16_t interval = pulseActive ? pulseOn : pulseOff;
            if ((now - lastPulseToggle) >= interval) {
                pulseActive = !pulseActive;
                lastPulseToggle = now;
                if (pulseActive) {
                    motorOn(cfgIntensity);
                    pulsesDone++;
                    if (pulseCount > 0 && pulsesDone >= pulseCount) { motorOff(); return; }
                } else {
                    haptic.setRealtimeValue(0);
                }
            }
            break;
        }
        case VIB_RAMP: {
            if (rampDur == 0) { motorOff(); return; }
            float t = min(1.0f, (float)elapsed / rampDur);
            uint8_t intensity = (uint8_t)(rampFrom + t * (rampTo - rampFrom));
            motorOn(intensity);
            if (elapsed >= rampDur) vibState = VIB_IDLE;
            break;
        }
        default:
            break;
    }
}

// ── Setup / Loop ────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println();
    Serial.printf("=== WearBlocks Vibration Module v%s ===\n", FW_VERSION);
    Serial.printf ("MY_FACE=%d  CHILD_DETECT=%d\n", MY_FACE, CHILD_DETECT);

    if (!can.begin(CAN_TX, CAN_RX)) {
        Serial.println("[VIB] CAN init FAILED!");
        while (1) delay(1000);
    }
    protocol.begin(can, false, mySlot);
    protocol.onDescriptorRequested(onDescriptorRequested);
    protocol.onActuatorCommand(onActuatorCmd);
    protocol.onActuatorConfig(onActuatorConfig);
    protocol.onAck(onAck);
    protocol.onRediscover([]() {
        Serial.println("[VIB] REDISCOVER received — re-sending HELLO");
        protocol.sendHello(descriptor.moduleId, MY_FACE, 0);
        lastHello = millis();
    });

#if CHILD_DETECT
    for (uint8_t i = 0; i < 3; i++) {
        pinMode(CHILD_PINS[i].gpio, INPUT_PULLUP);
    }
    delay(20);
    for (uint8_t i = 0; i < 3; i++) {
        childTracks[i].committed = (digitalRead(CHILD_PINS[i].gpio) == LOW);
    }
#endif

    setupDescriptor();
    protocol.sendHello(descriptor.moduleId, MY_FACE, 0);
    lastHello = millis();

    Wire.begin(I2C_SDA, I2C_SCL);
    if (!haptic.begin()) {
        Serial.println("[VIB] DRV2605 not found!");
    }
    haptic.selectLibrary(1);
    haptic.setMode(DRV2605_MODE_INTTRIG);

    Serial.printf("[VIB] Ready — claimed face %d (hub will override)\n", MY_FACE);
}

void loop() {
    protocol.processIncoming();
#if CHILD_DETECT
    scanChildren();
#endif

    uint32_t now = millis();
    if (!registered && now - lastHello >= HELLO_RETRY_MS) {
        lastHello = now;
        protocol.sendHello(descriptor.moduleId, MY_FACE, 0);
    }

    tickBehavior();
    protocol.sendHeartbeat();
    delay(5);
}
