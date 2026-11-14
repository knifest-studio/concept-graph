import { useLayoutEffect, useState } from 'react';
import { applyThemePreference, readThemePreference } from './theme.mjs';
import { track } from './analytics.mjs';

export function useThemePreference() {
  const [theme, setTheme] = useState(() => readThemePreference(localStorage));
  useLayoutEffect(() => applyThemePreference(theme, {
    storage: localStorage, root: document.documentElement, media: window.matchMedia('(prefers-color-scheme: dark)'),
    onSystemChange: to => track('theme_changed', { to, source: 'system' })
  }), [theme]);
  return [theme, setTheme];
}
