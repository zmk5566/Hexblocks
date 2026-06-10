(function () {
  const colors = {
    light: '#C1B496',
    audio: '#9885BF',
    knob: '#98AF6F',
    hub: '#989898',
    motion: '#7CA1BB',
    accent: '#0A8F7A',
    visual: '#C68E9E'
  };

  window.HEXBLOCKS_DECK = {
    title: 'HexBlocks',
    colors,
    scenes: {
      ambient: {
        kind: 'ambient',
        caption: 'hub and stacked modules share one live topology',
        modules: [
          { id: 'light', label: 'Light', uid: 'LDR-41', color: colors.light, from: [-270, -145], to: [-100, -58], delay: 120 },
          { id: 'audio', label: 'Audio', uid: 'AUD-77', color: colors.audio, from: [270, -138], to: [100, -58], delay: 260 },
          { id: 'knob', label: 'Knob', uid: 'KNB-12', color: colors.knob, from: [240, 146], to: [0, 116], delay: 420 },
          { id: 'imu', label: 'IMU', uid: 'IMU-09', color: colors.motion, from: [-250, 152], to: [-100, 58], delay: 560 },
          { id: 'rgb', parent: 'imu', label: 'RGB', uid: 'LED-08', color: colors.visual, from: [-285, 190], to: [-100, 174], idleOrigin: [-100, 58], delay: 760, idleStep: 5 }
        ],
        edges: [
          { fromRef: 'hub', toRef: 'light', color: colors.light, delay: 760 },
          { fromRef: 'hub', toRef: 'audio', color: colors.audio, delay: 900 },
          { fromRef: 'hub', toRef: 'knob', color: colors.knob, delay: 1040 },
          { fromRef: 'hub', toRef: 'imu', color: colors.motion, delay: 1160 },
          { fromRef: 'imu', toRef: 'rgb', color: colors.visual, delay: 1360 }
        ],
        chips: [
          { label: 'live schema', sub: 'UID + channels', at: [-62, -156], delay: 980 },
          { label: 'stacked attach', sub: 'module-on-module', at: [80, 126], delay: 1460 }
        ]
      },
      continuity: {
        kind: 'continuity',
        caption: 'one module identity flows through authoring and runtime',
        modules: [
          { id: 'light', label: 'Light', uid: 'LDR-41', color: colors.light, from: [-260, -116], to: [-138, -62], delay: 100 }
        ],
        edges: [
          { from: [-96, -62], to: [10, -62], color: colors.light, delay: 560 },
          { from: [84, -62], to: [170, 0], color: colors.accent, delay: 860 },
          { from: [170, 42], to: [0, 0], color: colors.audio, delay: 1180 }
        ],
        chips: [
          { label: '@lightv3', sub: 'visible reference', at: [-12, -95], delay: 560 },
          { label: 'Blockly rule', sub: 'inspectable', at: [70, -10], delay: 880 },
          { label: 'UID target', sub: 'runtime binding', at: [88, 92], delay: 1180 }
        ]
      },
      architecture: {
        kind: 'architecture',
        caption: 'hardware descriptors feed the authoring schema and runtime',
        modules: [
          { id: 'hub', label: 'Hub', uid: 'ECA', color: colors.hub, from: [0, 250], to: [0, 110], delay: 120 },
          { id: 'ui', label: 'UI', uid: 'schema', color: colors.motion, from: [-270, -30], to: [-132, -44], delay: 260 },
          { id: 'rule', label: 'Rule', uid: 'uid-keyed', color: colors.visual, from: [270, -36], to: [132, -44], delay: 400 }
        ],
        edges: [
          { from: [-92, -44], to: [92, -44], color: colors.motion, delay: 760 },
          { from: [88, -24], to: [24, 86], color: colors.visual, delay: 940 },
          { from: [-24, 86], to: [-88, -24], color: colors.accent, delay: 1120 }
        ],
        chips: [
          { label: 'descriptor', sub: 'identity + channel', at: [-166, 92], delay: 700 },
          { label: 'bytecode', sub: 'no reflash', at: [82, 92], delay: 1000 }
        ]
      },
      attach: {
        kind: 'attach',
        caption: 'attach modules; live schema appears with the topology',
        modules: [
          { id: 'light', label: 'Light', uid: 'LDR-41', color: colors.light, from: [-280, -132], to: [-128, -74], delay: 120 },
          { id: 'audio', label: 'Audio', uid: 'AUD-77', color: colors.audio, from: [280, -132], to: [128, -74], delay: 320 }
        ],
        edges: [
          { from: [0, 0], to: [-128, -74], color: colors.light, delay: 660 },
          { from: [0, 0], to: [128, -74], color: colors.audio, delay: 840 }
        ],
        chips: [
          { label: 'light: 0..1', sub: 'sensor channel', at: [-178, 100], delay: 880 },
          { label: 'tone: 0..4000', sub: 'audio action', at: [58, 100], delay: 1060 }
        ]
      },
      move: {
        kind: 'move',
        caption: 'position changes; UID labels stay attached to modules',
        modules: [
          { id: 'light', label: 'Light', uid: 'LDR-41', color: colors.light, from: [-260, -122], to: [-128, -74], move: [128, 74], delay: 80, moveRot: '8deg' },
          { id: 'knob', label: 'Knob', uid: 'KNB-12', color: colors.knob, from: [250, 130], to: [128, 74], move: [-128, -74], delay: 180, moveRot: '-8deg' },
          { id: 'audio', label: 'Audio', uid: 'AUD-77', color: colors.audio, from: [270, -130], to: [128, -74], delay: 260 }
        ],
        edges: [
          { from: [0, 0], to: [-128, -74], color: colors.knob, delay: 780 },
          { from: [0, 0], to: [128, 74], color: colors.light, delay: 980 },
          { from: [0, 0], to: [128, -74], color: colors.audio, delay: 1180 }
        ],
        chips: [
          { label: 'same UID', sub: 'not face number', at: [-178, 106], delay: 1050 },
          { label: 'schema refresh', sub: 'binding preserved', at: [56, 112], delay: 1280 }
        ]
      },
      reauthor: {
        kind: 'reauthor',
        caption: 'new behavior can reuse explicit module identities',
        modules: [
          { id: 'knob', label: 'Knob', uid: 'KNB-12', color: colors.knob, from: [-240, -126], to: [-128, -74], delay: 100 },
          { id: 'light', label: 'Light', uid: 'LDR-41', color: colors.light, from: [240, 128], to: [128, 74], delay: 200 },
          { id: 'audio', label: 'Audio', uid: 'AUD-77', color: colors.audio, from: [260, -122], to: [128, -74], delay: 300 }
        ],
        edges: [
          { from: [-128, -74], to: [128, -74], color: colors.knob, delay: 720 },
          { from: [128, 74], to: [128, -74], color: colors.light, delay: 960 }
        ],
        chips: [
          { label: 'pitch', sub: 'knob -> audio', at: [-168, 110], delay: 960 },
          { label: 'amplitude', sub: 'light -> audio', at: [54, 110], delay: 1160 }
        ]
      },
      redeploy: {
        kind: 'redeploy',
        caption: 'deployment targets UIDs, so motion does not reset meaning',
        modules: [
          { id: 'knob', label: 'Knob', uid: 'KNB-12', color: colors.knob, from: [-240, -126], to: [-128, -74], move: [128, 74], delay: 80, moveRot: '8deg' },
          { id: 'light', label: 'Light', uid: 'LDR-41', color: colors.light, from: [240, 124], to: [128, 74], move: [-128, -74], delay: 180, moveRot: '-8deg' },
          { id: 'audio', label: 'Audio', uid: 'AUD-77', color: colors.audio, from: [260, -126], to: [128, -74], delay: 280 }
        ],
        edges: [
          { from: [-128, -74], to: [128, -74], color: colors.knob, delay: 650 },
          { from: [128, 74], to: [128, -74], color: colors.light, delay: 820 },
          { from: [0, 0], to: [128, -74], color: colors.accent, delay: 1160 }
        ],
        packets: [
          { label: 'ECA', from: [-168, 122], to: [0, 0], delay: 980 }
        ],
        chips: [
          { label: 'redeployed', sub: 'UID-keyed', at: [-174, 110], delay: 1320 },
          { label: 'still bound', sub: 'after move', at: [66, 114], delay: 1520 }
        ]
      },
      continuityConfigMini: {
        kind: 'mini-config-loop',
        modules: [
          { id: 'light', label: 'Light', uid: 'LDR-41', color: colors.light, from: [-200, -58], to: [-110, -28], move: [90, 30], delay: 70, moveRot: '7deg' },
          { id: 'knob', label: 'Knob', uid: 'KNB-12', color: colors.knob, from: [196, 56], to: [110, 28], move: [-90, 30], delay: 170, moveRot: '-7deg' },
          { id: 'audio', label: 'Audio', uid: 'AUD-77', color: colors.audio, from: [196, -56], to: [110, -28], delay: 260 }
        ]
      },
      continuityAuthoringMini: {
        kind: 'mini-authoring-loop',
        modules: [
          { id: 'light', label: 'Light', uid: 'LDR-41', color: colors.light, from: [-210, -48], to: [-132, -24], delay: 80 },
          { id: 'knob', label: 'Knob', uid: 'KNB-12', color: colors.knob, from: [0, -88], to: [0, -34], delay: 210 },
          { id: 'audio', label: 'Audio', uid: 'AUD-77', color: colors.audio, from: [210, -48], to: [132, -24], delay: 330 }
        ]
      },
      continuityDeploymentMini: {
        kind: 'mini-deployment-loop',
        modules: [
          { id: 'knob', label: 'Knob', uid: 'KNB-12', color: colors.knob, from: [-204, -52], to: [-116, -28], delay: 80 },
          { id: 'light', label: 'Light', uid: 'LDR-41', color: colors.light, from: [-196, 58], to: [-116, 30], delay: 180 },
          { id: 'audio', label: 'Audio', uid: 'AUD-77', color: colors.audio, from: [210, -44], to: [126, -22], delay: 280 }
        ]
      }
    },
    audioBase: 'audio/tts-dacey/',
    slides: [
      {
        slug: 'title',
        scene: 'ambient',
        chip: 'HexBlocks',
        title: 'Open-Source Prototyping of Reconfigurable Physical Interfaces with Semantic Continuity',
        authors: [
          { name: 'Zhengyang Kenny Ma', url: 'https://zmk5566.github.io/' },
          { name: 'Xuetong Wang', url: 'https://poiuytxw.github.io/' }
        ],
        sub: 'github.com/zmk5566/HexBlocks',
        narration: [
          {
            text: 'In this video, we present HexBlocks, an open-source software-hardware framework for rapid, on-the-fly prototyping of reconfigurable physical interfaces.',
            durationMs: 9000
          }
        ]
      },
      {
        slug: 'llm-era-prototyping',
        chip: 'Motivation',
        title: 'LLMs Are Changing Hardware Prototyping',
        lead: 'With LLMs, a prototype can begin as a conversation about what the interaction should do, rather than as a firmware-writing task.',
        leadReveal: 'step',
        bulletHeading: 'Trends',
        bulletsReveal: 'step',
        bullets: [
          'Users can describe intent before committing to wiring diagrams or firmware templates.',
          'LLMs can suggest modules and draft behavior from natural-language prompts.',
          'Designers, educators, and domain experts can join early hardware sketching without first writing firmware.'
        ],
        narration: [
          {
            text: 'Large language models are changing how people prototype interactive hardware.',
            durationMs: 5200
          },
          {
            text: 'With LLMs, a prototype can begin as a conversation about what the interaction should do, rather than as a firmware-writing task.',
            durationMs: 7600,
            action: { type: 'reveal', selector: '[data-step-lead]' }
          },
          {
            text: 'The first opportunity is that users can describe intent before committing to wiring diagrams or firmware templates.',
            durationMs: 6800,
            action: { type: 'reveal', selector: '[data-bullet-heading], [data-bullet-index="1"]' }
          },
          {
            text: 'The model can then suggest modules and draft behavior from natural-language prompts, making the first prototype easier to start.',
            durationMs: 7800,
            action: { type: 'reveal', selector: '[data-bullet-index="2"]' }
          },
          {
            text: 'This brings designers, educators, and domain experts into early hardware sketching, even when they do not write firmware.',
            durationMs: 7600,
            action: { type: 'reveal', selector: '[data-bullet-index="3"]' }
          }
        ]
      },
      {
        slug: 'llm-hardware-breakdown',
        chip: 'Problem',
        title: 'Where LLM-Mediated Hardware Prototyping Breaks Down',
        titleReveal: 'step',
        lead: 'The dilemma for LLM-mediated prototyping: generated behavior <span class="text-underline">must stay grounded in physical modules</span>.',
        leadReveal: 'step',
        imageTriptych: [
          { src: 'pics/a.jpg', alt: 'A designer overwhelmed by component catalogs and LLM suggestions.' },
          { src: 'pics/b.jpg', alt: 'A generated hardware sketch that fails in wiring, code, and debugging.' },
          { src: 'pics/c.jpg', alt: 'A small hardware change that forces reflashing and re-prompting.' }
        ],
        narration: [
          {
            text: 'But once LLMs help generate behavior for physical prototypes, a new problem appears.',
            durationMs: 5600,
            action: { type: 'reveal', selector: '[data-step-title]' }
          },
          {
            text: 'The generated behavior must stay grounded in the real modules, channels, and attachment state of the assembly.',
            durationMs: 6800,
            action: { type: 'reveal', selector: '[data-step-lead]' }
          },
          {
            text: 'Imagine a non-technical user who wants to build a safety night-light wristband. She can describe the goal, but choosing the right sensors and feedback modules is still an unfamiliar hardware search.',
            durationMs: 9200,
            action: { type: 'reveal', selector: '[data-reveal-step="1"]' }
          },
          {
            text: 'After behavior is generated, the wristband may still fail in ways that are hard to locate: the rule, the wiring, the module capability, or the generated assumption may be wrong.',
            durationMs: 9000,
            action: { type: 'reveal', selector: '[data-reveal-step="2"]' }
          },
          {
            text: 'As she moves modules or swaps feedback hardware, the authored behavior can lose contact with the physical module it was written for, forcing re-prompting, repair, or redeployment work.',
            durationMs: 9200,
            action: { type: 'reveal', selector: '[data-reveal-step="3"]' }
          }
        ]
      },
      {
        slug: 'related-work',
        chip: 'Related Work',
        title: 'Prior Work Solves Pieces, Not Continuity',
        table: {
          headers: ['Layer', 'Examples', 'What they support', 'Remaining gap'],
          rows: [
            ['Physical construction', '<strong>Phidgets, Gadgeteer, SkinKit</strong>', 'connectable sensors and actuators<br>reconfigurable assemblies', '<span class="gap-cell">behavior references often do not follow topology changes</span>'],
            ['Blocks-based authoring', '<strong>Blockly, MakeCode</strong>', 'inspectable embedded programs<br>editable rules and constrained palettes', '<span class="gap-cell">device palettes and references are often comparatively static</span>'],
            ['LLM-assisted programming', '<strong>ChatIoT, AutoIoT, Code as Policies</strong>', 'natural-language rules or control code<br>fast behavior sketching', '<span class="gap-cell">generated references still need live grounding and validation</span>']
          ]
        },
        quote: 'These systems improve parts of prototyping.<br>HexBlocks focuses on the continuity between the parts.',
        narration: [
          {
            text: 'Prior work makes parts of this process easier: construction kits support assembly, block-based authoring environments support inspection, and LLM systems support intent-to-code generation.',
            durationMs: 9000
          },
          {
            text: 'But these systems usually assume a fixed hardware model, so the connection between changing modules, generated behavior, and deployed runtime still has to be maintained by the user.',
            durationMs: 9000
          }
        ]
      },
      {
        slug: 'hexblocks-overview',
        chip: 'Our Work',
        title: 'Our Work Toward These Problems: HexBlocks',
        imageSequence: {
          mode: 'stack',
          frameMs: 1000,
          frames: [
            { src: 'pics/introduction-to-sections/1.png', alt: 'HexBlocks system section introduction frame 1.' },
            { src: 'pics/introduction-to-sections/2.png', alt: 'HexBlocks system section introduction frame 2.' },
            { src: 'pics/introduction-to-sections/3.png', alt: 'HexBlocks system section introduction frame 3.' },
            { src: 'pics/introduction-to-sections/4.png', alt: 'HexBlocks system section introduction frame 4.' },
            { src: 'pics/introduction-to-sections/5.png', alt: 'HexBlocks system section introduction frame 5.' },
            { src: 'pics/introduction-to-sections/6.png', alt: 'HexBlocks system section introduction frame 6.' },
            { src: 'pics/introduction-to-sections/7.png', alt: 'HexBlocks system section introduction frame 7.' },
            { src: 'pics/introduction-to-sections/8.png', alt: 'HexBlocks system section introduction frame 8.' }
          ]
        },
        onEnterStep: true,
        narration: [
          {
            text: 'HexBlocks addresses this gap by bringing module assembly, topology, behavior authoring, LLM assistance, and live data inspection into one workspace.',
            durationMs: 7000,
            action: { type: 'playImageSequence', selector: '[data-image-sequence]', frameMs: 1000, mode: 'stack' }
          },
          {
            text: 'This gives HexBlocks its central property, semantic continuity: the system treats a module as the same entity across assembly, authoring, inspection, and deployment.',
            durationMs: 7600
          },
          {
            text: 'The next clip walks through how these views work together in the prototype.',
            durationMs: 5200
          }
        ]
      },
      {
        slug: 'system-overview-video',
        chip: 'Video',
        title: 'System Overview',
        video: {
          src: 'https://hk-static-host-1258866552.cos.ap-hongkong.myqcloud.com/hex-blocks/video/system-overview-vid-cropped-v3.mp4',
          controls: true,
          autoplay: true,
          muted: false,
          resetOnLeave: true
        },
        videoCaptions: [
          { start: 0.3, durationMs: 2933, text: 'A central hub supplies power and carries data for the connected modules.' },
          { start: 4.5, durationMs: 3067, text: 'Modules magnetically snap onto the hub, and the live module list and visualized topology panel update with the physical assembly.' },
          { start: 10.9, durationMs: 2400, text: 'This digital view precisely reflects the snapped physical configuration.' },
          { start: 14.55, durationMs: 6100, text: 'The interface also visualizes live data from one or multiple sensors.' },
          { start: 25.5, durationMs: 3333, text: 'Beyond hub-to-module attachment, a module can also become the parent for another module.' },
          { start: 33.41, durationMs: 3333, text: 'This lets the physical topology extend into a three-layer arrangement in the reference design.' },
          { start: 38.7, durationMs: 3000, text: 'Even as the topology changes, sensor data continues to arrive through the same module identity.' }
        ]
      },
      {
        slug: 'semantic-continuity',
        sceneStack: [
          { scene: 'continuityConfigMini', label: 'Reconfigure topology', tone: 'config' },
          { scene: 'continuityAuthoringMini', label: 'Reauthor behavior', tone: 'authoring' },
          { scene: 'continuityDeploymentMini', label: 'Redeploy without reset', tone: 'deployment' }
        ],
        chip: 'Core Concept',
        title: 'Semantic Continuity',
        def: 'Physical modules, authoring references, and runtime targets remain bound to the same UID-keyed entities as topology changes.',
        defReveal: 'semantic-def',
        cards: [
          ['Configuration Continuity', 'Attach, swap, or stack modules. The physical layout changes while each UID stays with the same object.', 'Reconfigure topology'],
          ['Authoring Continuity', 'LLM and Blockly references stay grounded in the topology-aware live schema, not a static device list.', 'Reauthor behavior'],
          ['Deployment Continuity', 'UID-keyed ECA bytecode targets modules by identity, so accepted rules survive physical reconfiguration.', 'Redeploy without reset']
        ],
        quoteParts: ['Physical module', 'LLM reference / Blockly block', 'UID-keyed runtime target'],
        onEnterStep: true,
        narration: [
          {
            text: 'The clip shows what semantic continuity provides: the same module identity stays valid across assembly, inspection, authoring, and deployment.',
            durationMs: 7600,
            actions: [
              { type: 'setSlideState', state: 'intro' },
              { type: 'reveal', selector: '[data-action-reveal="semantic-def"]' },
              { type: 'pauseScene', selector: '[data-scene-stage]' }
            ]
          },
          {
            text: 'The concept that holds these parts together is semantic continuity.',
            durationMs: 4600
          },
          {
            text: 'We describe it through three forms of continuity.',
            durationMs: 3600
          },
          {
            text: 'Configuration continuity keeps module identity stable as users attach, swap, or stack modules.',
            durationMs: 5200,
            actions: [
              { type: 'setSlideState', state: 'config' },
              { type: 'pauseScene', selector: '[data-scene-stage]' },
              { type: 'restartScene', selector: '[data-scene-stage="continuityConfigMini"]' }
            ]
          },
          {
            text: 'Authoring continuity keeps LLM and Blockly references grounded in the live schema, rather than in a static device list.',
            durationMs: 5400,
            actions: [
              { type: 'setSlideState', state: 'authoring' },
              { type: 'pauseScene', selector: '[data-scene-stage]' },
              { type: 'restartScene', selector: '[data-scene-stage="continuityAuthoringMini"]' }
            ]
          },
          {
            text: 'Deployment continuity keeps the accepted ECA program targeting the same UID-keyed modules at runtime.',
            durationMs: 5400,
            actions: [
              { type: 'setSlideState', state: 'deployment' },
              { type: 'pauseScene', selector: '[data-scene-stage]' },
              { type: 'restartScene', selector: '[data-scene-stage="continuityDeploymentMini"]' }
            ]
          },
          {
            text: 'Together, these continuities connect the physical prototype, the authoring interface, and the deployed behavior.',
            durationMs: 5600,
            actions: [
              { type: 'setSlideState', state: 'synthesis' },
              { type: 'restartScene', selector: '[data-scene-stage]' }
            ]
          }
        ]
      },
      {
        slug: 'light-theremin-walkthrough-video',
        chip: 'Video',
        title: 'Light Theremin Demo Walkthrough',
        video: {
          src: 'https://hk-static-host-1258866552.cos.ap-hongkong.myqcloud.com/hex-blocks/video/light-theremin-walkthrough-cropped-hq.mp4',
          controls: true,
          autoplay: true,
          muted: false,
          resetOnLeave: true
        },
        videoCaptions: [
          { start: 0, durationMs: 3800, text: 'This walkthrough uses a light theremin as a running example.' },
          { start: 3.8, durationMs: 4200, text: 'The user first asks the LLM what modules are needed to build that interaction.' },
          { start: 8, durationMs: 4700, text: 'Following the recommendation, the user attaches the suggested modules to the hub.' },
          { start: 13, durationMs: 5000, text: 'As those modules appear in the live schema, the user can ask the LLM to author behavior for the current assembly.' },
          { start: 19, durationMs: 6000, text: 'The generated ECA rules are not hidden code: the user can accept, reject, or revise them as editable Blockly blocks.' },
          { start: 26, durationMs: 6500, text: 'This block form makes the behavior inspectable and steerable, while the sensor visualization panel shows the system starting to run.' },
          { start: 33, durationMs: 7000, text: 'When the user adds another module, module awareness lets the LLM update the program against the new live schema.' },
          { start: 42, durationMs: 8000, text: 'The user intent can change from a simple light theremin to a richer mapping without rebuilding the hardware model from scratch.' },
          { start: 60, durationMs: 5200, text: 'Returning to semantic continuity, the user can move modules while the deployed behavior keeps working.' },
          { start: 65.8, durationMs: 6400, text: 'Because the ECA program is UID-keyed and persisted on the hub, it can resume after power cycling.' },
          { start: 72.5, durationMs: 6500, text: 'Programs can also be exported and imported, avoiding an Arduino-style compile-and-flash cycle and speeding iteration.' },
          { start: 80, durationMs: 5200, text: 'Adding more modules lets the same workflow scale toward more complex interactive systems.' }
        ]
      },
      {
        slug: 'operating-modes',
        chip: 'Operating Modes',
        title: 'Two Ways to Run the Same Hardware',
        lead: 'The walkthrough used standalone hub execution. The same live schema can also stream events to external creative software.',
        onEnterStep: true,
        modeCards: [
          {
            kicker: 'Mode A',
            title: 'Standalone Mode',
            subtitle: 'Hub-Resident Execution',
            body: 'Accepted ECA bytecode runs on the hub, persists across power cycles, and drives actuators without a companion computer in the rule loop.',
            image: {
              src: 'pics/modes/a.png',
              alt: 'Standalone HexBlocks mode diagram.'
            }
          },
          {
            kicker: 'Mode B',
            title: 'External Software interaction Mode',
            subtitle: 'Sensor-Stream Integration',
            body: 'The hub forwards decoded sensor and actuator-state events through the bridge to external creative-coding tools such as OSC targets.',
            image: {
              src: 'pics/modes/b.png',
              alt: 'External software interaction mode diagram.'
            }
          }
        ],
        narration: [
          {
            text: 'The walkthrough we just saw is a standalone example: the accepted ECA behavior runs directly on the hub.',
            durationMs: 5600
          },
          {
            text: 'This is Mode A, hub-resident execution: the UI is used to author and update rules, but once accepted, the behavior runs on the hub without a companion computer or external device in the rule loop.',
            durationMs: 9400,
            action: { type: 'reveal', selector: '[data-mode-card="1"]' }
          },
          {
            text: 'HexBlocks also supports Mode B: the same live module events can stream through the bridge to external software, including OSC-based creative coding and interactive media tools.',
            durationMs: 8200,
            action: { type: 'reveal', selector: '[data-mode-card="2"]' }
          }
        ]
      },
      {
        slug: 'night-walk-safety',
        hidden: true,
        fullImage: {
          src: 'pics/night-walk-safety.png',
          alt: 'Illustrated night walk safety prototype concept built with HexBlocks modules.'
        }
      },
      {
        slug: 'closing',
        chip: 'Open Source',
        title: 'HexBlocks',
        visualImage: {
          src: 'pics/ending-pic.jpg',
          alt: 'HexBlocks physical modules arranged on a table during a live demonstration.'
        },
        closing: {
          intro: 'Technical details, hardware files, semantic-continuity implementation, and simulator:',
          repo: 'github.com/zmk5566/HexBlocks',
          tags: ['Technical details', 'Hardware + enclosure design', 'Semantic continuity implementation', 'Simulator without hardware', 'MIT firmware', 'CC BY 4.0 hardware'],
          moduleTypes: [
            { label: 'Light Sensor', color: colors.light },
            { label: 'Audio Synth', color: colors.audio },
            { label: 'Knob', color: colors.knob },
            { label: 'IMU Motion', color: colors.motion },
            { label: 'RGB LED Ring', color: colors.visual },
            { label: 'Hub', color: colors.hub }
          ]
        },
        onEnterStep: true,
        narration: [
          {
            text: 'For technical details, hardware and enclosure designs, and how semantic continuity is implemented, please visit our GitHub repository.',
            durationMs: 6200
          },
          {
            text: 'The repository also includes simulator and walkthrough materials, so you can try the authoring flow even without physical devices.',
            durationMs: 6200
          },
          {
            text: 'This concludes our presentation. Thank you for watching. HexBlocks is open source, and we welcome collaboration in research, education, creative coding, and interactive hardware prototyping. Please feel free to reach out if you are interested in using, extending, or contributing to HexBlocks.',
            durationMs: 14000
          }
        ]
      },
      {
        slug: 'references',
        chip: 'References',
        title: 'References',
        references: [
          ['greenberg2001phidgets', 'Greenberg &amp; Fitchett. <em>Phidgets: Easy Development of Physical Interfaces through Physical Widgets.</em> UIST 2001.'],
          ['villar2011gadgeteer', 'Villar, Scott &amp; Hodges. <em>Prototyping with Microsoft .NET Gadgeteer.</em> TEI 2011.'],
          ['ku2021skinkit', 'Ku et al. <em>SkinKit: Construction Kit for On-Skin Interface Prototyping.</em> IMWUT 2021.'],
          ['pasternak2017blockly', 'Pasternak, Fenichel & Marshall. <em>Tips for Creating a Block Language with Blockly.</em> IEEE Blocks and Beyond 2017.'],
          ['makecode', 'Ball et al. <em>Microsoft MakeCode: Embedded Programming for Education, in Blocks and TypeScript.</em> SIGCSE 2019.'],
          ['gao2024chatiot', 'Gao et al. <em>ChatIoT: Zero-code Generation of Trigger-action Based IoT Programs.</em> IMWUT 2024.'],
          ['shen2025autoiot', 'Shen et al. <em>AutoIOT: LLM-Driven Automated Natural Language Programming for AIoT Applications.</em> MobiCom 2025.'],
          ['liang2023codeaspolicies', 'Liang et al. <em>Code as Policies: Language Model Programs for Embodied Control.</em> ICRA 2023.']
        ],
        referenceMarquee: {
          message: 'THANKS FOR WATCHING',
          modules: [
            { label: 'Light', color: colors.light },
            { label: 'Audio', color: colors.audio },
            { label: 'Knob', color: colors.knob },
            { label: 'Motion', color: colors.motion },
            { label: 'RGB', color: colors.visual },
            { label: 'Hub', color: colors.hub }
          ]
        }
      }
    ]
  };
})();
