import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { activeShortcutOverrides, defaultBindings, matchShortcut, shortcutRegistry } from '../src/shortcuts.mjs';
import { assignShortcut, getShortcutOverrides, hasOverride, readShortcutOverrides, resetAllShortcuts, resetShortcut, sanitizeShortcutOverrides, savedShortcuts, setShortcutBindings, shortcutStorageKey, subscribeShortcutOverrides, withAssigned, withBindings, withoutOverride } from '../src/shortcut-preferences.mjs';
import { validPreferences, validShortcutPreferences } from '../desktop-preferences.mjs';
import { ungroupTargets } from '../src/canvas.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';

const empty = { version: 1, bindings: {} };
const memory = () => { const items = new Map(); return { items, getItem: key => items.has(key) ? items.get(key) : null, setItem: (key, value) => items.set(key, String(value)), removeItem: key => items.delete(key) }; };

test('stored overrides keep only known, changeable actions with bindings the recorder would accept', () => {
  for (const value of [null, 'x', [], {}, { version: 2, bindings: {} }, { version: 1, bindings: [] }]) assert.deepEqual(sanitizeShortcutOverrides(value, false), empty);
  const clean = sanitizeShortcutOverrides({ version: 1, bindings: {
    'group.create': ['Shift+Mod+KeyG', 'Mod+Shift+KeyG'], 'tool.pen': [], 'unknown.action': ['KeyQ'], 'edit.copy': ['KeyQ'], __proto__: ['KeyQ'],
    'tool.select': ['Bogus'], 'tool.sticky': ['Mod+KeyW'], 'tool.stamp': ['Tab'], 'tool.arrow': ['Mod+KeyC'], 'prompt.add': ['KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE'], 'edit.undo': ['KeyU']
  } }, false);
  assert.deepEqual(clean.bindings, { 'group.create': ['Mod+Shift+KeyG'], 'tool.pen': [], 'edit.undo': ['KeyU'] });
  assert.ok(Object.isFrozen(clean) && Object.isFrozen(clean.bindings));
  // Mod+Q quits on a Mac but is an ordinary key elsewhere.
  assert.deepEqual(sanitizeShortcutOverrides({ version: 1, bindings: { 'tool.pen': ['Mod+KeyQ'] } }, true).bindings, {});
  assert.deepEqual(sanitizeShortcutOverrides({ version: 1, bindings: { 'tool.pen': ['Mod+KeyQ'] } }, false).bindings, { 'tool.pen': ['Mod+KeyQ'] });
  assert.deepEqual(sanitizeShortcutOverrides({ version: 1, bindings: { 'edit.delete': ['Delete'], 'prompt.generate': ['Mod+Enter', 'F5'] } }, false).bindings, { 'edit.delete': ['Delete'], 'prompt.generate': ['Mod+Enter', 'F5'] });
});

test('changing, turning off, resetting and replacing keep only differences from the defaults', () => {
  let overrides = withBindings(empty, 'group.create', ['Mod+Alt+KeyG'], false);
  assert.deepEqual(overrides.bindings, { 'group.create': ['Mod+Alt+KeyG'] }); assert.ok(hasOverride(overrides, 'group.create'));
  overrides = withBindings(overrides, 'group.create', defaultBindings('group.create', false), false);
  assert.deepEqual(overrides.bindings, {}, 'choosing the default again removes the override');
  overrides = withBindings(overrides, 'prompt.add', [], false);
  assert.deepEqual(overrides.bindings, { 'prompt.add': [] });
  assert.equal(matchShortcut({ key: 't', code: 'KeyT' }, { overrides, mac: false }), null);
  assert.deepEqual(withoutOverride(overrides, 'prompt.add').bindings, {});
  assert.equal(withBindings(empty, 'edit.copy', ['KeyQ'], false), empty, 'fixed shortcuts cannot change');
  // Replace moves a key: the select tool takes P, so the pen loses it and has no shortcut.
  overrides = withAssigned(empty, 'tool.select', 'KeyP', false);
  assert.deepEqual(overrides.bindings, { 'tool.select': ['KeyP'], 'tool.pen': [] });
  assert.equal(matchShortcut({ key: 'p', code: 'KeyP' }, { overrides, mac: false }), 'tool.select');
  // The arrow keeps X when another tool takes L.
  assert.deepEqual(withAssigned(empty, 'tool.pen', 'KeyL', false).bindings, { 'tool.pen': ['KeyL'], 'tool.arrow': ['KeyX'] });
  assert.equal(withAssigned(empty, 'tool.pen', 'Mod+KeyV', false), empty, 'a fixed shortcut is never taken');
  // No sequence of assignments leaves two changeable actions on one key.
  let many = empty;
  for (const [id, binding] of [['tool.select', 'KeyP'], ['tool.pen', 'KeyV'], ['group.create', 'Mod+KeyD'], ['edit.duplicate', 'Mod+KeyG'], ['help', 'KeyV']]) many = withAssigned(many, id, binding, false);
  const used = new Map();
  for (const item of shortcutRegistry) for (const binding of (Object.hasOwn(many.bindings, item.id) ? many.bindings[item.id] : defaultBindings(item.id, false))) {
    if (item.scope === 'zoom') continue;
    assert.ok(!used.has(binding), `${binding}: ${used.get(binding)} and ${item.id}`); used.set(binding, item.id);
  }
  assert.equal(savedShortcuts(empty), undefined);
  assert.deepEqual(savedShortcuts(overrides), { version: 1, bindings: { 'tool.select': ['KeyP'], 'tool.pen': [] } });
});

test('the store persists to localStorage, survives broken storage and notifies subscribers', () => {
  assert.deepEqual(readShortcutOverrides({ getItem: () => '{not json' }), empty);
  assert.deepEqual(readShortcutOverrides({ getItem: () => { throw new Error('blocked'); } }), empty);
  assert.deepEqual(readShortcutOverrides(undefined), empty);
  const storage = memory(), calls = [];
  globalThis.localStorage = storage;
  try {
    const unsubscribe = subscribeShortcutOverrides(() => calls.push(getShortcutOverrides()));
    setShortcutBindings('group.create', ['Mod+Alt+KeyG']);
    assert.deepEqual(JSON.parse(storage.getItem(shortcutStorageKey)), { version: 1, bindings: { 'group.create': ['Mod+Alt+KeyG'] } });
    assert.equal(activeShortcutOverrides(), getShortcutOverrides(), 'key handlers read the same overrides');
    assert.equal(matchShortcut({ key: 'g', code: 'KeyG', ctrlKey: true, altKey: true }, { mac: false }), 'group.create');
    assert.equal(matchShortcut({ key: 'g', code: 'KeyG', ctrlKey: true }, { mac: false }), null);
    assignShortcut('tool.pen', 'KeyV');
    assert.deepEqual(getShortcutOverrides().bindings['tool.select'], []);
    resetShortcut('tool.select');
    assert.equal(hasOverride(getShortcutOverrides(), 'tool.select'), false);
    resetAllShortcuts();
    assert.equal(storage.getItem(shortcutStorageKey), null);
    assert.equal(calls.length, 4); unsubscribe();
    setShortcutBindings('tool.pen', []); assert.equal(calls.length, 4);
    // Writing can fail (private mode, quota); the change still applies for this page.
    globalThis.localStorage = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('quota'); } };
    setShortcutBindings('tool.sticky', ['KeyQ']);
    assert.deepEqual(getShortcutOverrides().bindings['tool.sticky'], ['KeyQ']);
    resetAllShortcuts();
  } finally { delete globalThis.localStorage; }
});

test('desktop preferences accept saved shortcuts by shape and keep older files loading', () => {
  const boardId = '00000000-0000-0000-0000-000000000001', shortcuts = { version: 1, bindings: { 'group.create': ['Mod+Alt+KeyG'], 'prompt.add': [] } };
  assert.ok(validPreferences({ theme: 'dark', boardId, shortcuts }));
  assert.ok(validPreferences({ theme: 'dark', boardId: null }));
  for (const bad of [{ version: 2, bindings: {} }, { version: 1, bindings: [] }, { version: 1 }, { version: 1, bindings: {}, extra: 1 }, { version: 1, bindings: { 'group.create': 'Mod+KeyG' } },
    { version: 1, bindings: { 'group.create': ['Mod+KeyG', 'KeyA', 'KeyB', 'KeyC', 'KeyD'] } }, { version: 1, bindings: { 'Bad id': ['KeyG'] } }, { version: 1, bindings: { 'group.create': ['<script>'] } },
    { version: 1, bindings: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`a${index}`, []])) }]) {
    assert.equal(validShortcutPreferences(bad), false, JSON.stringify(bad).slice(0, 80));
    assert.ok(!validPreferences({ theme: 'dark', boardId, shortcuts: bad }));
  }
  assert.ok(!validPreferences({ theme: 'dark', shortcuts }), 'theme and board are still required');
  // Whatever the page can save, the desktop server accepts.
  const everything = { version: 1, bindings: Object.fromEntries(shortcutRegistry.filter(item => !item.fixed).map(item => [item.id, defaultBindings(item.id, false).slice(0, 4)])) };
  assert.ok(validShortcutPreferences(everything));
  assert.ok(JSON.stringify({ theme: 'system', boardId, shortcuts: everything }).length < 16384);
});

test('ungrouping by shortcut removes every targeted group in one undo step', () => {
  const node = (id, selected = false) => ({ id, type: 'text', position: { x: 0, y: 0 }, data: { text: id }, ...(selected ? { selected } : {}) });
  const groups = [{ id: 'g1', name: 'Group 1', nodeIds: ['a', 'b'], collapsed: false }, { id: 'g2', name: 'Group 2', nodeIds: ['c', 'd'], collapsed: true }, { id: 'g3', name: 'Group 3', nodeIds: ['e', 'f'], collapsed: false }];
  const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => node(id));
  // A selected group and a group with a selected member are both ungrouped; the third stays.
  const targets = ungroupTargets([{ ...groups[0], selected: true }, groups[1], groups[2]], nodes.map(item => item.id === 'c' ? node('c', true) : item));
  assert.deepEqual(targets.map(group => group.id), ['g1', 'g2']);
  assert.deepEqual(ungroupTargets(groups, nodes), []);
  const doc = new Y.Doc(), base = { nodes, edges: [], groups, runs: [] }, origin = 'me';
  applyLocalGraph(doc, base, { nodes: [], edges: [], groups: [], runs: [] }, 'seed');
  const undo = new Y.UndoManager([doc.getMap('nodes'), doc.getMap('edges'), doc.getMap('groups'), doc.getMap('pages'), doc.getMap('sections')], { trackedOrigins: new Set([origin]) });
  const removed = new Set(targets.map(group => group.id));
  applyLocalGraph(doc, { ...base, groups: groups.filter(group => !removed.has(group.id)) }, base, origin);
  assert.deepEqual(readCloudGraph(doc).groups.map(group => group.id), ['g3']);
  undo.undo();
  assert.deepEqual(readCloudGraph(doc).groups.map(group => group.id).sort(), ['g1', 'g2', 'g3']);
  assert.equal(undo.undoStack.length, 0);
});
