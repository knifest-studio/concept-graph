import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestFreePosition, revealViewport } from '../src/node-placement.mjs';

const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test('nearest placement matches exhaustive free-space search, including constrained and completely occupied views', () => {
  const size = { width: 2, height: 2 }, limits = { minX: 0, maxX: 8, minY: -2, maxY: 8 };
  let seed = 17;
  const random = () => { seed = seed * 48271 % 2147483647; return seed % 9; };
  for (let sample = 0; sample < 50; sample++) {
    const boxes = Array.from({ length: 5 }, () => ({ x: random(), y: random() - 2, width: random() + 1, height: random() + 1 })), wanted = { x: random(), y: random() - 2 };
    const result = nearestFreePosition(wanted, size, boxes, limits);
    let closest = Infinity;
    for (let x = 0; x <= 8; x++) for (let y = -2; y <= 8; y++) {
      if (!boxes.some(box => overlaps({ x, y, ...size }, box))) closest = Math.min(closest, (x - wanted.x) ** 2 + (y - wanted.y) ** 2);
    }
    if (!Number.isFinite(closest)) assert.equal(result, null);
    else { assert.ok(!boxes.some(box => overlaps({ ...result, ...size }, box))); assert.equal((result.x - wanted.x) ** 2 + (result.y - wanted.y) ** 2, closest); }
    assert.deepEqual(nearestFreePosition(wanted, size, [...boxes].reverse(), limits), result);
  }
  assert.equal(nearestFreePosition({ x: 0, y: 0 }, size, [], { minX: 4, maxX: 3 }), null);
});

test('camera preserves zoom, leaves visible cards alone and pans each axis only as far as needed', () => {
  const viewport = { x: 0, y: 0, zoom: 1 }, bounds = { width: 1000, height: 800 };
  assert.equal(revealViewport({ x: 100, y: 100, width: 310, height: 310 }, viewport, bounds), null);
  assert.deepEqual(revealViewport({ x: 900, y: 100, width: 310, height: 310 }, viewport, bounds), { x: -240, y: 0, zoom: 1 });
  assert.deepEqual(revealViewport({ x: -100, y: -100, width: 310, height: 310 }, viewport, bounds), { x: 130, y: 160, zoom: 1 });
  const zoomed = { x: 0, y: 0, zoom: .2 };
  assert.equal(revealViewport({ x: 1000, y: 1000, width: 310, height: 310 }, zoomed, bounds), null);
  assert.equal(revealViewport({ x: 9000, y: 1000, width: 310, height: 310 }, zoomed, bounds).zoom, .2);
});

test('camera includes the prompt when both fit, prioritizes the new card otherwise, and handles oversized images', () => {
  const viewport = { x: 0, y: 0, zoom: 1 }, bounds = { width: 1000, height: 800 }, output = { x: 900, y: 100, width: 310, height: 310 };
  const source = { x: 510, y: 100, width: 310, height: 150 };
  assert.deepEqual(revealViewport(output, viewport, bounds, source), { x: -240, y: 0, zoom: 1 });
  const distant = { ...source, x: 0 };
  assert.deepEqual(revealViewport(output, viewport, bounds, distant), revealViewport(output, viewport, bounds));
  assert.deepEqual(revealViewport({ x: 800, y: 2000, width: 310, height: 4000 }, viewport, bounds), { x: -140, y: -1940, zoom: 1 });
});
