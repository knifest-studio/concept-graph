import test from 'node:test';
import assert from 'node:assert/strict';
import { installButtonHelp } from '../src/button-help.mjs';

function fakeTarget() {
  const listeners = {};
  return {
    addEventListener: (type, listener) => { listeners[type] = listener; },
    removeEventListener: type => { delete listeners[type]; },
    fire: (type, event) => listeners[type]?.({ type, ...event }),
    listeners
  };
}
const button = ({ label = 'Close image', focusVisible = false, rect = { left: 300, top: 420, width: 32, bottom: 452 } } = {}) => {
  const element = {
    dataset: {}, textContent: '', getAttribute: name => (name === 'aria-label' ? label : null), getBoundingClientRect: () => rect,
    closest: selector => (selector === 'button,[data-tooltip]' ? element : null), contains: other => other === element,
    matches: selector => { if (selector === ':focus-visible') return focusVisible; throw new SyntaxError(selector); }
  };
  return element;
};
const setup = () => {
  const doc = fakeTarget(), win = { ...fakeTarget(), innerWidth: 375 }, tips = [];
  const remove = installButtonHelp(doc, win, tip => tips.push(tip));
  return { doc, win, tips, remove };
};

test('a focus that follows a tap or click, such as a dialog autofocus, shows no tooltip', () => {
  const { doc, tips } = setup(), close = button();
  doc.fire('focusin', { target: close });
  assert.deepEqual(tips, []);
});

test('keyboard focus and hover still explain the button', () => {
  const { doc, tips } = setup();
  doc.fire('focusin', { target: button({ focusVisible: true }) });
  assert.equal(tips.length, 1);
  assert.equal(tips[0].text, 'Close image');
  assert.equal(tips[0].below, false);
  assert.equal(tips[0].x, 375 - 140);
  doc.fire('pointerover', { target: button({ label: 'Fit' }) });
  assert.equal(tips.at(-1).text, 'Fit');
});

test('a pointer focus on the hovered button keeps its tip until the click, and focus on another button leaves it alone', () => {
  const { doc, tips } = setup(), hovered = button({ label: 'Copy node ID' });
  doc.fire('pointerover', { target: hovered });
  doc.fire('focusin', { target: hovered });
  doc.fire('focusin', { target: button({ label: 'Close image' }) });
  assert.deepEqual(tips.map(tip => tip?.text ?? null), ['Copy node ID']);
  doc.fire('click', { target: hovered });
  assert.equal(tips.at(-1), null);
});

test('browsers without :focus-visible keep showing tips on focus, and removal detaches every listener', () => {
  const { doc, win, tips, remove } = setup(), old = button();
  old.matches = () => { throw new SyntaxError(':focus-visible'); };
  doc.fire('focusin', { target: old });
  assert.equal(tips.length, 1);
  remove();
  assert.deepEqual(Object.keys(doc.listeners), []);
  assert.deepEqual(Object.keys(win.listeners), []);
});
