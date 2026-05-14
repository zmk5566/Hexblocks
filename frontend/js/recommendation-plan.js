/**
 * RecommendationPlan — persistent state for a Loop A module recommendation.
 *
 * Created when the LLM emits a <module_recommendation> envelope. Lives on the
 * LLM panel as `_activePlan` until the user dismisses it or a new
 * recommendation replaces it. Status is recomputed on every modules update;
 * it is not persisted in the plan itself.
 */

import { MODULE_CATALOG, CAPABILITY_BY_TYPE } from './llm-catalog.js';

export const PLAN_STATUS = Object.freeze({
  SATISFIED: 'satisfied',
  SUBSTITUTED: 'substituted',
  MISSING: 'missing',
});

/**
 * Build a RecommendationPlan from a parsed <module_recommendation> JSON
 * envelope. Returns null when the envelope is malformed.
 */
export function makePlanFromEnvelope(parsed) {
  if (!parsed || !Array.isArray(parsed.modules) || parsed.modules.length === 0) {
    return null;
  }
  const modules = [];
  for (const entry of parsed.modules) {
    // Accept both "imu" (string shorthand) and {type, rationale} object forms.
    const type = typeof entry === 'string' ? entry : entry?.type;
    if (!type || !MODULE_CATALOG[type]) continue;
    modules.push({
      type,
      capability: CAPABILITY_BY_TYPE[type] || null,
      rationale: typeof entry === 'object' ? (entry.rationale || '') : '',
    });
  }
  if (!modules.length) return null;
  return {
    modules,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    createdAt: Date.now(),
  };
}

/**
 * Pull the type of an attached live module. Falls back to the first
 * capability when the descriptor doesn't pin a type, since older firmware
 * sends `capabilities: ['imu']` instead of `descriptor.type`.
 */
function moduleType(mod) {
  return mod?.descriptor?.type || (mod?.capabilities || [])[0] || null;
}

/**
 * Map an attached live module to the abstract capability it provides, using
 * its type. Returns null when we don't know what the module does.
 */
function moduleCapability(mod) {
  const t = moduleType(mod);
  return t ? CAPABILITY_BY_TYPE[t] || null : null;
}

/**
 * Compute the status of every plan entry against the live modules list.
 * Returns an array aligned with plan.modules: each item is
 * { status, substituteId?, substituteUid? }.
 *
 * Substitution rule: if no module of the requested type is attached, but
 * some attached module's capability matches the requested capability, mark
 * it substituted and surface which live module covers it. This is intentionally
 * a coarse heuristic — it lets a vibration module (haptic_output) substitute
 * for a recommended vibration but does NOT let it cover an IMU recommendation,
 * because the capability strings differ.
 */
export function computePlanStatus(plan, liveModules) {
  if (!plan) return [];
  const live = (liveModules || []).filter(m => m.active !== false);
  return plan.modules.map(entry => {
    const exact = live.find(m => moduleType(m) === entry.type);
    if (exact) {
      return { status: PLAN_STATUS.SATISFIED, substituteId: exact.id, substituteUid: exact.uid };
    }
    if (entry.capability) {
      const sub = live.find(m => moduleCapability(m) === entry.capability);
      if (sub) {
        return {
          status: PLAN_STATUS.SUBSTITUTED,
          substituteId: sub.id,
          substituteUid: sub.uid,
        };
      }
    }
    return { status: PLAN_STATUS.MISSING };
  });
}

/**
 * Format the plan state into a single line for the LLM feedback prefix.
 * Example: "imu=satisfied; audio=substituted-by-vibration; light=missing"
 * Returns null when there is no plan or it has zero entries.
 */
export function formatPlanStateLine(plan, liveModules) {
  if (!plan || !plan.modules.length) return null;
  const statuses = computePlanStatus(plan, liveModules);
  const parts = plan.modules.map((entry, i) => {
    const s = statuses[i];
    if (s.status === PLAN_STATUS.SATISFIED) return `${entry.type}=satisfied`;
    if (s.status === PLAN_STATUS.SUBSTITUTED) {
      // Surface what type covered the slot, not the uid — the LLM cares
      // about substitution semantics, not the specific physical module.
      const subType = s.substituteId ? s.substituteId.replace(/[0-9_]+$/, '') : 'other';
      return `${entry.type}=substituted-by-${subType}`;
    }
    return `${entry.type}=missing`;
  });
  return parts.join('; ');
}
