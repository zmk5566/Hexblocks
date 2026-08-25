/**
 * <wb-sim-stage> — Three.js digital twin for live HexBlocks topology.
 *
 * This component is deliberately a projection, not a simulator. Module,
 * sensor, topology, and actuator state all come from wb-app's existing bridge
 * state so the same view works with --sim and with physical hardware.
 */
import { LitElement, html, css } from 'lit';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import {
  buildSceneLayout,
  moduleRole,
  stateForModule,
} from '../sim-scene-model.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function colorFrom(value, fallback = '#7d8791') {
  try {
    return new THREE.Color(value || fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}

function labelSprite(text, accent) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(8, 13, 16, .82)';
  context.fillRect(0, 10, canvas.width, 100);
  context.strokeStyle = accent;
  context.lineWidth = 5;
  context.strokeRect(2.5, 12.5, canvas.width - 5, 95);
  context.fillStyle = '#edf3ee';
  context.font = '600 38px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(text).slice(0, 22), canvas.width / 2, 61);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.05, 0.51, 1);
  sprite.position.y = 0.78;
  return sprite;
}

function disposeTree(root) {
  root.traverse(object => {
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      material.map?.dispose?.();
      material.dispose?.();
    }
  });
}

export class WbSimStage extends LitElement {
  static properties = {
    open:          { type: Boolean, reflect: true },
    modules:       { type: Array },
    children:      { type: Object },
    sensorByUid:   { type: Object },
    actuatorByUid: { type: Object },
    highlightedUid:{ type: String },
    _selectedKey:  { type: String, state: true },
  };

  static styles = css`
    :host {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 1200;
      color: #e8eee9;
      font-family: var(--wb-mono, ui-monospace, monospace);
      background: rgba(3, 7, 9, .82);
      backdrop-filter: blur(12px);
    }
    :host([open]) { display: block; }

    .shell {
      position: absolute;
      inset: 22px;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      overflow: hidden;
      background: #0b1114;
      border: 1px solid #637068;
      box-shadow: 0 30px 90px rgba(0, 0, 0, .55);
    }

    header {
      min-height: 58px;
      display: grid;
      grid-template-columns: 1fr auto auto;
      align-items: center;
      gap: 18px;
      padding: 0 18px;
      border-bottom: 1px solid #303b37;
      background:
        linear-gradient(90deg, rgba(178, 255, 111, .07), transparent 36%),
        #10181b;
    }
    .title { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
    h2 {
      margin: 0;
      color: #f1f5ee;
      font-family: 'Arial Narrow', 'Avenir Next Condensed', sans-serif;
      font-size: 1.05rem;
      letter-spacing: .16em;
      text-transform: uppercase;
    }
    .subtitle, .metric {
      color: #87948d;
      font-size: .66rem;
      letter-spacing: .06em;
    }
    .live {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      color: #b2ff6f;
      font-size: .68rem;
      letter-spacing: .1em;
    }
    .live::before {
      content: '';
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #b2ff6f;
      box-shadow: 0 0 12px rgba(178, 255, 111, .8);
    }
    button {
      border: 1px solid #46534c;
      background: transparent;
      color: #aeb9b1;
      font: inherit;
      font-size: .68rem;
      letter-spacing: .06em;
      padding: 7px 11px;
      cursor: pointer;
    }
    button:hover, button:focus-visible {
      color: #101510;
      border-color: #b2ff6f;
      background: #b2ff6f;
      outline: none;
    }

    .body {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 300px;
      min-height: 0;
    }
    .viewport-wrap {
      position: relative;
      min-width: 0;
      overflow: hidden;
      background:
        radial-gradient(circle at 48% 40%, rgba(54, 76, 68, .27), transparent 40%),
        linear-gradient(135deg, #101719 0%, #070b0d 72%);
    }
    .viewport { position: absolute; inset: 0; }
    .viewport canvas { display: block; width: 100%; height: 100%; }
    .legend {
      position: absolute;
      left: 18px;
      bottom: 16px;
      display: flex;
      gap: 14px;
      color: #738079;
      font-size: .62rem;
      pointer-events: none;
    }
    .legend span::before {
      content: '';
      display: inline-block;
      width: 8px;
      height: 8px;
      margin-right: 6px;
      border: 1px solid #66736c;
      vertical-align: -1px;
    }
    .legend .applied::before { background: #b2ff6f; border-color: #b2ff6f; }
    .legend .orphan::before { border-style: dashed; }
    .hint {
      position: absolute;
      right: 18px;
      bottom: 16px;
      color: #657169;
      font-size: .62rem;
      pointer-events: none;
    }

    aside {
      min-width: 0;
      overflow: auto;
      border-left: 1px solid #303b37;
      background: #0e1518;
    }
    .inspector-empty {
      min-height: 100%;
      display: grid;
      place-content: center;
      padding: 24px;
      color: #69766f;
      font-size: .7rem;
      line-height: 1.7;
      text-align: center;
    }
    .inspector { padding: 18px; }
    .eyebrow {
      color: #b2ff6f;
      font-size: .62rem;
      letter-spacing: .14em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    h3 {
      margin: 0 0 4px;
      font-family: 'Arial Narrow', 'Avenir Next Condensed', sans-serif;
      font-size: 1.35rem;
      font-weight: 600;
      letter-spacing: .04em;
    }
    .uid { color: #77847d; font-size: .68rem; margin-bottom: 18px; }
    dl { margin: 0; }
    .row {
      display: grid;
      grid-template-columns: 86px minmax(0, 1fr);
      gap: 10px;
      padding: 9px 0;
      border-top: 1px solid #26312d;
      font-size: .68rem;
    }
    dt { color: #748179; }
    dd { margin: 0; color: #d5ddd7; overflow-wrap: anywhere; }
    .caps { display: flex; flex-wrap: wrap; gap: 5px; margin: 14px 0 18px; }
    .cap {
      padding: 3px 6px;
      color: #b2ff6f;
      border: 1px solid #40513f;
      font-size: .58rem;
      text-transform: uppercase;
    }
    pre {
      margin: 0;
      color: #b8c3bc;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: inherit;
      line-height: 1.55;
    }
    .open-data { width: 100%; margin-top: 18px; }

    @media (max-width: 760px) {
      .shell { inset: 8px; }
      .body { grid-template-columns: 1fr; grid-template-rows: minmax(300px, 1fr) 220px; }
      aside { border-left: 0; border-top: 1px solid #303b37; }
      .subtitle, .metric { display: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      :host { backdrop-filter: none; }
    }
  `;

  constructor() {
    super();
    this.open = false;
    this.modules = [];
    this.children = new Map();
    this.sensorByUid = new Map();
    this.actuatorByUid = new Map();
    this.highlightedUid = '';
    this._selectedKey = '';
    this._moduleGroups = new Map();
    this._renderFrame = 0;
    this._pointerDown = this._pointerDown.bind(this);
    this._animate = this._animate.bind(this);
  }

  updated(changed) {
    if (changed.has('open') && this.open && !this._renderer) this._startScene();
    if (!this.open || !this._renderer) return;
    const structuralChange = changed.has('open')
      || changed.has('modules')
      || changed.has('children')
      || changed.has('highlightedUid')
      || changed.has('_selectedKey');
    if (structuralChange) this._syncScene();
    else this._updateDynamicState();
  }

  disconnectedCallback() {
    this._stopScene();
    super.disconnectedCallback();
  }

  _close() {
    this.open = false;
    this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
  }

  _startScene() {
    const viewport = this.renderRoot.querySelector('.viewport');
    if (!viewport) return;
    this._scene = new THREE.Scene();
    this._scene.background = new THREE.Color('#080d0f');
    this._camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this._camera.position.set(8.5, 11.5, 12.5);

    this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this._renderer.outputColorSpace = THREE.SRGBColorSpace;
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    viewport.append(this._renderer.domElement);

    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.075;
    this._controls.minDistance = 5;
    this._controls.maxDistance = 30;
    this._controls.maxPolarAngle = Math.PI * 0.48;
    this._controls.target.set(0, 0, 0);

    this._scene.add(new THREE.HemisphereLight('#d8f0e2', '#17201d', 2.1));
    const keyLight = new THREE.DirectionalLight('#e9fff2', 3.2);
    keyLight.position.set(5, 12, 7);
    keyLight.castShadow = true;
    this._scene.add(keyLight);
    const edgeLight = new THREE.PointLight('#b2ff6f', 2.4, 18);
    edgeLight.position.set(-6, 4, -3);
    this._scene.add(edgeLight);

    const bench = new THREE.Mesh(
      new THREE.PlaneGeometry(32, 24),
      new THREE.MeshStandardMaterial({ color: '#101719', roughness: 0.93, metalness: 0.08 }),
    );
    bench.rotation.x = -Math.PI / 2;
    bench.position.y = -0.25;
    bench.receiveShadow = true;
    this._scene.add(bench);

    const grid = new THREE.GridHelper(30, 30, '#34433b', '#1e2924');
    grid.position.y = -0.235;
    this._scene.add(grid);

    this._rig = new THREE.Group();
    this._scene.add(this._rig);
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._renderer.domElement.addEventListener('pointerdown', this._pointerDown);
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(viewport);
    this._resize();
    this._animate();
  }

  _stopScene() {
    cancelAnimationFrame(this._renderFrame);
    this._resizeObserver?.disconnect();
    this._renderer?.domElement?.removeEventListener('pointerdown', this._pointerDown);
    this._controls?.dispose();
    if (this._rig) disposeTree(this._rig);
    this._renderer?.dispose();
    this._renderer?.domElement?.remove();
    this._renderer = null;
    this._scene = null;
    this._rig = null;
    this._moduleGroups.clear();
  }

  _resize() {
    const viewport = this.renderRoot.querySelector('.viewport');
    if (!viewport || !this._renderer) return;
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    this._renderer.setSize(width, height, false);
    this._camera.aspect = width / height;
    this._camera.updateProjectionMatrix();
  }

  _hubGroup() {
    const group = new THREE.Group();
    group.userData.key = 'HUB';
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.15, 0.46, 6),
      new THREE.MeshStandardMaterial({ color: '#848f89', roughness: 0.48, metalness: 0.42 }),
    );
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    const inset = new THREE.Mesh(
      new THREE.CylinderGeometry(0.86, 0.86, 0.475, 6),
      new THREE.MeshStandardMaterial({ color: '#18211e', roughness: 0.72, metalness: 0.18 }),
    );
    group.add(inset);
    group.add(labelSprite('HUB', '#b2ff6f'));
    return group;
  }

  _moduleGroup(item) {
    const { module } = item;
    const state = stateForModule(module, this.sensorByUid, this.actuatorByUid);
    const role = moduleRole(module);
    const accent = colorFrom(module.color).getStyle();
    const group = new THREE.Group();
    group.position.set(item.x, 0, item.z);
    group.rotation.y = -item.rotation;
    group.userData = {
      key: item.key,
      module,
      state,
      baseX: item.x,
      baseZ: item.z,
      vibration: Number(state.actuator?.vib?.intensity || 0),
      role,
    };

    const bandMaterial = new THREE.MeshStandardMaterial({
      color: item.orphan ? '#4c5550' : accent,
      roughness: 0.58,
      metalness: 0.22,
      transparent: !!item.orphan,
      opacity: item.orphan ? 0.52 : 1,
    });
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.38, 6), bandMaterial);
    band.castShadow = true;
    band.receiveShadow = true;
    band.userData.moduleKey = item.key;
    group.add(band);

    const led = state.actuator?.led || {};
    const ledOn = led.mode !== 'off'
      && (Number(led.brightness) > 0 || Number(led.r) + Number(led.g) + Number(led.b) > 0);
    const ledColor = new THREE.Color(
      clamp(Number(led.r) || 0, 0, 255) / 255,
      clamp(Number(led.g) || 0, 0, 255) / 255,
      clamp(Number(led.b) || 0, 0, 255) / 255,
    );
    const topMaterial = new THREE.MeshStandardMaterial({
      color: role === 'led' && ledOn ? ledColor : '#17201d',
      emissive: role === 'led' && ledOn ? ledColor : '#000000',
      emissiveIntensity: role === 'led' && ledOn
        ? 0.5 + clamp(Number(led.brightness) || 30, 0, 100) / 48
        : 0,
      roughness: role === 'led' ? 0.32 : 0.72,
      metalness: 0.12,
    });
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 0.405, 6), topMaterial);
    top.userData.moduleKey = item.key;
    group.add(top);
    group.userData.topMaterial = topMaterial;

    if (this._selectedKey === item.key || this.highlightedUid === item.key) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.16, 0.035, 8, 48),
        new THREE.MeshBasicMaterial({ color: '#b2ff6f' }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.27;
      group.add(ring);
    }

    const label = module.name || module.id || item.key;
    group.add(labelSprite(label, accent));
    return group;
  }

  _applyActuatorState(group, actuator) {
    const material = group.userData.topMaterial;
    const role = group.userData.role;
    if (!material) return;
    group.userData.vibration = Number(actuator?.vib?.intensity || 0);
    const led = actuator?.led || {};
    const ledOn = role === 'led'
      && led.mode !== 'off'
      && (Number(led.brightness) > 0 || Number(led.r) + Number(led.g) + Number(led.b) > 0);
    if (ledOn) {
      const color = new THREE.Color(
        clamp(Number(led.r) || 0, 0, 255) / 255,
        clamp(Number(led.g) || 0, 0, 255) / 255,
        clamp(Number(led.b) || 0, 0, 255) / 255,
      );
      material.color.copy(color);
      material.emissive.copy(color);
      material.emissiveIntensity = 0.5 + clamp(Number(led.brightness) || 30, 0, 100) / 48;
      material.roughness = 0.32;
    } else {
      material.color.set('#17201d');
      material.emissive.set('#000000');
      material.emissiveIntensity = 0;
      material.roughness = role === 'led' ? 0.32 : 0.72;
    }
    material.needsUpdate = true;
  }

  _updateDynamicState() {
    for (const [key, group] of this._moduleGroups) {
      if (key === 'HUB') continue;
      const module = group.userData.module;
      const state = stateForModule(module, this.sensorByUid, this.actuatorByUid);
      group.userData.state = state;
      this._applyActuatorState(group, state.actuator);
    }

    const imuGroup = [...this._moduleGroups.values()]
      .find(group => group.userData.role === 'imu');
    const ax = Number(imuGroup?.userData.state?.sensor?.data?.ax || 0);
    const ay = Number(imuGroup?.userData.state?.sensor?.data?.ay || 0);
    this._rig.rotation.x = clamp(ax * 0.08, -0.12, 0.12);
    this._rig.rotation.z = clamp(-ay * 0.08, -0.12, 0.12);
  }

  _syncScene() {
    if (!this._rig) return;
    for (const child of [...this._rig.children]) {
      this._rig.remove(child);
      disposeTree(child);
    }
    this._moduleGroups.clear();

    const layout = buildSceneLayout(this.modules, this.children);
    const hub = this._hubGroup();
    this._rig.add(hub);
    this._moduleGroups.set('HUB', hub);
    for (const item of layout.items) {
      const group = this._moduleGroup(item);
      this._rig.add(group);
      this._moduleGroups.set(item.key, group);
    }

    const positions = new Map([['HUB', new THREE.Vector3(0, 0.02, 0)]]);
    for (const item of layout.items) positions.set(item.key, new THREE.Vector3(item.x, 0.02, item.z));
    for (const edge of layout.edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) continue;
      const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
      const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: '#536159' }));
      this._rig.add(line);
    }

    this._updateDynamicState();
  }

  _pointerDown(event) {
    const rect = this._renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointer, this._camera);
    const hit = this._raycaster.intersectObjects([...this._moduleGroups.values()], true)
      .find(entry => entry.object.userData.moduleKey);
    if (!hit) return;
    this._selectedKey = hit.object.userData.moduleKey;
    this.dispatchEvent(new CustomEvent('highlight-module', {
      detail: { uid: this._selectedKey },
      bubbles: true,
      composed: true,
    }));
  }

  _animate(time = 0) {
    if (!this._renderer) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    for (const group of this._moduleGroups.values()) {
      const intensity = reduceMotion ? 0 : Number(group.userData.vibration || 0);
      if (intensity > 0) {
        const amplitude = clamp(intensity / 100, 0, 1) * 0.055;
        group.position.x = group.userData.baseX + Math.sin(time * 0.09) * amplitude;
        group.position.z = group.userData.baseZ + Math.cos(time * 0.13) * amplitude;
      } else if (Number.isFinite(group.userData.baseX)) {
        group.position.x = group.userData.baseX;
        group.position.z = group.userData.baseZ;
      }
    }
    this._controls?.update();
    this._renderer.render(this._scene, this._camera);
    this._renderFrame = requestAnimationFrame(this._animate);
  }

  _selectedModule() {
    return this.modules.find(module => (module.uid ?? `slot:${module.slot}`) === this._selectedKey) || null;
  }

  _openData(module) {
    this.dispatchEvent(new CustomEvent('open-panel', {
      detail: { uid: module.uid, slot: module.slot },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    const selected = this._selectedModule();
    const state = selected
      ? stateForModule(selected, this.sensorByUid, this.actuatorByUid)
      : { sensor: null, actuator: null };
    return html`
      <div class="shell" role="dialog" aria-modal="true" aria-label="HexBlocks 3D digital twin">
        <header>
          <div class="title">
            <h2>HexBlocks Spatial Twin</h2>
            <span class="subtitle">Bridge state rendered in three dimensions</span>
          </div>
          <span class="live">LIVE PROJECTION</span>
          <button @click=${this._close} aria-label="Close 3D twin">Close ×</button>
        </header>
        <div class="body">
          <div class="viewport-wrap">
            <div class="viewport"></div>
            <div class="legend">
              <span class="applied">actuator applied</span>
              <span class="orphan">unresolved topology</span>
              <span>${this.modules.length} modules</span>
            </div>
            <div class="hint">drag to orbit · wheel to zoom · click a module</div>
          </div>
          <aside>
            ${selected ? html`
              <div class="inspector">
                <div class="eyebrow">${moduleRole(selected)} module</div>
                <h3>${selected.name || selected.id || 'Unnamed module'}</h3>
                <div class="uid">${selected.uid || `slot:${selected.slot}`}</div>
                <div class="caps">
                  ${(selected.capabilities || []).map(cap => html`<span class="cap">${cap}</span>`)}
                </div>
                <dl>
                  <div class="row"><dt>attachment</dt><dd>${selected.parent_is_hub === false ? selected.parent_uid : 'HUB'}.F${selected.parent_face || selected.face || '?'}</dd></div>
                  <div class="row"><dt>sensor</dt><dd><pre>${state.sensor ? JSON.stringify(state.sensor.data || {}, null, 2) : 'no live values'}</pre></dd></div>
                  <div class="row"><dt>actuator</dt><dd><pre>${state.actuator ? JSON.stringify(state.actuator, null, 2) : 'no applied state'}</pre></dd></div>
                </dl>
                <button class="open-data" @click=${() => this._openData(selected)}>Open signal panel</button>
              </div>
            ` : html`
              <div class="inspector-empty">
                SELECT A MODULE<br>
                Inspect live sensor values and applied actuator state.
              </div>
            `}
          </aside>
        </div>
      </div>
    `;
  }
}

customElements.define('wb-sim-stage', WbSimStage);
