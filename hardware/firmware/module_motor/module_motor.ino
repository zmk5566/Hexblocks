/*
 * HexBlocks dual DC motor module — ESP32-C3FH4 + DRV8410.
 *
 * Board mapping (HexBot hardware/motor-chip):
 *   GPIO0/GPIO1 -> AIN1/AIN2 -> Motor 1
 *   GPIO3/GPIO4 -> BIN1/BIN2 -> Motor 2
 *   GPIO10       -> nSLEEP
 *   GPIO6/GPIO7  -> CAN TX/RX (SN65HVD230)
 *
 * ACT_MOTOR_SET CAN payload:
 *   [motor, mode, speed, duration_hi, duration_lo]
 *   motor: 1 or 2
 *   mode:  0 stop/coast, 1 forward, 2 reverse
 *   speed: 0..255 PWM duty
 *   duration: milliseconds, big-endian; 0 means continuous
 */

#include <Arduino.h>
#include <WearBlocksCAN.h>
#include <WearBlocksProtocol.h>
#include <WearBlocksDescriptor.h>
#include <WearBlocksModule.h>
#include <WearBlocksECA.h>

#if __has_include(<esp_arduino_version.h>)
#include <esp_arduino_version.h>
#endif

#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

static const char* FW_VERSION = "1.0";

static const uint8_t CAN_TX_PIN = 6;
static const uint8_t CAN_RX_PIN = 7;
static const uint8_t MOTOR1_IN1_PIN = 0;
static const uint8_t MOTOR1_IN2_PIN = 1;
static const uint8_t MOTOR2_IN1_PIN = 3;
static const uint8_t MOTOR2_IN2_PIN = 4;
static const uint8_t MOTOR_SLEEP_PIN = 10;

static const uint32_t PWM_FREQ_HZ = 20000;
static const uint8_t PWM_BITS = 8;
static const uint8_t CH_M1_IN1 = 0;
static const uint8_t CH_M1_IN2 = 1;
static const uint8_t CH_M2_IN1 = 2;
static const uint8_t CH_M2_IN2 = 3;

enum MotorMode : uint8_t {
    MOTOR_STOP = 0,
    MOTOR_FORWARD = 1,
    MOTOR_REVERSE = 2,
};

struct MotorState {
    uint8_t mode;
    uint8_t speed;
    uint32_t untilMs;
};

WearBlocksCAN can;
WearBlocksProtocol protocol;
WearBlocksDescriptor descriptor;
WBModule module(can, protocol, descriptor);
MotorState motors[2] = {{MOTOR_STOP, 0, 0}, {MOTOR_STOP, 0, 0}};

static void writePwm(uint8_t pin, uint8_t channel, uint8_t duty) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    (void)channel;
    ledcWrite(pin, duty);
#else
    (void)pin;
    ledcWrite(channel, duty);
#endif
}

static bool attachPwm(uint8_t pin, uint8_t channel) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    (void)channel;
    bool ok = ledcAttach(pin, PWM_FREQ_HZ, PWM_BITS);
#else
    double actual = ledcSetup(channel, PWM_FREQ_HZ, PWM_BITS);
    ledcAttachPin(pin, channel);
    bool ok = actual > 0;
#endif
    if (ok) writePwm(pin, channel, 0);
    return ok;
}

static void applyOutputs(uint8_t index) {
    const MotorState& state = motors[index];
    const bool first = index == 0;
    const uint8_t in1 = first ? MOTOR1_IN1_PIN : MOTOR2_IN1_PIN;
    const uint8_t in2 = first ? MOTOR1_IN2_PIN : MOTOR2_IN2_PIN;
    const uint8_t ch1 = first ? CH_M1_IN1 : CH_M2_IN1;
    const uint8_t ch2 = first ? CH_M1_IN2 : CH_M2_IN2;

    if (state.mode == MOTOR_FORWARD && state.speed > 0) {
        writePwm(in1, ch1, state.speed);
        writePwm(in2, ch2, 0);
    } else if (state.mode == MOTOR_REVERSE && state.speed > 0) {
        writePwm(in1, ch1, 0);
        writePwm(in2, ch2, state.speed);
    } else {
        writePwm(in1, ch1, 0);
        writePwm(in2, ch2, 0);
    }
}

static void setMotor(uint8_t motor, uint8_t mode, uint8_t speed,
                     uint16_t durationMs) {
    if (motor < 1 || motor > 2 || mode > MOTOR_REVERSE) return;
    const uint8_t index = motor - 1;
    MotorState& state = motors[index];

    if (mode == MOTOR_STOP || speed == 0) {
        state = {MOTOR_STOP, 0, 0};
    } else {
        state.mode = mode;
        state.speed = speed;
        state.untilMs = durationMs > 0 ? millis() + durationMs : 0;
    }
    applyOutputs(index);
    Serial.printf("[MOTOR] M%d mode=%d speed=%d duration=%u\n",
                  motor, state.mode, state.speed, durationMs);
}

static void onActuatorCmd(uint8_t cmd, const uint8_t* p, uint8_t pLen) {
    if (cmd != ACT_MOTOR_SET || pLen < 5) return;
    const uint16_t durationMs = ((uint16_t)p[3] << 8) | p[4];
    setMotor(p[0], p[1], p[2], durationMs);
}

static void tickMotors() {
    const uint32_t now = millis();
    for (uint8_t i = 0; i < 2; i++) {
        if (motors[i].untilMs != 0 &&
            (int32_t)(now - motors[i].untilMs) >= 0) {
            motors[i] = {MOTOR_STOP, 0, 0};
            applyOutputs(i);
            Serial.printf("[MOTOR] M%d duration complete\n", i + 1);
        }
    }
}

static void setupDescriptor() {
    char id[20];
    snprintf(id, sizeof(id), "motor_%08lX", (unsigned long)module.uid());
    strlcpy(descriptor.moduleId, id, sizeof(descriptor.moduleId));
    strlcpy(descriptor.name, "Dual DC Motor", sizeof(descriptor.name));
    strlcpy(descriptor.category, "motor_output", sizeof(descriptor.category));
    strlcpy(descriptor.color, "#D97757", sizeof(descriptor.color));
    strlcpy(descriptor.version, FW_VERSION, sizeof(descriptor.version));

    descriptor.numCapabilities = 1;
    WBCapability& motor = descriptor.capabilities[0];
    strlcpy(motor.type, "actuator", sizeof(motor.type));
    strlcpy(motor.modality, "dual_motor", sizeof(motor.modality));
    motor.axes = 2;
    motor.rangeMin = -255.0f;
    motor.rangeMax = 255.0f;
    motor.resolution = 1.0f;
    strlcpy(motor.dataType, "int16[2]", sizeof(motor.dataType));
    motor.numSampleRates = 0;

    descriptor.numAffordances = 1;
    strlcpy(descriptor.affordances[0], "independent_motor_control",
            sizeof(descriptor.affordances[0]));
    descriptor.power.voltage = 5.0f;
    descriptor.power.currentTypical = 100.0f;
    descriptor.power.currentPeak = 1000.0f;
    descriptor.physical.weight = 8.0f;
    descriptor.physical.dimensions[0] = 32.0f;
    descriptor.physical.dimensions[1] = 32.0f;
    descriptor.physical.dimensions[2] = 8.0f;
    descriptor.physical.numPlacements = 1;
    strlcpy(descriptor.physical.placements[0], "robot",
            sizeof(descriptor.physical.placements[0]));
}

void setup() {
    Serial.begin(115200);
    delay(300);

    pinMode(MOTOR_SLEEP_PIN, OUTPUT);
    digitalWrite(MOTOR_SLEEP_PIN, LOW);
    bool pwmOk = attachPwm(MOTOR1_IN1_PIN, CH_M1_IN1)
              && attachPwm(MOTOR1_IN2_PIN, CH_M1_IN2)
              && attachPwm(MOTOR2_IN1_PIN, CH_M2_IN1)
              && attachPwm(MOTOR2_IN2_PIN, CH_M2_IN2);
    if (!pwmOk) {
        Serial.println("[MOTOR] PWM init failed");
        while (true) delay(1000);
    }

    digitalWrite(MOTOR_SLEEP_PIN, HIGH);
    delayMicroseconds(200);

    if (!module.begin(CAN_TX_PIN, CAN_RX_PIN)) {
        Serial.println("[MOTOR] CAN init failed");
        while (true) delay(1000);
    }
    protocol.onActuatorCommand(onActuatorCmd);
    setupDescriptor();
    module.start();
    Serial.printf("[MOTOR] ready uid=%08lX\n", (unsigned long)module.uid());
}

void loop() {
    module.tick();
    tickMotors();
    protocol.sendHeartbeat();
    delay(1);
}
