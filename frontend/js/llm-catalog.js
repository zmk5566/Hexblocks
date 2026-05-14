/**
 * Static capability catalog for the LLM panel.
 *
 * Lists module *types the kit ships with* (what *could* be attached) so the
 * model can reason about hardware recommendations even when the requested
 * module isn't currently on the bus. This is intentionally separate from
 * `module-channel-map.js`, which only enumerates channel ids per capability.
 *
 * Keep entries short — one paragraph each. The catalog is injected into the
 * system prompt verbatim, so verbose entries cost tokens on every turn.
 */

import { CHANNELS_BY_CAP } from './module-channel-map.js';

// Module-type → human-facing affordance description. Used by the
// `recommend_modules` intent path to ground hardware suggestions.
//
// Colors and identity names mirror hardware/docs/bom.md so the LLM's
// recommendations match the physical kit the user is holding.
export const MODULE_CATALOG = {
  imu: {
    label: 'imu',
    description:
      'Inertial measurement unit (MPU-6050). Detects motion, tilt, orientation, taps, shakes, freefall, and step counts.',
    channelKey: 'imu',
    color: '#7CA1BB',
  },
  led: {
    label: 'led',
    description:
      'RGB LED ring actuator (NeoPixel x8). Solid color, breathe, blink, ramp, rainbow effects. Use for visual feedback.',
    channelKey: null,
    actuator: true,
    color: '#C68E9E',
  },
  vibration: {
    label: 'vibration',
    description:
      'Haptic vibration motor (DRV2605L + ERM). Pulses, ramps, sustained buzz at variable intensity. Use for silent/eyes-free feedback.',
    channelKey: null,
    actuator: true,
    color: '#50C878',
  },
  audio: {
    label: 'audio',
    description:
      'Audio Synth (MAX98357A I2S amplifier + 8Ω speaker). Plays tones, pulses, and simple synthesis. Use for audible feedback or musical interaction.',
    channelKey: null,
    actuator: true,
    color: '#9885BF',
  },
  light: {
    label: 'light',
    description:
      'Ambient light sensor (GL5528 LDR). Reports normalized brightness 0..1. Use for room/dark detection or context-aware behaviour.',
    channelKey: 'light',
    color: '#C1B496',
  },
  knob: {
    label: 'knob',
    description:
      'Rotary input control (WH148 B100K pot). Reports normalized position 0..1. Use as a continuous user-driven parameter.',
    channelKey: 'knob',
    color: '#98AF6F',
  },
};

/**
 * Module-type → primary capability label. Used by the recommendation-plan
 * matcher to detect "substituted" cases, where the user attached a module
 * whose capability covers the recommended one but whose type differs.
 *
 * Keep this in sync with MODULE_CATALOG. Capability strings are abstract
 * (motion_sensing, audio_output, …) so the matcher can ask "does any
 * attached module also report this capability?" without depending on
 * concrete module-type names.
 */
export const CAPABILITY_BY_TYPE = {
  imu: 'motion_sensing',
  vibration: 'haptic_output',
  led: 'visual_output',
  audio: 'audio_output',
  light: 'light_sensing',
  knob: 'input_control',
};

/**
 * Render the catalog as a markdown list suitable for direct embedding into
 * the system prompt. Channel ranges are pulled from CHANNELS_BY_CAP so the
 * prompt stays in sync with the rest of the frontend.
 */
export function formatCatalog() {
  const lines = [];
  for (const entry of Object.values(MODULE_CATALOG)) {
    let chFragment = '';
    if (entry.channelKey && CHANNELS_BY_CAP[entry.channelKey]) {
      const chs = CHANNELS_BY_CAP[entry.channelKey]
        .map(([lbl, id]) => `${lbl}:${id}`)
        .join(', ');
      chFragment = ` channels=[${chs}]`;
    } else if (entry.actuator) {
      chFragment = ' (actuator, no sensor channels)';
    }
    lines.push(`- ${entry.label} — ${entry.description}${chFragment}`);
  }
  return lines.join('\n');
}
