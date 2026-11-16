import { migrateLegacyTheme, validTheme } from './src/theme.mjs';

// Personal shortcuts are checked for shape and size here; the page drops actions or keys it does not know when it reads them.
const shortcutBinding = /^(?:(?:Mod|Ctrl|Alt|Shift)\+){0,4}[A-Za-z0-9]{1,20}$/;
export const validShortcutPreferences = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2 && value.version === 1 && !!value.bindings && typeof value.bindings === 'object' && !Array.isArray(value.bindings)
  && Object.keys(value.bindings).length <= 64
  && Object.entries(value.bindings).every(([id, list]) => /^[a-z][\w.-]{0,40}$/.test(id) && Array.isArray(list) && list.length <= 4 && list.every(binding => typeof binding === 'string' && shortcutBinding.test(binding)));

export const validPreferences = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.hasOwn(value, 'theme') && Object.hasOwn(value, 'boardId') && Object.keys(value).every(key => ['theme', 'boardId', 'shortcuts'].includes(key))
  && validTheme(value.theme)
  && (value.boardId === null || (typeof value.boardId === 'string' && /^[\da-f-]{36}$/.test(value.boardId)))
  && (value.shortcuts === undefined || validShortcutPreferences(value.shortcuts));

// Only disk storage carries the version; the preferences API keeps its existing shape.
export function readDesktopPreferences(saved) {
  const { version, ...preferences } = saved || {};
  if ((version !== undefined && version !== 2) || !validPreferences(preferences)) throw new Error('Invalid preferences.');
  return version === 2 ? preferences : { ...preferences, theme: migrateLegacyTheme(preferences.theme) };
}
