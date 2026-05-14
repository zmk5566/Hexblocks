/**
 * Maps module capability → available ECA channels, plus small helpers
 * used by the Blockly dynamic dropdowns.
 *
 * Channel ids and capability→channel maps come from the bridge-served
 * channel catalog (`GET /api/channel_catalog`, source file
 * `frontend/channel_catalog.json`). Call `loadChannelCatalog()` once at
 * app boot before any code that reads `CHANNELS_BY_CAP`, `SENSOR_CAPS`,
 * `LED_CAPS`, etc. — until then those exports are empty.
 */

// `let` (not `const`) so the values can be replaced by loadChannelCatalog.
// ES module live bindings let importers see the post-load values without
// re-importing.
export let CHANNELS_BY_CAP = {};
export let SENSOR_CAPS = [];
export let LED_CAPS = [];
export let VIB_CAPS = [];
export let AUDIO_CAPS = [];
let CHANNEL_FIELD_NAME = {};

let _catalogLoaded = null;  // Promise<void>, memoized

const CAPABILITY_ALIASES = {
  imu: ['imu', 'motion', 'motion_sensing', 'acceleration', 'angular_velocity'],
  motion: ['motion', 'motion_sensing', 'imu'],
  light: ['light', 'light_sensing', 'ldr'],
  ldr: ['ldr', 'light', 'light_sensing'],
  knob: ['knob', 'input_control', 'rotary'],
  rotary: ['rotary', 'knob', 'input_control'],
  input: ['input', 'input_control', 'knob'],
  led: ['led', 'visual_output', 'rgb'],
  rgb: ['rgb', 'led', 'visual_output'],
  vib: ['vib', 'vibration', 'haptic_output', 'haptic'],
  vibration: ['vibration', 'vib', 'haptic_output', 'haptic'],
  haptic: ['haptic', 'haptic_output', 'vib', 'vibration'],
  audio: ['audio', 'audio_output', 'speaker', 'tone'],
  speaker: ['speaker', 'audio', 'audio_output'],
};

export function setDropdownGhosts(ghosts) {
  globalThis.__wbDropdownGhosts = ghosts || null;
}

export function normalizeUid(value) {
  if (value == null) return '';
  const s = String(value).trim().replace(/^0x/i, '').toUpperCase();
  return /^[0-9A-F]{8}$/.test(s) ? s : '';
}

export function moduleMatchesKey(mod, key) {
  if (!mod || key == null) return false;
  const wantedUid = normalizeUid(key);
  if (wantedUid && normalizeUid(mod.uid) === wantedUid) return true;
  return mod.slot != null && String(mod.slot) === String(key);
}

/**
 * Fetch the channel catalog from the bridge and populate the module-level
 * exports. Idempotent: subsequent calls return the same promise.
 */
export function loadChannelCatalog(url = '/api/channel_catalog') {
  if (_catalogLoaded) return _catalogLoaded;
  _catalogLoaded = (async () => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`channel_catalog: HTTP ${resp.status}`);
    const cat = await resp.json();
    _applyCatalog(cat);
  })();
  return _catalogLoaded;
}

function _applyCatalog(cat) {
  const channels = cat.channels || {};
  const sensorCaps = cat.sensor_capabilities || {};
  const actCaps = cat.actuator_capabilities || {};

  const next = {};
  for (const [cap, names] of Object.entries(sensorCaps)) {
    next[cap] = (names || [])
      .filter(n => channels[n])
      .map(n => [channels[n].label || n.toLowerCase(), channels[n].id]);
  }
  CHANNELS_BY_CAP = next;
  SENSOR_CAPS = Object.keys(sensorCaps);
  LED_CAPS = actCaps.led || [];
  VIB_CAPS = actCaps.vibration || [];
  AUDIO_CAPS = actCaps.audio || [];

  const fieldNames = {};
  for (const entry of Object.values(channels)) {
    if (entry && typeof entry.id === 'number') {
      fieldNames[entry.id] = entry.label;
    }
  }
  CHANNEL_FIELD_NAME = fieldNames;
}

export function slotLabel(mod) {
  const name = mod?.name || mod?.id || 'module';
  const uid = mod?.uid ? normalizeUid(mod.uid).slice(-4) || String(mod.uid).slice(-4) : '?';
  // Always include the UID suffix so two same-type modules remain distinct.
  // Slot is useful in sim/debug, but UID is the persistent rule identity.
  if (mod?.slot != null) return `${name} @ slot ${mod.slot} · ${uid}`;
  return `${name} · ${uid}`;
}

function _moduleCapabilityTokens(mod) {
  const tokens = new Set();
  const add = (value) => {
    const token = String(value ?? '').trim().toLowerCase();
    if (!token) return;
    tokens.add(token);
    for (const part of token.split(/[^a-z0-9]+/)) {
      if (part) tokens.add(part);
    }
  };
  for (const cap of mod?.capabilities || []) add(cap);
  add(mod?.id);
  add(mod?.name);
  add(mod?.descriptor?.id);
  add(mod?.descriptor?.moduleId);
  add(mod?.descriptor?.name);
  add(mod?.descriptor?.type);
  add(mod?.descriptor?.cat);
  add(mod?.descriptor?.category);
  for (const cap of mod?.descriptor?.caps || []) {
    add(cap?.m);
    add(cap?.modality);
    add(cap?.type);
  }
  for (const token of [...tokens]) {
    for (const alias of CAPABILITY_ALIASES[token] || []) tokens.add(alias);
  }
  return tokens;
}

export function channelsForModule(mod) {
  const caps = [..._moduleCapabilityTokens(mod)];
  console.log('[channelsForModule]', mod?.name, 'uid:', mod?.uid, 'caps:', caps);
  const seen = new Set();
  const out = [];
  for (const cap of caps) {
    const list = CHANNELS_BY_CAP[cap];
    if (!list) continue;
    for (const [lbl, id] of list) {
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([lbl, key]);
    }
  }
  console.log('[channelsForModule] result:', out, 'stringified:', JSON.stringify(out));
  return out;
}

/**
 * Reverse-lookup the field name (e.g. "ax") for a channel id, used when
 * the bridge emits per-channel $S frames and wb-app needs to fold them back
 * into the batched `data` object the sensor panel expects.
 *
 * Names come from the channel catalog (`channels[X].label`). Returns null
 * before `loadChannelCatalog()` has resolved, or for unknown ids.
 *
 * `mod` is currently unused but kept in the signature so capability-aware
 * disambiguation (same channel id meaning different things across modalities)
 * can be added later without touching call sites.
 */
export function fieldNameForChannel(mod, channelId) {
  return CHANNEL_FIELD_NAME[channelId] ?? null;
}

export function moduleHasRole(mod, role) {
  const caps = _moduleCapabilityTokens(mod);
  const hasAny = (wanted) => wanted.some(c => caps.has(c));
  if (role === 'sensor') return hasAny(SENSOR_CAPS);
  if (role === 'led')    return hasAny(LED_CAPS);
  if (role === 'vib')    return hasAny(VIB_CAPS);
  if (role === 'audio')  return hasAny(AUDIO_CAPS);
  return false;
}

/**
 * Dropdown option list of attached modules filtered by role.
 * Always returns ≥1 entry (Blockly requires it).
 *
 * v3: option value is the module UID (8-hex-char string), not slot. UIDs
 * are stable across replug; slots are runtime hub-internal allocations
 * that the frontend isn't told about.
 */
export function slotOptions(role) {
  const all = globalThis.__wbModulesRef?.current || [];
  const mods = all.filter(m =>
    m && m.active !== false && m.uid && moduleHasRole(m, role),
  );
  const liveOptions = mods.map(m => [slotLabel(m), String(m.uid)]);
  const options = [...liveOptions];
  const seenExact = new Set(options.map(([, value]) => String(value)));
  const seenUid = new Set(options.map(([, value]) => normalizeUid(value)).filter(Boolean));
  const ghostValues = globalThis.__wbDropdownGhosts?.slots?.[role] || [];
  for (const value of ghostValues) {
    const key = String(value);
    if (!key || seenExact.has(key)) continue;
    const uid = normalizeUid(key);
    const live = uid
      ? liveOptions.find(([, liveValue]) => normalizeUid(liveValue) === uid)
      : null;
    const label = live?.[0] || `${key} (saved)`;
    // If the saved UID differs only by case from a live option, keep an alias
    // with the exact serialized value so Blockly field validation accepts it.
    if (uid && seenUid.has(uid) && !live) continue;
    options.push([label, key]);
    seenExact.add(key);
    if (uid) seenUid.add(uid);
  }
  // Always-on diagnostic: one line per dropdown open. Easy to disable by
  // setting `window.__wbDebugDropdowns = false`.
  if (typeof window === 'undefined' || window.__wbDebugDropdowns !== false) {
    console.log('[slotOptions]', role,
      '→ all=', all.map(m => ({
        slot: m.slot, uid: m.uid, name: m.name, caps: m.capabilities, active: m.active,
      })),
      '→ matched=', mods.map(m => m.uid),
      '→ ghosts=', ghostValues);
  }
  if (!options.length) return [[`(no ${role} attached)`, '0']];
  return options;
}

/**
 * Channel dropdown options for a given module-key value (UID string in v3,
 * legacy slot string in old saves). Looks up the module by uid first, then
 * falls back to slot for backward compat.
 */
export function channelOptionsForSlot(keyStr) {
  if (!keyStr || keyStr === '0') {
    const saved = Object.values(globalThis.__wbDropdownGhosts?.channels || {})
      .flat()
      .map(ch => String(ch));
    const unique = [...new Set(saved)];
    if (unique.length) return unique.map(ch => [`channel ${ch} (saved)`, ch]);
    return [['(select module)', '0']];
  }
  const mods = globalThis.__wbModulesRef?.current || [];
  const mod = mods.find(m => moduleMatchesKey(m, keyStr));
  const list = mod ? channelsForModule(mod) : [];
  const options = [...list];
  const seen = new Set(options.map(([, value]) => String(value)));
  const uid = normalizeUid(keyStr);
  const ghostChannels = [
    ...(globalThis.__wbDropdownGhosts?.channels?.[String(keyStr)] || []),
    ...(uid ? (globalThis.__wbDropdownGhosts?.channels?.[uid] || []) : []),
  ];
  for (const ch of ghostChannels) {
    const value = String(ch);
    if (!value || seen.has(value)) continue;
    options.push([`channel ${value} (saved)`, value]);
    seen.add(value);
  }
  if (options.length) return options;
  if (!mod) return [[`(${keyStr} not present)`, '0']];
  return [['(no channels)', '0']];
}

/** LED command options implemented by the current module firmware. */
export const LED_CMD_OPTIONS = [
  ['solid',   'LED_SOLID'],
  ['off',     'LED_OFF'],
];

export const VIB_CMD_OPTIONS = [
  ['buzz',  'VIBRATE'],
  ['pulse', 'VIBRATE_PULSE'],
  ['stop',  'VIBRATE_STOP'],
];

export const AUDIO_CMD_OPTIONS = [
  ['tone', 'AUDIO_SET_TONE'],
  ['stop', 'AUDIO_STOP'],
];

/**
 * Ensure the currently-held field value is represented in the generated
 * options list — if missing, append a ghost "(missing)" entry so Blockly
 * doesn't silently drop the user's selection.
 */
export function withGhost(options, currentValue) {
  if (currentValue == null) return options;
  const current = String(currentValue);
  const has = options.some(([, v]) => String(v) === current);
  if (has) return options;
  const currentUid = normalizeUid(current);
  const uidMatch = currentUid
    ? options.find(([, v]) => normalizeUid(v) === currentUid)
    : null;
  if (uidMatch) return [...options, [uidMatch[0], currentValue]];
  return [...options, [`${currentValue} (missing)`, currentValue]];
}
