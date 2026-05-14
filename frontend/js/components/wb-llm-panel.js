import { LitElement, html, css } from 'lit';
import { channelsForModule } from '../module-channel-map.js';
import { formatCatalog } from '../llm-catalog.js';
import {
  PLAN_STATUS,
  makePlanFromEnvelope,
  computePlanStatus,
  formatPlanStateLine,
} from '../recommendation-plan.js';

// Intent labels recognised by the classifier. Anything else falls back to
// `generate_rules`, which preserves pre-Loop-A behaviour.
const VALID_INTENTS = [
  'recommend_modules',
  'generate_rules',
  'repair_rules',
  'explain',
  'other',
];
const DEFAULT_INTENT = 'generate_rules';
const CLASSIFIER_TIMEOUT_MS = 3000;

function hexToRgb(value, fallback = '#888888') {
  let hex = String(value || fallback).trim();
  if (!/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex)) hex = fallback;
  hex = hex.replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map(ch => ch + ch).join('');
  const n = Number.parseInt(hex, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map(n => n.toString(16).padStart(2, '0'))
    .join('')}`;
}

function mixHex(from, to, amount) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return rgbToHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

function normalizeHex(value) {
  return rgbToHex(hexToRgb(value));
}

export class WbLlmPanel extends LitElement {
  static properties = {
    modules:   { type: Array },   // from wb-app._modules
    workspace: { type: Object },  // current JSON rules from wb-block-canvas
    _theme:    { type: String, state: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      font-family: var(--wb-font, monospace);
      font-size: 13px;
      --llm-user-bg: #e5f0ff;
      --llm-user-border: #93c5fd;
      --llm-user-text: #10233f;
      --llm-assistant-bg: #ffffff;
      --llm-assistant-border: #d6dbe4;
      --llm-assistant-text: #1a1a2e;
      --llm-panel-info-bg: #eff6ff;
      --llm-panel-info-border: #60a5fa;
      --llm-info: #2563eb;
      --llm-info-soft: #1d4ed8;
      --llm-warning-bg: #fff7ed;
      --llm-warning-border: #f59e0b;
      --llm-warning: #b45309;
      --llm-success-bg: #dcfce7;
      --llm-success: #166534;
      --llm-success-border: #22c55e;
      --llm-muted: #6b7280;
      --llm-muted-border: #cbd5e1;
    }

    :host([data-theme="dark"]) {
      --llm-user-bg: #1e3e6e;
      --llm-user-border: #2563eb55;
      --llm-user-text: #e8f4ff;
      --llm-assistant-bg: #0e1f33;
      --llm-assistant-border: #1e3a5f;
      --llm-assistant-text: #e8f4ff;
      --llm-panel-info-bg: #0a1830;
      --llm-panel-info-border: #2563eb;
      --llm-info: #60a5fa;
      --llm-info-soft: #93c5fd;
      --llm-warning-bg: #1c1008;
      --llm-warning-border: #b45309;
      --llm-warning: #fbbf24;
      --llm-success-bg: #166534;
      --llm-success: #86efac;
      --llm-success-border: #16a34a;
      --llm-muted: #9ca3af;
      --llm-muted-border: #374151;
    }

    .chat-header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--wb-border, #1e3a5f);
      font-weight: 600;
      font-size: 0.78rem;
      color: var(--wb-text-dim, #7a9bc0);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      flex-shrink: 0;
    }

    .chat-body {
      flex: 1;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 0;
    }

    .bubble {
      max-width: 94%;
      padding: 7px 10px;
      border-radius: 0;
      line-height: 1.55;
      font-size: 12.5px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble.user {
      align-self: flex-end;
      background: var(--llm-user-bg);
      border: 1px solid var(--llm-user-border);
      color: var(--llm-user-text);
    }
    .bubble.assistant {
      align-self: flex-start;
      background: var(--llm-assistant-bg);
      border: 1px solid var(--llm-assistant-border);
      color: var(--llm-assistant-text);
    }
    .bubble.assistant.streaming::after {
      content: '▋';
      animation: blink 0.8s step-end infinite;
      color: var(--wb-accent, #2563eb);
    }
    @keyframes blink { 50% { opacity: 0; } }

    .module-chip {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 7px 1px 5px;
      border-radius: 0;
      border: 1px solid var(--chip-border, var(--chip-color, #888));
      background: var(--chip-bg, transparent);
      color: var(--chip-text, var(--chip-color, #555));
      cursor: pointer;
      font-size: 11.5px;
      font-weight: 600;
      vertical-align: middle;
      transition: opacity 0.15s;
      user-select: none;
    }
    .module-chip:hover { opacity: 0.8; }
    .chip-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--chip-text, var(--chip-color, #888));
      flex-shrink: 0;
    }

    .proposed-banner {
      border: 1px solid var(--llm-warning-border);
      border-radius: 0;
      padding: 8px 10px;
      background: var(--llm-warning-bg);
      flex-shrink: 0;
      margin: 4px 0 2px;
    }
    .proposed-label {
      font-size: 11px;
      color: var(--llm-warning);
      font-weight: 600;
      margin-bottom: 6px;
    }
    .proposed-actions {
      display: flex;
      gap: 8px;
    }
    .btn-accept {
      background: var(--llm-success-bg);
      color: var(--llm-success);
      border: 1px solid var(--llm-success-border);
      padding: 4px 12px;
      border-radius: 0;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
    }
    .btn-accept:hover {
      opacity: 0.9;
    }
    .btn-reject {
      background: transparent;
      color: var(--llm-muted);
      border: 1px solid var(--llm-muted-border);
      padding: 4px 12px;
      border-radius: 0;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
    }
    .btn-reject:hover { color: var(--wb-text, #1a1a2e); }

    .plan-panel {
      border: 1px solid var(--llm-panel-info-border);
      border-radius: 0;
      padding: 8px 10px;
      background: var(--llm-panel-info-bg);
      flex-shrink: 0;
      margin: 4px 0 2px;
    }
    .plan-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .plan-title {
      font-size: 11px;
      color: var(--llm-info);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .plan-dismiss {
      padding: 2px 8px;
      font-size: 11px;
    }
    .plan-overall {
      font-size: 11.5px;
      color: var(--llm-info-soft);
      margin-bottom: 6px;
      font-style: italic;
    }
    .plan-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .plan-entry {
      display: grid;
      grid-template-columns: 16px auto 1fr;
      align-items: baseline;
      gap: 6px;
      font-size: 12px;
      padding: 2px 0;
    }
    .plan-entry .plan-rationale {
      grid-column: 2 / -1;
      font-size: 11px;
      color: var(--wb-text-dim, #5b6478);
      opacity: 0.85;
      margin-top: 1px;
    }
    .plan-mark {
      font-weight: 700;
      text-align: center;
    }
    .plan-type {
      font-weight: 600;
      color: var(--wb-text, #1a1a2e);
    }
    .plan-status {
      color: var(--wb-text-dim, #5b6478);
      font-size: 11.5px;
    }
    .plan-entry.satisfied .plan-mark    { color: #22c55e; }
    .plan-entry.satisfied .plan-status  { color: var(--llm-success); }
    .plan-entry.substituted .plan-mark   { color: var(--llm-warning); }
    .plan-entry.substituted .plan-status { color: var(--llm-warning); }
    .plan-entry.missing .plan-mark      { color: var(--llm-muted); }
    .plan-entry.missing .plan-status    { color: var(--llm-muted); }

    .update-hint {
      color: var(--llm-warning);
      font-style: italic;
      font-size: 11.5px;
    }

    .chat-input-area {
      padding: 8px;
      border-top: 1px solid var(--wb-border, #1e3a5f);
      display: flex;
      gap: 6px;
      flex-shrink: 0;
    }
    .chat-input {
      flex: 1;
      background: var(--wb-surface-2, #0a1628);
      border: 1px solid var(--wb-border, #1e3a5f);
      border-radius: 0;
      color: var(--wb-text, #d0e4f7);
      padding: 6px 10px;
      font-size: 12.5px;
      font-family: inherit;
      outline: none;
      resize: none;
      min-height: 32px;
      max-height: 80px;
      line-height: 1.4;
    }
    .chat-input:focus { border-color: var(--wb-accent, #2563eb); }
    .chat-input::placeholder { color: var(--wb-text-dim, #7a9bc0); opacity: 0.7; }
    .btn-send {
      background: var(--wb-accent, #2563eb);
      color: var(--wb-on-accent, #ffffff);
      border: none;
      border-radius: 0;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      font-family: inherit;
      align-self: flex-end;
      flex-shrink: 0;
    }
    .btn-send:disabled { opacity: 0.4; cursor: default; }
    .btn-send:not(:disabled):hover {
      opacity: 0.9;
    }

    .empty-hint {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--wb-text-dim, #7a9bc0);
      font-size: 11px;
      opacity: 0.5;
      text-align: center;
      padding: 16px;
    }
  `;

  constructor() {
    super();
    this.modules = [];
    this.workspace = null;
    this._messages = [];      // [{role: 'user'|'assistant', content: string}]
    this._inputValue = '';
    this._loading = false;
    this._proposedRules = null;
    // Loop A: persistent recommendation plan (replaces old "fire-and-forget"
    // banner). Set when the LLM emits <module_recommendation>; cleared on
    // dismiss or replaced when a new envelope arrives.
    this._activePlan = null;
    // Per-entry status cache, recomputed on every modules update.
    this._planStatus = [];
    // Snapshot of the module set at the moment of the previous user turn,
    // used to compute "schema diff since the last turn" for Loop A feedback.
    this._lastPromptSchema = null;
    this._lastIntent = null;
    this._theme = (window.themeController && window.themeController.current()) || 'light';
    this._onThemeChange = (e) => {
      this._setTheme(e.detail?.theme || 'light');
    };
  }

  connectedCallback() {
    super.connectedCallback();
    this._setTheme((window.themeController && window.themeController.current()) || this._theme);
    window.addEventListener('wb-theme-change', this._onThemeChange);
  }

  disconnectedCallback() {
    window.removeEventListener('wb-theme-change', this._onThemeChange);
    super.disconnectedCallback();
  }

  _setTheme(theme) {
    this._theme = theme === 'dark' ? 'dark' : 'light';
    this.setAttribute('data-theme', this._theme);
  }

  // Recompute plan status whenever the live modules list changes. Cheap —
  // O(plan.modules * live.modules) with both sides ≤ 8 in practice.
  updated(changed) {
    if (changed.has('modules') && this._activePlan) {
      this._planStatus = computePlanStatus(this._activePlan, this.modules);
      this.requestUpdate();
    }
  }

  // --- Loop A: schema snapshot + diff -----------------------------------
  // We only snapshot uid/type/active so re-renders that change unrelated
  // descriptor fields (RSSI, last-seen ts) don't show up as "changes".
  _snapshotSchema() {
    return (this.modules || [])
      .filter(m => m.active !== false)
      .map(m => ({
        uid: m.uid,
        id: m.id,
        type: m.descriptor?.type || (m.capabilities || [])[0] || 'unknown',
      }));
  }

  _diffSchema(prev, curr) {
    if (!prev) return null;
    const prevByUid = new Map(prev.map(m => [m.uid, m]));
    const currByUid = new Map(curr.map(m => [m.uid, m]));
    const added = curr.filter(m => !prevByUid.has(m.uid));
    const removed = prev.filter(m => !currByUid.has(m.uid));
    if (!added.length && !removed.length) return null;
    const parts = [];
    if (added.length) {
      parts.push(`attached ${added.map(m => `${m.type}@${m.uid}`).join(', ')}`);
    }
    if (removed.length) {
      parts.push(`removed ${removed.map(m => `${m.type}@${m.uid}`).join(', ')}`);
    }
    return parts.join('; ');
  }

  // --- Loop A: intent classifier ---------------------------------------
  // Cheap non-streaming call. We deliberately omit the full system prompt
  // here — the classifier only needs the user's message to pick a route.
  // Falls back to DEFAULT_INTENT on timeout, network error, or parse fail
  // so the user never gets stuck behind a broken classifier.
  async _classifyIntent(userText) {
    const sys =
      'You are an intent classifier for a wearable-sensor authoring tool. ' +
      'Read the user message and respond with EXACTLY one XML tag and nothing else: ' +
      '<intent>recommend_modules</intent>, <intent>generate_rules</intent>, ' +
      '<intent>repair_rules</intent>, <intent>explain</intent>, or <intent>other</intent>. ' +
      'Pick recommend_modules when the user asks what hardware they need; ' +
      'generate_rules when they describe a new behaviour to build; ' +
      'repair_rules when they want existing rules fixed; ' +
      'explain when they ask how something works; other otherwise.';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CLASSIFIER_TIMEOUT_MS);
    try {
      const resp = await fetch('http://localhost:3000/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: 'deepseek-v4-pro',
          stream: false,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: userText },
          ],
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const txt = data.choices?.[0]?.message?.content ?? '';
      const m = txt.match(/<intent>\s*([a-z_]+)\s*<\/intent>/i);
      const picked = m ? m[1].toLowerCase() : null;
      if (picked && VALID_INTENTS.includes(picked)) return picked;
      return DEFAULT_INTENT;
    } catch {
      return DEFAULT_INTENT;
    } finally {
      clearTimeout(timer);
    }
  }

  _buildSystemPrompt(intent = DEFAULT_INTENT) {
    const modList = (this.modules || [])
      .filter(m => m.active !== false)
      .map(m => {
        let capDetail = '';
        if (m.descriptor?.caps) {
          capDetail = m.descriptor.caps.map(c => {
            const mod = c.m || c.modality || '';
            const range = (c.rn != null && c.rx != null) ? ` range=[${c.rn}, ${c.rx}]` : '';
            return `${mod}${range}`;
          }).join(', ');
        }

        const channels = channelsForModule(m);
        const chDetail = channels.length > 0
          ? `, channels=[${channels.map(([lbl, id]) => `${lbl}:${id}`).join(', ')}]`
          : '';

        return `- @${m.id}: uid=${m.uid}, color=${m.color}, name="${m.name || m.id}", ` +
               `capabilities=[${capDetail || (m.capabilities || []).join(', ')}]${chDetail}`;
      })
      .join('\n');

    const wsJson = this.workspace
      ? JSON.stringify(this.workspace, null, 2)
      : '(empty — no rules defined yet)';

    // Minimal-context branches for intents that don't need the full ECA schema.
    if (intent === 'explain' || intent === 'other') {
      return `You are an assistant for HexBlocks, a modular wearable sensor authoring tool.
Answer the user's question in plain text. Do NOT emit any XML envelopes —
no <workspace_update> and no <module_recommendation>. Be concise.

## Available module types (what the kit ships with)
${formatCatalog()}

## Currently connected modules (what is attached now)
${modList || '(none connected)'}

When mentioning an attached module, use the exact @id token from the connected
module list above. Do not invent short aliases; only exact @id tokens become
interactive chips in the UI.

Respond in the same language the user writes in.`;
    }

    if (intent === 'recommend_modules') {
      return `You are an assistant for HexBlocks, a modular wearable sensor authoring tool.
The user is deciding what hardware to attach. Recommend modules from the catalog
below, explain why, and call out any modules that aren't currently attached.

## Available module types (what could be attached)
${formatCatalog()}

## Currently connected modules (what is attached now)
${modList || '(none connected)'}

## How to surface your recommendation
Wrap your proposal in <module_recommendation> tags on a single line, JSON-encoded:

<module_recommendation>{"modules":["imu","audio"],"rationale":"short reason"}</module_recommendation>

Use the short type names from the catalog (imu, led, vibration, audio, light, knob).
Outside the tag, you can chat normally — the user reads both the prose and the envelope.
In that prose, use exact @id tokens for modules that are already attached. For modules
that are missing, use plain catalog names without @ because they are not clickable yet.

Respond in the same language the user writes in.`;
    }

    // Default: generate_rules / repair_rules — full ECA authoring prompt.
    return `You are an assistant for HexBlocks, a modular wearable sensor programming platform.
The user programs wearable devices using visual ECA (Event-Condition-Action) rules in a Blockly editor.

## Available module types (what could be attached)
${formatCatalog()}

## Currently connected modules (what is attached right now)
${modList || '(none connected)'}

The first list is the kit's catalog. The second list is the live bus — only modules
in the second list have valid uids and channels you can reference in rules.

When referring to an attached module in visible prose, use the exact @id token from
the currently connected module list above (for example @imuv2 or @lightv3 if those
exact ids are listed). Do not invent short type aliases unless that exact id
appears in the connected module list. The UI renders exact @id tokens as interactive
colored chips that highlight the physical module.

**IMPORTANT:** When generating rules JSON, use the exact \`uid\` value from the module list above
(e.g. \`"id": "ac200001"\` for the IMU module). Do NOT use generic names like "imu" or "led"
in the \`ref.id\` or \`target\` fields — those will fail to match the hardware.

**IMPORTANT:** Always respect the range=[min, max] values shown for each capability. Threshold values
in conditions MUST fall within the specified range for that sensor.

**IMPORTANT:** Use the exact channel IDs shown in channels=[...] for each module. For example, if
@lightv3 shows channels=[light:41], use "ch": 41 in conditions referencing that sensor.

## Current workspace rules (JSON)
\`\`\`json
${wsJson}
\`\`\`

## How to suggest rule changes
If you want to propose a modification to the workspace, wrap the complete updated rules JSON
in <workspace_update> XML tags **on a single line, with no markdown code blocks around it**.
The user can then Accept or Reject your proposal.

Every time you emit a <workspace_update>, first provide a short teaching-oriented
visible explanation, then put the XML tag as the final line. Use this pattern:

1. Intent: one concise sentence explaining what behavior you are creating or changing.
2. Modules: one concise sentence naming the exact attached modules with @id chips and
   describing the sensor-to-actuator path.
3. Rule detail: one concise sentence for thresholds, timing, hold_ms, cooldown_ms, or
   why a workspace variable/virtual channel is needed.
4. Final line: the single-line <workspace_update> JSON envelope.

Do not put the only explanation inside the JSON or inside the XML tag; the UI hides
the envelope and only the visible prose can teach the user or show clickable module
chips. Example format:

<workspace_update>{"version":3,"variables":[],"virtual_channels":[],"rules":[...]}</workspace_update>

## Full ECA Schema (version 3)

\`\`\`
{
  "version": 3,
  "variables": [0.0, 0.0, ...],          // up to 8 floats; index = var_id (0..7)
  "virtual_channels": [
    {
      "vc_id": 0,                         // 0..15, used as ch when ref.type=2
      "op": "ADD|SUB|MUL|DIV|ABS|NEG|MIN|MAX|MAP|CLAMP|DIFF",
      "a": { "type": 0|1|2|3, "id": "uid_hex_or_vc_or_var_id", "ch": int },
      "b": { "type": 0|1|2|3, "id": "...", "ch": int, "value": float },
      "c_const": float                    // used by MAP/CLAMP as 3rd operand
    }
  ],
  "rules": [
    {
      "conditions": [
        {
          "ref": { "type": 0|1|2|3, "id": "uid_hex_or_id", "ch": int },
          "op": "GT|LT|GTE|LTE|EQ|NEQ",
          "threshold": float,
          "hold_ms": int,                 // condition must be true this long before firing
          "cooldown_ms": int              // minimum interval between re-fires
        }
      ],
      "logic": "AND|OR",
      "actions": [
        {
          "target": "uid_hex",            // module UID for actuators; var_id for VAR_*
          "cmd": "ACTION_NAME",
          "params": [
            { "type": 0|1|2|3, "id": "...", "ch": 0, "value": float }
          ]
        }
      ]
    }
  ]
}
\`\`\`

## Reference types (used in conditions, VC operands, action params)

- **type 0 (SLOT)**: physical sensor channel. \`id\` = module UID hex, \`ch\` = channel ID.
- **type 1 (CONST)**: constant value. \`value\` = the number; \`id\`/\`ch\` ignored.
- **type 2 (VC)**: virtual channel. \`id\` = vc_id (0..15), \`ch\` = 0.
- **type 3 (VAR)**: variable. \`id\` = var_id (0..7), \`ch\` = 0.

## Virtual Channel ops

- \`ADD/SUB/MUL/DIV\`: a OP b
- \`ABS/NEG\`: unary on a
- \`MIN/MAX\`: between a and b
- \`MAP\`: linear map a from [b.value, c_const] to [0,1]
- \`CLAMP\`: clamp a to [b.value, c_const]
- \`DIFF\`: a - previous(a)  (rate-of-change)

VCs let you derive new signals (e.g. acc_mag - 1.0, or knob mapped to 0..255).
Reference a VC in conditions/actions via \`{type: 2, id: vc_id, ch: 0}\`.

## Variables

\`variables\` is an array of initial float values. var_id 0 = variables[0], etc.
Use VAR_* actions to mutate them; reference via \`{type: 3, id: var_id, ch: 0}\`.

- **VAR_SET** (target=var_id): params=[{value: new_val}]
- **VAR_INC** (target=var_id): params=[{value: delta}]
- **VAR_RESET** (target=var_id): no params (resets to initial)
- **VAR_TOGGLE** (target=var_id): no params (0↔1)

## All Action Commands

LED (target = LED module uid):
- **LED_OFF**: 0 params
- **LED_SOLID**: 3 params [R, G, B]  (each 0-255)
- **LED_STOP**: 0 params

Vibration (target = vibration module uid):
- **VIBRATE**: 2 params [intensity 0-100, duration_ms]
- **VIBRATE_PULSE**: 4 params [intensity, on_ms, off_ms, count]
- **VIBRATE_RAMP**: 3 params [from%, to%, duration_ms]
- **VIBRATE_STOP**: 0 params

Audio (target = audio module uid):
- **AUDIO_SET_TONE**: 2 params [freq_hz 0-5000, amplitude 0-255]
- **AUDIO_STOP**: 0 params

Variable mutations (target = var_id, NOT a module uid):
- **VAR_SET / VAR_INC / VAR_RESET / VAR_TOGGLE** (see Variables section)

## Condition operators

GT, LT, GTE, LTE, EQ, NEQ — comparison against \`threshold\`.

## Param refs (advanced — dynamic actions)

Action params support type 0/2/3 too, not just type 1 (CONST). This lets you:
- LED color driven by sensor: \`{type: 0, id: "imu_uid", ch: 6, value: 0}\` (acc_mag → R)
- Audio frequency driven by knob: \`{type: 0, id: "knob_uid", ch: 40, value: 0}\`
- Audio amp = variable: \`{type: 3, id: 0, ch: 0, value: 0}\`

Use this for theremin-like demos and dynamic feedback.

## Timing semantics

- \`hold_ms\`: condition must remain true for at least this many ms before firing (debounce).
- \`cooldown_ms\`: minimum interval before the next eligible firing. Constant actions fire once per false→true episode; actions with live sensor/VC/VAR params may refresh while the condition stays true.
- Defaults: hold_ms=0 (instant), cooldown_ms=2000 (2s) is a sensible starting point.

## Channel IDs (for reference)

Motion: AX=0, AY=1, AZ=2, GX=3, GY=4, GZ=5, ACC_MAG=6, GYRO_MAG=7, PITCH=8, ROLL=9
Motion derived: AX_LPF=10, AY_LPF=11, AZ_LPF=12, ACC_MAG_LPF=13, JERK=14
Motion events: SHAKE=16, STEP=17, FREEFALL=18
Environment: CELSIUS=32, HUMIDITY=33, HEAT_INDEX=34
Input: KNOB=40, LIGHT=41

Only use channels that the connected modules actually expose (see channels=[...] in the module list above).

Respond in the same language the user writes in.`;
  }

  async _onSend() {
    const text = this._inputValue.trim();
    if (!text || this._loading) return;

    this._inputValue = '';
    this._loading = true;

    // Loop A: if the user just acted on a previous module recommendation by
    // attaching/removing modules, surface that diff and the current plan
    // state to the LLM so its next turn responds to the physical change
    // rather than starting fresh.
    let userTextForLlm = text;
    if (this._lastIntent === 'recommend_modules') {
      const prefixLines = [];
      if (this._activePlan) {
        const planLine = formatPlanStateLine(this._activePlan, this.modules);
        if (planLine) prefixLines.push(`Recommendation plan state: ${planLine}`);
      }
      const diff = this._diffSchema(this._lastPromptSchema, this._snapshotSchema());
      if (diff) prefixLines.push(`Schema diff since last turn: ${diff}`);
      if (prefixLines.length) {
        userTextForLlm = `${prefixLines.join('\n')}\n\n${text}`;
      }
    }

    // Classify the user's intent before composing the system prompt.
    // Defaults to generate_rules (legacy behaviour) on any failure.
    const intent = await this._classifyIntent(text);
    this._lastIntent = intent;
    this._lastPromptSchema = this._snapshotSchema();

    const historySnapshot = this._messages.map(m => ({ role: m.role, content: m.content }));
    this._messages = [...this._messages,
      { role: 'user', content: text },
      { role: 'assistant', content: '', streaming: true },
    ];
    this.requestUpdate();
    await this.updateComplete;
    this._scrollToBottom();

    let full = '';
    try {
      const resp = await fetch('http://localhost:3000/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v4-pro',
          stream: true,
          messages: [
            { role: 'system', content: this._buildSystemPrompt(intent) },
            ...historySnapshot,
            { role: 'user', content: userTextForLlm },
          ],
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errText}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta?.content ?? '';
            if (delta) {
              full += delta;
              const last = this._messages[this._messages.length - 1];
              this._messages = [
                ...this._messages.slice(0, -1),
                { ...last, content: full },
              ];
              this.requestUpdate();
              this._scrollToBottom();
            }
          } catch { /* ignore malformed SSE lines */ }
        }
      }
    } catch (err) {
      full = `[Error: ${err.message}]`;
      this._messages = [
        ...this._messages.slice(0, -1),
        { role: 'assistant', content: full },
      ];
    }

    // Finalize — remove streaming flag and parse workspace_update
    const lastMsg = { role: 'assistant', content: full };
    this._messages = [...this._messages.slice(0, -1), lastMsg];

    // Match workspace_update, tolerating markdown code blocks around it
    const match = full.match(/<workspace_update>([\s\S]*?)<\/workspace_update>/);
    if (match) {
      const jsonText = match[1].trim()
        .replace(/^```(?:json)?\s*/, '')  // strip leading ```json or ```
        .replace(/\s*```$/, '');          // strip trailing ```
      try {
        this._proposedRules = JSON.parse(jsonText);
      } catch { /* malformed JSON from LLM, ignore */ }
    }

    // Match module_recommendation envelope (Loop A). A fresh envelope
    // REPLACES any active plan so the user can iterate by re-asking.
    const recMatch = full.match(/<module_recommendation>([\s\S]*?)<\/module_recommendation>/);
    if (recMatch) {
      const jsonText = recMatch[1].trim()
        .replace(/^```(?:json)?\s*/, '')
        .replace(/\s*```$/, '');
      try {
        const parsed = JSON.parse(jsonText);
        const plan = makePlanFromEnvelope(parsed);
        if (plan) {
          this._activePlan = plan;
          this._planStatus = computePlanStatus(plan, this.modules);
        }
      } catch { /* malformed recommendation JSON, ignore */ }
    }

    this._loading = false;
    this.requestUpdate();
    await this.updateComplete;
    this._scrollToBottom();
  }

  _onAccept() {
    this.dispatchEvent(new CustomEvent('apply-rules', {
      bubbles: true,
      composed: true,
      detail: { rules: this._proposedRules },
    }));
    this._proposedRules = null;
    this.requestUpdate();
  }

  _onReject() {
    this._proposedRules = null;
    this.requestUpdate();
  }

  _onChipClick(uid) {
    this.dispatchEvent(new CustomEvent('highlight-module', {
      bubbles: true,
      composed: true,
      detail: { uid },
    }));
  }

  _themeColor(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  _chipStyle(color) {
    const base = normalizeHex(color);
    const surface = this._themeColor('--wb-surface', this._theme === 'dark' ? '#16213e' : '#f7f8fa');
    const border = this._themeColor('--wb-border', this._theme === 'dark' ? '#2d3a5a' : '#d6dbe4');
    const text = this._themeColor('--wb-text', this._theme === 'dark' ? '#e8e8e8' : '#1a1a2e');
    const bgMix = this._theme === 'dark' ? 0.24 : 0.14;
    const borderMix = this._theme === 'dark' ? 0.70 : 0.55;
    const textMix = this._theme === 'dark' ? 0.62 : 0.46;
    return [
      `--chip-color:${base}`,
      `--chip-bg:${mixHex(surface, base, bgMix)}`,
      `--chip-border:${mixHex(border, base, borderMix)}`,
      `--chip-text:${mixHex(text, base, textMix)}`,
    ].join(';');
  }

  _scrollToBottom() {
    const body = this.renderRoot?.querySelector('.chat-body');
    if (body) body.scrollTop = body.scrollHeight;
  }

  _onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this._onSend();
    }
  }

  _renderMessageContent(content) {
    // Hide envelope blocks from chat, show a hint instead.
    const cleaned = content
      .replace(
        /<workspace_update>[\s\S]*?<\/workspace_update>/g,
        '\n[Rule update proposed ↓]\n',
      )
      .replace(
        /<module_recommendation>[\s\S]*?<\/module_recommendation>/g,
        '\n[Module recommendation ↓]\n',
      );
    // Split on @word tokens so we can render module chips
    const parts = cleaned.split(/(@[A-Za-z][A-Za-z0-9_]*)/g);
    return html`${parts.map(part => {
      if (/^@[A-Za-z]/.test(part)) {
        const name = part.slice(1).toLowerCase();
        const mod = (this.modules || []).find(m =>
          m.id?.toLowerCase() === name ||
          m.name?.toLowerCase().startsWith(name)
        );
        if (mod) {
          return html`<span class="module-chip"
            style="${this._chipStyle(mod.color)}"
            @click=${() => this._onChipClick(mod.uid)}
            title="${mod.name || mod.id} — click to highlight"
          ><span class="chip-dot"></span>${part}</span>`;
        }
      }
      return part;
    })}`;
  }

  _renderProposedBanner() {
    if (!this._proposedRules) return '';
    return html`
      <div class="proposed-banner">
        <div class="proposed-label">Rule update proposed by LLM</div>
        <div class="proposed-actions">
          <button class="btn-accept" @click=${this._onAccept}>Accept</button>
          <button class="btn-reject" @click=${this._onReject}>Reject</button>
        </div>
      </div>
    `;
  }

  _onDismissPlan() {
    // Clear the persistent plan and stop sending plan-state lines on
    // subsequent turns until a fresh recommendation arrives.
    this._activePlan = null;
    this._planStatus = [];
    this.requestUpdate();
  }

  _renderPlanEntry(entry, status) {
    let mark = '○';
    let label = 'Missing';
    let cls = 'missing';
    let suffix = '';
    if (status?.status === PLAN_STATUS.SATISFIED) {
      mark = '✓';
      label = 'Satisfied';
      cls = 'satisfied';
      if (status.substituteId) suffix = ` by @${status.substituteId}`;
    } else if (status?.status === PLAN_STATUS.SUBSTITUTED) {
      mark = '⇄';
      label = 'Substituted';
      cls = 'substituted';
      if (status.substituteId) suffix = ` by @${status.substituteId}`;
    }
    return html`
      <li class="plan-entry ${cls}">
        <span class="plan-mark">${mark}</span>
        <span class="plan-type">${entry.type}</span>
        <span class="plan-status">${label}${suffix}</span>
        ${entry.rationale ? html`<div class="plan-rationale">${entry.rationale}</div>` : ''}
      </li>
    `;
  }

  _renderRecommendationPlan() {
    if (!this._activePlan) return '';
    const statuses = this._planStatus.length === this._activePlan.modules.length
      ? this._planStatus
      : computePlanStatus(this._activePlan, this.modules);
    return html`
      <div class="plan-panel">
        <div class="plan-header">
          <span class="plan-title">Recommendation plan</span>
          <button class="btn-reject plan-dismiss" @click=${this._onDismissPlan}>Dismiss</button>
        </div>
        ${this._activePlan.rationale
          ? html`<div class="plan-overall">${this._activePlan.rationale}</div>`
          : ''}
        <ul class="plan-list">
          ${this._activePlan.modules.map((entry, i) => this._renderPlanEntry(entry, statuses[i]))}
        </ul>
      </div>
    `;
  }

  render() {
    return html`
      <div class="chat-header">LLM Assistant</div>

      <div class="chat-body">
        ${this._messages.length === 0
          ? html`<div class="empty-hint">Describe a rule or ask about your modules.<br>The LLM sees the current workspace.</div>`
          : this._messages.map(msg => html`
              <div class="bubble ${msg.role} ${msg.streaming ? 'streaming' : ''}">
                ${this._renderMessageContent(msg.content)}
              </div>
            `)
        }
      </div>

      ${this._renderProposedBanner()}
      ${this._renderRecommendationPlan()}

      <div class="chat-input-area">
        <textarea class="chat-input"
          rows="1"
          placeholder="Ask the LLM… (Enter to send, Shift+Enter for newline)"
          .value=${this._inputValue}
          @input=${e => { this._inputValue = e.target.value; this.requestUpdate(); }}
          @keydown=${this._onKeyDown}
          ?disabled=${this._loading}
        ></textarea>
        <button class="btn-send"
          ?disabled=${this._loading || !this._inputValue.trim()}
          @click=${this._onSend}
        >${this._loading ? '…' : 'Send'}</button>
      </div>
    `;
  }
}

customElements.define('wb-llm-panel', WbLlmPanel);
