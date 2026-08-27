#include "WearBlocksECA.h"
#include <math.h>
#include <Preferences.h>

// NVS namespace + key for the persisted bytecode blob. Bumping the
// version suffix is the safe way to invalidate stored programs that
// would no longer parse under a new bytecode revision.
static constexpr const char* kNvsNamespace = "wb-eca";
static constexpr const char* kNvsKey       = "prog_v4";

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
      _actuatorDispatch(nullptr), _topicDispatch(nullptr),
      _nextOwnerToken(0),
      _numVCs(0), _numRules(0), _running(false), _hasProgram(false),
      _rawLen(0), _proto(nullptr) {
    memset(_cache, 0, sizeof(_cache));
    memset(_prevCache, 0, sizeof(_prevCache));
    memset(_eventFresh, 0, sizeof(_eventFresh));
    memset(_vcVal, 0, sizeof(_vcVal));
    memset(_vars, 0, sizeof(_vars));
    memset(_reassemBuf, 0, sizeof(_reassemBuf));
    memset(_reassemLen, 0, sizeof(_reassemLen));
    memset(_actionRuntime, 0, sizeof(_actionRuntime));
    memset(_outputOwners, 0, sizeof(_outputOwners));
    resetTimingState();
    memset(_rawProgram, 0, sizeof(_rawProgram));
}

void WearBlocksECA::begin(WearBlocksProtocol& proto) {
    _proto = &proto;
}

bool WearBlocksECA::dispatchActuator(uint8_t slot, uint32_t uid, uint8_t cmd,
                                     const uint8_t* params, uint8_t paramLen) {
    if (_actuatorDispatch) return _actuatorDispatch(slot, uid, cmd, params, paramLen);
    if (!_proto) return false;
    _proto->sendActuatorCommand(slot, cmd, params, paramLen);
    return true;
}

bool WearBlocksECA::dispatchTopic(uint8_t slot, uint32_t uid, uint8_t channelId,
                                  bool enable) {
    if (_topicDispatch) return _topicDispatch(slot, uid, channelId, enable);
    if (!_proto) return false;
    if (enable) _proto->sendTopicEnable(slot, channelId);
    else        _proto->sendTopicDisable(slot, channelId);
    return true;
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
    if (!data || len < 6) { Serial.println("[ECA] Program too short"); return false; }
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

    // A valid replacement program owns the outputs from this point forward.
    // Stop anything launched by the previous program before its rules vanish.
    safeAllOutputs();
    _running = false;
    _hasProgram = false;
    _rawLen = 0;

    uint16_t idx = 3;  // skip magic + version
    const uint16_t end = len - 1; // checksum byte is not part of the payload
    auto need = [&](uint16_t count) -> bool {
        if (idx > end || count > end - idx) {
            Serial.println("[ECA] Truncated program");
            return false;
        }
        return true;
    };

    // Variables initial values
    memset(_vars, 0, sizeof(_vars));
    if (!need(1)) return false;
    uint8_t numVars = data[idx++];
    if (!need((uint16_t)numVars * 4)) return false;
    for (uint8_t i = 0; i < numVars; i++) {
        if (i < WB_ECA_MAX_VARS) memcpy(&_vars[i], &data[idx], 4);
        idx += 4;
    }

    // Virtual channels (22 bytes each)
    if (!need(1)) return false;
    _numVCs = data[idx++];
    if (_numVCs > WB_ECA_MAX_VCS) { Serial.println("[ECA] Too many VCs"); return false; }
    if (!need((uint16_t)_numVCs * 22)) return false;
    for (uint8_t i = 0; i < _numVCs; i++) {
        memcpy(&_vcs[i], &data[idx], 22); idx += 22;
        if (_vcs[i].vc_id >= WB_ECA_MAX_VCS || _vcs[i].op > VC_DIFF ||
            _vcs[i].a_type > WB_REF_VAR || _vcs[i].b_type > WB_REF_VAR) {
            Serial.println("[ECA] Invalid virtual channel");
            return false;
        }
    }

    // Rules
    if (!need(1)) return false;
    _numRules = data[idx++];
    if (_numRules > WB_ECA_MAX_RULES) { Serial.println("[ECA] Too many rules"); return false; }
    for (uint8_t r = 0; r < _numRules; r++) {
        if (!need(11)) return false;
        _rules[r].num_cond = data[idx++];
        _rules[r].logic    = data[idx++];
        _rules[r].num_act  = data[idx++];
        memcpy(&_rules[r].hold_ms, &data[idx], 4); idx += 4;
        memcpy(&_rules[r].cooldown_ms, &data[idx], 4); idx += 4;
        if (_rules[r].num_cond > 4 || _rules[r].num_act > WB_ECA_MAX_ACTIONS ||
            _rules[r].logic > LOGIC_OR) {
            Serial.println("[ECA] Too many conditions/actions");
            return false;
        }
        if (!need((uint16_t)_rules[r].num_cond * 11)) return false;
        for (uint8_t c = 0; c < _rules[r].num_cond; c++) {
            memcpy(&_rules[r].conditions[c], &data[idx], 11); idx += 11;
            const WBCondition& cond = _rules[r].conditions[c];
            if (cond.ref_type > WB_REF_VAR || cond.op > COND_NEQ) {
                Serial.println("[ECA] Invalid condition");
                return false;
            }
        }
        if (_rules[r].hold_ms > 0) {
            for (uint8_t c = 0; c < _rules[r].num_cond; c++) {
                const WBCondition& cond = _rules[r].conditions[c];
                if (cond.ref_type == WB_REF_SLOT &&
                    wbEcaIsTransientChannel(cond.channel_id)) {
                    Serial.println("[ECA] hold_ms is invalid for transient events");
                    return false;
                }
            }
        }
        for (uint8_t a = 0; a < _rules[r].num_act; a++) {
            if (!need(17)) return false;
            WBAction& act = _rules[r].actions[a];
            memset(&act, 0, sizeof(act));
            memcpy(&act.target, &data[idx], 4); idx += 4;
            act.cmd       = data[idx++];
            act.mode      = data[idx++];
            uint8_t np    = data[idx++];
            memcpy(&act.delay_ms, &data[idx], 4); idx += 4;
            memcpy(&act.duration_ms, &data[idx], 4); idx += 4;
            act.update_interval_ms = ((uint16_t)data[idx] << 8) | data[idx + 1];
            idx += 2;
            if (act.mode > ACTION_STREAM || np > WB_ACTION_MAX_PARAMS ||
                act.delay_ms > 0x7FFFFFFFUL || act.duration_ms > 0x7FFFFFFFUL) {
                Serial.println("[ECA] Invalid action lifecycle/params");
                return false;
            }
            if (act.mode == ACTION_STREAM &&
                (act.update_interval_ms < 20 || act.update_interval_ms > 800)) {
                Serial.println("[ECA] STREAM interval must be 20..800 ms");
                return false;
            }
            act.numParams = np;
            if (!need((uint16_t)np * 10)) return false;
            for (uint8_t p = 0; p < np; p++) {
                memcpy(&act.params[p], &data[idx], 10);
                idx += 10;
                if (act.params[p].type > WB_REF_VAR) {
                    Serial.println("[ECA] Invalid action parameter ref");
                    return false;
                }
            }
        }
    }
    if (idx != end) {
        Serial.printf("[ECA] Trailing payload bytes: %u\n", (unsigned)(end - idx));
        return false;
    }

    resetTimingState();
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
        resetTimingState();
        _running = true;
        Serial.println("[ECA] Running");
    }
}

void WearBlocksECA::stopProgram() {
    _running = false;
    safeAllOutputs();
    resetTimingState();
    Serial.println("[ECA] Stopped");
}

void WearBlocksECA::clearProgram(){
    _running = false;
    safeAllOutputs();
    _hasProgram = false; _numVCs = 0; _numRules = 0;
    _rawLen = 0;
    memset(_vars, 0, sizeof(_vars));
    resetTimingState();
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
    uint32_t hold = rule.hold_ms;
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

bool WearBlocksECA::timeReached(uint32_t now, uint32_t deadline) {
    return (int32_t)(now - deadline) >= 0;
}

bool WearBlocksECA::isVariableCommand(uint8_t cmd) {
    return cmd >= ACT_VAR_SET && cmd <= ACT_VAR_TOGGLE;
}

bool WearBlocksECA::isStopCommand(uint8_t cmd) {
    return cmd == ACT_LED_OFF || cmd == ACT_LED_STOP ||
           cmd == ACT_VIBRATE_STOP || cmd == ACT_AUDIO_STOP;
}

uint8_t WearBlocksECA::stopCommandFor(uint8_t cmd) {
    if (cmd <= ACT_LED_STOP) return ACT_LED_OFF;
    if (cmd >= ACT_VIBRATE && cmd <= ACT_VIBRATE_STOP) return ACT_VIBRATE_STOP;
    if (cmd >= ACT_AUDIO_SET_TONE && cmd <= ACT_AUDIO_STOP) return ACT_AUDIO_STOP;
    return 0xFF;
}

void WearBlocksECA::resetTimingState() {
    memset(_holdStart, 0, sizeof(_holdStart));
    memset(_lastTrigger, 0, sizeof(_lastTrigger));
    memset(_condActive, 0, sizeof(_condActive));
    memset(_lastTriggerValid, 0, sizeof(_lastTriggerValid));
    memset(_ruleLatched, 0, sizeof(_ruleLatched));
    memset(_actionRuntime, 0, sizeof(_actionRuntime));
}

uint32_t WearBlocksECA::claimOutput(uint32_t uid, uint8_t stopCmd) {
    uint8_t freeIdx = WB_ECA_MAX_OUTPUTS;
    for (uint8_t i = 0; i < WB_ECA_MAX_OUTPUTS; i++) {
        if (_outputOwners[i].used && _outputOwners[i].uid == uid) {
            freeIdx = i;
            break;
        }
        if (!_outputOwners[i].used && freeIdx == WB_ECA_MAX_OUTPUTS) freeIdx = i;
    }
    if (freeIdx == WB_ECA_MAX_OUTPUTS) {
        // The table is sized for every rule action, so this can only happen
        // after malformed runtime state. Refuse ownership rather than evicting
        // another live output and creating an unsafe stale timer.
        return 0;
    }
    _nextOwnerToken++;
    if (_nextOwnerToken == 0) _nextOwnerToken++;
    _outputOwners[freeIdx] = {true, uid, _nextOwnerToken, stopCmd};
    return _nextOwnerToken;
}

bool WearBlocksECA::ownsOutput(uint32_t uid, uint32_t token) const {
    if (token == 0) return false;
    for (uint8_t i = 0; i < WB_ECA_MAX_OUTPUTS; i++) {
        if (_outputOwners[i].used && _outputOwners[i].uid == uid &&
            _outputOwners[i].token == token) return true;
    }
    return false;
}

void WearBlocksECA::releaseOutput(uint32_t uid, uint32_t token) {
    for (uint8_t i = 0; i < WB_ECA_MAX_OUTPUTS; i++) {
        if (_outputOwners[i].used && _outputOwners[i].uid == uid &&
            (token == 0 || _outputOwners[i].token == token)) {
            _outputOwners[i].used = false;
            return;
        }
    }
}

bool WearBlocksECA::executeStop(uint32_t uid, uint8_t stopCmd) {
    uint8_t slot = _uidToSlot ? _uidToSlot(uid) : 0;
    if (slot == 0) return false;
    return dispatchActuator(slot, uid, stopCmd, nullptr, 0);
}

void WearBlocksECA::safeAllOutputs() {
    for (uint8_t i = 0; i < WB_ECA_MAX_OUTPUTS; i++) {
        if (!_outputOwners[i].used) continue;
        executeStop(_outputOwners[i].uid, _outputOwners[i].stopCmd);
        _outputOwners[i].used = false;
    }
    memset(_actionRuntime, 0, sizeof(_actionRuntime));
}

void WearBlocksECA::startAction(uint8_t ruleIdx, uint8_t actionIdx, uint32_t now) {
    WBAction& act = _rules[ruleIdx].actions[actionIdx];
    WBActionRuntime& state = _actionRuntime[ruleIdx][actionIdx];
    if (!executeAction(act)) {
        state.pending = false;
        return;
    }
    state.pending = false;
    if (isStopCommand(act.cmd)) {
        releaseOutput(act.target, 0);
        state.active = false;
        state.token = 0;
        return;
    }
    uint8_t stopCmd = stopCommandFor(act.cmd);
    if (stopCmd == 0xFF || isVariableCommand(act.cmd)) {
        state.active = false;
        state.token = 0;
        return;
    }
    state.token = claimOutput(act.target, stopCmd);
    state.active = state.token != 0 &&
                   (act.duration_ms > 0 || act.mode == ACTION_WHILE_TRUE ||
                    act.mode == ACTION_STREAM);
    state.stopAt = act.duration_ms > 0 ? now + act.duration_ms : 0;
    uint16_t interval = max((uint16_t)20, act.update_interval_ms);
    state.nextUpdateAt = now + interval;
}

void WearBlocksECA::stopAction(uint8_t ruleIdx, uint8_t actionIdx,
                               bool cancelPending) {
    const WBAction& act = _rules[ruleIdx].actions[actionIdx];
    WBActionRuntime& state = _actionRuntime[ruleIdx][actionIdx];
    if (ownsOutput(act.target, state.token)) {
        uint8_t stopCmd = stopCommandFor(act.cmd);
        if (stopCmd != 0xFF) executeStop(act.target, stopCmd);
        releaseOutput(act.target, state.token);
    }
    state.active = false;
    if (cancelPending) state.pending = false;
    state.stopAt = 0;
    state.token = 0;
}

void WearBlocksECA::serviceAction(uint8_t ruleIdx, uint8_t actionIdx,
                                  bool ruleTrue, uint32_t now) {
    const WBAction& act = _rules[ruleIdx].actions[actionIdx];
    WBActionRuntime& state = _actionRuntime[ruleIdx][actionIdx];
    if (state.pending) {
        if (act.mode != ACTION_TRIGGER && !ruleTrue) {
            state.pending = false;
        } else if (timeReached(now, state.dueAt)) {
            startAction(ruleIdx, actionIdx, now);
        }
    }
    if (!state.active) return;
    if (act.duration_ms > 0 && timeReached(now, state.stopAt)) {
        stopAction(ruleIdx, actionIdx);
        return;
    }
    if ((act.mode == ACTION_WHILE_TRUE || act.mode == ACTION_STREAM) && !ruleTrue) {
        stopAction(ruleIdx, actionIdx);
        return;
    }
    if (act.mode == ACTION_STREAM && timeReached(now, state.nextUpdateAt)) {
        // A superseded stream must never reclaim the output from its newer owner.
        if (ownsOutput(act.target, state.token)) executeAction(act);
        uint16_t interval = max((uint16_t)20, act.update_interval_ms);
        state.nextUpdateAt = now + interval;
    }
}

bool WearBlocksECA::executeAction(const WBAction& act) {

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
            return false;
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
        if (vid >= WB_ECA_MAX_VARS) return false;
        switch ((WBActCmd)act.cmd) {
            case ACT_VAR_RESET:  _vars[vid] = 0.0f; break;
            case ACT_VAR_TOGGLE: _vars[vid] = (_vars[vid] >= 0.5f) ? 0.0f : 1.0f; break;
            case ACT_VAR_INC:    _vars[vid] += vals[0]; break;
            case ACT_VAR_SET:    _vars[vid]  = vals[0]; break;
            default: break;
        }
        Serial.printf("[ECA] VAR[%d] = %.2f\n", vid, _vars[vid]);
        return true;
    }

    // Actuator commands: target is a module UID. Resolve to slot before
    // emitting the CAN frame. If the UID isn't registered, skip silently.
    uint8_t targetSlot = _uidToSlot ? _uidToSlot(act.target) : 0;
    if (targetSlot == 0) {
        Serial.printf("[ECA] ACT skip: uid=%08lX not registered\n",
                      (unsigned long)act.target);
        return false;
    }

    uint8_t buf[8];
    uint8_t lease10ms = 0;
    if (act.mode == ACTION_STREAM) {
        uint32_t leaseMs = max((uint32_t)100, (uint32_t)act.update_interval_ms * 3U);
        leaseMs = min(leaseMs, (uint32_t)2550);
        lease10ms = (uint8_t)((leaseMs + 9) / 10);
    }
    bool sent = false;
    switch ((WBActCmd)act.cmd) {
        case ACT_LED_SOLID: {
            buf[0] = clampByte(vals[0]);  // R
            buf[1] = clampByte(vals[1]);  // G
            buf[2] = clampByte(vals[2]);  // B
            buf[3] = (act.duration_ms >> 24) & 0xFF;
            buf[4] = (act.duration_ms >> 16) & 0xFF;
            buf[5] = (act.duration_ms >> 8) & 0xFF;
            buf[6] = act.duration_ms & 0xFF;
            buf[7] = lease10ms;
            sent = dispatchActuator(targetSlot, act.target, act.cmd, buf, 8);
            break;
        }
        case ACT_LED_OFF:
        case ACT_LED_STOP:
            sent = dispatchActuator(targetSlot, act.target, act.cmd, nullptr, 0);
            break;

        case ACT_VIBRATE: {
            uint32_t dur = act.duration_ms > 0
                         ? act.duration_ms
                         : clampU16(vals[1]); // legacy JSON compatibility
            buf[0] = clampByte(vals[0]);          // intensity
            buf[1] = (dur >> 24) & 0xFF;
            buf[2] = (dur >> 16) & 0xFF;
            buf[3] = (dur >> 8) & 0xFF;
            buf[4] = dur & 0xFF;
            buf[5] = lease10ms;
            sent = dispatchActuator(targetSlot, act.target, act.cmd, buf, 6);
            break;
        }
        case ACT_VIBRATE_PULSE: {
            buf[0] = clampByte(vals[0]);  // intensity
            buf[1] = clampByte(fmaxf(1.0f, ceilf(vals[1] / 10.0f))); // on, 10 ms units
            buf[2] = clampByte(fmaxf(1.0f, ceilf(vals[2] / 10.0f))); // off, 10 ms units
            buf[3] = clampByte(vals[3]);  // count
            buf[4] = lease10ms;
            sent = dispatchActuator(targetSlot, act.target, act.cmd, buf, 5);
            break;
        }
        case ACT_VIBRATE_RAMP: {
            uint32_t dur = act.duration_ms > 0
                         ? act.duration_ms
                         : clampU16(vals[2]); // legacy JSON compatibility
            buf[0] = clampByte(vals[0]);  // from_pct
            buf[1] = clampByte(vals[1]);  // to_pct
            buf[2] = (dur >> 24) & 0xFF;
            buf[3] = (dur >> 16) & 0xFF;
            buf[4] = (dur >> 8) & 0xFF;
            buf[5] = dur & 0xFF;
            buf[6] = lease10ms;
            sent = dispatchActuator(targetSlot, act.target, act.cmd, buf, 7);
            break;
        }
        case ACT_VIBRATE_STOP:
            sent = dispatchActuator(targetSlot, act.target, act.cmd, nullptr, 0);
            break;

        case ACT_AUDIO_SET_TONE: {
            uint16_t freq = clampU16(vals[0]);
            buf[0] = freq & 0xFF;          // freq_lo (LE — module_amplifier reads p[0] | p[1]<<8)
            buf[1] = (freq >> 8) & 0xFF;   // freq_hi
            buf[2] = clampByte(vals[1]);   // amp 0..255
            buf[3] = (act.duration_ms >> 24) & 0xFF;
            buf[4] = (act.duration_ms >> 16) & 0xFF;
            buf[5] = (act.duration_ms >> 8) & 0xFF;
            buf[6] = act.duration_ms & 0xFF;
            buf[7] = lease10ms;
            sent = dispatchActuator(targetSlot, act.target, act.cmd, buf, 8);
            break;
        }
        case ACT_AUDIO_STOP:
            sent = dispatchActuator(targetSlot, act.target, act.cmd, nullptr, 0);
            break;

        // LED RAMP/BREATHE/BLINK/RAINBOW reserved — module_led v3 only
        // implements SOLID. Pass through resolved bytes for forward-compat.
        default: {
            uint8_t n = act.numParams;
            if (n > sizeof(buf)) n = sizeof(buf);
            for (uint8_t i = 0; i < n; i++) buf[i] = clampByte(vals[i]);
            sent = dispatchActuator(targetSlot, act.target, act.cmd, buf, n);
            break;
        }
    }
    if (sent) {
        Serial.printf("[ECA] ACT slot=%d cmd=%d (uid=%08lX)\n",
                      targetSlot, act.cmd, (unsigned long)act.target);
    }
    return sent;
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

    // Step 2: evaluate rules and service their cooperative action schedulers.
    uint32_t now = millis();
    for (uint8_t r = 0; r < _numRules; r++) {
        bool conditionTrue = evaluateConditions(_rules[r], r, now);
        for (uint8_t a = 0; a < _rules[r].num_act && a < WB_ECA_MAX_ACTIONS; a++) {
            serviceAction(r, a, conditionTrue, now);
        }

        if (!conditionTrue) {
            _ruleLatched[r] = false;
            continue;
        }
        if (_ruleLatched[r]) continue;

        uint32_t cd = _rules[r].cooldown_ms;
        if (cd > 0 && _lastTriggerValid[r] && (now - _lastTrigger[r]) < cd) continue;

        _lastTrigger[r] = now;
        _lastTriggerValid[r] = true;
        _ruleLatched[r] = true;
        for (uint8_t a = 0; a < _rules[r].num_act && a < WB_ECA_MAX_ACTIONS; a++) {
            WBAction& act = _rules[r].actions[a];
            WBActionRuntime& state = _actionRuntime[r][a];
            state.pending = true;
            state.dueAt = now + act.delay_ms;
            if (act.delay_ms == 0) startAction(r, a, now);
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
        dispatchTopic(slot, uid, ch, true);
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
        dispatchTopic(targetSlot, uid, ch, true);
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
