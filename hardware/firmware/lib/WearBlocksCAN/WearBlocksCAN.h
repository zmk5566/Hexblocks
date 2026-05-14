#ifndef WEARBLOCKS_CAN_H
#define WEARBLOCKS_CAN_H

#include <Arduino.h>
#include <driver/twai.h>

#define WB_CAN_DEFAULT_BAUD 500000
#define WB_CAN_RX_QUEUE_SIZE 32
#define WB_CAN_TX_QUEUE_SIZE 20    // ESP-IDF default is 5; 20 gives headroom
                                   // for the 68-frame descriptor burst so a
                                   // brief ACK hiccup during hot-plug doesn't
                                   // saturate the queue in <1ms.
#define WB_CAN_TX_TIMEOUT_MS 50

typedef void (*WBCanReceiveCallback)(uint32_t canId, const uint8_t* data, uint8_t len);

class WearBlocksCAN {
public:
    WearBlocksCAN();

    bool begin(uint8_t txPin, uint8_t rxPin, uint32_t baudRate = WB_CAN_DEFAULT_BAUD);
    void end();

    bool send(uint32_t canId, const uint8_t* data, uint8_t len);
    bool receive(uint32_t& canId, uint8_t* data, uint8_t& len, uint32_t timeoutMs = 10);

    void onReceive(WBCanReceiveCallback callback);
    void processReceived();

    bool isRunning() const;
    uint32_t getTxErrorCount() const;
    uint32_t getRxErrorCount() const;

private:
    bool _running;
    WBCanReceiveCallback _rxCallback;
};

#endif
