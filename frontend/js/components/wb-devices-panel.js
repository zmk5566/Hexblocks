/**
 * <wb-devices-panel> — Wireless device pairing modal.
 *
 * Lets the user scan for nearby HEX-* hubs over BLE, connect/forget
 * paired devices, and toggle which one auto-reconnects on bridge start.
 * The bridge owns the source of truth (paired_devices.json); this panel
 * mirrors it for display.
 *
 * Bridge protocol (WS messages):
 *   ←  {type:'transport_status', transport:'serial'|'ble'|null,
 *       address, label, connected}
 *   ←  {type:'paired_devices', devices:[{address,name,last_seen,auto_reconnect}]}
 *   ←  {type:'ble_scan_started', duration}
 *   ←  {type:'ble_scan_result', address, name, rssi}
 *   ←  {type:'ble_scan_done', count}
 *   ←  {type:'ble_scan_error', error}
 *   →  {action:'ble_scan', duration}
 *   →  {action:'ble_connect', address, name}
 *   →  {action:'ble_disconnect'}
 *   →  {action:'ble_forget', address}
 *   →  {action:'ble_set_auto_reconnect', address, name, enable}
 */
import { LitElement, html, css } from 'lit';
import { wsClient } from '../ws-client.js';

const SCAN_DURATION_S = 5;

export class WbDevicesPanel extends LitElement {
  static properties = {
    open:         { type: Boolean, reflect: true },
    _scanning:    { type: Boolean, state: true },
    _scanResults: { type: Array,   state: true },
    _paired:      { type: Array,   state: true },
    _transport:   { type: Object,  state: true },
    _error:       { type: String,  state: true },
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
    :host([open]) {
      display: flex;
    }
    .modal {
      width: 520px;
      max-width: 92vw;
      max-height: 80vh;
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

    .transport-banner {
      font-family: var(--wb-mono);
      font-size: 0.7rem;
      padding: 8px 10px;
      border: 1px solid var(--wb-border);
      background: var(--wb-bg, transparent);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .transport-banner .dot {
      width: 7px; height: 7px; border-radius: 50%;
    }
    .transport-banner .dot.on  { background: #50C878; }
    .transport-banner .dot.off { background: var(--wb-danger); }
    .transport-banner .label   { color: var(--wb-text); font-weight: 600; }
    .transport-banner .meta    { color: var(--wb-text-dim); margin-left: auto; }
    .transport-banner button {
      background: transparent;
      border: 1px solid var(--wb-border);
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
      font-size: 0.65rem;
      padding: 2px 8px;
      cursor: pointer;
    }
    .transport-banner button:hover { color: var(--wb-text); }

    section h3 {
      margin: 0 0 6px 0;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--wb-text-dim);
      font-weight: 600;
    }

    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border: 1px solid var(--wb-border);
      margin-bottom: 6px;
      font-family: var(--wb-mono);
      font-size: 0.72rem;
    }
    .row .name  { color: var(--wb-text); font-weight: 600; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; }
    .row .addr  { color: var(--wb-text-dim); font-size: 0.65rem; }
    .row .rssi  { color: var(--wb-text-dim); font-size: 0.65rem; min-width: 50px; text-align: right; }
    .row .actions { display: flex; gap: 4px; }

    button.act {
      background: transparent;
      border: 1px solid var(--wb-border);
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
      font-size: 0.65rem;
      padding: 3px 8px;
      cursor: pointer;
    }
    button.act:hover  { color: var(--wb-text); border-color: var(--wb-text-dim); }
    button.act.primary { color: var(--wb-text); border-color: var(--wb-text); }
    button.act:disabled { opacity: 0.4; cursor: not-allowed; }

    .scan-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .scan-bar .hint {
      color: var(--wb-text-dim);
      font-size: 0.65rem;
      font-family: var(--wb-mono);
    }
    .empty {
      padding: 10px;
      color: var(--wb-text-dim);
      font-size: 0.7rem;
      font-style: italic;
      text-align: center;
    }
    .error {
      color: var(--wb-danger);
      font-size: 0.7rem;
      padding: 6px 8px;
      border: 1px solid var(--wb-danger);
    }

    label.toggle {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.65rem;
      color: var(--wb-text-dim);
      cursor: pointer;
    }
    label.toggle input { margin: 0; }
  `;

  constructor() {
    super();
    this.open = false;
    this._scanning = false;
    this._scanResults = [];
    this._paired = [];
    this._transport = { transport: null, label: null, address: null, connected: false };
    this._error = '';
    this._onMsg = (msg) => this._handleMessage(msg);
  }

  connectedCallback() {
    super.connectedCallback();
    wsClient.onMessage(this._onMsg);
    document.addEventListener('keydown', this._onKey = (e) => {
      if (e.key === 'Escape' && this.open) this._close();
    });
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this._onKey);
    super.disconnectedCallback();
  }

  _handleMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'transport_status':
        this._transport = { ...msg };
        break;
      case 'paired_devices':
        this._paired = Array.isArray(msg.devices) ? msg.devices : [];
        break;
      case 'ble_scan_started':
        this._scanning = true;
        this._scanResults = [];
        this._error = '';
        break;
      case 'ble_scan_result':
        // Dedupe by address; update RSSI / name on re-discovery.
        this._scanResults = [
          ...this._scanResults.filter(d => d.address !== msg.address),
          { address: msg.address, name: msg.name || '(unnamed)', rssi: msg.rssi },
        ].sort((a, b) => (b.rssi || 0) - (a.rssi || 0));
        break;
      case 'ble_scan_done':
        this._scanning = false;
        break;
      case 'ble_scan_error':
        this._scanning = false;
        this._error = msg.error || 'scan failed';
        break;
    }
  }

  _close() {
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  _scan() {
    this._scanning = true;
    this._scanResults = [];
    this._error = '';
    wsClient.send({ action: 'ble_scan', duration: SCAN_DURATION_S });
  }

  _connect(addr, name) {
    wsClient.send({ action: 'ble_connect', address: addr, name: name || addr });
  }

  _disconnect() {
    wsClient.send({ action: 'ble_disconnect' });
  }

  _forget(addr) {
    wsClient.send({ action: 'ble_forget', address: addr });
  }

  _toggleAutoReconnect(d, enable) {
    wsClient.send({
      action: 'ble_set_auto_reconnect',
      address: d.address,
      name: d.name || '',
      enable,
    });
  }

  _isActive(addr) {
    return this._transport.connected && this._transport.address === addr;
  }

  _rssiBars(rssi) {
    if (rssi == null) return '····';
    if (rssi >= -55) return '████';
    if (rssi >= -67) return '███·';
    if (rssi >= -80) return '██··';
    if (rssi >= -90) return '█···';
    return '····';
  }

  render() {
    const t = this._transport || {};
    const transportLabel = t.transport
      ? `${t.transport.toUpperCase()} · ${t.label || t.address || ''}`
      : 'No transport';
    return html`
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        <header>
          <h2>Wireless Devices</h2>
          <button class="close" @click=${this._close} title="Close (Esc)">✕</button>
        </header>
        <div class="body">

          <div class="transport-banner">
            <span class="dot ${t.connected ? 'on' : 'off'}"></span>
            <span class="label">${transportLabel}</span>
            <span class="meta">${t.connected ? 'connected' : 'idle'}</span>
            ${t.connected && t.transport === 'ble' ? html`
              <button class="act" @click=${this._disconnect}>Disconnect</button>
            ` : ''}
          </div>

          ${this._error ? html`<div class="error">${this._error}</div>` : ''}

          <section>
            <h3>Paired Devices</h3>
            ${this._paired.length === 0
              ? html`<div class="empty">No paired devices yet — scan and connect to add one.</div>`
              : this._paired.map(d => html`
                  <div class="row">
                    <span class="name">${d.name || '(unnamed)'}</span>
                    <span class="addr">${d.address}</span>
                    <span class="actions">
                      <label class="toggle" title="Auto-connect this device on bridge startup">
                        <input type="checkbox"
                               .checked=${!!d.auto_reconnect}
                               @change=${(e) => this._toggleAutoReconnect(d, e.target.checked)}>
                        auto
                      </label>
                      ${this._isActive(d.address)
                        ? html`<button class="act" disabled>Active</button>`
                        : html`<button class="act primary"
                                       @click=${() => this._connect(d.address, d.name)}>Connect</button>`}
                      <button class="act" @click=${() => this._forget(d.address)}>Forget</button>
                    </span>
                  </div>
                `)}
          </section>

          <section>
            <h3>Scan</h3>
            <div class="scan-bar">
              <button class="act primary"
                      ?disabled=${this._scanning}
                      @click=${this._scan}>
                ${this._scanning ? 'Scanning…' : 'Scan for hubs'}
              </button>
              <span class="hint">Discovers nearby HEX-* peripherals (${SCAN_DURATION_S}s)</span>
            </div>
            ${this._scanResults.length === 0
              ? html`<div class="empty">${this._scanning
                  ? 'Looking for hubs…'
                  : 'No results yet. Click Scan.'}</div>`
              : this._scanResults.map(d => {
                  const known = this._paired.some(p => p.address === d.address);
                  return html`
                    <div class="row">
                      <span class="name">${d.name}</span>
                      <span class="addr">${d.address}</span>
                      <span class="rssi">${this._rssiBars(d.rssi)} ${d.rssi}dBm</span>
                      <span class="actions">
                        ${this._isActive(d.address)
                          ? html`<button class="act" disabled>Active</button>`
                          : html`<button class="act primary"
                                         @click=${() => this._connect(d.address, d.name)}>
                                   ${known ? 'Connect' : 'Pair'}
                                 </button>`}
                      </span>
                    </div>
                  `;
                })}
          </section>

        </div>
      </div>
    `;
  }
}

customElements.define('wb-devices-panel', WbDevicesPanel);
