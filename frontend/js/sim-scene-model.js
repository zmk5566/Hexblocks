/**
 * Pure scene projection for the HexBlocks 3D twin.
 *
 * The Python bridge remains the source of truth. This module only projects
 * its module/topology maps into deterministic positions that Three.js can
 * render. Keeping this file DOM-free makes the topology contract testable in
 * Node without WebGL.
 */

const TAU = Math.PI * 2;

export function faceAngle(face) {
  const normalized = Number.isFinite(Number(face))
    ? Math.max(1, Math.min(6, Number(face)))
    : 1;
  return ((normalized - 1) * TAU / 6) - (Math.PI / 3);
}

function moduleKey(module) {
  return module?.uid ?? (module?.slot != null ? `slot:${module.slot}` : null);
}

function childEntries(children, parentKey) {
  if (!(children instanceof Map)) return [];
  const faces = children.get(parentKey);
  return faces instanceof Map ? [...faces.entries()] : [];
}

function moduleForKey(modulesByKey, key) {
  if (modulesByKey.has(key)) return modulesByKey.get(key);
  if (typeof key === 'number') return modulesByKey.get(`slot:${key}`);
  return null;
}

/**
 * Project live modules into a flat-topped 3D workbench layout.
 *
 * `rotation` is the world-space direction of a module's local face 1.
 * Root modules point face 1 back toward the hub; stacked children point face
 * 1 toward their parent. That is the same convention used by the SVG topology.
 */
export function buildSceneLayout(modules = [], children = new Map(), spacing = 2.42) {
  const modulesByKey = new Map();
  for (const module of modules) {
    const key = moduleKey(module);
    if (key != null) modulesByKey.set(key, module);
  }

  const items = [];
  const edges = [];
  const visited = new Set();

  const placeChildren = (parentKey, parentItem) => {
    for (const [face, childKey] of childEntries(children, parentKey)) {
      if (childKey == null) continue;
      const child = moduleForKey(modulesByKey, childKey);
      if (!child) continue;
      const key = moduleKey(child);
      if (key == null || visited.has(key)) continue;
      const direction = parentItem.rotation + ((Number(face) - 1) * TAU / 6);
      const item = {
        key,
        module: child,
        x: parentItem.x + Math.cos(direction) * spacing,
        z: parentItem.z + Math.sin(direction) * spacing,
        rotation: direction + Math.PI,
        depth: parentItem.depth + 1,
        parentKey,
        parentFace: Number(face),
      };
      visited.add(key);
      items.push(item);
      edges.push({ from: parentKey, to: key });
      placeChildren(key, item);
    }
  };

  const roots = modules.filter(module => module.parent_is_hub !== false
    && Number(module.parent_face ?? module.face) > 0);
  for (const module of roots) {
    const key = moduleKey(module);
    if (key == null || visited.has(key)) continue;
    const face = Number(module.parent_face ?? module.face);
    const direction = faceAngle(face);
    const item = {
      key,
      module,
      x: Math.cos(direction) * spacing,
      z: Math.sin(direction) * spacing,
      rotation: direction + Math.PI,
      depth: 1,
      parentKey: 'HUB',
      parentFace: face,
    };
    visited.add(key);
    items.push(item);
    edges.push({ from: 'HUB', to: key });
    placeChildren(key, item);
  }

  // A partial topology snapshot may temporarily leave modules unattached.
  // Keep them visible on a deterministic inspection rail instead of silently
  // dropping them from the scene.
  const orphans = modules.filter(module => {
    const key = moduleKey(module);
    return key != null && !visited.has(key);
  });
  const railX = -5.8;
  const railStartZ = -((orphans.length - 1) * 1.35) / 2;
  orphans.forEach((module, index) => {
    const key = moduleKey(module);
    visited.add(key);
    items.push({
      key,
      module,
      x: railX,
      z: railStartZ + index * 1.35,
      rotation: 0,
      depth: 0,
      parentKey: null,
      parentFace: 0,
      orphan: true,
    });
  });

  return { items, edges };
}

export function stateForModule(module, sensorByUid, actuatorByUid) {
  const key = moduleKey(module);
  const slotKey = module?.slot != null ? `slot:${module.slot}` : null;
  const sensor = sensorByUid instanceof Map
    ? sensorByUid.get(key) ?? sensorByUid.get(module?.slot) ?? sensorByUid.get(slotKey)
    : null;
  const actuator = actuatorByUid instanceof Map
    ? actuatorByUid.get(key) ?? actuatorByUid.get(module?.slot) ?? actuatorByUid.get(slotKey)
    : null;
  return { sensor: sensor ?? null, actuator: actuator ?? null };
}

export function moduleRole(module) {
  const tokens = [
    module?.id,
    module?.name,
    module?.descriptor?.type,
    ...(Array.isArray(module?.capabilities) ? module.capabilities : []),
  ].filter(Boolean).join(' ').toLowerCase();
  if (tokens.includes('led') || tokens.includes('light output')) return 'led';
  if (tokens.includes('motor')) return 'motor';
  if (tokens.includes('vib') || tokens.includes('haptic')) return 'vibration';
  if (tokens.includes('audio') || tokens.includes('speaker')) return 'audio';
  if (tokens.includes('imu') || tokens.includes('motion')) return 'imu';
  return 'generic';
}
