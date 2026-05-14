/**
 * <wb-palette> — Module palette sidebar.
 *
 * Displays discovered hardware modules as cards.
 */
import { LitElement, html, css } from 'lit';

export class WbPalette extends LitElement {
  static properties = {
    modules: { type: Array },
  };

  static styles = css`
    :host {
      display: block;
      padding: 12px;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 4px 12px;
    }

    .title {
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--wb-text-dim);
    }

    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      padding: 0 6px;
      border-radius: 0;
      background: var(--wb-surface-2);
      color: var(--wb-accent);
      font-size: 0.7rem;
      font-weight: 700;
      font-family: var(--wb-mono);
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 32px 16px;
      text-align: center;
      color: var(--wb-text-dim);
      opacity: 0.6;
    }

    .empty-state .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--wb-text-dim);
      margin-bottom: 12px;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 1; }
    }

    .empty-state p {
      font-size: 0.8rem;
    }

    .module-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .hub-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      margin-bottom: 8px;
      border-radius: 0;
      background: var(--wb-surface-2);
      border-left: 4px solid var(--wb-hub);
      user-select: none;
    }
    .hub-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--wb-hub);
      box-shadow: 0 0 6px rgba(152, 152, 152, 0.6);
      flex-shrink: 0;
    }
    .hub-text { display: flex; flex-direction: column; }
    .hub-name {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--wb-text);
    }
    .hub-meta {
      font-size: 0.65rem;
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
    }
  `;

  constructor() {
    super();
    this.modules = [];
  }

  render() {
    const count = this.modules.length;

    return html`
      <div class="header">
        <span class="title">Modules</span>
        <span class="badge">${count}</span>
      </div>
      <div class="hub-row" title="Hub — runs the ECA engine and routes child modules">
        <span class="hub-dot"></span>
        <div class="hub-text">
          <span class="hub-name">Hub</span>
          <span class="hub-meta">ECA engine · ${count} module${count === 1 ? '' : 's'}</span>
        </div>
      </div>
      ${count === 0
        ? html`
          <div class="empty-state">
            <div class="dot"></div>
            <p>Waiting for modules...</p>
          </div>`
        : html`
          <div class="module-list">
            ${this.modules.map(m => html`
              <wb-module-card
                .moduleId=${m.id}
                .uid=${m.uid}
                .slot=${m.slot ?? null}
                .parent=${m.parent_is_hub === false ? (m.parent_uid ?? '') : 'HUB'}
                .parentFace=${m.parent_face ?? 0}
                .color=${m.color}
                .name=${m.name}
                .capabilities=${m.capabilities || []}
                .firmwareVersion=${m.firmware_version || ''}
                .fwHash=${m.fw_hash || ''}
                .active=${m.active !== false}>
              </wb-module-card>
            `)}
          </div>`
      }
    `;
  }
}

customElements.define('wb-palette', WbPalette);
