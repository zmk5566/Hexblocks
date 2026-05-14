#ifndef MODULE_REGISTRY_H
#define MODULE_REGISTRY_H

#include <Arduino.h>
#include <WearBlocksDescriptor.h>
#include <WearBlocksProtocol.h>

#define WB_MAX_MODULES 12
#define WB_NUM_FACES 6
#define WB_PARENT_HUB 0xFF

enum ModuleState : uint8_t {
    MODULE_EMPTY = 0,        // slot free for any UID
    MODULE_PENDING,          // ACK sent, waiting for descriptor
    MODULE_REGISTERED,       // descriptor received, streaming
    MODULE_DETACHED,         // physically gone, slot held for 8s TTL
};

struct RegisteredModule {
    ModuleState state;
    uint8_t  slot;
    uint32_t uid;             // stable identity (efuse MAC low 32)
    uint16_t fwHash;          // descriptor cache key
    uint8_t  parentSlot;      // WB_PARENT_HUB or 0..WB_MAX_MODULES-1
    uint8_t  parentFace;      // 1..6 on parent (hub or module)
    WearBlocksDescriptor descriptor;
    bool     hasDescriptor;
    uint32_t lastSeenMs;
    uint32_t detachedAtMs;
    uint8_t  pendingRetries;  // PENDING-state descriptor request retries
};

class ModuleRegistry {
public:
    // Emit callbacks. Two flavors so the hub can distinguish "module went
    // physically absent but slot is held for TTL" ($X) from "slot is gone
    // entirely and the UID will never be referenced again" ($U). Cascaded
    // operations call these once per affected UID, leaf-first, so the
    // frontend sees children fall before parents.
    typedef void (*OnDetachedCb)(uint32_t uid);     // -> $X,<uid>
    typedef void (*OnRemovedCb) (uint32_t uid);     // -> $U,<uid>
    // Backward-compat alias: old reapDetached signature accepted ReapCb,
    // which is semantically identical to OnRemovedCb.
    typedef OnRemovedCb ReapCb;

    ModuleRegistry();

    // Lookups.
    uint8_t findByUid(uint32_t uid) const;          // returns slot or 0xFF
    uint8_t findChildSlot(uint8_t parentSlot, uint8_t parentFace) const;
    const RegisteredModule* getModule(uint8_t slot) const;
    uint8_t getModuleCount() const;                 // REGISTERED only
    uint8_t nextFreeSlot() const;                   // EMPTY slot or 0xFF
    // Evict the oldest DETACHED slot to free space for a new pending
    // module. Cascades through removeSubtree() so any DETACHED descendants
    // of the evictee are also removed; onRemoved fires once per UID.
    // Returns evicted root slot or 0xFF.
    uint8_t evictOldestDetached(OnRemovedCb onRemoved);

    // Mutations.
    void addPending(uint32_t uid, uint8_t slot, uint16_t fwHash,
                    uint8_t parentSlot, uint8_t parentFace);
    void markDescriptorPending(uint8_t slot, uint16_t fwHash);
    bool registerDescriptor(uint8_t slot, const WearBlocksDescriptor& desc);
    bool rebind(uint8_t slot, uint8_t newParentSlot, uint8_t newParentFace);
    void markDetached(uint8_t slot, uint32_t now);
    void markReattached(uint8_t slot, uint32_t now);
    void removeModule(uint8_t slot);

    // Subtree-aware ops. markSubtreeDetached marks the given slot AND every
    // descendant DETACHED, leaf-first, calling onDetached(uid) for each
    // node that wasn't already DETACHED. removeSubtree wipes the subtree
    // entirely and calls onRemoved(uid) for each non-EMPTY node, leaf-first.
    void markSubtreeDetached(uint8_t rootSlot, uint32_t now, OnDetachedCb onDetached);
    void removeSubtree(uint8_t rootSlot, OnRemovedCb onRemoved);

    // Before binding a new occupant to (parentSlot, parentFace): if the
    // face is occupied by a DETACHED module, removeSubtree it first (firing
    // onRemoved per UID). Returns true if the face is now free for
    // exceptUid; returns false if the face is held by a REGISTERED or
    // PENDING module other than exceptUid (caller should refuse the bind).
    bool ensureFaceFree(uint8_t parentSlot, uint8_t parentFace,
                        uint32_t exceptUid, OnRemovedCb onRemoved);

    // Pure query — returns what ensureFaceFree would return without any
    // side effects (no DETACHED removal, no $U emission). Used by
    // peekBindableAttach to skip head-of-line attach entries that point
    // at a live-busy face, without committing a removal that the caller
    // may not actually want yet.
    bool canBindToFace(uint8_t parentSlot, uint8_t parentFace,
                       uint32_t exceptUid) const;

    // PENDING retry counter — hub increments before each descriptor
    // re-request and removes the slot once it hits the cap.
    uint8_t bumpPendingRetries(uint8_t slot);

    // Periodic — release DETACHED slots whose TTL expired. Each TTL hit
    // goes through removeSubtree() so DETACHED descendants of an expired
    // root are reaped together; onRemoved fires once per affected UID.
    uint8_t reapDetached(uint32_t now, uint32_t ttlMs, OnRemovedCb onRemoved);

    // Face label helpers (kept for serial bridge friendly names).
    void setFaceLabel(uint8_t face, const char* label);
    const char* getFaceLabel(uint8_t face) const;

    String toJSON() const;

private:
    RegisteredModule _modules[WB_MAX_MODULES];
    char _faceLabels[WB_NUM_FACES][24];
};

#endif
