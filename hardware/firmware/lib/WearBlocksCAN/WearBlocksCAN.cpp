#include "WearBlocksCAN.h"

WearBlocksCAN::WearBlocksCAN()
    : _running(false), _rxCallback(nullptr) {}

bool WearBlocksCAN::begin(uint8_t txPin, uint8_t rxPin, uint32_t baudRate) {
    twai_general_config_t g_config = TWAI_GENERAL_CONFIG_DEFAULT(
        (gpio_num_t)txPin, (gpio_num_t)rxPin, TWAI_MODE_NORMAL);
    g_config.rx_queue_len = WB_CAN_RX_QUEUE_SIZE;
    g_config.tx_queue_len = WB_CAN_TX_QUEUE_SIZE;

    twai_timing_config_t t_config;
    switch (baudRate) {
        case 1000000: t_config = TWAI_TIMING_CONFIG_1MBITS(); break;
        case 500000:  t_config = TWAI_TIMING_CONFIG_500KBITS(); break;
        case 250000:  t_config = TWAI_TIMING_CONFIG_250KBITS(); break;
        case 125000:  t_config = TWAI_TIMING_CONFIG_125KBITS(); break;
        default:      t_config = TWAI_TIMING_CONFIG_500KBITS(); break;
    }

    twai_filter_config_t f_config = TWAI_FILTER_CONFIG_ACCEPT_ALL();

    esp_err_t err = twai_driver_install(&g_config, &t_config, &f_config);
    if (err != ESP_OK) {
        Serial.printf("[WB-CAN] Driver install failed: 0x%x\n", err);
        return false;
    }

    err = twai_start();
    if (err != ESP_OK) {
        Serial.printf("[WB-CAN] Start failed: 0x%x\n", err);
        twai_driver_uninstall();
        return false;
    }

    _running = true;
    Serial.printf("[WB-CAN] Started at %lu bps\n", baudRate);
    return true;
}

void WearBlocksCAN::end() {
    if (_running) {
        twai_stop();
        twai_driver_uninstall();
        _running = false;
        Serial.println("[WB-CAN] Stopped");
    }
}

bool WearBlocksCAN::send(uint32_t canId, const uint8_t* data, uint8_t len) {
    if (!_running || len > 8) return false;

    // Bus-off recovery. ESP-IDF TWAI does not auto-recover: once TEC ≥ 256 the
    // driver latches into BUS_OFF and every subsequent twai_transmit() returns
    // ESP_ERR_TIMEOUT forever. Symptoms in logs were exactly "TX failed 0x107"
    // on every heartbeat + HELLO after a descriptor burst starved the bus of
    // ACKs during a hot-plug transient. We fix it in-line:
    //   BUS_OFF   → kick off recovery (non-blocking; takes ~128 bits of idle).
    //                Return false so the caller doesn't keep stacking failures.
    //   STOPPED   → recovery finished, driver is halted. Restart it, then
    //                fall through and attempt this TX.
    twai_status_info_t status;
    if (twai_get_status_info(&status) == ESP_OK) {
        if (status.state == TWAI_STATE_BUS_OFF) {
            Serial.println("[WB-CAN] BUS_OFF — initiating recovery");
            twai_initiate_recovery();
            return false;
        }
        if (status.state == TWAI_STATE_STOPPED) {
            Serial.println("[WB-CAN] driver STOPPED — restarting after recovery");
            if (twai_start() != ESP_OK) return false;
        }
    }

    twai_message_t msg = {};
    msg.identifier = canId;
    msg.data_length_code = len;
    msg.extd = 0;
    memcpy(msg.data, data, len);

    esp_err_t err = twai_transmit(&msg, pdMS_TO_TICKS(WB_CAN_TX_TIMEOUT_MS));
    if (err != ESP_OK) {
        Serial.printf("[WB-CAN] TX failed (0x%03X): 0x%x\n", canId, err);
        return false;
    }
    return true;
}

bool WearBlocksCAN::receive(uint32_t& canId, uint8_t* data, uint8_t& len,
                            uint32_t timeoutMs) {
    if (!_running) return false;

    twai_message_t msg;
    esp_err_t err = twai_receive(&msg, pdMS_TO_TICKS(timeoutMs));
    if (err != ESP_OK) return false;

    canId = msg.identifier;
    len = msg.data_length_code;
    memcpy(data, msg.data, len);
    return true;
}

void WearBlocksCAN::onReceive(WBCanReceiveCallback callback) {
    _rxCallback = callback;
}

void WearBlocksCAN::processReceived() {
    if (!_running || !_rxCallback) return;

    uint32_t canId;
    uint8_t data[8];
    uint8_t len;

    while (receive(canId, data, len, 0)) {
        _rxCallback(canId, data, len);
    }
}

bool WearBlocksCAN::isRunning() const {
    return _running;
}

uint32_t WearBlocksCAN::getTxErrorCount() const {
    twai_status_info_t status;
    if (twai_get_status_info(&status) == ESP_OK) {
        return status.tx_error_counter;
    }
    return 0;
}

uint32_t WearBlocksCAN::getRxErrorCount() const {
    twai_status_info_t status;
    if (twai_get_status_info(&status) == ESP_OK) {
        return status.rx_error_counter;
    }
    return 0;
}
