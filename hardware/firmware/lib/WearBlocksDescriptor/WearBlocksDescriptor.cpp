#include "WearBlocksDescriptor.h"
#include <Preferences.h>
#include <ArduinoJson.h>

uint16_t WearBlocksDescriptor::serialize(uint8_t* buffer, uint16_t maxLen) const {
    JsonDocument doc;

    // Identity
    doc["id"] = moduleId;
    doc["name"] = name;
    doc["cat"] = category;
    doc["color"] = color;
    doc["ver"] = version;

    // Capabilities
    JsonArray caps = doc["caps"].to<JsonArray>();
    for (uint8_t i = 0; i < numCapabilities; i++) {
        JsonObject cap = caps.add<JsonObject>();
        cap["t"] = capabilities[i].type;
        cap["m"] = capabilities[i].modality;
        cap["ax"] = capabilities[i].axes;
        cap["rn"] = capabilities[i].rangeMin;
        cap["rx"] = capabilities[i].rangeMax;
        cap["res"] = capabilities[i].resolution;
        cap["dt"] = capabilities[i].dataType;
        JsonArray sr = cap["sr"].to<JsonArray>();
        for (uint8_t j = 0; j < capabilities[i].numSampleRates; j++) {
            sr.add(capabilities[i].sampleRates[j]);
        }
    }

    // Affordances
    JsonArray affs = doc["affs"].to<JsonArray>();
    for (uint8_t i = 0; i < numAffordances; i++) {
        affs.add(affordances[i]);
    }

    // Power
    JsonObject pwr = doc["pwr"].to<JsonObject>();
    pwr["v"] = power.voltage;
    pwr["i"] = power.currentTypical;
    pwr["ip"] = power.currentPeak;

    // Physical
    JsonObject phy = doc["phy"].to<JsonObject>();
    phy["w"] = physical.weight;
    JsonArray dim = phy["dim"].to<JsonArray>();
    dim.add(physical.dimensions[0]);
    dim.add(physical.dimensions[1]);
    dim.add(physical.dimensions[2]);
    JsonArray plc = phy["plc"].to<JsonArray>();
    for (uint8_t i = 0; i < physical.numPlacements; i++) {
        plc.add(physical.placements[i]);
    }

    size_t len = serializeJson(doc, (char*)buffer, maxLen);
    return (uint16_t)len;
}

bool WearBlocksDescriptor::deserialize(const uint8_t* buffer, uint16_t len) {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, (const char*)buffer, len);
    if (err) {
        Serial.printf("[WB-DESC] Deserialize error: %s\n", err.c_str());
        return false;
    }

    // Identity
    strlcpy(moduleId, doc["id"] | "", sizeof(moduleId));
    strlcpy(name, doc["name"] | "", sizeof(name));
    strlcpy(category, doc["cat"] | "", sizeof(category));
    strlcpy(color, doc["color"] | "", sizeof(color));
    strlcpy(version, doc["ver"] | "1.0", sizeof(version));

    // Capabilities
    JsonArray caps = doc["caps"].as<JsonArray>();
    numCapabilities = 0;
    for (JsonObject cap : caps) {
        if (numCapabilities >= WB_DESC_MAX_CAPABILITIES) break;
        WBCapability& c = capabilities[numCapabilities];
        strlcpy(c.type, cap["t"] | "", sizeof(c.type));
        strlcpy(c.modality, cap["m"] | "", sizeof(c.modality));
        c.axes = cap["ax"] | 1;
        c.rangeMin = cap["rn"] | 0.0f;
        c.rangeMax = cap["rx"] | 0.0f;
        c.resolution = cap["res"] | 0.0f;
        strlcpy(c.dataType, cap["dt"] | "float32", sizeof(c.dataType));
        c.numSampleRates = 0;
        JsonArray sr = cap["sr"].as<JsonArray>();
        for (uint16_t rate : sr) {
            if (c.numSampleRates < 4) c.sampleRates[c.numSampleRates++] = rate;
        }
        numCapabilities++;
    }

    // Affordances
    JsonArray affs = doc["affs"].as<JsonArray>();
    numAffordances = 0;
    for (const char* aff : affs) {
        if (numAffordances >= WB_DESC_MAX_AFFORDANCES) break;
        strlcpy(affordances[numAffordances], aff, 24);
        numAffordances++;
    }

    // Power
    JsonObject pwr = doc["pwr"].as<JsonObject>();
    power.voltage = pwr["v"] | 3.3f;
    power.currentTypical = pwr["i"] | 0.0f;
    power.currentPeak = pwr["ip"] | 0.0f;

    // Physical
    JsonObject phy = doc["phy"].as<JsonObject>();
    physical.weight = phy["w"] | 0.0f;
    JsonArray dim = phy["dim"].as<JsonArray>();
    for (int i = 0; i < 3 && i < (int)dim.size(); i++) {
        physical.dimensions[i] = dim[i] | 0.0f;
    }
    JsonArray plc = phy["plc"].as<JsonArray>();
    physical.numPlacements = 0;
    for (const char* p : plc) {
        if (physical.numPlacements >= WB_DESC_MAX_PLACEMENTS) break;
        strlcpy(physical.placements[physical.numPlacements], p, 16);
        physical.numPlacements++;
    }

    return true;
}

void WearBlocksDescriptor::saveToFlash(const char* nsName) {
    uint8_t buf[WB_DESC_MAX_SERIALIZED];
    uint16_t len = serialize(buf, sizeof(buf));

    Preferences prefs;
    prefs.begin(nsName, false);
    prefs.putBytes("desc", buf, len);
    prefs.putUShort("desc_len", len);
    prefs.end();

    Serial.printf("[WB-DESC] Saved to flash: %d bytes\n", len);
}

bool WearBlocksDescriptor::loadFromFlash(const char* nsName) {
    Preferences prefs;
    prefs.begin(nsName, true);
    uint16_t len = prefs.getUShort("desc_len", 0);
    if (len == 0 || len > WB_DESC_MAX_SERIALIZED) {
        prefs.end();
        return false;
    }

    uint8_t buf[WB_DESC_MAX_SERIALIZED];
    prefs.getBytes("desc", buf, len);
    prefs.end();

    return deserialize(buf, len);
}

String WearBlocksDescriptor::toJSON() const {
    uint8_t buf[WB_DESC_MAX_SERIALIZED];
    uint16_t len = serialize(buf, sizeof(buf));
    buf[len] = '\0';
    return String((char*)buf);
}

String WearBlocksDescriptor::toLLMPrompt() const {
    String s;
    s += "Module: " + String(name) + " (" + String(moduleId) + ")\n";
    s += "Category: " + String(category) + "\n";
    s += "Color: " + String(color) + "\n";
    s += "Version: " + String(version) + "\n";

    s += "Capabilities:\n";
    for (uint8_t i = 0; i < numCapabilities; i++) {
        const WBCapability& c = capabilities[i];
        s += "  - " + String(c.type) + ": " + String(c.modality);
        if (c.axes > 1) s += " (" + String(c.axes) + "-axis)";
        s += ", range [" + String(c.rangeMin, 1) + ", " + String(c.rangeMax, 1) + "]";
        if (c.resolution > 0) s += ", resolution " + String(c.resolution, 4);
        s += ", data type: " + String(c.dataType);
        s += ", rates: ";
        for (uint8_t j = 0; j < c.numSampleRates; j++) {
            if (j > 0) s += "/";
            s += String(c.sampleRates[j]) + "Hz";
        }
        s += "\n";
    }

    s += "Affordances: ";
    for (uint8_t i = 0; i < numAffordances; i++) {
        if (i > 0) s += ", ";
        s += String(affordances[i]);
    }
    s += "\n";

    s += "Power: " + String(power.voltage, 1) + "V, typical "
         + String(power.currentTypical, 1) + "mA, peak "
         + String(power.currentPeak, 1) + "mA\n";

    s += "Suitable body placements: ";
    for (uint8_t i = 0; i < physical.numPlacements; i++) {
        if (i > 0) s += ", ";
        s += String(physical.placements[i]);
    }
    s += "\n";

    return s;
}
