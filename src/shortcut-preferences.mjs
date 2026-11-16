import { currentBindings, defaultBindings, findShortcutConflict, normalBinding, platformIsMac, rebindable, recordBinding, sameBinding, setActiveShortcutOverrides } from './shortcuts.mjs';

// Personal shortcuts: only the differences from the defaults are kept, so new defaults reach everyone who has not
// changed that action. An empty list turns an action's shortcut off. Like the theme, they live on this device; the
// desktop app also saves them with its other preferences, because its page opens on a new port at every launch.
export const shortcutStorageKey = 'concept-graph-shortcuts';
export const maxBindingsPerAction = 4;
const empty = Object.freeze({ version: 1, bindings: Object.freeze({}) });

export function sanitizeShortcutOverrides(value, mac = platformIsMac()) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)) return empty;
  const bindings = {};
  for (const [id, list] of Object.entries(value.bindings).slice(0, 64)) {
    if (!rebindable(id) || !Array.isArray(list) || list.length > maxBindingsPerAction) continue;
    const clean = [...new Set(list.map(normalBinding))];
    // A stored binding the recorder would refuse (a browser key, Tab, a bare Enter, a fixed shortcut) is dropped rather than trusted.
    if (clean.some(binding => !binding || !recordable(binding, mac) || findShortcutConflict(id, binding, null, mac)?.fixed)) continue;
    bindings[id] = clean;
  }
  return Object.freeze({ version: 1, bindings: Object.freeze(bindings) });
}
// Replays a stored binding through the recorder's rules.
function recordable(binding, mac) {
  const parts = binding.split('+'), code = parts.pop();
  const key = code === 'Space' ? ' ' : /^(?:Enter|Delete|Backspace|Escape|Tab|Insert|Home|End|PageUp|PageDown|Arrow(?:Left|Right|Up|Down)|F\d+)$/.test(code) ? code : '';
  const result = recordBinding({ key, code, metaKey: mac && parts.includes('Mod'), ctrlKey: parts.includes('Ctrl') || (!mac && parts.includes('Mod')), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift') }, mac);
  return !!result && !result.error;
}

const sameList = (a, b, mac) => a.length === b.length && a.every((binding, index) => sameBinding(binding, b[index], mac));
// Sets one action's bindings; matching the defaults again removes the override.
export function withBindings(overrides, id, bindings, mac = platformIsMac()) {
  if (!rebindable(id)) return overrides;
  const next = { ...overrides.bindings };
  const clean = [...new Set(bindings.map(normalBinding).filter(Boolean))].slice(0, maxBindingsPerAction);
  if (sameList(clean, defaultBindings(id, mac), mac)) delete next[id]; else next[id] = clean;
  return sanitizeShortcutOverrides({ version: 1, bindings: next }, mac);
}
// Gives an action one binding, taking it from another changeable action that used it ("Replace" in Settings).
export function withAssigned(overrides, id, binding, mac = platformIsMac()) {
  let freed = overrides;
  for (let conflict = findShortcutConflict(id, binding, freed, mac), turns = 0; conflict; conflict = findShortcutConflict(id, binding, freed, mac)) {
    if (conflict.fixed || ++turns > 64) return overrides;
    freed = withBindings(freed, conflict.id, currentBindings(conflict.id, freed, mac).filter(other => !sameBinding(other, binding, mac)), mac);
  }
  return withBindings(freed, id, [binding], mac);
}
export const withoutOverride = (overrides, id) => { const next = { ...overrides.bindings }; delete next[id]; return sanitizeShortcutOverrides({ version: 1, bindings: next }); };
export const hasOverride = (overrides, id) => Object.hasOwn(overrides.bindings, id);
// What the desktop preferences file stores: nothing when every shortcut is the default.
export const savedShortcuts = overrides => Object.keys(overrides.bindings).length ? { version: 1, bindings: { ...overrides.bindings } } : undefined;

export function readShortcutOverrides(storage) {
  try { return sanitizeShortcutOverrides(JSON.parse(storage?.getItem(shortcutStorageKey) || 'null')); } catch { return empty; }
}
function writeShortcutOverrides(storage, overrides) {
  try {
    if (Object.keys(overrides.bindings).length) storage?.setItem(shortcutStorageKey, JSON.stringify(overrides));
    else storage?.removeItem(shortcutStorageKey);
  } catch {}
}

// The store the keyboard handlers read at key-press time and components read through useSyncExternalStore.
const storage = () => { try { return globalThis.localStorage; } catch { return undefined; } };
let state = empty;
const listeners = new Set();
function commit(next, persist = true) {
  if (persist) writeShortcutOverrides(storage(), next);
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next; setActiveShortcutOverrides(state);
  for (const listener of [...listeners]) listener();
}
export const getShortcutOverrides = () => state;
export function subscribeShortcutOverrides(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export const setShortcutBindings = (id, bindings) => commit(withBindings(state, id, bindings));
export const assignShortcut = (id, binding) => commit(withAssigned(state, id, binding));
export const resetShortcut = id => commit(withoutOverride(state, id));
export const resetAllShortcuts = () => commit(empty);
// The desktop app's saved copy wins over this origin's storage, which starts empty on each new port.
export const replaceShortcutOverrides = value => commit(sanitizeShortcutOverrides(value));
export const reloadShortcutOverrides = () => commit(readShortcutOverrides(storage()), false);

if (typeof window !== 'undefined') {
  reloadShortcutOverrides();
  // Another tab changed its shortcuts.
  window.addEventListener('storage', event => { if (event.key === shortcutStorageKey || event.key === null) reloadShortcutOverrides(); });
}
