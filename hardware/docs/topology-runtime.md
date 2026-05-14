# Firmware Topology Runtime

Status: current firmware behavior as of 2026-05-08.

This note documents the hub/module topology rules implemented in firmware.

## Identity Model

- `uid` is the stable external identity for a physical module.
- `slot` is a hub-local CAN address alias. It can change across hub resets and
  should not be used as durable identity outside the hub firmware.
- `fwHash` is a descriptor cache key. When a known UID sends HELLO with the same
  `fwHash`, the hub can ACK it as cached. When the hash changes, the hub keeps
  the module registered but requests a fresh descriptor.

## Registry Invariants

The hub keeps these invariants after attach, detach, rebind, and reap:

- One `(parentSlot, parentFace)` has at most one logical occupant.
- Removing a parent removes the whole subtree, leaf first.
- Detaching a parent detaches the whole subtree, leaf first.
- Replacing a stale `DETACHED` occupant emits `$U,<oldUid>` before accepting the
  new UID on that face.
- `$Q,STATUS` and `$Q,TOPO` surface `REGISTERED` and `PENDING` modules, but skip
  `DETACHED` modules so a browser resync does not revive a module during the
  detach TTL.

## HELLO Matching

The hub always looks up UID before consuming an attach candidate.

- Known `REGISTERED` UID: treat HELLO as keepalive / duplicate. Re-ACK only and
  never consume an attach event.
- Known `PENDING` UID: re-ACK and re-request descriptor. The existing binding is
  preserved.
- Known `DETACHED` UID: consume a bindable attach candidate, rebind if needed,
  reattach, and emit `$H` or `$F`.
- Unknown UID: first try topology memory, then fall back to the bindable attach
  queue. If more than one attach candidate is active, the hub still binds but
  logs `[ATT] ambiguous HELLO ...` because FIFO cannot prove physical identity.

## Topology Memory

The hub stores remembered bindings in NVS as:

```text
uid -> parentUid, parentFace
```

`parentUid == 0` means the parent is the hub. Memory is updated when a module
registers or reattaches, and flushed to NVS at most once every 30 seconds.

Topology memory is used mainly for hub-only reboot recovery. If modules remain
powered while the hub reboots, multiple occupied faces may appear at the same
time. FIFO attach order cannot reliably map those HELLOs back to faces, so the
hub trusts a remembered binding when:

- the parent is available,
- the remembered hub face is physically occupied, and
- the remembered face is not held by another live module.

If a remembered face is busy with another live UID, the entry is treated as
stale, forgotten, and the HELLO falls back to the attach queue.

## Manual Forget Command

Use these commands before an offline physical rearrange:

```text
$Q,FORGET ALL
$Q,FORGET <uidHex>
```

`$Q,FORGET ALL` clears in-RAM topology memory and removes the NVS blob. If NVS
erase fails, the hub reports `nvs=deferred` and retries by flushing an all-zero
table later.

`$Q,FORGET <uidHex>` removes one remembered binding and flushes immediately when
possible.

## Recovery Loops

- Modules send fast HELLO retries before ACK and a low-frequency keepalive HELLO
  after registration.
- The hub periodically re-enqueues occupied hub faces that do not currently hold
  a `REGISTERED` module. This lets hub reboot recovery and PENDING timeout
  recovery work without physically unplugging and replugging a module.
- PENDING modules retry descriptor requests. After the retry cap, the hub emits
  `$U,<uid>` and removes the slot, but preserves topology memory because a
  descriptor timeout does not prove the physical module is gone.
- Sensor data is forwarded only from `REGISTERED` modules. `PENDING` and
  `DETACHED` slots are ignored.

## Known Limitation

Without an external information source, firmware cannot perfectly identify
simultaneous physical rearranges. The current system has no per-face electrical
identity, per-port challenge, or user confirmation step.

Examples that remain ambiguous:

- two unknown modules are inserted at nearly the same time,
- two `DETACHED` known modules are reseated at nearly the same time,
- modules are rearranged while the hub is off and topology memory was not
  cleared first.

For reliable behavior during rearrangement, insert/reseat one module at a time
or run `$Q,FORGET ALL` before powering down and changing the layout.
