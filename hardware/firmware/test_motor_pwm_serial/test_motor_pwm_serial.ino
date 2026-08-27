/*
 * HexBlocks DRV8833 serial PWM test
 *
 * Wiring:
 *   DRV8833 IN1 -> GPIO1   Motor 1 input 1
 *   DRV8833 IN2 -> GPIO2   Motor 1 input 2
 *   DRV8833 IN3 -> GPIO3   Motor 2 input 1
 *   DRV8833 IN4 -> GPIO4   Motor 2 input 2
 *
 * Serial Monitor: 115200 baud, Newline or Both NL & CR
 * Commands:
 *   M1,<speed>       Motor 1 speed, -255..255
 *   M2,<speed>       Motor 2 speed, -255..255
 *   BOTH,<speed>     Both motors, -255..255
 *   STOP
 *   STATUS
 *   HELP
 */

#include <Arduino.h>
#include <ctype.h>

#if __has_include(<esp_arduino_version.h>)
#include <esp_arduino_version.h>
#endif

#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

static const uint8_t MOTOR1_IN1_PIN = 1;
static const uint8_t MOTOR1_IN2_PIN = 2;
static const uint8_t MOTOR2_IN1_PIN = 3;
static const uint8_t MOTOR2_IN2_PIN = 4;

static const uint8_t CH_M1_IN1 = 0;
static const uint8_t CH_M1_IN2 = 1;
static const uint8_t CH_M2_IN1 = 2;
static const uint8_t CH_M2_IN2 = 3;

static const uint32_t PWM_FREQ_HZ = 20000;
static const uint8_t PWM_BITS = 8;
static const uint16_t REVERSE_COAST_MS = 30;

static char g_line[64] = {0};
static size_t g_lineLength = 0;
static bool g_lineOverflow = false;
static bool g_pwmReady = false;
static int g_motor1Speed = 0;
static int g_motor2Speed = 0;

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
    double actualFrequency = ledcSetup(channel, PWM_FREQ_HZ, PWM_BITS);
    ledcAttachPin(pin, channel);
    bool ok = actualFrequency > 0;
#endif
    if (ok) writePwm(pin, channel, 0);
    return ok;
}

static bool changesDirection(int previous, int next) {
    return (previous > 0 && next < 0) || (previous < 0 && next > 0);
}

static void writeMotor(uint8_t in1Pin, uint8_t in1Channel,
                       uint8_t in2Pin, uint8_t in2Channel,
                       int speed) {
    uint8_t duty = (uint8_t)abs(speed);
    if (speed > 0) {
        writePwm(in1Pin, in1Channel, duty);
        writePwm(in2Pin, in2Channel, 0);
    } else if (speed < 0) {
        writePwm(in1Pin, in1Channel, 0);
        writePwm(in2Pin, in2Channel, duty);
    } else {
        writePwm(in1Pin, in1Channel, 0);
        writePwm(in2Pin, in2Channel, 0);
    }
}

static void setMotor1(int speed) {
    if (changesDirection(g_motor1Speed, speed)) {
        writeMotor(MOTOR1_IN1_PIN, CH_M1_IN1,
                   MOTOR1_IN2_PIN, CH_M1_IN2, 0);
        delay(REVERSE_COAST_MS);
    }
    g_motor1Speed = speed;
    writeMotor(MOTOR1_IN1_PIN, CH_M1_IN1,
               MOTOR1_IN2_PIN, CH_M1_IN2, speed);
}

static void setMotor2(int speed) {
    if (changesDirection(g_motor2Speed, speed)) {
        writeMotor(MOTOR2_IN1_PIN, CH_M2_IN1,
                   MOTOR2_IN2_PIN, CH_M2_IN2, 0);
        delay(REVERSE_COAST_MS);
    }
    g_motor2Speed = speed;
    writeMotor(MOTOR2_IN1_PIN, CH_M2_IN1,
               MOTOR2_IN2_PIN, CH_M2_IN2, speed);
}

static void stopAll() {
    setMotor1(0);
    setMotor2(0);
}

static void printStatus() {
    Serial.printf("STATUS,M1=%d,M2=%d,PWM=%luHz,READY=%s\n",
                  g_motor1Speed,
                  g_motor2Speed,
                  (unsigned long)PWM_FREQ_HZ,
                  g_pwmReady ? "yes" : "no");
}

static void printHelp() {
    Serial.println("M1,<speed> | M2,<speed> | BOTH,<speed> | STOP | STATUS | HELP");
    Serial.println("speed range: -255..255; negative values reverse direction");
}

static bool parseSpeed(const char* line, const char* prefix, int* speed) {
    size_t prefixLength = strlen(prefix);
    if (strncmp(line, prefix, prefixLength) != 0) return false;

    char trailing = '\0';
    int parsed = sscanf(line + prefixLength, "%d%c", speed, &trailing);
    if (parsed != 1) {
        Serial.println("ERR,bad-speed");
        return false;
    }
    if (*speed < -255 || *speed > 255) {
        Serial.println("ERR,speed-range,-255..255");
        return false;
    }
    if (!g_pwmReady && *speed != 0) {
        Serial.println("ERR,pwm-not-ready");
        return false;
    }
    return true;
}

static void handleCommand(char* line) {
    while (*line == ' ' || *line == '\t') line++;

    char* end = line + strlen(line);
    while (end > line && (end[-1] == ' ' || end[-1] == '\t')) *--end = '\0';
    for (char* p = line; *p != '\0'; p++) {
        *p = (char)toupper((unsigned char)*p);
    }

    if (strcmp(line, "STOP") == 0) {
        stopAll();
        Serial.println("OK,STOP");
        return;
    }
    if (strcmp(line, "STATUS") == 0) {
        printStatus();
        return;
    }
    if (strcmp(line, "HELP") == 0) {
        printHelp();
        return;
    }

    int speed = 0;
    if (strncmp(line, "M1,", 3) == 0) {
        if (parseSpeed(line, "M1,", &speed) && speed >= -255 && speed <= 255) {
            if (!g_pwmReady && speed != 0) return;
            setMotor1(speed);
            Serial.printf("OK,M1,%d\n", g_motor1Speed);
        }
        return;
    }
    if (strncmp(line, "M2,", 3) == 0) {
        if (parseSpeed(line, "M2,", &speed) && speed >= -255 && speed <= 255) {
            if (!g_pwmReady && speed != 0) return;
            setMotor2(speed);
            Serial.printf("OK,M2,%d\n", g_motor2Speed);
        }
        return;
    }
    if (strncmp(line, "BOTH,", 5) == 0) {
        if (parseSpeed(line, "BOTH,", &speed) && speed >= -255 && speed <= 255) {
            if (!g_pwmReady && speed != 0) return;
            setMotor1(speed);
            setMotor2(speed);
            Serial.printf("OK,BOTH,%d\n", speed);
        }
        return;
    }

    Serial.println("ERR,unknown-command; send HELP");
}

static void serviceSerial() {
    while (Serial.available() > 0) {
        char ch = (char)Serial.read();
        if (ch == '\n' || ch == '\r') {
            if (g_lineOverflow) {
                Serial.println("ERR,line-too-long");
            } else if (g_lineLength > 0) {
                g_line[g_lineLength] = '\0';
                handleCommand(g_line);
            }
            g_lineLength = 0;
            g_lineOverflow = false;
        } else if (!g_lineOverflow) {
            if (g_lineLength < sizeof(g_line) - 1) {
                g_line[g_lineLength++] = ch;
            } else {
                g_lineOverflow = true;
            }
        }
    }
}

void setup() {
    Serial.begin(115200);
    delay(300);

    bool in1Ok = attachPwm(MOTOR1_IN1_PIN, CH_M1_IN1);
    bool in2Ok = attachPwm(MOTOR1_IN2_PIN, CH_M1_IN2);
    bool in3Ok = attachPwm(MOTOR2_IN1_PIN, CH_M2_IN1);
    bool in4Ok = attachPwm(MOTOR2_IN2_PIN, CH_M2_IN2);
    g_pwmReady = in1Ok && in2Ok && in3Ok && in4Ok;
    stopAll();

    Serial.println();
    Serial.println("=== HexBlocks DRV8833 Serial PWM Test ===");
    Serial.printf("PWM_ATTACH,GPIO1=%s,GPIO2=%s,GPIO3=%s,GPIO4=%s\n",
                  in1Ok ? "ok" : "fail",
                  in2Ok ? "ok" : "fail",
                  in3Ok ? "ok" : "fail",
                  in4Ok ? "ok" : "fail");
    printStatus();
    printHelp();
}

void loop() {
    serviceSerial();
    delay(1);
}
