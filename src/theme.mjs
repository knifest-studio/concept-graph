export const themePreferenceKey = 'concept-graph-theme-v2';
export const validTheme = value => ['light', 'dark', 'system'].includes(value);
export const migrateLegacyTheme = value => value === 'dark' ? 'dark' : 'system';

export function readThemePreference(storage) {
  try {
    const saved = storage.getItem(themePreferenceKey);
    return validTheme(saved) ? saved : migrateLegacyTheme(storage.getItem('concept-graph-theme'));
  } catch { return 'system'; }
}

export function applyThemePreference(theme, { storage, root, media, onSystemChange }) {
  try { storage.setItem(themePreferenceKey, theme); } catch {}
  const update = () => { root.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
  update();
  if (theme !== 'system') return () => {};
  const changed = () => { const before = root.dataset.theme; update(); if (before !== root.dataset.theme) onSystemChange?.(root.dataset.theme); };
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
}
