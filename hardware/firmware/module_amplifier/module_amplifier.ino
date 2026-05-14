/*
 * WearBlocks Module — Audio Synth (MAX98357A I2S amp), v1
 * Target: ESP32-C3-MINI-1
 * Actuator: MAX98357A on I2S (BCLK=GPIO5, LRC=GPIO3, DIN=GPIO4)
 *
 * Pin note: BCLK moved off GPIO 2 — GPIO 2 is an ESP32-C3 strapping pin and
 * the audio path was silent when BCLK lived there. GPIO 5 is clean.
 *
 * Capability: actuator/audio_synth, axes=2 (freq, amp).
 * Commands:
 *   ACT_AUDIO_SET_TONE (0x30) — 3 params: freq_lo, freq_hi (uint16 LE Hz), amp (0..255)
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
#include <WearBlocksECA.h>
#include <AudioTools.h>

#define CAN_TX   6
#define CAN_RX   7
#define I2S_BCLK 5
#define I2S_LRC  3
#define I2S_DIN  4

#define AUDIO_SAMPLE_RATE 22050
#define AUDIO_BITS        16
#define AUDIO_AMP_MAX     20000   // peak int16 amplitude when host sends amp=255

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

static const char FW_VERSION[] = "1.0";

SineWaveGenerator<int16_t>      sine(0);
GeneratedSoundStream<int16_t>   src(sine);
I2SStream                       i2s;
StreamCopy                      copier(i2s, src);

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
    strlcpy(descriptor.affordances[1], "tone_generator", 24);

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
// Deadband: SineWaveGenerator::setFrequency resets phase whenever the new
// freq != the cached one. ECA streams SET_TONE at every tick with float
// jitter (e.g. 400.001 vs 400.002), so naively forwarding every call resets
// the waveform back to sin(0) on each frame → audible silence. Only update
// the generator when the value moves by more than the deadband.
static float    g_lastFreq = -1.0f;
static int16_t  g_lastAmp  = -1;
static const float FREQ_DEADBAND_HZ = 1.0f;

void onActuatorCmd(uint8_t cmd, const uint8_t* p, uint8_t pLen) {
    if (cmd == ACT_AUDIO_SET_TONE) {
        if (pLen < 3) {
            Serial.printf("[AMP] SET_TONE: short params (len=%d)\n", pLen);
            return;
        }
        uint16_t freq = (uint16_t)p[0] | ((uint16_t)p[1] << 8);
        uint8_t  amp  = p[2];
        if (fabsf((float)freq - g_lastFreq) >= FREQ_DEADBAND_HZ) {
            sine.setFrequency((float)freq);
            g_lastFreq = (float)freq;
            Serial.printf("[AMP] freq=%u\n", freq);
        }
        if (amp != g_lastAmp) {
            sine.setAmplitude((float)amp / 255.0f * AUDIO_AMP_MAX);
            g_lastAmp = amp;
            Serial.printf("[AMP] amp=%u\n", amp);
        }
        return;
    }
    if (cmd == ACT_AUDIO_STOP) {
        if (g_lastAmp != 0) {
            sine.setAmplitude(0);
            g_lastAmp = 0;
            Serial.println("[AMP] STOP");
        }
        return;
    }
    Serial.printf("[AMP] unknown cmd=0x%02X (ignored)\n", cmd);
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

    protocol.onActuatorCommand(onActuatorCmd);
    module.onAfterAck(onRegistered);

#if CHILD_DETECT
    for (uint8_t i = 0; i < CHILD_COUNT; i++) {
        pinMode(CHILD_PINS[i].gpio, INPUT_PULLUP);
    }
    delay(20);
#endif

    AudioInfo info(AUDIO_SAMPLE_RATE, 1, AUDIO_BITS);
    auto i2sCfg = i2s.defaultConfig(TX_MODE);
    i2sCfg.copyFrom(info);
    i2sCfg.pin_bck  = I2S_BCLK;
    i2sCfg.pin_ws   = I2S_LRC;
    i2sCfg.pin_data = I2S_DIN;
    if (!i2s.begin(i2sCfg)) {
        Serial.println("[AMP] I2S init FAILED!");
    }
    sine.begin(info, 0.0f);
    src.begin(info);

    setupDescriptor();
    module.start();
    Serial.printf("[AMP] fwVersion=%s fwHash=%04X\n", FW_VERSION, module.fwHash());

    Serial.println("[AMP] Ready");
}

// ── Loop ──────────────────────────────────────────────────────
void loop() {
    module.tick();
    copier.copy();
#if CHILD_DETECT
    scanChildren();
#endif
    protocol.sendHeartbeat();
}
