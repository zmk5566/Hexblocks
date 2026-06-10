(function () {
  const HEX_BG = [
    [-186, -148, -8], [-108, -152, 8], [-30, -148, -4], [48, -152, 5], [126, -148, -7],
    [-148, -82, 6], [-70, -86, -6], [8, -82, 8], [86, -86, -5], [164, -82, 6],
    [-186, -16, -7], [-108, -20, 7], [-30, -16, -5], [48, -20, 6], [126, -16, -8],
    [-148, 50, 6], [-70, 46, -4], [8, 50, 6], [86, 46, -7], [164, 50, 4],
    [-186, 116, 5], [-108, 112, -7], [-30, 116, 5], [48, 112, -4], [126, 116, 7]
  ];
  const SNAP_PRE_VECTORS = [
    [0, -98],
    [86, -49],
    [86, 49],
    [0, 98],
    [-86, 49],
    [-86, -49]
  ];
  const SNAP_FINAL_VECTORS = [
    [0, -77],
    [67, -39],
    [67, 39],
    [0, 77],
    [-67, 39],
    [-67, -39]
  ];
  const SNAP_EDGE_INSET = 38;
  const SNAP_DEPTH_DELAY_MS = 240;
  const SNAP_RETURN_MS = 620;
  const SNAP_SETTLE_MS = 920;
  const SNAP_RELEASE_MS = SNAP_SETTLE_MS * 3;
  const SNAP_BREATHE_RESUME_MS = SNAP_SETTLE_MS;

  function px(value) {
    return `${Math.round(value)}px`;
  }

  function styleVars(map) {
    return Object.entries(map)
      .map(([key, value]) => `${key}:${value}`)
      .join(';');
  }

  function finalPosition(mod) {
    return mod.move || mod.to || [0, 0];
  }

  function distance(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  function closestSnapFace(vector, usedFaces = new Set()) {
    const angle = Math.atan2(vector[1], vector[0]);
    const ranked = SNAP_FINAL_VECTORS.map((candidate, index) => {
      const candidateAngle = Math.atan2(candidate[1], candidate[0]);
      const delta = Math.abs(Math.atan2(
        Math.sin(angle - candidateAngle),
        Math.cos(angle - candidateAngle)
      ));
      return { candidate, index, delta };
    }).sort((a, b) => a.delta - b.delta);

    const open = ranked.find((entry) => !usedFaces.has(entry.index)) || ranked[0];
    usedFaces.add(open.index);
    return open.index;
  }

  function closestRef(point, moduleById, maxDistance = 34) {
    if (!Array.isArray(point)) return null;
    const candidates = [['hub', [0, 0]]];
    for (const [id, mod] of moduleById.entries()) {
      if (id === 'hub') continue;
      candidates.push([id, finalPosition(mod)]);
    }
    const best = candidates
      .map(([id, candidate]) => ({ id, distance: distance(point, candidate) }))
      .sort((a, b) => a.distance - b.distance)[0];
    return best && best.distance <= maxDistance ? best.id : null;
  }

  function edgeRefs(edge, moduleById) {
    return {
      from: edge.fromRef || closestRef(edge.from, moduleById),
      to: edge.toRef || closestRef(edge.to, moduleById)
    };
  }

  function addChild(childrenByParent, parent, child) {
    if (!parent || !child || parent === child) return;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    const children = childrenByParent.get(parent);
    if (!children.includes(child)) children.push(child);
  }

  function snapMapFor(scene) {
    const moduleById = new Map((scene.modules || []).map((mod) => [mod.id, mod]));
    const parentById = new Map();
    const childrenByParent = new Map();
    const occupied = new Set(['0,0']);

    function setParent(child, parent) {
      if (!moduleById.has(child) || child === 'hub' || parentById.has(child)) return;
      parentById.set(child, parent);
      addChild(childrenByParent, parent, child);
    }

    for (const mod of scene.modules || []) {
      if (mod.parent) setParent(mod.id, mod.parent);
    }

    for (const edge of scene.edges || []) {
      const refs = edgeRefs(edge, moduleById);
      if (refs.from === 'hub' && moduleById.has(refs.to)) setParent(refs.to, 'hub');
      if (refs.to === 'hub' && moduleById.has(refs.from)) setParent(refs.from, 'hub');
    }

    for (const mod of scene.modules || []) {
      if (mod.id === 'hub' || parentById.has(mod.id)) continue;
      setParent(mod.id, 'hub');
    }

    const snapById = new Map();

    function placeChildren(parentId, parentRest, parentPreSnap, parentFinalSnap, depth) {
      if (depth > 1) return;
      const children = childrenByParent.get(parentId) || [];
      const usedFaces = new Set();

      for (const childId of children) {
        const child = moduleById.get(childId);
        if (!child) continue;
        const childRest = finalPosition(child);
        const vector = [
          childRest[0] - parentRest[0],
          childRest[1] - parentRest[1]
        ];
        const face = closestSnapFace(vector, usedFaces);
        const pre = [
          parentPreSnap[0] + SNAP_PRE_VECTORS[face][0],
          parentPreSnap[1] + SNAP_PRE_VECTORS[face][1]
        ];
        const snapped = [
          parentFinalSnap[0] + SNAP_FINAL_VECTORS[face][0],
          parentFinalSnap[1] + SNAP_FINAL_VECTORS[face][1]
        ];
        const key = snapped.join(',');
        if (occupied.has(key)) continue;
        occupied.add(key);
        snapById.set(childId, { pre, point: snapped, depth: depth + 1 });
        placeChildren(childId, childRest, pre, snapped, depth + 1);
      }
    }

    placeChildren('hub', [0, 0], [0, 0], [0, 0], 0);

    for (const mod of scene.modules || []) {
      if (mod.id === 'hub') {
        snapById.set(mod.id, { pre: finalPosition(mod), point: finalPosition(mod), depth: 0 });
      } else if (!snapById.has(mod.id)) {
        snapById.set(mod.id, { pre: finalPosition(mod), point: finalPosition(mod), depth: 1 });
      }
    }

    return snapById;
  }

  function ownIdleVector(mod) {
    const idleTarget = finalPosition(mod);
    const idleOrigin = mod.idleOrigin || [0, 0];
    const idleBase = [
      idleTarget[0] - idleOrigin[0],
      idleTarget[1] - idleOrigin[1]
    ];
    const idleLen = Math.sqrt(idleBase[0] * idleBase[0] + idleBase[1] * idleBase[1]) || 1;
    const idleStep = mod.idleStep || 7;
    return [
      idleBase[0] / idleLen * idleStep,
      idleBase[1] / idleLen * idleStep
    ];
  }

  function totalIdleVector(mod, moduleById, seen = new Set()) {
    const own = ownIdleVector(mod);
    if (!mod.parent || seen.has(mod.id)) return own;

    const parent = moduleById.get(mod.parent);
    if (!parent) return own;

    seen.add(mod.id);
    const inherited = totalIdleVector(parent, moduleById, seen);
    return [
      own[0] + inherited[0],
      own[1] + inherited[1]
    ];
  }

  function moduleIdleStart(mod) {
    if (!mod) return 0;
    return (mod.delay || 0) + (mod.move ? 1900 : 1050);
  }

  function groupRoot(mod, moduleById, seen = new Set()) {
    if (!mod || !mod.parent || seen.has(mod.id)) return mod;
    const parent = moduleById.get(mod.parent);
    if (!parent) return mod;
    seen.add(mod.id);
    return groupRoot(parent, moduleById, seen);
  }

  function subtreeIdleStart(mod, moduleById, seen = new Set()) {
    if (!mod || seen.has(mod.id)) return 0;
    seen.add(mod.id);
    let start = moduleIdleStart(mod);
    for (const candidate of moduleById.values()) {
      if (candidate.parent === mod.id) {
        start = Math.max(start, subtreeIdleStart(candidate, moduleById, seen));
      }
    }
    return start;
  }

  function groupIdleStart(mod, moduleById) {
    const root = groupRoot(mod, moduleById);
    return subtreeIdleStart(root, moduleById);
  }

  function escapeHTML(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function moduleVars(mod, moduleById, index, snapById) {
    const from = mod.from || [0, 0];
    const to = mod.to || [0, 0];
    const move = mod.move || null;
    const rest = finalPosition(mod);
    const snapInfo = snapById?.get(mod.id);
    const preSnap = snapInfo?.pre || rest;
    const snap = snapInfo?.point || rest;
    const idle = totalIdleVector(mod, moduleById || new Map());
    const overshoot = [
      to[0] + (to[0] - from[0]) * 0.08,
      to[1] + (to[1] - from[1]) * 0.08
    ];
    const vars = {
      '--module-color': mod.color || '#999',
      '--from-x': px(from[0]),
      '--from-y': px(from[1]),
      '--to-x': px(to[0]),
      '--to-y': px(to[1]),
      '--rest-x': px(rest[0]),
      '--rest-y': px(rest[1]),
      '--pre-snap-x': px(preSnap[0]),
      '--pre-snap-y': px(preSnap[1]),
      '--snap-x': px(snap[0]),
      '--snap-y': px(snap[1]),
      '--snap-delay': `${Math.max(0, ((snapInfo?.depth || 1) - 1) * SNAP_DEPTH_DELAY_MS)}ms`,
      '--overshoot-x': px(overshoot[0]),
      '--overshoot-y': px(overshoot[1]),
      '--idle-x': px(idle[0]),
      '--idle-y': px(idle[1]),
      '--idle-delay': `${groupIdleStart(mod, moduleById || new Map())}ms`,
      '--delay': `${mod.delay || 0}ms`,
      '--rot': mod.rot || '-10deg'
    };
    if (move) {
      vars['--move-x'] = px(move[0]);
      vars['--move-y'] = px(move[1]);
      vars['--move-rot'] = mod.moveRot || '8deg';
    }
    return styleVars(vars);
  }

  function pointForRef(ref, fallback, moduleById) {
    if (ref === 'hub') return [0, 0];
    if (ref && moduleById.has(ref)) return finalPosition(moduleById.get(ref));
    return fallback || [0, 0];
  }

  function snapPointForRef(ref, fallback, moduleById, snapById, key = 'point') {
    if (ref === 'hub') return [0, 0];
    if (ref && snapById?.has(ref)) return snapById.get(ref)[key] || snapById.get(ref).point;
    return pointForRef(ref, fallback, moduleById);
  }

  function snapDelayForRef(ref, snapById) {
    if (!ref || ref === 'hub') return 0;
    const snap = snapById?.get(ref);
    return Math.max(0, ((snap?.depth || 1) - 1) * SNAP_DEPTH_DELAY_MS);
  }

  function idleForRef(ref, moduleById) {
    if (!ref || ref === 'hub' || !moduleById.has(ref)) return [0, 0];
    return totalIdleVector(moduleById.get(ref), moduleById);
  }

  function idleStartForRef(ref, moduleById) {
    if (!ref || ref === 'hub' || !moduleById.has(ref)) return 0;
    return groupIdleStart(moduleById.get(ref), moduleById);
  }

  function lineShape(from, to) {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    return {
      x: px(from[0]),
      y: px(from[1]),
      length: px(length),
      angle: `${angle.toFixed(2)}deg`
    };
  }

  function collapsedLineShape(from, to) {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const inset = Math.min(SNAP_EDGE_INSET, (length - 1) / 2);
    const ux = dx / length;
    const uy = dy / length;
    return lineShape(
      [from[0] + ux * inset, from[1] + uy * inset],
      [to[0] - ux * inset, to[1] - uy * inset]
    );
  }

  function lineVars(edge, moduleById, snapById) {
    const refs = edgeRefs(edge, moduleById || new Map());
    const from = pointForRef(refs.from, edge.from, moduleById || new Map());
    const to = pointForRef(refs.to, edge.to, moduleById || new Map());
    const preSnapFrom = snapPointForRef(refs.from, edge.from, moduleById || new Map(), snapById || new Map(), 'pre');
    const preSnapTo = snapPointForRef(refs.to, edge.to, moduleById || new Map(), snapById || new Map(), 'pre');
    const snapFrom = snapPointForRef(refs.from, edge.from, moduleById || new Map(), snapById || new Map());
    const snapTo = snapPointForRef(refs.to, edge.to, moduleById || new Map(), snapById || new Map());
    const fromIdle = idleForRef(refs.from, moduleById || new Map());
    const toIdle = idleForRef(refs.to, moduleById || new Map());
    const linkedIdleStart = Math.max(
      idleStartForRef(refs.from, moduleById || new Map()),
      idleStartForRef(refs.to, moduleById || new Map())
    );
    const idleDelay = linkedIdleStart || ((edge.delay || 0) + 1500);
    const base = lineShape(from, to);
    const preSnap = lineShape(preSnapFrom, preSnapTo);
    const snap = collapsedLineShape(snapFrom, snapTo);
    const out = lineShape(
      [from[0] + fromIdle[0], from[1] + fromIdle[1]],
      [to[0] + toIdle[0], to[1] + toIdle[1]]
    );
    const inwards = lineShape(
      [from[0] - fromIdle[0], from[1] - fromIdle[1]],
      [to[0] - toIdle[0], to[1] - toIdle[1]]
    );
    return styleVars({
      '--x': base.x,
      '--y': base.y,
      '--line-length': base.length,
      '--angle': base.angle,
      '--pre-snap-x': preSnap.x,
      '--pre-snap-y': preSnap.y,
      '--pre-snap-line-length': preSnap.length,
      '--pre-snap-angle': preSnap.angle,
      '--snap-x': snap.x,
      '--snap-y': snap.y,
      '--snap-line-length': snap.length,
      '--snap-angle': snap.angle,
      '--snap-delay': `${Math.max(
        snapDelayForRef(refs.from, snapById || new Map()),
        snapDelayForRef(refs.to, snapById || new Map())
      )}ms`,
      '--x-out': out.x,
      '--y-out': out.y,
      '--line-length-out': out.length,
      '--angle-out': out.angle,
      '--x-in': inwards.x,
      '--y-in': inwards.y,
      '--line-length-in': inwards.length,
      '--angle-in': inwards.angle,
      '--line-color': edge.color || 'var(--accent)',
      '--delay': `${edge.delay || 0}ms`,
      '--line-idle-delay': `${idleDelay}ms`
    });
  }

  function chipVars(chip) {
    const at = chip.at || [0, 0];
    return styleVars({
      '--x': px(at[0]),
      '--y': px(at[1]),
      '--delay': `${chip.delay || 0}ms`
    });
  }

  function packetVars(packet) {
    const from = packet.from || [0, 0];
    const to = packet.to || [0, 0];
    return styleVars({
      '--from-x': px(from[0]),
      '--from-y': px(from[1]),
      '--to-x': px(to[0]),
      '--to-y': px(to[1]),
      '--delay': `${packet.delay || 0}ms`
    });
  }

  function renderBgHexes() {
    return HEX_BG.map(([x, y, r]) => (
      `<div class="scene-bg-hex" style="${styleVars({
        '--x': px(x),
        '--y': px(y),
        '--r': `${r}deg`
      })}"></div>`
    )).join('');
  }

  function renderModules(scene) {
    const moduleById = new Map((scene.modules || []).map((mod) => [mod.id, mod]));
    const snapById = snapMapFor(scene);
    return (scene.modules || []).map((mod, index) => {
      const classes = ['scene-module'];
      if (mod.move) classes.push('has-move');
      return `
        <div class="${classes.join(' ')}" style="${moduleVars(mod, moduleById, index, snapById)}">
          <span>${escapeHTML(mod.label)}<span class="uid">${escapeHTML(mod.uid)}</span></span>
        </div>
      `;
    }).join('');
  }

  function renderLines(scene) {
    const moduleById = new Map((scene.modules || []).map((mod) => [mod.id, mod]));
    const snapById = snapMapFor(scene);
    return (scene.edges || []).map((edge) => (
      `<div class="scene-line" style="${lineVars(edge, moduleById, snapById)}"><span class="scene-line-core"></span></div>`
    )).join('');
  }

  function renderChips(scene) {
    return (scene.chips || []).map((chip) => (
      `<div class="scene-chip" style="${chipVars(chip)}">
        ${escapeHTML(chip.label)}
        ${chip.sub ? `<small>${escapeHTML(chip.sub)}</small>` : ''}
      </div>`
    )).join('');
  }

  function renderPackets(scene) {
    return (scene.packets || []).map((packet) => (
      `<div class="scene-packet" style="${packetVars(packet)}">${escapeHTML(packet.label || 'ECA')}</div>`
    )).join('');
  }

  function moduleById(scene, id, fallback) {
    return (scene.modules || []).find((mod) => mod.id === id) || fallback;
  }

  function renderConfigLoopModule(scene, id, fallback) {
    const mod = moduleById(scene, id, fallback);
    return `
      <div class="config-loop-module config-loop-${escapeHTML(id)}" style="${styleVars({ '--module-color': mod.color })}">
        <span>${escapeHTML(mod.label)}<small>${escapeHTML(mod.uid)}</small></span>
      </div>
    `;
  }

  function renderConfigLoopScene(scene) {
    return `
      <div class="toy-scene config-loop-scene scene-kind-${escapeHTML(scene.kind || 'mini-config-loop')}">
        ${renderBgHexes()}
        <div class="config-loop-hub"><span>HUB</span></div>
        ${renderConfigLoopModule(scene, 'light', { label: 'Light', uid: 'LDR-41', color: '#c1b496' })}
        ${renderConfigLoopModule(scene, 'knob', { label: 'Knob', uid: 'KNB-12', color: '#98af6f' })}
        ${renderConfigLoopModule(scene, 'audio', { label: 'Audio', uid: 'AUD-77', color: '#9885bf' })}
        <svg class="config-loop-user" viewBox="0 0 240 96" aria-hidden="true" focusable="false">
          <g class="config-user-figure">
            <circle class="config-user-head" cx="16" cy="68" r="6"></circle>
            <path class="config-user-body" d="M5 91c4-14 18-14 22 0"></path>
          </g>
          <g class="config-user-arrow config-user-arrow-initial">
            <path class="config-user-arrow-line" d="M34 78C75 92 132 78 168 55C175 50 180 44 183 39"></path>
            <path class="config-user-arrow-head" d="M176 44l7-5 1 9"></path>
          </g>
          <g class="config-user-arrow config-user-arrow-moved">
            <path class="config-user-arrow-line" d="M34 78C58 86 86 69 96 50"></path>
            <path class="config-user-arrow-head" d="M90 54l6-4 1 7"></path>
          </g>
          <g class="config-user-arrow config-user-arrow-stacked">
            <path class="config-user-arrow-line" d="M34 78C55 92 87 76 98 52"></path>
            <path class="config-user-arrow-head" d="M92 56l6-4 1 7"></path>
          </g>
        </svg>
        <div class="config-loop-hint">UID follows module</div>
        <div class="config-loop-toast config-loop-toast-initial">configure once: interaction works</div>
        <div class="config-loop-toast config-loop-toast-change">topology changes: interaction stays</div>
        <div class="config-loop-toast config-loop-toast-stacked">stacked topology: still works</div>
      </div>
    `;
  }

  function renderAuthoringLoopScene(scene) {
    const light = moduleById(scene, 'light', { label: 'Light', uid: 'LDR-41', color: '#c1b496' });
    const knob = moduleById(scene, 'knob', { label: 'Knob', uid: 'KNB-12', color: '#98af6f' });
    const audio = moduleById(scene, 'audio', { label: 'Audio', uid: 'AUD-77', color: '#9885bf' });

    return `
      <div class="toy-scene author-loop-scene scene-kind-${escapeHTML(scene.kind || 'mini-authoring-loop')}">
        ${renderBgHexes()}
        <div class="author-live-schema">
          <strong>live schema</strong>
          <span style="${styleVars({ '--chip-color': light.color })}">${escapeHTML(light.uid)}</span>
          <span style="${styleVars({ '--chip-color': knob.color })}">${escapeHTML(knob.uid)}</span>
          <span style="${styleVars({ '--chip-color': audio.color })}">${escapeHTML(audio.uid)}</span>
        </div>
        <div class="author-llm-chat">
          <div class="author-chat-bar"><span></span><strong>LLM chat</strong></div>
          <div class="author-pass author-pass-before">
            <div class="author-msg author-msg-user author-msg-initial-prompt">make a light theremin knob shape the audio</div>
            <div class="author-msg author-msg-ai author-msg-initial-reply">updated based on modules <span class="author-module-chip" style="${styleVars({ '--chip-color': light.color })}">@${escapeHTML(light.uid)}</span> <span class="author-module-chip" style="${styleVars({ '--chip-color': knob.color })}">@${escapeHTML(knob.uid)}</span> <span class="author-module-chip" style="${styleVars({ '--chip-color': audio.color })}">@${escapeHTML(audio.uid)}</span></div>
          </div>
          <div class="author-pass author-pass-after">
            <div class="author-msg author-msg-user">gain instead of trim</div>
          </div>
        </div>
        <div class="author-flow-line author-flow-before"></div>
        <div class="author-flow-line author-flow-after"></div>
        <div class="author-blockly-panel">
          <div class="author-blockly-stack">
            <div class="author-block author-block-event" style="${styleVars({ '--block-color': light.color })}">
              when <span>@${escapeHTML(light.uid)}</span> changes
            </div>
            <div class="author-block author-block-action" style="${styleVars({ '--block-color': audio.color })}">
              set <span>@${escapeHTML(audio.uid)}</span> tone
            </div>
            <div class="author-block-value-slot">
              <div class="author-block author-block-value author-block-value-trim" style="${styleVars({ '--block-color': knob.color })}">
                trim with <span>@${escapeHTML(knob.uid)}</span>
              </div>
              <div class="author-block author-block-value author-block-value-gain" style="${styleVars({ '--block-color': knob.color })}">
                gain with <span>@${escapeHTML(knob.uid)}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="author-topology-arrow author-topology-arrow-before"></div>
        <div class="author-topology-arrow author-topology-arrow-after"></div>
        <div class="author-rule-packet author-rule-packet-before">ECA</div>
        <div class="author-rule-packet author-rule-packet-after">ECA</div>
        <div class="author-topology" aria-label="Reauthor topology">
          <div class="author-topo-hub"><span>HUB</span></div>
          <div class="author-topo-module author-topo-light" style="${styleVars({ '--module-color': light.color })}"><span>${escapeHTML(light.label)}<small>${escapeHTML(light.uid)}</small></span></div>
          <div class="author-topo-module author-topo-knob" style="${styleVars({ '--module-color': knob.color })}"><span>${escapeHTML(knob.label)}<small>${escapeHTML(knob.uid)}</small></span></div>
          <div class="author-topo-module author-topo-audio" style="${styleVars({ '--module-color': audio.color })}"><span>${escapeHTML(audio.label)}<small>${escapeHTML(audio.uid)}</small></span></div>
        </div>
        <div class="author-toast author-toast-before">Authoring with live schema<small>current UIDs become editable blocks</small></div>
        <div class="author-toast author-toast-after">reauthor after topology change<small>LLM and Blockly still target the same modules</small></div>
      </div>
    `;
  }

  function renderDeploymentLoopScene(scene) {
    const light = moduleById(scene, 'light', { label: 'Light', uid: 'LDR-41', color: '#c1b496' });
    const knob = moduleById(scene, 'knob', { label: 'Knob', uid: 'KNB-12', color: '#98af6f' });
    const audio = moduleById(scene, 'audio', { label: 'Audio', uid: 'AUD-77', color: '#9885bf' });

    return `
      <div class="toy-scene deploy-loop-scene scene-kind-${escapeHTML(scene.kind || 'mini-deployment-loop')}">
        ${renderBgHexes()}
        <div class="deploy-companion" aria-label="Companion Authoring Environment">
          <svg class="deploy-computer-svg" viewBox="0 0 96 92" aria-hidden="true" focusable="false">
            <rect class="deploy-computer-shell" x="10" y="8" width="76" height="62" rx="8"></rect>
            <rect class="deploy-computer-screen" x="17" y="15" width="62" height="48" rx="5"></rect>
            <rect class="deploy-program-card" x="24" y="23" width="48" height="30" rx="5"></rect>
            <circle class="deploy-program-dot deploy-program-dot-a" cx="31" cy="31" r="3"></circle>
            <circle class="deploy-program-dot deploy-program-dot-b" cx="31" cy="42" r="3"></circle>
            <path class="deploy-program-line deploy-program-line-a" d="M39 31H62"></path>
            <path class="deploy-program-line deploy-program-line-b" d="M39 42H57"></path>
            <path class="deploy-code-glyph" d="M30 51H65"></path>
            <path class="deploy-computer-neck" d="M40 70h16l4 12H36z"></path>
            <rect class="deploy-computer-base" x="27" y="81" width="42" height="6" rx="3"></rect>
          </svg>
        </div>
        <div class="deploy-visualization" aria-label="Runtime visualization">
          <div class="deploy-viz-bar"><strong>visualization</strong><span></span></div>
          <svg class="deploy-waveform" viewBox="0 0 92 34" aria-hidden="true" focusable="false">
            <path class="deploy-wave-path deploy-wave-sine" d="M4 17C12 3 22 3 30 17S48 31 56 17S74 3 88 17"></path>
            <path class="deploy-wave-path deploy-wave-square" d="M4 25H17V9H31V25H45V9H59V25H73V9H88"></path>
            <path class="deploy-wave-path deploy-wave-triangle" d="M4 25L18 9L32 25L46 9L60 25L74 9L88 25"></path>
            <path class="deploy-wave-path deploy-wave-saw" d="M4 25L25 9V25L46 9V25L67 9V25L88 9"></path>
          </svg>
          <div class="deploy-wave-name">
            <span class="deploy-wave-name-sine">sine</span>
            <span class="deploy-wave-name-square">square</span>
            <span class="deploy-wave-name-triangle">triangle</span>
            <span class="deploy-wave-name-saw">saw</span>
          </div>
        </div>
        <div class="deploy-module deploy-module-knob" style="${styleVars({ '--module-color': knob.color })}"><span>${escapeHTML(knob.label)}<small>${escapeHTML(knob.uid)}</small></span></div>
        <div class="deploy-module deploy-module-light" style="${styleVars({ '--module-color': light.color })}"><span>${escapeHTML(light.label)}<small>${escapeHTML(light.uid)}</small></span></div>
        <div class="deploy-module deploy-module-audio" style="${styleVars({ '--module-color': audio.color })}"><span>${escapeHTML(audio.label)}<small>${escapeHTML(audio.uid)}</small></span></div>
        <div class="deploy-hub"><span>HUB<small>UID map</small></span></div>
        <div class="deploy-packet deploy-packet-a" style="--packet-delay: 0.98s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-b" style="--packet-delay: 1.288s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-c" style="--packet-delay: 1.596s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-d" style="--packet-delay: 1.904s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-e" style="--packet-delay: 2.212s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-f" style="--packet-delay: 2.52s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-g" style="--packet-delay: 2.828s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-h" style="--packet-delay: 3.136s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-i" style="--packet-delay: 3.444s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-j" style="--packet-delay: 3.752s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-k" style="--packet-delay: 4.06s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-l" style="--packet-delay: 4.368s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-m" style="--packet-delay: 4.676s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-n" style="--packet-delay: 4.984s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-o" style="--packet-delay: 5.292s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-p" style="--packet-delay: 5.6s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-q" style="--packet-delay: 8.4s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-r" style="--packet-delay: 8.666s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-s" style="--packet-delay: 8.932s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-t" style="--packet-delay: 9.198s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-u" style="--packet-delay: 9.464s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-v" style="--packet-delay: 9.73s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-w" style="--packet-delay: 9.996s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-x" style="--packet-delay: 10.262s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-y" style="--packet-delay: 10.528s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-z" style="--packet-delay: 10.794s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-aa" style="--packet-delay: 11.06s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-ab" style="--packet-delay: 11.326s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-ac" style="--packet-delay: 11.592s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-ad" style="--packet-delay: 11.858s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-ae" style="--packet-delay: 12.124s">ECA: wave -> AUD</div>
        <div class="deploy-packet deploy-packet-af" style="--packet-delay: 12.39s">ECA: wave -> AUD</div>
        <div class="deploy-pulse deploy-pulse-a"></div>
        <div class="deploy-toast deploy-toast-runtime">immediate runtime update: no compile time<small>uploaded bytecode runs on the hub</small></div>
        <div class="deploy-toast deploy-toast-topology">UID-keyed update after topology change<small>same targets, new behavior; no compile delay</small></div>
      </div>
    `;
  }

  function mount(el, scene) {
    if (!el || !scene) return null;
    if (scene.kind === 'mini-config-loop') {
      el.innerHTML = renderConfigLoopScene(scene);
    } else if (scene.kind === 'mini-authoring-loop') {
      el.innerHTML = renderAuthoringLoopScene(scene);
    } else if (scene.kind === 'mini-deployment-loop') {
      el.innerHTML = renderDeploymentLoopScene(scene);
    } else {
      el.innerHTML = `
        <div class="toy-scene scene-kind-${escapeHTML(scene.kind || 'default')}">
          ${renderBgHexes()}
          ${renderLines(scene)}
          <div class="scene-hub"><span>HUB</span></div>
          ${renderModules(scene)}
          ${renderPackets(scene)}
          ${renderChips(scene)}
          ${(scene.modules || []).length ? '<button class="snap-button" type="button" aria-label="Snap modules to hub">Snap!</button>' : ''}
          ${scene.caption ? `<div class="scene-caption">${escapeHTML(scene.caption)}</div>` : ''}
        </div>
      `;
    }

    const toy = el.querySelector('.toy-scene');
    const snapButton = toy?.querySelector('.snap-button');
    let snapTimer = null;
    let returnTimer = null;
    let settleTimer = null;
    let breatheTimer = null;

    function clearSnapTimer() {
      if (!snapTimer) return;
      window.clearTimeout(snapTimer);
      snapTimer = null;
    }

    function clearReturnTimer() {
      if (!returnTimer) return;
      window.clearTimeout(returnTimer);
      returnTimer = null;
    }

    function clearSettleTimer() {
      if (!settleTimer) return;
      window.clearTimeout(settleTimer);
      settleTimer = null;
    }

    function clearBreatheTimer() {
      if (!breatheTimer) return;
      window.clearTimeout(breatheTimer);
      breatheTimer = null;
    }

    function clearFrozenPose() {
      if (!toy) return;
      toy.querySelectorAll('.scene-module, .scene-line').forEach((node) => {
        node.style.transition = '';
        node.style.transform = '';
        node.style.width = '';
      });
    }

    function freezeCurrentPose() {
      if (!toy) return;
      toy.querySelectorAll('.scene-module, .scene-line').forEach((node) => {
        const computed = window.getComputedStyle(node);
        node.style.transition = 'none';
        node.style.transform = computed.transform === 'none' ? '' : computed.transform;
        if (node.classList.contains('scene-line')) {
          node.style.width = computed.width;
        }
      });
      void toy.offsetWidth;
    }

    function animateReturnToRest() {
      if (!toy) return;
      toy.classList.add('is-returning');
      void toy.offsetWidth;
      window.requestAnimationFrame(() => {
        clearFrozenPose();
      });
    }

    function releaseSnap() {
      if (!toy) return;
      clearSnapTimer();
      clearReturnTimer();
      clearSettleTimer();
      clearBreatheTimer();
      clearFrozenPose();
      toy.classList.remove('is-snapped', 'is-pre-snapped', 'is-returning', 'is-breathing');
      toy.classList.add('is-released');
      if (snapButton) snapButton.disabled = false;
      breatheTimer = window.setTimeout(() => {
        breatheTimer = null;
        if (!toy || !toy.classList.contains('is-released')) return;
        toy.classList.remove('is-released');
        toy.classList.add('is-breathing');
      }, SNAP_BREATHE_RESUME_MS);
    }

    function resetSnap() {
      clearSnapTimer();
      clearReturnTimer();
      clearSettleTimer();
      clearBreatheTimer();
      if (!toy) return;
      clearFrozenPose();
      toy.classList.remove('is-snapped', 'is-pre-snapped', 'is-returning', 'is-released', 'is-breathing');
      if (snapButton) snapButton.disabled = false;
    }

    if (snapButton) {
      snapButton.addEventListener('click', () => {
        if (
          !toy ||
          toy.classList.contains('is-snapped') ||
          toy.classList.contains('is-pre-snapped') ||
          toy.classList.contains('is-returning')
        ) return;
        clearSnapTimer();
        clearReturnTimer();
        clearSettleTimer();
        clearBreatheTimer();
        freezeCurrentPose();
        toy.classList.remove('is-snapped', 'is-pre-snapped', 'is-released', 'is-breathing');
        animateReturnToRest();
        snapButton.disabled = true;
        returnTimer = window.setTimeout(() => {
          returnTimer = null;
          if (!toy) return;
          toy.classList.remove('is-returning');
          toy.classList.add('is-pre-snapped');
          settleTimer = window.setTimeout(() => {
            settleTimer = null;
            if (!toy) return;
            toy.classList.remove('is-pre-snapped');
            toy.classList.add('is-snapped');
            snapTimer = window.setTimeout(releaseSnap, SNAP_RELEASE_MS);
          }, SNAP_SETTLE_MS);
        }, SNAP_RETURN_MS);
      });
    }

    const api = {
      el,
      scene,
      play() {
        if (!toy) return;
        resetSnap();
        toy.classList.remove('is-playing');
        void toy.offsetWidth;
        toy.classList.add('is-playing');
      },
      pause() {
        resetSnap();
        if (toy) toy.classList.remove('is-playing');
      },
      reset() {
        if (!toy) return;
        resetSnap();
        toy.classList.remove('is-playing');
        void toy.offsetWidth;
      }
    };
    el.__hexScene = api;
    return api;
  }

  function mountAll(root, scenes) {
    const mounted = [];
    root.querySelectorAll('[data-scene-stage]').forEach((el) => {
      const name = el.getAttribute('data-scene-stage');
      const scene = scenes && scenes[name];
      const api = mount(el, scene);
      if (api) mounted.push(api);
    });
    return mounted;
  }

  function play(target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    const api = el && el.__hexScene;
    if (api) api.play();
  }

  function pause(target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    const api = el && el.__hexScene;
    if (api) api.pause();
  }

  function reset(target) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    const api = el && el.__hexScene;
    if (api) api.reset();
  }

  function pauseAll(root) {
    (root || document).querySelectorAll('[data-scene-stage]').forEach(pause);
  }

  window.HexScene = {
    mount,
    mountAll,
    play,
    pause,
    pauseAll,
    reset
  };
})();
