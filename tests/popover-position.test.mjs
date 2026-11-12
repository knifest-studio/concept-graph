import test from 'node:test';
import assert from 'node:assert/strict';
import { popoverPosition } from '../src/popover-position.mjs';

test('voice popover opens beside its button and stays within desktop and narrow viewports', () => {
  const size = { width: 290, height: 300 };
  assert.deepEqual(popoverPosition({ left: 420, bottom: 48 }, size, { width: 1024, height: 768 }), { left: 420, top: 56 });
  for (const viewport of [{ width: 1024, height: 768 }, { width: 800, height: 600 }, { width: 375, height: 500 }]) {
    const position = popoverPosition({ left: viewport.width - 50, bottom: viewport.height - 30 }, size, viewport);
    assert.ok(position.left >= 12); assert.ok(position.left + size.width <= viewport.width - 12);
    assert.ok(position.top >= 12); assert.ok(position.top + size.height <= viewport.height - 12);
  }
});
