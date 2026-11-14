import { migrateLegacyTheme, validTheme } from './src/theme.mjs';

export const validPreferences = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2 && Object.keys(value).every(key => ['theme', 'boardId'].includes(key))
  && validTheme(value.theme)
  && (value.boardId === null || (typeof value.boardId === 'string' && /^[\da-f-]{36}$/.test(value.boardId)));

// Only disk storage carries the version; the preferences API keeps its existing shape.
export function readDesktopPreferences(saved) {
  const { version, ...preferences } = saved || {};
  if ((version !== undefined && version !== 2) || !validPreferences(preferences)) throw new Error('Invalid preferences.');
  return version === 2 ? preferences : { ...preferences, theme: migrateLegacyTheme(preferences.theme) };
}
