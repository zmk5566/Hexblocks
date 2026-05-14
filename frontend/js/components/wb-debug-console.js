/**
 * <wb-debug-console> — toggleable floating overlay with hub event log,
 * face-occupancy bar, and ECA controls. Mirrors the shape of the
 * wb_debug.py CLI: same event names, same command surface.
 *
 * Data source: wsClient events (wb-app passes no state in; the console
 * subscribes directly so it works even when wb-app is busy).
 *
 * Design note: this component does NOT own authoritative state. The
 * module list it renders is a transient log view; wb-app and
 * wb-block-canvas remain the source of truth for docked modules.
 */
import { LitElement, html, css } from 'lit';
import { wsClient } from '../ws-client.js';
import { CH, ACT } from '../eca-encoder.js';

const EVENT_LIMIT = 500;
const RATE_WINDOW_MS = 2000;

export class WbDebugConsole extends LitElement {
  static properties = {
    open: { type: Boolean, reflect: true },
    _events:         { type: Array,  state: true },
    _faces:          { type: Array,  state: true },
    _modules:        { type: Object, state: true },  // Map<uid, {id, parent, parent_face}>
    _pendingDetach:  { type: Object, state: true },  // {uid} | null
    _sampleRate:     { type: Number, state: true },
    _topoBuffer:     { type: Array,  state: true },
    _actuatorUid:    { type: String, state: true },
    _actuatorCmd:    { type: String, state: true },
    _actuatorParams: { type: String, state: true },
    _topicUid:       { type: String, state: true },
    _topicChannel:   { type: Number, state: true },
  };

  static styles = css`
    :host {
      display: none;
      position: fixed;
      left: 0; right: 0; bottom: 0;
      height: 42vh;
      min-height: 300px;
      z-index: 1000;
      background: var(--wb-surface, #0d1b2e);
      border-top: 1px solid var(--wb-accent, #64FFDA);
      box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.4);
      color: var(--wb-text, #e8f4ff);
      font-family: var(--wb-font, system-ui);
      display: none;
    }
    :host([open]) { display: flex; flex-direction: column; }

    header {
      padding: 8px 14px;
      border-bottom: 1px solid var(--wb-border, rgba(255,255,255,0.1));
      display: flex;
      align-items: center;
      gap: 8px;
    }
    header .title {
      font-weight: 600;
      font-size: 0.85rem;
      flex: 1;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--wb-accent, #64FFDA);
    }
    button {
      padding: 4px 10px;
      border: 1px solid var(--wb-border, rgba(255,255,255,0.15));
      border-radius: 0;
      background: transparent;
      color: var(--wb-text-dim, rgba(255,255,255,0.7));
      font-size: 0.72rem;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
    }
    button:hover {
      background: var(--wb-accent);
      color: var(--wb-on-accent);
    }
    button.danger:hover {
      background: var(--wb-danger);
      color: var(--wb-on-accent);
    }

    .face-bar {
      padding: 8px 14px;
      display: flex;
      gap: 12px;
      align-items: center;
      font-family: var(--wb-mono, monospace);
      font-size: 0.78rem;
      border-bottom: 1px solid var(--wb-border, rgba(255,255,255,0.08));
    }
    .face-cell {
      padding: 3px 8px;
      border-radius: 0;
      background: var(--wb-surface-2);
    }
    .face-cell.occ  { color: var(--wb-accent); background: var(--wb-cap-badge-bg); }
    .face-cell.empty{ color: var(--wb-text-dim); }
    .face-cell .slot { color: var(--wb-text); opacity: 0.8; margin-left: 4px; font-size: 0.6em; }
    .meta {
      margin-left: auto;
      color: var(--wb-text-dim, rgba(255,255,255,0.6));
      font-size: 0.72rem;
    }

    .log {
      flex: 1;
      overflow-y: auto;
      padding: 6px 14px;
      font-family: var(--wb-mono, monospace);
      font-size: 0.72rem;
      line-height: 1.5;
      background: var(--wb-bg);
    }
    .log .entry { display: flex; gap: 8px; }
    .log .ts   { color: var(--wb-text-dim); flex-shrink: 0; }
    .log .msg  { flex: 1; word-break: break-word; white-space: pre-wrap; }
    .log .k-hello  .msg { color: #7CA1BB; }
    .log .k-swap   .msg { color: #c0399a; font-weight: 600; }
    .log .k-stack  .msg { color: #7B68EE; }
    .log .k-detach .msg { color: #c08018; }
    .log .k-unplug .msg { color: var(--wb-danger); font-weight: 600; }
    .log .k-ack-ok .msg { color: #2e9b56; }
    .log .k-ack-err.msg { color: var(--wb-danger); font-weight: 600; }
    .log .k-log    .msg { color: var(--wb-text); }
    .log .k-topo   .msg { color: #7CA1BB; }
    .log .k-done   .msg { color: var(--wb-text-dim); }

    .controls {
      padding: 8px 14px;
      border-top: 1px solid var(--wb-border, rgba(255,255,255,0.1));
      display: grid;
      gap: 6px;
      grid-template-columns: auto 1fr;
      align-items: center;
      font-size: 0.72rem;
    }
    .controls label {
      color: var(--wb-text-dim, rgba(255,255,255,0.6));
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 0.68rem;
    }
    .row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
    }
    select, input[type="text"], input[type="number"] {
      background: var(--wb-surface-2);
      border: 1px solid var(--wb-border);
      border-radius: 0;
      color: var(--wb-text);
      padding: 3px 6px;
      font: inherit;
      font-size: 0.72rem;
    }
    input[type="text"] { flex: 1; min-width: 120px; }
  `;

  constructor() {
    super();
    this.open = false;
    this._events = [];
    this._faces = Array.from({ length: 6 }, () => ({ occupied: false, uid: null }));
    this._modules = new Map();
    this._pendingDetach = null;
    this._sampleRate = 0;
    this._topoBuffer = [];
    this._topoOpen = false;
    this._sampleWindow = [];
    this._actuatorUid = '';
    this._actuatorCmd = 'LED_SOLID';
    this._actuatorParams = '255 0 0 100';
    this._topicUid = '';
    this._topicChannel = CH.ACC_MAG;
    this._onMsg = (msg) => this._handleMessage(msg);
  }

  connectedCallback() {
    super.connectedCallback();
    wsClient.onMessage(this._onMsg);
    this._rateTimer = setInterval(() => this._updateRate(), 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this._rateTimer);
  }

  // ── Event intake ─────────────────────────────────────────────

  _pushEvent(kind, text) {
    const next = [...this._events, { ts: this._nowStr(), kind, text }];
    if (next.length > EVENT_LIMIT) next.splice(0, next.length - EVENT_LIMIT);
    this._events = next;
    this.updateComplete.then(() => {
      const log = this.renderRoot?.querySelector('.log');
      if (log) log.scrollTop = log.scrollHeight;
    });
  }

  _nowStr() {
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  }

  _handleMessage(msg) {
    // Helper: short uid suffix for log readability.
    const sh = (u) => u ? String(u).slice(-4) : '????';

    switch (msg.type) {
      case 'hello': {
        const { uid, id, parent_face } = msg;
        const parent = msg.parent_is_hub ? 'HUB' : (msg.parent_uid || 'PENDING');
        const next = new Map(this._modules);
        next.set(uid, { ...(next.get(uid) || {}), id, parent, parent_face });
        this._modules = next;
        // First clear stale hub-face ownership for this uid, then mark the
        // current hub face if this module is hub-attached.
        this._faces = this._faces.map(f =>
          f.uid === uid ? { occupied: false, uid: null } : f);
        if (parent === 'HUB' && parent_face >= 1 && parent_face <= 6) {
          this._faces = this._faces.map((f, i) =>
            i === parent_face - 1 ? { occupied: true, uid } : f);
        }
        this._pushEvent('hello', `$H ${id || '(no-desc)'} uid=${sh(uid)} parent=${parent}.F${parent_face}`);
        break;
      }
      case 'descriptor': {
        const name = msg.data?.name || '?';
        this._pushEvent('log', `$D uid=${sh(msg.uid)} name=${name}`);
        break;
      }
      case 'module_info': {
        const { uid, id, version, fw_hash } = msg;
        const next = new Map(this._modules);
        next.set(uid, { ...(next.get(uid) || {}), id, version, fw_hash });
        this._modules = next;
        this._pushEvent('log',
          `$I uid=${sh(uid)} ${id || '(pending)'} v${version || '?'} hash=${fw_hash || '????'}`);
        break;
      }
      case 'sensor':
        this._sampleWindow.push(performance.now());
        break;
      case 'detach_pending':
        this._pendingDetach = { uid: msg.uid };
        this._pushEvent('detach', `$X uid=${sh(msg.uid)} (TTL started)`);
        break;
      case 'face_swap':
      case 'rebind': {
        const { uid } = msg;
        const old_parent = msg.old_parent ?? (msg.old_parent_is_hub ? 'HUB' : msg.old_parent_uid);
        const new_parent = msg.new_parent ?? (msg.new_parent_is_hub ? 'HUB' : msg.new_parent_uid);
        const old_face = msg.old_face ?? 0;
        const new_face = msg.new_face ?? 0;
        if (this._modules.has(uid)) {
          const next = new Map(this._modules);
          const prev = next.get(uid);
          next.set(uid, { ...prev, parent: new_parent, parent_face: new_face });
          this._modules = next;
        }
        // Update face strip for hub-rooted moves.
        this._faces = this._faces.map((f, i) => {
          if (old_parent === 'HUB' && i === old_face - 1 && f.uid === uid) {
            return { occupied: false, uid: null };
          }
          if (new_parent === 'HUB' && i === new_face - 1) {
            return { occupied: true, uid };
          }
          return f;
        });
        if (this._pendingDetach?.uid === uid) this._pendingDetach = null;
        this._pushEvent('swap',
          `↔ REBIND uid=${sh(uid)}: ${old_parent}.F${old_face} → ${new_parent}.F${new_face}`);
        break;
      }
      case 'unplug': {
        const { uid } = msg;
        const next = new Map(this._modules);
        next.delete(uid);
        this._modules = next;
        this._faces = this._faces.map(f =>
          f.uid === uid ? { occupied: false, uid: null } : f);
        if (this._pendingDetach?.uid === uid) this._pendingDetach = null;
        this._pushEvent('unplug', `✕ UNPLUG uid=${sh(uid)}`);
        break;
      }
      case 'child_stack': {
        const { parent_uid, child_uid, parent_face } = msg;
        const suffix = child_uid ? ` (child=${sh(child_uid)})` : ' (child PENDING)';
        this._pushEvent('stack',
          `⬆ STACK on ${sh(parent_uid)}.F${parent_face}${suffix}`);
        break;
      }
      case 'child_unstack':
        this._pushEvent('stack',
          `⬇ unstack from ${sh(msg.parent_uid)}.F${msg.parent_face}`);
        break;
      case 'command_ack': {
        const tag = msg.status === 'ok' ? '$OK' : '$ERR';
        const kind = msg.status === 'ok' ? 'ack-ok' : 'ack-err';
        this._pushEvent(kind, `${tag} ${msg.text || ''}`);
        break;
      }
      case 'query_done':
        this._pushEvent('done', '$Q DONE');
        break;
      case 'log':
        this._handleLogLine(msg.line);
        break;
      default:
        break;
    }
  }

  _handleLogLine(line) {
    if (!line) return;
    if (line.includes('=== TOPOLOGY ===')) {
      this._topoOpen = true;
      this._pushEvent('topo', line);
      return;
    }
    if (line.includes('=== END ===')) {
      this._topoOpen = false;
      this._pushEvent('topo', line);
      return;
    }
    if (this._topoOpen) {
      this._pushEvent('topo', line);
      return;
    }
    if (line.includes('FAIL') || line.includes('ERROR')) {
      this._pushEvent('ack-err', line);
      return;
    }
    this._pushEvent('log', line);
  }

  _updateRate() {
    const cutoff = performance.now() - RATE_WINDOW_MS;
    this._sampleWindow = this._sampleWindow.filter(t => t >= cutoff);
    const rate = this._sampleWindow.length > 1
      ? (this._sampleWindow.length / (RATE_WINDOW_MS / 1000))
      : 0;
    if (Math.abs(rate - this._sampleRate) > 0.5) this._sampleRate = rate;
  }

  // ── Actions ──────────────────────────────────────────────────

  _close() { this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true })); }

  _send(obj) { wsClient.send(obj); }

  _queryTopo()   { this._send({ action: 'query', command: 'TOPO' }); }
  _queryStatus() { this._send({ action: 'query', command: 'STATUS' }); }
  _ecaRun()      { this._send({ action: 'program_run' }); }
  _ecaStop()     { this._send({ action: 'program_stop' }); }
  _ecaClear()    { this._send({ action: 'program_clear' }); }

  _sendActuator() {
    const params = this._actuatorParams
      .trim().split(/\s+/).filter(Boolean)
      .map(n => parseInt(n, 10) & 0xFF);
    const cmd = ACT[this._actuatorCmd];
    if (cmd === undefined) {
      this._pushEvent('ack-err', `unknown actuator cmd: ${this._actuatorCmd}`);
      return;
    }
    this._send({ action: 'actuator', uid: this._actuatorUid, cmd, params });
  }

  _sendTopic(enable, all = false) {
    if (all) {
      this._send({ action: 'topic_enable_all', uid: this._topicUid });
      return;
    }
    this._send({
      action: enable ? 'topic_enable' : 'topic_disable',
      uid: this._topicUid,
      channel: this._topicChannel,
    });
  }

  _clearLog() {
    this._events = [];
  }

  // ── Render ───────────────────────────────────────────────────

  render() {
    const shortUid = (u) => u ? String(u).slice(-4) : '????';
    const faceCells = this._faces.map((f, i) => html`
      <span class="face-cell ${f.occupied ? 'occ' : 'empty'}">
        F${i + 1} ${f.occupied ? '●' : '○'}
        ${f.uid != null ? html`<span class="slot">→${shortUid(f.uid)}</span>` : ''}
      </span>
    `);

    const modUids = [...this._modules.keys()].sort();
    // Default-select first known uid when selects mount and no value set.
    if (!this._actuatorUid && modUids.length) this._actuatorUid = modUids[0];
    if (!this._topicUid && modUids.length)    this._topicUid    = modUids[0];

    return html`
      <header>
        <span class="title">🔧 Debug Console</span>
        <button @click=${this._queryTopo}>topo</button>
        <button @click=${this._queryStatus}>status</button>
        <button @click=${this._clearLog}>clear log</button>
        <button class="danger" @click=${this._close} title="Close (Ctrl/Cmd+D)">✕</button>
      </header>

      <div class="face-bar">
        ${faceCells}
        <span class="meta">
          $S ${this._sampleRate.toFixed(1)}/s
          ${this._pendingDetach
            ? html` · pending: ${shortUid(this._pendingDetach.uid)}`
            : ''}
        </span>
      </div>

      <div class="log">
        ${this._events.map(e => html`
          <div class="entry k-${e.kind}">
            <span class="ts">${e.ts}</span>
            <span class="msg">${e.text}</span>
          </div>
        `)}
      </div>

      <div class="controls">
        <label>ECA</label>
        <div class="row">
          <button @click=${this._ecaRun}>run</button>
          <button @click=${this._ecaStop}>stop</button>
          <button @click=${this._ecaClear}>clear</button>
        </div>

        <label>Actuator</label>
        <div class="row">
          module <select
            .value=${this._actuatorUid}
            @change=${e => this._actuatorUid = e.target.value}>
            ${modUids.length === 0
              ? html`<option value="">(none)</option>`
              : modUids.map(u => {
                  const m = this._modules.get(u) || {};
                  return html`<option value=${u}>${shortUid(u)} ${m.id || ''}${m.version ? ` v${m.version}` : ''}</option>`;
                })}
          </select>
          cmd <select
            .value=${this._actuatorCmd}
            @change=${e => this._actuatorCmd = e.target.value}>
            ${Object.keys(ACT).map(k => html`<option value=${k}>${k}</option>`)}
          </select>
          params <input type="text"
            .value=${this._actuatorParams}
            @change=${e => this._actuatorParams = e.target.value}
            placeholder="space-separated bytes (e.g. 255 0 0 100)">
          <button @click=${this._sendActuator}>send</button>
        </div>

        <label>Topic</label>
        <div class="row">
          module <select
            .value=${this._topicUid}
            @change=${e => this._topicUid = e.target.value}>
            ${modUids.length === 0
              ? html`<option value="">(none)</option>`
              : modUids.map(u => {
                  const m = this._modules.get(u) || {};
                  return html`<option value=${u}>${shortUid(u)} ${m.id || ''}${m.version ? ` v${m.version}` : ''}</option>`;
                })}
          </select>
          ch <select
            .value=${String(this._topicChannel)}
            @change=${e => this._topicChannel = parseInt(e.target.value, 10)}>
            ${Object.entries(CH).map(([name, id]) =>
              html`<option value=${id}>${name} (${id})</option>`)}
          </select>
          <button @click=${() => this._sendTopic(true)}>enable</button>
          <button @click=${() => this._sendTopic(false)}>disable</button>
          <button @click=${() => this._sendTopic(true, true)}>enable all</button>
        </div>
      </div>
    `;
  }
}

customElements.define('wb-debug-console', WbDebugConsole);
