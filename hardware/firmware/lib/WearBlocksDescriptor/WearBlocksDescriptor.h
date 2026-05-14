#ifndef WEARBLOCKS_DESCRIPTOR_H
#define WEARBLOCKS_DESCRIPTOR_H

#include <Arduino.h>

#define WB_DESC_MAX_CAPABILITIES 4
#define WB_DESC_MAX_AFFORDANCES 6
#define WB_DESC_MAX_PLACEMENTS 6
#define WB_DESC_MAX_SERIALIZED 512

// --- ROS-inspired Capability Description ---
struct WBCapability {
    char type[16];          // "sensor" or "actuator"
    char modality[24];      // "acceleration", "heart_rate", "vibration", etc.
    uint8_t axes;           // Number of axes (e.g., 3 for IMU accel)
    float rangeMin;         // Min value (e.g., -16g)
    float rangeMax;         // Max value (e.g., +16g)
    float resolution;       // Smallest detectable change (e.g., 0.001g)
    char dataType[16];      // "float32[3]", "uint8", "bool", etc.
    uint16_t sampleRates[4];
    uint8_t numSampleRates;
};

// --- Power Profile ---
struct WBPowerProfile {
    float voltage;           // Operating voltage (e.g., 3.3)
    float currentTypical;    // Typical current draw in mA
    float currentPeak;       // Peak current draw in mA
};

// --- Physical Properties ---
struct WBPhysical {
    float weight;            // Weight in grams
    float dimensions[3];     // [width, height, depth] in mm
    uint8_t numPlacements;
    char placements[WB_DESC_MAX_PLACEMENTS][16];  // Suitable body locations
};

// --- Full Module Descriptor (ROS-inspired) ---
struct WearBlocksDescriptor {
    // Identity
    char moduleId[16];       // Unique ID: "imu_6axis_v2"
    char name[32];           // Human name: "6-Axis IMU"
    char category[24];       // "motion_sensing", "biometric", etc.
    char color[8];           // "#7CA1BB" (matches physical enclosure)
    char version[8];         // "2.0"

    // Capabilities (like ROS topics/services)
    uint8_t numCapabilities;
    WBCapability capabilities[WB_DESC_MAX_CAPABILITIES];

    // Affordances (natural-language-friendly, for LLM consumption)
    uint8_t numAffordances;
    char affordances[WB_DESC_MAX_AFFORDANCES][24];

    // Power profile
    WBPowerProfile power;

    // Physical properties
    WBPhysical physical;

    // Serialization
    uint16_t serialize(uint8_t* buffer, uint16_t maxLen) const;
    bool deserialize(const uint8_t* buffer, uint16_t len);

    // Flash persistence
    void saveToFlash(const char* nsName = "wbdesc");
    bool loadFromFlash(const char* nsName = "wbdesc");

    // JSON export (for LLM system prompt and BLE transfer)
    String toJSON() const;

    // Generate LLM-friendly text description
    String toLLMPrompt() const;
};

#endif
