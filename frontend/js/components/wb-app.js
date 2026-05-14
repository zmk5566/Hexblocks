/**
 * <wb-app> — Root layout component for WearBlocks companion.
 *
 * Three-column layout with resizable bottom sensor panel area and status bar.
 * Owns the WebSocket connection and dispatches data to children.
 */
import { LitElement, html, css } from 'lit';
import { wsClient } from '../ws-client.js';
import { fieldNameForChannel, loadChannelCatalog } from '../module-channel-map.js';
import './wb-palette.js';
import './wb-module-card.js';
import './wb-sensor-panel.js';
import './wb-status-bar.js';
import './wb-block-canvas.js';
import './wb-debug-console.js';
import './wb-llm-panel.js';
import './wb-devices-panel.js';
import './wb-eca-inspector.js';
import './wb-osc-panel.js';
import { decodeBytecode } from '../eca-decoder.js';

const DEFAULT_MODULE_COLOR = '#888888';

function isDefaultModuleColor(color) {
  if (!color) return true;
  const normalized = String(color).trim().toLowerCase();
  return normalized === '#888' || normalized === DEFAULT_MODULE_COLOR;
}

function mergeModuleColor(prev, incoming) {
  const descriptorColor = prev?.descriptor?.color;
  if (descriptorColor) return descriptorColor;
  if (incoming && (!isDefaultModuleColor(incoming) || isDefaultModuleColor(prev?.color))) {
    return incoming;
  }
  return prev?.color || incoming || DEFAULT_MODULE_COLOR;
}

export class WbApp extends LitElement {
  static properties = {
    _connected:      { type: Boolean, state: true },
    _modules:        { type: Array,   state: true },
    _sensorByUid:    { type: Object,  state: true },
    _openPanels:     { type: Array,   state: true },
    _sampleRate:     { type: Number,  state: true },
    _frameCount:     { type: Number,  state: true },
    _panelHeight:    { type: Number,  state: true },
    _pendingDetach:  { type: Object,  state: true },  // Set<uid|slot>
    _children:       { type: Object,  state: true },  // Map<parentKey, Map<face, childKey>>
    _actuatorByUid:  { type: Object,  state: true },  // Map<uid|slot, {led, vib}>
    _debugOpen:      { type: Boolean, state: true },
    _workspaceRules: { type: Object,  state: true },  // current JSON rules from canvas
    _highlightedUid: { type: String,  state: true },  // uid to highlight in topology
    _devicesOpen:    { type: Boolean, state: true },
    _transport:      { type: Object,  state: true },
    _ecaInspectorOpen: { type: Boolean, state: true },
    _ecaStatus:      { type: Object,  state: true },
    _ecaRules:       { type: Object,  state: true },  // decoded JSON, null if no program
    _oscOpen:        { type: Boolean, state: true },
    _oscActiveCount: { type: Number,  state: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
      background: var(--wb-bg);
      color: var(--wb-text);
      overflow: hidden;
    }

    .main-row {
      display: flex;
      flex: 1;
      min-height: 0;
    }

    /* Left sidebar — palette */
    .sidebar-left {
      width: 240px;
      min-width: 240px;
      border-right: 1px solid var(--wb-border);
      overflow-y: auto;
      background: var(--wb-surface);
    }

    /* Center — block canvas */
    .center {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      background: var(--wb-bg);
    }

    /* Right sidebar — LLM panel */
    .sidebar-right {
      width: 280px;
      min-width: 280px;
      border-left: 1px solid var(--wb-border);
      background: var(--wb-surface);
      display: flex;
      flex-direction: column;
    }

    /* Bottom — sensor panels */
    .resize-handle {
      height: 5px;
      background: var(--wb-border);
      cursor: ns-resize;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    .resize-handle:hover {
      background: var(--wb-accent);
    }

    .bottom-panel {
      display: flex;
      flex-direction: row;
      overflow-x: auto;
      overflow-y: hidden;
      border-top: 1px solid var(--wb-border);
      background: var(--wb-surface);
      flex-shrink: 0;
      width: 100%;
      max-width: 100vw;
    }

    .panel-empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--wb-text-dim);
      font-size: 0.8rem;
      opacity: 0.5;
      min-height: 60px;
    }

    .debug-toggle {
      position: fixed;
      right: 14px;
      bottom: 38px;
      z-index: 999;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 1px solid var(--wb-border);
      background: var(--wb-surface);
      color: var(--wb-text-dim);
      cursor: pointer;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, color 0.15s, transform 0.15s;
    }
    .debug-toggle:hover {
      background: var(--wb-accent);
      color: var(--wb-on-accent);
      transform: scale(1.05);
    }
  `;

  constructor() {
    super();
    this._connected = false;
    this._modules = [];
    this._sensorByUid = new Map();
    this._openPanels = [];
    this._sampleRate = 0;
    this._frameCount = 0;
    this._panelHeight = 200;
    this._pendingDetach = new Set();
    this._children = new Map();
    this._actuatorByUid = new Map();
    this._debugOpen = false;
    this._workspaceRules = null;
    this._highlightedUid = null;
    this._devicesOpen = false;
    this._transport = { transport: null, label: null, connected: false };
    this._ecaInspectorOpen = false;
    this._ecaStatus = null;
    this._ecaRules = null;
    this._lastEcaBytecodeB64 = '';
    this._autoLoadAttempted = false;
    this._workspaceRulesAutoDefault = false;
    this._oscOpen = false;
    this._oscActiveCount = 0;
    // Slot → uid lookup built up as we see hellos; lets us resolve
    // legacy slot-only messages from older bridges / sim paths.
    this._slotToUid = new Map();

    // Topology reconcile buffer. `$T` rows from a $Q,TOPO reply accumulate
    // here; the trailing `query_done(command="TOPO")` flushes them into
    // _children and module.face, replacing whatever drift had crept in.
    // Command annotation matters because an empty TOPO snapshot is meaningful
    // (clear stale UI), while STATUS/ECA DONE messages carry no topology.
    this._topoBuffer = [];

    this._rateTimestamps = [];
    this._onResizeMouseMove = this._onResizeMouseMove.bind(this);
    this._onResizeMouseUp = this._onResizeMouseUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  async connectedCallback() {
    super.connectedCallback();

    // Channel catalog must be loaded before any code that opens a Blockly
    // dropdown (channelsForModule / slotOptions) or asks the LLM panel for
    // its system prompt — both consume CHANNELS_BY_CAP. WS connect happens
    // afterwards so the first hello/descriptor frames don't race the catalog.
    try {
      await loadChannelCatalog();
    } catch (err) {
      console.error('[wb-app] channel_catalog load failed:', err);
    }

    wsClient.onStatus((connected) => {
      this._connected = connected;
    });

    wsClient.onMessage((msg) => this._handleMessage(msg));
    wsClient.connect('ws://localhost:8765');
    window.addEventListener('keydown', this._onKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    wsClient.disconnect();
    window.removeEventListener('mousemove', this._onResizeMouseMove);
    window.removeEventListener('mouseup', this._onResizeMouseUp);
    window.removeEventListener('keydown', this._onKeyDown);
  }

  _onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this._debugOpen = !this._debugOpen;
    }
  }

  _handleMessage(msg) {
    // UID is the authoritative identity in v2. For late-joining legacy
    // messages that only carry slot, we resolve uid via _slotToUid (built
    // up as we see hellos). Rendering components still read mod.slot so
    // this refactor is an internal-only identity change.
    const uid = msg.uid ?? (msg.slot != null ? this._slotToUid.get(msg.slot) : null);

    switch (msg.type) {
      case 'hello': {
        if (uid && msg.slot != null) this._slotToUid.set(msg.slot, uid);
        // The hub face this module sits on, or 0 if it's a stacked
        // child (positioned via _children, not via hub face). The
        // bridge sets `face` correctly post-fix; we still defend here
        // because (a) cached helloes from a pre-fix bridge may carry
        // face=parent_face, and (b) the sim path / future producers
        // shouldn't be required to know the alias semantics.
        let face = msg.face ?? msg.parent_face ?? 0;
        if (msg.parent_is_hub === false) face = 0;
        const existing = uid
          ? this._modules.findIndex(m => m.uid === uid)
          : this._modules.findIndex(m => m.slot === msg.slot);
        const prev = existing >= 0 ? this._modules[existing] : null;
        const mod = {
          uid: uid ?? prev?.uid ?? null,
          id: msg.id,
          face,
          slot: msg.slot,
          color: mergeModuleColor(prev, msg.color),
          name: msg.id,
          capabilities: prev?.capabilities ?? [],
          face_kinds: prev?.face_kinds,
          descriptor: prev?.descriptor,
          firmware_version: prev?.firmware_version ?? '',
          fw_hash: prev?.fw_hash ?? '',
          // Parent metadata — needed by wb-module-card to render the
          // "where" label ("HUB.F3" / "AC20.F5" / "orphan"). Without
          // these the card always falls through to "orphan" because
          // parentFace defaults to 0.
          parent_uid: msg.parent_uid ?? null,
          parent_is_hub: msg.parent_is_hub ?? null,
          parent_face: msg.parent_face ?? 0,
          active: true,
        };
        if (existing >= 0) {
          const updated = [...this._modules];
          updated[existing] = mod;
          this._modules = updated;
        } else {
          this._modules = [...this._modules, mod];
        }
        // Clear pendingDetach for this module — a fresh hello means
        // the module is alive again (re-attached after the brief 8s
        // hub TTL window). Without this, the render() filter would
        // keep hiding the module despite it being re-registered.
        const pendKey = uid ?? msg.slot;
        if (pendKey != null && this._pendingDetach.has(pendKey)) {
          const next = new Set(this._pendingDetach);
          next.delete(pendKey);
          // Also clear by the other identity, in case detach_pending
          // arrived with one and hello with the other.
          if (uid != null && msg.slot != null) {
            next.delete(uid);
            next.delete(msg.slot);
          }
          this._pendingDetach = next;
        }
        // Sync _children directly from the hello — the message already
        // carries the authoritative (parent, face) binding for this
        // module. Without this, a stacked child re-attaching after
        // unplug only gets a transient $C,...,PENDING (which lands as
        // null) followed by $H — but nothing else reasserts the
        // resolved link, so canvas can't find the child until a
        // manual re-sync. We also clear stale child links for this
        // module elsewhere in the tree (it can't be in two places).
        if (uid) {
          const nextChildren = new Map();
          for (const [parent, faceMap] of this._children) {
            const filtered = new Map();
            for (const [face, child] of faceMap) {
              if (child !== uid) filtered.set(face, child);
            }
            if (filtered.size) nextChildren.set(parent, filtered);
          }
          if (msg.parent_is_hub === false && msg.parent_uid != null) {
            const parentFaceMap = new Map(nextChildren.get(msg.parent_uid) || []);
            parentFaceMap.set(msg.parent_face, uid);
            nextChildren.set(msg.parent_uid, parentFaceMap);
          }
          this._children = nextChildren;
        }
        break;
      }
      case 'descriptor': {
        const idx = uid
          ? this._modules.findIndex(m => m.uid === uid)
          : this._modules.findIndex(m => m.slot === msg.slot);
        if (idx >= 0) {
          const updated = [...this._modules];
          const d = msg.data;
          let caps = [];
          if (d.type) caps.push(d.type);
          if (d.caps && Array.isArray(d.caps)) {
            for (const c of d.caps) {
              const modality = c.m || c.modality || '';
              if (modality && !caps.includes(modality)) caps.push(modality);
            }
          }
          updated[idx] = {
            ...updated[idx],
            uid: uid ?? updated[idx].uid,
            name: d.name || d.nm || updated[idx].name,
            capabilities: caps,
            face_kinds: d.face_kinds || updated[idx].face_kinds,
            descriptor: d,
            firmware_version: updated[idx].firmware_version || d.version || d.ver || '',
            // The bridge derives module color from the moduleId at hello
            // time (color_for(mod_id)). When the hello arrived for a
            // module still in PENDING (no descriptor → empty mod_id),
            // bridge fell back to the gray default. The descriptor JSON
            // itself carries the real color, so prefer that over what
            // the placeholder/early-hello set.
            color: d.color || updated[idx].color,
          };
          this._modules = updated;
        }
        break;
      }
      case 'module_info': {
        if (uid == null && msg.slot == null) break;
        const idx = uid
          ? this._modules.findIndex(m => m.uid === uid)
          : this._modules.findIndex(m => m.slot === msg.slot);
        const patch = {
          uid: uid ?? null,
          id: msg.id || '',
          name: msg.id || '(loading)',
          slot: msg.slot ?? null,
          firmware_version: msg.version || '',
          fw_hash: msg.fw_hash || '',
          active: true,
        };
        if (idx >= 0) {
          const updated = [...this._modules];
          updated[idx] = {
            ...updated[idx],
            uid: uid ?? updated[idx].uid,
            id: msg.id || updated[idx].id,
            name: updated[idx].name || msg.id || '(loading)',
            slot: msg.slot ?? updated[idx].slot,
            color: mergeModuleColor(updated[idx], msg.color),
            firmware_version: msg.version || updated[idx].firmware_version || '',
            fw_hash: msg.fw_hash || updated[idx].fw_hash || '',
            active: true,
          };
          this._modules = updated;
        } else {
          this._modules = [...this._modules, {
            ...patch,
            face: 0,
            color: msg.color || DEFAULT_MODULE_COLOR,
            capabilities: [],
            face_kinds: undefined,
            descriptor: undefined,
            parent_uid: null,
            parent_is_hub: null,
            parent_face: 0,
          }];
        }
        const key = uid ?? msg.slot;
        if (key != null && this._pendingDetach.has(key)) {
          const next = new Set(this._pendingDetach);
          next.delete(key);
          if (uid != null) next.delete(uid);
          if (msg.slot != null) next.delete(msg.slot);
          this._pendingDetach = next;
        }
        break;
      }
      case 'sensor': {
        // v2: per-channel frames carry `channel_id` + `value`; legacy
        // batched frames carry `data` with named fields. We consume both
        // shapes into the same sensorData.data map so the sensor panel
        // renders identically.
        if (uid == null && msg.slot == null) break;
        const key = uid ?? `slot:${msg.slot}`;
        const next = new Map(this._sensorByUid);
        const prev = next.get(key) || { uid, slot: msg.slot,
                                          sensor: msg.sensor, data: {} };
        const merged = { ...prev, ts: msg.ts, sensor: msg.sensor || prev.sensor,
                         slot: msg.slot ?? prev.slot, uid: uid ?? prev.uid };
        if (msg.channel_id != null && msg.value != null) {
          // Reverse-lookup field name from the module's channel map.
          const mod = this._findModule(uid, msg.slot);
          const fieldName = fieldNameForChannel(mod, msg.channel_id);
          if (fieldName) {
            merged.data = { ...prev.data, [fieldName]: msg.value };
          }
        } else if (msg.data && typeof msg.data === 'object') {
          merged.data = { ...prev.data, ...msg.data };
        }
        next.set(key, merged);
        this._sensorByUid = next;
        // Rate / frame-count counts one event per (uid, ts) tuple so that
        // per-channel frames from the v2 hub (6 frames at the same ts for
        // one IMU tick) don't over-count vs the legacy batched frame.
        if (!msg.legacy) {
          const fingerprint = `${key}@${msg.ts}`;
          if (this._lastTickFingerprint !== fingerprint) {
            this._lastTickFingerprint = fingerprint;
            this._frameCount++;
            const now = performance.now();
            this._rateTimestamps.push(now);
            if (this._rateTimestamps.length > 50) this._rateTimestamps.shift();
            if (this._rateTimestamps.length >= 2) {
              const span = (this._rateTimestamps[this._rateTimestamps.length - 1]
                           - this._rateTimestamps[0]) / 1000;
              this._sampleRate = Math.round((this._rateTimestamps.length - 1) / span);
            }
          }
        }
        break;
      }
      case 'detach_pending': {
        // v2 $X carries uid only (no face). Mark module as ghosted by uid.
        const key = uid ?? msg.slot;
        if (key == null) break;
        const next = new Set(this._pendingDetach);
        next.add(key);
        this._pendingDetach = next;
        break;
      }
      case 'face_swap': {
        const idx = uid
          ? this._modules.findIndex(m => m.uid === uid)
          : this._modules.findIndex(m => m.slot === msg.slot);
        if (idx >= 0) {
          const updated = [...this._modules];
          // Mirror the hello handler's face semantics: face = hub face,
          // or 0 for a stacked child. parent_uid / parent_face track the
          // authoritative parent binding so wb-module-card can label
          // the relocation correctly instead of falling back to "orphan".
          const newFaceAlias = msg.new_parent_is_hub === false
            ? 0 : (msg.new_face ?? 0);
          updated[idx] = {
            ...updated[idx],
            face: newFaceAlias,
            parent_uid: msg.new_parent_uid ?? null,
            parent_is_hub: msg.new_parent_is_hub ?? null,
            parent_face: msg.new_face ?? 0,
          };
          this._modules = updated;
        }
        // Mirror the hello handler: keep _children in sync with the
        // module's authoritative (parent, face) binding. Drop any
        // stale entry pointing at this uid, then add the new one if
        // the module is now a stacked child.
        if (uid) {
          const nextChildren = new Map();
          for (const [parent, faceMap] of this._children) {
            const filtered = new Map();
            for (const [face, child] of faceMap) {
              if (child !== uid) filtered.set(face, child);
            }
            if (filtered.size) nextChildren.set(parent, filtered);
          }
          if (msg.new_parent_is_hub === false && msg.new_parent_uid != null) {
            const parentFaceMap = new Map(nextChildren.get(msg.new_parent_uid) || []);
            parentFaceMap.set(msg.new_face, uid);
            nextChildren.set(msg.new_parent_uid, parentFaceMap);
          }
          this._children = nextChildren;
        }
        const key = uid ?? msg.slot;
        if (this._pendingDetach.has(key)) {
          const next = new Set(this._pendingDetach);
          next.delete(key);
          this._pendingDetach = next;
        }
        break;
      }
      case 'unplug': {
        const targetUid = uid;
        const targetSlot = msg.slot;
        this._modules = this._modules.filter(m =>
          targetUid ? m.uid !== targetUid : m.slot !== targetSlot);
        const key = targetUid ?? targetSlot;
        if (this._pendingDetach.has(key)) {
          const next = new Set(this._pendingDetach);
          next.delete(key);
          this._pendingDetach = next;
        }
        if (this._sensorByUid.has(key)) {
          const next = new Map(this._sensorByUid);
          next.delete(key);
          this._sensorByUid = next;
        }
        // Drop children keyed by this uid (as parent or child).
        const nextChildren = new Map();
        for (const [parent, faceMap] of this._children) {
          if (parent === key) continue;
          const filtered = new Map();
          for (const [face, child] of faceMap) {
            if (child !== key) filtered.set(face, child);
          }
          if (filtered.size) nextChildren.set(parent, filtered);
        }
        this._children = nextChildren;
        // _openPanels keys are uid (real hw) or slot (sim). Drop any
        // open panel for the unplugged module under either identity.
        this._openPanels = this._openPanels.filter(k =>
          k !== targetUid && k !== targetSlot);
        if (targetSlot != null) this._slotToUid.delete(targetSlot);
        break;
      }
      case 'child_stack': {
        // Prefer UID linkage; fall back to slot when the bridge hasn't
        // yet populated uid (shouldn't happen in v2, but keeps legacy
        // sim frames working during the transition).
        const parentKey = msg.parent_uid ?? msg.parent_slot;
        const childKey  = msg.child_uid ?? msg.child_slot;
        if (parentKey == null) break;
        const next = new Map(this._children);
        const faceMap = new Map(next.get(parentKey) || []);
        const isPending = (msg.pending || childKey == null || childKey === -1);
        if (isPending) {
          // PENDING is "child docked but identity unresolved". Don't
          // downgrade an already-resolved entry — that happens when
          // hub re-emits $C,...,PENDING during a transient (CAN
          // BUS_OFF recovery, brief PENDING window after re-attach,
          // keepalive racing with state transitions). Only set to
          // null when the slot is empty or was already pending.
          const existing = faceMap.get(msg.parent_face);
          if (existing == null) {
            faceMap.set(msg.parent_face, null);
          }
        } else {
          faceMap.set(msg.parent_face, childKey);
        }
        next.set(parentKey, faceMap);
        this._children = next;
        break;
      }
      case 'child_unstack': {
        const parentKey = msg.parent_uid ?? msg.parent_slot;
        if (parentKey == null) break;
        const faceMap = this._children.get(parentKey);
        if (!faceMap || !faceMap.has(msg.parent_face)) break;
        const next = new Map(this._children);
        const updated = new Map(faceMap);
        updated.delete(msg.parent_face);
        if (updated.size) next.set(parentKey, updated);
        else              next.delete(parentKey);
        this._children = next;
        break;
      }
      case 'actuator_state': {
        const key = uid ?? msg.slot;
        if (key == null) break;
        const next = new Map(this._actuatorByUid);
        next.set(key, { led: msg.led, vib: msg.vib });
        this._actuatorByUid = next;
        break;
      }
      case 'topology': {
        // One row per registered module, emitted in response to $Q,TOPO.
        // Buffer until query_done flushes the snapshot into state.
        this._topoBuffer.push({
          uid: msg.uid,
          parent_uid: msg.parent_uid,
          parent_is_hub: msg.parent_is_hub,
          parent_face: msg.parent_face,
        });
        break;
      }
      case 'query_done': {
        const command = String(msg.command || '').toUpperCase();
        const hasRows = this._topoBuffer.length > 0;
        if (command === 'TOPO' || (!command && hasRows)) {
          const snapshot = this._topoBuffer;
          this._topoBuffer = [];
          this._reconcileTopology(snapshot);
        } else if (command) {
          this._topoBuffer = [];
        }
        break;
      }
      case 'command_ack':
        this._handleCommandAck(msg);
        break;
      case 'transport_status':
        this._transport = {
          transport: msg.transport,
          address:   msg.address,
          label:     msg.label,
          connected: !!msg.connected,
        };
        break;
      case 'paired_devices':
        // Forwarded to <wb-devices-panel> via wsClient.onMessage; nothing
        // to do at the app level. Listed here so the dispatcher recognizes
        // the type.
        break;
      case 'osc_state':
        // Refresh the status-bar badge counter. The panel listens to
        // wsClient directly for the full target list.
        this._oscActiveCount = (msg.targets || []).filter(t => t.enabled).length;
        break;
      case 'osc_stats':
        // Per-target stats — consumed by <wb-osc-panel>; no app-level state.
        break;
      case 'eca_status':
        this._ecaStatus = msg;
        // If the hub no longer has a program, drop our cached rules so
        // the chip / inspector match reality after a $PC.
        if (!msg.has_program) {
          this._ecaRules = null;
          this._lastEcaBytecodeB64 = '';
          this._autoLoadAttempted = false;
        }
        this._maybeAutoLoadEca();
        break;
      case 'eca_bytecode':
        if (msg.base64 && msg.base64 !== this._lastEcaBytecodeB64) {
          this._lastEcaBytecodeB64 = msg.base64;
          try {
            this._ecaRules = decodeBytecode(msg.base64);
          } catch (e) {
            console.error('[wb-app] eca decode failed:', e.message);
            this._ecaRules = null;
          }
          this._maybeAutoLoadEca();
        }
        break;
    }
  }

  /** If the canvas is empty AND the hub is reporting a program, fold the
   *  hub's program into the local Blockly workspace. Runs at most once
   *  per "fresh program" — we re-arm `_autoLoadAttempted` whenever the
   *  hub clears its program (e.g. after $PC). */
  _maybeAutoLoadEca() {
    if (this._autoLoadAttempted) return;
    if (!this._ecaRules) return;
    const local = this._workspaceRules;
    const localCount = local
      ? ((local.rules || []).length + (local.virtual_channels || []).length)
      : 0;
    if (localCount > 0 && !this._workspaceRulesAutoDefault) return;  // user work: leave alone
    this._autoLoadAttempted = true;
    // Defer to the same path the LLM panel uses, so all canvas mutation
    // goes through one entry point.
    queueMicrotask(() => {
      const ok = this._onApplyRules({
        detail: { rules: this._ecaRules, markDirty: false },
      });
      if (!ok) {
        this._autoLoadAttempted = false;
        setTimeout(() => this._maybeAutoLoadEca(), 100);
        return;
      }
      console.log('[eca] auto-loaded program from hub (canvas was empty)');
    });
  }

  _handleCommandAck(msg) {
    const text = String(msg.text || '');
    const isEcaAck = text.startsWith('P ')
      || text === 'PR' || text === 'PS' || text === 'PC'
      || text.startsWith('PE')
      || text === 'running' || text === 'stopped' || text === 'cleared';
    if (isEcaAck) wsClient.queryEca();
  }

  _reconcileTopology(rows) {
    // Apply a $Q,TOPO snapshot as the authoritative tree: rebuild
    // _children from scratch (drops stale links left behind by missed
    // child_unstack events), remove modules absent from the snapshot, restore
    // each live module's parent/face from its $T row, and clear pending-detach
    // for anything the hub still reports as live.
    const nextChildren = new Map();
    const liveUids = new Set();
    for (const row of rows) {
      liveUids.add(row.uid);
      if (!row.parent_is_hub && row.parent_uid != null) {
        const faceMap = nextChildren.get(row.parent_uid) || new Map();
        faceMap.set(row.parent_face, row.uid);
        nextChildren.set(row.parent_uid, faceMap);
      }
    }
    this._children = nextChildren;

    const staleModules = this._modules.filter(m => m.uid && !liveUids.has(m.uid));
    const staleKeys = new Set();
    for (const m of staleModules) {
      if (m.uid != null) staleKeys.add(m.uid);
      if (m.slot != null) {
        staleKeys.add(m.slot);
        staleKeys.add(`slot:${m.slot}`);
      }
    }

    // Apply hub-face updates AND create placeholders for any uid in the
    // snapshot we don't have a module entry for yet. Placeholders are
    // minimal (uid + face only, name="(loading)", empty caps) — but they
    // let the canvas render the topology *structure* even when the
    // hub's hello/descriptor for some module never made it through (e.g.
    // hub state machine got stuck in PENDING and emitStatusSnapshot
    // skipped it). The placeholder gets enriched in place when a real
    // hello eventually arrives — the hello handler's
    // `prev?.capabilities ?? []` pattern preserves anything that's
    // already been set across overwrites.
    const retainedModules = this._modules.filter(m =>
      m.uid ? liveUids.has(m.uid) : false);
    const knownUids = new Set(retainedModules.map(m => m.uid).filter(Boolean));
    const placeholders = [];
    for (const row of rows) {
      if (row.uid && !knownUids.has(row.uid)) {
        placeholders.push({
          uid: row.uid,
          id: '',
          name: '(loading)',
          face: row.parent_is_hub ? row.parent_face : 0,
          slot: null,
          color: DEFAULT_MODULE_COLOR,
          capabilities: [],
          face_kinds: undefined,
          descriptor: undefined,
          firmware_version: '',
          fw_hash: '',
          parent_uid: row.parent_uid ?? null,
          parent_is_hub: row.parent_is_hub ?? null,
          parent_face: row.parent_face ?? 0,
          active: true,
        });
        knownUids.add(row.uid);
      }
    }
    // Build a parent-update map so we can refresh both the face alias
    // and the parent_* metadata on existing modules in one pass.
    const parentUpdate = new Map();   // uid → { face, parent_uid, parent_is_hub, parent_face }
    for (const row of rows) {
      if (!row.uid) continue;
      parentUpdate.set(row.uid, {
        face: row.parent_is_hub ? row.parent_face : 0,
        parent_uid: row.parent_uid ?? null,
        parent_is_hub: row.parent_is_hub ?? null,
        parent_face: row.parent_face ?? 0,
      });
    }
    if (parentUpdate.size || placeholders.length) {
      let updated = retainedModules.map(m =>
        parentUpdate.has(m.uid) ? { ...m, ...parentUpdate.get(m.uid) } : m);
      if (placeholders.length) updated = [...updated, ...placeholders];
      this._modules = updated;
    } else if (staleModules.length || this._modules.length !== retainedModules.length) {
      this._modules = retainedModules;
    }

    // Live/stale modules cannot remain detach-pending after an authoritative
    // snapshot. Also clear associated sensor, actuator, panel, and slot maps
    // for stale modules so missed `$U` events do not leave local ghosts.
    if (this._pendingDetach.size) {
      let mutated = false;
      const nextPending = new Set(this._pendingDetach);
      for (const uid of liveUids) {
        if (nextPending.delete(uid)) mutated = true;
      }
      for (const key of staleKeys) {
        if (nextPending.delete(key)) mutated = true;
      }
      if (mutated) this._pendingDetach = nextPending;
    }
    if (staleKeys.size) {
      const nextSensors = new Map(this._sensorByUid);
      const nextActuators = new Map(this._actuatorByUid);
      for (const key of staleKeys) {
        nextSensors.delete(key);
        nextActuators.delete(key);
      }
      this._sensorByUid = nextSensors;
      this._actuatorByUid = nextActuators;
      this._openPanels = this._openPanels.filter(k => !staleKeys.has(k));
      for (const [slot, uid] of [...this._slotToUid.entries()]) {
        if (!liveUids.has(uid)) this._slotToUid.delete(slot);
      }
    }
  }

  _findModule(uid, slot) {
    if (uid) return this._modules.find(m => m.uid === uid);
    if (slot != null) return this._modules.find(m => m.slot === slot);
    return null;
  }

  _onOpenPanel(e) {
    // Prefer uid (stable identity, survives re-attach); fall back to
    // slot so the legacy sim path still works. Module-card dispatches
    // {uid}, canvas dispatches {uid, slot}, both shapes funnel through
    // here. Without the uid path, real-hardware clicks resolved to
    // slot=null and the panel showed "Waiting for data" because
    // _sensorByUid is keyed by uid.
    const key = e.detail?.uid ?? e.detail?.slot;
    if (key == null) return;
    if (!this._openPanels.includes(key)) {
      this._openPanels = [...this._openPanels, key];
    }
  }

  _onClosePanel(e) {
    const key = e.detail?.uid ?? e.detail?.slot;
    if (key == null) return;
    this._openPanels = this._openPanels.filter(s => s !== key);
  }

  _onApplyRules(e) {
    const canvas = this.renderRoot.querySelector('wb-block-canvas');
    if (!canvas?.applyRules) return false;
    return canvas.applyRules(e.detail?.rules, { markDirty: e.detail?.markDirty !== false }) !== false;
  }

  /** Build the {uid → {id, name}} map the ECA inspector uses to render
   *  module names instead of raw UID hex. Keys are uppercase 8-char
   *  hex (matches the inspector's lookup convention). */
  _buildModulesByUid() {
    const out = {};
    for (const m of this._modules) {
      if (!m.uid) continue;
      out[String(m.uid).toUpperCase()] = {
        id: m.id || m.type || '',
        name: m.name || m.id || m.type || '',
      };
    }
    return out;
  }

  _onHighlightModule(e) {
    this._highlightedUid = e.detail?.uid ?? null;
  }

  _onResizeMouseDown(e) {
    e.preventDefault();
    this._resizeStartY = e.clientY;
    this._resizeStartH = this._panelHeight;
    window.addEventListener('mousemove', this._onResizeMouseMove);
    window.addEventListener('mouseup', this._onResizeMouseUp);
  }

  _onResizeMouseMove(e) {
    const delta = this._resizeStartY - e.clientY;
    this._panelHeight = Math.max(80, Math.min(600, this._resizeStartH + delta));
  }

  _onResizeMouseUp() {
    window.removeEventListener('mousemove', this._onResizeMouseMove);
    window.removeEventListener('mouseup', this._onResizeMouseUp);
  }

  render() {
    // Hide modules that are in detach-pending — the user has physically
    // unplugged them and there's no live data flowing. Hub keeps the
    // slot + descriptor for 8s so a quick re-plug skips re-handshake;
    // that's a hub-internal optimization, not something the UI needs
    // to mirror as a ghosted module. On re-attach, the module reappears
    // immediately (hello clears its pendingDetach entry).
    const pending = this._pendingDetach;
    const visibleModules = pending.size
      ? this._modules.filter(m =>
          !pending.has(m.uid) && !pending.has(m.slot))
      : this._modules;
    // Filter _children too — drop any link pointing at a hidden child,
    // and drop any parent group that's now empty. Prevents canvas from
    // drawing a stack edge to nothing.
    let visibleChildren = this._children;
    if (pending.size) {
      const filtered = new Map();
      for (const [parentKey, faceMap] of this._children) {
        if (pending.has(parentKey)) continue;
        const innerFiltered = new Map();
        for (const [face, childKey] of faceMap) {
          if (childKey != null && pending.has(childKey)) continue;
          innerFiltered.set(face, childKey);
        }
        if (innerFiltered.size) filtered.set(parentKey, innerFiltered);
      }
      visibleChildren = filtered;
    }
    return html`
      <div class="main-row">
        <div class="sidebar-left" @open-panel=${this._onOpenPanel}>
          <wb-palette .modules=${visibleModules}></wb-palette>
        </div>
        <div class="center">
          <wb-block-canvas
            .modules=${visibleModules}
            .hubProgramKnown=${this._ecaStatus != null}
            .hubHasProgram=${!!this._ecaStatus?.has_program}
            .pendingDetach=${this._pendingDetach}
            .children=${visibleChildren}
            .highlightedUid=${this._highlightedUid}
            @open-panel=${this._onOpenPanel}
            @workspace-changed=${e => {
              this._workspaceRules = e.detail?.rules ?? null;
              this._workspaceRulesAutoDefault = !!e.detail?.autoDefault;
            }}
            @resync=${() => { wsClient.queryStatus(); wsClient.queryTopo(); }}>
          </wb-block-canvas>
        </div>
        <div class="sidebar-right">
          <wb-llm-panel
            .modules=${visibleModules}
            .workspace=${this._workspaceRules}
            @apply-rules=${this._onApplyRules}
            @highlight-module=${this._onHighlightModule}>
          </wb-llm-panel>
        </div>
      </div>

      <div class="resize-handle" @mousedown=${this._onResizeMouseDown}></div>

      <div class="bottom-panel" style="height: ${this._panelHeight}px">
        ${this._openPanels.length === 0
          ? html`<div class="panel-empty">Click "view" on a module card to open its sensor panel</div>`
          : this._openPanels.map(key => {
              // key is uid (string) or slot (number); match either.
              const mod = this._modules.find(m =>
                m.uid === key || m.slot === key);
              const sensorKey = mod?.uid ?? mod?.slot ?? key;
              return html`<wb-sensor-panel
                .slot=${mod?.slot ?? 0}
                .module=${mod ?? null}
                .sensorData=${this._sensorByUid.get(sensorKey) ?? null}
                .actuatorState=${this._actuatorByUid.get(sensorKey) ?? null}
                ?closeable=${true}
                @close-panel=${this._onClosePanel}>
              </wb-sensor-panel>`;
            })
        }
      </div>

      <wb-status-bar
        .connected=${this._connected}
        .moduleCount=${visibleModules.length}
        .sampleRate=${this._sampleRate}
        .frameCount=${this._frameCount}
        .transport=${this._transport}
        .eca=${this._ecaStatus}
        .oscActive=${this._oscActiveCount}
        @open-devices-panel=${() => this._devicesOpen = true}
        @open-eca-inspector=${() => this._ecaInspectorOpen = true}
        @open-osc-panel=${() => this._oscOpen = true}>
      </wb-status-bar>

      <wb-devices-panel
        ?open=${this._devicesOpen}
        @close=${() => this._devicesOpen = false}>
      </wb-devices-panel>

      <wb-osc-panel
        ?open=${this._oscOpen}
        @close=${() => this._oscOpen = false}>
      </wb-osc-panel>

      <wb-eca-inspector
        ?open=${this._ecaInspectorOpen}
        .status=${this._ecaStatus}
        .modulesByUid=${this._buildModulesByUid()}
        .localRules=${this._workspaceRules}
        @close=${() => this._ecaInspectorOpen = false}
        @apply-rules=${this._onApplyRules}>
      </wb-eca-inspector>

      <button class="debug-toggle"
              title="Toggle debug console (Ctrl/Cmd+D)"
              @click=${() => this._debugOpen = !this._debugOpen}>
        🔧
      </button>

      <wb-debug-console ?open=${this._debugOpen}
                        @close=${() => this._debugOpen = false}>
      </wb-debug-console>
    `;
  }
}

customElements.define('wb-app', WbApp);
