import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import viteConfig from '../vite.config.js';
import { controlName, rageDetector, shortcut, shortcutControl, sanitizeEvent, validateBatch, replayKey, replaySequence, retentionCutoffs, splitEvents, eventBytes, byteLength, details } from '../src/analytics-core.mjs';

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
test('shortcuts log only the action IDs the app handles, never ordinary typing, composition or AltGr input', () => {
  const typing = { editing: true, mac: true }, canvas = { mac: true };
  assert.equal(shortcut({ key: 'a' }, typing), '');
  assert.equal(shortcut({ key: 'p' }, typing), '');
  assert.equal(shortcut({ key: 'é', altKey: true }, typing), '');
  assert.equal(shortcut({ key: '@', altKey: true, ctrlKey: true }, typing), '');
  // Undo inside a text field is the field's own, not the board's.
  assert.equal(shortcut({ key: 'z', metaKey: true, shiftKey: true }, typing), '');
  assert.equal(shortcut({ key: 'z', metaKey: true, shiftKey: true }, canvas), 'edit.redo');
  assert.equal(shortcut({ key: 'Enter', ctrlKey: true }, typing), 'prompt.generate');
  assert.equal(shortcut({ key: 'Enter', ctrlKey: true }, canvas), '');
  assert.equal(shortcut({ key: 'p' }, canvas), 'tool.pen');
  assert.equal(shortcut({ key: 'e' }, canvas), 'tool.stamp');
  assert.equal(shortcut({ key: 'І', code: 'KeyS', shiftKey: true }, canvas), 'section.wrap');
  assert.equal(shortcut({ key: 'я', code: 'KeyZ', metaKey: true }, canvas), 'edit.undo');
  assert.equal(shortcut({ key: 'q' }, canvas), '');
  assert.equal(shortcut({ key: 'z', metaKey: true, repeat: true }, canvas), '');
  assert.equal(shortcut({ key: 'p', isComposing: true }, canvas), '');
  assert.equal(shortcutControl('edit.undo'), 'Undo'); assert.equal(shortcutControl('prompt.generate'), 'Generate'); assert.equal(shortcutControl('group.create'), 'group.create');
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
test('every build names its version in the meta that session_start reads', async () => {
  const plugin = viteConfig.plugins.find(plugin => plugin.name === 'concept-graph-version'), [tag] = plugin.transformIndexHtml();
  const emitted = []; plugin.generateBundle.call({ emitFile: asset => emitted.push(asset) });
  assert.equal(emitted[0].fileName, 'version.json'); assert.deepEqual(JSON.parse(emitted[0].source), { version: tag.attrs.content });
  assert.equal(plugin.apply, 'build');
  assert.equal(tag.tag, 'meta'); assert.equal(tag.injectTo, 'head'); assert.equal(tag.attrs.name, 'concept-graph-version');
  assert.match(tag.attrs.content, /^[\da-f]{7,}(?:-dirty)?$|^\d+\.\d+\.\d+\+\d{8}T\d{6}Z$/);
  assert.ok((await readFile(new URL('../src/analytics.mjs', import.meta.url), 'utf8')).includes(`meta[name="${tag.attrs.name}"]`));
  assert.equal(sanitizeEvent({ ...event(), kind: 'session', name: 'session_start', details: { version: tag.attrs.content } }).details.version, tag.attrs.content);
});

test('repeatable controls never count toward rage and clear a nearby burst', () => {
  const rage = rageDetector(), click = (time, repeat = false) => rage({ x: 20, y: 20, time, repeat });
  assert.equal(click(0), false); assert.equal(click(100), false);
  for (const time of [200, 300, 400, 500]) assert.equal(click(time, true), false);
  assert.equal(click(600), false); assert.equal(click(700), false); assert.equal(click(800), true);
});
test('voice diagnostics keep candidate kinds, a relay flag and a state, and drop anything address-like', () => {
  assert.deepEqual(details({ local: 'host,srflx', remote: 'relay', path: 'srflx-relay', turn: true, status: 'failed/failed/stable', errorKind: 'ice_failed', count: 2, duration: 30000 }),
    { local: 'host,srflx', remote: 'relay', path: 'srflx-relay', turn: true, status: 'failed/failed/stable', errorKind: 'ice_failed', count: 2, duration: 30000 });
  assert.deepEqual(details({ local: '192.168.1.5', remote: 'host,203.0.113.7', path: 'host-host-host', turn: 'yes' }), {});
  assert.deepEqual(details({ sent: 400, received: 390, lost: -1, energyIn: .8, energyOut: 1.5, trackMuted: false, muted: true, paused: false, readyState: 4 }),
    { sent: 400, received: 390, lost: 0, energyIn: .8, energyOut: 1.5, trackMuted: false, muted: true, paused: false, readyState: 4 });
});
