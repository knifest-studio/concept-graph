import test from 'node:test';
import assert from 'node:assert/strict';
import { controlName, rageDetector, shortcut, sanitizeEvent, validateBatch, replayKey, replaySequence, retentionCutoffs, splitEvents, eventBytes, byteLength, details } from '../src/analytics-core.mjs';

const session = '12345678-1234-1234-1234-123456789abc';
const event = (seq = 0) => ({ seq, kind: 'click', name: 'Generate', time: Date.now(), area: 'top-bar', details: { x: .5, y: .6 } });
test('control names prefer accessible label, tooltip, bounded text, then a stable fallback', () => {
  assert.equal(controlName({ ariaLabel: ' Generate ', tooltip: 'x' }), 'Generate');
  assert.equal(controlName({ tooltip: 'Crop', text: 'x' }), 'Crop');
  assert.equal(controlName({ text: 'a'.repeat(100) }).length, 60);
  assert.equal(controlName({ tag: 'input', type: 'checkbox' }), 'input[type=checkbox]');
});
test('rage clicks require three nearby clicks within a second and do not count distant clicks', () => {
  const rage = rageDetector();
  assert.equal(rage({ x: 0, y: 0, time: 0 }), false);
  assert.equal(rage({ x: 15, y: 0, time: 300 }), false);
  assert.equal(rage({ x: 20, y: 0, time: 800 }), true);
  assert.equal(rage({ x: 20, y: 0, time: 900 }), false);
  assert.equal(rage({ x: 80, y: 0, time: 1000 }), false);
});
test('shortcuts never log ordinary typing, composition or AltGr input', () => {
  assert.equal(shortcut({ key: 'a' }, true), '');
  assert.equal(shortcut({ key: 'é', altKey: true }, true), '');
  assert.equal(shortcut({ key: '@', altKey: true, ctrlKey: true }, true), '');
  assert.equal(shortcut({ key: 'z', metaKey: true, shiftKey: true }, true), 'Cmd+Shift+Z');
  assert.equal(shortcut({ key: 'Enter', ctrlKey: true }, true), 'Ctrl+Enter');
  assert.equal(shortcut({ key: 'p' }), 'P');
  assert.equal(shortcut({ key: 'e' }), 'E');
  assert.equal(shortcut({ key: 'І', code: 'KeyS', shiftKey: true }), 'Shift+S');
  assert.equal(shortcut({ key: 'p', repeat: true }), '');
  assert.equal(shortcut({ key: 'p', isComposing: true }), '');
});
test('discovery analytics retains only bounded UI fields, never user-authored content', () => {
  for (const [name, fields] of [
    ['theme_changed', { to: 'system', source: 'settings' }],
    ['theme_changed', { to: 'dark', source: 'system' }],
    ...['menu', 'getting_started', 'shortcuts', 'whats_new'].map(item => ['help_opened', { item, via: 'key' }]),
    ...['sidebar', 'node_toolbar', 'context_menu', 'tip', 'invite', 'copy'].map(source => ['template_created', { source }]),
    ...['sidebar_click', 'sidebar_drag', 'node_type'].map(source => ['template_applied', { source }]),
    ...['duplicate_to_custom_node', 'custom_nodes_invite'].flatMap(tip => ['shown', 'accepted', 'dismissed'].map(action => ['tip_event', { tip, action }]))
  ]) {
    const clean = sanitizeEvent({ ...event(), kind: 'app', name, details: { ...fields, prompt: 'PRIVATE', templateName: 'PRIVATE', instructions: 'PRIVATE', boardName: 'PRIVATE', image: 'PRIVATE' } });
    assert.deepEqual(clean.details, fields, name);
  }
  assert.deepEqual(details({ to: 'PRIVATE', source: 'PRIVATE', item: 'PRIVATE', tip: 'PRIVATE', action: 'PRIVATE' }), {});
});
test('event boundary strips identity, raw input and arbitrary nested fields and clamps numbers', () => {
  const clean = sanitizeEvent({ ...event(), user: 'forged', board: '../secret', name: 'a'.repeat(100), time: Infinity,
    details: { user: 'forged', text: 'typed text', password: 'secret', nested: { x: 1 }, x: 5, y: -2, width: 1e9, zoom: NaN, message: 'm'.repeat(2000) } }, 100000000);
  assert.equal(clean.name.length, 80); assert.equal(clean.board, ''); assert.equal(clean.time, 100000000);
  assert.equal(clean.details.x, 1); assert.equal(clean.details.y, 0); assert.equal(clean.details.width, 16384);
  assert.equal(clean.details.message, 'Error (details hidden)'); assert.equal(clean.details.zoom, undefined);
  assert.equal(clean.user, undefined); assert.equal(clean.details.password, undefined); assert.equal(clean.details.text, undefined);
  assert.equal(sanitizeEvent({ ...event(), seq: -1 }), null);
  assert.equal(sanitizeEvent({ ...event(), kind: 'arbitrary' }), null);
  assert.deepEqual(details(null), {});
});
test('batch validation and byte splitting respect UTF-8 size and 200 events', () => {
  assert.throws(() => validateBatch({ session: '../path', events: [event()] }));
  assert.throws(() => validateBatch({ session, events: Array.from({length:201}, (_,i) => event(i)) }));
  const input = Array.from({length:650}, (_,i) => ({ ...event(i), details: { message: 'ї'.repeat(1000) } }));
  const batches = splitEvents(session, input);
  assert.equal(batches.flat().length, 650);
  for (const events of batches) { assert.ok(events.length <= 200); assert.ok(byteLength(JSON.stringify({ session, events })) <= eventBytes); }
});
test('replay keys and retention cutoffs cannot traverse storage paths', () => {
  assert.equal(replayKey('2026-11-13', session, 12), `analytics/replays/2026-11-13/${session}/000012`);
  assert.throws(() => replayKey('../secret', session, 0));
  assert.throws(() => replayKey('2026-11-13', '../secret', 0));
  assert.equal(replaySequence('01'), null); assert.equal(replaySequence(-1), null); assert.equal(replaySequence(999999), 999999);
  assert.deepEqual(retentionCutoffs(200 * 86400000), { replays: 170 * 86400000, events: 20 * 86400000 });
});
