import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingLabel, currentBindings, defaultBindings, findShortcutConflict, isHelpShortcut, isMacPlatform, keyboardShortcuts, matchShortcut, normalBinding, rebindable, recordBinding, shortcutHint, shortcutLabel, shortcutRegistry, shortcutRows, textEntrySelector, withShortcut } from '../src/shortcuts.mjs';
import uk from '../src/locales/uk.mjs';

test('shortcut reference covers actual tools and context-specific commands with Ukrainian labels', () => {
  for (const keys of ['V', 'P', 'S', 'E', 'R', 'O', 'L / X', 'Shift+S', 'T', 'Mod+D', 'Mod+Z', 'Mod+Shift+Z', 'Delete / Backspace', 'Mod+Enter', 'Mod+V', 'Mod+C', 'Mod+Shift+C', 'F2', ']', '[', 'Mod+]', 'Mod+[', '?']) assert.ok(keyboardShortcuts.some(row => row.keys === keys), keys);
  assert.equal(new Set(keyboardShortcuts.map(row => row.keys)).size, keyboardShortcuts.length);
  assert.match(keyboardShortcuts.find(row => row.keys === 'F2').label, /focus/);
  assert.match(keyboardShortcuts.find(row => row.keys === 'Mod+Enter').label, /prompt editor/);
  for (const row of keyboardShortcuts) { assert.ok(uk[row.label], row.label); assert.ok(uk[row.group], row.group); }
});
test('reference and tooltips use platform-appropriate modifier labels', () => {
  for (const platform of ['MacIntel', 'macOS', 'iPhone', 'iPad']) assert.equal(isMacPlatform(platform), true);
  for (const platform of ['Windows', 'Linux', undefined]) assert.equal(isMacPlatform(platform), false);
  assert.equal(shortcutLabel('Mod+Shift+Z', true), '⌘ ⇧ Z');
  assert.equal(shortcutLabel('Mod+Shift+Z', false), 'Ctrl+Shift+Z');
  assert.equal(shortcutLabel('Mod+Enter', true), '⌘ Enter');
  assert.equal(shortcutLabel('Shift+S', false), 'Shift+S');
});
test('? opens help only outside editing controls and without composition, repetition or command modifiers', () => {
  const event = { key: '?', shiftKey: true, target: { closest: () => null } };
  assert.ok(isHelpShortcut(event));
  for (const key of ['metaKey', 'ctrlKey', 'altKey', 'repeat', 'isComposing']) assert.equal(isHelpShortcut({ ...event, [key]: true }), false);
  assert.equal(isHelpShortcut({ ...event, key: '/' }), false);
  assert.ok(isHelpShortcut({ ...event, key: ',', code: 'Slash' }), 'Shift + the ?/ key on a Ukrainian layout');
  assert.equal(isHelpShortcut({ ...event, key: '.', code: 'Slash', shiftKey: false }), false);
  for (const field of ['input', 'textarea', 'select', '[contenteditable]', '[role="textbox"]']) {
    assert.equal(isHelpShortcut({ ...event, target: { closest: selector => { assert.ok(selector.includes(field)); return {}; } } }), false);
  }
});

const press = (key, code, extra = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, target: null, ...extra });
const match = (event, ctx = {}) => matchShortcut(event, { mac: false, overrides: null, ...ctx });
const macMatch = (event, ctx = {}) => match(event, { mac: true, ...ctx });
const field = { closest: selector => selector.includes('textarea') ? {} : null };

test('the registry is complete, translated, parseable and free of default conflicts on both platforms', () => {
  assert.equal(new Set(shortcutRegistry.map(item => item.id)).size, shortcutRegistry.length);
  for (const item of shortcutRegistry) {
    assert.ok(uk[item.label], item.label); assert.ok(uk[item.group], item.group);
    for (const binding of [...item.bindings, ...(item.pc || [])]) assert.equal(normalBinding(binding), binding, `${item.id} ${binding}`);
    if (item.display) for (const text of Object.values(item.display)) if (/[a-z]/i.test(text)) assert.ok(uk[text], text);
    for (const mac of [true, false]) for (const binding of defaultBindings(item.id, mac)) assert.equal(findShortcutConflict(item.id, binding, null, mac), null, `${item.id} ${binding} mac=${mac}`);
  }
  for (const id of ['group.create', 'group.remove']) assert.ok(rebindable(id), id);
  for (const id of ['escape', 'edit.copy', 'edit.paste', 'edit.cut', 'page.rename', 'zoom.in', 'zoom.fit', 'pan.left', 'drag.duplicate']) assert.equal(rebindable(id), false, id);
  for (const keys of ['Mod+G', 'Mod+Shift+G', 'Alt+drag']) assert.ok(keyboardShortcuts.some(row => row.keys === keys), keys);
});

test('US layout presses match by the typed character with exact modifiers', () => {
  assert.equal(match(press('v', 'KeyV')), 'tool.select');
  assert.equal(match(press('l', 'KeyL')), 'tool.arrow'); assert.equal(match(press('x', 'KeyX')), 'tool.arrow');
  assert.equal(match(press('r', 'KeyR')), 'tool.rectangle'); assert.equal(match(press('o', 'KeyO')), 'tool.ellipse');
  assert.equal(match(press('S', 'KeyS', { shiftKey: true })), 'section.wrap');
  assert.equal(match(press('t', 'KeyT')), 'prompt.add');
  for (const extra of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) assert.equal(match(press('T', 'KeyT', extra)), null, JSON.stringify(extra));
  assert.equal(match(press('z', 'KeyZ', { ctrlKey: true })), 'edit.undo');
  assert.equal(match(press('Z', 'KeyZ', { ctrlKey: true, shiftKey: true })), 'edit.redo');
  assert.equal(match(press('y', 'KeyY', { ctrlKey: true })), 'edit.redo', 'Ctrl+Y redoes away from a Mac');
  assert.equal(macMatch(press('y', 'KeyY', { metaKey: true })), null, 'no ⌘Y redo on a Mac');
  assert.equal(macMatch(press('z', 'KeyZ', { metaKey: true })), 'edit.undo');
  assert.equal(macMatch(press('z', 'KeyZ', { ctrlKey: true })), 'edit.undo', 'Ctrl still stands for Mod on a Mac');
  assert.equal(match(press('z', 'KeyZ', { ctrlKey: true, altKey: true })), null);
  assert.equal(match(press('g', 'KeyG', { ctrlKey: true })), 'group.create'); assert.equal(macMatch(press('g', 'KeyG', { metaKey: true })), 'group.create');
  assert.equal(match(press('G', 'KeyG', { ctrlKey: true, shiftKey: true })), 'group.remove'); assert.equal(macMatch(press('g', 'KeyG', { metaKey: true, shiftKey: true })), 'group.remove');
  assert.equal(match(press('Delete', 'Delete')), 'edit.delete'); assert.equal(match(press('Backspace', 'Backspace')), 'edit.delete');
  for (const extra of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) assert.equal(match(press('Delete', 'Delete', extra)), null, JSON.stringify(extra));
  assert.equal(match(press(']', 'BracketRight')), 'layer.front'); assert.equal(match(press('[', 'BracketLeft', { ctrlKey: true })), 'layer.backward');
  assert.equal(match(press('C', 'KeyC', { ctrlKey: true, shiftKey: true })), 'copy.ids');
  assert.equal(match(press('?', 'Slash', { shiftKey: true })), 'help');
  assert.equal(match(press('Enter', 'NumpadEnter', { ctrlKey: true }), { scopes: ['prompt'] }), 'prompt.generate');
  assert.equal(match(press('Enter', 'Enter', { ctrlKey: true, shiftKey: true }), { scopes: ['prompt'] }), null);
});

test('Ukrainian and other non-Latin layouts fall back to the physical key', () => {
  assert.equal(macMatch(press('я', 'KeyZ', { metaKey: true })), 'edit.undo');
  assert.equal(macMatch(press('Я', 'KeyZ', { metaKey: true, shiftKey: true })), 'edit.redo');
  assert.equal(match(press('м', 'KeyV')), 'tool.select');
  assert.equal(match(press('і', 'KeyS')), 'tool.sticky');
  assert.equal(match(press('І', 'KeyS', { shiftKey: true })), 'section.wrap');
  assert.equal(match(press('е', 'KeyT')), 'prompt.add');
  assert.equal(match(press('в', 'KeyD', { ctrlKey: true })), 'edit.duplicate');
  assert.equal(match(press('п', 'KeyG', { ctrlKey: true })), 'group.create');
  assert.equal(match(press('с', 'KeyC', { ctrlKey: true, shiftKey: true })), 'copy.ids');
  assert.equal(match(press('х', 'BracketLeft')), 'layer.back'); assert.equal(match(press('ї', 'BracketRight', { metaKey: true })), 'layer.forward');
  assert.equal(match(press(',', 'Slash', { shiftKey: true })), 'help', 'Shift + the ?/ key types a comma on the Ukrainian layout');
  assert.equal(match(press('.', 'Slash')), null);
  assert.equal(match(press('ζ', 'KeyZ', { ctrlKey: true })), 'edit.undo', 'Greek');
});

test('AZERTY follows the printed letter, macOS Option and AltGr keep their meaning', () => {
  assert.equal(macMatch(press('z', 'KeyW', { metaKey: true })), 'edit.undo', 'AZERTY Z sits where QWERTY has W');
  assert.equal(macMatch(press('w', 'KeyZ', { metaKey: true })), null, 'the key printed W is not undo');
  assert.equal(match(press('a', 'KeyQ')), null); assert.equal(match(press('q', 'KeyA')), null);
  // macOS Option letters and dead keys fall back to the physical key.
  const option = { version: 1, bindings: { 'tool.pen': ['Alt+KeyA'], 'tool.stamp': ['Alt+KeyE'] } };
  assert.equal(macMatch(press('å', 'KeyA', { altKey: true }), { overrides: option }), 'tool.pen');
  assert.equal(macMatch(press('Dead', 'KeyE', { altKey: true }), { overrides: option }), 'tool.stamp');
  assert.equal(macMatch(press('å', 'KeyA', { altKey: true })), null);
  // AltGr (Ctrl+Alt) types brackets on German and other layouts: that is the plain shortcut, and AltGr letters are text.
  assert.equal(match(press('[', 'Digit8', { ctrlKey: true, altKey: true })), 'layer.back');
  assert.equal(match(press(']', 'Digit9', { ctrlKey: true, altKey: true })), 'layer.front');
  assert.equal(match(press('ś', 'KeyS', { ctrlKey: true, altKey: true })), null);
  assert.equal(match(press('@', 'KeyQ', { ctrlKey: true, altKey: true })), null);
});

test('repeats, composition and text fields only reach the actions meant for them', () => {
  assert.equal(match(press('t', 'KeyT', { repeat: true })), null);
  assert.equal(match(press('g', 'KeyG', { ctrlKey: true, repeat: true })), null);
  assert.equal(match(press('z', 'KeyZ', { ctrlKey: true, repeat: true })), 'edit.undo', 'holding undo keeps undoing');
  assert.equal(match(press('v', 'KeyV', { isComposing: true })), null);
  assert.equal(match(press('Process', 'KeyV')), null);
  assert.equal(match(press('v', 'KeyV', { keyCode: 229 })), null);
  assert.equal(match(press('v', 'KeyV', { target: field })), null);
  assert.equal(match(press('Delete', 'Delete', { target: field })), null);
  assert.equal(match(press('g', 'KeyG', { ctrlKey: true, target: field })), null);
  assert.equal(match(press('d', 'KeyD', { ctrlKey: true, target: field })), 'edit.duplicate');
  assert.equal(match(press('Enter', 'Enter', { metaKey: true, target: field }), { scopes: ['prompt'] }), 'prompt.generate');
  assert.equal(match({ nativeEvent: press('я', 'KeyZ', { ctrlKey: true }) }), 'edit.undo', 'React events are read through nativeEvent');
  for (const selector of ['textarea', 'select', '[contenteditable]', '[role="textbox"]', 'input']) assert.ok(textEntrySelector.includes(selector), selector);
  assert.ok(textEntrySelector.includes(':not([type="checkbox"])'));
});

test('fullscreen viewer keys accept the typed character or the physical key', () => {
  const zoom = event => match(event, { scopes: ['zoom'] });
  assert.equal(zoom(press('+', 'Equal', { shiftKey: true })), 'zoom.in'); assert.equal(zoom(press('=', 'Equal')), 'zoom.in');
  assert.equal(zoom(press('+', 'NumpadAdd')), 'zoom.in'); assert.equal(zoom(press('+', 'BracketRight')), 'zoom.in', 'German +');
  assert.equal(zoom(press('-', 'NumpadSubtract')), 'zoom.out'); assert.equal(zoom(press('_', 'Minus', { shiftKey: true })), 'zoom.out');
  assert.equal(zoom(press('0', 'Numpad0')), 'zoom.fit'); assert.equal(zoom(press('à', 'Digit0')), 'zoom.fit', 'AZERTY digit row');
  assert.equal(zoom(press('1', 'Digit1', { shiftKey: true })), 'zoom.actual', 'AZERTY Shift+&');
  assert.equal(zoom(press('ArrowLeft', 'ArrowLeft', { repeat: true })), 'pan.left');
  assert.equal(zoom(press('+', 'Equal', { metaKey: true, shiftKey: true })), null);
  assert.equal(match(press('0', 'Digit0')), null, 'not a canvas key');
});

test('personal overrides replace or turn off defaults; on a Mac Ctrl and ⌘ bindings stay apart', () => {
  const overrides = { version: 1, bindings: { 'tool.select': ['KeyQ'], 'prompt.add': [], 'tool.pen': ['Ctrl+KeyD'] } };
  assert.equal(match(press('q', 'KeyQ'), { overrides }), 'tool.select');
  assert.equal(match(press('v', 'KeyV'), { overrides }), null);
  assert.equal(match(press('t', 'KeyT'), { overrides }), null);
  assert.equal(macMatch(press('d', 'KeyD', { ctrlKey: true }), { overrides }), 'tool.pen', 'the exact Ctrl binding wins');
  assert.equal(macMatch(press('d', 'KeyD', { metaKey: true }), { overrides }), 'edit.duplicate');
  assert.equal(findShortcutConflict('tool.pen', 'Ctrl+KeyD', null, true), null);
  assert.deepEqual(findShortcutConflict('tool.pen', 'Ctrl+KeyD', null, false), { id: 'edit.duplicate', label: 'Duplicate selection with connections', fixed: false });
  assert.equal(findShortcutConflict('tool.pen', 'KeyV', null, false).id, 'tool.select');
  assert.equal(findShortcutConflict('tool.pen', 'Mod+KeyC', null, false).fixed, true);
  assert.equal(findShortcutConflict('tool.pen', 'Shift+Slash', null, false).id, 'help', 'global keys conflict everywhere');
  assert.equal(findShortcutConflict('tool.pen', 'Digit0', null, false), null, 'the fullscreen viewer keys are separate');
  assert.equal(findShortcutConflict('prompt.generate', 'Mod+KeyD', null, false).id, 'edit.duplicate', 'the prompt editor shares keys with the canvas');
  assert.deepEqual(currentBindings('edit.copy', { version: 1, bindings: { 'edit.copy': ['KeyQ'] } }, false), ['Mod+KeyC'], 'fixed shortcuts ignore overrides');
});

test('labels come from the bindings in force', () => {
  assert.equal(bindingLabel('Mod+Shift+KeyG', true), '⌘ ⇧ G'); assert.equal(bindingLabel('Mod+Shift+KeyG', false), 'Ctrl+Shift+G');
  assert.equal(bindingLabel('Shift+Slash', true), '?'); assert.equal(bindingLabel('Mod+BracketRight', true), '⌘ ]');
  assert.equal(bindingLabel('Ctrl+Alt+KeyA', true), '⌃ ⌥ A'); assert.equal(bindingLabel('Mod+Enter', false), 'Ctrl+Enter');
  assert.equal(bindingLabel('ArrowLeft', false), '←'); assert.equal(bindingLabel('Delete', true), 'Delete'); assert.equal(bindingLabel('nonsense', true), '');
  assert.equal(shortcutHint('edit.redo', null, false), 'Ctrl+Shift+Z');
  assert.equal(withShortcut('Undo', 'edit.undo', null, true), 'Undo · ⌘ Z');
  assert.equal(withShortcut('Undo', 'edit.undo', { version: 1, bindings: { 'edit.undo': [] } }, true), 'Undo');
  const rows = shortcutRows(null, false), row = id => rows.find(item => item.id === id);
  assert.equal(row('edit.redo').keys, 'Ctrl+Shift+Z / Ctrl+Y'); assert.equal(row('tool.arrow').keys, 'L / X'); assert.equal(row('help').keys, '?');
  assert.equal(row('drag.duplicate').keys, 'Alt+drag'); assert.equal(shortcutRows(null, true).find(item => item.id === 'drag.duplicate').keys, '⌥ drag');
  assert.equal(shortcutRows({ version: 1, bindings: { 'tool.select': [] } }, true).find(item => item.id === 'tool.select').keys, '');
  assert.ok(!rows.some(item => ['zoom.out', 'pan.right', 'edit.cut'].includes(item.id)));
});

test('the Settings recorder turns presses into bindings and refuses keys the board or browser needs', () => {
  const record = (event, mac = false) => recordBinding(press(event.key, event.code, event), mac);
  assert.deepEqual(record({ key: 'g', code: 'KeyG', metaKey: true }, true), { binding: 'Mod+KeyG' });
  assert.deepEqual(record({ key: 'g', code: 'KeyG', ctrlKey: true }), { binding: 'Mod+KeyG' });
  assert.deepEqual(record({ key: 'g', code: 'KeyG', ctrlKey: true }, true), { binding: 'Ctrl+KeyG' });
  assert.deepEqual(record({ key: 'п', code: 'KeyG', metaKey: true }, true), { binding: 'Mod+KeyG' });
  assert.deepEqual(record({ key: 'z', code: 'KeyW' }), { binding: 'KeyZ' }, 'AZERTY records the printed letter');
  assert.deepEqual(record({ key: '?', code: 'Slash', shiftKey: true }), { binding: 'Shift+Slash' });
  assert.deepEqual(record({ key: ',', code: 'Slash', shiftKey: true }), { binding: 'Comma' }, 'the typed character is recorded, as it is matched first');
  assert.deepEqual(record({ key: 'х', code: 'BracketLeft', shiftKey: true }), { binding: 'Shift+BracketLeft' }, 'a non-Latin character records the physical key');
  assert.deepEqual(record({ key: '[', code: 'Digit8', ctrlKey: true, altKey: true }), { binding: 'BracketLeft' });
  assert.deepEqual(record({ key: 'å', code: 'KeyA', altKey: true }, true), { binding: 'Alt+KeyA' });
  assert.deepEqual(record({ key: 'Delete', code: 'Delete' }), { binding: 'Delete' });
  assert.deepEqual(record({ key: 'Enter', code: 'Enter', metaKey: true }, true), { binding: 'Mod+Enter' });
  assert.deepEqual(record({ key: 'F5', code: 'F5' }), { binding: 'F5' });
  for (const key of ['Shift', 'Meta', 'Control', 'Alt', 'CapsLock']) assert.equal(record({ key, code: key }), null, key);
  assert.equal(record({ key: 'v', code: 'KeyV', isComposing: true }), null);
  for (const [key, code] of [['Tab', 'Tab'], [' ', 'Space'], ['ArrowUp', 'ArrowUp'], ['Escape', 'Escape'], ['Enter', 'Enter']]) assert.equal(record({ key, code }).error, 'blocked', code);
  for (const [extra, mac] of [[{ key: 'w', code: 'KeyW', metaKey: true }, true], [{ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }, false], [{ key: 'n', code: 'KeyN', ctrlKey: true }, false], [{ key: 'q', code: 'KeyQ', metaKey: true }, true], [{ key: 'F4', code: 'F4', altKey: true }, false]]) assert.equal(record(extra, mac).error, 'reserved', JSON.stringify(extra));
  assert.deepEqual(record({ key: 'q', code: 'KeyQ', ctrlKey: true }), { binding: 'Mod+KeyQ' });
  assert.equal(record({ key: 'Unidentified', code: '' }).error, 'unsupported');
});
