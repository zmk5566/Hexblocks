/*
 * WearBlocks Module — Fixed-Resource Audio Rack (MAX98357A I2S amp), v3
 * Target: ESP32-C3-MINI-1
 * Actuator: MAX98357A on I2S (BCLK=GPIO5, LRC=GPIO3, DIN=GPIO4)
 *
 * Pin note: BCLK moved off GPIO 2 — GPIO 2 is an ESP32-C3 strapping pin and
 * the audio path was silent when BCLK lived there. GPIO 5 is clean.
 *
 * Capability: actuator/audio_synth, axes=2 (freq, amp), plus a compact WBAP
 * patch delivered over chunked SYS_CONFIG. The patch changes the built-in
 * oscillator/filter/LFO/delay rack without reflashing firmware.
 * Commands:
 *   ACT_AUDIO_SET_TONE (0x30) — freq_lo, freq_hi, amp, optional duration_u32_be
 *   ACT_AUDIO_STOP    (0x31) — 0 params
 *
 * Mirrors module_led v3 for CAN/descriptor/HELLO/ACK and child detect.
 *
 * NOTE: I2S DIN shares GPIO 4 with the LED module's face-1 child-detect pin.
 * On this module face-1 child detection is DROPPED. Only faces 2 (GPIO 8)
 * and 3 (GPIO 10) report stack events.
 */
#include <WearBlocksCAN.h>
#include <WearBlocksProtocol.h>
#include <WearBlocksDescriptor.h>
#include <WearBlocksModule.h>
#include <WearBlocksWireless.h>
#include <WearBlocksECA.h>
#include <WearBlocksAudio.h>
#include <ESP_I2S.h>
#include <Preferences.h>
#include "AudioRack.h"

#define CAN_TX   6
#define CAN_RX   7
#define I2S_BCLK 5
#define I2S_LRC  3
#define I2S_DIN  4

#ifndef CHILD_DETECT
#define CHILD_DETECT 1
#endif

#if CHILD_DETECT
struct ChildFacePin { uint8_t face; uint8_t gpio; };
const ChildFacePin CHILD_PINS[2] = {
    {2, 8},
    {3, 10},
};
const uint8_t CHILD_COUNT = 2;
#endif

// ── Components ───────────────────────────────────────────────
WearBlocksCAN        can;
WearBlocksProtocol   protocol;
WearBlocksDescriptor descriptor;
WBModule             module(can, protocol, descriptor);
WBWirelessModule     wireless(module, protocol, descriptor);

static const char FW_VERSION[] = "3.0";

I2SClass i2s;
AudioRack audioRack;
int16_t audioBlock[AudioRack::BLOCK_FRAMES * 2];
uint32_t audioShortWrites = 0;
uint32_t lastAudioHealthLog = 0;

// ── Child-presence debounce ──────────────────────────────────
#if CHILD_DETECT
const uint32_t CHILD_SCAN_TICK    = 20;
const uint8_t  CHILD_DEBOUNCE     = 5;
const uint32_t CHILD_KEEPALIVE_MS = 2000;
struct ChildTrack { bool committed; uint8_t streak; };
ChildTrack childTracks[CHILD_COUNT] = {};
uint32_t   lastChildScan = 0;
uint32_t   lastChildBroadcast[CHILD_COUNT] = {0, 0};

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
            uint8_t face = CHILD_PINS[cursor].face;
            Serial.printf("[CHILD] my face %d → %s\n",
                          face, occ ? "OCCUPIED" : "empty");
            if (module.registered()) {
                protocol.sendChildEvent(face, occ);
                lastChildBroadcast[cursor] = now;
            }
        }
    }
    cursor = (cursor + 1) % CHILD_COUNT;

    if (module.registered()) {
        for (uint8_t i = 0; i < CHILD_COUNT; i++) {
            if (childTracks[i].committed &&
                now - lastChildBroadcast[i] >= CHILD_KEEPALIVE_MS) {
                protocol.sendChildEvent(CHILD_PINS[i].face, true);
                lastChildBroadcast[i] = now;
            }
        }
    }
}
#endif

// ── Descriptor ───────────────────────────────────────────────
void setupDescriptor() {
    char uid[16];
    snprintf(uid, sizeof(uid), "amp_%08lX", (unsigned long)module.uid());
    strlcpy(descriptor.moduleId, uid, sizeof(descriptor.moduleId));
    strlcpy(descriptor.name, "Audio Synth", sizeof(descriptor.name));
    strlcpy(descriptor.category, "audio_output", sizeof(descriptor.category));
    strlcpy(descriptor.color, "#9885BF", sizeof(descriptor.color));
    strlcpy(descriptor.version, FW_VERSION, sizeof(descriptor.version));

    descriptor.numCapabilities = 1;
    WBCapability& syn = descriptor.capabilities[0];
    strlcpy(syn.type, "actuator", 16);
    strlcpy(syn.modality, "audio_synth", 24);
    syn.axes = 2;
    syn.rangeMin = 0.0f;
    syn.rangeMax = 20000.0f;
    syn.resolution = 1.0f;
    strlcpy(syn.dataType, "uint16+uint8", 16);
    syn.numSampleRates = 0;

    descriptor.numAffordances = 2;
    strlcpy(descriptor.affordances[0], "audio_feedback", 24);
    strlcpy(descriptor.affordances[1], "patchable_synth", 24);

    descriptor.numConfigFields = 1;
    WBConfigField& patch = descriptor.configFields[0];
    strlcpy(patch.key, "audio_patch", sizeof(patch.key));
    strlcpy(patch.type, "bytes", sizeof(patch.type));
    strlcpy(patch.defaultValue, "built_in", sizeof(patch.defaultValue));
    strlcpy(patch.label, "WBAP subtractive synth patch", sizeof(patch.label));

    descriptor.power.voltage = 3.3f;
    descriptor.power.currentTypical = 50.0f;
    descriptor.power.currentPeak = 500.0f;

    descriptor.physical.weight = 5.0f;
    descriptor.physical.dimensions[0] = 20.0f;
    descriptor.physical.dimensions[1] = 20.0f;
    descriptor.physical.dimensions[2] = 6.0f;
    descriptor.physical.numPlacements = 2;
    strlcpy(descriptor.physical.placements[0], "wrist", 16);
    strlcpy(descriptor.physical.placements[1], "chest", 16);
}

// ── Actuator callback ────────────────────────────────────────
// ECA can stream SET_TONE at every tick with small float-to-integer jitter.
// Suppress insignificant control churn; AudioRack smooths accepted changes
// without resetting oscillator phase.
static float    g_lastFreq = -1.0f;
static int16_t  g_lastAmp  = -1;
static const float FREQ_DEADBAND_HZ = 1.0f;
static bool     g_toneTimed = false;
static uint32_t g_toneUntil = 0;

void stopTone() {
    g_toneTimed = false;
    if (g_lastAmp != 0) {
        audioRack.hardStop();
        g_lastAmp = 0;
        Serial.println("[AMP] STOP");
    }
}

void onActuatorCmd(uint8_t cmd, const uint8_t* p, uint8_t pLen) {
    if (cmd == ACT_AUDIO_SET_TONE) {
        if (pLen < 3) {
            Serial.printf("[AMP] SET_TONE: short params (len=%d)\n", pLen);
            return;
        }
        uint16_t freq = (uint16_t)p[0] | ((uint16_t)p[1] << 8);
        uint8_t  amp  = p[2];
        if (fabsf((float)freq - g_lastFreq) >= FREQ_DEADBAND_HZ) {
            g_lastFreq = (float)freq;
            Serial.printf("[AMP] freq=%u\n", freq);
        }
        if (amp != g_lastAmp) {
            g_lastAmp = amp;
            Serial.printf("[AMP] amp=%u\n", amp);
        }
        audioRack.setTone(g_lastFreq >= 0.0f ? g_lastFreq : (float)freq, amp);
        if (pLen >= 7) {
            uint32_t duration = ((uint32_t)p[3] << 24) |
                                ((uint32_t)p[4] << 16) |
                                ((uint32_t)p[5] << 8) | p[6];
            uint32_t lease = (pLen >= 8) ? (uint32_t)p[7] * 10U : 0;
            uint32_t timeout = lease > 0 ? lease : duration;
            g_toneTimed = timeout > 0;
            g_toneUntil = millis() + timeout;
        } else {
            g_toneTimed = false;
        }
        return;
    }
    if (cmd == ACT_AUDIO_STOP) {
        stopTone();
        return;
    }
    Serial.printf("[AMP] unknown cmd=0x%02X (ignored)\n", cmd);
}

bool saveAudioPatch(const uint8_t* payload, uint16_t payloadLen) {
    Preferences prefs;
    if (!prefs.begin("wbaudio", false)) return false;
    size_t wrote = prefs.putBytes("patch", payload, payloadLen);
    size_t wroteLen = prefs.putUShort("patch_len", payloadLen);
    prefs.end();
    return wrote == payloadLen && wroteLen == sizeof(uint16_t);
}

bool loadAudioPatch() {
    Preferences prefs;
    if (!prefs.begin("wbaudio", true)) return false;
    uint16_t len = prefs.getUShort("patch_len", 0);
    if (len != WB_AUDIO_PATCH_ENCODED_LEN) {
        prefs.end();
        return false;
    }
    uint8_t payload[WB_AUDIO_PATCH_MAX_ENCODED];
    size_t got = prefs.getBytes("patch", payload, len);
    prefs.end();
    if (got != len) return false;
    WBAudioPatch patch;
    if (!wbAudioPatchDecode(payload, len, patch)) return false;
    audioRack.setPatch(patch);
    Serial.printf("[AMP] restored patch rev=%lu\n",
                  (unsigned long)patch.configRev);
    return true;
}

void onSystemConfig(const uint8_t* payload, uint16_t payloadLen,
                    uint8_t sessionId) {
    WBAudioPatch patch;
    if (!wbAudioPatchDecode(payload, payloadLen, patch)) {
        protocol.sendSysConfigAck(30, sessionId);
        Serial.printf("[AMP] rejected SYS_CONFIG len=%u\n", (unsigned)payloadLen);
        return;
    }

    // The callback runs between render blocks on this single-core module, so
    // the active struct is replaced atomically from the audio loop's view.
    audioRack.setPatch(patch);
    bool saved = saveAudioPatch(payload, payloadLen);
    protocol.sendSysConfigAck(saved ? 0 : 31, sessionId);
    Serial.printf("[AMP] patch rev=%lu saved=%d wave=%u/%u filter=%u delay=%ums\n",
                  (unsigned long)patch.configRev, saved ? 1 : 0,
                  (unsigned)patch.oscAWave, (unsigned)patch.oscBWave,
                  (unsigned)patch.filterMode, (unsigned)patch.delayMs);
}

void onRegistered(uint8_t slot, bool descriptorCached) {
    Serial.printf("[AMP] Registered slot=%d uid=%08lX cached=%d\n",
                  slot, (unsigned long)module.uid(), descriptorCached);
}

// ── Setup ─────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println();
    Serial.printf("=== WearBlocks Audio Module v%s ===\n", FW_VERSION);

    if (!module.begin(CAN_TX, CAN_RX)) {
        Serial.println("[AMP] CAN init FAILED!");
        while (1) delay(1000);
    }
    Serial.printf("[AMP] uid=%08lX\n", (unsigned long)module.uid());

    wireless.onActuatorCommand(onActuatorCmd);
    module.onAfterAck(onRegistered);

#if CHILD_DETECT
    for (uint8_t i = 0; i < CHILD_COUNT; i++) {
        pinMode(CHILD_PINS[i].gpio, INPUT_PULLUP);
    }
    delay(20);
#endif

    audioRack.begin();
    if (!loadAudioPatch()) {
        Serial.println("[AMP] using built-in default patch");
    }

    i2s.setPins(I2S_BCLK, I2S_LRC, I2S_DIN);
    if (!i2s.begin(I2S_MODE_STD, AudioRack::SAMPLE_RATE,
                   I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO)) {
        Serial.println("[AMP] I2S init FAILED!");
    }

    setupDescriptor();
    wireless.onSystemConfig(onSystemConfig);
    wireless.begin();
    module.start();
    Serial.printf("[AMP] fwVersion=%s fwHash=%04X\n", FW_VERSION, module.fwHash());

    Serial.println("[AMP] Ready");
}

// ── Loop ──────────────────────────────────────────────────────
void loop() {
    module.tick();
    wireless.tick();
    if (g_toneTimed && (int32_t)(millis() - g_toneUntil) >= 0) stopTone();
    audioRack.renderStereo(audioBlock, AudioRack::BLOCK_FRAMES);
    size_t expected = sizeof(audioBlock);
    size_t wrote = i2s.write((const uint8_t*)audioBlock, expected);
    if (wrote != expected) audioShortWrites++;
#if CHILD_DETECT
    scanChildren();
#endif
    protocol.sendHeartbeat();
    uint32_t now = millis();
    if (audioShortWrites > 0 && now - lastAudioHealthLog >= 1000) {
        lastAudioHealthLog = now;
        Serial.printf("[AMP] I2S short writes=%lu last=%u/%u\n",
                      (unsigned long)audioShortWrites, (unsigned)wrote,
                      (unsigned)expected);
    }
}
