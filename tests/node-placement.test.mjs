import test from 'node:test';
import assert from 'node:assert/strict';
import { minRevealZoom, nearestFreePosition, revealViewport } from '../src/node-placement.mjs';

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

const onScreen = (box, view, bounds) => box.x * view.zoom + view.x >= 30 - 1e-6 && box.y * view.zoom + view.y >= 60 - 1e-6
  && (box.x + box.width) * view.zoom + view.x <= bounds.width - 30 + 1e-6 && (box.y + box.height) * view.zoom + view.y <= bounds.height - 90 + 1e-6;

test('camera includes the prompt when both fit, zooms out a little when that makes them fit, keeps the prompt in view otherwise, and handles oversized images', () => {
  const viewport = { x: 0, y: 0, zoom: 1 }, bounds = { width: 1000, height: 800 }, output = { x: 900, y: 100, width: 310, height: 310 };
  const source = { x: 510, y: 100, width: 310, height: 150 };
  assert.deepEqual(revealViewport(output, viewport, bounds, source), { x: -240, y: 0, zoom: 1 });
  // Too wide together at this zoom: the camera steps out just enough to keep the prompt (and its model buttons) in view.
  const distant = { ...source, x: 0 }, out = revealViewport(output, viewport, bounds, distant);
  assert.ok(out.zoom < 1 && out.zoom >= minRevealZoom); assert.ok(onScreen(output, out, bounds) && onScreen(distant, out, bounds));
  // Fitting both would need light cards: the zoom stays and the prompt stays in view, moved toward the card.
  const far = { ...source, x: -3000 }, held = revealViewport(output, viewport, bounds, far);
  assert.equal(held.zoom, 1); assert.ok(onScreen(far, held, bounds)); assert.equal(held.x, 30 - far.x);
  assert.deepEqual(revealViewport({ x: 800, y: 2000, width: 310, height: 4000 }, viewport, bounds), { x: -140, y: -1940, zoom: 1 });
});

test('a card far down a prompt’s column keeps the prompt and its model buttons in view, moving toward the card', () => {
  const bounds = { width: 1000, height: 800 }, source = { x: 0, y: 0, width: 310, height: 150 }, card = { x: 390, y: 2400, width: 310, height: 310 };
  const view = revealViewport(card, { x: 100, y: 100, zoom: 1 }, bounds, source);
  assert.equal(view.zoom, 1); assert.ok(onScreen(source, view, bounds));
  // As far down as the prompt allows: the prompt at the top of the canvas, its column below it.
  assert.equal(view.y, 60 - source.y);
});

test('a new card under a floating panel slides out from under it', () => {
  const viewport = { x: 0, y: 0, zoom: 1 }, bounds = { width: 1000, height: 800 }, cover = { x: 640, y: 10, width: 340, height: 150 };
  // Fully inside the canvas, but its top-right corner sits under the panel: move it just below.
  assert.deepEqual(revealViewport({ x: 600, y: 100, width: 310, height: 310 }, viewport, bounds, undefined, cover), { x: 0, y: 72, zoom: 1 });
  // Clear of the panel: the camera stays.
  assert.equal(revealViewport({ x: 600, y: 200, width: 310, height: 310 }, viewport, bounds, undefined, cover), null);
});
