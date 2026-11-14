import test from 'node:test';
import assert from 'node:assert/strict';
import { installBackdropClose } from '../src/backdrop-close.mjs';

function fakeDocument() {
  const listeners = {};
  class KeyboardEvent { constructor(type, init) { Object.assign(this, { type, ...init }); } }
  return {
    defaultView: { KeyboardEvent },
    addEventListener: (type, listener) => { listeners[type] = listener; },
    removeEventListener: type => { delete listeners[type]; },
    fire: (type, event) => listeners[type]?.(event),
    listeners
  };
}
const element = isBackdrop => {
  const sent = [];
  return { sent, matches: selector => isBackdrop && selector === '.board-modal', dispatchEvent: event => sent.push(event) };
};

test('a click on the dialog backdrop sends Escape to that dialog', () => {
  const doc = fakeDocument(), backdrop = element(true);
  installBackdropClose(doc);
  doc.fire('pointerdown', { button: 0, target: backdrop });
  doc.fire('click', { target: backdrop });
  assert.equal(backdrop.sent.length, 1);
  assert.equal(backdrop.sent[0].key, 'Escape');
  assert.equal(backdrop.sent[0].bubbles, true);
});

test('clicks inside the card, drags that end on the backdrop and other buttons keep the dialog open', () => {
  const doc = fakeDocument(), backdrop = element(true), card = element(false);
  installBackdropClose(doc);
  doc.fire('pointerdown', { button: 0, target: card });
  doc.fire('click', { target: card });
  doc.fire('pointerdown', { button: 0, target: card });
  doc.fire('click', { target: backdrop });
  doc.fire('pointerdown', { button: 2, target: backdrop });
  doc.fire('click', { target: backdrop });
  assert.equal(backdrop.sent.length, 0);
  assert.equal(card.sent.length, 0);
});

test('removing the listeners stops closing', () => {
  const doc = fakeDocument();
  installBackdropClose(doc)();
  assert.deepEqual(Object.keys(doc.listeners), []);
});
