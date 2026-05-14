// Theme controller — single source of truth for light/dark theme.
// Loaded as a classic script BEFORE component modules so the html
// data-theme attribute is set before any component renders (no flash).

(function () {
  const STORAGE_KEY = 'wb-theme';
  const VALID = new Set(['light', 'dark']);
  const root = document.documentElement;

  function read() {
    const v = localStorage.getItem(STORAGE_KEY);
    return VALID.has(v) ? v : 'light';
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
  }

  function set(theme) {
    if (!VALID.has(theme)) return;
    apply(theme);
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (_) {}
    window.dispatchEvent(new CustomEvent('wb-theme-change', { detail: { theme } }));
  }

  function toggle() {
    set(current() === 'dark' ? 'light' : 'dark');
  }

  function current() {
    return root.getAttribute('data-theme') || 'light';
  }

  // Read CSS variables from :root. Returns trimmed strings or fallbacks.
  function getThemeColors() {
    const cs = getComputedStyle(root);
    const get = (name, fallback) => {
      const v = cs.getPropertyValue(name).trim();
      return v || fallback;
    };
    return {
      bg:       get('--wb-bg',       '#ffffff'),
      surface:  get('--wb-surface',  '#f7f8fa'),
      surface2: get('--wb-surface-2', '#eef1f6'),
      text:     get('--wb-text',     '#1a1a2e'),
      textDim:  get('--wb-text-dim', '#5b6478'),
      accent:   get('--wb-accent',   '#0a8f7a'),
      border:   get('--wb-border',   '#d6dbe4'),
      danger:   get('--wb-danger',   '#c0392b'),
    };
  }

  apply(read());

  window.themeController = { current, set, toggle, getThemeColors };
})();
