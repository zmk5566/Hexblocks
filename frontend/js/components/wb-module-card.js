/**
 * <wb-module-card> — Individual module card in the palette.
 *
 * Shows module identity, slot, capabilities, and streaming status.
 */
import { LitElement, html, css } from 'lit';
import { dispatchOpenPanel } from './open-panel.js';

export class WbModuleCard extends LitElement {
  static properties = {
    moduleId:     { type: String },
    uid:          { type: String },
    slot:         { type: Number },   // legacy/sim fallback identity
    parent:       { type: String },   // "HUB" or parent module's uid
    parentFace:   { type: Number },
    color:        { type: String },
    name:         { type: String },
    capabilities: { type: Array },
    firmwareVersion: { type: String },
    fwHash:       { type: String },
    active:       { type: Boolean },
  };

  static styles = css`
    :host {
      display: block;
    }

    .card {
      position: relative;
      padding: 10px 12px;
      border-radius: 0;
      background: var(--wb-surface-2);
      border-left: 4px solid var(--wb-border);
      transition: opacity 0.3s, border-color 0.3s;
      overflow: hidden;
    }

    .card.inactive {
      opacity: 0.45;
    }

    .card.active .pulse-border {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 4px;
      animation: border-pulse 1.5s ease-in-out infinite;
    }

    @keyframes border-pulse {
      0%, 100% { opacity: 0.6; }
      50% { opacity: 1; box-shadow: 0 0 8px var(--card-color); }
    }

    .name {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--wb-text);
      margin-bottom: 2px;
    }

    .meta {
      font-size: 0.7rem;
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
      margin-bottom: 6px;
    }

    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .tag {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 0;
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      background: var(--wb-cap-badge-bg);
      color: var(--wb-accent);
    }

    .view-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      padding: 2px 6px;
      border: 1px solid var(--wb-border);
      border-radius: 0;
      background: transparent;
      color: var(--wb-text-dim);
      font-size: 0.65rem;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      line-height: 1.4;
    }

    .view-btn:hover {
      background: var(--wb-accent);
      color: var(--wb-bg);
      border-color: var(--wb-accent);
    }
  `;

  constructor() {
    super();
    this.moduleId = '';
    this.uid = '';
    this.parent = 'HUB';
    this.parentFace = 0;
    this.color = '#888888';
    this.name = '';
    this.capabilities = [];
    this.firmwareVersion = '';
    this.fwHash = '';
    this.active = true;
  }

  _onViewClick(e) {
    e.stopPropagation();
    dispatchOpenPanel(this, { uid: this.uid, slot: this.slot });
  }

  render() {
    const cardClass = this.active ? 'card active' : 'card inactive';
    // "HUB.F3" if hub-attached, "<parent_uid>.F<face>" if stacked, otherwise
    // show just the uid suffix.
    const where = this.parentFace > 0
      ? `${this.parent === 'HUB' ? 'HUB' : this.parent.slice(-4)}.F${this.parentFace}`
      : 'orphan';
    const uidShort = this.uid ? this.uid.slice(-4) : '????';
    const hasFirmware = this.firmwareVersion || this.fwHash;
    const fwVersion = this.firmwareVersion ? `v${this.firmwareVersion}` : 'v?';
    const fwHash = this.fwHash ? String(this.fwHash).toUpperCase() : '????';

    return html`
      <div class=${cardClass}
           style="border-left-color: ${this.color}; --card-color: ${this.color}">
        ${this.active ? html`<div class="pulse-border" style="background: ${this.color}"></div>` : ''}
        <button class="view-btn" @click=${this._onViewClick}>view</button>
        <div class="name">${this.name || this.moduleId || this.uid}</div>
        <div class="meta">${uidShort} &middot; ${where} &middot; ${this.moduleId}</div>
        ${hasFirmware ? html`
          <div class="meta">FW ${fwVersion} &middot; hash ${fwHash}</div>
        ` : ''}
        <div class="tags">
          ${(this.capabilities || []).map(cap => html`
            <span class="tag">${cap}</span>
          `)}
        </div>
      </div>
    `;
  }
}

customElements.define('wb-module-card', WbModuleCard);
