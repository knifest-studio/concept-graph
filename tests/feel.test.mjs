import test from 'node:test';
import assert from 'node:assert/strict';
import { claimCelebration, dragTilt, presets } from '../src/feel.mjs';
import { pitchVariation } from '../src/sounds.mjs';

const storage = () => { const values = new Map(); return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }; };

test('presets keep frequent actions quiet and celebrations rare', () => {
  for (const name of ['create', 'connect', 'pickup', 'drop', 'remove', 'dictation-start', 'dictation-stop', 'dictated', 'sound-on']) assert.equal(presets[name].intensity, 'frequent', name);
  for (const name of ['generate', 'arrival', 'error', 'step', 'helper']) assert.equal(presets[name].intensity, 'significant', name);
  assert.equal(presets['first-image'].intensity, 'rare'); assert.equal(presets.onboarding.intensity, 'rare');
  assert.equal(presets.generate.sound, 'start'); assert.equal(presets.arrival.sound, 'arrival');
  assert.equal(presets.helper.sound, 'success'); assert.equal(presets.error.sound, 'error');
  assert.equal(presets.pickup.sound, undefined); assert.equal(presets.dictated.sound, undefined);
});

test('every pitch stays within four percent of the selected root', () => {
  assert.equal(pitchVariation(() => 0), .96); assert.equal(pitchVariation(() => 1), 1.04);
  assert.equal(pitchVariation(() => .5), 1);
  for (let i = 0; i < 1000; i++) { const pitch = pitchVariation(); assert.ok(pitch >= .96 && pitch <= 1.04); }
});

test('first image and onboarding are independent once-only flags per viewer, including reload', () => {
  const saved = storage();
  for (const kind of ['first-image', 'onboarding']) {
    assert.equal(claimCelebration(saved, 'a', kind, new Set()), true);
    assert.equal(claimCelebration(saved, 'a', kind, new Set()), false);
    assert.equal(claimCelebration(saved, 'b', kind, new Set()), true);
  }
});

test('blocked storage still claims each celebration once for the current session', () => {
  const fallback = new Set(), blocked = { getItem() { throw Error('blocked'); } };
  assert.equal(claimCelebration(blocked, 'a', 'first-image', fallback), true);
  assert.equal(claimCelebration(blocked, 'a', 'first-image', fallback), false);
  assert.equal(claimCelebration(blocked, 'a', 'onboarding', fallback), true);
});

test('drag tilt follows horizontal velocity, clamps to three degrees and ignores bad samples', () => {
  assert.equal(dragTilt(8, 16), 1); assert.equal(dragTilt(-8, 16), -1);
  assert.equal(dragTilt(1000, 1), 3); assert.equal(dragTilt(-1000, 1), -3);
  for (const [x, time] of [[0, 16], [50, 0], [50, -1], [NaN, 16], [Infinity, 16]]) assert.equal(dragTilt(x, time), 0);
});

async function overlayHarness(t, reduced = false) {
  const previous = { document: globalThis.document, matchMedia: globalThis.matchMedia }, animations = [], listeners = new Map();
  const element = () => ({
    style: {}, children: [], className: '', setAttribute() {}, querySelector() { return null; },
    getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 80 }; },
    appendChild(child) { child.parentElement = this; this.children.push(child); },
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; },
    replaceChildren() { for (const child of [...this.children]) child.remove(); },
    animate(frames) { const animation = { frames, cancel() { this.oncancel?.(); } }; animations.push(animation); return animation; },
  });
  globalThis.document = { hidden: false, body: element(), createElement: element, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  globalThis.matchMedia = () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} });
  const { mountFeelOverlay, fireFeel } = await import('../src/feel.mjs');
  const cleanup = mountFeelOverlay(), layer = document.body.children[0];
  t.after(() => { cleanup(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  return { fireFeel, layer, element, animations, listeners };
}

test('bursts stay bounded, remove finished elements, and cancel on tab hide', async t => {
  const ui = await overlayHarness(t);
  ui.fireFeel('arrival', { element: ui.element() });
  assert.equal(ui.layer.children.filter(child => child.className.startsWith('feel-particle')).length, 16);
  for (const animation of [...ui.animations]) animation.onfinish?.();
  assert.equal(ui.layer.children.length, 0);
  ui.fireFeel('first-image', { element: ui.element() });
  assert.equal(ui.layer.children.filter(child => child.className.startsWith('feel-particle')).length, 36);
  document.hidden = true; ui.listeners.get('visibilitychange')();
  assert.equal(ui.layer.children.length, 0);
  ui.fireFeel('arrival', { element: ui.element() }); assert.equal(ui.layer.children.length, 0);
});

test('reduced motion keeps colour/opacity feedback without particles, shaking or scaling', async t => {
  const ui = await overlayHarness(t, true);
  for (const name of ['arrival', 'first-image', 'onboarding', 'error', 'pickup', 'drop', 'connect', 'create']) ui.fireFeel(name, { element: ui.element() });
  ui.fireFeel('remove', { rects: [{ left: 10, top: 20, width: 100, height: 80 }] });
  assert.ok(ui.layer.children.length > 0);
  assert.equal(ui.layer.children.some(child => child.className.startsWith('feel-particle')), false);
  for (const animation of ui.animations) for (const frame of animation.frames) assert.equal(frame.transform, undefined);
});
