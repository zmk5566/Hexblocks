#include "ModuleRegistry.h"
#include <ArduinoJson.h>

static const char* faceLabelSafe(const char (*labels)[24], uint8_t face) {
    if (face >= 1 && face <= WB_NUM_FACES) return labels[face - 1];
    return "unassigned";
}

ModuleRegistry::ModuleRegistry() {
    memset(_modules, 0, sizeof(_modules));
    const char* defaultLabels[] = {
        "chest", "r_upper_arm", "l_wrist", "r_wrist", "l_ankle", "r_ankle"
    };
    for (int i = 0; i < WB_NUM_FACES; i++) {
        strlcpy(_faceLabels[i], defaultLabels[i], sizeof(_faceLabels[i]));
    }
}

uint8_t ModuleRegistry::findByUid(uint32_t uid) const {
    for (uint8_t i = 1; i < WB_MAX_MODULES; i++) {
        if (_modules[i].state != MODULE_EMPTY && _modules[i].uid == uid) {
            return i;
        }
    }
    return 0xFF;
}

uint8_t ModuleRegistry::findChildSlot(uint8_t parentSlot, uint8_t parentFace) const {
    for (uint8_t i = 1; i < WB_MAX_MODULES; i++) {
        if (_modules[i].state == MODULE_EMPTY) continue;
        if (_modules[i].parentSlot == parentSlot &&
            _modules[i].parentFace == parentFace) {
            return i;
        }
    }
    return 0xFF;
}

const RegisteredModule* ModuleRegistry::getModule(uint8_t slot) const {
    if (slot < WB_MAX_MODULES && _modules[slot].state != MODULE_EMPTY) {
        return &_modules[slot];
    }
    return nullptr;
}

uint8_t ModuleRegistry::getModuleCount() const {
    uint8_t count = 0;
    for (uint8_t i = 0; i < WB_MAX_MODULES; i++) {
        if (_modules[i].state == MODULE_REGISTERED) count++;
    }
    return count;
}

uint8_t ModuleRegistry::nextFreeSlot() const {
    for (uint8_t i = 1; i < WB_MAX_MODULES; i++) {
        if (_modules[i].state == MODULE_EMPTY) return i;
    }
    return 0xFF;
}

uint8_t ModuleRegistry::evictOldestDetached(OnRemovedCb onRemoved) {
    uint8_t oldest = 0xFF;
    uint32_t oldestAt = 0;
    for (uint8_t i = 1; i < WB_MAX_MODULES; i++) {
        if (_modules[i].state != MODULE_DETACHED) continue;
        if (oldest == 0xFF || _modules[i].detachedAtMs < oldestAt) {
            oldest = i;
            oldestAt = _modules[i].detachedAtMs;
        }
    }
    if (oldest != 0xFF) {
        Serial.printf("[REG] evict oldest DETACHED slot=%d uid=%08lX\n",
                      oldest, (unsigned long)_modules[oldest].uid);
        // Cascade through removeSubtree so DETACHED descendants of the
        // evictee don't get orphaned by the wipe. onRemoved fires for
        // each affected UID, leaf-first.
        removeSubtree(oldest, onRemoved);
    }
    return oldest;
}

void ModuleRegistry::addPending(uint32_t uid, uint8_t slot, uint16_t fwHash,
                                uint8_t parentSlot, uint8_t parentFace) {
    if (slot >= WB_MAX_MODULES || slot == 0) return;
    RegisteredModule& m = _modules[slot];
    memset(&m, 0, sizeof(m));
    m.state = MODULE_PENDING;
    m.slot = slot;
    m.uid = uid;
    m.fwHash = fwHash;
    m.parentSlot = parentSlot;
    m.parentFace = parentFace;
    m.hasDescriptor = false;
    m.lastSeenMs = millis();
    m.pendingRetries = 0;
    Serial.printf("[REG] pending: slot=%d uid=%08lX fwHash=%04X parent=%s face=%d\n",
                  slot, (unsigned long)uid, fwHash,
                  parentSlot == WB_PARENT_HUB ? "HUB" : "MOD",
                  parentFace);
}

void ModuleRegistry::markDescriptorPending(uint8_t slot, uint16_t fwHash) {
    if (slot >= WB_MAX_MODULES || slot == 0) return;
    RegisteredModule& m = _modules[slot];
    if (m.state == MODULE_EMPTY) return;
    m.fwHash = fwHash;
    m.hasDescriptor = false;
    // Don't downgrade REGISTERED -> PENDING. The old behavior caused
    // getModuleCount() to drop and the frontend to flicker the module
    // off and back on during an in-place descriptor refresh. The slot
    // stays REGISTERED until registerDescriptor() overwrites it.
    m.lastSeenMs = millis();
    m.pendingRetries = 0;
    Serial.printf("[REG] descriptor pending: slot=%d uid=%08lX fwHash=%04X\n",
                  slot, (unsigned long)m.uid, fwHash);
}

bool ModuleRegistry::registerDescriptor(uint8_t slot, const WearBlocksDescriptor& desc) {
    if (slot >= WB_MAX_MODULES) return false;
    RegisteredModule& m = _modules[slot];
    if (m.state == MODULE_EMPTY) return false;
    m.descriptor = desc;
    m.hasDescriptor = true;
    if (m.state == MODULE_PENDING) m.state = MODULE_REGISTERED;
    m.lastSeenMs = millis();
    Serial.printf("[REG] descriptor: slot=%d uid=%08lX module=%s ver=%s fwHash=%04X name='%s'\n",
                  slot, (unsigned long)m.uid, desc.moduleId, desc.version,
                  m.fwHash, desc.name);
    return true;
}

bool ModuleRegistry::rebind(uint8_t slot, uint8_t newParentSlot, uint8_t newParentFace) {
    if (slot >= WB_MAX_MODULES || _modules[slot].state == MODULE_EMPTY) return false;
    RegisteredModule& m = _modules[slot];
    bool changed = (m.parentSlot != newParentSlot) || (m.parentFace != newParentFace);
    m.parentSlot = newParentSlot;
    m.parentFace = newParentFace;
    m.lastSeenMs = millis();
    if (m.state == MODULE_DETACHED) m.state = MODULE_REGISTERED;  // caller must have descriptor
    return changed;
}

void ModuleRegistry::markDetached(uint8_t slot, uint32_t now) {
    if (slot >= WB_MAX_MODULES) return;
    RegisteredModule& m = _modules[slot];
    if (m.state == MODULE_EMPTY) return;
    m.state = MODULE_DETACHED;
    m.detachedAtMs = now;
    Serial.printf("[REG] detached: slot=%d uid=%08lX (TTL starting)\n",
                  slot, (unsigned long)m.uid);
}

void ModuleRegistry::markReattached(uint8_t slot, uint32_t now) {
    if (slot >= WB_MAX_MODULES) return;
    RegisteredModule& m = _modules[slot];
    if (m.state == MODULE_DETACHED) {
        m.state = m.hasDescriptor ? MODULE_REGISTERED : MODULE_PENDING;
    }
    m.lastSeenMs = now;
}

void ModuleRegistry::removeModule(uint8_t slot) {
    if (slot >= WB_MAX_MODULES) return;
    Serial.printf("[REG] remove: slot=%d uid=%08lX\n",
                  slot, (unsigned long)_modules[slot].uid);
    memset(&_modules[slot], 0, sizeof(_modules[slot]));
}

// Leaf-first subtree walk. Repeatedly scan the array; on each pass, act
// on every node in the subtree whose own children have already been
// processed (or has none). With WB_MAX_MODULES=12 this is trivially
// O(N²) and has no recursion / heap cost. shouldVisit / act are inlined
// by the two callers below to avoid std::function or templates in
// Arduino-land.
//
// "in subtree" is recomputed each pass via a parent-walk up to rootSlot;
// we don't cache because mutations during the walk (state flips, slot
// wipes) would invalidate any cache anyway, and 12 nodes × 12 walks × 12
// hops is still trivial.

static bool _isAncestorOrSelf(const RegisteredModule* mods, uint8_t slot,
                              uint8_t rootSlot) {
    // Walk from `slot` up via parentSlot chain, stop at HUB or self.
    // Bounded by WB_MAX_MODULES hops to defend against pathological cycles.
    uint8_t cur = slot;
    for (uint8_t hops = 0; hops < WB_MAX_MODULES; hops++) {
        if (cur == rootSlot) return true;
        if (cur == WB_PARENT_HUB) return false;
        if (cur >= WB_MAX_MODULES) return false;
        if (mods[cur].state == MODULE_EMPTY) return false;
        cur = mods[cur].parentSlot;
    }
    return false;
}

void ModuleRegistry::markSubtreeDetached(uint8_t rootSlot, uint32_t now,
                                         OnDetachedCb onDetached) {
    if (rootSlot >= WB_MAX_MODULES || _modules[rootSlot].state == MODULE_EMPTY) return;

    uint8_t affected = 0;
    // Each pass detaches every "ready" node — one whose own children
    // (within the subtree) are all already DETACHED or EMPTY. Loop until
    // a full pass changes nothing.
    for (uint8_t pass = 0; pass < WB_MAX_MODULES; pass++) {
        bool progress = false;
        for (uint8_t i = 1; i < WB_MAX_MODULES; i++) {
            RegisteredModule& m = _modules[i];
            if (m.state == MODULE_EMPTY || m.state == MODULE_DETACHED) continue;
            if (!_isAncestorOrSelf(_modules, i, rootSlot)) continue;

            // Only detach if every child of i (in registry) is already
            // DETACHED or EMPTY. This enforces leaf-first ordering.
            bool hasLiveChild = false;
            for (uint8_t j = 1; j < WB_MAX_MODULES; j++) {
                if (j == i) continue;
                const RegisteredModule& c = _modules[j];
                if (c.state == MODULE_EMPTY || c.state == MODULE_DETACHED) continue;
                if (c.parentSlot == i) { hasLiveChild = true; break; }
            }
            if (hasLiveChild) continue;

            uint32_t uid = m.uid;
            m.state = MODULE_DETACHED;
            m.detachedAtMs = now;
            Serial.printf("[REG] subtree detach: slot=%d uid=%08lX\n",
                          i, (unsigned long)uid);
            if (onDetached) onDetached(uid);
            affected++;
            progress = true;
        }
        if (!progress) break;
    }
    if (affected > 1) {
        Serial.printf("[REG] subtree detach root=%d affected=%d\n", rootSlot, affected);
    }
}

void ModuleRegistry::removeSubtree(uint8_t rootSlot, OnRemovedCb onRemoved) {
    if (rootSlot >= WB_MAX_MODULES || _modules[rootSlot].state == MODULE_EMPTY) return;

    uint8_t affected = 0;
    for (uint8_t pass = 0; pass < WB_MAX_MODULES; pass++) {
        bool progress = false;
        for (uint8_t i = 1; i < WB_MAX_MODULES; i++) {
            RegisteredModule& m = _modules[i];
            if (m.state == MODULE_EMPTY) continue;
            if (!_isAncestorOrSelf(_modules, i, rootSlot)) continue;

            // Only remove leaves (no remaining non-EMPTY child in registry).
            bool hasChild = false;
            for (uint8_t j = 1; j < WB_MAX_MODULES; j++) {
                if (j == i) continue;
                const RegisteredModule& c = _modules[j];
                if (c.state == MODULE_EMPTY) continue;
                if (c.parentSlot == i) { hasChild = true; break; }
            }
            if (hasChild) continue;

            uint32_t uid = m.uid;
            Serial.printf("[REG] subtree remove: slot=%d uid=%08lX\n",
                          i, (unsigned long)uid);
            memset(&m, 0, sizeof(m));
            if (onRemoved) onRemoved(uid);
            affected++;
            progress = true;
        }
        if (!progress) break;
    }
    if (affected > 1) {
        Serial.printf("[REG] subtree remove root=%d affected=%d\n", rootSlot, affected);
    }
}

bool ModuleRegistry::canBindToFace(uint8_t parentSlot, uint8_t parentFace,
                                   uint32_t exceptUid) const {
    uint8_t occ = findChildSlot(parentSlot, parentFace);
    if (occ == 0xFF) return true;
    const RegisteredModule& m = _modules[occ];
    if (m.uid == exceptUid) return true;
    // DETACHED would be cleared by ensureFaceFree, so the bind is feasible.
    if (m.state == MODULE_DETACHED) return true;
    return false;
}

bool ModuleRegistry::ensureFaceFree(uint8_t parentSlot, uint8_t parentFace,
                                    uint32_t exceptUid, OnRemovedCb onRemoved) {
    uint8_t occ = findChildSlot(parentSlot, parentFace);
    if (occ == 0xFF) return true;

    const RegisteredModule& m = _modules[occ];
    if (m.uid == exceptUid) return true;     // re-binding to same UID, no-op

    if (m.state == MODULE_DETACHED) {
        // Old occupant gave up its slot when it physically departed; the
        // 8s TTL was just for fast reseat with the *same* UID. A different
        // UID arriving means the previous module is gone for good — emit
        // its $U now so the frontend doesn't keep a ghost around for the
        // remainder of the TTL.
        removeSubtree(occ, onRemoved);
        return true;
    }

    // REGISTERED or PENDING — face is genuinely held. Caller must refuse.
    Serial.printf("[REG] ensureFaceFree: face busy parent=%s F%d held by uid=%08lX state=%d\n",
                  parentSlot == WB_PARENT_HUB ? "HUB" : "MOD",
                  parentFace, (unsigned long)m.uid, m.state);
    return false;
}

uint8_t ModuleRegistry::bumpPendingRetries(uint8_t slot) {
    if (slot >= WB_MAX_MODULES) return 0xFF;
    RegisteredModule& m = _modules[slot];
    if (m.state != MODULE_PENDING) return 0;
    if (m.pendingRetries < 0xFF) m.pendingRetries++;
    return m.pendingRetries;
}

uint8_t ModuleRegistry::reapDetached(uint32_t now, uint32_t ttlMs, OnRemovedCb onRemoved) {
    uint8_t reaped = 0;
    // Each TTL hit goes through removeSubtree so DETACHED descendants of
    // an expired root are reaped together. The outer loop restarts after
    // each cascade because removeSubtree mutates the array under us.
    bool changed = true;
    while (changed) {
        changed = false;
        for (uint8_t i = 1; i < WB_MAX_MODULES; i++) {
            RegisteredModule& m = _modules[i];
            if (m.state != MODULE_DETACHED) continue;
            if (now - m.detachedAtMs < ttlMs) continue;
            Serial.printf("[REG] reap: slot=%d uid=%08lX (TTL expired)\n",
                          i, (unsigned long)m.uid);
            removeSubtree(i, onRemoved);
            reaped++;
            changed = true;
            break;  // restart scan, indices may have shifted semantically
        }
    }
    return reaped;
}

void ModuleRegistry::setFaceLabel(uint8_t face, const char* label) {
    if (face >= 1 && face <= WB_NUM_FACES) {
        strlcpy(_faceLabels[face - 1], label, sizeof(_faceLabels[0]));
    }
}

const char* ModuleRegistry::getFaceLabel(uint8_t face) const {
    if (face >= 1 && face <= WB_NUM_FACES) return _faceLabels[face - 1];
    return "unknown";
}

String ModuleRegistry::toJSON() const {
    JsonDocument doc;
    JsonArray modules = doc["modules"].to<JsonArray>();

    for (uint8_t i = 1; i < WB_MAX_MODULES; i++) {
        const RegisteredModule& m = _modules[i];
        if (m.state != MODULE_REGISTERED) continue;

        JsonObject jm = modules.add<JsonObject>();
        char uidHex[9];
        snprintf(uidHex, sizeof(uidHex), "%08lX", (unsigned long)m.uid);
        jm["uid"] = uidHex;
        jm["id"] = m.descriptor.moduleId;
        jm["name"] = m.descriptor.name;
        jm["category"] = m.descriptor.category;
        jm["color"] = m.descriptor.color;
        if (m.parentSlot == WB_PARENT_HUB) {
            jm["parent"] = "HUB";
        } else {
            const RegisteredModule& p = _modules[m.parentSlot];
            char puid[9];
            snprintf(puid, sizeof(puid), "%08lX", (unsigned long)p.uid);
            jm["parent"] = puid;
        }
        jm["parentFace"] = m.parentFace;
        if (m.parentSlot == WB_PARENT_HUB) {
            jm["location"] = faceLabelSafe(_faceLabels, m.parentFace);
        }

        JsonArray caps = jm["capabilities"].to<JsonArray>();
        for (uint8_t j = 0; j < m.descriptor.numCapabilities; j++) {
            JsonObject cap = caps.add<JsonObject>();
            cap["type"] = m.descriptor.capabilities[j].type;
            cap["modality"] = m.descriptor.capabilities[j].modality;
        }

        JsonArray affs = jm["affordances"].to<JsonArray>();
        for (uint8_t j = 0; j < m.descriptor.numAffordances; j++) {
            affs.add(m.descriptor.affordances[j]);
        }
    }

    String result;
    serializeJson(doc, result);
    return result;
}
