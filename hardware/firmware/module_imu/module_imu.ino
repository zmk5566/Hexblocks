/*
 * WearBlocks Module — 6-Axis IMU (Slate #7CA1BB)
 * Target: ESP32-C3-MINI-1
 * Sensor: MPU6050 (GY-521 breakout)
 *
 * Internally this is the v3 sketch: registration boilerplate (UID derive,
 * fwHash, onAck, onDescriptorRequested, HELLO retry) lives in the shared
 * WearBlocksModule library so it can be reused by LED/vibration/etc.
 * This sketch is the reference user of that lib.
 *
 * Channels published over CAN (single-channel frames):
 *   Raw (always ON):        AX, AY, AZ, GX, GY, GZ
 *   Derived (topic-gated):  ACC_MAG, GYRO_MAG, PITCH, ROLL,
 *                           AX_LPF, AY_LPF, AZ_LPF, ACC_MAG_LPF, JERK
 *   Events (topic-gated):   SHAKE, STEP, FREEFALL
 */

#include <WearBlocksCAN.h>
#include <WearBlocksProtocol.h>
#include <WearBlocksDescriptor.h>
#include <WearBlocksModule.h>
#include <WearBlocksECA.h>
#include <Wire.h>
#include <MPU6050_light.h>
#include <math.h>

// ── Pin assignment (ESP32-C3-MINI-1) ──────────────────────────
#define CAN_TX     6
#define CAN_RX     7
#define I2C_SDA    3
#define I2C_SCL    4

#ifndef CHILD_DETECT
#define CHILD_DETECT 1
#endif

#if CHILD_DETECT
struct ChildFacePin { uint8_t face; uint8_t gpio; };
const ChildFacePin CHILD_PINS[3] = {
    {3, 2},
    {4, 5},
    {5, 10},
};
#endif

// ── Components ───────────────────────────────────────────────
WearBlocksCAN        can;
WearBlocksProtocol   protocol;
WearBlocksDescriptor descriptor;
WBModule             module(can, protocol, descriptor);
MPU6050              imu(Wire);

static const char FW_VERSION[] = "3.0";

uint32_t lastSend = 0;
const uint32_t SEND_INTERVAL = 20;     // 50 Hz

// ── Topic mask ───────────────────────────────────────────────
uint64_t topicMask = 0;
bool isTopicEnabled(uint8_t channelId) { return (topicMask >> channelId) & 1; }

// ── LPF state ────────────────────────────────────────────────
static const float LPF_ALPHA = 0.2f;
float lpf_ax = 0, lpf_ay = 0, lpf_az = 0, lpf_acc_mag = 0;
float lpfUpdate(float& state, float input) {
    state = state + LPF_ALPHA * (input - state);
    return state;
}

// ── Derived / event state ────────────────────────────────────
float prevAccMag = 0;

static const float    SHAKE_THRESHOLD = 3.0f;
static const uint32_t SHAKE_COOLDOWN  = 500;
uint32_t lastShakeTime = 0;

uint16_t stepCount = 0;
bool     stepAboveZero = false;
uint32_t lastStepTime = 0;
static const uint32_t STEP_MIN_INTERVAL = 250;

static const float    FREEFALL_THRESHOLD = 0.3f;
static const uint32_t FREEFALL_DURATION  = 50;
uint32_t freefallStart = 0;
bool     inFreefall = false;

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

    // Keepalive: re-broadcast each occupied face every CHILD_KEEPALIVE_MS.
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

// ── Descriptor build ─────────────────────────────────────────
void setupDescriptor() {
    char uid[16];
    snprintf(uid, sizeof(uid), "imu_%08lX", (unsigned long)module.uid());
    strlcpy(descriptor.moduleId, uid, sizeof(descriptor.moduleId));
    strlcpy(descriptor.name, "6-Axis IMU", sizeof(descriptor.name));
    strlcpy(descriptor.category, "motion_sensing", sizeof(descriptor.category));
    strlcpy(descriptor.color, "#7CA1BB", sizeof(descriptor.color));
    strlcpy(descriptor.version, FW_VERSION, sizeof(descriptor.version));

    descriptor.numCapabilities = 2;

    WBCapability& accel = descriptor.capabilities[0];
    strlcpy(accel.type, "sensor", 16);
    strlcpy(accel.modality, "acceleration", 24);
    accel.axes = 3;
    accel.rangeMin = -16.0f;
    accel.rangeMax = 16.0f;
    accel.resolution = 0.001f;
    strlcpy(accel.dataType, "float32[3]", 16);
    accel.sampleRates[0] = 50;
    accel.numSampleRates = 1;

    WBCapability& gyro = descriptor.capabilities[1];
    strlcpy(gyro.type, "sensor", 16);
    strlcpy(gyro.modality, "angular_velocity", 24);
    gyro.axes = 3;
    gyro.rangeMin = -2000.0f;
    gyro.rangeMax = 2000.0f;
    gyro.resolution = 0.1f;
    strlcpy(gyro.dataType, "float32[3]", 16);
    gyro.sampleRates[0] = 50;
    gyro.numSampleRates = 1;

    descriptor.numAffordances = 3;
    strlcpy(descriptor.affordances[0], "detect_gesture", 24);
    strlcpy(descriptor.affordances[1], "track_orientation", 24);
    strlcpy(descriptor.affordances[2], "count_repetitions", 24);

    descriptor.power.voltage = 3.3f;
    descriptor.power.currentTypical = 3.5f;
    descriptor.power.currentPeak = 10.0f;

    descriptor.physical.weight = 4.2f;
    descriptor.physical.dimensions[0] = 15.0f;
    descriptor.physical.dimensions[1] = 15.0f;
    descriptor.physical.dimensions[2] = 5.0f;
    descriptor.physical.numPlacements = 3;
    strlcpy(descriptor.physical.placements[0], "wrist", 16);
    strlcpy(descriptor.physical.placements[1], "forearm", 16);
    strlcpy(descriptor.physical.placements[2], "upper_arm", 16);
}

// ── Topic callback (module-specific) ─────────────────────────
void onTopicChange(uint8_t channelId, bool enable) {
    if (enable) topicMask |= (1ULL << channelId);
    else        topicMask &= ~(1ULL << channelId);
    Serial.printf("[IMU] Topic ch=%d %s\n", channelId, enable ? "ON" : "OFF");
}

void onRegistered(uint8_t slot, bool descriptorCached) {
    Serial.printf("[IMU] Registered slot=%d uid=%08lX cached=%d\n",
                  slot, (unsigned long)module.uid(), descriptorCached);
}

// ── Setup ─────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println();
    Serial.printf("=== WearBlocks IMU Module v%s ===\n", FW_VERSION);

    if (!module.begin(CAN_TX, CAN_RX)) {
        Serial.println("[IMU] CAN init FAILED!");
        while (1) delay(1000);
    }
    Serial.printf("[IMU] uid=%08lX\n", (unsigned long)module.uid());

    // Topic callback is module-specific — register directly on protocol.
    protocol.onTopic(onTopicChange);
    module.onAfterAck(onRegistered);

#if CHILD_DETECT
    for (uint8_t i = 0; i < 3; i++) {
        pinMode(CHILD_PINS[i].gpio, INPUT_PULLUP);
    }
    delay(20);
    // Init committed=false unconditionally. The first scanChildren() pass
    // will then debounce the *current* state and emit a CHILD_EVENT for
    // any face that's actually occupied — this is what makes "stack
    // assembled, then powered on" work.
    for (uint8_t i = 0; i < 3; i++) {
        childTracks[i].committed = false;
    }
#endif

    setupDescriptor();
    module.start();
    Serial.printf("[IMU] fwVersion=%s fwHash=%04X\n", FW_VERSION, module.fwHash());

    Wire.begin(I2C_SDA, I2C_SCL);
    imu.begin();
    imu.calcOffsets();

    Serial.println("[IMU] Ready");
}

// ── Loop ──────────────────────────────────────────────────────
void loop() {
    module.tick();

#if CHILD_DETECT
    scanChildren();
#endif

    uint32_t now = millis();

    if (module.registered() && now - lastSend >= SEND_INTERVAL) {
        lastSend = now;
        imu.update();

        float ax = imu.getAccX();
        float ay = imu.getAccY();
        float az = imu.getAccZ();
        float gx = imu.getGyroX();
        float gy = imu.getGyroY();
        float gz = imu.getGyroZ();

        protocol.sendSensorChannel(WB_CH_AX, ax);
        protocol.sendSensorChannel(WB_CH_AY, ay);
        protocol.sendSensorChannel(WB_CH_AZ, az);
        protocol.sendSensorChannel(WB_CH_GX, gx);
        protocol.sendSensorChannel(WB_CH_GY, gy);
        protocol.sendSensorChannel(WB_CH_GZ, gz);

        float accMag = sqrtf(ax*ax + ay*ay + az*az);

        if (isTopicEnabled(WB_CH_ACC_MAG))
            protocol.sendSensorChannel(WB_CH_ACC_MAG, accMag);
        if (isTopicEnabled(WB_CH_GYRO_MAG))
            protocol.sendSensorChannel(WB_CH_GYRO_MAG, sqrtf(gx*gx + gy*gy + gz*gz));
        if (isTopicEnabled(WB_CH_PITCH))
            protocol.sendSensorChannel(WB_CH_PITCH, atan2f(ay, sqrtf(ax*ax + az*az)) * 180.0f / M_PI);
        if (isTopicEnabled(WB_CH_ROLL))
            protocol.sendSensorChannel(WB_CH_ROLL, atan2f(ax, sqrtf(ay*ay + az*az)) * 180.0f / M_PI);
        if (isTopicEnabled(WB_CH_AX_LPF))
            protocol.sendSensorChannel(WB_CH_AX_LPF, lpfUpdate(lpf_ax, ax));
        if (isTopicEnabled(WB_CH_AY_LPF))
            protocol.sendSensorChannel(WB_CH_AY_LPF, lpfUpdate(lpf_ay, ay));
        if (isTopicEnabled(WB_CH_AZ_LPF))
            protocol.sendSensorChannel(WB_CH_AZ_LPF, lpfUpdate(lpf_az, az));
        if (isTopicEnabled(WB_CH_ACC_MAG_LPF))
            protocol.sendSensorChannel(WB_CH_ACC_MAG_LPF, lpfUpdate(lpf_acc_mag, accMag));
        if (isTopicEnabled(WB_CH_JERK)) {
            float jerk = fabsf(accMag - prevAccMag) * 50.0f;
            protocol.sendSensorChannel(WB_CH_JERK, jerk);
        }
        prevAccMag = accMag;

        if (isTopicEnabled(WB_CH_SHAKE)) {
            if (accMag > SHAKE_THRESHOLD && (now - lastShakeTime) > SHAKE_COOLDOWN) {
                protocol.sendSensorChannel(WB_CH_SHAKE, 1.0f);
                lastShakeTime = now;
            }
        }

        if (isTopicEnabled(WB_CH_STEP)) {
            bool aboveNow = (az > 0);
            if (aboveNow && !stepAboveZero && (now - lastStepTime) > STEP_MIN_INTERVAL) {
                stepCount++;
                lastStepTime = now;
                protocol.sendSensorChannel(WB_CH_STEP, (float)stepCount);
            }
            stepAboveZero = aboveNow;
        }

        if (isTopicEnabled(WB_CH_FREEFALL)) {
            if (accMag < FREEFALL_THRESHOLD) {
                if (!inFreefall) { freefallStart = now; inFreefall = true; }
                else if ((now - freefallStart) > FREEFALL_DURATION) {
                    protocol.sendSensorChannel(WB_CH_FREEFALL, 1.0f);
                    inFreefall = false;
                }
            } else {
                inFreefall = false;
            }
        }
    }

    protocol.sendHeartbeat();
    delay(1);
}
