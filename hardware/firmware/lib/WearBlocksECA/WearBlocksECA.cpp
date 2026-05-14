#include "WearBlocksECA.h"
#include <math.h>
#include <Preferences.h>

// NVS namespace + key for the persisted bytecode blob. Bumping the
// version suffix is the safe way to invalidate stored programs that
// would no longer parse under a new bytecode revision.
static constexpr const char* kNvsNamespace = "wb-eca";
static constexpr const char* kNvsKey       = "prog_v3";

static bool wbEcaIsTransientChannel(uint8_t channelId) {
    switch (channelId) {
        case WB_CH_SHAKE:
        case WB_CH_STEP:
        case WB_CH_FREEFALL:
        case WB_CH_HR_HIGH:
        case WB_CH_HR_SPIKE:
            return true;
        default:
            return false;
    }
}

// ─────────────────────────────────────────────────────
//  Constructor & Init
// ─────────────────────────────────────────────────────

WearBlocksECA::WearBlocksECA()
    : _uidToSlot(nullptr),
      _numVCs(0), _numRules(0), _running(false), _hasProgram(false),
      _rawLen(0), _proto(nullptr) {
    memset(_cache, 0, sizeof(_cache));
    memset(_prevCache, 0, sizeof(_prevCache));
    memset(_eventFresh, 0, sizeof(_eventFresh));
    memset(_vcVal, 0, sizeof(_vcVal));
    memset(_vars, 0, sizeof(_vars));
    memset(_reassemBuf, 0, sizeof(_reassemBuf));
    memset(_reassemLen, 0, sizeof(_reassemLen));
    memset(_holdStart, 0, sizeof(_holdStart));
    memset(_lastTrigger, 0, sizeof(_lastTrigger));
    memset(_condActive, 0, sizeof(_condActive));
    memset(_lastTriggerValid, 0, sizeof(_lastTriggerValid));
    memset(_ruleLatched, 0, sizeof(_ruleLatched));
    memset(_rawProgram, 0, sizeof(_rawProgram));
}

void WearBlocksECA::begin(WearBlocksProtocol& proto) {
    _proto = &proto;
}

// ─────────────────────────────────────────────────────
//  Sensor Cache Updates
// ─────────────────────────────────────────────────────

void WearBlocksECA::updateSensor(uint8_t slot, uint8_t sensorType,
                                  const uint8_t* payload, uint8_t payloadLen) {
    if (slot == 0 || slot >= WB_ECA_MAX_SLOTS) return;

    auto storeFloat = [&](uint8_t ch, const uint8_t* src) {
        float v; memcpy(&v, src, 4);
        _prevCache[slot][ch] = _cache[slot][ch];
        _cache[slot][ch] = v;
        if (wbEcaIsTransientChannel(ch)) {
            _eventFresh[slot][ch] = (v >= 0.5f);
        }
    };

    // New per-channel protocol: sensorType IS the channelId (WBChannelID enum)
    // Each CAN frame carries exactly 1 float for 1 channel.
    // Legacy multi-float types (0x01=IMU_RAW, 0x02=HR_RAW, 0x03=ENV_RAW) are
    // handled for backward compatibility with old module firmware.
    switch (sensorType) {
        case WB_SENS_IMU_RAW: {
            // Legacy: 6 floats in multiple frames — accumulate
            uint8_t remaining = 24 - _reassemLen[slot];
            uint8_t copy = min((uint8_t)remaining, payloadLen);
            memcpy(&_reassemBuf[slot][_reassemLen[slot]], payload, copy);
            _reassemLen[slot] += copy;
            if (_reassemLen[slot] >= 24) {
                storeFloat(WB_CH_AX, &_reassemBuf[slot][0]);
                storeFloat(WB_CH_AY, &_reassemBuf[slot][4]);
                storeFloat(WB_CH_AZ, &_reassemBuf[slot][8]);
                storeFloat(WB_CH_GX, &_reassemBuf[slot][12]);
                storeFloat(WB_CH_GY, &_reassemBuf[slot][16]);
                storeFloat(WB_CH_GZ, &_reassemBuf[slot][20]);
                _reassemLen[slot] = 0;
            }
            break;
        }
        case WB_SENS_HR_RAW:
            if (payloadLen >= 8) {
                storeFloat(WB_CH_BPM,  &payload[0]);
                storeFloat(WB_CH_SPO2, &payload[4]);
            }
            break;
        case WB_SENS_ENV_RAW:
            if (payloadLen >= 8) {
                storeFloat(WB_CH_CELSIUS,  &payload[0]);
                storeFloat(WB_CH_HUMIDITY, &payload[4]);
            }
            break;
        default:
            // Per-channel protocol: sensorType = channelId, payload = 1 float
            if (sensorType < WB_CH_MAX && payloadLen >= 4) {
                storeFloat(sensorType, payload);
            }
            break;
    }
}

float WearBlocksECA::getSensorValue(uint8_t slot, uint8_t channelId) const {
    if (slot == 0 || slot >= WB_ECA_MAX_SLOTS || channelId >= WB_CH_MAX) return 0.0f;
    return _cache[slot][channelId];
}

// ─────────────────────────────────────────────────────
//  Program Loading
// ─────────────────────────────────────────────────────

bool WearBlocksECA::loadProgram(const uint8_t* data, uint16_t len) {
    if (len < 4) { Serial.println("[ECA] Program too short"); return false; }
    if (data[0] != WB_ECA_MAGIC_0 || data[1] != WB_ECA_MAGIC_1) {
        Serial.println("[ECA] Bad magic"); return false;
    }
    if (data[2] != WB_ECA_VERSION) {
        Serial.printf("[ECA] Bad version: got 0x%02X expected 0x%02X\n",
                      data[2], WB_ECA_VERSION);
        return false;
    }
    // Verify checksum (sum of all bytes except last = last byte)
    uint8_t chk = 0;
    for (uint16_t i = 0; i < len - 1; i++) chk += data[i];
    if (chk != data[len - 1]) {
        Serial.printf("[ECA] Checksum fail: got 0x%02X expected 0x%02X\n", chk, data[len-1]);
        return false;
    }

    uint16_t idx = 2;  // skip magic
    /* version */ idx++;

    // Variables initial values
    memset(_vars, 0, sizeof(_vars));
    uint8_t numVars = data[idx++];
    for (uint8_t i = 0; i < numVars && idx + 4 <= len - 1; i++) {
        if (i < WB_ECA_MAX_VARS) memcpy(&_vars[i], &data[idx], 4);
        idx += 4;  // always advance past all declared vars
    }

    // Virtual channels (22 bytes each)
    if (idx >= len - 1) { Serial.println("[ECA] Truncated before VCs"); return false; }
    _numVCs = data[idx++];
    if (_numVCs > WB_ECA_MAX_VCS) { Serial.println("[ECA] Too many VCs"); return false; }
    for (uint8_t i = 0; i < _numVCs && idx + 22 <= len - 1; i++) {
        memcpy(&_vcs[i], &data[idx], 22); idx += 22;
    }

    // Rules
    if (idx >= len - 1) { Serial.println("[ECA] Truncated before rules"); return false; }
    _numRules = data[idx++];
    if (_numRules > WB_ECA_MAX_RULES) { Serial.println("[ECA] Too many rules"); return false; }
    for (uint8_t r = 0; r < _numRules; r++) {
        if (idx + 3 > len - 1) break;
        _rules[r].num_cond = data[idx++];
        _rules[r].logic    = data[idx++];
        _rules[r].num_act  = data[idx++];
        uint8_t nc = min(_rules[r].num_cond, (uint8_t)4);
        uint8_t na = min(_rules[r].num_act,  (uint8_t)4);
        for (uint8_t c = 0; c < nc && idx + 15 <= len - 1; c++) {
            memcpy(&_rules[r].conditions[c], &data[idx], 15); idx += 15;
        }
        for (uint8_t a = 0; a < na; a++) {
            // Action header is now 6 bytes (target u32 + cmd u8 + numParams u8).
            if (idx + 6 > len - 1) break;
            WBAction& act = _rules[r].actions[a];
            memcpy(&act.target, &data[idx], 4); idx += 4;
            act.cmd       = data[idx++];
            uint8_t np    = data[idx++];
            act.numParams = min(np, (uint8_t)WB_ACTION_MAX_PARAMS);
            // Read params we have room for; skip the rest (each 10 bytes).
            for (uint8_t p = 0; p < np; p++) {
                if (idx + 10 > len - 1) break;
                if (p < WB_ACTION_MAX_PARAMS) {
                    memcpy(&act.params[p], &data[idx], 10);
                }
                idx += 10;
            }
        }
    }

    // Reset timing state
    memset(_holdStart, 0, sizeof(_holdStart));
    memset(_lastTrigger, 0, sizeof(_lastTrigger));
    memset(_condActive, 0, sizeof(_condActive));
    memset(_lastTriggerValid, 0, sizeof(_lastTriggerValid));
    memset(_ruleLatched, 0, sizeof(_ruleLatched));
    memset(_eventFresh, 0, sizeof(_eventFresh));
    memset(_vcVal, 0, sizeof(_vcVal));

    _hasProgram = true;
    // Stash raw bytecode for later saveToNVS(). The caller-supplied
    // `data` buffer typically lives in the wire-protocol decoder and
    // becomes invalid as soon as we return, so we must own a copy.
    if (len <= WB_ECA_PROGRAM_MAX) {
        memcpy(_rawProgram, data, len);
        _rawLen = len;
    } else {
        // Parsed OK but too big for NVS — keep runtime, drop persistence.
        _rawLen = 0;
        Serial.printf("[ECA] Program %u B exceeds NVS cap %u — not persistable\n",
                      (unsigned)len, (unsigned)WB_ECA_PROGRAM_MAX);
    }
    Serial.printf("[ECA] Loaded: %d VCs, %d rules, %d vars\n", _numVCs, _numRules, numVars);
    return true;
}

void WearBlocksECA::runProgram()  {
    if (_hasProgram) {
        memset(_ruleLatched, 0, sizeof(_ruleLatched));
        _running = true;
        Serial.println("[ECA] Running");
    }
}

void WearBlocksECA::stopProgram() {
    _running = false;
    memset(_ruleLatched, 0, sizeof(_ruleLatched));
    Serial.println("[ECA] Stopped");
}

void WearBlocksECA::clearProgram(){
    _running = false; _hasProgram = false; _numVCs = 0; _numRules = 0;
    _rawLen = 0;
    memset(_vars, 0, sizeof(_vars));
    memset(_ruleLatched, 0, sizeof(_ruleLatched));
    Serial.println("[ECA] Cleared");
}

// ─────────────────────────────────────────────────────
//  NVS Persistence
// ─────────────────────────────────────────────────────

bool WearBlocksECA::saveToNVS() {
    if (_rawLen == 0) {
        Serial.println("[ECA] saveToNVS: no program loaded");
        return false;
    }
    Preferences prefs;
    if (!prefs.begin(kNvsNamespace, /*readOnly=*/false)) {
        Serial.println("[ECA] saveToNVS: Preferences.begin failed");
        return false;
    }
    size_t written = prefs.putBytes(kNvsKey, _rawProgram, _rawLen);
    prefs.end();
    if (written != _rawLen) {
        Serial.printf("[ECA] saveToNVS: short write %u/%u\n",
                      (unsigned)written, (unsigned)_rawLen);
        return false;
    }
    Serial.printf("[ECA] saveToNVS: stored %u bytes\n", (unsigned)_rawLen);
    return true;
}

bool WearBlocksECA::loadFromNVS() {
    Preferences prefs;
    if (!prefs.begin(kNvsNamespace, /*readOnly=*/true)) {
        // Namespace not present yet — first boot, treat as no program.
        return false;
    }
    size_t storedLen = prefs.getBytesLength(kNvsKey);
    if (storedLen == 0 || storedLen > WB_ECA_PROGRAM_MAX) {
        prefs.end();
        return false;
    }
    uint8_t buf[WB_ECA_PROGRAM_MAX];
    size_t  got = prefs.getBytes(kNvsKey, buf, sizeof(buf));
    prefs.end();
    if (got != storedLen) {
        Serial.printf("[ECA] loadFromNVS: short read %u/%u\n",
                      (unsigned)got, (unsigned)storedLen);
        return false;
    }
    if (!loadProgram(buf, (uint16_t)storedLen)) {
        Serial.println("[ECA] loadFromNVS: stored bytecode failed to parse "
                       "(version mismatch?). Erasing.");
        eraseFromNVS();
        return false;
    }
    Serial.printf("[ECA] loadFromNVS: restored %u bytes\n", (unsigned)storedLen);
    return true;
}

bool WearBlocksECA::eraseFromNVS() {
    Preferences prefs;
    if (!prefs.begin(kNvsNamespace, /*readOnly=*/false)) return false;
    bool ok = prefs.remove(kNvsKey);
    prefs.end();
    if (ok) Serial.println("[ECA] eraseFromNVS: removed stored program");
    return ok;
}

bool WearBlocksECA::hasStoredProgram() const {
    Preferences prefs;
    if (!prefs.begin(kNvsNamespace, /*readOnly=*/true)) return false;
    size_t storedLen = prefs.getBytesLength(kNvsKey);
    prefs.end();
    return storedLen > 0;
}

// ─────────────────────────────────────────────────────
//  Value Resolution
// ─────────────────────────────────────────────────────

float WearBlocksECA::resolveRef(uint8_t ref_type, uint32_t id, uint8_t channel_id) {
    switch (ref_type) {
        case WB_REF_SLOT: {
            // id is the module UID (4 bytes). Translate to slot via the
            // host-supplied resolver, then read from the slot-keyed cache.
            // Unresolved UID ⇒ NaN (not 0) so rules referencing an absent
            // module are skipped instead of firing on a placeholder zero.
            uint8_t slot = _uidToSlot ? _uidToSlot(id) : 0;
            if (slot > 0 && slot < WB_ECA_MAX_SLOTS && channel_id < WB_CH_MAX) {
                if (wbEcaIsTransientChannel(channel_id) && !_eventFresh[slot][channel_id])
                    return 0.0f;
                return _cache[slot][channel_id];
            }
            return NAN;
        }
        case WB_REF_VC:
            // VC/VAR ids fit in low byte of the 4-byte id field.
            return ((id & 0xFF) < WB_ECA_MAX_VCS) ? _vcVal[id & 0xFF] : 0.0f;
        case WB_REF_VAR:
            return ((id & 0xFF) < WB_ECA_MAX_VARS) ? _vars[id & 0xFF] : 0.0f;
        default: return 0.0f;
    }
}

float WearBlocksECA::computeVC(uint8_t vc_id) {
    if (vc_id >= _numVCs) return 0.0f;
    const WBVirtualChannel& vc = _vcs[vc_id];
    float a = resolveRef(vc.a_type, vc.a_id, vc.a_ch);
    float b = (vc.b_type == WB_REF_CONST) ? vc.b_const
                                           : resolveRef(vc.b_type, vc.b_id, vc.b_ch);
    // Unavailable operand ⇒ VC is unavailable. Some ops (MIN/MAX/MAP/CLAMP)
    // would otherwise mask NaN with a finite value; short-circuit instead.
    if (isnanf(a) || isnanf(b)) return NAN;
    switch ((WBVCOp)vc.op) {
        case VC_ADD:   return a + b;
        case VC_SUB:   return a - b;
        case VC_MUL:   return a * b;
        case VC_DIV:   return (b != 0.0f) ? a / b : 0.0f;
        case VC_ABS:   return fabsf(a);
        case VC_NEG:   return -a;
        case VC_MIN:   return fminf(a, b);
        case VC_MAX:   return fmaxf(a, b);
        case VC_MAP: {
            // Normalize a from [b_const, c_const] → [0, 1]
            float range = vc.c_const - vc.b_const;
            if (fabsf(range) < 1e-6f) return 0.0f;
            float v = (a - vc.b_const) / range;
            return fmaxf(0.0f, fminf(1.0f, v));
        }
        case VC_CLAMP:
            return fmaxf(vc.b_const, fminf(vc.c_const, a));
        case VC_DIFF: {
            // a(t) - a(t-1); we read prev from _prevCache if a_type=SLOT
            uint8_t aSlot = (vc.a_type == WB_REF_SLOT && _uidToSlot)
                            ? _uidToSlot(vc.a_id) : 0;
            float prev = (aSlot > 0 && aSlot < WB_ECA_MAX_SLOTS
                          && vc.a_ch < WB_CH_MAX)
                         ? _prevCache[aSlot][vc.a_ch] : 0.0f;
            return a - prev;
        }
        default: return 0.0f;
    }
}

// ─────────────────────────────────────────────────────
//  Condition Evaluation
// ─────────────────────────────────────────────────────

bool WearBlocksECA::evaluateConditions(const WBRule& rule, uint8_t rule_idx, uint32_t now) {
    bool result = (rule.logic == LOGIC_AND) ? true : false;

    for (uint8_t i = 0; i < rule.num_cond && i < 4; i++) {
        const WBCondition& cond = rule.conditions[i];
        float val = resolveRef(cond.ref_type, cond.id, cond.channel_id);
        // Unavailable ref ⇒ rule is undefined this tick. Reset hold state
        // so the timer restarts cleanly when the module reappears.
        if (isnanf(val)) {
            _condActive[rule_idx] = false;
            return false;
        }
        bool met = false;
        switch ((WBCondOp)cond.op) {
            case COND_GT:  met = val >  cond.threshold; break;
            case COND_LT:  met = val <  cond.threshold; break;
            case COND_GTE: met = val >= cond.threshold; break;
            case COND_LTE: met = val <= cond.threshold; break;
            case COND_EQ:  met = fabsf(val - cond.threshold) < 0.001f; break;
            case COND_NEQ: met = fabsf(val - cond.threshold) >= 0.001f; break;
        }
        if (rule.logic == LOGIC_AND) result = result && met;
        else                         result = result || met;
    }

    // hold_ms: condition must stay true for N ms before firing
    uint16_t hold = (rule.num_cond > 0) ? rule.conditions[0].hold_ms : 0;
    if (hold > 0) {
        if (result) {
            if (!_condActive[rule_idx]) {
                _holdStart[rule_idx] = now;
                _condActive[rule_idx] = true;
            }
            if ((now - _holdStart[rule_idx]) < hold) return false;
        } else {
            _condActive[rule_idx] = false;
            return false;
        }
    }

    return result;
}

bool WearBlocksECA::ruleNeedsContinuousUpdates(const WBRule& rule) const {
    for (uint8_t a = 0; a < rule.num_act && a < 4; a++) {
        const WBAction& act = rule.actions[a];
        for (uint8_t p = 0; p < act.numParams && p < WB_ACTION_MAX_PARAMS; p++) {
            if (act.params[p].type != WB_REF_CONST) return true;
        }
    }
    return false;
}

void WearBlocksECA::clearTransientEvents() {
    for (uint8_t slot = 1; slot < WB_ECA_MAX_SLOTS; slot++) {
        for (uint8_t ch = 0; ch < WB_CH_MAX; ch++) {
            if (wbEcaIsTransientChannel(ch)) {
                _eventFresh[slot][ch] = false;
                _cache[slot][ch] = 0.0f;
            }
        }
    }
}

// ─────────────────────────────────────────────────────
//  Action Execution
// ─────────────────────────────────────────────────────

void WearBlocksECA::executeAction(const WBAction& act) {
    if (!_proto) return;

    // Resolve all typed params to floats. Per-cmd handlers below decide
    // how to interpret each slot (color byte, ms, count, raw float, …).
    float vals[WB_ACTION_MAX_PARAMS] = {0};
    for (uint8_t i = 0; i < act.numParams && i < WB_ACTION_MAX_PARAMS; i++) {
        const WBActionParam& pp = act.params[i];
        if (pp.type == WB_REF_CONST) vals[i] = pp.value;
        else                         vals[i] = resolveRef(pp.type, pp.id, pp.ch);
    }

    // Unavailable param ⇒ action is meaningless (RGB byte / ms duration /
    // intensity would clamp to garbage). Skip rather than emit nonsense.
    for (uint8_t i = 0; i < act.numParams && i < WB_ACTION_MAX_PARAMS; i++) {
        if (isnanf(vals[i])) {
            Serial.printf("[ECA] ACT skip: param %u unavailable\n", i);
            return;
        }
    }

    auto clampByte = [](float v) -> uint8_t {
        if (v < 0)   return 0;
        if (v > 255) return 255;
        return (uint8_t)(v + 0.5f);
    };
    auto clampU16 = [](float v) -> uint16_t {
        if (v < 0)     return 0;
        if (v > 65535) return 65535;
        return (uint16_t)(v + 0.5f);
    };

    // Variable operations stay inside the engine (no CAN). For VAR_* the
    // target is the var_id, packed in the low byte of the 4-byte target.
    if (act.cmd >= ACT_VAR_SET && act.cmd <= ACT_VAR_TOGGLE) {
        uint8_t vid = (uint8_t)(act.target & 0xFF);
        if (vid >= WB_ECA_MAX_VARS) return;
        switch ((WBActCmd)act.cmd) {
            case ACT_VAR_RESET:  _vars[vid] = 0.0f; break;
            case ACT_VAR_TOGGLE: _vars[vid] = (_vars[vid] >= 0.5f) ? 0.0f : 1.0f; break;
            case ACT_VAR_INC:    _vars[vid] += vals[0]; break;
            case ACT_VAR_SET:    _vars[vid]  = vals[0]; break;
            default: break;
        }
        Serial.printf("[ECA] VAR[%d] = %.2f\n", vid, _vars[vid]);
        return;
    }

    // Actuator commands: target is a module UID. Resolve to slot before
    // emitting the CAN frame. If the UID isn't registered, skip silently.
    uint8_t targetSlot = _uidToSlot ? _uidToSlot(act.target) : 0;
    if (targetSlot == 0) {
        Serial.printf("[ECA] ACT skip: uid=%08lX not registered\n",
                      (unsigned long)act.target);
        return;
    }

    uint8_t buf[8];
    switch ((WBActCmd)act.cmd) {
        case ACT_LED_SOLID: {
            buf[0] = clampByte(vals[0]);  // R
            buf[1] = clampByte(vals[1]);  // G
            buf[2] = clampByte(vals[2]);  // B
            _proto->sendActuatorCommand(targetSlot, act.cmd, buf, 3);
            break;
        }
        case ACT_LED_OFF:
        case ACT_LED_STOP:
            _proto->sendActuatorCommand(targetSlot, act.cmd, nullptr, 0);
            break;

        case ACT_VIBRATE: {
            uint16_t dur = clampU16(vals[1]);
            buf[0] = clampByte(vals[0]);          // intensity
            buf[1] = (dur >> 8) & 0xFF;
            buf[2] = dur & 0xFF;
            _proto->sendActuatorCommand(targetSlot, act.cmd, buf, 3);
            break;
        }
        case ACT_VIBRATE_PULSE: {
            buf[0] = clampByte(vals[0]);  // intensity
            buf[1] = clampByte(vals[1]);  // on_10ms
            buf[2] = clampByte(vals[2]);  // off_10ms
            buf[3] = clampByte(vals[3]);  // count
            _proto->sendActuatorCommand(targetSlot, act.cmd, buf, 4);
            break;
        }
        case ACT_VIBRATE_RAMP: {
            uint16_t dur = clampU16(vals[2]);
            buf[0] = clampByte(vals[0]);  // from_pct
            buf[1] = clampByte(vals[1]);  // to_pct
            buf[2] = (dur >> 8) & 0xFF;
            buf[3] = dur & 0xFF;
            _proto->sendActuatorCommand(targetSlot, act.cmd, buf, 4);
            break;
        }
        case ACT_VIBRATE_STOP:
            _proto->sendActuatorCommand(targetSlot, act.cmd, nullptr, 0);
            break;

        case ACT_AUDIO_SET_TONE: {
            uint16_t freq = clampU16(vals[0]);
            buf[0] = freq & 0xFF;          // freq_lo (LE — module_amplifier reads p[0] | p[1]<<8)
            buf[1] = (freq >> 8) & 0xFF;   // freq_hi
            buf[2] = clampByte(vals[1]);   // amp 0..255
            _proto->sendActuatorCommand(targetSlot, act.cmd, buf, 3);
            break;
        }
        case ACT_AUDIO_STOP:
            _proto->sendActuatorCommand(targetSlot, act.cmd, nullptr, 0);
            break;

        // LED RAMP/BREATHE/BLINK/RAINBOW reserved — module_led v3 only
        // implements SOLID. Pass through resolved bytes for forward-compat.
        default: {
            uint8_t n = act.numParams;
            if (n > sizeof(buf)) n = sizeof(buf);
            for (uint8_t i = 0; i < n; i++) buf[i] = clampByte(vals[i]);
            _proto->sendActuatorCommand(targetSlot, act.cmd, buf, n);
            break;
        }
    }
    Serial.printf("[ECA] ACT slot=%d cmd=%d (uid=%08lX)\n",
                  targetSlot, act.cmd, (unsigned long)act.target);
}

// ─────────────────────────────────────────────────────
//  Main Tick (call each loop)
// ─────────────────────────────────────────────────────

void WearBlocksECA::tick() {
    if (!_running || !_hasProgram) {
        clearTransientEvents();
        return;
    }

    // Step 1: compute virtual channels in order (DAG evaluation)
    for (uint8_t i = 0; i < _numVCs; i++) {
        _vcVal[_vcs[i].vc_id] = computeVC(i);
    }

    // Step 2: evaluate each rule
    uint32_t now = millis();
    for (uint8_t r = 0; r < _numRules; r++) {
        if (!evaluateConditions(_rules[r], r, now)) {
            _ruleLatched[r] = false;
            continue;
        }

        // Check cooldown on rule level
        uint16_t cd = (_rules[r].num_cond > 0) ? _rules[r].conditions[0].cooldown_ms : 0;
        if (cd > 0 && _lastTriggerValid[r] && (now - _lastTrigger[r]) < cd) continue;

        bool continuous = ruleNeedsContinuousUpdates(_rules[r]);
        if (!continuous && _ruleLatched[r]) continue;

        _lastTrigger[r] = now;
        _lastTriggerValid[r] = true;
        _ruleLatched[r] = true;
        if (continuous) {
            _condActive[r] = false;  // let held dynamic rules refresh after cooldown
        }

        for (uint8_t a = 0; a < _rules[r].num_act && a < 4; a++) {
            executeAction(_rules[r].actions[a]);
        }
    }
    clearTransientEvents();
}

// ─────────────────────────────────────────────────────
//  Auto Topic Enable
// ─────────────────────────────────────────────────────

void WearBlocksECA::autoEnableTopics() {
    if (!_proto || !_hasProgram) return;

    // Deduplicate with bitmask per slot. Refs are uid-keyed in the bytecode;
    // we resolve via the host hook. Unknown UIDs (not currently registered)
    // are silently skipped — the topic will get enabled next program upload
    // after the module hellos.
    uint64_t enabled[WB_ECA_MAX_SLOTS] = {};

    auto enableIfNew = [&](uint32_t uid, uint8_t ch) {
        uint8_t slot = _uidToSlot ? _uidToSlot(uid) : 0;
        if (slot == 0 || slot >= WB_ECA_MAX_SLOTS || ch >= 64) return;
        uint64_t bit = 1ULL << ch;
        if (enabled[slot] & bit) return;
        enabled[slot] |= bit;
        _proto->sendTopicEnable(slot, ch);
    };

    for (uint8_t r = 0; r < _numRules; r++) {
        for (uint8_t c = 0; c < _rules[r].num_cond && c < 4; c++) {
            const WBCondition& cond = _rules[r].conditions[c];
            if (cond.ref_type == WB_REF_SLOT) enableIfNew(cond.id, cond.channel_id);
        }
        // v2: action params can also reference live slot channels
        // (e.g. LED R inlet bound to a knob). Enable those topics too.
        for (uint8_t a = 0; a < _rules[r].num_act && a < 4; a++) {
            const WBAction& act = _rules[r].actions[a];
            for (uint8_t p = 0; p < act.numParams && p < WB_ACTION_MAX_PARAMS; p++) {
                const WBActionParam& pp = act.params[p];
                if (pp.type == WB_REF_SLOT) enableIfNew(pp.id, pp.ch);
            }
        }
    }
    for (uint8_t i = 0; i < _numVCs; i++) {
        if (_vcs[i].a_type == WB_REF_SLOT) enableIfNew(_vcs[i].a_id, _vcs[i].a_ch);
        if (_vcs[i].b_type == WB_REF_SLOT) enableIfNew(_vcs[i].b_id, _vcs[i].b_ch);
    }
}

void WearBlocksECA::autoEnableTopicsForUid(uint32_t targetUid) {
    if (!_proto || !_hasProgram) return;
    if (!_uidToSlot) return;
    uint8_t targetSlot = _uidToSlot(targetUid);
    if (targetSlot == 0 || targetSlot >= WB_ECA_MAX_SLOTS) return;

    // Single-slot dedup bitmap. Walk the program and emit only refs whose
    // id equals targetUid. Mirrors the structure of autoEnableTopics() so
    // the two stay in sync if reference sites are added.
    uint64_t enabled = 0;

    auto enableIfNew = [&](uint32_t uid, uint8_t ch) {
        if (uid != targetUid || ch >= 64) return;
        uint64_t bit = 1ULL << ch;
        if (enabled & bit) return;
        enabled |= bit;
        _proto->sendTopicEnable(targetSlot, ch);
    };

    for (uint8_t r = 0; r < _numRules; r++) {
        for (uint8_t c = 0; c < _rules[r].num_cond && c < 4; c++) {
            const WBCondition& cond = _rules[r].conditions[c];
            if (cond.ref_type == WB_REF_SLOT) enableIfNew(cond.id, cond.channel_id);
        }
        for (uint8_t a = 0; a < _rules[r].num_act && a < 4; a++) {
            const WBAction& act = _rules[r].actions[a];
            for (uint8_t p = 0; p < act.numParams && p < WB_ACTION_MAX_PARAMS; p++) {
                const WBActionParam& pp = act.params[p];
                if (pp.type == WB_REF_SLOT) enableIfNew(pp.id, pp.ch);
            }
        }
    }
    for (uint8_t i = 0; i < _numVCs; i++) {
        if (_vcs[i].a_type == WB_REF_SLOT) enableIfNew(_vcs[i].a_id, _vcs[i].a_ch);
        if (_vcs[i].b_type == WB_REF_SLOT) enableIfNew(_vcs[i].b_id, _vcs[i].b_ch);
    }
}
