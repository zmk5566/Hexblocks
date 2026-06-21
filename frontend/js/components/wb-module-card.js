/**
 * <wb-module-card> — Individual module card in the palette.
 *
 * Shows module identity, slot, capabilities, and streaming status.
 */
import { LitElement, html, css } from 'lit';
import { dispatchOpenPanel } from './open-panel.js';

const LINK_LABELS = {
  can: 'CAN',
  wifi: 'Wi-Fi',
  dual: 'CAN+Wi-Fi',
  none: 'none',
};

const TOPOLOGY_LABELS = {
  physical: 'physical',
  remote_unplaced: 'remote',
  remote_placed: 'remote placed',
};

export class WbModuleCard extends LitElement {
  static properties = {
    moduleId:     { type: String },
    uid:          { type: String },
    slot:         { type: Number },   // legacy/sim fallback identity
    parent:       { type: String },   // "HUB" or parent module's uid
    parentRemote: { type: Boolean },
    parentFace:   { type: Number },
    color:        { type: String },
    name:         { type: String },
    capabilities: { type: Array },
    firmwareVersion: { type: String },
    fwHash:       { type: String },
    activeLink:   { type: String },
    transportMode:{ type: String },
    topologyState:{ type: String },
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
      padding-right: 48px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .meta {
      font-size: 0.7rem;
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
      margin-bottom: 6px;
      padding-right: 48px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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

    .link-row {
      display: flex;
      align-items: center;
      gap: 5px;
      margin: 6px 0;
      min-width: 0;
      font-family: var(--wb-mono);
      font-size: 0.64rem;
      color: var(--wb-text-dim);
    }

    .link-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
      padding: 2px 6px;
      border: 1px solid var(--wb-border);
      color: var(--wb-text);
      background: var(--wb-bg);
      font-weight: 700;
      line-height: 1.3;
    }

    .link-pill.wifi {
      border-color: var(--wb-accent);
      color: var(--wb-accent);
    }

    .link-pill.can {
      border-color: var(--card-color);
      color: var(--card-color);
    }

    .link-state {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .action-row {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-items: stretch;
    }

    .card-btn {
      padding: 2px 6px;
      min-width: 36px;
      border: 1px solid var(--wb-border);
      border-radius: 0;
      background: transparent;
      color: var(--wb-text-dim);
      font-size: 0.65rem;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      line-height: 1.4;
      font-family: var(--wb-mono);
      text-align: center;
    }

    .card-btn:hover {
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
    this.parentRemote = false;
    this.parentFace = 0;
    this.color = '#888888';
    this.name = '';
    this.capabilities = [];
    this.firmwareVersion = '';
    this.fwHash = '';
    this.activeLink = '';
    this.transportMode = '';
    this.topologyState = '';
    this.active = true;
  }

  _onViewClick(e) {
    e.stopPropagation();
    dispatchOpenPanel(this, { uid: this.uid, slot: this.slot });
  }

  _onInfoClick(e) {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('open-config', {
      detail: { targetType: 'module', uid: this.uid, slot: this.slot },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    const cardClass = this.active ? 'card active' : 'card inactive';
    // "HUB.F3" if hub-attached, "<parent_uid>.F<face>" if stacked, otherwise
    // show just the uid suffix.
    const where = this.parentRemote
      ? 'REMOTE'
      : this.parentFace > 0
        ? `${this.parent === 'HUB' ? 'HUB' : this.parent.slice(-4)}.F${this.parentFace}`
        : 'orphan';
    const uidShort = this.uid ? this.uid.slice(-4) : '????';
    const hasFirmware = this.firmwareVersion || this.fwHash;
    const fwVersion = this.firmwareVersion ? `v${this.firmwareVersion}` : 'v?';
    const fwHash = this.fwHash ? String(this.fwHash).toUpperCase() : '????';
    const activeLink = this.activeLink || 'none';
    const linkLabel = LINK_LABELS[activeLink] || activeLink;
    const linkClass = activeLink === 'wifi' ? 'wifi'
      : activeLink === 'can' ? 'can'
        : '';
    const topologyLabel = TOPOLOGY_LABELS[this.topologyState]
      || this.topologyState
      || 'topology pending';

    return html`
      <div class=${cardClass}
           style="border-left-color: ${this.color}; --card-color: ${this.color}">
        ${this.active ? html`<div class="pulse-border" style="background: ${this.color}"></div>` : ''}
        <div class="name">${this.name || this.moduleId || this.uid}</div>
        <div class="meta">${uidShort} &middot; ${where} &middot; ${this.moduleId}</div>
        ${hasFirmware ? html`
          <div class="meta">FW ${fwVersion} &middot; hash ${fwHash}</div>
        ` : ''}
        <div class="link-row" title=${`${linkLabel} · ${topologyLabel}`}>
          <span class=${`link-pill ${linkClass}`}>${linkLabel}</span>
          <span class="link-state">${topologyLabel}</span>
        </div>
        <div class="action-row">
          <button class="card-btn" @click=${this._onViewClick}>view</button>
          <button class="card-btn" @click=${this._onInfoClick}>info</button>
        </div>
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
