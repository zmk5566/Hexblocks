/**
 * <wb-status-bar> — Bottom status bar.
 *
 * Shows connection state, module count, sample rate, and frame count.
 */
import { LitElement, html, css } from 'lit';
import { wsClient } from '../ws-client.js';
import { DEMO_PROGRAMS } from '../demo-programs.js';

export class WbStatusBar extends LitElement {
  static properties = {
    connected:   { type: Boolean },
    moduleCount: { type: Number },
    sampleRate:  { type: Number },
    frameCount:  { type: Number },
    theme:       { type: String, state: true },
    transport:   { type: Object, state: true },
    eca:         { type: Object, state: true },
    oscActive:   { type: Number },
  };

  static styles = css`
    :host {
      display: block;
    }

    .bar {
      display: flex;
      align-items: center;
      gap: 20px;
      padding: 4px 16px;
      background: var(--wb-surface);
      border-top: 1px solid var(--wb-border);
      font-size: 0.7rem;
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
      user-select: none;
    }

    .status-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .dot.on {
      background: #50C878;
      box-shadow: 0 0 6px rgba(80, 200, 120, 0.5);
    }

    .dot.off {
      background: var(--wb-danger);
      box-shadow: 0 0 6px rgba(255, 107, 107, 0.4);
    }

    .label {
      color: var(--wb-text-dim);
    }

    .value {
      color: var(--wb-text);
      font-weight: 600;
    }

    .sep {
      width: 1px;
      height: 12px;
      background: var(--wb-border);
    }

    .brand {
      margin-left: auto;
      font-size: 0.65rem;
      color: var(--wb-text-dim);
      opacity: 0.5;
      font-family: var(--wb-font);
      letter-spacing: 0.04em;
    }

    .rediscover {
      margin-left: auto;
      background: transparent;
      border: 1px solid var(--wb-border);
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
      font-size: 0.65rem;
      padding: 2px 8px;
      border-radius: 0;
      cursor: pointer;
    }
    .rediscover:hover {
      color: var(--wb-text);
      border-color: var(--wb-text-dim);
    }
    .rediscover:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .demo-btn {
      background: transparent;
      border: 1px solid var(--wb-border);
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
      font-size: 0.65rem;
      padding: 2px 8px;
      border-radius: 0;
      cursor: pointer;
    }
    .demo-btn:hover {
      color: var(--wb-text);
      border-color: var(--wb-text-dim);
    }
    .demo-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .demo-btn.first {
      /* Right-cluster begins at the ECA chip (margin-left:auto on .eca-chip).
       * Subsequent buttons just sit inline. */
    }

    .theme-toggle {
      background: transparent;
      border: 1px solid var(--wb-border);
      color: var(--wb-text-dim);
      font-size: 0.85rem;
      line-height: 1;
      padding: 2px 8px;
      cursor: pointer;
    }
    .theme-toggle:hover {
      color: var(--wb-text);
      border-color: var(--wb-text-dim);
    }

    .transport-btn {
      background: transparent;
      border: 1px solid var(--wb-border);
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
      font-size: 0.65rem;
      padding: 2px 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .transport-btn:hover { color: var(--wb-text); border-color: var(--wb-text-dim); }
    .transport-btn.active { color: var(--wb-text); border-color: var(--wb-text); }

    .eca-chip {
      margin-left: auto;
      background: transparent;
      border: 1px solid var(--wb-border);
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
      font-size: 0.65rem;
      padding: 2px 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .eca-chip:hover { color: var(--wb-text); border-color: var(--wb-text-dim); }
    .eca-chip.run  { color: var(--wb-text); border-color: var(--wb-text); }
    .eca-chip .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
    .eca-chip .dot.run  { background: #50C878; box-shadow: 0 0 4px rgba(80,200,120,.5); }
    .eca-chip .dot.stop { background: var(--wb-text-dim); }
    .eca-chip .dot.none { background: transparent; border: 1px solid var(--wb-text-dim); }
  `;

  constructor() {
    super();
    this.connected = false;
    this.moduleCount = 0;
    this.sampleRate = 0;
    this.frameCount = 0;
    this.theme = (window.themeController && window.themeController.current()) || 'light';
    this.transport = { transport: null, label: null, connected: false };
    this.eca = { has_program: false, running: false, num_rules: 0, num_vcs: 0, nvs_stored: false };
    this.oscActive = 0;
    this._onThemeChange = (e) => { this.theme = e.detail.theme; };
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('wb-theme-change', this._onThemeChange);
  }

  disconnectedCallback() {
    window.removeEventListener('wb-theme-change', this._onThemeChange);
    super.disconnectedCallback();
  }

  _runDemo(name) {
    wsClient.simCommand(name);
    const state = DEMO_PROGRAMS[name];
    if (!state) return;
    // Wait for the bridge's clear→add HELLO/descriptor round-trip so
    // the live module dropdowns refresh before the program loads. The
    // sim adds modules with ~300 ms spacing per type, so 1.5 s is a
    // safe upper bound for the largest preset (D3 = 3 modules).
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('wb-load-demo-program', {
        detail: { state },
      }));
    }, 1500);
  }

  _transportIcon() {
    const t = this.transport && this.transport.transport;
    if (t === 'ble')    return '⌬';
    if (t === 'serial') return '⎓';
    return '○';
  }

  _transportLabel() {
    const t = this.transport || {};
    if (!t.connected) return 'No link';
    if (t.transport === 'ble')    return t.label || 'BLE';
    if (t.transport === 'serial') return t.label || 'USB';
    return 'Linked';
  }

  _ecaSummary() {
    const e = this.eca || {};
    if (!e.has_program) return { dot: 'none', text: 'ECA: —', active: false };
    const text = `ECA: ${e.num_rules || 0}r${e.nvs_stored ? ' · NVS✓' : ''}`;
    return {
      dot: e.running ? 'run' : 'stop',
      text,
      active: !!e.running,
    };
  }

  render() {
    return html`
      <div class="bar">
        <div class="status-group">
          <span class="dot ${this.connected ? 'on' : 'off'}"></span>
          <span class="value">${this.connected ? 'Connected' : 'Disconnected'}</span>
        </div>

        <div class="sep"></div>

        <div class="status-group">
          <span class="label">Modules</span>
          <span class="value">${this.moduleCount}</span>
        </div>

        <div class="sep"></div>

        <div class="status-group">
          <span class="label">Rate</span>
          <span class="value">${this.sampleRate} Hz</span>
        </div>

        <div class="sep"></div>

        <div class="status-group">
          <span class="label">Frames</span>
          <span class="value">${this.frameCount.toLocaleString()}</span>
        </div>

        ${(() => { const e = this._ecaSummary(); return html`
          <button
            class="eca-chip ${e.active ? 'run' : ''}"
            title="ECA inspector — see/control the program currently on the hub"
            @click=${() => this.dispatchEvent(new CustomEvent('open-eca-inspector',
                { bubbles: true, composed: true }))}
          >
            <span class="dot ${e.dot}"></span>
            ${e.text}
          </button>
        `; })()}

        <button
          class="demo-btn first"
            title="Demo 1: clear hub, attach light + LED, and load a 2-rule night-light program. Sim-only."
          ?disabled=${!this.connected}
          @click=${() => this._runDemo('demo1')}
        >D1 Night Light</button>

        <button
          class="demo-btn"
          title="Demo 2: clear hub, attach light + audio, and load vc-mapped theremin rule. Sim-only."
          ?disabled=${!this.connected}
          @click=${() => this._runDemo('demo2')}
        >D2 Theremin</button>

        <button
          class="demo-btn"
          title="Demo 3: clear hub, attach LED + audio + IMU, and load motion-alert rule. Sim-only."
          ?disabled=${!this.connected}
          @click=${() => this._runDemo('demo3')}
        >D3 Motion Alert</button>

        <button
          class="rediscover"
          title="Broadcast REDISCOVER: force all modules to re-send HELLO. Use when a module is connected but not showing up."
          ?disabled=${!this.connected}
          @click=${() => { wsClient.queryDiscover(); wsClient.queryStatus(); wsClient.queryTopo(); }}
        >↻ Rediscover</button>

        <button
          class="transport-btn ${this.transport && this.transport.connected ? 'active' : ''}"
          title="Manage wireless devices (BLE pairing)"
          @click=${() => this.dispatchEvent(new CustomEvent('open-devices-panel',
              { bubbles: true, composed: true }))}
        >
          ${this._transportIcon()} ${this._transportLabel()}
        </button>

        <button
          class="osc-btn ${this.oscActive > 0 ? 'active' : ''}"
          title="Configure OSC forwarding (Mode B)"
          @click=${() => this.dispatchEvent(new CustomEvent('open-osc-panel',
              { bubbles: true, composed: true }))}
        >
          ⤳ OSC${this.oscActive > 0 ? ` ${this.oscActive}` : ''}
        </button>

        <button
          class="theme-toggle"
          title="Toggle light/dark theme"
          @click=${() => window.themeController && window.themeController.toggle()}
        >${this.theme === 'dark' ? '☀' : '☾'}</button>

        <span class="brand">WearBlocks v0.1</span>
      </div>
    `;
  }
}

customElements.define('wb-status-bar', WbStatusBar);
