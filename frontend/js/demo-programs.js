/**
 * Pre-canned Blockly workspace JSON for the three simulator demos.
 * Used by the D1/D2/D3 buttons in <wb-status-bar>.
 *
 * Slot/channel identity uses the legacy slot-string path. The sim's
 * SIM_MODULE_DEFS pins each module type to a fixed slot:
 *   imu=1, hr=2, temp/vib=3/4, led=5, light=6, audio=7
 *
 * Channel ids mirror eca-encoder.js CH:
 *   AX=0, ACC_MAG=6, LIGHT=41
 */

import { CH } from './eca-encoder.js';

const LIGHT_SLOT = '6';
const LED_SLOT   = '5';
const AUDIO_SLOT = '7';
const IMU_SLOT   = '1';

/** D1: Adaptive Night Light.
 *  Two rules: when light < 0.3, LED on (warm white); when light > 0.5,
 *  LED off. */
export const DEMO_D1 = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'eca_rule',
        x: 20, y: 20,
        fields: { LOGIC: 'AND' },
        inputs: {
          CONDITIONS: { block: {
            type: 'sensor_condition',
            fields: {
              SLOT: LIGHT_SLOT, CHANNEL: String(CH.LIGHT),
              OP: 'LT', THRESHOLD: 0.3, COOLDOWN: 1000, HOLD: 0,
            },
          }},
          ACTIONS: { block: {
            type: 'led_action',
            fields: {
              SLOT: LED_SLOT, CMD: 'LED_SOLID',
              R: 255, G: 220, B: 160,
            },
          }},
        },
      },
      {
        type: 'eca_rule',
        x: 20, y: 220,
        fields: { LOGIC: 'AND' },
        inputs: {
          CONDITIONS: { block: {
            type: 'sensor_condition',
            fields: {
              SLOT: LIGHT_SLOT, CHANNEL: String(CH.LIGHT),
              OP: 'GT', THRESHOLD: 0.5, COOLDOWN: 1000, HOLD: 0,
            },
          }},
          ACTIONS: { block: {
            type: 'led_action',
            fields: {
              SLOT: LED_SLOT, CMD: 'LED_OFF',
              R: 0, G: 0, B: 0,
            },
          }},
        },
      },
    ],
  },
};

/** D2: Light-Driven Theremin.
 *  Virtual channel vc0 = MAP(light to 200..2000 Hz), then a single
 *  always-true rule drives the audio synth's freq via vc0. */
export const DEMO_D2 = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'vc_def',
        x: 20, y: 20,
        fields: { OP: 'MAP', B_CONST: 200, C_CONST: 2000 },
        inputs: {
          A: { block: {
            type: 'ref_slot',
            fields: { SLOT: LIGHT_SLOT, CHANNEL: String(CH.LIGHT) },
          }},
        },
      },
      {
        type: 'eca_rule',
        x: 20, y: 200,
        fields: { LOGIC: 'AND' },
        inputs: {
          CONDITIONS: { block: {
            type: 'sensor_condition',
            fields: {
              SLOT: LIGHT_SLOT, CHANNEL: String(CH.LIGHT),
              OP: 'GTE', THRESHOLD: 0, COOLDOWN: 100, HOLD: 0,
            },
          }},
          ACTIONS: { block: {
            type: 'audio_action',
            fields: { SLOT: AUDIO_SLOT, CMD: 'AUDIO_SET_TONE', FREQ: 440, AMP: 180 },
            inputs: {
              FREQ_REF: { block: {
                type: 'ref_vc',
                fields: { VC_ID: '0' },
              }},
            },
          }},
        },
      },
    ],
  },
};

/** D3: Remote Motion Alert.
 *  IMU acc-magnitude > 1.4g triggers audio beep AND LED red flash. Two
 *  actions chained on a single rule. */
export const DEMO_D3 = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'eca_rule',
        x: 20, y: 20,
        fields: { LOGIC: 'AND' },
        inputs: {
          CONDITIONS: { block: {
            type: 'sensor_condition',
            fields: {
              SLOT: IMU_SLOT, CHANNEL: String(CH.ACC_MAG),
              OP: 'GT', THRESHOLD: 1.4, COOLDOWN: 2000, HOLD: 0,
            },
          }},
          ACTIONS: { block: {
            type: 'audio_action',
            fields: { SLOT: AUDIO_SLOT, CMD: 'AUDIO_SET_TONE', FREQ: 880, AMP: 200 },
            next: { block: {
              type: 'led_action',
              fields: {
                SLOT: LED_SLOT, CMD: 'LED_SOLID',
                R: 255, G: 30, B: 30,
              },
            }},
          }},
        },
      },
    ],
  },
};

export const DEMO_PROGRAMS = {
  demo1: DEMO_D1,
  demo2: DEMO_D2,
  demo3: DEMO_D3,
};
