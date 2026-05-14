#ifndef WEARBLOCKS_ECA_H
#define WEARBLOCKS_ECA_H

/*
 * WearBlocks ECA Engine
 * Event-Condition-Action rule engine for the Hub (ESP32-C3).
 *
 * Bytecode format (v3, variable length, sent via $P command):
 *   [magic:2=0x57,0x42][version:1=0x03][num_vars:1][var_inits:4f×n]
 *   [num_vc:1][vc_defs:22B×n]
 *   [num_rules:1]
 *     per rule: [num_cond:1][logic:1][num_act:1][cond×n:15B each]
 *     per action: [target:4][cmd:1][numParams:1][param×N: 10B each]
 *       param = [type:1][id:4][ch:1][value:f32]
 *   [checksum:1]  (sum of all bytes, mod 256)
 *
 * Reference types used in conditions, virtual channels, and action params:
 *   WB_REF_SLOT  0x00  — module sensor channel (id = module UID, 4 bytes)
 *   WB_REF_CONST 0x01  — float constant (encoded inline in `value`)
 *   WB_REF_VC    0x02  — virtual channel (id = vc_id 0-7, low byte only)
 *   WB_REF_VAR   0x03  — variable (id = var_id 0-7, low byte only)
 *
 * v3 vs v2: refs are now keyed by **module UID** (4-byte stable id) rather
 * than the hub-internal slot (1 byte, runtime-assigned). The engine asks
 * the host (`setUidResolver`) to translate uid→slot at execute time. The
 * frontend never sees a slot number — it stores UIDs in saved workspaces,
 * which survive replug/restart. See hub.ino:hubUidToSlot for the wiring.
 *
 * v2 → v3 size deltas: condition 12B → 15B, vc 16B → 22B, action header
 * 3B → 6B (target u8 → u32), action param 7B → 10B.
 */

#include <Arduino.h>
#include <WearBlocksProtocol.h>

// ─────────────────────────────────────────────────────
//  CHANNEL IDs (sensor channels per module)
// ─────────────────────────────────────────────────────

enum WBChannelID : uint8_t {
    // IMU raw (always ON, sent by module)
    WB_CH_AX = 0, WB_CH_AY, WB_CH_AZ,
    WB_CH_GX, WB_CH_GY, WB_CH_GZ,

    // IMU derived (topic-switched, OFF by default)
    WB_CH_ACC_MAG,      // √(ax²+ay²+az²)
    WB_CH_GYRO_MAG,     // √(gx²+gy²+gz²)
    WB_CH_PITCH,        // degrees, atan2
    WB_CH_ROLL,         // degrees, atan2
    WB_CH_AX_LPF,       // low-pass filtered ax
    WB_CH_AY_LPF,
    WB_CH_AZ_LPF,
    WB_CH_ACC_MAG_LPF,
    WB_CH_JERK,         // |acc_mag(t) - acc_mag(t-1)| × sampleRate

    // IMU events (topic-switched)
    WB_CH_SHAKE    = 16, // 1.0 on trigger
    WB_CH_STEP     = 17, // cumulative count (float)
    WB_CH_FREEFALL = 18, // 1.0 on trigger

    // HR raw (always ON)
    WB_CH_BPM   = 24,
    WB_CH_SPO2  = 25,

    // HR derived (topic-switched)
    WB_CH_BPM_AVG  = 26,
    WB_CH_HR_HIGH  = 27, // event: 1.0 when sustained high bpm
    WB_CH_HR_SPIKE = 28, // event: 1.0 on sudden spike

    // Environmental raw (always ON)
    WB_CH_CELSIUS  = 32,
    WB_CH_HUMIDITY = 33,

    // Environmental derived
    WB_CH_HEAT_INDEX = 34,

    // Input controls (knobs, sliders, buttons). Convention: normalized 0..1 float.
    WB_CH_KNOB = 40,

    // Ambient light (LDR voltage divider). Normalized 0..1, brighter → 1.
    WB_CH_LIGHT = 41,

    WB_CH_MAX = 48
};

// Sensor type bytes (used in CAN frames)
// NEW protocol: modules use WBChannelID directly as sensorType (1 float per frame).
// LEGACY types below are kept for backward compatibility with old module firmware.
enum WBSensorType : uint8_t {
    WB_SENS_IMU_RAW     = 0x01,  // LEGACY: 6 floats packed (multi-frame, fragile)
    WB_SENS_HR_RAW      = 0x02,  // LEGACY: 2 floats packed
    WB_SENS_ENV_RAW     = 0x03,  // LEGACY: 2 floats packed
    // New modules should use sendSensorChannel(channelId, value) instead.
    // channelId = WBChannelID enum value, one float per CAN frame.
};

// Reference types
// Note on naming: WB_REF_SLOT is the historical name kept for ABI/source
// compatibility. Since v3 bytecode the `id` field carries a 4-byte UID,
// not a slot index — slot lookup happens only inside the runtime resolver
// (_uidToSlot). Prefer WB_REF_UID in new code; the two are identical.
#define WB_REF_SLOT  0x00
#define WB_REF_UID   WB_REF_SLOT
#define WB_REF_CONST 0x01
#define WB_REF_VC    0x02
#define WB_REF_VAR   0x03

// ─────────────────────────────────────────────────────
//  VIRTUAL CHANNEL OPERATIONS
// ─────────────────────────────────────────────────────

enum WBVCOp : uint8_t {
    VC_ADD = 0, VC_SUB, VC_MUL, VC_DIV,
    VC_ABS, VC_NEG,
    VC_MIN, VC_MAX,
    VC_MAP,    // (a - b_const) / (c_const - b_const), clamped [0,1]
    VC_CLAMP,  // clamp(a, b_const, c_const)
    VC_DIFF,   // a(t) - a(t-1), one-sample derivative
};

// ─────────────────────────────────────────────────────
//  CONDITION OPERATORS
// ─────────────────────────────────────────────────────

enum WBCondOp : uint8_t {
    COND_GT = 0, COND_LT, COND_GTE, COND_LTE, COND_EQ, COND_NEQ
};

enum WBLogic : uint8_t { LOGIC_AND = 0, LOGIC_OR };

// ─────────────────────────────────────────────────────
//  ACTUATOR COMMANDS
// ─────────────────────────────────────────────────────

enum WBActCmd : uint8_t {
    // LED Ring  (params resolved to floats, then clamped 0..255 → bytes)
    ACT_LED_OFF     = 0,   // 0 params
    ACT_LED_SOLID   = 1,   // 3 params: R, G, B
    ACT_LED_RAMP    = 2,   // reserved (LED v3 implements only SOLID for now)
    ACT_LED_BREATHE = 3,   // reserved
    ACT_LED_BLINK   = 4,   // reserved
    ACT_LED_RAINBOW = 5,   // reserved
    ACT_LED_STOP    = 6,   // 0 params

    // Vibration Motor
    ACT_VIBRATE       = 16,  // 2 params: intensity (0..100), dur_ms
    ACT_VIBRATE_PULSE = 17,  // 4 params: intensity, on_10ms, off_10ms, count
    ACT_VIBRATE_RAMP  = 18,  // 3 params: from_pct, to_pct, dur_100ms
    ACT_VIBRATE_STOP  = 19,  // 0 params

    // Variable operations (no CAN, Hub-internal only)
    ACT_VAR_SET    = 32,  // 1 param: resolved to float, assigned to var
    ACT_VAR_INC    = 33,  // 1 param: resolved to float, added to var
    ACT_VAR_RESET  = 34,  // 0 params: reset var to 0
    ACT_VAR_TOGGLE = 35,  // 0 params: var = 1.0 - var

    // Audio Synth (MAX98357A I2S amp)
    ACT_AUDIO_SET_TONE = 48,  // 3 params: freq_lo, freq_hi (uint16 LE Hz), amp (0..255)
    ACT_AUDIO_STOP     = 49,  // 0 params
};

// ─────────────────────────────────────────────────────
//  BYTECODE STRUCTS (packed)
// ─────────────────────────────────────────────────────

struct __attribute__((packed)) WBCondition {
    uint8_t  ref_type;     // WB_REF_SLOT / _VC / _VAR
    uint32_t id;           // UID (for SLOT), vc_id (for VC), var_id (for VAR)
    uint8_t  channel_id;   // WBChannelID (only for ref_type=SLOT)
    uint8_t  op;           // WBCondOp
    float    threshold;    // comparison value
    uint16_t hold_ms;      // must hold true this long before firing
    uint16_t cooldown_ms;  // lockout after trigger
};  // 15 bytes

struct __attribute__((packed)) WBVirtualChannel {
    uint8_t  vc_id;        // 0-7
    uint8_t  op;           // WBVCOp
    uint8_t  a_type;       // WB_REF_SLOT / _CONST / _VC / _VAR
    uint32_t a_id;         // UID / vc_id / var_id (low byte for VC/VAR)
    uint8_t  a_ch;         // channel_id (only for SLOT)
    uint8_t  b_type;       // same as a_type
    uint32_t b_id;
    uint8_t  b_ch;
    float    b_const;      // float constant for b (or in_lo for MAP)
    float    c_const;      // float constant c (in_hi for MAP, max for CLAMP)
};  // 22 bytes

// Bytecode action params (v3): each parameter is a typed reference resolved
// to a float at execute time. Per-cmd param schema lives in the executor
// (WearBlocksECA.cpp): e.g. LED_SOLID expects 3 params [R, G, B] each 0..255,
// VIBRATE expects [intensity_pct, dur_ms], VAR_SET/VAR_INC expect 1 value.
struct __attribute__((packed)) WBActionParam {
    uint8_t  type;         // WB_REF_SLOT / _CONST / _VC / _VAR
    uint32_t id;           // UID / vc_id / var_id (low byte for VC/VAR)
    uint8_t  ch;           // channel_id (only for SLOT)
    float    value;        // CONST literal (ignored for non-CONST)
};  // 10 bytes

#define WB_ACTION_MAX_PARAMS 4

struct __attribute__((packed)) WBAction {
    uint32_t       target;      // module UID (for actuator cmds) or var_id (for VAR_*, low byte only)
    uint8_t        cmd;         // WBActCmd
    uint8_t        numParams;   // 0..WB_ACTION_MAX_PARAMS
    WBActionParam  params[WB_ACTION_MAX_PARAMS];
};

struct WBRule {
    uint8_t     num_cond;
    uint8_t     logic;      // WBLogic
    uint8_t     num_act;
    WBCondition conditions[4];
    WBAction    actions[4];
};

// ─────────────────────────────────────────────────────
//  ECA ENGINE
// ─────────────────────────────────────────────────────

#define WB_ECA_MAX_RULES 16
#define WB_ECA_MAX_VCS   8
#define WB_ECA_MAX_VARS  8
#define WB_ECA_MAX_SLOTS 7   // ECA register cap: slots 1-6 are addressable in
                             // the runtime, index 0 unused. This is *separate*
                             // from ModuleRegistry's broader slot range
                             // (1..WB_MAX_MODULES, currently 11) used for
                             // descriptor/topology bookkeeping; only the first
                             // 6 registry slots are reachable from rule
                             // bytecode. Bumping this widens the per-slot
                             // cache arrays below and the bitmap in
                             // autoEnableTopics; check both before changing.
#define WB_ECA_MAGIC_0   0x57
#define WB_ECA_MAGIC_1   0x42
#define WB_ECA_VERSION   0x03

// Max bytecode size for NVS persistence. Comfortably under the ESP32
// NVS Preferences blob limit (~4000 B). Bumping this requires confirming
// the new size still fits in the namespace's free pages.
#define WB_ECA_PROGRAM_MAX 2048

class WearBlocksECA {
public:
    // Host-supplied UID→slot lookup. Returns 0 if uid is not registered.
    // The engine uses this to (a) read sensor cache for SLOT-typed refs,
    // (b) target actuator commands at the correct CAN slot, and (c) enable
    // topics on the right module. Without it, all SLOT refs resolve to 0.
    typedef uint8_t (*UidToSlotFn)(uint32_t uid);

    WearBlocksECA();
    void begin(WearBlocksProtocol& proto);
    void setUidResolver(UidToSlotFn fn) { _uidToSlot = fn; }

    // Program management
    bool loadProgram(const uint8_t* data, uint16_t len);
    void runProgram();
    void stopProgram();
    void clearProgram();
    bool isRunning() const { return _running; }
    bool hasProgram() const { return _hasProgram; }

    // NVS persistence (ESP32 Preferences). Auto-save is opt-in: hub.ino
    // calls saveToNVS() after a successful loadProgram() so the hub comes
    // back up running the same program after a reboot or power loss.
    // clearProgram() does NOT touch NVS; call eraseFromNVS() explicitly
    // (or use the $PE command on the wire protocol).
    //
    //   saveToNVS()    — write the most recently loaded raw bytecode
    //   loadFromNVS()  — read+parse stored bytecode (does not auto-run)
    //   eraseFromNVS() — wipe the stored blob; runtime state untouched
    //   hasStoredProgram() — true if a non-empty blob exists in NVS
    bool saveToNVS();
    bool loadFromNVS();
    bool eraseFromNVS();
    bool hasStoredProgram() const;

    // Read-only accessors for $Q,ECA introspection. The raw bytecode is
    // exactly what the frontend originally uploaded via $P, so a
    // round-trip lets the host re-decode rules + VCs from a single
    // source of truth without duplicating parser state on both sides.
    uint8_t        getNumRules()    const { return _numRules; }
    uint8_t        getNumVCs()      const { return _numVCs; }
    uint16_t       getRawLen()      const { return _rawLen; }
    const uint8_t* getRawProgram()  const { return _rawProgram; }

    // Called by hub's onSensorData callback
    void updateSensor(uint8_t slot, uint8_t sensorType,
                      const uint8_t* payload, uint8_t payloadLen);

    // Called each hub loop() iteration
    void tick();

    // Analyze loaded program and return bitmask of (slot, channelId) pairs needed
    void autoEnableTopics();

    // Like autoEnableTopics(), but only emits topic enables for the given
    // module UID. Use after a mid-session re-register (HELLO from a UID the
    // running program already references) so the reattached module starts
    // streaming the channels the program reads, without forcing a full
    // re-deploy. Safe to call when no program is loaded; safe to call when
    // the UID is unknown to the resolver (silently no-ops).
    void autoEnableTopicsForUid(uint32_t uid);

    // Read current sensor cache (for serial forwarding)
    float getSensorValue(uint8_t slot, uint8_t channelId) const;

private:
    // Value resolution
    float resolveRef(uint8_t ref_type, uint32_t id, uint8_t channel_id);
    float computeVC(uint8_t vc_id);
    bool  evaluateConditions(const WBRule& rule, uint8_t rule_idx, uint32_t now);
    void  executeAction(const WBAction& act);
    bool  ruleNeedsContinuousUpdates(const WBRule& rule) const;
    void  clearTransientEvents();

    UidToSlotFn _uidToSlot;

    // Sensor cache: [slot 1-6][channel_id 0-47]
    float    _cache[WB_ECA_MAX_SLOTS][WB_CH_MAX];
    float    _prevCache[WB_ECA_MAX_SLOTS][WB_CH_MAX]; // for DIFF
    bool     _eventFresh[WB_ECA_MAX_SLOTS][WB_CH_MAX];
    float    _vcVal[WB_ECA_MAX_VCS];
    float    _vars[WB_ECA_MAX_VARS];

    // Sensor reassembly buffers (for multi-frame IMU raw, 6 floats = 24 bytes)
    uint8_t  _reassemBuf[WB_ECA_MAX_SLOTS][24];
    uint8_t  _reassemLen[WB_ECA_MAX_SLOTS];

    // Per-rule timing state
    uint32_t _holdStart[WB_ECA_MAX_RULES];    // when condition first became true
    uint32_t _lastTrigger[WB_ECA_MAX_RULES];  // last trigger time (cooldown)
    bool     _condActive[WB_ECA_MAX_RULES];   // current condition state
    bool     _lastTriggerValid[WB_ECA_MAX_RULES];
    bool     _ruleLatched[WB_ECA_MAX_RULES];  // edge-fire latch for constant actions

    // Program storage
    WBVirtualChannel _vcs[WB_ECA_MAX_VCS];
    WBRule           _rules[WB_ECA_MAX_RULES];
    uint8_t          _numVCs;
    uint8_t          _numRules;
    bool             _running;
    bool             _hasProgram;

    // Raw bytecode stash — kept on every successful loadProgram() so we
    // can hand the same bytes back to NVS on saveToNVS() without having
    // to re-serialize the parsed Rule[] / VC[] structures.
    uint8_t  _rawProgram[WB_ECA_PROGRAM_MAX];
    uint16_t _rawLen;

    WearBlocksProtocol* _proto;
};

#endif // WEARBLOCKS_ECA_H
