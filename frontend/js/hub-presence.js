/**
 * A WebSocket only proves that the browser can reach the bridge. A Hub is
 * visible when hardware transport is active, or when the simulator has
 * attached at least one module.
 */
export function hasHubPresence(transport, modules = []) {
  return !!transport?.connected || modules.length > 0;
}

/** A disconnected hardware transport invalidates every Hub-owned module. */
export function modulesAfterTransportStatus(modules = [], status = {}) {
  return status.connected === false ? [] : modules;
}
