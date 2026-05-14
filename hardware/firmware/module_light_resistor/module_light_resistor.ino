
/*
 * WearBlocks Module — Light Sensor / LDR (Tan #C1B496), v3
 * Target: ESP32-C3-MINI-1
 * Sensor: photoresistor (LDR) in voltage-divider with a 10k fixed resistor,
 *         wiper to GPIO0 (ADC1_CH0). Wiring (high-on-bright):
 *             3.3V ── LDR ──┬── GPIO0 (ADC)
 *                          10k
 *                           └── GND
 *         When ambient light is bright the LDR resistance drops, more of
 *         the 3.3V swings across the 10k → ADC reads higher → norm → 1.0.
 *         (LDRs vary; this layout works for the common GL5528 / GL5537
 *         class which sits ~1k bright, ~10k indoor, >100k dark.)
 *
 * Wire behavior:
 *   - Publishes WB_CH_LIGHT (channel id 41) as a normalized 0..1 float.
 *   - On-change only: emits a frame when the smoothed reading moves more
 *     than LIGHT_DEADBAND, rate-capped by LIGHT_MIN_INTERVAL.
 *   - No periodic heartbeat of the value — silence means "no change".
 *
 * Registration boilerplate (UID, fwHash, HELLO retry, onAck) lives in
 * the WearBlocksModule library, same as the knob / IMU v3 / LED v3.
 */

#include <WearBlocksCAN.h>
#include <WearBlocksProtocol.h>
#include <WearBlocksDescriptor.h>
#include <WearBlocksModule.h>
#include <WearBlocksECA.h>

// ── Pin assignment (ESP32-C3-MINI-1) ──────────────────────────
#define CAN_TX     6
#define CAN_RX     7
#define LIGHT_PIN  0   // ADC1_CH0; wiper of 10k+LDR divider.

// ── Components ───────────────────────────────────────────────
WearBlocksCAN        can;
WearBlocksProtocol   protocol;
WearBlocksDescriptor descriptor;
WBModule             module(can, protocol, descriptor);

static const char FW_VERSION[] = "3.0";

// ── On-change publish state ──────────────────────────────────
// Light changes more slowly than a hand-turned knob, so we relax the
// deadband a touch and the rate cap (still snappy at 25 Hz max).
static const uint32_t LIGHT_MIN_INTERVAL = 40;     // 25 Hz cap
static const float    LIGHT_DEADBAND     = 0.01f;  // 1% of full scale
static const float    LIGHT_LPF_ALPHA    = 0.20f;  // smoothing

float    lightLpf      = 0.0f;
float    lastSentNorm  = -1.0f;  // forces first publish
uint32_t lastSendMs    = 0;

// ── Descriptor build ─────────────────────────────────────────
void setupDescriptor() {
    char uid[16];
    snprintf(uid, sizeof(uid), "light_%08lX", (unsigned long)module.uid());
    strlcpy(descriptor.moduleId, uid, sizeof(descriptor.moduleId));
    strlcpy(descriptor.name, "Light Sensor", sizeof(descriptor.name));
    strlcpy(descriptor.category, "light_sensing", sizeof(descriptor.category));
    strlcpy(descriptor.color, "#C1B496", sizeof(descriptor.color));
    strlcpy(descriptor.version, FW_VERSION, sizeof(descriptor.version));

    descriptor.numCapabilities = 1;
    WBCapability& light = descriptor.capabilities[0];
    strlcpy(light.type, "sensor", 16);
    strlcpy(light.modality, "light", 24);
    light.axes = 1;
    light.rangeMin = 0.0f;
    light.rangeMax = 1.0f;
    light.resolution = 0.001f;
    strlcpy(light.dataType, "float32", 16);
    light.sampleRates[0] = 25;
    light.numSampleRates = 1;

    descriptor.numAffordances = 2;
    strlcpy(descriptor.affordances[0], "detect_ambient_light", 24);
    strlcpy(descriptor.affordances[1], "detect_cover", 24);

    descriptor.power.voltage = 3.3f;
    descriptor.power.currentTypical = 1.0f;
    descriptor.power.currentPeak = 2.0f;

    descriptor.physical.weight = 2.5f;
    descriptor.physical.dimensions[0] = 15.0f;
    descriptor.physical.dimensions[1] = 15.0f;
    descriptor.physical.dimensions[2] = 5.0f;
    descriptor.physical.numPlacements = 1;
    strlcpy(descriptor.physical.placements[0], "panel", 16);
}

void onRegistered(uint8_t slot, bool descriptorCached) {
    Serial.printf("[LIGHT] Registered slot=%d uid=%08lX cached=%d\n",
                  slot, (unsigned long)module.uid(), descriptorCached);
}

// ── Setup ─────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println();
    Serial.printf("=== WearBlocks Light Module v%s ===\n", FW_VERSION);

    if (!module.begin(CAN_TX, CAN_RX)) {
        Serial.println("[LIGHT] CAN init FAILED!");
        while (1) delay(1000);
    }
    Serial.printf("[LIGHT] uid=%08lX\n", (unsigned long)module.uid());

    module.onAfterAck(onRegistered);

    pinMode(LIGHT_PIN, INPUT);
    // Prime LPF with one read so the first publish reflects reality, not 0.
    lightLpf = analogRead(LIGHT_PIN) / 4095.0f;

    setupDescriptor();
    module.start();
    Serial.printf("[LIGHT] fwVersion=%s fwHash=%04X\n", FW_VERSION, module.fwHash());

    Serial.println("[LIGHT] Ready");
}

// ── Loop ──────────────────────────────────────────────────────
void loop() {
    module.tick();

    uint32_t now = millis();

    if (module.registered() && (now - lastSendMs) >= LIGHT_MIN_INTERVAL) {
        int raw = analogRead(LIGHT_PIN);
        float norm = raw / 4095.0f;
        lightLpf = lightLpf + LIGHT_LPF_ALPHA * (norm - lightLpf);

        if (fabsf(lightLpf - lastSentNorm) >= LIGHT_DEADBAND) {
            protocol.sendSensorChannel(WB_CH_LIGHT, lightLpf);
            lastSentNorm = lightLpf;
            lastSendMs = now;
        }
    }

    protocol.sendHeartbeat();
    delay(1);
}
