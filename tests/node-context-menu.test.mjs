import test from 'node:test';
import assert from 'node:assert/strict';
import { contextMenuShortcut } from '../src/node-context-menu.mjs';

test('context menu shortcuts act on its target and leave other shortcuts alone', () => {
  const key = (key, extra = {}) => ({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
  assert.equal(contextMenuShortcut(key('c'), 'image'), 'image');
  assert.equal(contextMenuShortcut(key('C', { shiftKey: true }), 'image'), 'id');
  assert.equal(contextMenuShortcut(key('C', { metaKey: false, ctrlKey: true, shiftKey: true }), 'group'), 'id');
  assert.equal(contextMenuShortcut(key('c'), 'text'), null);
  assert.equal(contextMenuShortcut(key('c', { altKey: true }), 'image'), null);
  assert.equal(contextMenuShortcut(key('x'), 'image'), null);
  // A group's menu shows the Ungroup keys, so they act on that group; other menus leave them to the canvas.
  assert.equal(contextMenuShortcut(key('G', { shiftKey: true, code: 'KeyG' }), 'group'), 'ungroup');
  assert.equal(contextMenuShortcut(key('П', { shiftKey: true, code: 'KeyG' }), 'group'), 'ungroup', 'Ukrainian layout');
  assert.equal(contextMenuShortcut(key('G', { shiftKey: true, code: 'KeyG' }), 'image'), null);
  assert.equal(contextMenuShortcut(key('g', { code: 'KeyG' }), 'group'), null);
});
