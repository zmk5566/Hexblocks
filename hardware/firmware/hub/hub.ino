/*
 * WearBlocks Hub v2 — Topology-Robust Refactor
 * Target: ESP32-C3-MINI-1
 *
 * Architecture:
 *   - CAN bus master (500 kbps).
 *   - Digital presence: 6 GPIOs as INPUT_PULLUP, one per hub face. Module's
 *     dock ties POS_ID to GND → digitalRead == LOW means occupied.
 *     Debounced 5 × 20 ms.
 *   - Identity: each module sends its UID (efuse MAC low 32 bits) in HELLO.
 *     UID is the canonical key for *everything* visible outside this process.
 *     slot (1..11) is an internal CAN addressing alias, kept persistent for
 *     the UID's lifetime in the registry.
 *   - Single truth source per fact:
 *       • hub-face occupancy       ← hub FACE_PIN debounce
 *       • module-R-face occupancy  ← that module's CHILD_EVENT
 *       • module identity          ← HELLO.uid
 *       • module's parent+face     ← derived by hub from a FIFO queue of
 *                                    pending attach signals (HUB_FACE_OCC or
 *                                    MODULE_CHILD_OCC). No inference spread
 *                                    across multiple callbacks.
 *   - TTL: a module going physically absent is marked DETACHED; slot held
 *     8 s before reap. Reinsertion within 8 s preserves slot and — if
 *     fwHash matches cache — skips descriptor transfer entirely.
 *   - Stacking depth: supports arbitrary parent-slot chains (3+ layers).
 *
 * Serial bridge line protocol (UID-keyed; slot never leaked to frontend):
 *   $H,<uid>,<moduleId>,<parentUid|HUB>,<parentFace>
 *       module registered/re-registered; moduleId may be "" pending descriptor
 *   $D,<uid>,<descriptorJSON>
 *   $I,<uid>,<moduleId>,<version>,<fwHash>
 *       identity/version note; moduleId/version may be "" pending descriptor
 *   $S,<uid>,<channelId>,<floatValue>
 *   $X,<uid>                                detached (TTL started)
 *   $F,<uid>,<oldParent>,<oldFace>,<newParent>,<newFace>  moved/rebound
 *   $U,<uid>                                unplugged (TTL fired or evicted)
 *   $C,<parentUid>,<childUid|PENDING>,<parentFace>        child docked
 *   $c,<parentUid>,<childUid|PENDING>,<parentFace>        child undocked
 *   $T,<uid>,<parentUid|HUB>,<parentFace>                 topology entry
 *   $Q,DONE                                               end of resync
 *
 * Host commands (Serial → hub):
 *   $Q,STATUS              dump current registry as $H/$D lines + $Q,DONE
 *   $Q,TOPO                emit $T,<uid>,<parent>,<face> for each module
 *   $Q,ECA                 emit $E summary + $EB raw bytecode (if loaded) + $Q,DONE
 *   $Q,FORGET ALL          wipe topology memory (use before offline rearrange)
 *   $Q,FORGET <uidHex>     wipe one remembered binding
 *   $P <base64>            upload + auto-run ECA bytecode (also persists to NVS)
 *   $PR / $PS / $PC        run / stop / clear ECA ($PC also wipes NVS)
 *   $PE                    erase persisted ECA bytecode from NVS only (runtime untouched)
 *   $A <uidHex> <cmd> <p...>  actuator EXECUTE
 *   $TE <uidHex> <ch>      topic enable;  $TD <uidHex> <ch> disable
 *   $TA <uidHex>           topic enable all
 */

#include <WearBlocksCAN.h>
#include <WearBlocksProtocol.h>
#include <WearBlocksDescriptor.h>
#include <WearBlocksECA.h>
#include <Preferences.h>
#include <mbedtls/base64.h>
#include "ModuleRegistry.h"

// ── BLE peripheral ────────────────────────────────���───────────
// The hub exposes Nordic UART Service so the bridge (`bleak`) can read
// the same $-prefixed protocol stream that USB-CDC carries. USB and BLE
// are mutually exclusive at the bridge layer; the firmware keeps both
// alive at the same time and lets whichever side has a live host write
// commands. No PIN/bonding — Just-Works pairing only (lab use).
//
// arduino-esp32 v3+ ships NimBLE-Arduino as the recommended stack on
// ESP32-C3. If your toolchain pulls the older Bluedroid `BLEDevice.h`,
// swap the include line and replace NimBLE classes with their BLE*
// counterparts (the API surface used here is intentionally small).
#include <NimBLEDevice.h>

#define NUS_SERVICE_UUID  "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_RX_CHAR_UUID  "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"  // host -> hub
#define NUS_TX_CHAR_UUID  "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"  // hub  -> host

NimBLECharacteristic* g_bleTxChar       = nullptr;
NimBLECharacteristic* g_bleRxChar       = nullptr;
volatile bool         g_bleClientConnected = false;
char                  g_bleAdvName[16] = {0};

// Forward declaration (used by MirrorStream below).
static void bleNotifyLine(const char* line, size_t len);

// MirrorStream — Print subclass that line-buffers output, writes each
// byte to USB Serial, and flushes whole '\n'-terminated lines to BLE
// notify when a client is connected. Used only at $-protocol emission
// sites; debug `[XXX]` messages keep using `Serial` directly so they
// don't pollute the BLE channel.
class MirrorStream : public Print {
public:
    char   _buf[512];
    size_t _len = 0;

    size_t write(uint8_t c) override {
        Serial.write(c);
        _accumulate(c);
        return 1;
    }
    size_t write(const uint8_t* data, size_t size) override {
        size_t n = Serial.write(data, size);
        for (size_t i = 0; i < size; i++) _accumulate(data[i]);
        return n;
    }

private:
    void _accumulate(uint8_t c) {
        if (_len < sizeof(_buf) - 1) _buf[_len++] = (char)c;
        // BLE may need to carry long protocol lines such as `$EB,<base64>`.
        // Flush full fragments too; the bridge reassembles notify chunks
        // until it sees the final newline.
        if (c == '\n' || _len == sizeof(_buf) - 1) {
            _buf[_len] = '\0';
            bleNotifyLine(_buf, _len);
            _len = 0;
        }
    }
};

MirrorStream out;

// ── Pin assignment ─────────────────────────────────────────────
#define CAN_TX_PIN   6
#define CAN_RX_PIN   7
#define STATUS_LED   9

const uint8_t FACE_PIN[6] = {0, 2, 3, 4, 8, 10};

WearBlocksCAN      can;
WearBlocksProtocol protocol;
ModuleRegistry     registry;
WearBlocksECA      eca;

// ── Tunables ──────────────────────────────────────────────────
const uint32_t FACE_SCAN_TICK         = 20;
const uint8_t  DEBOUNCE_CONSECUTIVE   = 5;
const uint32_t DETACH_TTL_MS          = 8000;
// Pending attach TTL was 5000 ms originally. Pulled to 12000 so a single
// CAN packet loss won't expire an attach before the module's next HELLO
// retry / keepalive lands. With B8's hub-face keepalive re-enqueueing
// every 4s on still-occupied faces, the actual time an attach can be
// stale is bounded by HUB_FACE_KEEPALIVE_MS, not this TTL — but the
// extra slack helps debug prints stay coherent under load.
const uint32_t PENDING_ATTACH_TTL_MS  = 12000;
// Hub-face attach keepalive. Mirrors what modules already do for their
// own child faces (CHILD_KEEPALIVE_MS in module_imu): every 4s, every
// committed-occupied hub face re-enqueues an ATTACH_HUB_FACE entry
// (enqueueAttach dedups + refreshes timestamp on existing entries). This
// is what makes "hub reboots while modules stay powered" recoverable: a
// module's 7s keepalive HELLO finds a fresh attach in the queue and
// takes the unknown-UID first-time-insertion path. Also recovers a
// face whose PENDING module was reaped after descriptor handshake
// failure — the face stays occupied so the keepalive keeps the attach
// fresh until the module retries HELLO.
const uint32_t HUB_FACE_KEEPALIVE_MS  = 4000;
const uint32_t STATS_INTERVAL         = 5000;

// ── Face debounce ─────────────────────────────────────────────
struct FaceTrack {
    bool     committedOccupied;
    uint8_t  streak;
};
FaceTrack faceTracks[6] = {};
uint32_t  lastFaceScan = 0;

// ── Pending-attach FIFO ───────────────────────────────────────
// A unified queue of "somebody just appeared at this parent.face" signals.
// Entries come from:
//   HUB_FACE:     hub's own GPIO debounce fires occupied
//   MODULE_CHILD: a registered module reports CHILD_EVENT(occupied=1)
// HELLO consumes the oldest unconsumed entry within PENDING_ATTACH_TTL_MS;
// that entry tells us the new module's parent slot + face.
//
// If a face/child event goes unoccupied while its entry is still pending,
// that entry is pruned (the module that was physically present left before
// sending HELLO — a transient that should not later match a different UID).
enum AttachKind : uint8_t { ATTACH_HUB_FACE, ATTACH_MODULE_CHILD };
struct PendingAttach {
    bool       active;
    AttachKind kind;
    uint8_t    hubFace;        // kind == HUB_FACE
    uint8_t    parentSlot;     // kind == MODULE_CHILD
    uint8_t    parentFace;     // kind == MODULE_CHILD
    uint32_t   createdAtMs;
};
#define PENDING_ATTACH_MAX 16
PendingAttach attachQueue[PENDING_ATTACH_MAX] = {};

// ── UID-keyed topology memory (NVS-backed) ────────────────────
// What it solves:
//   Hub-only reboot with multiple modules still powered. Setup() enqueues
//   every occupied face essentially simultaneously, so the FIFO pick has
//   no information to tell module-A's HELLO apart from module-B's. The
//   wrong binding is *stable* — keepalive HELLOs from a registered UID
//   are idempotent, so the misbinding never self-corrects.
//
// How it works:
//   Each successful registration writes (uid, parentUid, parentFace) into
//   an in-memory table mirrored to NVS (Preferences blob). On reboot the
//   table is loaded; when an unknown UID's HELLO arrives, the hub checks
//   the table first. If memory has a remembered binding AND the
//   remembered face is still physically occupied AND the parent (HUB or
//   another module by UID) is currently registered, the hub binds to the
//   remembered location instead of consuming a FIFO attach. memory miss
//   falls back to the FIFO + ambiguous log path.
//
// Persistence policy:
//   Mutations set _topoDirty; loop() flushes once every 30s if dirty.
//   This bounds NVS wear at well under one write per minute even under
//   continuous reseat. Memory loss in the 30s window since the last
//   flush degrades to FIFO behavior, which is acceptable.
struct TopologyMemoryEntry {
    uint32_t uid;          // 0 == empty slot
    uint32_t parentUid;    // 0 == HUB
    uint8_t  parentFace;   // 1..6
    uint8_t  reserved[3];  // pad to 12 bytes for stable on-disk layout
};
#define TOPO_MEM_MAX WB_MAX_MODULES   // 12 entries × 12 B = 144 B blob
TopologyMemoryEntry topoMemory[TOPO_MEM_MAX] = {};
bool      topoDirty       = false;
uint32_t  topoLastFlushMs = 0;
const uint32_t TOPO_FLUSH_MS = 30000;
static const char* TOPO_NVS_NS  = "wb-topo";
static const char* TOPO_NVS_KEY = "mem";

static TopologyMemoryEntry* findTopoEntry(uint32_t uid) {
    if (uid == 0) return nullptr;
    for (uint8_t i = 0; i < TOPO_MEM_MAX; i++) {
        if (topoMemory[i].uid == uid) return &topoMemory[i];
    }
    return nullptr;
}

// Insert or update. If table is full, evict the entry whose UID is no
// longer in the registry (they're stale by definition); if all entries
// are still live, evict the lowest-UID slot — arbitrary but bounded.
static void updateTopoEntry(uint32_t uid, uint32_t parentUid, uint8_t parentFace) {
    if (uid == 0) return;
    TopologyMemoryEntry* slot = findTopoEntry(uid);
    if (!slot) {
        for (uint8_t i = 0; i < TOPO_MEM_MAX; i++) {
            if (topoMemory[i].uid == 0) { slot = &topoMemory[i]; break; }
        }
    }
    if (!slot) {
        // Look for an entry whose UID isn't currently in the registry.
        for (uint8_t i = 0; i < TOPO_MEM_MAX; i++) {
            if (registry.findByUid(topoMemory[i].uid) == 0xFF) {
                slot = &topoMemory[i]; break;
            }
        }
    }
    if (!slot) slot = &topoMemory[0];     // fallback: overwrite arbitrary

    if (slot->uid == uid && slot->parentUid == parentUid &&
        slot->parentFace == parentFace) {
        return;   // unchanged — don't dirty NVS for nothing
    }
    slot->uid        = uid;
    slot->parentUid  = parentUid;
    slot->parentFace = parentFace;
    memset(slot->reserved, 0, sizeof(slot->reserved));
    topoDirty = true;
}

static void removeTopoEntry(uint32_t uid) {
    TopologyMemoryEntry* slot = findTopoEntry(uid);
    if (!slot) return;
    memset(slot, 0, sizeof(*slot));
    topoDirty = true;
}

static bool loadTopoMemory() {
    Preferences prefs;
    if (!prefs.begin(TOPO_NVS_NS, /*readOnly=*/true)) return false;
    size_t storedLen = prefs.getBytesLength(TOPO_NVS_KEY);
    if (storedLen != sizeof(topoMemory)) {
        prefs.end();
        if (storedLen != 0) {
            Serial.printf("[TOPO] NVS size mismatch %u != %u — ignoring\n",
                          (unsigned)storedLen, (unsigned)sizeof(topoMemory));
        }
        return false;
    }
    size_t got = prefs.getBytes(TOPO_NVS_KEY, topoMemory, sizeof(topoMemory));
    prefs.end();
    if (got != sizeof(topoMemory)) return false;
    uint8_t live = 0;
    for (uint8_t i = 0; i < TOPO_MEM_MAX; i++) if (topoMemory[i].uid) live++;
    Serial.printf("[TOPO] loaded %d remembered bindings from NVS\n", live);
    // Print each binding so the user can see what the hub will trust on
    // first HELLO. If the layout was rearranged while powered off, this
    // is the cue to issue $Q,FORGET ALL before modules HELLO in.
    for (uint8_t i = 0; i < TOPO_MEM_MAX; i++) {
        const TopologyMemoryEntry& e = topoMemory[i];
        if (e.uid == 0) continue;
        if (e.parentUid == 0) {
            Serial.printf("[TOPO]   uid=%08lX parent=HUB face=%d\n",
                          (unsigned long)e.uid, e.parentFace);
        } else {
            Serial.printf("[TOPO]   uid=%08lX parent=%08lX face=%d\n",
                          (unsigned long)e.uid,
                          (unsigned long)e.parentUid, e.parentFace);
        }
    }
    return true;
}

static bool saveTopoMemory() {
    Preferences prefs;
    if (!prefs.begin(TOPO_NVS_NS, /*readOnly=*/false)) return false;
    size_t written = prefs.putBytes(TOPO_NVS_KEY, topoMemory, sizeof(topoMemory));
    prefs.end();
    if (written != sizeof(topoMemory)) {
        Serial.printf("[TOPO] saveToNVS short write %u/%u\n",
                      (unsigned)written, (unsigned)sizeof(topoMemory));
        return false;
    }
    return true;
}

// Wipe in-RAM table + erase NVS blob. Use case: user is about to power
// the hub off and physically rearrange modules. Without this escape,
// memory will deterministically misbind on the next boot — both faces
// are still occupied, so the table thinks the rearranged layout is
// the original. Exposed via $Q,FORGET ALL.
//
// On NVS failure we keep the in-RAM wipe (user-visible behavior they
// asked for) but mark the table dirty so the next 30s flush retries
// the persist. The boolean return tells the caller whether NVS itself
// was successfully cleared so $OK can report nvs=erased / nvs=deferred.
static bool eraseTopoMemory() {
    memset(topoMemory, 0, sizeof(topoMemory));
    Preferences prefs;
    bool ok = false;
    if (prefs.begin(TOPO_NVS_NS, /*readOnly=*/false)) {
        ok = prefs.remove(TOPO_NVS_KEY);
        prefs.end();
    }
    if (ok) {
        topoDirty = false;
    } else {
        // RAM wipe is durable enough on its own — saveTopoMemory() will
        // overwrite the stale NVS blob with all-zeros at the next flush.
        topoDirty = true;
    }
    return ok;
}

// ── Stats ──────────────────────────────────────────────────────
uint32_t sampleCount = 0;
uint32_t statsStart = 0;

// ── uid → hex helper ──────────────────────────────────────────
static void formatUidHex(uint32_t uid, char* buf, size_t len) {
    snprintf(buf, len, "%08lX", (unsigned long)uid);
}

static const char* uidHex(uint32_t uid) {
    static char buf[9];
    formatUidHex(uid, buf, sizeof(buf));
    return buf;
}

// Parse 8-char hex uid from a C string (space-terminated or NUL).
static bool parseUidHex(const char* s, uint32_t& result) {
    uint32_t v = 0;
    uint8_t n = 0;
    for (; n < 8 && s[n]; n++) {
        char c = s[n];
        uint8_t d;
        if (c >= '0' && c <= '9')      d = c - '0';
        else if (c >= 'a' && c <= 'f') d = 10 + (c - 'a');
        else if (c >= 'A' && c <= 'F') d = 10 + (c - 'A');
        else break;
        v = (v << 4) | d;
    }
    if (n != 8) return false;
    result = v;
    return true;
}

// Emit a parent label for a serial line ("HUB" or 8-char hex uid).
static void printParentLabel(Print& p, uint8_t parentSlot) {
    if (parentSlot == WB_PARENT_HUB) {
        p.print("HUB");
    } else {
        const RegisteredModule* m = registry.getModule(parentSlot);
        p.print(m ? uidHex(m->uid) : "????????");
    }
}

static void emitModuleIdentity(Print& p, const RegisteredModule* m) {
    if (!m) return;
    const char* moduleId = m->hasDescriptor ? m->descriptor.moduleId : "";
    const char* version  = m->hasDescriptor ? m->descriptor.version : "";
    p.printf("$I,%s,%s,%s,%04X\n", uidHex(m->uid), moduleId, version, m->fwHash);
}

// ── PendingAttach ops ─────────────────────────────────────────
void enqueueAttach(AttachKind k, uint8_t hubFace, uint8_t parentSlot, uint8_t parentFace) {
    uint32_t now = millis();
    // Drop duplicates on the same key: if the exact same (kind, coords) is
    // already pending, refresh its timestamp instead of queuing a second copy.
    for (uint8_t i = 0; i < PENDING_ATTACH_MAX; i++) {
        PendingAttach& e = attachQueue[i];
        if (!e.active || e.kind != k) continue;
        if (k == ATTACH_HUB_FACE && e.hubFace == hubFace) {
            e.createdAtMs = now;
            return;
        }
        if (k == ATTACH_MODULE_CHILD && e.parentSlot == parentSlot && e.parentFace == parentFace) {
            e.createdAtMs = now;
            return;
        }
    }
    for (uint8_t i = 0; i < PENDING_ATTACH_MAX; i++) {
        if (!attachQueue[i].active) {
            attachQueue[i] = {true, k, hubFace, parentSlot, parentFace, now};
            return;
        }
    }
    // Queue full: evict oldest unconsumed entry.
    uint8_t oldest = 0;
    for (uint8_t i = 1; i < PENDING_ATTACH_MAX; i++) {
        if (attachQueue[i].createdAtMs < attachQueue[oldest].createdAtMs) oldest = i;
    }
    attachQueue[oldest] = {true, k, hubFace, parentSlot, parentFace, now};
    Serial.println("[ATT] queue full, evicted oldest");
}

// peek/commit pair so a HELLO that fails downstream checks (face busy,
// no free slot) doesn't burn the attach event. consumeAttach is kept as
// a peek+commit shorthand for callers that always succeed.
//
// peekAttach: oldest active non-expired entry. Returns its index in
// attachQueue (0..PENDING_ATTACH_MAX-1), or -1 if none. Does NOT mark
// the entry inactive.
int8_t peekAttach(uint8_t& parentSlotOut, uint8_t& parentFaceOut) {
    uint32_t now = millis();
    int8_t best = -1;
    uint32_t bestAge = 0;
    for (uint8_t i = 0; i < PENDING_ATTACH_MAX; i++) {
        PendingAttach& e = attachQueue[i];
        if (!e.active) continue;
        if (now - e.createdAtMs > PENDING_ATTACH_TTL_MS) continue;
        uint32_t age = now - e.createdAtMs;
        if (best == -1 || age > bestAge) {
            best = (int8_t)i;
            bestAge = age;
        }
    }
    if (best < 0) return -1;
    PendingAttach& e = attachQueue[best];
    if (e.kind == ATTACH_HUB_FACE) {
        parentSlotOut = WB_PARENT_HUB;
        parentFaceOut = e.hubFace;
    } else {
        parentSlotOut = e.parentSlot;
        parentFaceOut = e.parentFace;
    }
    return best;
}

void commitAttach(int8_t idx) {
    if (idx < 0 || idx >= PENDING_ATTACH_MAX) return;
    attachQueue[idx].active = false;
}

// peekAttach picks the oldest entry blindly; if the queue head points
// at a face that is currently held by a live module (REGISTERED /
// PENDING with a different UID), peekAttach + ensureFaceFree-fail +
// attach-kept-on-failure becomes head-of-line blocking — every
// subsequent unknown HELLO retries the same dead candidate. peekBindableAttach
// scans the queue and returns the oldest entry whose target face is
// actually bindable for `uid` (free, held by `uid` itself, or held by a
// stale DETACHED occupant we'd be willing to evict). The caller still
// commits via commitAttach() and handles the live-DETACHED removal via
// ensureFaceFree() afterwards.
int8_t peekBindableAttach(uint32_t uid,
                          uint8_t& parentSlotOut, uint8_t& parentFaceOut) {
    uint32_t now = millis();
    int8_t best = -1;
    uint32_t bestAge = 0;
    for (uint8_t i = 0; i < PENDING_ATTACH_MAX; i++) {
        const PendingAttach& e = attachQueue[i];
        if (!e.active) continue;
        if (now - e.createdAtMs > PENDING_ATTACH_TTL_MS) continue;
        uint8_t pSlot, pFace;
        if (e.kind == ATTACH_HUB_FACE) {
            pSlot = WB_PARENT_HUB; pFace = e.hubFace;
        } else {
            pSlot = e.parentSlot;  pFace = e.parentFace;
        }
        if (!registry.canBindToFace(pSlot, pFace, uid)) continue;
        uint32_t age = now - e.createdAtMs;
        if (best == -1 || age > bestAge) {
            best = (int8_t)i;
            bestAge = age;
            parentSlotOut = pSlot;
            parentFaceOut = pFace;
        }
    }
    return best;
}

bool consumeAttach(uint8_t& parentSlotOut, uint8_t& parentFaceOut) {
    int8_t idx = peekAttach(parentSlotOut, parentFaceOut);
    if (idx < 0) return false;
    commitAttach(idx);
    return true;
}

void pruneAttach(AttachKind k, uint8_t hubFace, uint8_t parentSlot, uint8_t parentFace) {
    for (uint8_t i = 0; i < PENDING_ATTACH_MAX; i++) {
        PendingAttach& e = attachQueue[i];
        if (!e.active || e.kind != k) continue;
        if (k == ATTACH_HUB_FACE && e.hubFace == hubFace) { e.active = false; return; }
        if (k == ATTACH_MODULE_CHILD && e.parentSlot == parentSlot && e.parentFace == parentFace) {
            e.active = false; return;
        }
    }
}

void reapAttachQueue(uint32_t now) {
    for (uint8_t i = 0; i < PENDING_ATTACH_MAX; i++) {
        PendingAttach& e = attachQueue[i];
        if (!e.active) continue;
        if (now - e.createdAtMs > PENDING_ATTACH_TTL_MS) {
            if (e.kind == ATTACH_HUB_FACE) {
                Serial.printf("[ATT] reap HUB_FACE F%d (no HELLO in %lu ms)\n",
                              e.hubFace, (unsigned long)PENDING_ATTACH_TTL_MS);
            } else {
                Serial.printf("[ATT] reap MODULE_CHILD slot=%d F%d\n",
                              e.parentSlot, e.parentFace);
            }
            e.active = false;
        }
    }
}

// Count active (non-expired) entries in the pending-attach queue.
static uint8_t countActivePendingAttaches() {
    uint32_t now = millis();
    uint8_t n = 0;
    for (uint8_t i = 0; i < PENDING_ATTACH_MAX; i++) {
        const PendingAttach& e = attachQueue[i];
        if (!e.active) continue;
        if (now - e.createdAtMs > PENDING_ATTACH_TTL_MS) continue;
        n++;
    }
    return n;
}

// ── Protocol callbacks ────────────────────────────────────────
//
// HELLO matching policy (post-fix):
//   1. Look up UID first.
//   2. REGISTERED known UID -> keepalive HELLO. Re-ACK only; never consume
//      an attach. (Modules send a low-frequency HELLO every 7s after ACK
//      so the hub can recover its registry across reboots while modules
//      stay powered.)
//   3. PENDING known UID -> still in handshake, re-ACK + re-request
//      descriptor. Don't consume attach (the binding is already correct).
//   4. DETACHED known UID -> physical reseat / move. Consume attach to
//      learn where the module landed; rebind + reattach; emit $F or $H.
//   5. Unknown UID -> first-time insertion. Consume attach; ensureFaceFree
//      so a stale DETACHED occupant gets removed before the new pending
//      one binds; addPending + ACK + request descriptor.
//
// The old code consumed the attach BEFORE looking up the UID, which let
// a duplicate HELLO from an already-registered module steal an attach
// event meant for a different module that had just been plugged in.
void onModuleHello(const HelloMessage& msg) {
    uint32_t now = millis();
    uint8_t slot = registry.findByUid(msg.uid);

    if (slot != 0xFF) {
        const RegisteredModule* existing = registry.getModule(slot);
        if (!existing) {
            Serial.printf("[HELLO] uid=%s slot=%d registry lookup failed\n",
                          uidHex(msg.uid), slot);
            return;
        }

        // REGISTERED: keepalive / pre-ACK retry. Re-ACK so the module
        // stops the retry loop; never touch parent binding or the attach
        // queue. fwHash mismatch means the module's descriptor changed
        // out from under us (firmware update) — request it again, but the
        // slot stays REGISTERED until a fresh descriptor arrives
        // (markDescriptorPending no longer downgrades state).
        if (existing->state == MODULE_REGISTERED) {
            bool cached = (existing->fwHash == msg.fwHash) && existing->hasDescriptor;
            protocol.sendAck(slot, msg.uid, cached);
            if (!cached) {
                registry.markDescriptorPending(slot, msg.fwHash);
                protocol.requestDescriptor(slot);
            } else {
                Serial.printf("[HELLO] keepalive uid=%s slot=%d\n",
                              uidHex(msg.uid), slot);
            }
            return;
        }

        // PENDING: descriptor handshake still in flight. Re-ACK and
        // re-request descriptor. No rebind (binding came from addPending).
        if (existing->state == MODULE_PENDING) {
            protocol.sendAck(slot, msg.uid, /*cached=*/false);
            protocol.requestDescriptor(slot);
            return;
        }

        // DETACHED: physical reseat or move. We need fresh attach info to
        // know where the module landed. peekBindableAttach skips queue
        // entries whose target face is already held by a live module —
        // critical when keepalive or attach-kept-on-failure has left a
        // dead candidate at the FIFO head.
        uint8_t parentSlot, parentFace;
        int8_t  attachIdx = peekBindableAttach(msg.uid, parentSlot, parentFace);
        if (attachIdx < 0) {
            // No usable attach yet — the FACE/CHILD debounce hasn't
            // fired since the module came back, or every active attach
            // points at a face held by someone else. Treat as duplicate
            // HELLO; the next debounce / keepalive will enqueue a
            // fresh attach and the following HELLO retry will pick it.
            Serial.printf("[HELLO] detached uid=%s slot=%d — no bindable attach yet, deferring\n",
                          uidHex(msg.uid), slot);
            return;
        }

        uint8_t oldParent = existing->parentSlot;
        uint8_t oldFace   = existing->parentFace;
        bool moved        = (oldParent != parentSlot) || (oldFace != parentFace);

        // peekBindableAttach already filtered to a face that's either
        // free, owned by us, or holds a stale DETACHED occupant we can
        // evict. ensureFaceFree handles the DETACHED eviction and emits
        // its $U; since the candidate is bindable, this can only fail in
        // a tight race where the registry mutated between peek and ensure
        // — defensive return without committing the attach.
        if (moved && !registry.ensureFaceFree(parentSlot, parentFace, msg.uid, onSlotRemoved)) {
            Serial.printf("[HELLO] reseat uid=%s — face state changed under us (attach kept)\n",
                          uidHex(msg.uid));
            return;
        }

        commitAttach(attachIdx);
        registry.rebind(slot, parentSlot, parentFace);
        registry.markReattached(slot, now);

        bool cached = (existing->fwHash == msg.fwHash) && existing->hasDescriptor;
        protocol.sendAck(slot, msg.uid, cached);
        if (!cached) {
            registry.markDescriptorPending(slot, msg.fwHash);
            protocol.requestDescriptor(slot);
        }

        // Topic-enable state doesn't survive a module reset. On the
        // cached-reattach path we re-enable here; the non-cached path
        // re-enables in onModuleDescriptor() once state flips to
        // REGISTERED.
        if (cached) {
            eca.autoEnableTopicsForUid(msg.uid);
        }

        // Persist the (possibly new) binding. updateTopoEntry no-ops if
        // unchanged so steady-state keepalive HELLOs don't dirty NVS.
        uint32_t parentUid = 0;
        if (parentSlot != WB_PARENT_HUB) {
            const RegisteredModule* p = registry.getModule(parentSlot);
            if (p) parentUid = p->uid;
        }
        updateTopoEntry(msg.uid, parentUid, parentFace);

        if (moved) {
            out.printf("$F,%s,", uidHex(msg.uid));
            printParentLabel(out, oldParent); out.printf(",%d,", oldFace);
            printParentLabel(out, parentSlot); out.printf(",%d\n", parentFace);
            emitModuleIdentity(out, registry.getModule(slot));
        } else {
            // Reattached at same place — emit fresh $H so frontend can
            // clear the "detached" flag.
            const RegisteredModule* m = registry.getModule(slot);
            out.printf("$H,%s,%s,", uidHex(msg.uid),
                          (m && m->hasDescriptor) ? m->descriptor.moduleId : "");
            printParentLabel(out, parentSlot); out.printf(",%d\n", parentFace);
            emitModuleIdentity(out, m);
        }
        return;
    }

    // Unknown UID — first-time insertion, OR a known module that the hub
    // forgot across a reboot. Two binding paths:
    //
    //   (A) Topology memory hit: the hub remembers this UID's last
    //       parent + face, the parent is currently registered, and that
    //       face is still physically occupied. Trust memory over FIFO —
    //       this is the only way to correctly recover hub-reboot with
    //       multiple modules powered, where setup() enqueues every
    //       occupied face simultaneously and FIFO has no information to
    //       distinguish module-A's HELLO from module-B's. Don't consume
    //       any attach in this path; the FIFO entries belong to whichever
    //       module the queue ordering implies, which we'd be guessing at.
    //
    //   (B) Memory miss: standard FIFO peek + ensureFaceFree path,
    //       ambiguous log if multiple attaches are active.
    uint8_t parentSlot = 0, parentFace = 0;
    int8_t  attachIdx  = -1;
    bool    fromMemory = false;

    const TopologyMemoryEntry* mem = findTopoEntry(msg.uid);
    if (mem) {
        uint8_t parentSlotMem = (mem->parentUid == 0)
                              ? WB_PARENT_HUB
                              : registry.findByUid(mem->parentUid);
        bool parentReady = (parentSlotMem == WB_PARENT_HUB) ||
                           (parentSlotMem != 0xFF);
        bool faceOccupied = false;
        if (parentSlotMem == WB_PARENT_HUB) {
            if (mem->parentFace >= 1 && mem->parentFace <= 6) {
                faceOccupied = faceTracks[mem->parentFace - 1].committedOccupied;
            }
        } else if (parentSlotMem != 0xFF) {
            // For module-parent we trust memory if the parent is registered;
            // module-side child detect provides its own keepalive so the
            // child's actual presence will resync via CHILD_EVENT regardless.
            faceOccupied = true;
        }
        if (parentReady && faceOccupied) {
            // Last gate: the remembered face must actually be bindable
            // for this UID right now. If another live module took the
            // remembered face while this UID was away (rearrange-while-on,
            // or a swap into a face the hub had memorized for someone
            // else), the memory entry is stale — drop it and fall back
            // to FIFO. Without this check, ensureFaceFree below would
            // fail and we'd return without ever trying the bindable
            // attach path, leaving the UID stuck retrying forever.
            if (registry.canBindToFace(parentSlotMem, mem->parentFace, msg.uid)) {
                parentSlot = parentSlotMem;
                parentFace = mem->parentFace;
                fromMemory = true;
                Serial.printf("[TOPO] memory hit uid=%s parent=%s face=%d\n",
                              uidHex(msg.uid),
                              parentSlotMem == WB_PARENT_HUB ? "HUB" : "MOD",
                              parentFace);
            } else {
                Serial.printf("[TOPO] memory stale uid=%s — face busy by another live module, forgetting\n",
                              uidHex(msg.uid));
                removeTopoEntry(msg.uid);
            }
        } else if (mem->parentUid != 0 && parentSlotMem == 0xFF) {
            // Parent UID known but parent itself hasn't re-registered yet.
            // Defer this HELLO — keepalive will retry; by the time the
            // parent comes back we can bind the child correctly.
            Serial.printf("[TOPO] defer uid=%s — parent uid=%08lX not yet registered\n",
                          uidHex(msg.uid), (unsigned long)mem->parentUid);
            return;
        }
    }

    if (!fromMemory) {
        attachIdx = peekBindableAttach(msg.uid, parentSlot, parentFace);
        if (attachIdx < 0) {
            Serial.printf("[HELLO] orphan uid=%s (no bindable attach) — dropping\n",
                          uidHex(msg.uid));
            return;
        }
        // Ambiguity log: more than one attach active when this HELLO
        // landed → our FIFO pick may have been wrong. We still bind
        // (a strict refuse-to-bind policy would break first-boot when
        // boot HELLO and hand insertion overlap) but flag it so the
        // misbinding is at least visible in logs. The next time hub
        // sees this UID after a reboot, topology memory will fix it.
        uint8_t pendingNow = countActivePendingAttaches();
        if (pendingNow > 1) {
            Serial.printf("[ATT] ambiguous HELLO uid=%s pending=%d\n",
                          uidHex(msg.uid), pendingNow);
        }
    }

    // peekBindableAttach already proved the face is bindable; ensureFaceFree
    // here only does the DETACHED eviction (with its $U). A failure means
    // the registry mutated between peek and ensure — defensive bail.
    if (!registry.ensureFaceFree(parentSlot, parentFace, msg.uid, onSlotRemoved)) {
        Serial.printf("[HELLO] uid=%s — face state changed under us (attach kept)\n",
                      uidHex(msg.uid));
        return;
    }

    uint8_t newSlot = registry.nextFreeSlot();
    if (newSlot == 0xFF) newSlot = registry.evictOldestDetached(onSlotRemoved);
    if (newSlot == 0xFF) {
        Serial.printf("[HELLO] no free slot for uid=%s — dropping (attach kept)\n",
                      uidHex(msg.uid));
        return;
    }

    if (!fromMemory) commitAttach(attachIdx);
    registry.addPending(msg.uid, newSlot, msg.fwHash, parentSlot, parentFace);
    protocol.sendAck(newSlot, msg.uid, /*descriptorCached=*/false);
    protocol.requestDescriptor(newSlot);

    out.printf("$H,%s,,", uidHex(msg.uid));
    printParentLabel(out, parentSlot); out.printf(",%d\n", parentFace);
    emitModuleIdentity(out, registry.getModule(newSlot));
}

void onModuleDescriptor(uint8_t sourceSlot, const WearBlocksDescriptor& desc) {
    if (!registry.registerDescriptor(sourceSlot, desc)) {
        Serial.printf("[DESC] slot %d: register failed (state mismatch)\n", sourceSlot);
        return;
    }
    const RegisteredModule* m = registry.getModule(sourceSlot);
    if (!m) return;
    out.printf("$D,%s,%s\n", uidHex(m->uid), desc.toJSON().c_str());
    emitModuleIdentity(out, m);

    // Persist the binding so a future hub-only reboot can recover this
    // module's location without depending on FIFO attach ordering.
    // parentUid 0 means parent is HUB; otherwise look up the parent's
    // UID via its slot.
    uint32_t parentUid = 0;
    if (m->parentSlot != WB_PARENT_HUB) {
        const RegisteredModule* p = registry.getModule(m->parentSlot);
        if (p) parentUid = p->uid;
    }
    updateTopoEntry(m->uid, parentUid, m->parentFace);

    // Module is now MODULE_REGISTERED, so the UID resolver will succeed.
    // Re-enable streaming topics for any program references to this UID.
    // Covers both first-time registrations and reattaches that needed a
    // descriptor refresh; the cached-skip reattach path emits this from
    // onModuleHello() instead. No-op when no program is loaded.
    eca.autoEnableTopicsForUid(m->uid);
}

void onSensorData(uint32_t canId, uint8_t channelId,
                  const uint8_t* payload, uint8_t payloadLen) {
    uint8_t slot = (uint8_t)(canId - 0x100);
    if (slot == 0 || slot >= WB_MAX_MODULES) return;
    const RegisteredModule* m = registry.getModule(slot);
    if (!m) return;

    // Strict policy: only forward sensor data from REGISTERED modules.
    // PENDING means the descriptor handshake hasn't completed (so we
    // don't know what the channel even means yet); DETACHED means the
    // module is physically gone — emitting $S for a detached UID would
    // tell the frontend the module is alive when it isn't.
    if (m->state != MODULE_REGISTERED) return;

    eca.updateSensor(slot, channelId, payload, payloadLen);

    if (payloadLen < 4) return;
    float v;
    memcpy(&v, payload, 4);
    out.printf("$S,%s,%d,%.4f\n", uidHex(m->uid), channelId, v);
    sampleCount++;
}

void onChildEvent(uint8_t parentSlot, uint8_t parentFace, bool occupied) {
    if (parentSlot >= WB_MAX_MODULES || parentFace < 1 || parentFace > 6) return;
    const RegisteredModule* parent = registry.getModule(parentSlot);
    if (!parent) return;

    if (occupied) {
        // Idempotent path: if a child is already REGISTERED at this
        // (parent, face), the CHILD_EVENT is a keepalive — nothing to
        // do. We deliberately do NOT short-circuit when the existing
        // child is DETACHED (8s TTL after unplug, slot mapping kept) or
        // PENDING (child's HELLO not yet arrived), because in both of
        // those states a fresh attach signal is exactly what's needed
        // to bring the child back / complete its handshake.
        uint8_t existingChild = registry.findChildSlot(parentSlot, parentFace);
        if (existingChild != 0xFF) {
            const RegisteredModule* m = registry.getModule(existingChild);
            if (m && m->state == MODULE_REGISTERED) return;
        }

        // Keepalive arriving while child's HELLO is still in flight, or
        // a brand-new docking. enqueueAttach() dedups (kind, parent, face)
        // and refreshes the timestamp on a repeat, so attachQueue stays
        // tidy. Print $C,PENDING only on the first event so the WS
        // clients don't see a flicker stream.
        bool alreadyPending = false;
        for (uint8_t i = 0; i < PENDING_ATTACH_MAX; i++) {
            const PendingAttach& e = attachQueue[i];
            if (e.active && e.kind == ATTACH_MODULE_CHILD &&
                e.parentSlot == parentSlot && e.parentFace == parentFace) {
                alreadyPending = true;
                break;
            }
        }
        enqueueAttach(ATTACH_MODULE_CHILD, 0, parentSlot, parentFace);
        if (!alreadyPending) {
            out.printf("$C,%s,PENDING,%d\n", uidHex(parent->uid), parentFace);
        }
    } else {
        pruneAttach(ATTACH_MODULE_CHILD, 0, parentSlot, parentFace);
        uint8_t childSlot = registry.findChildSlot(parentSlot, parentFace);
        if (childSlot != 0xFF) {
            const RegisteredModule* child = registry.getModule(childSlot);
            uint32_t cuid = child ? child->uid : 0;
            // Cascade: mark the whole subtree under childSlot as DETACHED.
            // onSlotDetached emits $X per affected UID, leaf-first, so a
            // 3-layer stack pull surfaces grandchild $X then child $X then
            // root $X to the frontend. Old code only detached the direct
            // child, leaving grandchildren stuck as REGISTERED under a
            // DETACHED parent.
            registry.markSubtreeDetached(childSlot, millis(), onSlotDetached);
            char parentUid[9];
            char childUid[9];
            formatUidHex(parent->uid, parentUid, sizeof(parentUid));
            formatUidHex(cuid, childUid, sizeof(childUid));
            out.printf("$c,%s,%s,%d\n", parentUid, childUid, parentFace);
        } else {
            out.printf("$c,%s,PENDING,%d\n", uidHex(parent->uid), parentFace);
        }
    }
}

// ── Face debounce driver ──────────────────────────────────────
void onFaceBecameOccupied(uint8_t face) {
    Serial.printf("[FACE] F%d occupied\n", face);
    enqueueAttach(ATTACH_HUB_FACE, face, 0, 0);
}

void onFaceBecameEmpty(uint8_t face) {
    Serial.printf("[FACE] F%d empty\n", face);
    pruneAttach(ATTACH_HUB_FACE, face, 0, 0);

    // Any module whose parent is (HUB, face) is now physically gone.
    // Cascade subtree detach so any descendants of that root also get
    // marked DETACHED + emit $X. A hub face holds at most one direct
    // child, so we break after the first match.
    for (uint8_t s = 1; s < WB_MAX_MODULES; s++) {
        const RegisteredModule* m = registry.getModule(s);
        if (!m) continue;
        if (m->parentSlot != WB_PARENT_HUB || m->parentFace != face) continue;
        if (m->state == MODULE_DETACHED) break;
        registry.markSubtreeDetached(s, millis(), onSlotDetached);
        break;
    }
}

void trackFaceSample(uint8_t face, bool occupied) {
    FaceTrack& t = faceTracks[face - 1];
    if (occupied == t.committedOccupied) { t.streak = 0; return; }
    if (++t.streak < DEBOUNCE_CONSECUTIVE) return;
    t.committedOccupied = occupied;
    t.streak = 0;
    if (occupied) onFaceBecameOccupied(face);
    else          onFaceBecameEmpty(face);
}

// ── Serial command parsing ────────────────────────────────────
char    serialCmdBuf[2048];
uint8_t serialCmdLen = 0;

void emitStatusSnapshot() {
    // Mirror emitTopology()'s inclusion rule: surface live registry entries
    // (REGISTERED + PENDING), but not DETACHED. Previously requiring only
    // MODULE_REGISTERED hid modules stuck in PENDING (descriptor handshake
    // incomplete), causing no $H/module entry for their children. Including
    // DETACHED would be worse in the other direction: a browser resync would
    // receive $H and clear the frontend's pending-detach marker, reviving a
    // physically removed module during the 8s slot-retention TTL.
    //
    // For PENDING modules we emit $H with an empty moduleId and skip
    // $D; the frontend treats empty id gracefully and the descriptor
    // gets filled in once the registration completes.
    for (uint8_t i = 1; i < WB_MAX_MODULES; i++) {
        const RegisteredModule* m = registry.getModule(i);
        if (!m) continue;                      // MODULE_EMPTY — skip
        if (m->state == MODULE_DETACHED) continue;
        const char* mid = m->hasDescriptor ? m->descriptor.moduleId : "";
        out.printf("$H,%s,%s,", uidHex(m->uid), mid);
        printParentLabel(out, m->parentSlot); out.printf(",%d\n", m->parentFace);
        emitModuleIdentity(out, m);
        if (m->hasDescriptor) {
            out.printf("$D,%s,%s\n", uidHex(m->uid),
                          m->descriptor.toJSON().c_str());
        }
    }
    out.println("$Q,DONE");
}

void emitTopology() {
    for (uint8_t i = 1; i < WB_MAX_MODULES; i++) {
        const RegisteredModule* m = registry.getModule(i);
        if (!m) continue;
        if (m->state == MODULE_DETACHED) continue;
        out.printf("$T,%s,", uidHex(m->uid));
        printParentLabel(out, m->parentSlot); out.printf(",%d\n", m->parentFace);
    }
    out.println("$Q,DONE");
}

// Snapshot the engine + persistence state. Frontend uses $E to render
// "what's running" status; $EB carries the same raw bytecode the host
// originally uploaded so the UI can decode rules without keeping its
// own copy. Format:
//   $E,<running>,<has>,<rules>,<vcs>,<rawLen>,<nvsHas>
//   $EB,<base64>           (only if rawLen > 0)
//   $Q,DONE
void emitEcaSnapshot() {
    out.printf("$E,%d,%d,%u,%u,%u,%d\n",
                  eca.isRunning() ? 1 : 0,
                  eca.hasProgram() ? 1 : 0,
                  (unsigned)eca.getNumRules(),
                  (unsigned)eca.getNumVCs(),
                  (unsigned)eca.getRawLen(),
                  eca.hasStoredProgram() ? 1 : 0);
    if (eca.getRawLen() > 0) {
        // base64 encode the raw bytecode. mbedtls picks ~4/3 inflation;
        // 2048 raw → ≤2732 chars + null. Stack-allocated to avoid heap
        // churn during a query.
        size_t encOutLen = 0;
        unsigned char encBuf[2800];
        int ret = mbedtls_base64_encode(encBuf, sizeof(encBuf), &encOutLen,
                                         eca.getRawProgram(), eca.getRawLen());
        if (ret == 0) {
            out.print("$EB,");
            // Stream in chunks so out.print() doesn't have to allocate
            // a String for the full payload.
            const size_t CHUNK = 256;
            for (size_t off = 0; off < encOutLen; off += CHUNK) {
                size_t n = (encOutLen - off > CHUNK) ? CHUNK : (encOutLen - off);
                out.write(encBuf + off, n);
            }
            out.println();
        } else {
            out.printf("$ERR EB encode_fail ret=%d\n", ret);
        }
    }
    out.println("$Q,DONE");
}

bool handleEcaCommand(const char* cmd, size_t len);

// Resolve "<uidHex>" arg to a slot. Returns 0xFF if not found.
uint8_t resolveUidArg(const char* uidStr) {
    uint32_t uid;
    if (!parseUidHex(uidStr, uid)) return 0xFF;
    return registry.findByUid(uid);
}

void handleSerialCommand(const char* cmd) {
    if (strcmp(cmd, "$Q,STATUS") == 0) { emitStatusSnapshot(); return; }
    if (strcmp(cmd, "$Q,TOPO")   == 0) { emitTopology();       return; }
    if (strcmp(cmd, "$Q,ECA")    == 0) { emitEcaSnapshot();    return; }

    // $Q,FORGET ALL          — wipe entire topology memory + NVS blob
    // $Q,FORGET <uidHex>     — wipe one entry (also flushes NVS now)
    // Use case: user is about to power off the hub and physically
    // rearrange modules. Without this, the next boot would
    // deterministically rebind UIDs to their old faces (since both
    // faces are still occupied, memory wins over FIFO).
    if (strncmp(cmd, "$Q,FORGET", 9) == 0) {
        const char* arg = cmd + 9;
        while (*arg == ' ' || *arg == ',') arg++;
        if (strcmp(arg, "ALL") == 0) {
            bool ok = eraseTopoMemory();
            // erased = NVS blob removed now; deferred = RAM cleared but
            // NVS write failed, retry queued for next 30s flush.
            out.printf("$OK FORGET ALL nvs=%s\n", ok ? "erased" : "deferred");
            return;
        }
        uint32_t uid;
        if (parseUidHex(arg, uid)) {
            removeTopoEntry(uid);
            // Flush immediately rather than wait 30s — the user is
            // explicitly saying "forget this", they want it persisted now.
            // If the write fails, leave topoDirty alone (removeTopoEntry
            // already set it true) so the next 30s flush will retry.
            bool saved = saveTopoMemory();
            if (saved) {
                topoDirty = false;
                topoLastFlushMs = millis();
            }
            out.printf("$OK FORGET %s nvs=%s\n",
                       uidHex(uid), saved ? "saved" : "deferred");
            return;
        }
        out.println("$ERR FORGET expects 'ALL' or 8-char uid");
        return;
    }

    if (handleEcaCommand(cmd, strlen(cmd))) return;

    Serial.printf("[CMD] unknown: %s\n", cmd);
}

bool handleEcaCommand(const char* cmd, size_t len) {
    if (len >= 3 && cmd[0] == '$' && cmd[1] == 'P' && cmd[2] == ' ') {
        const char* b64 = cmd + 3;
        size_t b64Len = len - 3;
        while (b64Len > 0 && (b64[b64Len - 1] == ' ' || b64[b64Len - 1] == '\t')) b64Len--;
        size_t outLen = 0;
        unsigned char decoded[1024];
        int ret = mbedtls_base64_decode(decoded, sizeof(decoded), &outLen,
                                        (const unsigned char*)b64, b64Len);
        if (ret == 0 && outLen > 0) {
            if (eca.loadProgram(decoded, outLen)) {
                eca.autoEnableTopics();
                eca.runProgram();
                bool saved = eca.saveToNVS();
                out.printf("$OK P loaded+running (%u bytes) nvs=%s\n",
                              (unsigned)outLen, saved ? "saved" : "skipped");
            } else {
                out.println("$ERR P parse_fail");
            }
        } else {
            out.printf("$ERR P b64_decode ret=%d\n", ret);
        }
        return true;
    }
    if (strcmp(cmd, "$PR") == 0) { eca.runProgram();   out.println("$OK PR"); return true; }
    if (strcmp(cmd, "$PS") == 0) { eca.stopProgram();  out.println("$OK PS"); return true; }
    if (strcmp(cmd, "$PC") == 0) {
        // $PC = clear runtime AND wipe NVS — "forget the current program
        // entirely". Use $PS then $PE if you need to stop without losing
        // the persisted bytecode.
        eca.clearProgram();
        eca.eraseFromNVS();
        out.println("$OK PC");
        return true;
    }
    if (strcmp(cmd, "$PE") == 0) {
        // $PE = erase persisted bytecode only; runtime keeps running.
        // Useful for "play once, don't auto-run on next boot."
        bool ok = eca.eraseFromNVS();
        out.printf("$OK PE %s\n", ok ? "erased" : "noop");
        return true;
    }

    if (strncmp(cmd, "$A ", 3) == 0) {
        const char* p = cmd + 3;
        while (*p == ' ') p++;
        uint8_t slot = resolveUidArg(p);
        if (slot == 0xFF) { out.println("$ERR A bad_uid"); return true; }
        while (*p && *p != ' ') p++;
        while (*p == ' ') p++;
        int parts[10];
        int count = 0;
        while (*p && count < 10) {
            parts[count++] = atoi(p);
            while (*p && *p != ' ') p++;
            while (*p == ' ') p++;
        }
        if (count >= 1) {
            uint8_t c = (uint8_t)parts[0];
            uint8_t params[10] = {};
            int paramCount = count - 1;
            if (paramCount > 10) paramCount = 10;
            for (int i = 0; i < paramCount; i++) params[i] = (uint8_t)parts[i + 1];
            protocol.sendActuatorCommand(slot, c, params, (uint8_t)paramCount);
            out.printf("$OK A slot=%d cmd=%d\n", slot, c);
        }
        return true;
    }

    if ((strncmp(cmd, "$TE ", 4) == 0 || strncmp(cmd, "$TD ", 4) == 0)) {
        bool enable = (cmd[2] == 'E');
        const char* p = cmd + 4;
        while (*p == ' ') p++;
        uint8_t slot = resolveUidArg(p);
        if (slot == 0xFF) { out.println("$ERR T bad_uid"); return true; }
        while (*p && *p != ' ') p++;
        while (*p == ' ') p++;
        if (!*p) return true;
        int ch = atoi(p);
        if (enable) protocol.sendTopicEnable(slot, (uint8_t)ch);
        else        protocol.sendTopicDisable(slot, (uint8_t)ch);
        out.printf("$OK T%c slot=%d ch=%d\n", enable ? 'E' : 'D', slot, ch);
        return true;
    }

    if (strncmp(cmd, "$TA ", 4) == 0) {
        const char* p = cmd + 4;
        while (*p == ' ') p++;
        uint8_t slot = resolveUidArg(p);
        if (slot == 0xFF) { out.println("$ERR TA bad_uid"); return true; }
        protocol.sendTopicEnableAll(slot);
        out.printf("$OK TA slot=%d\n", slot);
        return true;
    }

    return false;
}

void processSerialCommands() {
    while (Serial.available()) {
        char c = Serial.read();
        if (c == '\n' || c == '\r') {
            if (serialCmdLen > 0) {
                serialCmdBuf[serialCmdLen] = '\0';
                handleSerialCommand(serialCmdBuf);
                serialCmdLen = 0;
            }
        } else if (serialCmdLen < sizeof(serialCmdBuf) - 1) {
            serialCmdBuf[serialCmdLen++] = c;
        }
    }
}

// Registry emit hooks. The registry calls these once per affected UID
// during cascaded subtree ops; leaf-first so the frontend sees children
// fall before parents.
//   onSlotDetached -> $X (slot held for TTL, may come back)
//   onSlotRemoved  -> $U (slot is gone, UID won't be referenced again)
void onSlotDetached(uint32_t uid) {
    out.printf("$X,%s\n", uidHex(uid));
}
void onSlotRemoved(uint32_t uid) {
    out.printf("$U,%s\n", uidHex(uid));
    // A remove is the only signal that this UID is "gone for good"
    // (TTL reap, evict, ensureFaceFree's stale-DETACHED cleanup all
    // funnel through here). Drop its memory entry so it doesn't override
    // a future attach to that face.
    removeTopoEntry(uid);
}
void onPendingSlotRemoved(uint32_t uid) {
    // Descriptor handshake failure means the registry slot is unusable, but
    // not that the physical module is gone. Preserve topology memory so the
    // module's next keepalive HELLO can recover from hub reboot / lost
    // descriptor traffic without falling back to ambiguous FIFO binding.
    out.printf("$U,%s\n", uidHex(uid));
}

// ── BLE peripheral implementation ─────────────────────────────
//
// Inbound writes on the RX characteristic feed bytes into a separate command
// buffer, then enqueue complete commands for the main loop. The callback must
// stay lightweight: commands like $Q,ECA can touch NVS, encode bytecode, and
// emit many BLE notifications, all of which belong in the normal Arduino loop
// context rather than the NimBLE host callback.
static char    g_bleCmdBuf[2048];
static uint16_t g_bleCmdLen = 0;
static constexpr uint8_t BLE_CMD_QUEUE_DEPTH = 4;
static char     g_bleCmdQueue[BLE_CMD_QUEUE_DEPTH][sizeof(g_bleCmdBuf)];
static volatile uint8_t g_bleCmdHead = 0;
static volatile uint8_t g_bleCmdTail = 0;
static volatile uint8_t g_bleCmdCount = 0;
static volatile uint16_t g_bleCmdDropped = 0;
static portMUX_TYPE g_bleCmdMux = portMUX_INITIALIZER_UNLOCKED;

static bool enqueueBleCommand(const char* cmd) {
    if (!cmd || !cmd[0]) return true;
    portENTER_CRITICAL(&g_bleCmdMux);
    if (g_bleCmdCount >= BLE_CMD_QUEUE_DEPTH) {
        g_bleCmdDropped++;
        portEXIT_CRITICAL(&g_bleCmdMux);
        return false;
    }
    uint8_t slot = g_bleCmdTail;
    strncpy(g_bleCmdQueue[slot], cmd, sizeof(g_bleCmdQueue[slot]) - 1);
    g_bleCmdQueue[slot][sizeof(g_bleCmdQueue[slot]) - 1] = '\0';
    g_bleCmdTail = (uint8_t)((g_bleCmdTail + 1) % BLE_CMD_QUEUE_DEPTH);
    g_bleCmdCount++;
    portEXIT_CRITICAL(&g_bleCmdMux);
    return true;
}

static bool dequeueBleCommand(char* out, size_t outLen) {
    if (!out || outLen == 0) return false;
    portENTER_CRITICAL(&g_bleCmdMux);
    if (g_bleCmdCount == 0) {
        portEXIT_CRITICAL(&g_bleCmdMux);
        return false;
    }
    uint8_t slot = g_bleCmdHead;
    strncpy(out, g_bleCmdQueue[slot], outLen - 1);
    out[outLen - 1] = '\0';
    g_bleCmdHead = (uint8_t)((g_bleCmdHead + 1) % BLE_CMD_QUEUE_DEPTH);
    g_bleCmdCount--;
    portEXIT_CRITICAL(&g_bleCmdMux);
    return true;
}

static uint16_t takeBleCommandDrops() {
    portENTER_CRITICAL(&g_bleCmdMux);
    uint16_t dropped = g_bleCmdDropped;
    g_bleCmdDropped = 0;
    portEXIT_CRITICAL(&g_bleCmdMux);
    return dropped;
}

static void resetBleCommandState() {
    portENTER_CRITICAL(&g_bleCmdMux);
    g_bleCmdHead = 0;
    g_bleCmdTail = 0;
    g_bleCmdCount = 0;
    g_bleCmdDropped = 0;
    portEXIT_CRITICAL(&g_bleCmdMux);
    g_bleCmdLen = 0;
}

class HubServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* s, NimBLEConnInfo& connInfo) override {
        g_bleClientConnected = true;
        Serial.println("[BLE] central connected");
    }
    void onDisconnect(NimBLEServer* s, NimBLEConnInfo& connInfo, int reason) override {
        g_bleClientConnected = false;
        resetBleCommandState();
        Serial.println("[BLE] central disconnected — re-advertising");
        NimBLEDevice::startAdvertising();
    }
};

class HubRxCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& connInfo) override {
        const NimBLEAttValue& v = c->getValue();
        const uint8_t* data = v.data();
        for (size_t i = 0; i < v.size(); i++) {
            char ch = (char)data[i];
            if (ch == '\n' || ch == '\r') {
                if (g_bleCmdLen > 0) {
                    g_bleCmdBuf[g_bleCmdLen] = '\0';
                    enqueueBleCommand(g_bleCmdBuf);
                    g_bleCmdLen = 0;
                }
            } else if (g_bleCmdLen < sizeof(g_bleCmdBuf) - 1) {
                g_bleCmdBuf[g_bleCmdLen++] = ch;
            }
        }
    }
};

static void bleNotifyLine(const char* line, size_t len) {
    if (!g_bleClientConnected || g_bleTxChar == nullptr || len == 0) return;
    // Chunk so each notify fits under the negotiated MTU minus 3 bytes
    // ATT overhead. We requested MTU 247, so ≤200 is comfortable on any
    // central that successfully completed MTU exchange.
    constexpr size_t CHUNK = 200;
    for (size_t off = 0; off < len; off += CHUNK) {
        size_t n = (len - off > CHUNK) ? CHUNK : (len - off);
        g_bleTxChar->setValue((const uint8_t*)(line + off), n);
        g_bleTxChar->notify();
    }
}

static void bleSetup() {
    uint64_t mac = ESP.getEfuseMac();
    uint16_t shortId = (uint16_t)(((mac >> 32) ^ mac) & 0xFFFF);
    snprintf(g_bleAdvName, sizeof(g_bleAdvName), "HEX-%04X",
             (unsigned)shortId);

    NimBLEDevice::init(g_bleAdvName);
    NimBLEDevice::setMTU(247);

    NimBLEServer* server = NimBLEDevice::createServer();
    server->setCallbacks(new HubServerCallbacks());

    NimBLEService* svc = server->createService(NUS_SERVICE_UUID);
    g_bleTxChar = svc->createCharacteristic(
        NUS_TX_CHAR_UUID, NIMBLE_PROPERTY::NOTIFY);
    g_bleRxChar = svc->createCharacteristic(
        NUS_RX_CHAR_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
    g_bleRxChar->setCallbacks(new HubRxCallbacks());
    svc->start();

    NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
    adv->addServiceUUID(NUS_SERVICE_UUID);
    adv->setName(g_bleAdvName);
    adv->enableScanResponse(true);
    adv->start();

    Serial.printf("[OK] BLE peripheral up: %s\n", g_bleAdvName);
}

void processBleCommands() {
    uint16_t dropped = takeBleCommandDrops();
    if (dropped > 0) {
        Serial.printf("[BLE] dropped %u queued command(s)\n", (unsigned)dropped);
    }

    char cmd[sizeof(g_bleCmdBuf)];
    while (dequeueBleCommand(cmd, sizeof(cmd))) {
        handleSerialCommand(cmd);
    }
}

// ── Setup ─────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println();
    Serial.println("========================================");
    Serial.println("  WearBlocks Hub v2 (UID-keyed)");
    Serial.println("========================================");

    if (STATUS_LED != 255) {
        pinMode(STATUS_LED, OUTPUT);
        digitalWrite(STATUS_LED, HIGH);
    }

    if (!can.begin(CAN_TX_PIN, CAN_RX_PIN)) {
        Serial.println("[FAIL] CAN init failed!");
        while (1) delay(1000);
    }
    Serial.printf("[OK] CAN: TX=GPIO%d RX=GPIO%d @500kbps\n", CAN_TX_PIN, CAN_RX_PIN);

    bleSetup();

    Serial.print("[OK] Face pins:");
    for (uint8_t i = 0; i < 6; i++) {
        pinMode(FACE_PIN[i], INPUT_PULLUP);
        Serial.printf(" F%d=GPIO%d", i + 1, FACE_PIN[i]);
    }
    Serial.println();

    delay(20);
    for (uint8_t i = 0; i < 6; i++) {
        bool occ = (digitalRead(FACE_PIN[i]) == LOW);
        faceTracks[i].committedOccupied = occ;
        if (occ) {
            enqueueAttach(ATTACH_HUB_FACE, i + 1, 0, 0);
            Serial.printf("  F%d initial: OCCUPIED (queued)\n", i + 1);
        }
    }

    protocol.begin(can, true);
    protocol.onHello(onModuleHello);
    protocol.onDescriptorReceived(onModuleDescriptor);
    protocol.onSensorData(onSensorData);
    protocol.onChildEvent(onChildEvent);

    eca.begin(protocol);
    // Wire ECA's UID→slot lookup to the registry so v3 bytecode (which
    // carries module UIDs, not slots) can resolve refs at execute time.
    eca.setUidResolver([](uint32_t uid) -> uint8_t {
        // Only REGISTERED modules resolve to a usable slot. DETACHED and
        // PENDING entries are retained in the registry for descriptor /
        // workspace continuity, but runtime reads/writes resolve to the
        // unavailable sentinel (slot 0 → NaN via WearBlocksECA::resolveRef).
        uint8_t slot = registry.findByUid(uid);
        if (slot == 0xFF) return 0;
        const RegisteredModule* m = registry.getModule(slot);
        if (!m || m->state != MODULE_REGISTERED) return 0;
        return slot;
    });

    if (STATUS_LED != 255) digitalWrite(STATUS_LED, LOW);
    statsStart = millis();

    // Load remembered topology bindings before the first HELLO arrives,
    // so onModuleHello's memory-hit path can resolve UIDs that powered
    // through the hub reboot.
    loadTopoMemory();
    topoLastFlushMs = millis();

    // Restore any persisted ECA program from NVS and auto-run it. This
    // is what makes the hub usable untethered: a program loaded once via
    // $P comes back automatically after reboot/power-loss, with no host
    // connection required. autoEnableTopics() is called so the modules
    // it references start streaming again as they re-register over CAN.
    if (eca.loadFromNVS()) {
        eca.autoEnableTopics();
        eca.runProgram();
        out.println("$OK P restored_from_nvs");
    }

    Serial.println("[WAIT] Listening for HELLO...");
}

// ── Loop ──────────────────────────────────────────────────────
void loop() {
    processSerialCommands();
    processBleCommands();
    protocol.processIncoming();
    eca.tick();

    uint32_t now = millis();

    // Round-robin one face per tick (6 faces in 120 ms).
    if (now - lastFaceScan >= FACE_SCAN_TICK) {
        lastFaceScan = now;
        static uint8_t cursor = 0;
        bool occ = (digitalRead(FACE_PIN[cursor]) == LOW);
        trackFaceSample(cursor + 1, occ);
        cursor = (cursor + 1) % 6;
    }

    registry.reapDetached(now, DETACH_TTL_MS, onSlotRemoved);
    reapAttachQueue(now);

    // Throttled flush of topology memory to NVS. Mutations only set
    // topoDirty; this is the single point that actually writes flash,
    // bounding wear at one write per TOPO_FLUSH_MS even under continuous
    // reseat. A hub crash within the window forfeits the most recent
    // bindings, which degrades to FIFO behavior.
    if (topoDirty && now - topoLastFlushMs >= TOPO_FLUSH_MS) {
        topoLastFlushMs = now;
        if (saveTopoMemory()) {
            topoDirty = false;
            Serial.println("[TOPO] flushed memory to NVS");
        }
    }

    // Hub-face attach keepalive. Re-enqueue an ATTACH_HUB_FACE entry for
    // every committed-occupied hub face that does NOT currently hold a
    // REGISTERED module. enqueueAttach dedups by (kind, hubFace) and
    // refreshes the timestamp on the existing entry, so this is cheap.
    // Without this, two failure modes break "hub reboots, modules stay
    // powered":
    //   1. After hub reboot, setup() enqueues each occupied face exactly
    //      once. PENDING_ATTACH_TTL_MS expires before the module's next
    //      7s keepalive HELLO, so the HELLO becomes orphan-dropped.
    //   2. After PENDING reap (descriptor handshake failed 10x), the
    //      face stays occupied — no new GPIO edge — but the registry
    //      entry is gone. Without re-enqueue, the next HELLO is orphan.
    //
    // Skipping REGISTERED-occupied faces is critical: otherwise a stale
    // attach for an already-bound face sits at the head of the FIFO and
    // blocks every other module's unknown HELLO from finding its real
    // attach (head-of-line blocking, made worse by attach-kept-on-fail).
    // PENDING / DETACHED occupants don't block — those modules may have
    // gone away and the face is genuinely available for re-binding.
    static uint32_t lastFaceKeepalive = 0;
    if (now - lastFaceKeepalive >= HUB_FACE_KEEPALIVE_MS) {
        lastFaceKeepalive = now;
        for (uint8_t f = 0; f < 6; f++) {
            if (!faceTracks[f].committedOccupied) continue;
            uint8_t occ = registry.findChildSlot(WB_PARENT_HUB, f + 1);
            if (occ != 0xFF) {
                const RegisteredModule* m = registry.getModule(occ);
                if (m && m->state == MODULE_REGISTERED) continue;
            }
            enqueueAttach(ATTACH_HUB_FACE, f + 1, 0, 0);
        }
    }

    // Re-poke any module stuck in PENDING. If the original descriptor
    // request or the module's reply was lost on the bus, retry every
    // PENDING_RETRY_MS — but bail after PENDING_RETRY_MAX so a wedged
    // module doesn't squat on a slot forever. removeSubtree fires
    // onPendingSlotRemoved → $U so the frontend stops showing the ghost
    // while keeping topology memory for the module's next HELLO.
    static uint32_t lastPendingScan = 0;
    const uint32_t PENDING_RETRY_MS  = 2000;
    const uint8_t  PENDING_RETRY_MAX = 10;   // ~20s at 2s cadence
    if (now - lastPendingScan >= PENDING_RETRY_MS) {
        lastPendingScan = now;
        for (uint8_t i = 1; i < WB_MAX_MODULES; i++) {
            const RegisteredModule* m = registry.getModule(i);
            if (!m || m->state != MODULE_PENDING) continue;
            uint8_t tries = registry.bumpPendingRetries(i);
            if (tries >= PENDING_RETRY_MAX) {
                Serial.printf("[REG] giving up on PENDING slot=%d uid=%08lX (%d retries)\n",
                              i, (unsigned long)m->uid, tries);
                registry.removeSubtree(i, onPendingSlotRemoved);
            } else {
                Serial.printf("[REG] retry descriptor: slot=%d uid=%08lX try=%d\n",
                              i, (unsigned long)m->uid, tries);
                protocol.requestDescriptor(i);
            }
        }
    }

    if (now - statsStart >= STATS_INTERVAL) {
        if (registry.getModuleCount() > 0) {
            float elapsed = (now - statsStart) / 1000.0f;
            float hz = (elapsed > 0) ? sampleCount / elapsed : 0;
            Serial.printf("[STATS] samples=%lu %.1fHz modules=%d\n",
                          sampleCount, hz, registry.getModuleCount());
        }
        sampleCount = 0;
        statsStart = now;
    }

    protocol.sendHeartbeat();
    delay(1);
}
