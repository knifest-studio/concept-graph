import test from 'node:test';
import assert from 'node:assert/strict';
import { isHelpShortcut, isMacPlatform, keyboardShortcuts, shortcutLabel } from '../src/shortcuts.mjs';
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
