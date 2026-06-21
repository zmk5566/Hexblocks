/**
 * <wb-config-panel> - Hub/module wireless configuration modal.
 *
 * Keeps transport mode controls out of compact module cards while still
 * giving both the hub and each module one consistent info/config entry.
 */
import { LitElement, html, css } from 'lit';
import { wsClient } from '../ws-client.js';

const TRANSPORT_MODES = [
  ['can_primary_wifi_fallback', 'CAN -> Wi-Fi fallback'],
  ['wifi_primary_can_fallback', 'Wi-Fi -> CAN fallback'],
  ['wifi_only', 'Wi-Fi only'],
  ['can_only', 'CAN only'],
  ['dual_send_debug', 'Dual send debug'],
];

const LINK_LABELS = {
  can: 'CAN',
  wifi: 'Wi-Fi',
  dual: 'CAN + Wi-Fi',
  none: 'none',
};

const TOPOLOGY_LABELS = {
  physical: 'physical',
  remote_unplaced: 'remote',
  remote_placed: 'remote placed',
};

export class WbConfigPanel extends LitElement {
  static properties = {
    open:       { type: Boolean, reflect: true },
    targetType: { type: String },
    targetUid:  { type: String },
    modules:    { type: Array },
    wifiInfo:   { type: Object },
    _hubMode:   { type: String, state: true },
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
      width: 560px;
      max-width: 92vw;
      max-height: 84vh;
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
      gap: 14px;
    }

    section h3 {
      margin: 0 0 6px 0;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--wb-text-dim);
      font-weight: 600;
    }

    .kv {
      border: 1px solid var(--wb-border);
      background: var(--wb-bg);
      font-family: var(--wb-mono);
      font-size: 0.72rem;
    }
    .kv-row {
      display: grid;
      grid-template-columns: 98px 1fr;
      gap: 10px;
      padding: 7px 9px;
      border-bottom: 1px solid var(--wb-border);
      min-width: 0;
    }
    .kv-row:last-child { border-bottom: 0; }
    .key {
      color: var(--wb-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .value {
      color: var(--wb-text);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .config-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 9px;
      border: 1px solid var(--wb-border);
      background: var(--wb-bg);
      font-family: var(--wb-mono);
      font-size: 0.72rem;
    }
    select {
      min-width: 220px;
      flex: 1;
      background: var(--wb-surface-2);
      color: var(--wb-text);
      border: 1px solid var(--wb-border);
      border-radius: 0;
      padding: 4px 7px;
      font: inherit;
    }
    button.act {
      background: transparent;
      border: 1px solid var(--wb-border);
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
      font-size: 0.65rem;
      padding: 4px 9px;
      cursor: pointer;
    }
    button.act:hover {
      color: var(--wb-text);
      border-color: var(--wb-text-dim);
    }
    button.act.primary {
      color: var(--wb-text);
      border-color: var(--wb-text);
    }
    .empty {
      border: 1px dashed var(--wb-border);
      padding: 14px;
      color: var(--wb-text-dim);
      font-size: 0.78rem;
      text-align: center;
    }
  `;

  constructor() {
    super();
    this.open = false;
    this.targetType = 'hub';
    this.targetUid = '';
    this.modules = [];
    this.wifiInfo = {};
    this._hubMode = 'can_primary_wifi_fallback';
  }

  _close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  updated(changed) {
    if (changed.has('open') && this.open) {
      wsClient.wirelessInfo();
    }
  }

  _module() {
    if (!this.targetUid) return null;
    return (this.modules || []).find(m => m.uid === this.targetUid) || null;
  }

  _modeOptions(selected) {
    return TRANSPORT_MODES.map(([value, label]) => html`
      <option value=${value} ?selected=${value === selected}>${label}</option>
    `);
  }

  _applyModule(mode) {
    const mod = this._module();
    if (!mod?.uid || !mode) return;
    wsClient.wirelessConfig(mod.uid, mode);
  }

  _applyAll() {
    wsClient.wirelessConfig('ALL', this._hubMode);
  }

  _renderHub() {
    const wifi = this.wifiInfo || {};
    return html`
      <section>
        <h3>Hub Wi-Fi AP</h3>
        <div class="kv">
          <div class="kv-row"><span class="key">SSID</span><span class="value" title=${wifi.ssid || ''}>${wifi.ssid || 'pending'}</span></div>
          <div class="kv-row"><span class="key">Endpoint</span><span class="value">${wifi.ip || '0.0.0.0'}:${wifi.port || 0}</span></div>
          <div class="kv-row"><span class="key">Password</span><span class="value" title=${wifi.password || ''}>${wifi.password || 'pending'}</span></div>
          <div class="kv-row"><span class="key">OSC token</span><span class="value" title=${wifi.token || ''}>${wifi.token || 'pending'}</span></div>
        </div>
      </section>

      <section>
        <h3>Module transport default</h3>
        <div class="config-row">
          <select .value=${this._hubMode} @change=${e => this._hubMode = e.target.value}>
            ${this._modeOptions(this._hubMode)}
          </select>
          <button class="act primary" @click=${this._applyAll}>apply all</button>
          <button class="act" @click=${() => wsClient.wirelessInfo()}>refresh</button>
        </div>
      </section>
    `;
  }

  _renderModule() {
    const mod = this._module();
    if (!mod) return html`<div class="empty">Module is no longer connected.</div>`;
    const activeLink = mod.active_link || 'none';
    const mode = mod.transport_mode || 'can_primary_wifi_fallback';
    const topology = mod.topology_state || (mod.parent_remote ? 'remote_unplaced' : 'physical');
    const where = mod.parent_remote || topology === 'remote_unplaced'
      ? 'REMOTE'
      : mod.parent_face
        ? `${mod.parent_is_hub === false ? String(mod.parent_uid || '').slice(-4) : 'HUB'}.F${mod.parent_face}`
        : 'orphan';
    return html`
      <section>
        <h3>Module info</h3>
        <div class="kv">
          <div class="kv-row"><span class="key">Name</span><span class="value">${mod.name || mod.id || mod.uid}</span></div>
          <div class="kv-row"><span class="key">UID</span><span class="value">${mod.uid || 'unknown'}</span></div>
          <div class="kv-row"><span class="key">Location</span><span class="value">${where}</span></div>
          <div class="kv-row"><span class="key">Link</span><span class="value">${LINK_LABELS[activeLink] || activeLink}</span></div>
          <div class="kv-row"><span class="key">Topology</span><span class="value">${TOPOLOGY_LABELS[topology] || topology}</span></div>
        </div>
      </section>

      <section>
        <h3>Transport mode</h3>
        <div class="config-row">
          <select .value=${mode} @change=${e => this._applyModule(e.target.value)}>
            ${this._modeOptions(mode)}
          </select>
          <button class="act" @click=${() => wsClient.wirelessInfo()}>refresh</button>
        </div>
      </section>
    `;
  }

  render() {
    const isModule = this.targetType === 'module';
    const mod = this._module();
    const title = isModule
      ? `${mod?.name || mod?.id || 'Module'} info`
      : 'Hub info';
    return html`
      <div class="modal" role="dialog" aria-modal="true">
        <header>
          <h2>${title}</h2>
          <button class="close" @click=${this._close}>x</button>
        </header>
        <div class="body">
          ${isModule ? this._renderModule() : this._renderHub()}
        </div>
      </div>
    `;
  }
}

customElements.define('wb-config-panel', WbConfigPanel);
