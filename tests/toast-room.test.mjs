import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toastGap, toastRoom } from '../src/toast-room.mjs';

function fakeRoot() {
  const style = new Map();
  return { style: { setProperty: (name, value) => style.set(name, value), removeProperty: name => style.delete(name) }, room: () => style.get('--toast-room') };
}
class FakeObserver {
  static last;
  constructor(callback) { this.callback = callback; this.watched = new Set(); FakeObserver.last = this; }
  observe(element) { this.watched.add(element); }
  unobserve(element) { this.watched.delete(element); }
}
const toast = height => ({ height, getBoundingClientRect() { return { height: this.height }; } });

test('a shown notification reserves its height and the gaps around it, and the room goes with the last one', () => {
  const root = fakeRoot(), ref = toastRoom(root, FakeObserver), first = toast(46), second = toast(63.2);
  const dropFirst = ref(first);
  assert.equal(root.room(), `${46 + toastGap * 2}px`);
  const dropSecond = ref(second);
  assert.equal(root.room(), `${64 + toastGap * 2}px`);
  dropSecond();
  assert.equal(root.room(), `${46 + toastGap * 2}px`);
  assert.equal(FakeObserver.last.watched.has(second), false);
  dropFirst();
  assert.equal(root.room(), undefined);
  assert.equal(ref(null), undefined);
});

test('a notification that wraps to more lines grows the room', () => {
  const root = fakeRoot(), ref = toastRoom(root, FakeObserver), long = toast(46);
  ref(long);
  long.height = 82;
  FakeObserver.last.callback();
  assert.equal(root.room(), `${82 + toastGap * 2}px`);
});

test('dialogs leave the room free and the docked notification uses the same gap', () => {
  const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /:root:has\(:is\(\.lightbox,\.board-modal\)\) \.toast\{[^}]*bottom:12px/);
  assert.equal(toastGap, 12);
  assert.match(css, /:is\(\.lightbox,\.board-modal\)\{padding-bottom:max\(12px,3dvh,var\(--toast-room,0px\)\)\}/);
  for (const card of [/\.lightbox-card\{[^}]*max-height:100%/, /\.help-card\{[^}]*max-height:min\(calc\(100dvh - 48px\),100%\)/, /\.copy-custom-dialog\{max-height:min\(85dvh,100%\)/]) assert.match(css, card);
  assert.match(css, /:where\(\.board-modal>\*\)\{max-height:100%/);
  const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.equal(main.match(/className="toast" role="status" ref=\{keepToastRoom\}/g)?.length, 3);
  assert.equal(main.match(/className="toast"/g)?.length, 3);
});
