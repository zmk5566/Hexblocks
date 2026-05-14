/**
 * <wb-block-canvas> — Block topology view + Blockly ECA editor.
 *
 * Left side: SVG hex topology with the hub at center, 6 face positions,
 * stacked-child rendering, hot-swap pending-detach ghosting, and a
 * resync button. Clicking a module dispatches open-panel.
 *
 * Right side: Blockly workspace with ECA-specific blocks. Upload encodes
 * the workspace → JSON Rules → bytecode → base64 → bridge `program` action.
 */
import { LitElement, html, svg, css } from 'lit';
import { programToBase64, REF, VC_OP, COND_OP, LOGIC, ACT } from '../eca-encoder.js';
import { wsClient } from '../ws-client.js';
import { dispatchOpenPanel } from './open-panel.js';
import {
  slotOptions,
  channelOptionsForSlot,
  channelsForModule,
  moduleHasRole,
  slotLabel,
  LED_CMD_OPTIONS,
  VIB_CMD_OPTIONS,
  AUDIO_CMD_OPTIONS,
  withGhost,
  normalizeUid,
  moduleMatchesKey,
  setDropdownGhosts,
} from '../module-channel-map.js';

// Pointy-top hexagon path centered at (cx, cy) with radius r
function hexPath(cx, cy, r) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = ((i * 60) + 30) * (Math.PI / 180);
    return `${i === 0 ? 'M' : 'L'}${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  }).join('') + 'Z';
}

// Position of a face (1–6) around the hub center.
// Face 1 = right flat-edge, stepping clockwise every 60°.
function facePos(face, dist) {
  const a = ((face - 1) * 60 - 60) * (Math.PI / 180);
  return { x: +(dist * Math.cos(a)).toFixed(2), y: +(dist * Math.sin(a)).toFixed(2) };
}

// Collect `vc_def` blocks from a workspace in deterministic order and
// return FieldDropdown options of the form [['vc0: DIFF', '0'], ...].
// The string values (not the numeric positions) are what Blockly stores,
// so the ID is always the 0-based index of the block in workspace order.
function vcOptionsFromWorkspace(ws) {
  if (!ws) return [['— no vcs —', '0']];
  const defs = ws.getBlocksByType('vc_def', false);
  if (defs.length === 0) return [['— no vcs —', '0']];
  return defs.map((b, i) => {
    const op = b.getFieldValue('OP') || 'ADD';
    return [`vc${i}: ${op}`, String(i)];
  });
}

// All hexes share the same radius — hub and modules are equal-sized
const HEX_R = 44;
// Module category color is drawn as an inset band. The outer hex keeps the
// existing footprint, while the inner fill shrinks inward to make color weightier.
const MOD_COLOR_BAND = 8;
const AUDIO_MODULE_COLOR = '#9885BF';
// Edge-touching distance: R * sqrt(3) for pointy-top hexes sharing a flat edge
const HEX_DIST_COMPACT = HEX_R * Math.sqrt(3) + 2;  // +2px grid-line gap
const HEX_DIST_SPACED  = 115;
const VB = 175; // half-size of viewBox square
const BLOCKLY_THEME_CACHE = new Map();

export class WbBlockCanvas extends LitElement {
  /**
   * Render into LIGHT DOM, not shadow DOM.
   *
   * Reason: Blockly's event handling relies on document-level pointer
   * coordinates and `document.elementFromPoint`, neither of which pierce
   * the shadow boundary (google/blockly#1114). With shadow DOM, mirroring
   * CSS makes the workspace *visible* but blocks still can't be dragged.
   * Hoisting the whole component into light DOM fixes both rendering and
   * interaction without forking Blockly.
   *
   * Trade-off: lit's `static styles` no longer auto-scopes. We re-inject
   * it as an inline <style> in render(), with `:host` rewritten to the
   * element tag name. Every other selector is already descendant-based
   * so it scopes naturally to children of <wb-block-canvas>.
   */
  createRenderRoot() { return this; }

  static styles = css`
    :host {
      display: flex;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    /* ── topology pane ─────────────────────── */
    .topology-pane {
      flex: 1;
      min-width: 0;
      position: relative;
      overflow: hidden;
    }

    .topology-pane > svg {
      width: 100%;
      height: 100%;
      display: block;
      cursor: grab;
      user-select: none;
    }

    /* zoom controls */
    .zoom-controls {
      position: absolute;
      bottom: 12px;
      left: 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      z-index: 10;
    }
    .zoom-btn {
      width: 28px;
      height: 28px;
      background: var(--wb-surface);
      border: 1px solid var(--wb-border);
      border-radius: 0;
      color: var(--wb-text-dim);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, color 0.15s;
    }
    .zoom-btn:hover {
      background: var(--wb-accent);
      color: var(--wb-on-accent);
    }

    /* hub hex */
    .hub-color-band { fill: var(--wb-hub); }
    .hub-fill   { fill: var(--wb-surface); }
    .hub-label  { fill: var(--wb-hub); font: 600 11px system-ui; text-anchor: middle; dominant-baseline: central; }

    /* ghost hex (unoccupied face) */
    .ghost-fill   { fill: none; }
    .ghost-stroke { fill: none; stroke: var(--wb-ghost-stroke); stroke-width: 1.5; stroke-dasharray: 5 4; }
    .ghost-label  { fill: var(--wb-ghost-label); font: 500 11px var(--wb-mono, monospace); text-anchor: middle; dominant-baseline: central; }

    /* module hex */
    .mod-color-band { fill: var(--mod-color, #888); transition: opacity 0.2s; }
    .mod-fill   { fill: var(--wb-surface-2); transition: fill 0.15s, opacity 0.2s; }
    .module-hex { cursor: pointer; }
    .module-hex:hover .mod-fill { fill: var(--wb-mod-hover); }
    .mod-pending { opacity: 0.35; }
    .mod-name   {
      fill: var(--wb-text);
      font: 600 9px system-ui;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
    }
    .mod-cap-badge {
      fill: var(--wb-cap-badge-bg);
      rx: 4; ry: 4;
    }
    .mod-cap-text {
      fill: var(--wb-accent);
      font: 500 7px system-ui;
      text-anchor: middle;
      dominant-baseline: central;
      pointer-events: none;
    }

    /* edge */
    .edge { stroke: var(--wb-edge-stroke); stroke-width: 1.5; fill: none; }

    /* face badge on edge midpoint */
    .face-badge-bg { fill: var(--wb-face-badge-bg); stroke: var(--wb-face-badge-stroke); stroke-width: 1; }
    .face-badge-txt {
      fill: var(--wb-text-dim);
      font: 600 9px var(--wb-mono, monospace);
      text-anchor: middle;
      dominant-baseline: central;
    }

    /* connector-kind badges (Plug / Receptacle) */
    .kind-badge-p { fill: #ffb347; stroke: #ff8c00; stroke-width: 1; }
    .kind-badge-r { fill: none; stroke: var(--wb-accent); stroke-width: 1.5; }
    .kind-badge-txt-p {
      fill: #1a1100; font: 700 7px var(--wb-mono, monospace);
      text-anchor: middle; dominant-baseline: central;
    }
    .kind-badge-txt-r {
      fill: var(--wb-accent); font: 700 7px var(--wb-mono, monospace);
      text-anchor: middle; dominant-baseline: central;
    }

    /* hex background pattern */
    .bg-hex { fill: none; stroke: var(--wb-bg-grid-stroke); stroke-width: 1; }

    /* ── divider ───────────────────────────── */
    .divider {
      width: 4px;
      flex-shrink: 0;
      background: var(--wb-border);
      cursor: ew-resize;
      transition: background 0.15s;
    }
    .divider:hover { background: var(--wb-accent); }

    /* ── code pane ─────────────────────────── */
    .code-pane {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      background: var(--wb-surface);
      overflow: hidden;
    }

    .code-header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--wb-border);
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--wb-text-dim);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .mode-toggle {
      font-size: 0.65rem;
      padding: 3px 8px;
      border: 1px solid var(--wb-border);
      border-radius: 0;
      background: transparent;
      color: var(--wb-text-dim);
      cursor: pointer;
      font-family: var(--wb-mono, monospace);
      letter-spacing: 0;
      text-transform: none;
      transition: background 0.15s, color 0.15s;
    }
    .mode-toggle:hover {
      background: var(--wb-accent);
      color: var(--wb-on-accent);
    }

    .code-body {
      flex: 1;
      position: relative;
      overflow: hidden;
    }

    .code-body .blockly-host {
      width: 100%;
      height: 100%;
    }
    .code-body .blocklySvg .blocklyText {
      fill: var(--wb-blockly-block-text) !important;
    }
    .code-body .blocklySvg .blocklyEditableText .blocklyText {
      fill: var(--wb-blockly-field-text) !important;
    }
    .code-body .blocklySvg .blocklyEditableText > rect,
    .code-body .blocklySvg .blocklyFieldRect,
    .code-body .blocklySvg .blocklyNonEditableText > rect {
      fill: var(--wb-blockly-field-bg) !important;
      stroke: var(--wb-blockly-field-border) !important;
    }
    .code-body .blocklySvg .blocklyEditableText:hover > rect {
      stroke: var(--wb-accent) !important;
    }
    .code-body .blocklySvg .blocklyFlyoutLabelText {
      fill: var(--wb-blockly-tb-fg) !important;
    }
    .code-body .blocklyTreeLabel {
      color: var(--wb-blockly-tb-fg) !important;
    }
    .blocklyWidgetDiv .blocklyHtmlInput {
      background: var(--wb-blockly-field-bg) !important;
      color: var(--wb-blockly-field-text) !important;
      border-color: var(--wb-blockly-field-border) !important;
    }

    .code-body .json-host {
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: none;
      background: var(--wb-json-bg);
      color: var(--wb-json-text);
      font: 12px / 1.5 var(--wb-mono, monospace);
      resize: none;
      outline: none;
      tab-size: 2;
    }
    .code-body .json-host:focus {
      background: var(--wb-json-bg-focus);
    }

    .code-toolbar {
      display: flex;
      gap: 6px;
      padding: 6px 10px;
      border-top: 1px solid var(--wb-border);
    }
    .code-toolbar button {
      padding: 4px 12px;
      border: 1px solid var(--wb-border);
      border-radius: 0;
      background: var(--wb-surface);
      color: var(--wb-text-dim);
      font-size: 0.72rem;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    .code-toolbar button:hover {
      background: var(--wb-accent);
      color: var(--wb-on-accent);
    }
    .code-toolbar .status {
      flex: 1;
      display: flex;
      align-items: center;
      font-size: 0.7rem;
      color: var(--wb-text-dim);
      opacity: 0.7;
    }
    .code-toolbar .status.dirty {
      color: var(--wb-accent);
      opacity: 1;
      font-weight: 600;
    }
    .code-toolbar .status.pending {
      color: var(--wb-text);
      opacity: 1;
    }
    .code-toolbar .status.ok {
      color: #50C878;
      opacity: 1;
    }
    .code-toolbar .status.err {
      color: var(--wb-danger);
      opacity: 1;
      font-weight: 600;
    }
  `;

  static properties = {
    modules:       { type: Array },
    hubProgramKnown: { type: Boolean },
    hubHasProgram: { type: Boolean },
    pendingDetach: { type: Object },  // Set<slot>
    children:      { type: Object },  // Map<parentSlot, Map<face, childSlot>>
    compact:       { type: Boolean },
    highlightedUid: { type: String }, // uid to highlight in topology SVG
    _codePaneW:    { type: Number, state: true },
    _scale:        { type: Number, state: true },
    _tx:           { type: Number, state: true },
    _ty:           { type: Number, state: true },
    _uploadStatus: { type: String, state: true },
    _statusKind:   { type: String, state: true },   // '' | 'dirty' | 'pending' | 'ok' | 'err'
    _ecaDirty:     { type: Boolean, state: true },
    _editMode:     { type: String, state: true },  // 'blocks' | 'json'
    _jsonText:     { type: String, state: true },
  };

  constructor() {
    super();
    this.modules = [];
    this.hubProgramKnown = false;
    this.hubHasProgram = false;
    this.pendingDetach = new Set();
    this.children = new Map();
    this.compact = true;
    this.highlightedUid = null;
    this._highlightTimer = null;
    this._codePaneW = 560;
    this._uploadStatus = '';
    this._statusKind = '';
    this._ecaDirty = false;
    this._editMode = 'blocks';
    this._jsonText = '';
    this._workspace = null;
    this._pendingApplyRules = null;
    this._autoDefaultActive = false;
    this._pendingEcaAction = null;
    this._pendingUpload = null;
    this._lastUploadedB64 = '';
    this._suppressDirty = false;
    this._pendingTimer = null;
    // divider drag
    this._dragStartX = 0;
    this._dragStartW = 0;
    this._onDivMove = this._onDivMove.bind(this);
    this._onDivUp   = this._onDivUp.bind(this);
    // pan state
    this._scale = 1;
    this._tx = 0;
    this._ty = 0;
    this._panning = false;
    this._panStartX = 0;
    this._panStartY = 0;
    this._panStartTx = 0;
    this._panStartTy = 0;
    this._onPanMove = this._onPanMove.bind(this);
    this._onPanUp   = this._onPanUp.bind(this);
    this._syncBlocklyTextQueued = false;
    this._onThemeChange = () => {
      this._applyBlocklyTheme();
    };
    this._onWsMessage = (msg) => this._handleWsMessage(msg);
  }

  connectedCallback() {
    super.connectedCallback();
    wsClient.onMessage(this._onWsMessage);
    window.addEventListener('wb-theme-change', this._onThemeChange);
    this._onLoadDemoProgram = (e) => this._loadProgramJson(e.detail?.state);
    window.addEventListener('wb-load-demo-program', this._onLoadDemoProgram);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    wsClient.offMessage?.(this._onWsMessage);
    window.removeEventListener('wb-load-demo-program', this._onLoadDemoProgram);
    window.removeEventListener('mousemove', this._onDivMove);
    window.removeEventListener('mouseup', this._onDivUp);
    window.removeEventListener('mousemove', this._onPanMove);
    window.removeEventListener('mouseup', this._onPanUp);
    window.removeEventListener('wb-theme-change', this._onThemeChange);
    this._clearPendingTimer();
    if (this._blocklyRO) { this._blocklyRO.disconnect(); this._blocklyRO = null; }
    if (this._blocklyMO) { this._blocklyMO.disconnect(); this._blocklyMO = null; }
  }

  // ── divider drag ─────────────────────────────────────────────────────

  _onDivDown(e) {
    e.preventDefault();
    this._dragStartX = e.clientX;
    this._dragStartW = this._codePaneW;
    window.addEventListener('mousemove', this._onDivMove);
    window.addEventListener('mouseup', this._onDivUp);
  }

  _onDivMove(e) {
    const delta = this._dragStartX - e.clientX;
    this._codePaneW = Math.max(280, Math.min(900, this._dragStartW + delta));
    // Tell Blockly its viewport changed; without this the toolbox flyout
    // stays at the old geometry and may overlap the workspace.
    if (this._workspace) Blockly.svgResize(this._workspace);
  }

  _onDivUp() {
    window.removeEventListener('mousemove', this._onDivMove);
    window.removeEventListener('mouseup', this._onDivUp);
  }

  // ── zoom ─────────────────────────────────────────────────────────────

  _onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.max(0.3, Math.min(4, this._scale * factor));

    // Zoom toward cursor position inside the SVG element
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top  - rect.height / 2;
    this._tx = cx + (this._tx - cx) * (newScale / this._scale);
    this._ty = cy + (this._ty - cy) * (newScale / this._scale);
    this._scale = newScale;
  }

  // ── pan ──────────────────────────────────────────────────────────────

  _onPanDown(e) {
    if (e.button !== 0) return;
    this._panning = true;
    this._panStartX  = e.clientX;
    this._panStartY  = e.clientY;
    this._panStartTx = this._tx;
    this._panStartTy = this._ty;
    e.currentTarget.style.cursor = 'grabbing';
    window.addEventListener('mousemove', this._onPanMove);
    window.addEventListener('mouseup',   this._onPanUp);
  }

  _onPanMove(e) {
    if (!this._panning) return;
    this._tx = this._panStartTx + (e.clientX - this._panStartX);
    this._ty = this._panStartTy + (e.clientY - this._panStartY);
  }

  _onPanUp(e) {
    this._panning = false;
    const svg = this.renderRoot?.querySelector('svg');
    if (svg) svg.style.cursor = 'grab';
    window.removeEventListener('mousemove', this._onPanMove);
    window.removeEventListener('mouseup',   this._onPanUp);
  }

  _resetView() {
    this._scale = 1;
    this._tx = 0;
    this._ty = 0;
  }

  _onModuleClick(mod) {
    dispatchOpenPanel(this, mod);
  }

  // ── SVG rendering helpers ────────────────────────────────────────────

  _renderBgPattern() {
    // Small hex pattern tiles across the background
    const r = 14;
    const path = hexPath(0, 0, r);
    const tw = r * Math.sqrt(3);
    const th = r * 1.5;
    return svg`
      <defs>
        <pattern id="hex-bg" x="0" y="0"
          width="${tw.toFixed(2)}" height="${(th * 2).toFixed(2)}"
          patternUnits="userSpaceOnUse">
          <path d="${hexPath(tw / 2, r, r)}" class="bg-hex"/>
          <path d="${hexPath(0, r * 2.5, r)}" class="bg-hex"/>
          <path d="${hexPath(tw, r * 2.5, r)}" class="bg-hex"/>
        </pattern>
        <filter id="mod-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" result="blur"/>
          <feMerge>
            <feMergeNode in="blur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      <rect x="${-VB}" y="${-VB}" width="${VB * 2}" height="${VB * 2}"
            fill="url(#hex-bg)"/>
    `;
  }

  _renderHub() {
    const p = hexPath(0, 0, HEX_R);
    const innerPath = hexPath(0, 0, HEX_R - MOD_COLOR_BAND);
    // Hub has all 6 faces as R. Draw those badges inside the hub group AFTER
    // the fill/stroke so they aren't covered by the hub body. Only show them
    // in spaced (expanded) view, matching the module P/R behaviour.
    const kindBadges = !this.compact ? this._renderHubKindBadges() : [];
    return svg`
      <g class="hub-group">
        <path d="${p}" class="hub-color-band"/>
        <path d="${innerPath}" class="hub-fill"/>
        <text x="0" y="0" class="hub-label">HUB</text>
        ${kindBadges}
      </g>
    `;
  }

  _renderFaces() {
    const dist = this.compact ? HEX_DIST_COMPACT : HEX_DIST_SPACED;
    // Build a map: face → module (if connected). Skip any module that is
    // currently a child of another module — those are drawn via
    // _renderChildrenOf() beside their parent, not on the hub face bar.
    // _children entries can now be keyed by either uid (v2 wire) or slot
    // (legacy sim path); the value is likewise uid|slot|null. Match a
    // module if either of its identity fields appears as a child key.
    const stackedKeys = new Set();
    if (this.children) {
      for (const faceMap of this.children.values()) {
        for (const childKey of faceMap.values()) {
          if (childKey != null && childKey !== -1) stackedKeys.add(childKey);
        }
      }
    }
    const faceMap = new Map();
    for (const m of this.modules) {
      if (m.face == null || m.face < 1 || m.face > 6) continue;
      if (stackedKeys.has(m.uid) || stackedKeys.has(m.slot)) continue;
      faceMap.set(m.face, m);
    }

    const elements = [];
    for (let face = 1; face <= 6; face++) {
      const { x, y } = facePos(face, dist);
      const mod = faceMap.get(face);

      if (mod) {
        if (!this.compact) elements.push(this._renderEdge(x, y, face));
        elements.push(this._renderModule(x, y, mod, face));
        // Render any children stacked on this module's faces
        elements.push(...this._renderChildrenOf(mod, x, y));
      } else {
        if (!this.compact) elements.push(this._renderEdge(x, y, face, true));
        elements.push(this._renderGhost(x, y, face));
      }
    }
    return elements;
  }

  /** Draw a P/R kind badge at the midpoint of each hub face edge. */
  _renderHubKindBadges() {
    const out = [];
    for (let face = 1; face <= 6; face++) {
      const a = ((face - 1) * 60 - 60) * (Math.PI / 180);
      const mx = +(HEX_R * 0.72 * Math.cos(a)).toFixed(2);
      const my = +(HEX_R * 0.72 * Math.sin(a)).toFixed(2);
      out.push(this._renderKindBadge(mx, my, 'R'));
    }
    return out;
  }

  /** Draw P/R badges around a module hex, based on its descriptor.face_kinds.
   *  baseAngle (radians) is the world direction of the module's local face 1
   *  (its P face), so badges follow the module's actual orientation. */
  _renderModuleKindBadges(mod, modX, modY, baseAngle) {
    const kinds = (mod && mod.face_kinds) || { 1: 'P', 3: 'R', 4: 'R', 5: 'R' };
    const out = [];
    for (let f = 1; f <= 6; f++) {
      const kind = kinds[f] || kinds[String(f)];
      if (!kind) continue;
      const a = baseAngle + ((f - 1) * 60) * (Math.PI / 180);
      const mx = +(modX + HEX_R * 0.72 * Math.cos(a)).toFixed(2);
      const my = +(modY + HEX_R * 0.72 * Math.sin(a)).toFixed(2);
      out.push(this._renderKindBadge(mx, my, kind));
    }
    return out;
  }

  _renderKindBadge(cx, cy, kind) {
    const isP = kind === 'P';
    const bgCls = isP ? 'kind-badge-p' : 'kind-badge-r';
    const txCls = isP ? 'kind-badge-txt-p' : 'kind-badge-txt-r';
    return svg`
      <g>
        <circle cx="${cx}" cy="${cy}" r="7" class="${bgCls}"/>
        <text x="${cx}" y="${cy}" class="${txCls}">${kind}</text>
      </g>
    `;
  }

  _renderChildrenOf(parentMod, parentX, parentY) {
    if (!this.children) return [];
    // Children may be keyed by parent uid (v2) or parent slot (legacy);
    // try both so the same hex renders correctly under either path.
    const faceMap = this.children.get(parentMod.uid)
                 ?? this.children.get(parentMod.slot);
    if (!faceMap || faceMap.size === 0) return [];

    // Parent's own orientation: its local face 1 (P) points back toward the
    // hub (i.e. toward origin). So the *world* angle of parent's local face F
    // is baseAngle + (F-1)*60°, where baseAngle points from parent → hub.
    const baseAngle = Math.atan2(-parentY, -parentX);
    // Edge-touching distance between two equal-sized pointy-top hexes.
    const dist = HEX_R * Math.sqrt(3) + 2;

    const out = [];
    for (const [parentFace, childKey] of faceMap) {
      const angle = baseAngle + ((parentFace - 1) * 60) * (Math.PI / 180);
      const cx = +(parentX + dist * Math.cos(angle)).toFixed(2);
      const cy = +(parentY + dist * Math.sin(angle)).toFixed(2);

      // childKey is uid (string) | slot (number) | null/-1 (pending).
      const child = (childKey != null && childKey !== -1)
        ? this.modules.find(m => m.uid === childKey || m.slot === childKey)
        : null;
      // Child's orientation: its local face 1 (P) points back at parent,
      // i.e. world angle = angle + 180°. Pass this so P/R badges on the
      // child rotate to match.
      const childRotRad = angle + Math.PI;
      if (!child) {
        out.push(this._renderPendingChild(cx, cy, parentFace));
      } else {
        out.push(this._renderModule(cx, cy, child, parentFace, childRotRad));
      }
      // Draw an edge hint between parent and child (only in spaced view).
      if (!this.compact) {
        out.push(this._renderStackEdge(parentX, parentY, cx, cy, parentFace));
      }
    }
    return out;
  }

  _renderPendingChild(cx, cy, parentFace) {
    const p = hexPath(cx, cy, HEX_R);
    return svg`
      <g title="pending child on parent F${parentFace}">
        <path d="${p}" class="ghost-fill"/>
        <path d="${p}" class="ghost-stroke"/>
        <text x="${cx}" y="${cy}" class="ghost-label" style="font-size:9px">
          F${parentFace}?
        </text>
      </g>
    `;
  }

  _renderStackEdge(x1, y1, x2, y2, parentFace) {
    const dx = x2 - x1, dy = y2 - y1;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / d, ny = dy / d;
    const sx = +(x1 + nx * HEX_R * 1.0).toFixed(2);
    const sy = +(y1 + ny * HEX_R * 1.0).toFixed(2);
    const ex = +(x2 - nx * HEX_R * 1.0).toFixed(2);
    const ey = +(y2 - ny * HEX_R * 1.0).toFixed(2);
    // Note: no F-number badge here — the parent's own face labels (drawn in
    // spaced view) and the P/R badges already convey the dock face. Adding
    // a third label on the stack edge was visually noisy.
    return svg`
      <line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" class="edge"/>
    `;
  }

  _renderEdge(x, y, face, ghost = false) {
    // Line from hub edge toward module center, stopping short of both hexes
    const dist = Math.sqrt(x * x + y * y);
    const nx = x / dist;
    const ny = y / dist;
    const x1 = +(nx * HEX_R * 1.1).toFixed(2);
    const y1 = +(ny * HEX_R * 1.1).toFixed(2);
    const x2 = +(x - nx * HEX_R * 1.1).toFixed(2);
    const y2 = +(y - ny * HEX_R * 1.1).toFixed(2);
    const mx = +((x1 + x2) / 2).toFixed(2);
    const my = +((y1 + y2) / 2).toFixed(2);

    const opacity = ghost ? 0.4 : 1;
    return svg`
      <g style="opacity: ${opacity}">
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="edge"/>
        <circle cx="${mx}" cy="${my}" r="9" class="face-badge-bg"/>
        <text x="${mx}" y="${my}" class="face-badge-txt">${face}</text>
      </g>
    `;
  }

  _renderGhost(x, y, face) {
    const p = hexPath(x, y, HEX_R);
    return svg`
      <g>
        <path d="${p}" class="ghost-fill"/>
        <path d="${p}" class="ghost-stroke"/>
        <text x="${x}" y="${y}" class="ghost-label">f${face}</text>
      </g>
    `;
  }

  _renderModule(x, y, mod, face, rotRad = null) {
    const p = hexPath(x, y, HEX_R);
    const innerPath = hexPath(x, y, HEX_R - MOD_COLOR_BAND);
    const name = (mod.name || mod.id || '?').slice(0, 8);
    const capCount = (mod.capabilities || []).length;
    const color = mod.color || '#888';
    const pending = this.pendingDetach && this.pendingDetach.has(mod.slot);
    const isHighlighted = this.highlightedUid != null &&
      String(mod.uid) === String(this.highlightedUid);

    // In compact mode, show face number in corner; in spaced mode it's on the edge
    const faceLabel = this.compact ? svg`
      <text x="${x}" y="${y + HEX_R * 0.58}" class="ghost-label" style="font-size:7px">f${face}</text>
    ` : '';

    // Module orientation: hub-attached modules have local face 1 (P) pointing
    // back at the hub. For stacked children, the caller passes the rotation.
    const baseAngle = (rotRad != null)
      ? rotRad
      : Math.atan2(-y, -x);  // hub-attached default
    // P/R badges are tied to spaced (expanded) view — same trigger as the
    // ⬡/⬢ toggle so users see connector kinds whenever they zoom out.
    const kindBadges = !this.compact
      ? this._renderModuleKindBadges(mod, x, y, baseAngle)
      : [];

    return svg`
      <g class="module-hex ${pending ? 'mod-pending' : ''}"
         style="--mod-color: ${color}"
         @click=${() => this._onModuleClick(mod)}>
        ${isHighlighted ? svg`
          <path d="${hexPath(x, y, HEX_R + 4)}" fill="none"
                stroke="${color}" stroke-width="2.5" opacity="0.85"
                filter="url(#mod-glow)"/>
        ` : ''}
        <path d="${p}" class="mod-color-band"/>
        <path d="${innerPath}" class="mod-fill"/>
        <text x="${x}" y="${y - 5}" class="mod-name">${name}</text>
        ${capCount > 0 ? svg`
          <rect x="${x - 14}" y="${y + 6}" width="28" height="12" rx="4" ry="4"
                class="mod-cap-badge"/>
          <text x="${x}" y="${y + 12}" class="mod-cap-text">${capCount} cap</text>
        ` : ''}
        ${faceLabel}
        ${kindBadges}
      </g>
    `;
  }

  render() {
    const transform = `translate(${this._tx}px, ${this._ty}px) scale(${this._scale})`;
    // Because we render into light DOM (see createRenderRoot above), the
    // `static styles` block isn't auto-applied by lit. Inject it once at
    // the top of the output tree, rewriting `:host` → tag name so the
    // host-level rules still work.
    const cssText = WbBlockCanvas.styles.cssText.replaceAll(':host', 'wb-block-canvas');
    const statusText = this._uploadStatus || (this._ecaDirty ? 'Unsaved changes' : '');
    const statusClass = `status ${this._statusKind || (this._ecaDirty ? 'dirty' : '')}`;
    return html`
      <style>${cssText}</style>
      <div class="topology-pane">
        <svg viewBox="${-VB} ${-VB} ${VB * 2} ${VB * 2}"
             preserveAspectRatio="xMidYMid meet"
             @wheel=${this._onWheel}
             @mousedown=${this._onPanDown}>
          <g style="transform: ${transform}; transform-origin: center;">
            ${this._renderBgPattern()}
            ${this._renderFaces()}
            ${this._renderHub()}
          </g>
        </svg>
        <div class="zoom-controls">
          <button class="zoom-btn" @click=${() => { this._scale = Math.min(4, this._scale * 1.2); }}>+</button>
          <button class="zoom-btn" @click=${() => this._resetView()} title="Reset view">⊙</button>
          <button class="zoom-btn" @click=${() => { this._scale = Math.max(0.3, this._scale / 1.2); }}>−</button>
          <button class="zoom-btn" @click=${() => { this.compact = !this.compact; }}
                  title="${this.compact ? 'Switch to spaced view' : 'Switch to compact hex grid'}">
            ${this.compact ? '⬡' : '⬢'}
          </button>
          <button class="zoom-btn"
                  @click=${() => this.dispatchEvent(new CustomEvent('resync', { bubbles: true, composed: true }))}
                  title="Resync topology from hub">
            ↻
          </button>
        </div>
      </div>

      <div class="divider" @mousedown=${this._onDivDown}></div>

      <div class="code-pane" style="width: ${this._codePaneW}px">
        <div class="code-header">
          ECA Rules
          <button class="mode-toggle" @click=${this._toggleEditMode}
                  title="Toggle Blockly ↔ raw JSON view">
            ${this._editMode === 'blocks' ? '{ } JSON' : '⬛ Blocks'}
          </button>
        </div>
        <div class="code-body">
          <div class="blockly-host" id="blocklyDiv"
               style="display: ${this._editMode === 'blocks' ? 'block' : 'none'}"></div>
          ${this._editMode === 'json' ? html`
            <textarea class="json-host"
                      spellcheck="false"
                      .value=${this._jsonText}
                      @input=${this._onJsonInput}></textarea>
          ` : ''}
        </div>
        <div class="code-toolbar">
          <button @click=${this._onUpload}
                  title="${this._ecaDirty ? 'Upload unsaved ECA changes to hub' : 'Upload ECA program to hub'}">
            ${this._ecaDirty ? 'Upload *' : 'Upload'}
          </button>
          <button @click=${this._onStop}>Stop</button>
          <button @click=${this._onClear}>Clear</button>
          <span class=${statusClass}>${statusText}</span>
        </div>
      </div>
    `;
  }

  // ── Blockly lifecycle ──────────────────────────────────────────────

  firstUpdated() {
    // Publish a live reference so Blockly dropdown generators can read the
    // current modules list without prop drilling.
    if (!globalThis.__wbModulesRef) {
      globalThis.__wbModulesRef = { current: this.modules };
    } else {
      globalThis.__wbModulesRef.current = this.modules;
    }
    requestAnimationFrame(() => this._initBlockly());
  }

  updated(changed) {
    if (changed.has('modules')) {
      if (!globalThis.__wbModulesRef) globalThis.__wbModulesRef = { current: this.modules };
      else globalThis.__wbModulesRef.current = this.modules;
      console.debug('[wb-block-canvas] modules prop update →',
                    (this.modules || []).map(m => ({
                      slot: m.slot, name: m.name, caps: m.capabilities,
                    })));
      this._revalidateBlocks();
      // If the workspace started empty because no sensor+LED was attached
      // yet (very common — modules stream in after Blockly inits), retry
      // the default-rule insertion now that modules have arrived.
      this._maybeInsertDefaultRule();
    }
    if (changed.has('hubProgramKnown') || changed.has('hubHasProgram')) {
      this._maybeInsertDefaultRule();
    }
    if (changed.has('highlightedUid') && this.highlightedUid != null) {
      clearTimeout(this._highlightTimer);
      this._highlightTimer = setTimeout(() => {
        this.highlightedUid = null;
      }, 3000);
    }
  }

  _initBlockly() {
    const container = this.renderRoot.querySelector('#blocklyDiv');
    if (!container || typeof Blockly === 'undefined') {
      console.warn('[wb-block-canvas] Blockly not loaded or container missing');
      return;
    }

    this._defineBlocks();

    // Diagnostics: confirm which block types actually registered. If any are
    // missing the flyout will silently render as empty for that category.
    const expected = ['eca_rule', 'sensor_condition', 'led_action',
                      'vibrate_action', 'audio_action', 'variable_action',
                      'ref_slot', 'ref_const', 'ref_var', 'ref_vc',
                      'vc_def'];
    const registered = expected.filter(t => Blockly.Blocks[t]);
    const missing    = expected.filter(t => !Blockly.Blocks[t]);
    console.info('[wb-block-canvas] Blockly version:', Blockly.VERSION || '?');
    console.info('[wb-block-canvas] registered block types:', registered);
    if (missing.length) {
      console.error('[wb-block-canvas] MISSING block types (flyout will be empty):',
                    missing);
    }

    this._workspace = Blockly.inject(container, {
      toolbox: this._getToolbox(),
      theme: this._getBlocklyTheme(),
      grid: { spacing: 20, length: 3, colour: '#1a2d4a', snap: true },
      zoom: { controls: true, wheel: true, startScale: 0.75 },
      trashcan: true,
      // 'geras' renderer is more compact than 'zelos' (which is touch-oriented
      // and needs ~700+ px to be usable). Keeps categories clickable at the
      // default 560 px pane width.
      renderer: 'geras',
    });

    // ── Shadow-DOM workaround ─────────────────────────────────
    // Blockly injects its stylesheets into document.head, which is invisible
    // to our Lit shadow root. Without this, the workspace SVG renders at 0×0
    // and the flyout appears empty. See google/blockly#1114 and
    // RaspberryPiFoundation/blockly#5230.
    this._mirrorBlocklyStylesIntoShadow();

    // Broadcast workspace state to wb-app so wb-llm-panel always has current rules.
    this._workspace.addChangeListener(evt => {
      if (evt.isUiEvent) return;
      if (evt.type === Blockly.Events.BLOCK_CHANGE && evt.blockId) {
        requestAnimationFrame(() => {
          const block = this._workspace?.getBlockById?.(evt.blockId);
          if (block) _refreshBlockDropdownLabels(block);
        });
      }
      const rules = this._workspaceToRules();
      if (!this._suppressDirty) this._autoDefaultActive = false;
      this.dispatchEvent(new CustomEvent('workspace-changed', {
        bubbles: true, composed: true,
        detail: { rules, autoDefault: this._autoDefaultActive },
      }));
      if (!this._suppressDirty) this._markDirty();
    });

    console.info('[wb-block-canvas] Blockly ready — toolbox has',
                 this._workspace.getToolbox()?.getToolboxItems()?.length ?? '?',
                 'categories');

    // Fallback UX: pre-populate the workspace with a sample rule that
    // references *real* attached modules. Skip when nothing's plugged in
    // so the user doesn't see ghost "(missing)" blocks for hardware they
    // don't have. Users can always drag from the flyout.
    if (this._pendingApplyRules) {
      const pending = this._pendingApplyRules;
      this._pendingApplyRules = null;
      this.applyRules(pending.rules, { markDirty: pending.markDirty });
    } else {
      this._insertDefaultRuleIfPossible();
    }

    requestAnimationFrame(() => {
      this._syncBlocklyTextStyles();
      Blockly.svgResize(this._workspace);
    });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => {
        if (this._workspace) Blockly.svgResize(this._workspace);
      });
      ro.observe(container);
      this._blocklyRO = ro;
    }
    if (typeof MutationObserver !== 'undefined') {
      this._blocklyMO = new MutationObserver(() => this._queueBlocklyTextSync());
      this._blocklyMO.observe(container, {
        subtree: true,
        childList: true,
      });
    }
  }

  _setUploadStatus(text, kind = '') {
    this._uploadStatus = text;
    this._statusKind = kind;
  }

  _markDirty() {
    this._clearPendingTimer();
    this._ecaDirty = true;
    this._pendingEcaAction = null;
    this._pendingUpload = null;
    this._setUploadStatus('Unsaved changes', 'dirty');
  }

  _markClean(statusText) {
    this._clearPendingTimer();
    this._ecaDirty = false;
    this._setUploadStatus(statusText, 'ok');
  }

  _clearPendingTimer() {
    if (this._pendingTimer) clearTimeout(this._pendingTimer);
    this._pendingTimer = null;
  }

  _waitForAck(action, timeoutText) {
    this._clearPendingTimer();
    this._pendingEcaAction = action;
    this._pendingTimer = setTimeout(() => {
      if (this._pendingEcaAction !== action) return;
      this._pendingEcaAction = null;
      if (action === 'upload') {
        this._pendingUpload = null;
        this._ecaDirty = true;
      }
      this._setUploadStatus(timeoutText, 'err');
    }, 8000);
  }

  _clearLocalProgram() {
    if (this._workspace) {
      this._suppressDirty = true;
      try {
        this._workspace.clear();
      } finally {
        this._suppressDirty = false;
      }
    }
    this._jsonText = '';
  }

  _handleWsMessage(msg) {
    if (!msg || msg.type !== 'command_ack') return;
    const text = String(msg.text || '');
    const ok = msg.status === 'ok';

    if (this._pendingEcaAction === 'upload'
        && (text.startsWith('P ') || text.startsWith('P loaded') || text.startsWith('P parse'))) {
      this._clearPendingTimer();
      if (ok) {
        this._lastUploadedB64 = this._pendingUpload?.b64 || '';
        const count = this._pendingUpload?.rules ?? 0;
        this._markClean(`Uploaded and running ${count} rule(s)`);
      } else {
        this._ecaDirty = true;
        this._setUploadStatus(`Upload failed: ${text}`, 'err');
      }
      this._pendingEcaAction = null;
      this._pendingUpload = null;
      return;
    }

    if (this._pendingEcaAction === 'stop'
        && (text === 'PS' || text === 'stopped')) {
      this._clearPendingTimer();
      this._pendingEcaAction = null;
      this._setUploadStatus(ok ? 'Stopped on hub' : `Stop failed: ${text}`, ok ? 'ok' : 'err');
      return;
    }

    if (this._pendingEcaAction === 'clear'
        && (text === 'PC' || text === 'cleared')) {
      this._clearPendingTimer();
      this._pendingEcaAction = null;
      if (ok) {
        this._lastUploadedB64 = '';
        this._clearLocalProgram();
        this._ecaDirty = false;
        this._setUploadStatus('Cleared on hub', 'ok');
      } else {
        this._setUploadStatus(`Clear failed: ${text}`, 'err');
      }
    }
  }

  /** Clone all Blockly-injected stylesheets from document.head into this
   *  component's shadow root. Required because Blockly assumes light-DOM
   *  rendering and otherwise its CSS doesn't pierce our shadow boundary,
   *  which leaves the workspace SVG visible-but-unstyled (= invisible). */
  _mirrorBlocklyStylesIntoShadow() {
    try {
      const styles = document.head.querySelectorAll('style');
      let cloned = 0;
      for (const s of styles) {
        const txt = s.textContent || '';
        // Match Blockly's well-known selectors. Covers blockly-common-style,
        // blockly-renderer-style-* (per renderer), and any user-defined
        // additions made via Blockly.Css.register.
        if (txt.includes('.blocklyPath')
            || txt.includes('.blocklyFlyout')
            || txt.includes('.blocklySvg')
            || txt.includes('.blocklyToolbox')
            || txt.includes('.blocklyTreeRow')) {
          this.renderRoot.appendChild(s.cloneNode(true));
          cloned++;
        }
      }
      console.info('[wb-block-canvas] mirrored', cloned,
                   'Blockly <style> blocks into shadow root');
      // Trigger a re-layout once the styles are in scope.
      requestAnimationFrame(() => Blockly.svgResize(this._workspace));
    } catch (e) {
      console.warn('[wb-block-canvas] style mirror failed:', e);
    }
  }

  /** Programmatically build the golden rule: first sensor channel > 0.5 → LED
   *  solid red. Placed in the workspace so the user has something to
   *  edit immediately, regardless of toolbox state. */
  _insertDefaultRuleIfPossible() {
    if (!this._workspace || this._defaultRuleInserted ||
        this._pendingApplyRules || !this.hubProgramKnown ||
        this.hubHasProgram) {
      return;
    }
    // Pick a real sensor + LED module currently attached. If either is
    // missing we leave the workspace empty — no ghost blocks.
    const mods = this.modules || [];
    const sensorMod = mods.find(m => m.active !== false && moduleHasRole(m, 'sensor'));
    const ledMod    = mods.find(m => m.active !== false && moduleHasRole(m, 'led'));
    if (!sensorMod || !ledMod) {
      console.info('[wb-block-canvas] no matching sensor+LED attached — workspace starts empty');
      return;
    }
    const channels = channelsForModule(sensorMod);
    const defaultCh = channels[0]?.[1] ?? '0';
    this._insertDefaultRule(sensorMod.uid, ledMod.uid, defaultCh);
    this._defaultRuleInserted = true;
  }

  _maybeInsertDefaultRule() {
    this._insertDefaultRuleIfPossible();
  }

  _insertDefaultRule(sensorUid, ledUid, channel) {
    try {
      this._autoDefaultActive = true;
      this._suppressDirty = true;
      const state = {
        blocks: {
          languageVersion: 0,
          blocks: [{
            type: 'eca_rule',
            x: 20, y: 20,
            fields: { LOGIC: 'AND' },
            inputs: {
              CONDITIONS: {
                block: {
                  type: 'sensor_condition',
                  fields: {
                    SLOT: String(sensorUid), CHANNEL: String(channel), OP: 'GT',
                    THRESHOLD: 0.5, COOLDOWN: 2000,
                  },
                },
              },
              ACTIONS: {
                block: {
                  type: 'led_action',
                  fields: {
                    SLOT: String(ledUid), CMD: 'LED_SOLID',
                    R: 255, G: 0, B: 0,
                  },
                },
              },
            },
          }],
        },
      };
      Blockly.serialization.workspaces.load(state, this._workspace);
      console.info('[wb-block-canvas] pre-loaded default rule (imu.ax > 0.5 → LED red)');
    } catch (e) {
      this._autoDefaultActive = false;
      console.warn('[wb-block-canvas] could not pre-load default rule:', e);
    } finally {
      this._suppressDirty = false;
    }
  }

  /** Replace the workspace with a serialized Blockly state. Used by the
   *  D1/D2/D3 demo buttons in <wb-status-bar> via the
   *  `wb-load-demo-program` window event. The state is a v3 serialization
   *  object as produced by `Blockly.serialization.workspaces.save`. */
  _loadProgramJson(state) {
    if (!state) return;
    if (!this._workspace) {
      // Workspace not ready yet — retry once Blockly has injected.
      setTimeout(() => this._loadProgramJson(state), 200);
      return;
    }
    try {
      this._workspace.clear();
      Blockly.serialization.workspaces.load(state, this._workspace);
      this._defaultRuleInserted = true;
      console.info('[wb-block-canvas] loaded demo program');
    } catch (e) {
      console.warn('[wb-block-canvas] could not load demo program:', e);
    }
  }

  _themeVar(name, fallback) {
    const cs = getComputedStyle(document.documentElement);
    return cs.getPropertyValue(name).trim() || fallback;
  }

  _applyBlocklyTheme() {
    if (!this._workspace || typeof Blockly === 'undefined') return;
    try {
      this._workspace.setTheme(this._getBlocklyTheme());
    } catch (e) {
      console.warn('[wb-block-canvas] Blockly theme switch failed:', e);
    }
    this._rerenderBlockly();
    this._syncBlocklyTextStyles();
    requestAnimationFrame(() => {
      this._rerenderBlockly();
      this._syncBlocklyTextStyles();
      Blockly.svgResize(this._workspace);
    });
  }

  _rerenderBlockly() {
    if (!this._workspace) return;
    for (const block of this._workspace.getAllBlocks(false)) {
      try { block.render?.(); } catch (_) {}
    }
    try {
      const toolbox = this._workspace.getToolbox?.();
      const selected = toolbox?.getSelectedItem?.();
      if (toolbox && selected) {
        toolbox.setSelectedItem?.(null);
        toolbox.setSelectedItem?.(selected);
      }
    } catch (_) {}
  }

  _syncBlocklyTextStyles() {
    const container = this.renderRoot?.querySelector('#blocklyDiv');
    if (!container) return;
    const blockText = this._themeVar('--wb-blockly-block-text', '#ffffff');
    const fieldText = this._themeVar('--wb-blockly-field-text', '#111827');
    const fieldBg = this._themeVar('--wb-blockly-field-bg', 'rgba(255, 255, 255, 0.9)');
    const fieldBorder = this._themeVar('--wb-blockly-field-border', 'rgba(0, 0, 0, 0.18)');
    const flyoutText = this._themeVar('--wb-blockly-tb-fg', '#1a1a2e');

    for (const el of container.querySelectorAll('.blocklyText')) {
      el.style.fill = blockText;
    }
    for (const el of document.querySelectorAll('.blocklyBlockDragSurface .blocklyText')) {
      el.style.fill = blockText;
    }
    for (const el of container.querySelectorAll('.blocklyEditableText .blocklyText')) {
      el.style.fill = fieldText;
    }
    for (const el of document.querySelectorAll('.blocklyBlockDragSurface .blocklyEditableText .blocklyText')) {
      el.style.fill = fieldText;
    }
    for (const el of container.querySelectorAll(
      '.blocklyEditableText > rect, .blocklyFieldRect, .blocklyNonEditableText > rect',
    )) {
      el.style.fill = fieldBg;
      el.style.stroke = fieldBorder;
    }
    for (const el of document.querySelectorAll(
      '.blocklyBlockDragSurface .blocklyEditableText > rect, .blocklyBlockDragSurface .blocklyFieldRect, .blocklyBlockDragSurface .blocklyNonEditableText > rect',
    )) {
      el.style.fill = fieldBg;
      el.style.stroke = fieldBorder;
    }
    for (const el of container.querySelectorAll('.blocklyFlyoutLabelText')) {
      el.style.fill = flyoutText;
    }
    for (const el of container.querySelectorAll('.blocklyTreeLabel')) {
      el.style.color = flyoutText;
    }
    for (const el of document.querySelectorAll('.blocklyWidgetDiv .blocklyHtmlInput')) {
      el.style.background = fieldBg;
      el.style.color = fieldText;
      el.style.borderColor = fieldBorder;
    }
  }

  _queueBlocklyTextSync() {
    if (this._syncBlocklyTextQueued) return;
    this._syncBlocklyTextQueued = true;
    requestAnimationFrame(() => {
      this._syncBlocklyTextQueued = false;
      this._syncBlocklyTextStyles();
    });
  }

  _getBlocklyTheme() {
    const v = (name, fb) => this._themeVar(name, fb);
    const themeMode = (window.themeController && window.themeController.current()) || 'light';
    const cached = BLOCKLY_THEME_CACHE.get(themeMode);
    if (cached) return cached;
    const theme = Blockly.Theme.defineTheme('wearblocks_' + themeMode, {
      base: Blockly.Themes.Classic,
      componentStyles: {
        workspaceBackgroundColour: v('--wb-blockly-ws-bg', '#ffffff'),
        toolboxBackgroundColour:   v('--wb-blockly-tb-bg', '#f4f6fa'),
        toolboxForegroundColour:   v('--wb-blockly-tb-fg', '#1a1a2e'),
        flyoutBackgroundColour:    v('--wb-blockly-tb-bg', '#f4f6fa'),
        flyoutForegroundColour:    v('--wb-blockly-tb-fg', '#1a1a2e'),
        scrollbarColour:           v('--wb-blockly-scroll', '#cdd3de'),
      },
    });
    BLOCKLY_THEME_CACHE.set(themeMode, theme);
    return theme;
  }

  _defineBlocks() {
    Blockly.Blocks['eca_rule'] = {
      init() {
        this.appendStatementInput('CONDITIONS').setCheck('condition').appendField('IF');
        this.appendDummyInput().appendField(new Blockly.FieldDropdown([
          ['ALL match (AND)', 'AND'], ['ANY matches (OR)', 'OR'],
        ]), 'LOGIC');
        this.appendStatementInput('ACTIONS').setCheck('action').appendField('THEN');
        this.setColour(210);
        this.setTooltip('ECA rule: IF conditions THEN actions');
      },
    };

    Blockly.Blocks['sensor_condition'] = {
      init() {
        const self = this;
        const slotField = new Blockly.FieldDropdown(() => {
          const opts = slotOptions('sensor');
          return withGhost(opts, self.getFieldValue?.('SLOT'));
        });
        const channelField = new Blockly.FieldDropdown(() => {
          const slotVal = self.getFieldValue?.('SLOT') ?? '0';
          const opts = channelOptionsForSlot(slotVal);
          return withGhost(opts, self.getFieldValue?.('CHANNEL'));
        });
        this.appendDummyInput()
          .appendField('when')
          .appendField(slotField, 'SLOT')
          .appendField('.')
          .appendField(channelField, 'CHANNEL')
          .appendField(new Blockly.FieldDropdown([
            ['>', 'GT'], ['<', 'LT'], ['>=', 'GTE'],
            ['<=', 'LTE'], ['=', 'EQ'], ['!=', 'NEQ'],
          ]), 'OP')
          .appendField(new Blockly.FieldNumber(1.0), 'THRESHOLD');
        // Optional ref input — when connected, overrides SLOT/CHANNEL above.
        // Backward-compatible: legacy saves have no REF child and behave as before.
        this.appendValueInput('REF')
          .setCheck('ref')
          .appendField('or ref');
        this.appendDummyInput()
          .appendField('cooldown')
          .appendField(new Blockly.FieldNumber(2000, 0), 'COOLDOWN')
          .appendField('ms  hold')
          .appendField(new Blockly.FieldNumber(0, 0), 'HOLD')
          .appendField('ms');
        this.setPreviousStatement(true, 'condition');
        this.setNextStatement(true, 'condition');
        this.setColour(230);
        // Re-render CHANNEL when SLOT changes so the options match the new module.
        // forceRerender alone isn't enough: Blockly caches the value→label map
        // until the dropdown reopens, so a stale label can display (and the
        // saved CHANNEL id may no longer be valid for the new module). Re-run
        // the generator and switch to the first valid option if needed.
        this.setOnChange(evt => {
          if (evt?.type === Blockly.Events.BLOCK_CHANGE &&
              evt.blockId === self.id && evt.name === 'SLOT') {
            const newSlot = self.getFieldValue('SLOT') ?? '0';
            const opts = channelOptionsForSlot(newSlot);
            const currentCh = self.getFieldValue('CHANNEL');
            if (!opts.some(([, v]) => v === currentCh)) {
              self.setFieldValue(opts[0]?.[1] ?? '0', 'CHANNEL');
            } else {
              self.getField('CHANNEL')?.forceRerender?.();
            }
          }
        });
      },
    };

    Blockly.Blocks['led_action'] = {
      init() {
        const self = this;
        const slotField = new Blockly.FieldDropdown(() => {
          const opts = slotOptions('led');
          return withGhost(opts, self.getFieldValue?.('SLOT'));
        });
        this.appendDummyInput()
          .appendField('LED on')
          .appendField(slotField, 'SLOT')
          .appendField(new Blockly.FieldDropdown(LED_CMD_OPTIONS), 'CMD');
        // R/G/B are inlets: each can take a literal number OR a connected
        // ref_* block (slot/vc/var). The ref wins at compile time. Input
        // name carries the _REF suffix; the embedded FieldNumber keeps the
        // bare channel name so existing saves load unchanged.
        this.appendValueInput('R_REF').setCheck('ref')
          .setAlign(Blockly.ALIGN_RIGHT)
          .appendField('R').appendField(new Blockly.FieldNumber(255, 0, 255), 'R');
        this.appendValueInput('G_REF').setCheck('ref')
          .setAlign(Blockly.ALIGN_RIGHT)
          .appendField('G').appendField(new Blockly.FieldNumber(255, 0, 255), 'G');
        this.appendValueInput('B_REF').setCheck('ref')
          .setAlign(Blockly.ALIGN_RIGHT)
          .appendField('B').appendField(new Blockly.FieldNumber(255, 0, 255), 'B');
        this.setPreviousStatement(true, 'action');
        this.setNextStatement(true, 'action');
        this.setColour(0);
      },
    };

    Blockly.Blocks['vibrate_action'] = {
      init() {
        const self = this;
        const slotField = new Blockly.FieldDropdown(() => {
          const opts = slotOptions('vib');
          return withGhost(opts, self.getFieldValue?.('SLOT'));
        });
        this.appendDummyInput()
          .appendField('Vibrate on')
          .appendField(slotField, 'SLOT')
          .appendField(new Blockly.FieldDropdown(VIB_CMD_OPTIONS), 'CMD');
        this.appendDummyInput()
          .appendField('intensity').appendField(new Blockly.FieldNumber(80, 0, 100), 'INTENSITY')
          .appendField('%  dur').appendField(new Blockly.FieldNumber(300, 0, 65535), 'DURATION')
          .appendField('ms');
        this.setPreviousStatement(true, 'action');
        this.setNextStatement(true, 'action');
        this.setColour(130);
      },
    };

    Blockly.Blocks['audio_action'] = {
      init() {
        const self = this;
        const slotField = new Blockly.FieldDropdown(() => {
          const opts = slotOptions('audio');
          return withGhost(opts, self.getFieldValue?.('SLOT'));
        });
        this.appendDummyInput()
          .appendField('Audio on')
          .appendField(slotField, 'SLOT')
          .appendField(new Blockly.FieldDropdown(AUDIO_CMD_OPTIONS), 'CMD');
        // FREQ / AMP are inlets: each accepts a literal number OR a
        // connected ref_* block (slot/vc/var). Same pattern as led_action's
        // R/G/B inlets — enables theremin (IMU axis → freq) via ref_slot.
        this.appendValueInput('FREQ_REF').setCheck('ref')
          .setAlign(Blockly.ALIGN_RIGHT)
          .appendField('freq').appendField(new Blockly.FieldNumber(440, 0, 20000), 'FREQ').appendField('Hz');
        this.appendValueInput('AMP_REF').setCheck('ref')
          .setAlign(Blockly.ALIGN_RIGHT)
          .appendField('amp').appendField(new Blockly.FieldNumber(128, 0, 255), 'AMP');
        this.setPreviousStatement(true, 'action');
        this.setNextStatement(true, 'action');
        this.setColour(AUDIO_MODULE_COLOR);
      },
    };

    Blockly.Blocks['variable_action'] = {
      init() {
        this.appendDummyInput()
          .appendField(new Blockly.FieldDropdown([
            ['set', 'VAR_SET'], ['increment', 'VAR_INC'],
            ['reset', 'VAR_RESET'], ['toggle', 'VAR_TOGGLE'],
          ]), 'CMD')
          .appendField('var')
          .appendField(new Blockly.FieldNumber(0, 0, 7), 'VAR_ID')
          .appendField('by')
          .appendField(new Blockly.FieldNumber(1.0), 'AMOUNT');
        this.setPreviousStatement(true, 'action');
        this.setNextStatement(true, 'action');
        this.setColour(60);
      },
    };

    // ── Ref blocks (Phase 1) ────────────────────────────────────────
    // Output `ref`; consumed by sensor_condition.REF (and later VCs).
    // When left unconnected, sensor_condition falls back to its legacy
    // SLOT/CHANNEL dropdowns — keeps all pre-existing workspaces working.

    Blockly.Blocks['ref_slot'] = {
      init() {
        const self = this;
        const slotField = new Blockly.FieldDropdown(() => {
          const opts = slotOptions('sensor');
          return withGhost(opts, self.getFieldValue?.('SLOT'));
        });
        const channelField = new Blockly.FieldDropdown(() => {
          const slotVal = self.getFieldValue?.('SLOT') ?? '0';
          const opts = channelOptionsForSlot(slotVal);
          return withGhost(opts, self.getFieldValue?.('CHANNEL'));
        });
        this.appendDummyInput()
          .appendField('slot')
          .appendField(slotField, 'SLOT')
          .appendField('·')
          .appendField(channelField, 'CHANNEL');
        this.setOutput(true, 'ref');
        this.setColour(230);
        this.setTooltip('Reference to a live sensor channel');
        this.setOnChange(evt => {
          if (evt?.type === Blockly.Events.BLOCK_CHANGE &&
              evt.blockId === self.id && evt.name === 'SLOT') {
            const newSlot = self.getFieldValue('SLOT') ?? '0';
            const opts = channelOptionsForSlot(newSlot);
            const currentCh = self.getFieldValue('CHANNEL');
            if (!opts.some(([, v]) => v === currentCh)) {
              self.setFieldValue(opts[0]?.[1] ?? '0', 'CHANNEL');
            } else {
              self.getField('CHANNEL')?.forceRerender?.();
            }
          }
        });
      },
    };

    Blockly.Blocks['ref_const'] = {
      init() {
        this.appendDummyInput()
          .appendField('const')
          .appendField(new Blockly.FieldNumber(0), 'VALUE');
        this.setOutput(true, 'ref');
        this.setColour(20);
        this.setTooltip('Literal constant value');
      },
    };

    Blockly.Blocks['ref_var'] = {
      init() {
        this.appendDummyInput()
          .appendField('var')
          .appendField(new Blockly.FieldNumber(0, 0, 7, 1), 'VAR_ID');
        this.setOutput(true, 'ref');
        this.setColour(60);
        this.setTooltip('Reference to internal variable 0-7');
      },
    };

    Blockly.Blocks['ref_vc'] = {
      init() {
        const self = this;
        // Dynamic dropdown: reads live vc_def blocks from the workspace.
        // Labels are "vcN: OP" (e.g. "vc0: DIFF"). Stale ids are kept
        // visible via withGhost so saves from a deleted VC still load.
        const vcField = new Blockly.FieldDropdown(() => {
          const opts = vcOptionsFromWorkspace(self.workspace);
          return withGhost(opts, self.getFieldValue?.('VC_ID'));
        });
        this.appendDummyInput()
          .appendField('vc')
          .appendField(vcField, 'VC_ID');
        this.setOutput(true, 'ref');
        this.setColour(300);
        this.setTooltip('Reference to a virtual channel defined on the workspace');
      },
    };

    // ── Virtual channel definition (Phase 2) ────────────────────────
    // vc_def sits at workspace root. Its vc_id is its 0-based position
    // among all vc_def blocks at encode time — no explicit id field, no
    // collision risk. A/B accept any `ref` block; B_CONST / C_CONST are
    // literal floats (semantics per VC op, see WearBlocksECA.h:91-96).

    Blockly.Blocks['vc_def'] = {
      init() {
        this.appendDummyInput()
          .appendField('vc :=')
          .appendField(new Blockly.FieldDropdown([
            ['a + b',        'ADD'],
            ['a - b',        'SUB'],
            ['a × b',        'MUL'],
            ['a ÷ b',        'DIV'],
            ['|a|',          'ABS'],
            ['-a',           'NEG'],
            ['min(a,b)',     'MIN'],
            ['max(a,b)',     'MAX'],
            ['map(a,b→c)',   'MAP'],
            ['clamp(a,b,c)', 'CLAMP'],
            ['a(t)-a(t-1)',  'DIFF'],
          ]), 'OP');
        this.appendValueInput('A').setCheck('ref').appendField('a');
        this.appendValueInput('B').setCheck('ref').appendField('b');
        this.appendDummyInput()
          .appendField('b_const')
          .appendField(new Blockly.FieldNumber(0), 'B_CONST')
          .appendField('c_const')
          .appendField(new Blockly.FieldNumber(0), 'C_CONST');
        this.setColour(300);
        this.setTooltip('Virtual channel: reusable computed signal');
      },
    };
  }

  _getToolbox() {
    return {
      kind: 'categoryToolbox',
      contents: [
        { kind: 'category', name: 'Rules',     colour: 210, contents: [{ kind: 'block', type: 'eca_rule' }] },
        { kind: 'category', name: 'Sensors',   colour: 230, contents: [{ kind: 'block', type: 'sensor_condition' }] },
        { kind: 'category', name: 'Refs',      colour: 260, contents: [
          { kind: 'block', type: 'ref_slot' },
          { kind: 'block', type: 'ref_const' },
          { kind: 'block', type: 'ref_var' },
          { kind: 'block', type: 'ref_vc' },
        ] },
        { kind: 'category', name: 'Virtual Channels', colour: 300, contents: [
          { kind: 'block', type: 'vc_def' },
        ] },
        { kind: 'category', name: 'LED',       colour: 0,   contents: [{ kind: 'block', type: 'led_action' }] },
        { kind: 'category', name: 'Vibration', colour: 130, contents: [{ kind: 'block', type: 'vibrate_action' }] },
        { kind: 'category', name: 'Sound',     colour: AUDIO_MODULE_COLOR, contents: [{ kind: 'block', type: 'audio_action' }] },
        { kind: 'category', name: 'Variables', colour: 60,  contents: [{ kind: 'block', type: 'variable_action' }] },
      ],
    };
  }

  // ── Workspace → JSON Rules ─────────────────────────────────────────

  /** Decode a ref_* Blockly block into the JSON ref shape used by
   *  eca-encoder. Returns null for unconnected or unknown blocks.
   *  ref_const carries its literal via a `value` side-band field that
   *  callers can read for threshold / b_const overrides. */
  /** Decode a ref_* Blockly block into the JSON ref shape used by
   *  eca-encoder. Returns null for unconnected or unknown blocks.
   *  ref_const carries its literal via a `value` side-band field that
   *  callers can read for threshold / b_const overrides.
   *
   *  v3: id is the module UID hex string for SLOT, or vc_id/var_id
   *  integer for VC/VAR. Encoder accepts either string or number.
   */
  _refFromBlock(block) {
    if (!block) return null;
    switch (block.type) {
      case 'ref_slot':
        return { type: REF.SLOT,
                 id:   block.getFieldValue('SLOT'),  // uid hex string
                 ch:   parseInt(block.getFieldValue('CHANNEL')) };
      case 'ref_var':
        return { type: REF.VAR,
                 id:   parseInt(block.getFieldValue('VAR_ID')),
                 ch:   0 };
      case 'ref_vc':
        return { type: REF.VC,
                 id:   parseInt(block.getFieldValue('VC_ID')),
                 ch:   0 };
      case 'ref_const':
        return { type: REF.CONST, id: 0, ch: 0,
                 value: parseFloat(block.getFieldValue('VALUE')) };
      default:
        return null;
    }
  }

  /** Collect all vc_def blocks in deterministic workspace order and
   *  encode them. vc_id is the 0-based index — no explicit id field,
   *  no collision risk. ref_vc dropdowns elsewhere read the same order. */
  _collectVirtualChannels() {
    if (!this._workspace) return [];
    const defs = this._workspace.getBlocksByType('vc_def', false);
    const vcs = [];
    defs.forEach((b, i) => {
      const op = b.getFieldValue('OP') || 'ADD';
      const aBlock = b.getInputTargetBlock?.('A');
      const bBlock = b.getInputTargetBlock?.('B');
      const a = this._refFromBlock(aBlock) || { type: REF.SLOT, id: 0, ch: 0 };
      const bRef = this._refFromBlock(bBlock);
      // b_const: ref_const on input B wins; else the on-block field.
      const bConst = (bRef && bRef.type === REF.CONST)
        ? bRef.value
        : parseFloat(b.getFieldValue('B_CONST') || '0');
      const bFinal = bRef
        ? { type: bRef.type, id: bRef.id, ch: bRef.ch, value: bConst }
        : { type: REF.CONST, id: 0, ch: 0, value: bConst };
      vcs.push({
        vc_id: i,
        op,
        a: { type: a.type, id: a.id, ch: a.ch },
        b: bFinal,
        c_const: parseFloat(b.getFieldValue('C_CONST') || '0'),
      });
    });
    return vcs;
  }

  /** Replace the entire workspace with rules from JSON.
   *  markDirty=false is used when loading a program that already lives on the
   *  hub; LLM/generated local changes keep the default dirty behavior. */
  applyRules(rules, { markDirty = true } = {}) {
    if (!rules) return false;
    if (!this._workspace) {
      this._pendingApplyRules = { rules, markDirty };
      return true;
    }
    try {
      console.log('[applyRules] rules:', rules);
      console.log('[applyRules] modules:', this.modules);
      const resolved = _resolveRulesAgainstLiveSchema(rules, this.modules || []);
      const state = _rulesStateFromJSON(resolved.rules, this.modules || []);
      const dropdownGhosts = _dropdownGhostsForRules(resolved.rules);
      console.log('[applyRules] generated state:', state);
      this._suppressDirty = true;
      this._autoDefaultActive = false;
      setDropdownGhosts(dropdownGhosts);
      Blockly.serialization.workspaces.load(state, this._workspace);
      // ref_vc dropdowns cache their label from the first time the generator
      // runs. If a ref_vc block was created before its target vc_def existed
      // (which happens when both are in the same load), the cached label is
      // "— no vcs —". Force every ref_vc to re-render now that all vc_def
      // blocks are on the workspace.
      for (const b of this._workspace.getBlocksByType('ref_vc', false)) {
        b.getField?.('VC_ID')?.forceRerender?.();
      }
      const bindingMessage = _bindingDiagnosticMessage(resolved.diagnostics);
      const stale = this._revalidateBlocks();
      this._defaultRuleInserted = true;
      if (markDirty) {
        this._markDirty();
        if (bindingMessage || stale > 0) {
          this._setUploadStatus(bindingMessage || `${stale} missing/invalid reference(s)`, 'err');
        }
      } else {
        this._ecaDirty = false;
        this._setUploadStatus(bindingMessage || (stale > 0
          ? `${stale} missing/invalid reference(s)`
          : 'Loaded from hub'),
          (bindingMessage || stale > 0) ? 'err' : 'ok');
      }
    } catch (e) {
      console.error('[wb-block-canvas] applyRules failed:', e);
      this._setUploadStatus(`Load failed: ${e.message || e}`, 'err');
      return false;
    } finally {
      setDropdownGhosts(null);
      this._suppressDirty = false;
    }
    return true;
  }

  _workspaceToRules() {
    const ruleBlocks = this._workspace.getBlocksByType('eca_rule', false);
    if (ruleBlocks.length === 0) return null;

    const rules = [];
    for (const rb of ruleBlocks) {
      const logic = rb.getFieldValue('LOGIC') || 'AND';

      const conditions = [];
      let condBlock = rb.getInputTargetBlock('CONDITIONS');
      while (condBlock) {
        if (condBlock.type === 'sensor_condition') {
          const refBlock = condBlock.getInputTargetBlock?.('REF');
          let ref;
          let threshold = parseFloat(condBlock.getFieldValue('THRESHOLD'));
          if (refBlock) {
            const decoded = this._refFromBlock(refBlock);
            if (decoded?.type === REF.CONST) {
              // CONST as lhs: the const value moves into the threshold slot
              // so the engine compares const-vs-(some other const). Mostly
              // useful for always-true / always-false rules.
              ref = { type: REF.CONST, id: 0, ch: 0 };
              threshold = decoded.value;
            } else if (decoded) {
              ref = { type: decoded.type, id: decoded.id, ch: decoded.ch };
            } else {
              ref = { type: REF.SLOT, id: 0, ch: 0 };
            }
          } else {
            // Legacy path: use the on-block dropdowns. SLOT field stores
            // a uid hex string in v3 (was integer slot in v1/v2).
            ref = {
              type: REF.SLOT,
              id: condBlock.getFieldValue('SLOT'),
              ch: parseInt(condBlock.getFieldValue('CHANNEL')),
            };
          }
          conditions.push({
            ref,
            op: condBlock.getFieldValue('OP'),
            threshold,
            hold_ms: parseInt(condBlock.getFieldValue('HOLD') || '0'),
            cooldown_ms: parseInt(condBlock.getFieldValue('COOLDOWN')),
          });
        }
        condBlock = condBlock.getNextBlock();
      }

      const actions = [];
      let actBlock = rb.getInputTargetBlock('ACTIONS');
      // Helper: wrap a literal number as a CONST action param.
      const constParam = (v) => ({ type: REF.CONST, id: 0, ch: 0, value: Number(v) || 0 });
      // Helper: an action's R/G/B inlets accept either a number field OR a
      // connected ref_* block. The ref wins if present. Input name uses a
      // _REF suffix; the literal FieldNumber stays on the bare channel name.
      const rgbParam = (block, fieldName) => {
        const refBlock = block.getInputTargetBlock?.(`${fieldName}_REF`);
        if (refBlock) {
          const decoded = this._refFromBlock(refBlock);
          if (decoded?.type === REF.CONST) return { ...decoded };
          if (decoded) return { type: decoded.type, id: decoded.id, ch: decoded.ch, value: 0 };
        }
        return constParam(block.getFieldValue(fieldName));
      };
      while (actBlock) {
        if (actBlock.type === 'led_action') {
          const cmd = actBlock.getFieldValue('CMD');
          // SLOT field stores a uid hex string (v3); legacy saves with
          // integer slots will get them passed through as-is to the encoder
          // which will parse '0' or NaN → 0.
          const target = actBlock.getFieldValue('SLOT');
          let params = [];
          if (cmd === 'LED_OFF' || cmd === 'LED_STOP') {
            params = [];
          } else {
            // SOLID (and reserved RAMP/BREATHE/BLINK/RAINBOW): R, G, B as
            // typed inlets. Module_led v3 honors only the first 3 bytes.
            params = [
              rgbParam(actBlock, 'R'),
              rgbParam(actBlock, 'G'),
              rgbParam(actBlock, 'B'),
            ];
          }
          actions.push({ target, cmd, params });
        } else if (actBlock.type === 'vibrate_action') {
          const cmd = actBlock.getFieldValue('CMD');
          const target = actBlock.getFieldValue('SLOT');
          let params = [];
          if (cmd === 'VIBRATE_STOP') {
            params = [];
          } else {
            params = [
              constParam(actBlock.getFieldValue('INTENSITY')),
              constParam(actBlock.getFieldValue('DURATION')),
            ];
          }
          actions.push({ target, cmd, params });
        } else if (actBlock.type === 'audio_action') {
          const cmd = actBlock.getFieldValue('CMD');
          const target = actBlock.getFieldValue('SLOT');
          let params = [];
          if (cmd === 'AUDIO_STOP') {
            params = [];
          } else {
            // FREQ / AMP support ref_* inlets (theremin: VC drives freq).
            params = [
              rgbParam(actBlock, 'FREQ'),
              rgbParam(actBlock, 'AMP'),
            ];
          }
          actions.push({ target, cmd, params });
        } else if (actBlock.type === 'variable_action') {
          const cmd = actBlock.getFieldValue('CMD');
          // VAR_*: target's low byte = var_id (small integer 0-7).
          const target = parseInt(actBlock.getFieldValue('VAR_ID'));
          let params = [];
          if (cmd === 'VAR_INC' || cmd === 'VAR_SET') {
            params = [constParam(actBlock.getFieldValue('AMOUNT'))];
          }
          actions.push({ target, cmd, params });
        }
        actBlock = actBlock.getNextBlock();
      }

      if (conditions.length > 0 && actions.length > 0) {
        rules.push({ conditions, logic, actions });
      }
    }

    return { version: 3, variables: [],
             virtual_channels: this._collectVirtualChannels(), rules };
  }

  // ── Upload / Stop / Clear ──────────────────────────────────────────

  /**
   * Walk every block in the workspace, set or clear warningText based on
   * whether the referenced slot / channel / actuator role is still present
   * in the live `modules` list, and force on-block dropdowns to re-render.
   * Returns the count of blocks that are currently stale (warningText set).
   */
  _revalidateBlocks() {
    if (!this._workspace) return 0;
    const mods = this.modules || [];
    let stale = 0;
    for (const block of this._workspace.getAllBlocks(false)) {
      if (block.isInsertionMarker?.()) continue;
      let warning = null;
      const type = block.type;
      if (type === 'sensor_condition' && block.getInputTargetBlock?.('REF')) {
        // Connected REF overrides the legacy SLOT/CHANNEL fields. The child
        // ref_slot block, if present, validates its own physical module.
        warning = null;
      } else if (type === 'sensor_condition' || type === 'ref_slot' ||
                 type === 'led_action' || type === 'vibrate_action' ||
                 type === 'audio_action') {
        // SLOT field stores a uid hex string (v3) or legacy integer slot.
        const key = String(block.getFieldValue('SLOT') || '0');
        const mod = mods.find(m => m && m.active !== false && moduleMatchesKey(m, key));
        const role = (type === 'sensor_condition' || type === 'ref_slot') ? 'sensor'
                   : type === 'led_action'                                ? 'led'
                   : type === 'audio_action'                              ? 'audio'
                   : 'vib';
        if (!key || key === '0' || !mod) {
          warning = `No ${role} for ${key || '?'}`;
        } else if (!moduleHasRole(mod, role)) {
          warning = `${slotLabel(mod)} has no ${role}`;
        } else if (type === 'sensor_condition' || type === 'ref_slot') {
          const ch = String(block.getFieldValue('CHANNEL') || '0');
          const channels = channelsForModule(mod);
          if (!channels.some(([, id]) => id === ch)) {
            warning = `Channel ${ch} unavailable on ${slotLabel(mod)}`;
          }
        }
      }
      block.setWarningText?.(warning);
      if (warning) stale++;
      _refreshBlockDropdownLabels(block);
    }
    // Also refresh the flyout so previews pick up the new module list.
    try {
      const toolbox = this._workspace.getToolbox?.();
      const selected = toolbox?.getSelectedItem?.();
      if (toolbox && selected) {
        // Reselecting the current category forces Blockly to rebuild the
        // flyout blocks, which re-runs our dropdown generators with the
        // up-to-date __wbModulesRef.current.
        toolbox.setSelectedItem?.(null);
        toolbox.setSelectedItem?.(selected);
      }
    } catch (_) {}
    return stale;
  }

  /** Resolve the JSON program to upload, picking the source matching the
   *  current edit mode. Returns null and updates upload status on failure. */
  _resolveProgram() {
    if (this._editMode === 'json') {
      const text = (this._jsonText || '').trim();
      if (!text) {
        this._setUploadStatus('JSON is empty', 'err');
        return null;
      }
      try {
        const program = JSON.parse(text);
        if (!program || !Array.isArray(program.rules) || program.rules.length === 0) {
          this._setUploadStatus('JSON has no rules', 'err');
          return null;
        }
        const resolved = _resolveRulesAgainstLiveSchema(program, this.modules || []);
        const bindingMessage = _bindingDiagnosticMessage(resolved.diagnostics);
        if (bindingMessage) {
          this._setUploadStatus(bindingMessage, 'err');
          return null;
        }
        return resolved.rules;
      } catch (e) {
        this._setUploadStatus(`JSON parse error: ${e.message}`, 'err');
        return null;
      }
    }
    const program = this._workspaceToRules();
    if (!program || program.rules.length === 0) {
      this._setUploadStatus('No rules to upload', 'err');
      return null;
    }
    // Final hot-swap check: refuse upload when any block still carries a
    // warning (missing module, stale channel, wrong role).
    const stale = this._revalidateBlocks();
    if (stale > 0) {
      this._setUploadStatus(
        `${stale} block(s) reference missing/invalid modules — fix and retry`,
        'err',
      );
      return null;
    }
    return program;
  }

  _onUpload = () => {
    const program = this._resolveProgram();
    if (!program) return;
    const b64 = programToBase64(program);
    this._pendingUpload = { b64, rules: program.rules.length };
    if (!wsClient.send({ action: 'program', data: b64 })) {
      this._pendingUpload = null;
      this._ecaDirty = true;
      this._setUploadStatus('Upload failed: bridge not connected', 'err');
      return;
    }
    this._waitForAck('upload', 'Upload failed: no hub response');
    this._setUploadStatus(`Uploading ${program.rules.length} rule(s)...`, 'pending');
  };

  _onStop = () => {
    if (!wsClient.send({ action: 'program_stop' })) {
      this._setUploadStatus('Stop failed: bridge not connected', 'err');
      return;
    }
    this._waitForAck('stop', 'Stop failed: no hub response');
    this._setUploadStatus('Stopping on hub...', 'pending');
  };

  _onClear = () => {
    if (!wsClient.send({ action: 'program_clear' })) {
      this._setUploadStatus('Clear failed: bridge not connected', 'err');
      return;
    }
    this._waitForAck('clear', 'Clear failed: no hub response');
    this._setUploadStatus('Clearing on hub...', 'pending');
  };

  _toggleEditMode = () => {
    if (this._editMode === 'blocks') {
      // Snapshot current workspace as JSON so the user has a starting point.
      const program = this._workspaceToRules() || {
        version: 3, variables: [], virtual_channels: [], rules: [],
      };
      this._jsonText = JSON.stringify(program, null, 2);
      this._editMode = 'json';
      this._uploadStatus = 'Editing JSON (changes here are NOT synced back to blocks)';
    } else {
      this._editMode = 'blocks';
      this._uploadStatus = 'Editing blocks';
      // Re-render Blockly into the (now visible again) host on next frame.
      requestAnimationFrame(() => {
        if (this._workspace) Blockly.svgResize(this._workspace);
      });
    }
  };

  _onJsonInput = (e) => {
    this._jsonText = e.target.value;
    this._markDirty();
  };
}

customElements.define('wb-block-canvas', WbBlockCanvas);

// ── LLM rules → Blockly serialization state ──────────────────────────────────

function _invertEnum(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[v] = k;
  return out;
}

const VC_OP_NAME = _invertEnum(VC_OP);
const COND_OP_NAME = _invertEnum(COND_OP);
const LOGIC_NAME = _invertEnum(LOGIC);
const ACT_NAME = _invertEnum(ACT);

function _enumName(value, lookup, fallback) {
  if (typeof value === 'string') return value;
  if (value == null) return fallback;
  return lookup[value] || fallback;
}

function _cloneRules(rules) {
  return JSON.parse(JSON.stringify(rules || {
    version: 3, variables: [], virtual_channels: [], rules: [],
  }));
}

function _dropdownGhostsForRules(rules) {
  const slots = { sensor: [], led: [], vib: [], audio: [] };
  const slotSeen = {
    sensor: new Set(),
    led: new Set(),
    vib: new Set(),
    audio: new Set(),
  };
  const channels = {};

  const addSlot = (role, value) => {
    if (!role || !slots[role]) return;
    const raw = String(value ?? '').trim();
    if (!normalizeUid(raw) || slotSeen[role].has(raw)) return;
    slotSeen[role].add(raw);
    slots[role].push(raw);
  };
  const addChannel = (value, ch) => {
    const raw = String(value ?? '').trim();
    const uid = normalizeUid(raw);
    if (!uid || ch == null) return;
    const channelValue = String(ch);
    for (const key of new Set([raw, uid])) {
      if (!channels[key]) channels[key] = [];
      if (!channels[key].includes(channelValue)) channels[key].push(channelValue);
    }
  };
  const addRef = (ref) => {
    if (!ref) return;
    const type = ref.type ?? REF.SLOT;
    if (type !== REF.SLOT) return;
    const raw = ref.id ?? ref.uid ?? ref.slot;
    addSlot('sensor', raw);
    addChannel(raw, ref.ch);
  };

  for (const vc of rules?.virtual_channels || []) {
    addRef(vc?.a);
    addRef(vc?.b);
  }
  for (const rule of rules?.rules || []) {
    for (const cond of rule.conditions || []) addRef(cond?.ref);
    for (const act of rule.actions || []) {
      if (!_isVarActionCmd(act?.cmd)) {
        addSlot(_roleForActionCmd(act?.cmd), act?.target ?? act?.uid ?? act?.slot);
      }
      for (const param of act.params || []) addRef(param);
    }
  }

  return { slots, channels };
}

function _refreshBlockDropdownLabels(block) {
  for (const input of block?.inputList || []) {
    for (const field of input.fieldRow || []) {
      if (field?.menuGenerator_ && typeof field.menuGenerator_ === 'function') {
        _refreshDropdownFieldLabel(field);
      }
    }
  }
}

function _refreshDropdownFieldLabel(field) {
  if (!field || typeof field.getValue !== 'function') return;
  const current = String(field.getValue() ?? '');
  const currentUid = normalizeUid(current);
  if ('generatedOptions' in field) field.generatedOptions = null;
  if ('generatedOptions_' in field) field.generatedOptions_ = null;
  let options = [];
  try {
    if (typeof field.getOptions === 'function') {
      options = field.getOptions(false) || [];
    } else if (typeof field.menuGenerator_ === 'function') {
      options = field.menuGenerator_() || [];
    }
  } catch (_) {
    options = [];
  }
  const option = options.find(([, value]) => String(value) === current)
    || (currentUid
      ? options.find(([, value]) => normalizeUid(value) === currentUid)
      : null);
  if (option && typeof field.doValueUpdate_ === 'function') {
    field.doValueUpdate_(String(option[1]));
  }
  const liveModule = currentUid
    ? (globalThis.__wbModulesRef?.current || [])
        .find(m => m && m.active !== false && normalizeUid(m.uid) === currentUid)
    : null;
  const label = liveModule
    ? slotLabel(liveModule)
    : (option ? String(option[0]) : '');
  if (label) _setDropdownFieldDisplayText(field, label);
  field.forceRerender?.();
}

function _setDropdownFieldDisplayText(field, label) {
  if (typeof field.setText === 'function') {
    field.setText(label);
  } else if (typeof field.setText_ === 'function') {
    field.setText_(label);
  } else if (field.textElement_) {
    field.textElement_.textContent = label;
  }
}

function _lookupToken(value) {
  return String(value ?? '').trim().replace(/^@/, '').toLowerCase();
}

const MODULE_TOKEN_ALIASES = {
  imu: ['imu', 'motion', 'motion_sensing', 'acceleration', 'angular_velocity'],
  motion: ['imu', 'motion', 'motion_sensing', 'acceleration', 'angular_velocity'],
  light: ['light', 'light_sensing'],
  ldr: ['light', 'light_sensing'],
  knob: ['knob', 'input', 'input_control', 'rotary'],
  rotary: ['knob', 'input', 'input_control', 'rotary'],
  led: ['led', 'visual', 'visual_output', 'rgb'],
  rgb: ['led', 'visual', 'visual_output', 'rgb'],
  vib: ['vib', 'vibration', 'haptic', 'haptic_output'],
  vibration: ['vib', 'vibration', 'haptic', 'haptic_output'],
  haptic: ['vib', 'vibration', 'haptic', 'haptic_output'],
  audio: ['audio', 'audio_output', 'speaker', 'tone'],
  speaker: ['audio', 'audio_output', 'speaker', 'tone'],
  sensor: ['sensor'],
};

function _moduleSearchTokens(mod) {
  const tokens = new Set();
  const add = (value) => {
    const token = _lookupToken(value);
    if (token) tokens.add(token);
  };

  add(mod?.id);
  add(mod?.name);
  add(mod?.descriptor?.id);
  add(mod?.descriptor?.moduleId);
  add(mod?.descriptor?.name);
  add(mod?.descriptor?.type);
  add(mod?.descriptor?.cat);
  add(mod?.descriptor?.category);

  for (const cap of mod?.capabilities || []) add(cap);
  for (const cap of mod?.descriptor?.caps || []) {
    add(cap?.m);
    add(cap?.modality);
    add(cap?.type);
  }

  if (moduleHasRole(mod, 'sensor')) tokens.add('sensor');
  if (moduleHasRole(mod, 'led')) tokens.add('led');
  if (moduleHasRole(mod, 'vib')) {
    tokens.add('vib');
    tokens.add('vibration');
  }
  if (moduleHasRole(mod, 'audio')) tokens.add('audio');

  if (tokens.has('motion_sensing') || tokens.has('acceleration')) tokens.add('imu');
  if (tokens.has('light_sensing')) tokens.add('light');
  if (tokens.has('input_control')) tokens.add('knob');
  if (tokens.has('visual_output')) tokens.add('led');
  if (tokens.has('haptic_output')) {
    tokens.add('vib');
    tokens.add('vibration');
  }
  if (tokens.has('audio_output')) tokens.add('audio');
  return tokens;
}

function _moduleMatchesToken(mod, token, role, channelId) {
  if (role && !moduleHasRole(mod, role)) return false;
  if (role === 'sensor' && channelId != null && channelId !== '') {
    const ch = String(channelId);
    if (!channelsForModule(mod).some(([, id]) => String(id) === ch)) return false;
  }
  const wanted = _lookupToken(token);
  if (!wanted) return false;
  const tokens = _moduleSearchTokens(mod);
  const aliases = MODULE_TOKEN_ALIASES[wanted] || [wanted];
  return aliases.some(alias => tokens.has(alias));
}

function _roleForActionCmd(cmd) {
  const name = _enumName(cmd, ACT_NAME, String(cmd || ''));
  if (name.startsWith('LED_')) return 'led';
  if (name.startsWith('VIBRATE')) return 'vib';
  if (name.startsWith('AUDIO')) return 'audio';
  return null;
}

function _isVarActionCmd(cmd) {
  const name = _enumName(cmd, ACT_NAME, String(cmd || ''));
  return name === 'VAR_SET' || name === 'VAR_INC' ||
         name === 'VAR_RESET' || name === 'VAR_TOGGLE';
}

function _resolveRulesAgainstLiveSchema(rules, modules) {
  const out = _cloneRules(rules);
  const activeMods = (modules || []).filter(m => m && m.active !== false);
  const diagnostics = {
    resolved: [],
    ambiguous: [],
    unresolved: [],
    missing: [],
  };

  const resolveModuleId = (value, role, path, channelId = null) => {
    const raw = String(value ?? '').trim();
    if (!raw || raw === '0') {
      diagnostics.unresolved.push({ path, role, wanted: raw || '(empty)' });
      return value ?? '0';
    }

    const uid = normalizeUid(raw);
    if (uid) {
      const live = activeMods.find(m => normalizeUid(m.uid) === uid);
      if (live?.uid) return String(live.uid);
      diagnostics.missing.push({ path, role, wanted: uid });
      return raw;
    }

    const slotMatch = activeMods.find(m =>
      m.slot != null && String(m.slot) === raw && (!role || moduleHasRole(m, role)));
    if (slotMatch?.uid) {
      diagnostics.resolved.push({ path, from: raw, to: slotMatch.uid });
      return String(slotMatch.uid);
    }

    const matches = activeMods.filter(m => _moduleMatchesToken(m, raw, role, channelId));
    if (matches.length === 1 && matches[0].uid) {
      diagnostics.resolved.push({ path, from: raw, to: matches[0].uid });
      return String(matches[0].uid);
    }
    if (matches.length > 1) {
      diagnostics.ambiguous.push({
        path, role, wanted: raw,
        candidates: matches.map(m => String(m.uid || m.id || '?')),
      });
      return raw;
    }
    diagnostics.unresolved.push({ path, role, wanted: raw });
    return raw;
  };

  const resolveRef = (ref, path, defaultType = REF.SLOT) => {
    if (!ref) return;
    const type = ref.type ?? defaultType;
    if (type !== REF.SLOT) return;
    const rawId = ref.id ?? ref.uid ?? ref.slot;
    ref.id = resolveModuleId(rawId, 'sensor', `${path}.id`, ref.ch);
  };

  for (const [vcIdx, vc] of (out.virtual_channels || []).entries()) {
    resolveRef(vc?.a, `virtual_channels[${vcIdx}].a`);
    resolveRef(vc?.b, `virtual_channels[${vcIdx}].b`,
      vc?.b?.value != null ? REF.CONST : REF.SLOT);
  }

  for (const [ruleIdx, rule] of (out.rules || []).entries()) {
    for (const [condIdx, cond] of (rule.conditions || []).entries()) {
      resolveRef(cond?.ref, `rules[${ruleIdx}].conditions[${condIdx}].ref`);
    }
    for (const [actIdx, act] of (rule.actions || []).entries()) {
      if (!_isVarActionCmd(act?.cmd)) {
        const role = _roleForActionCmd(act?.cmd);
        if (role) {
          act.target = resolveModuleId(
            act.target ?? act.uid ?? act.slot,
            role,
            `rules[${ruleIdx}].actions[${actIdx}].target`,
          );
        }
      }
      for (const [paramIdx, param] of (act.params || []).entries()) {
        resolveRef(param, `rules[${ruleIdx}].actions[${actIdx}].params[${paramIdx}]`,
          param?.value != null ? REF.CONST : REF.SLOT);
      }
    }
  }

  return { rules: out, diagnostics };
}

function _bindingDiagnosticMessage(diagnostics) {
  if (!diagnostics) return '';
  const parts = [];
  if (diagnostics.ambiguous?.length) {
    parts.push(`${diagnostics.ambiguous.length} ambiguous module binding(s); choose a UID in the dropdown`);
  }
  if (diagnostics.unresolved?.length) {
    parts.push(`${diagnostics.unresolved.length} unresolved module reference(s)`);
  }
  if (diagnostics.missing?.length) {
    parts.push(`${diagnostics.missing.length} bound UID reference(s) are offline`);
  }
  return parts.join('; ');
}

function _buildUniqueModuleNameMap(modules) {
  const counts = new Map();
  const values = new Map();
  const add = (key, uid) => {
    const token = _lookupToken(key);
    if (!token || !uid) return;
    counts.set(token, (counts.get(token) || 0) + 1);
    values.set(token, uid);
  };
  for (const m of modules || []) {
    add(m.id, m.uid);
    add(m.name, m.uid);
    add(m.descriptor?.type, m.uid);
    add(m.descriptor?.cat, m.uid);
    add(m.descriptor?.category, m.uid);
  }
  const out = new Map();
  for (const [token, count] of counts) {
    if (count === 1) out.set(token, values.get(token));
  }
  return out;
}

function _rulesStateFromJSON(rules, modules) {
  if (!rules) return { blocks: { languageVersion: 0, blocks: [] } };
  const ruleList = rules.rules || [];
  const vcList = rules.virtual_channels || [];
  if (!ruleList.length && !vcList.length) {
    return { blocks: { languageVersion: 0, blocks: [] } };
  }

  // Last-chance lookup for already-resolved or unique module names. The full
  // abstract→UID binding pass runs before this; duplicate names intentionally
  // stay unresolved so Blockly can show a ghost value for manual selection.
  const uidByName = _buildUniqueModuleNameMap(modules);

  const blocks = [];

  // VCs go first so that when ref_vc blocks (nested inside rules) initialize,
  // their dropdown generator can already find the vc_def blocks in the
  // workspace. Otherwise the dropdown caches a "— no vcs —" label.
  // Encoder assigns vc_id by workspace position (_collectVirtualChannels), so
  // sort by vc_id to preserve the LLM's intended numbering.
  const sortedVcs = [...vcList].sort((a, b) => (a.vc_id ?? 0) - (b.vc_id ?? 0));
  const VC_ROW_H = 150;
  sortedVcs.forEach((vc, idx) => {
    const block = _buildVcDefBlock(vc, idx, uidByName);
    if (block) blocks.push(block);
  });

  // Stack rules below the VCs (same x column) so they read top-to-bottom:
  // virtual channels first, then the rules that consume them.
  const rulesYStart = 20 + sortedVcs.length * VC_ROW_H + (sortedVcs.length ? 40 : 0);
  ruleList.forEach((rule, idx) => {
    const condBlock = _buildCondChain(rule.conditions, uidByName);
    const actBlock  = _buildActChain(rule.actions, uidByName);
    blocks.push({
      type: 'eca_rule',
      x: 20, y: rulesYStart + idx * 300,
      fields: { LOGIC: _enumName(rule.logic, LOGIC_NAME, 'AND') },
      inputs: {
        ...(condBlock ? { CONDITIONS: { block: condBlock } } : {}),
        ...(actBlock  ? { ACTIONS:    { block: actBlock  } } : {}),
      },
    });
  });

  return { blocks: { languageVersion: 0, blocks } };
}

function _buildCondChain(conditions, uidByName) {
  if (!conditions?.length) return null;
  const [first, ...rest] = conditions;
  const block = _buildCondBlock(first, uidByName);
  if (block && rest.length > 0) {
    const next = _buildCondChain(rest, uidByName);
    if (next) block.next = { block: next };
  }
  return block;
}

function _buildCondBlock(cond, uidByName) {
  if (!cond) return null;
  const { ref, op, threshold, hold_ms, cooldown_ms } = cond;
  const refType = ref?.type ?? 0;
  const fields = {
    OP:       _enumName(op, COND_OP_NAME, 'GT'),
    THRESHOLD: threshold ?? 0,
    HOLD:     hold_ms ?? 0,
    COOLDOWN: cooldown_ms ?? 2000,
  };
  const inputs = {};

  if (refType === 0) {
    // SLOT — legacy flat form: SLOT/CHANNEL fields. Encoder handles this path.
    fields.SLOT = String(_resolveModuleId(ref?.id, uidByName));
    fields.CHANNEL = String(ref?.ch ?? '0');
  } else {
    // CONST/VC/VAR — embed a ref_* sub-block in the REF input. Encoder reads
    // REF and ignores SLOT/CHANNEL when it's connected.
    fields.SLOT = '0';
    fields.CHANNEL = '0';
    const refBlock = _buildRefBlock(ref, uidByName);
    if (refBlock) inputs.REF = { block: refBlock };
  }

  return { type: 'sensor_condition', fields, inputs };
}

function _buildActChain(actions, uidByName) {
  if (!actions?.length) return null;
  const [first, ...rest] = actions;
  const block = _buildActBlock(first, uidByName);
  if (block && rest.length > 0) {
    const next = _buildActChain(rest, uidByName);
    if (next) block.next = { block: next };
  }
  return block;
}

function _buildActBlock(action, uidByName) {
  if (!action) return null;
  const { target, cmd, params } = action;
  let cmdName = _enumName(cmd, ACT_NAME, '');
  const resolvedTarget = _resolveModuleId(target, uidByName);
  const cv = (i) => params?.[i]?.value ?? 0;
  // Helper: emit a literal field value when param is CONST, or a ref sub-block
  // via the *_REF input when param is SLOT/VC/VAR.
  const setRichParam = (i, fieldName, fields, inputs) => {
    const p = params?.[i];
    if (!p || p.type === REF.CONST || p.type == null) {
      fields[fieldName] = p?.value ?? 0;
      return;
    }
    const refBlock = _buildRefBlock(p, uidByName);
    if (refBlock) {
      inputs[`${fieldName}_REF`] = { block: refBlock };
      // Keep literal field at default — encoder ignores it when *_REF is set.
      fields[fieldName] = 0;
    } else {
      fields[fieldName] = p?.value ?? 0;
    }
  };

  if (cmdName.startsWith('LED_')) {
    if (cmdName !== 'LED_SOLID' && cmdName !== 'LED_OFF' && cmdName !== 'LED_STOP') {
      cmdName = 'LED_SOLID';
    }
    const fields = { SLOT: String(resolvedTarget), CMD: cmdName };
    const inputs = {};
    if (cmdName !== 'LED_OFF' && cmdName !== 'LED_STOP') {
      setRichParam(0, 'R', fields, inputs);
      setRichParam(1, 'G', fields, inputs);
      setRichParam(2, 'B', fields, inputs);
    }
    return { type: 'led_action', fields, inputs };
  }
  if (cmdName.startsWith('VIBRATE')) {
    const fields = { SLOT: String(resolvedTarget), CMD: cmdName };
    if (cmdName !== 'VIBRATE_STOP') {
      fields.INTENSITY = cv(0);
      fields.DURATION  = cv(1);
    }
    return { type: 'vibrate_action', fields };
  }
  if (cmdName.startsWith('AUDIO')) {
    const fields = { SLOT: String(resolvedTarget), CMD: cmdName };
    const inputs = {};
    if (cmdName !== 'AUDIO_STOP') {
      setRichParam(0, 'FREQ', fields, inputs);
      setRichParam(1, 'AMP',  fields, inputs);
    }
    return { type: 'audio_action', fields, inputs };
  }
  if (cmdName.startsWith('VAR_')) {
    return {
      type: 'variable_action',
      fields: {
        VAR_ID: String(_varIdFromTarget(target)),
        CMD: cmdName,
        AMOUNT: cv(0),
      },
    };
  }
  return null;
}

// Convert a JSON ref {type, id, ch, value} into a Blockly state block of
// the matching ref_* type. Returns null if the ref shape is unrecognized.
function _buildRefBlock(ref, uidByName) {
  if (!ref) return null;
  const type = ref.type ?? 0;
  if (type === REF.SLOT) {
    return {
      type: 'ref_slot',
      fields: {
        SLOT: String(_resolveModuleId(ref.id, uidByName)),
        CHANNEL: String(ref.ch ?? 0),
      },
    };
  }
  if (type === REF.CONST) {
    return { type: 'ref_const', fields: { VALUE: ref.value ?? 0 } };
  }
  if (type === REF.VC) {
    return { type: 'ref_vc', fields: { VC_ID: String(ref.id ?? 0) } };
  }
  if (type === REF.VAR) {
    return { type: 'ref_var', fields: { VAR_ID: String(ref.id ?? 0) } };
  }
  return null;
}

// Build a vc_def workspace-root block from a JSON virtual_channel entry.
// vc.b.value populates B_CONST when b is CONST; otherwise B input gets a ref
// sub-block. vc.c_const populates C_CONST. A always becomes a ref sub-block.
function _buildVcDefBlock(vc, idx, uidByName) {
  if (!vc) return null;
  const fields = {
    OP: _enumName(vc.op, VC_OP_NAME, 'ADD'),
    B_CONST: vc.b?.value ?? 0,
    C_CONST: vc.c_const ?? 0,
  };
  const inputs = {};
  const aBlock = _buildRefBlock(vc.a, uidByName);
  if (aBlock) inputs.A = { block: aBlock };
  // Only embed a B sub-block if b isn't a plain CONST — for CONST, B_CONST
  // field carries the value and a sub-block is redundant (encoder reads
  // either: ref_const on B wins, else field B_CONST).
  if (vc.b && vc.b.type !== REF.CONST) {
    const bBlock = _buildRefBlock(vc.b, uidByName);
    if (bBlock) inputs.B = { block: bBlock };
  }
  return {
    type: 'vc_def',
    x: 20, y: 20 + idx * 150,
    fields,
    inputs,
  };
}

function _varIdFromTarget(target) {
  if (typeof target === 'number' && Number.isFinite(target)) return target & 0xFF;
  const str = String(target ?? '0').replace(/^0x/i, '');
  const n = /^[0-9a-fA-F]+$/.test(str) ? parseInt(str, 16) : parseInt(str, 10);
  return Number.isFinite(n) ? (n & 0xFF) : 0;
}

function _resolveModuleId(idOrName, uidByName) {
  if (!idOrName) return '0';
  const str = String(idOrName);
  // If it's already a UID, preserve it. If it is offline, the block should
  // keep that exact identity and surface a missing-module warning.
  if (normalizeUid(str)) return idOrName;
  return uidByName.get(_lookupToken(str)) || idOrName;
}
