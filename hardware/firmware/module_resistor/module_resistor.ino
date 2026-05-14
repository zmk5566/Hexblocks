
/*
 * WearBlocks Module — Knob / Rotary Potentiometer (Olive #98AF6F), v3
 * Target: ESP32-C3-MINI-1
 * Sensor: WH148 B100K rotary pot, voltage-divider on GPIO0 (ADC1_CH0)
 *
 * Wire behavior:
 *   - Publishes WB_CH_KNOB (channel id 40) as a normalized 0..1 float.
 *   - On-change only: emits a frame when the smoothed reading moves more
 *     than KNOB_DEADBAND, rate-capped by KNOB_MIN_INTERVAL (50 Hz max).
 *   - No periodic heartbeat of the value — silence means "no change".
 *
 * Registration boilerplate (UID, fwHash, HELLO retry, onAck) lives in
 * the WearBlocksModule library, same as IMU v3 / LED v3.
 */

#include <WearBlocksCAN.h>
#include <WearBlocksProtocol.h>
#include <WearBlocksDescriptor.h>
#include <WearBlocksModule.h>
#include <WearBlocksECA.h>

// ── Pin assignment (ESP32-C3-MINI-1) ──────────────────────────
#define CAN_TX     6
#define CAN_RX     7
#define KNOB_PIN   0   // ADC1_CH0; wiper of B100K. Two ends → 3.3V and GND.

// ── Components ───────────────────────────────────────────────
WearBlocksCAN        can;
WearBlocksProtocol   protocol;
WearBlocksDescriptor descriptor;
WBModule             module(can, protocol, descriptor);

static const char FW_VERSION[] = "3.0";

// ── On-change publish state ──────────────────────────────────
static const uint32_t KNOB_MIN_INTERVAL = 20;     // 50 Hz cap
static const float    KNOB_DEADBAND     = 0.005f; // 0.5% of full scale
static const float    KNOB_LPF_ALPHA    = 0.25f;  // light smoothing

float    knobLpf       = 0.0f;
float    lastSentNorm  = -1.0f;  // forces first publish
uint32_t lastSendMs    = 0;

// ── Descriptor build ─────────────────────────────────────────
void setupDescriptor() {
    char uid[16];
    snprintf(uid, sizeof(uid), "knob_%08lX", (unsigned long)module.uid());
    strlcpy(descriptor.moduleId, uid, sizeof(descriptor.moduleId));
    strlcpy(descriptor.name, "Rotary Knob", sizeof(descriptor.name));
    strlcpy(descriptor.category, "input_control", sizeof(descriptor.category));
    strlcpy(descriptor.color, "#98AF6F", sizeof(descriptor.color));
    strlcpy(descriptor.version, FW_VERSION, sizeof(descriptor.version));

    descriptor.numCapabilities = 1;
    WBCapability& knob = descriptor.capabilities[0];
    strlcpy(knob.type, "sensor", 16);
    strlcpy(knob.modality, "knob", 24);
    knob.axes = 1;
    knob.rangeMin = 0.0f;
    knob.rangeMax = 1.0f;
    knob.resolution = 0.001f;
    strlcpy(knob.dataType, "float32", 16);
    knob.sampleRates[0] = 50;
    knob.numSampleRates = 1;

    descriptor.numAffordances = 1;
    strlcpy(descriptor.affordances[0], "adjust_parameter", 24);

    descriptor.power.voltage = 3.3f;
    descriptor.power.currentTypical = 1.0f;
    descriptor.power.currentPeak = 2.0f;

    descriptor.physical.weight = 3.0f;
    descriptor.physical.dimensions[0] = 15.0f;
    descriptor.physical.dimensions[1] = 15.0f;
    descriptor.physical.dimensions[2] = 18.0f;
    descriptor.physical.numPlacements = 1;
    strlcpy(descriptor.physical.placements[0], "panel", 16);
}

void onRegistered(uint8_t slot, bool descriptorCached) {
    Serial.printf("[KNOB] Registered slot=%d uid=%08lX cached=%d\n",
                  slot, (unsigned long)module.uid(), descriptorCached);
}

// ── Setup ─────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println();
    Serial.printf("=== WearBlocks Knob Module v%s ===\n", FW_VERSION);

    if (!module.begin(CAN_TX, CAN_RX)) {
        Serial.println("[KNOB] CAN init FAILED!");
        while (1) delay(1000);
    }
    Serial.printf("[KNOB] uid=%08lX\n", (unsigned long)module.uid());

    module.onAfterAck(onRegistered);

    // ESP32-C3 ADC: 12-bit by default (0..4095). No need for analogSetWidth.
    pinMode(KNOB_PIN, INPUT);
    // Prime LPF with one read so the first publish reflects reality, not 0.
    knobLpf = analogRead(KNOB_PIN) / 4095.0f;

    setupDescriptor();
    module.start();
    Serial.printf("[KNOB] fwVersion=%s fwHash=%04X\n", FW_VERSION, module.fwHash());

    Serial.println("[KNOB] Ready");
}

// ── Loop ──────────────────────────────────────────────────────
void loop() {
    module.tick();

    uint32_t now = millis();

    if (module.registered() && (now - lastSendMs) >= KNOB_MIN_INTERVAL) {
        int raw = analogRead(KNOB_PIN);
        float norm = raw / 4095.0f;
        knobLpf = knobLpf + KNOB_LPF_ALPHA * (norm - knobLpf);

        if (fabsf(knobLpf - lastSentNorm) >= KNOB_DEADBAND) {
            protocol.sendSensorChannel(WB_CH_KNOB, knobLpf);
            lastSentNorm = knobLpf;
            lastSendMs = now;
        }
    }

    protocol.sendHeartbeat();
    delay(1);
}
