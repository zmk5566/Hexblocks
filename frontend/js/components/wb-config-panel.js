/**
 * <wb-config-panel> - Hub/module wireless configuration modal.
 *
 * Keeps transport mode controls out of compact module cards while still
 * giving both the hub and each module one consistent info/config entry.
 */
import { LitElement, html, css } from 'lit';
import { wsClient } from '../ws-client.js';
import { channelsForModule, normalizeUid, slotLabel } from '../module-channel-map.js';

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

const LOGGER_MODES = [
  ['latest_interval', 'latest'],
  ['on_change', 'change'],
  ['aggregate_avg', 'avg'],
  ['aggregate_minmax', 'min/max'],
  ['event_only', 'event'],
];

export class WbConfigPanel extends LitElement {
  static properties = {
    open:       { type: Boolean, reflect: true },
    targetType: { type: String },
    targetUid:  { type: String },
    modules:    { type: Array },
    wifiInfo:   { type: Object },
    _hubMode:   { type: String, state: true },
    _loggerDraft: { type: Array, state: true },
    _loggerDraftUid: { type: String, state: true },
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
    input {
      background: var(--wb-surface-2);
      color: var(--wb-text);
      border: 1px solid var(--wb-border);
      border-radius: 0;
      padding: 4px 7px;
      font: inherit;
      min-width: 0;
    }
    input.small { width: 72px; }
    .topic-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .topic-row {
      display: grid;
      grid-template-columns: minmax(110px, 1.2fr) minmax(76px, 0.8fr) minmax(82px, 0.8fr) 72px 72px 26px;
      gap: 5px;
      align-items: center;
      padding: 6px;
      border: 1px solid var(--wb-border);
      background: var(--wb-bg);
      font-family: var(--wb-mono);
      font-size: 0.68rem;
    }
    .topic-row select {
      min-width: 0;
      width: 100%;
      padding: 4px 5px;
    }
    .topic-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }
    .icon-act {
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      color: var(--wb-text-dim);
      border: 1px solid var(--wb-border);
      cursor: pointer;
      font-family: var(--wb-mono);
      padding: 0;
    }
    .icon-act:hover { color: var(--wb-text); border-color: var(--wb-text-dim); }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      font-family: var(--wb-mono);
      font-size: 0.68rem;
    }
    .stat {
      border: 1px solid var(--wb-border);
      background: var(--wb-bg);
      padding: 6px;
      min-width: 0;
    }
    .stat .key {
      display: block;
      margin-bottom: 3px;
    }
    .stat .value {
      display: block;
      white-space: nowrap;
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
    this._loggerDraft = [];
    this._loggerDraftUid = '';
  }

  _close() {
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  updated(changed) {
    if (changed.has('open') && this.open) {
      wsClient.wirelessInfo();
      wsClient.loggerInfo();
      this._resetLoggerDraft();
    }
    if (this.open && changed.has('targetUid')) {
      this._resetLoggerDraft();
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

  _isLogger(mod) {
    const tokens = new Set();
    const add = (value) => {
      String(value || '').toLowerCase().split(/[^a-z0-9]+/).forEach(t => {
        if (t) tokens.add(t);
      });
    };
    add(mod?.id);
    add(mod?.name);
    add(mod?.descriptor?.id);
    add(mod?.descriptor?.cat);
    add(mod?.descriptor?.category);
    add(mod?.descriptor?.type);
    for (const cap of mod?.descriptor?.caps || []) {
      add(cap?.t); add(cap?.type); add(cap?.m); add(cap?.modality);
    }
    return ['loralogv1', 'logger', 'wireless_uplink', 'lora_uplink', 'batch_log']
      .some(t => tokens.has(t));
  }

  _loggerSources(mod) {
    const loggerUid = normalizeUid(mod?.uid);
    return (this.modules || [])
      .filter(m => normalizeUid(m.uid) && normalizeUid(m.uid) !== loggerUid)
      .filter(m => channelsForModule(m).length > 0);
  }

  _resetLoggerDraft() {
    const mod = this._module();
    if (!mod || !this._isLogger(mod)) {
      this._loggerDraft = [];
      this._loggerDraftUid = '';
      return;
    }
    this._loggerDraftUid = mod.uid || '';
    this._loggerDraft = (mod.logger_config?.subscriptions || []).map(s => ({
      source_uid: normalizeUid(s.source_uid),
      channel_id: Number(s.channel_id || 0),
      record_type: s.record_type || 'sensor',
      mode: s.mode || 'latest_interval',
      min_interval_ms: Number(s.min_interval_ms || 0),
      threshold: Number(s.threshold || 0),
      flags: Number(s.flags || 0),
    }));
  }

  _defaultLoggerSub(mod) {
    const source = this._loggerSources(mod)[0];
    const channel = source ? channelsForModule(source)[0] : null;
    if (!source || !channel) return null;
    return {
      source_uid: normalizeUid(source.uid),
      channel_id: Number(channel[1]),
      record_type: 'sensor',
      mode: 'latest_interval',
      min_interval_ms: 10000,
      threshold: 0,
      flags: 0,
    };
  }

  _updateLoggerSub(index, patch) {
    const next = this._loggerDraft.map((s, i) => i === index ? { ...s, ...patch } : s);
    this._loggerDraft = next;
  }

  _addLoggerSub(mod) {
    const sub = this._defaultLoggerSub(mod);
    if (!sub) return;
    this._loggerDraft = [...this._loggerDraft, sub];
  }

  _removeLoggerSub(index) {
    this._loggerDraft = this._loggerDraft.filter((_, i) => i !== index);
  }

  _applyLogger(mod) {
    if (!mod?.uid) return;
    wsClient.loggerConfig(mod.uid, this._loggerDraft);
  }

  _renderLoggerStatus(mod) {
    const st = mod.logger_status || {};
    return html`
      <div class="status-grid">
        <div class="stat"><span class="key">Queue</span><span class="value">${st.queue_depth ?? 0}</span></div>
        <div class="stat"><span class="key">Dropped</span><span class="value">${st.dropped_count ?? 0}</span></div>
        <div class="stat"><span class="key">RSSI</span><span class="value">${st.rssi ?? 0}</span></div>
        <div class="stat"><span class="key">SNR</span><span class="value">${st.snr ?? 0}</span></div>
      </div>
    `;
  }

  _renderLoggerTopics(mod) {
    if (!this._isLogger(mod)) return null;
    const sources = this._loggerSources(mod);
    return html`
      <section>
        <h3>Logger status</h3>
        ${this._renderLoggerStatus(mod)}
      </section>

      <section>
        <h3>Forward Topics</h3>
        ${sources.length
          ? html`
              <div class="topic-list">
                ${this._loggerDraft.map((sub, index) => {
                  const source = sources.find(m => normalizeUid(m.uid) === normalizeUid(sub.source_uid)) || sources[0];
                  const channels = source ? channelsForModule(source) : [];
                  const channelId = String(sub.channel_id);
                  return html`
                    <div class="topic-row">
                      <select .value=${sub.source_uid}
                              @change=${e => {
                                const nextSource = sources.find(m => normalizeUid(m.uid) === normalizeUid(e.target.value));
                                const firstCh = nextSource ? channelsForModule(nextSource)[0] : null;
                                this._updateLoggerSub(index, {
                                  source_uid: normalizeUid(e.target.value),
                                  channel_id: firstCh ? Number(firstCh[1]) : 0,
                                });
                              }}>
                        ${sources.map(src => html`
                          <option value=${normalizeUid(src.uid)} ?selected=${normalizeUid(src.uid) === normalizeUid(sub.source_uid)}>
                            ${slotLabel(src)}
                          </option>
                        `)}
                      </select>
                      <select .value=${channelId}
                              @change=${e => this._updateLoggerSub(index, { channel_id: Number(e.target.value) })}>
                        ${channels.map(([label, id]) => html`
                          <option value=${String(id)} ?selected=${String(id) === channelId}>${label}</option>
                        `)}
                      </select>
                      <select .value=${sub.mode}
                              @change=${e => this._updateLoggerSub(index, { mode: e.target.value })}>
                        ${LOGGER_MODES.map(([value, label]) => html`
                          <option value=${value} ?selected=${value === sub.mode}>${label}</option>
                        `)}
                      </select>
                      <input class="small" type="number" min="0" step="100"
                             .value=${String(sub.min_interval_ms)}
                             @change=${e => this._updateLoggerSub(index, { min_interval_ms: Number(e.target.value || 0) })}>
                      <input class="small" type="number" step="0.01"
                             .value=${String(sub.threshold)}
                             @change=${e => this._updateLoggerSub(index, { threshold: Number(e.target.value || 0) })}>
                      <button class="icon-act" title="Remove topic" @click=${() => this._removeLoggerSub(index)}>x</button>
                    </div>
                  `;
                })}
              </div>
              <div class="topic-actions">
                <button class="act" @click=${() => this._addLoggerSub(mod)}>add</button>
                <button class="act primary" @click=${() => this._applyLogger(mod)}>apply</button>
                <button class="act" @click=${() => wsClient.loggerInfo()}>refresh</button>
              </div>
            `
          : html`<div class="empty">No sensor topics available.</div>`}
      </section>
    `;
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

      ${this._renderLoggerTopics(mod)}
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
