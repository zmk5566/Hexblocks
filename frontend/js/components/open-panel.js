/**
 * Shared open-panel event helper.
 *
 * Used by every component that lets the user "view" a module (palette
 * card click, canvas module click, ...). Centralising the dispatch
 * keeps the event shape consistent and the wb-app handler single-path.
 *
 * The detail carries both identities — `uid` is preferred (stable
 * across re-attaches), `slot` is the legacy fallback for the sim path
 * where a uid may not exist.
 */
export function dispatchOpenPanel(target, mod) {
  target.dispatchEvent(new CustomEvent('open-panel', {
    detail: { uid: mod?.uid ?? null, slot: mod?.slot ?? null },
    bubbles: true,
    composed: true,
  }));
}
