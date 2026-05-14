/**
 * <wb-sensor-panel> — Per-module sensor data panel.
 *
 * Displays real-time values derived dynamically from the module's descriptor
 * (caps[].m, caps[].ax, caps[].rn/rx) and renders a scrolling line chart.
 * Supports multiple simultaneous instances, one per open module.
 */
import { LitElement, html, css } from 'lit';

const HISTORY_LEN = 200;

// 12-color palette for auto-assignment by field index
const FIELD_COLORS = [
  '#7CA1BB', '#9DBBCD', '#BDCFDC',  // slates (IMU)
  '#C1B496', '#CFC4AC', '#DDD3C2',  // tans (light sensor)
  '#9885BF', '#B0A0CD', '#C8BBDB',  // purples (speaker)
  '#C68E9E', '#D3A8B5', '#E0C2CC',  // roses (LED)
];

export class WbSensorPanel extends LitElement {
  static properties = {
    sensorData:     { type: Object },
    actuatorState:  { type: Object },  // { led: {...}, vib: {...} } from bridge actuator_state
    slot:           { type: Number },
    module:         { type: Object },
    closeable:      { type: Boolean },
    _collapsed:     { type: Boolean, state: true },
  };

  static styles = css`
    :host {
      display: block;
      height: 100%;
      min-width: 480px;
      flex: 1 0 480px;
      overflow: hidden;
      border-right: 1px solid var(--wb-border);
    }

    :host(:last-child) {
      border-right: none;
    }

    .panel {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 5px 12px;
      border-bottom: 1px solid var(--wb-border);
      user-select: none;
      flex-shrink: 0;
    }

    .panel-title-area {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }

    .color-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .panel-title {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--wb-text-dim);
    }

    .panel-slot {
      font-size: 0.6rem;
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
      opacity: 0.4;
      padding: 1px 5px;
      border-radius: 0;
      border: 1px solid var(--wb-border);
      cursor: help;
    }
    .panel-slot:hover { opacity: 0.85; }

    .cap-chips {
      display: inline-flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .cap-chip {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 0;
      font-size: 0.55rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--wb-cap-badge-bg);
      color: var(--wb-accent);
    }

    .toggle {
      font-size: 0.7rem;
      color: var(--wb-text-dim);
    }

    .close-btn {
      padding: 1px 5px;
      border: 1px solid var(--wb-border);
      border-radius: 0;
      background: transparent;
      color: var(--wb-text-dim);
      font-size: 0.75rem;
      cursor: pointer;
      line-height: 1.4;
      transition: background 0.15s, color 0.15s;
    }

    .close-btn:hover {
      background: var(--wb-danger, #ff6b6b);
      color: #fff;
      border-color: transparent;
    }

    .panel-body {
      display: flex;
      flex: 1;
      min-height: 0;
      gap: 12px;
      padding: 8px 12px;
      overflow: hidden;
    }

    .panel-body.hidden {
      display: none;
    }

    /* Data grid */
    .data-col {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 200px;
      overflow-y: auto;
    }

    .modality-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .modality-label {
      font-size: 0.62rem;
      font-weight: 600;
      color: var(--wb-text-dim);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .fields-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .data-cell {
      display: flex;
      flex-direction: column;
      padding: 5px 8px;
      border-radius: 0;
      background: var(--wb-surface-2);
      min-width: 60px;
    }

    .data-label {
      font-size: 0.58rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 1px;
    }

    .data-value {
      font-size: 0.95rem;
      font-weight: 600;
      font-family: var(--wb-mono);
      color: var(--wb-text);
    }

    /* Chart */
    .chart-wrap {
      flex: 1;
      min-width: 0;
      position: relative;
    }

    canvas {
      width: 100%;
      height: 100%;
      display: block;
      border-radius: 0;
      background: var(--wb-surface-2);
    }

    .chart-legend {
      position: absolute;
      top: 6px;
      right: 8px;
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      max-width: 60%;
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 0.58rem;
      color: var(--wb-text-dim);
      font-family: var(--wb-mono);
    }

    .legend-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    /* Empty state */
    .empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--wb-text-dim);
      font-size: 0.8rem;
      opacity: 0.5;
    }

    /* ── Actuator section ──────────────────────── */
    .actuator-section {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      padding: 10px 14px 12px 14px;
      border-bottom: 1px solid var(--wb-border);
      align-items: center;
    }
    .actuator-label {
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--wb-text-dim);
      margin-bottom: 3px;
    }
    .actuator-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .led-swatch {
      width: 56px;
      height: 40px;
      border-radius: 0;
      border: 1px solid var(--wb-border);
      transition: background 0.15s, opacity 0.2s, box-shadow 0.2s;
    }
    .led-meta {
      font-size: 0.68rem;
      color: var(--wb-text-dim);
      font-family: var(--wb-mono, monospace);
    }
    .led-meta .mode { color: var(--wb-text); font-weight: 600; }
    .vib-bar-wrap {
      width: 90px;
      height: 10px;
      background: var(--wb-surface-2);
      border-radius: 0;
      overflow: hidden;
      position: relative;
    }
    .vib-bar {
      height: 100%;
      background: linear-gradient(90deg, #64ffda, #50c878);
      transition: width 0.15s;
    }
    .vib-pulse { animation: vib-pulse 0.25s ease-in-out infinite alternate; }
    @keyframes vib-pulse {
      from { opacity: 0.6; }
      to   { opacity: 1.0; }
    }
  `;

  constructor() {
    super();
    this.sensorData = null;
    this.slot = 0;
    this.module = null;
    this.closeable = false;
    this._collapsed = false;
    this._history = {};
    this._animFrameId = null;
    // Cache computed field groups to avoid recalculating every frame
    this._fieldGroups = [];
    this._allFields = [];
    this._colorMap = {};
  }

  connectedCallback() {
    super.connectedCallback();
    this._startRenderLoop();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._animFrameId) cancelAnimationFrame(this._animFrameId);
  }

  /**
   * Derive field groups from module descriptor caps + actual data keys.
   * caps[].ax tells us how many consecutive data keys belong to each modality.
   */
  _computeFieldGroups() {
    const dataKeys = Object.keys(this.sensorData?.data ?? {});
    if (!dataKeys.length) return [];

    const caps = this.module?.descriptor?.caps ?? [];
    // Filter to sensor caps only
    const sensorCaps = caps.filter(c => c.t !== 'actuator');

    if (!sensorCaps.length) {
      return [{ label: 'Sensor', fields: dataKeys, rn: null, rx: null }];
    }

    const groups = [];
    let offset = 0;
    for (const cap of sensorCaps) {
      const n = cap.ax ?? 1;
      const fields = dataKeys.slice(offset, offset + n);
      if (fields.length) {
        groups.push({
          label: cap.m || 'Data',
          fields,
          rn: cap.rn ?? null,
          rx: cap.rx ?? null,
        });
      }
      offset += n;
    }
    if (offset < dataKeys.length) {
      groups.push({ label: 'Other', fields: dataKeys.slice(offset), rn: null, rx: null });
    }
    return groups;
  }

  updated(changed) {
    if (changed.has('sensorData') && this.sensorData?.data) {
      const d = this.sensorData.data;
      const keys = Object.keys(d);

      // Recompute field groups when data keys change
      const keyStr = keys.join(',');
      if (keyStr !== this._lastKeyStr || changed.has('module')) {
        this._lastKeyStr = keyStr;
        this._fieldGroups = this._computeFieldGroups();
        this._allFields = this._fieldGroups.flatMap(g => g.fields);

        // Assign colors by overall field index
        this._colorMap = {};
        this._allFields.forEach((f, i) => {
          this._colorMap[f] = FIELD_COLORS[i % FIELD_COLORS.length];
        });

        // Initialize history for new fields
        for (const f of this._allFields) {
          if (!this._history[f]) this._history[f] = [];
        }
      }

      // Append to history
      for (const f of this._allFields) {
        this._history[f].push(d[f] ?? 0);
        if (this._history[f].length > HISTORY_LEN) this._history[f].shift();
      }
    }
  }

  _startRenderLoop() {
    const draw = () => {
      this._drawChart();
      this._animFrameId = requestAnimationFrame(draw);
    };
    this._animFrameId = requestAnimationFrame(draw);
  }

  _drawChart() {
    const canvas = this.renderRoot?.querySelector('canvas');
    if (!canvas || !this._allFields.length) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);

    if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const ml = 36, mr = 8, mt = 8, mb = 18;
    const cw = w - ml - mr;
    const ch = h - mt - mb;
    if (cw <= 0 || ch <= 0) return;

    // Global min/max
    let yMin = Infinity, yMax = -Infinity;
    for (const f of this._allFields) {
      for (const v of (this._history[f] || [])) {
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
    if (!isFinite(yMin)) { yMin = -1; yMax = 1; }
    const yPad = (yMax - yMin) * 0.1 || 1;
    yMin -= yPad;
    yMax += yPad;

    // Grid
    const themeCols = (window.themeController && window.themeController.getThemeColors)
      ? window.themeController.getThemeColors()
      : { border: '#2d3a5a', textDim: '#8892b0' };
    ctx.strokeStyle = themeCols.border;
    ctx.lineWidth = 0.5;
    const numGrid = 4;
    for (let i = 0; i <= numGrid; i++) {
      const y = mt + (ch * i) / numGrid;
      ctx.beginPath();
      ctx.moveTo(ml, y);
      ctx.lineTo(ml + cw, y);
      ctx.stroke();
    }

    // Y-axis labels
    ctx.fillStyle = themeCols.textDim;
    ctx.font = '9px system-ui';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= numGrid; i++) {
      const y = mt + (ch * i) / numGrid;
      const val = yMax - ((yMax - yMin) * i) / numGrid;
      ctx.fillText(val.toFixed(1), ml - 4, y);
    }

    // X-axis label
    ctx.fillStyle = themeCols.textDim;
    ctx.font = '8px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`last ${HISTORY_LEN} samples`, ml + cw / 2, h - mb + 4);

    // Lines
    for (const f of this._allFields) {
      const data = this._history[f];
      if (!data || data.length < 2) continue;

      ctx.beginPath();
      ctx.strokeStyle = this._colorMap[f] || '#888';
      ctx.lineWidth = 1.2;
      ctx.lineJoin = 'round';

      const startIdx = HISTORY_LEN - data.length;
      for (let i = 0; i < data.length; i++) {
        const x = ml + ((startIdx + i) / (HISTORY_LEN - 1)) * cw;
        const y = mt + ch - ((data[i] - yMin) / (yMax - yMin)) * ch;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  _formatValue(v) {
    if (v === undefined || v === null) return '--';
    return typeof v === 'number' ? v.toFixed(3) : String(v);
  }

  /**
   * Color-code a value relative to a known range [rn, rx].
   * Falls back to text color when no range is available.
   */
  _valueColor(val, rn, rx) {
    if (val === undefined || rn === null || rx === null) return 'var(--wb-text)';
    const range = Math.abs(rx - rn);
    if (range === 0) return 'var(--wb-text)';
    const abs = Math.abs(val - (rn + rx) / 2) / (range / 2);
    if (abs > 0.9) return 'var(--wb-danger, #ff6b6b)';
    if (abs > 0.7) return 'var(--wb-accent)';
    return 'var(--wb-text)';
  }

  _close() {
    this.dispatchEvent(new CustomEvent('close-panel', {
      detail: { uid: this.module?.uid ?? null, slot: this.slot },
      bubbles: true,
      composed: true,
    }));
  }

  /** True if the module declares any actuator capability in its descriptor. */
  _hasActuatorCaps() {
    const caps = this.module?.descriptor?.caps ?? [];
    return caps.some(c => c.t === 'actuator');
  }

  _renderActuatorSection() {
    if (!this._hasActuatorCaps()) return '';
    const caps = this.module?.descriptor?.caps ?? [];
    const hasLed = caps.some(c => c.t === 'actuator' && (c.m || '').includes('light'));
    const hasVib = caps.some(c => c.t === 'actuator' && (c.m || '').includes('vibration'));
    const st = this.actuatorState || {};
    const led = st.led || { mode: 'off', r: 0, g: 0, b: 0, brightness: 0, until_ms: 0 };
    const vib = st.vib || { mode: 'off', intensity: 0, until_ms: 0 };
    const now = Date.now();

    const ledOn = led.mode && led.mode !== 'off';
    const ledRemaining = (led.until_ms && led.until_ms > now)
      ? Math.max(0, led.until_ms - now) : 0;
    const ledBg = ledOn ? `rgb(${led.r},${led.g},${led.b})` : '#222';
    const ledOpacity = ledOn ? ((led.brightness || 255) / 255) : 0.25;
    const ledGlow = ledOn
      ? `box-shadow: 0 0 14px rgba(${led.r},${led.g},${led.b},0.55);`
      : '';

    const vibOn = vib.mode && vib.mode !== 'off';
    const vibRemaining = (vib.until_ms && vib.until_ms > now)
      ? Math.max(0, vib.until_ms - now) : 0;
    const vibPct = Math.min(100, Math.round(((vib.intensity || 0) / 255) * 100));

    return html`
      <div class="actuator-section">
        ${hasLed ? html`
          <div class="actuator-card">
            <div class="actuator-label">LED</div>
            <div class="led-swatch"
                 style="background: ${ledBg}; opacity: ${ledOpacity}; ${ledGlow}"
                 title="rgb(${led.r}, ${led.g}, ${led.b}) @ ${led.brightness}/255"></div>
            <div class="led-meta">
              <span class="mode">${led.mode || 'off'}</span>
              ${ledRemaining > 0 ? html` · ${ledRemaining}ms` : ''}
            </div>
          </div>
        ` : ''}
        ${hasVib ? html`
          <div class="actuator-card">
            <div class="actuator-label">Vibration</div>
            <div class="vib-bar-wrap">
              <div class="vib-bar ${vib.mode === 'pulse' ? 'vib-pulse' : ''}"
                   style="width: ${vibPct}%;"></div>
            </div>
            <div class="led-meta">
              <span class="mode">${vib.mode || 'off'}</span>
              ${vibOn ? html` · ${vibPct}%` : ''}
              ${vibRemaining > 0 ? html` · ${vibRemaining}ms` : ''}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  render() {
    const d = this.sensorData?.data;
    const modColor = this.module?.color ?? '#888';
    const modName = this.module?.name || this.module?.id || `Module`;
    const caps = (this.module?.capabilities || []).filter(Boolean);
    const hasActuator = this._hasActuatorCaps();

    return html`
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title-area" @click=${() => this._collapsed = !this._collapsed}>
            <div class="color-dot" style="background: ${modColor}"></div>
            <span class="panel-title">${modName}</span>
            <span class="cap-chips">
              ${caps.map(c => html`<span class="cap-chip">${c}</span>`)}
            </span>
            <span class="panel-slot" title="hub slot ${this.slot} · debug only">#${this.slot}</span>
            <span class="toggle">${this._collapsed ? '▸' : '▾'}</span>
          </div>
          ${this.closeable
            ? html`<button class="close-btn" @click=${this._close}>✕</button>`
            : ''}
        </div>

        <div class="panel-body ${this._collapsed ? 'hidden' : ''}">
          ${this._renderActuatorSection()}
          ${!d
            ? (hasActuator
                ? ''  // actuator-only module: no "waiting for data" noise
                : html`<div class="empty">Waiting for data…</div>`)
            : html`
              <div class="data-col">
                ${this._fieldGroups.map(group => html`
                  <div class="modality-group">
                    <div class="modality-label">${group.label}</div>
                    <div class="fields-row">
                      ${group.fields.map(f => html`
                        <div class="data-cell">
                          <span class="data-label" style="color: ${this._colorMap[f] ?? '#888'}">${f}</span>
                          <span class="data-value"
                                style="color: ${this._valueColor(d[f], group.rn, group.rx)}">
                            ${this._formatValue(d[f])}
                          </span>
                        </div>
                      `)}
                    </div>
                  </div>
                `)}
              </div>
              <div class="chart-wrap">
                <canvas></canvas>
                <div class="chart-legend">
                  ${this._allFields.map(f => html`
                    <span class="legend-item">
                      <span class="legend-dot" style="background: ${this._colorMap[f] ?? '#888'}"></span>
                      ${f}
                    </span>
                  `)}
                </div>
              </div>
            `}
        </div>
      </div>
    `;
  }
}

customElements.define('wb-sensor-panel', WbSensorPanel);
