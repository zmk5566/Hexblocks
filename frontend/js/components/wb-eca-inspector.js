/**
 * <wb-eca-inspector> — ECA hub inspector modal.
 *
 * Shows the program currently running on the hub (decoded from $EB
 * bytecode), with engine controls for Run/Stop and persistence controls
 * for "erase NVS only" / "erase everything". Uses the same modal
 * scaffolding as <wb-devices-panel>.
 *
 * Bridge protocol (WS messages):
 *   ←  {type:'eca_status', running, has_program, num_rules, num_vcs,
 *       raw_len, nvs_stored}
 *   ←  {type:'eca_bytecode', base64}
 *   →  {action:'query', command:'ECA'}     refresh
 *   →  {action:'program_run' | 'program_stop' | 'program_clear' | 'program_erase_nvs'}
 *
 * Events dispatched:
 *   apply-rules  detail: {rules}   — consumed by wb-app → wb-block-canvas.applyRules()
 *   close                          — request close from parent
 */
import { LitElement, html, css } from 'lit';
import { wsClient } from '../ws-client.js';
import { decodeBytecode, describeRules } from '../eca-decoder.js';

export class WbEcaInspector extends LitElement {
  static properties = {
    open:        { type: Boolean, reflect: true },
    /** Latest eca_status message. */
    status:      { type: Object },
    /** Map { uid: {id, name} } for label resolution. Caller-supplied. */
    modulesByUid: { type: Object },
    /** Snapshot of the local Blockly workspace rules; used to decide
     *  whether "Load into canvas" needs a confirm. */
    localRules:  { type: Object },
    _decoded:    { type: Object,  state: true },
    _decodeErr:  { type: String,  state: true },
    _confirmClear: { type: Boolean, state: true },
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
      width: 620px;
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
      gap: 8px;
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
    .icon-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--wb-text-dim);
      font-size: 0.8rem;
      cursor: pointer;
      padding: 2px 8px;
    }
    .icon-btn:hover { color: var(--wb-text); border-color: var(--wb-border); }

    .body {
      overflow-y: auto;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .banner {
      font-family: var(--wb-mono);
      font-size: 0.7rem;
      padding: 8px 10px;
      border: 1px solid var(--wb-border);
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .banner .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .banner .dot.run  { background: #50C878; box-shadow: 0 0 6px rgba(80,200,120,.5); }
    .banner .dot.stop { background: var(--wb-text-dim); }
    .banner .dot.none { background: var(--wb-danger); }
    .banner .label  { color: var(--wb-text); font-weight: 600; }
    .banner .meta   { color: var(--wb-text-dim); }

    section h3 {
      margin: 0 0 6px 0;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--wb-text-dim);
      font-weight: 600;
    }

    pre.rules {
      margin: 0;
      padding: 10px 12px;
      border: 1px solid var(--wb-border);
      background: var(--wb-bg, transparent);
      font-family: var(--wb-mono);
      font-size: 0.7rem;
      line-height: 1.5;
      color: var(--wb-text);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 280px;
      overflow-y: auto;
    }

    .empty, .error {
      padding: 10px;
      font-size: 0.7rem;
      text-align: center;
      border: 1px solid var(--wb-border);
    }
    .empty { color: var(--wb-text-dim); font-style: italic; }
    .error { color: var(--wb-danger); border-color: var(--wb-danger); }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    button.act {
      background: transparent;
      border: 1px solid var(--wb-border);
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
      font-size: 0.65rem;
      padding: 4px 10px;
      cursor: pointer;
    }
    button.act:hover  { color: var(--wb-text); border-color: var(--wb-text-dim); }
    button.act.primary { color: var(--wb-text); border-color: var(--wb-text); }
    button.act.danger { color: var(--wb-danger); border-color: var(--wb-danger); }
    button.act.danger.confirm { background: var(--wb-danger); color: #fff; }
    button.act:disabled { opacity: 0.4; cursor: not-allowed; }

    .actions .spacer { flex: 1; }
  `;

  constructor() {
    super();
    this.open = false;
    this.status = null;
    this.modulesByUid = null;
    this.localRules = null;
    this._decoded = null;
    this._decodeErr = '';
    this._confirmClear = false;
    this._lastBytecodeB64 = '';
    this._onMsg = (msg) => this._handleMessage(msg);
    this._onKey = (e) => {
      if (e.key === 'Escape' && this.open) this._close();
    };
  }

  connectedCallback() {
    super.connectedCallback();
    wsClient.onMessage(this._onMsg);
    document.addEventListener('keydown', this._onKey);
  }

  disconnectedCallback() {
    wsClient.offMessage?.(this._onMsg);
    document.removeEventListener('keydown', this._onKey);
    super.disconnectedCallback();
  }

  updated(changed) {
    if (changed.has('open') && this.open) this._refresh();
  }

  _handleMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'eca_bytecode') {
      // Cache the raw base64 so we don't redo the decode on prop refresh,
      // and so we can re-encode for the apply-rules dispatch.
      if (msg.base64 && msg.base64 !== this._lastBytecodeB64) {
        this._lastBytecodeB64 = msg.base64;
        try {
          this._decoded = decodeBytecode(msg.base64);
          this._decodeErr = '';
        } catch (e) {
          this._decoded = null;
          this._decodeErr = e.message || String(e);
        }
        this.requestUpdate();
      }
    } else if (msg.type === 'eca_status') {
      // If the hub reports has_program=false, drop our cached decoded
      // payload so the inspector matches reality (otherwise stale
      // contents would linger after a $PC).
      if (msg.has_program === false) {
        this._decoded = null;
        this._lastBytecodeB64 = '';
      }
    }
  }

  _close() {
    this._confirmClear = false;
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  _refresh() {
    wsClient.queryEca();
  }

  _run()      { wsClient.programRun(); }
  _stop()     { wsClient.programStop(); }
  _eraseNvs() { wsClient.programEraseNvs(); }

  _eraseAll() {
    if (!this._confirmClear) {
      this._confirmClear = true;
      // Auto-revert the prompt after a few seconds so it can't stay
      // armed indefinitely.
      setTimeout(() => { this._confirmClear = false; this.requestUpdate(); }, 4000);
      return;
    }
    this._confirmClear = false;
    wsClient.programClear();
  }

  _hasLocalRules() {
    const r = this.localRules;
    if (!r) return false;
    const nRules = (r.rules || []).length;
    const nVcs   = (r.virtual_channels || []).length;
    return (nRules + nVcs) > 0;
  }

  _loadIntoCanvas() {
    if (!this._decoded) return;
    if (this._hasLocalRules()) {
      const ok = window.confirm(
        'Replace the local Blockly workspace with the program from the hub? ' +
        'Your unsaved local rules will be lost.');
      if (!ok) return;
    }
    this.dispatchEvent(new CustomEvent('apply-rules', {
      detail: { rules: this._decoded, markDirty: false },
      bubbles: true,
      composed: true,
    }));
    this._close();
  }

  _renderBanner() {
    const s = this.status || {};
    const has = !!s.has_program;
    const running = !!s.running;
    const dotClass = !has ? 'none' : (running ? 'run' : 'stop');
    const dotLabel = !has ? 'No program' : (running ? 'Running' : 'Stopped');
    return html`
      <div class="banner">
        <span class="dot ${dotClass}"></span>
        <span class="label">${dotLabel}</span>
        ${has ? html`
          <span class="meta">${s.num_rules || 0} rules · ${s.num_vcs || 0} VCs · ${s.raw_len || 0} B</span>
          <span class="meta">${s.nvs_stored ? 'NVS ✓' : 'NVS ✗'}</span>
        ` : ''}
      </div>
    `;
  }

  _renderRules() {
    if (this._decodeErr) {
      return html`<div class="error">Decode failed: ${this._decodeErr}</div>`;
    }
    if (!this._decoded) {
      const s = this.status || {};
      const msg = s.has_program
        ? 'Waiting for hub to send bytecode…'
        : 'No program loaded on the hub.';
      return html`<div class="empty">${msg}</div>`;
    }
    const lines = describeRules(this._decoded, this.modulesByUid || {});
    if (lines.length === 0) {
      return html`<div class="empty">Empty program (no rules, VCs, or variables).</div>`;
    }
    return html`<pre class="rules">${lines.join('\n')}</pre>`;
  }

  render() {
    const s = this.status || {};
    const has = !!s.has_program;
    const running = !!s.running;
    return html`
      <div class="modal" @click=${(e) => e.stopPropagation()}>
        <header>
          <h2>ECA Inspector</h2>
          <button class="icon-btn" title="Refresh from hub" @click=${this._refresh}>↻</button>
          <button class="icon-btn" title="Close (Esc)" @click=${this._close}>✕</button>
        </header>
        <div class="body">

          ${this._renderBanner()}

          <section>
            <h3>Program</h3>
            ${this._renderRules()}
          </section>

          <section>
            <h3>Engine</h3>
            <div class="actions">
              <button class="act primary"
                      ?disabled=${!has || running}
                      @click=${this._run}>▶ Run</button>
              <button class="act"
                      ?disabled=${!running}
                      @click=${this._stop}>⏸ Stop</button>
              <button class="act primary"
                      ?disabled=${!this._decoded}
                      @click=${this._loadIntoCanvas}
                      title="Replace the Blockly workspace with this program">
                ⤓ Load into canvas
              </button>
              <span class="spacer"></span>
              <button class="act"
                      ?disabled=${!s.nvs_stored}
                      @click=${this._eraseNvs}
                      title="Don't auto-restore on next boot. Current session keeps running.">
                Erase NVS only
              </button>
              <button class="act danger ${this._confirmClear ? 'confirm' : ''}"
                      ?disabled=${!has}
                      @click=${this._eraseAll}
                      title="Clear runtime + wipe NVS. Click twice to confirm.">
                ${this._confirmClear ? 'Click again to confirm' : 'Erase everything'}
              </button>
            </div>
          </section>

        </div>
      </div>
    `;
  }
}

customElements.define('wb-eca-inspector', WbEcaInspector);
