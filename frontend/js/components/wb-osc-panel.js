/**
 * <wb-osc-panel> — OSC forwarding configuration modal.
 *
 * Mode B authoring surface. Lets the user define UDP/OSC targets that the
 * bridge fans sensor + actuator_state events out to. Bridge owns the source
 * of truth (~/.wearblocks/osc_targets.json); this panel is a thin editor.
 *
 * Bridge protocol (WS messages):
 *   ←  {type:'osc_state', targets:[...]}
 *   ←  {type:'osc_stats', stats:{id: {sent, dropped, hz, last_err}}}
 *   →  {action:'osc_add',   target:{...}}
 *   →  {action:'osc_update', id, target:{...}}
 *   →  {action:'osc_remove', id}
 *   →  {action:'osc_auto_populate', id}
 */
import { LitElement, html, css } from 'lit';
import { wsClient } from '../ws-client.js';

const DEBOUNCE_MS = 300;

/** True iff `host` looks like a loopback literal. We only catch the obvious
 *  cases here — the bridge does authoritative resolution + policy check. */
function isLoopbackHost(host) {
  if (!host) return true;
  const h = String(host).trim().toLowerCase();
  if (h === 'localhost') return true;
  if (h === '::1' || h === '[::1]') return true;
  if (h.startsWith('127.')) return true;
  return false;
}

function blankTarget() {
  return {
    host: '127.0.0.1',
    port: 7000,
    enabled: false,
    sensors_filter: [],
    actuators_enabled: false,
    rate_limit_hz: 0,
    mappings: [],
  };
}

export class WbOscPanel extends LitElement {
  static properties = {
    open:    { type: Boolean, reflect: true },
    _targets: { type: Array,  state: true },
    _stats:   { type: Object, state: true },
  };

  static styles = css`
    :host {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: rgba(0, 0, 0, 0.45);
      align-items: center;
      justify-content: center;
      font-family: var(--wb-font);
    }
    :host([open]) { display: flex; }

    .modal {
      width: 720px;
      max-width: 94vw;
      max-height: 86vh;
      background: var(--wb-surface);
      border: 1px solid var(--wb-border);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--wb-border);
    }
    header h2 {
      margin: 0;
      font-size: 0.95rem;
      font-weight: 600;
      color: var(--wb-text);
      flex: 1;
    }
    .close {
      background: transparent;
      border: 1px solid transparent;
      color: var(--wb-text-dim);
      font-size: 1rem;
      cursor: pointer;
      padding: 2px 8px;
    }
    .close:hover { color: var(--wb-text); border-color: var(--wb-border); }

    .body {
      overflow-y: auto;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .empty {
      color: var(--wb-text-dim);
      font-size: 0.85rem;
      padding: 16px;
      text-align: center;
      border: 1px dashed var(--wb-border);
    }

    .target {
      border: 1px solid var(--wb-border);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .target-head {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .target-head input[type="text"],
    .target-head input[type="number"] {
      background: var(--wb-bg);
      color: var(--wb-text);
      border: 1px solid var(--wb-border);
      padding: 3px 6px;
      font-family: var(--wb-font-mono, monospace);
      font-size: 0.85rem;
    }
    .host-input  { width: 140px; }
    .port-input  { width: 70px; }
    .rate-input  { width: 60px; }

    .row-flex {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      font-size: 0.82rem;
      color: var(--wb-text-dim);
    }
    .row-flex label { display: inline-flex; gap: 4px; align-items: center; }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
      font-family: var(--wb-font-mono, monospace);
    }
    th, td {
      border-bottom: 1px solid var(--wb-border);
      padding: 4px 6px;
      text-align: left;
      vertical-align: middle;
    }
    th { color: var(--wb-text-dim); font-weight: 500; }
    td input {
      width: 100%;
      box-sizing: border-box;
      background: transparent;
      color: var(--wb-text);
      border: 1px solid transparent;
      padding: 2px 4px;
      font-family: inherit;
      font-size: inherit;
    }
    td input:focus { border-color: var(--wb-border); outline: none; }
    .col-scale, .col-offset { width: 60px; }
    .col-trash  { width: 24px; }

    button {
      background: var(--wb-bg);
      color: var(--wb-text);
      border: 1px solid var(--wb-border);
      padding: 3px 9px;
      cursor: pointer;
      font-family: inherit;
      font-size: 0.8rem;
    }
    button:hover { background: var(--wb-surface-hover, var(--wb-surface)); }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .danger { color: #c44; }

    .stats {
      font-size: 0.75rem;
      color: var(--wb-text-dim);
      font-family: var(--wb-font-mono, monospace);
    }
    .stats .err { color: #c44; }
    .warn-remote {
      font-size: 0.72rem;
      color: #c89400;
    }
    .err-banner {
      font-size: 0.78rem;
      color: #c44;
      border: 1px solid #c44;
      padding: 4px 8px;
      background: rgba(204, 68, 68, 0.08);
    }

    .add-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
  `;

  constructor() {
    super();
    this.open = false;
    this._targets = [];
    this._stats = {};
    this._errors = {};  // id -> last error string from bridge
    this._debouncers = new Map(); // id -> timer
    this._onMsg = this._onMsg.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();
    wsClient.onMessage(this._onMsg);
  }

  _onMsg(msg) {
    if (msg.type === 'osc_state') {
      this._targets = Array.isArray(msg.targets) ? msg.targets : [];
      // A successful state replay clears the per-id error if it referred
      // to a target that now exists.
      if (this._errors && Object.keys(this._errors).length) {
        const ids = new Set(this._targets.map(t => t.id));
        const next = {};
        for (const [k, v] of Object.entries(this._errors)) {
          if (ids.has(k)) next[k] = v;
        }
        this._errors = next;
      }
    } else if (msg.type === 'osc_stats') {
      this._stats = msg.stats || {};
    } else if (msg.type === 'osc_error') {
      // Bridge refused an add/update — surface inline. For "add" failures
      // the row is not yet in our list, so park the message under a sticky
      // "_pending" key shown above the target list.
      const key = msg.id || '_pending';
      this._errors = { ...(this._errors || {}), [key]: msg.error || 'unknown' };
      this.requestUpdate();
    }
  }

  // ── User actions ─────────────────────────────────────────────

  _addTarget() {
    wsClient.oscAdd(blankTarget());
  }

  _removeTarget(id) {
    if (!confirm('Remove this OSC target?')) return;
    wsClient.oscRemove(id);
  }

  _autoPopulate(id) {
    wsClient.oscAutoPopulate(id);
  }

  _addMapping(target) {
    const next = {
      ...target,
      mappings: [...(target.mappings || []),
                 { source_pattern: 'sensor/*/0', address: '/hex/new',
                   scale: 1.0, offset: 0.0 }],  // sensor/<uid>/<channel>; * = any
    };
    this._sendUpdate(next);
  }

  _removeMapping(target, idx) {
    const next = {
      ...target,
      mappings: (target.mappings || []).filter((_, i) => i !== idx),
    };
    this._sendUpdate(next);
  }

  /** Patch one field on `target` and queue a debounced update. */
  _patch(target, patch) {
    const next = { ...target, ...patch };
    this._scheduleUpdate(next);
  }

  _patchMapping(target, idx, patch) {
    const mappings = (target.mappings || []).map((m, i) =>
      i === idx ? { ...m, ...patch } : m);
    this._scheduleUpdate({ ...target, mappings });
  }

  _scheduleUpdate(target) {
    // Reflect locally so the input doesn't blink while the round-trip
    // is in flight; bridge will send the authoritative osc_state next.
    this._targets = this._targets.map(t => t.id === target.id ? target : t);
    clearTimeout(this._debouncers.get(target.id));
    const timer = setTimeout(() => this._sendUpdate(target), DEBOUNCE_MS);
    this._debouncers.set(target.id, timer);
  }

  _sendUpdate(target) {
    clearTimeout(this._debouncers.get(target.id));
    this._debouncers.delete(target.id);
    const { id, ...payload } = target;
    wsClient.oscUpdate(id, payload);
  }

  // ── Render ───────────────────────────────────────────────────

  render() {
    return html`
      <div class="modal" @click=${e => e.stopPropagation()}>
        <header>
          <h2>OSC Forwarding</h2>
          <span class="row-flex">
            ${this._targets.filter(t => t.enabled).length} active
          </span>
          <button class="close"
                  @click=${() => this.dispatchEvent(new CustomEvent('close'))}>
            ✕
          </button>
        </header>
        <div class="body">
          <div class="add-row">
            <span class="row-flex">
              Forward sensor + actuator events as OSC/UDP. Edits save live.
            </span>
            <button @click=${this._addTarget}>+ Add target</button>
          </div>

          ${this._errors && this._errors._pending
            ? html`<div class="err-banner">
                Bridge refused last add: ${this._errors._pending}
              </div>` : ''}

          ${this._targets.length === 0
            ? html`<div class="empty">No OSC targets yet. Click <b>Add target</b> to start.</div>`
            : this._targets.map(t => this._renderTarget(t))}
        </div>
      </div>
    `;
  }

  _renderTarget(t) {
    const stats = this._stats[t.id] || {};
    const mappings = t.mappings || [];
    const err = this._errors && this._errors[t.id];
    const remote = !isLoopbackHost(t.host);
    return html`
      <div class="target">
        <div class="target-head">
          <input type="text" class="host-input" .value=${t.host}
                 @change=${e => this._patch(t, { host: e.target.value.trim() })}>
          <span>:</span>
          <input type="number" class="port-input" min="1" max="65535"
                 .value=${t.port}
                 @change=${e => this._patch(t, { port: parseInt(e.target.value, 10) || t.port })}>
          <label>
            <input type="checkbox" .checked=${t.enabled}
                   @change=${e => this._patch(t, { enabled: e.target.checked })}>
            enabled
          </label>
          <button class="danger" @click=${() => this._removeTarget(t.id)}>🗑</button>
        </div>
        ${remote ? html`<div class="warn-remote">
          non-loopback target requires <code>--osc-allow-remote</code> on the bridge
        </div>` : ''}
        ${err ? html`<div class="err-banner">${err}</div>` : ''}

        <div class="row-flex">
          <label>
            sensors filter:
            <input type="text"
                   placeholder="empty = all (or e.g. imu, hr, 3)"
                   .value=${(t.sensors_filter || []).join(', ')}
                   @change=${e => this._patch(t, {
                     sensors_filter: e.target.value
                       .split(',').map(s => s.trim()).filter(Boolean)
                       .map(s => /^\d+$/.test(s) ? parseInt(s, 10) : s),
                   })}>
          </label>
          <label>
            <input type="checkbox" .checked=${t.actuators_enabled}
                   @change=${e => this._patch(t, { actuators_enabled: e.target.checked })}>
            actuators
          </label>
          <label>
            rate limit:
            <input type="number" class="rate-input" min="0" step="1"
                   .value=${t.rate_limit_hz || 0}
                   @change=${e => this._patch(t, {
                     rate_limit_hz: parseFloat(e.target.value) || 0,
                   })}>
            Hz (0 = unlimited)
          </label>
        </div>

        <div class="add-row">
          <span class="row-flex">Mappings (${mappings.length})</span>
          <span>
            <button @click=${() => this._autoPopulate(t.id)}>Auto-populate</button>
            <button @click=${() => this._addMapping(t)}>+ row</button>
          </span>
        </div>

        ${mappings.length === 0
          ? html`<div class="empty">No mappings. Click <b>Auto-populate</b>
                  once a module is plugged in, or <b>+ row</b> to add manually.</div>`
          : html`
            <table>
              <thead>
                <tr><th>source pattern</th><th>OSC address</th>
                    <th class="col-scale">scale</th>
                    <th class="col-offset">offset</th>
                    <th class="col-trash"></th></tr>
              </thead>
              <tbody>
                ${mappings.map((m, i) => html`
                  <tr>
                    <td><input type="text" .value=${m.source_pattern}
                               @change=${e => this._patchMapping(t, i,
                                 { source_pattern: e.target.value.trim() })}></td>
                    <td><input type="text" .value=${m.address}
                               @change=${e => this._patchMapping(t, i,
                                 { address: e.target.value.trim() })}></td>
                    <td><input type="number" step="any" .value=${m.scale ?? 1}
                               @change=${e => this._patchMapping(t, i,
                                 { scale: parseFloat(e.target.value) || 0 })}></td>
                    <td><input type="number" step="any" .value=${m.offset ?? 0}
                               @change=${e => this._patchMapping(t, i,
                                 { offset: parseFloat(e.target.value) || 0 })}></td>
                    <td><button class="danger"
                                @click=${() => this._removeMapping(t, i)}>×</button></td>
                  </tr>
                `)}
              </tbody>
            </table>`}

        <div class="stats">
          ${stats.sent ?? 0} sent, ${stats.dropped ?? 0} dropped,
          ${(stats.hz ?? 0).toFixed(0)} Hz
          ${stats.last_err
            ? html`<span class="err">— last err: ${stats.last_err}</span>`
            : ''}
        </div>
      </div>
    `;
  }
}

customElements.define('wb-osc-panel', WbOscPanel);
