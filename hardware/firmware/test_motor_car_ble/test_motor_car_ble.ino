/*
 * HexBlocks Motor Hub BLE Car Test
 * Target: ESP32-C3, Arduino IDE / arduino-cli
 *
 * This is an isolated bring-up sketch. It does not use WearBlocks CAN,
 * topology, ECA, or module protocol code.
 *
 * Wiring:
 *   DRV8833 module IN1 -> GPIO1   Motor 1 input 1
 *   DRV8833 module IN2 -> GPIO2   Motor 1 input 2
 *   DRV8833 module IN3 -> GPIO3   Motor 2 input 1
 *   DRV8833 module IN4 -> GPIO4   Motor 2 input 2
 *   DRV8833 module EEP -> NC      board has 47k pull-up to VCC
 *   DRV8833 module ULT -> NC
 *
 * BLE protocol:
 *   D,<left>,<right>\n   left/right are signed speeds -255..255
 *   S\n                  coast stop
 *   B\n                  brake stop
 *   P\n                  ping/status
 */

#include <Arduino.h>
#include <NimBLEDevice.h>

#if __has_include(<esp_arduino_version.h>)
#include <esp_arduino_version.h>
#endif

#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

// Custom UUIDs for this standalone test.
#define CAR_SERVICE_UUID "6f8f0001-b5a3-f393-e0a9-e50e24dcca9e"
#define CAR_RX_CHAR_UUID "6f8f0002-b5a3-f393-e0a9-e50e24dcca9e"  // browser -> car
#define CAR_TX_CHAR_UUID "6f8f0003-b5a3-f393-e0a9-e50e24dcca9e"  // car -> browser

#define DEVICE_NAME "HexMotorCar"

static const uint8_t MOTOR1_IN1_PIN = 1;
static const uint8_t MOTOR1_IN2_PIN = 2;
static const uint8_t MOTOR2_IN1_PIN = 3;
static const uint8_t MOTOR2_IN2_PIN = 4;

static const uint32_t PWM_FREQ = 20000;
static const uint8_t PWM_BITS = 8;

static const uint8_t CH_M1_IN1 = 0;
static const uint8_t CH_M1_IN2 = 1;
static const uint8_t CH_M2_IN1 = 2;
static const uint8_t CH_M2_IN2 = 3;

NimBLECharacteristic* g_txChar = nullptr;
bool g_bleConnected = false;

char g_cmdBuf[64] = {0};
size_t g_cmdLen = 0;

int g_leftSpeed = 0;
int g_rightSpeed = 0;

static void writePwm(uint8_t pin, uint8_t channel, uint8_t duty) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    (void)channel;
    ledcWrite(pin, duty);
#else
    (void)pin;
    ledcWrite(channel, duty);
#endif
}

static void setupPwmPin(uint8_t pin, uint8_t channel) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    (void)channel;
    ledcAttach(pin, PWM_FREQ, PWM_BITS);
#else
    ledcSetup(channel, PWM_FREQ, PWM_BITS);
    ledcAttachPin(pin, channel);
#endif
    writePwm(pin, channel, 0);
}

static int clampSpeed(int v) {
    if (v > 255) return 255;
    if (v < -255) return -255;
    return v;
}

static void notifyStatus(const char* msg) {
    if (!g_bleConnected || g_txChar == nullptr) return;
    g_txChar->setValue((const uint8_t*)msg, strlen(msg));
    g_txChar->notify();
}

static void setMotor(uint8_t in1Pin, uint8_t in1Ch,
                     uint8_t in2Pin, uint8_t in2Ch,
                     int speed) {
    speed = clampSpeed(speed);
    uint8_t duty = (uint8_t)abs(speed);

    if (speed > 0) {
        writePwm(in1Pin, in1Ch, duty);
        writePwm(in2Pin, in2Ch, 0);
    } else if (speed < 0) {
        writePwm(in1Pin, in1Ch, 0);
        writePwm(in2Pin, in2Ch, duty);
    } else {
        writePwm(in1Pin, in1Ch, 0);
        writePwm(in2Pin, in2Ch, 0);
    }
}

static void applyDrive(int left, int right) {
    g_leftSpeed = clampSpeed(left);
    g_rightSpeed = clampSpeed(right);

    setMotor(MOTOR1_IN1_PIN, CH_M1_IN1, MOTOR1_IN2_PIN, CH_M1_IN2, g_leftSpeed);
    setMotor(MOTOR2_IN1_PIN, CH_M2_IN1, MOTOR2_IN2_PIN, CH_M2_IN2, g_rightSpeed);

    char line[48];
    snprintf(line, sizeof(line), "D,%d,%d\n", g_leftSpeed, g_rightSpeed);
    Serial.print(line);
    notifyStatus(line);
}

static void coastStop() {
    applyDrive(0, 0);
}

static void brakeStop() {
    writePwm(MOTOR1_IN1_PIN, CH_M1_IN1, 255);
    writePwm(MOTOR1_IN2_PIN, CH_M1_IN2, 255);
    writePwm(MOTOR2_IN1_PIN, CH_M2_IN1, 255);
    writePwm(MOTOR2_IN2_PIN, CH_M2_IN2, 255);
    delay(80);
    coastStop();
}

static void handleCommand(char* cmd) {
    while (*cmd == ' ' || *cmd == '\t') cmd++;

    if (cmd[0] == 'S') {
        coastStop();
        return;
    }

    if (cmd[0] == 'B') {
        brakeStop();
        return;
    }

    if (cmd[0] == 'P') {
        char line[48];
        snprintf(line, sizeof(line), "OK,%d,%d\n", g_leftSpeed, g_rightSpeed);
        Serial.print(line);
        notifyStatus(line);
        return;
    }

    if (cmd[0] == 'D' && cmd[1] == ',') {
        char* comma = strchr(cmd + 2, ',');
        if (!comma) {
            notifyStatus("ERR,bad-drive\n");
            return;
        }
        *comma = '\0';
        int left = atoi(cmd + 2);
        int right = atoi(comma + 1);
        applyDrive(left, right);
        return;
    }

    notifyStatus("ERR,unknown\n");
}

class CarServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* server, NimBLEConnInfo& connInfo) override {
        (void)server;
        (void)connInfo;
        g_bleConnected = true;
        Serial.println("[BLE] connected");
        notifyStatus("OK,connected\n");
    }

    void onDisconnect(NimBLEServer* server, NimBLEConnInfo& connInfo, int reason) override {
        (void)server;
        (void)connInfo;
        (void)reason;
        g_bleConnected = false;
        coastStop();
        Serial.println("[BLE] disconnected; motors stopped");
        NimBLEDevice::startAdvertising();
    }
};

class CarRxCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& connInfo) override {
        (void)connInfo;
        const NimBLEAttValue& v = c->getValue();
        const uint8_t* data = v.data();

        for (size_t i = 0; i < v.size(); i++) {
            char ch = (char)data[i];
            if (ch == '\n' || ch == '\r') {
                if (g_cmdLen > 0) {
                    g_cmdBuf[g_cmdLen] = '\0';
                    handleCommand(g_cmdBuf);
                    g_cmdLen = 0;
                }
            } else if (g_cmdLen < sizeof(g_cmdBuf) - 1) {
                g_cmdBuf[g_cmdLen++] = ch;
            }
        }
    }
};

static void setupBle() {
    NimBLEDevice::init(DEVICE_NAME);
    NimBLEDevice::setMTU(128);

    NimBLEServer* server = NimBLEDevice::createServer();
    server->setCallbacks(new CarServerCallbacks());

    NimBLEService* service = server->createService(CAR_SERVICE_UUID);
    NimBLECharacteristic* rxChar = service->createCharacteristic(
        CAR_RX_CHAR_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
    g_txChar = service->createCharacteristic(
        CAR_TX_CHAR_UUID,
        NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

    rxChar->setCallbacks(new CarRxCallbacks());
    g_txChar->setValue("READY\n");

    service->start();

    NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
    adv->addServiceUUID(CAR_SERVICE_UUID);
    adv->setName(DEVICE_NAME);
    adv->enableScanResponse(true);
    adv->start();
}

void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println();
    Serial.println("=== HexBlocks Motor Hub BLE Car Test ===");

    setupPwmPin(MOTOR1_IN1_PIN, CH_M1_IN1);
    setupPwmPin(MOTOR1_IN2_PIN, CH_M1_IN2);
    setupPwmPin(MOTOR2_IN1_PIN, CH_M2_IN1);
    setupPwmPin(MOTOR2_IN2_PIN, CH_M2_IN2);
    coastStop();

    setupBle();
    Serial.printf("[BLE] advertising as %s\n", DEVICE_NAME);
    Serial.println("[CMD] D,<left>,<right> | S | B | P");
}

void loop() {
    delay(20);
}
