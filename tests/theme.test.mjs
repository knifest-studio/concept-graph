import test from 'node:test';
import assert from 'node:assert/strict';
import { applyThemePreference, readThemePreference, themePreferenceKey } from '../src/theme.mjs';
import { readDesktopPreferences, validPreferences } from '../desktop-preferences.mjs';

const storage = entries => {
  const values = new Map(entries);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test('new and legacy Light users follow the system; Dark and later explicit choices survive', () => {
  assert.equal(readThemePreference(storage()), 'system');
  assert.equal(readThemePreference(storage([['concept-graph-theme', 'light']])), 'system');
  assert.equal(readThemePreference(storage([['concept-graph-theme', 'dark']])), 'dark');
  for (const theme of ['light', 'dark', 'system']) {
    assert.equal(readThemePreference(storage([['concept-graph-theme', 'dark'], [themePreferenceKey, theme]])), theme);
  }
  assert.equal(readThemePreference({ getItem() { throw Error('denied'); } }), 'system');
});

test('System updates the effective CSS theme live and unsubscribes; explicit Light ignores OS changes', () => {
  const listeners = new Set(), root = { dataset: {} }, saved = storage([['concept-graph-theme', 'light']]);
  const media = { matches: true, addEventListener: (name, fn) => { assert.equal(name, 'change'); listeners.add(fn); }, removeEventListener: (name, fn) => listeners.delete(fn) };
  const stop = applyThemePreference('system', { storage: saved, root, media });
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(saved.getItem(themePreferenceKey), 'system');
  media.matches = false; for (const fn of listeners) fn();
  assert.equal(root.dataset.theme, 'light');
  stop(); assert.equal(listeners.size, 0);
  applyThemePreference('light', { storage: saved, root, media });
  media.matches = true; for (const fn of listeners) fn();
  assert.equal(root.dataset.theme, 'light');
  assert.equal(readThemePreference(saved), 'light');
  assert.doesNotThrow(() => applyThemePreference('dark', { storage: { setItem() { throw Error('denied'); } }, root, media }));
  assert.equal(root.dataset.theme, 'dark');
});

test('system change reporting fires only on real OS-driven changes, never initialization or an explicit theme', () => {
  const root = { dataset: {} }, listeners = new Set(), reported = [];
  const media = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  const options = { storage: storage(), root, media, onSystemChange: to => reported.push(to) };
  const stop = applyThemePreference('system', options);
  assert.deepEqual(reported, []);
  media.matches = true; for (const fn of listeners) fn();
  for (const fn of listeners) fn();
  assert.deepEqual(reported, ['dark']);
  media.matches = false; for (const fn of listeners) fn();
  assert.deepEqual(reported, ['dark', 'light']);
  stop(); applyThemePreference('dark', options);
  media.matches = true; for (const fn of listeners) fn();
  assert.deepEqual(reported, ['dark', 'light']);
});

test('desktop validation accepts all three themes and rejects malformed preferences', () => {
  const boardId = '00000000-0000-0000-0000-000000000001';
  for (const theme of ['light', 'dark', 'system']) assert.ok(validPreferences({ theme, boardId }));
  for (const value of [null, [], {}, { theme: 'blue', boardId }, { theme: 'system', boardId: 'bad' }, { theme: 'light', boardId, extra: true }]) assert.ok(!validPreferences(value));
});

test('desktop disk migration is one-time and preserves the remembered board', () => {
  const boardId = '00000000-0000-0000-0000-000000000001';
  assert.deepEqual(readDesktopPreferences({ theme: 'light', boardId }), { theme: 'system', boardId });
  assert.deepEqual(readDesktopPreferences({ theme: 'dark', boardId }), { theme: 'dark', boardId });
  for (const theme of ['light', 'dark', 'system']) assert.deepEqual(readDesktopPreferences({ version: 2, theme, boardId }), { theme, boardId });
  assert.throws(() => readDesktopPreferences({ version: 3, theme: 'light', boardId }), /Invalid preferences/);
  assert.throws(() => readDesktopPreferences({ version: 2, theme: 'light', boardId, extra: 1 }), /Invalid preferences/);
});
