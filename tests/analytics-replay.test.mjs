import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { gunzipSync } from 'node:zlib';
import { setImmediate } from 'node:timers/promises';

import { sessionReplayBytes } from '../src/analytics-core.mjs';

let recordSession, chunkBytes, flushMs;
if (nodeModule.registerHooks) {
  const hook = nodeModule.registerHooks({ resolve(specifier, context, next) {
    if (specifier !== '@rrweb/record') return next(specifier, context);
    return { url: 'data:text/javascript,' + encodeURIComponent('export function record(options) { globalThis.__analyticsRecordOptions = options; globalThis.__analyticsRecordStart?.(options); return () => { globalThis.__analyticsRecordStopped = true; }; }'), shortCircuit: true };
  } });
  try { ({ recordSession, chunkBytes, flushMs } = await import('../src/analytics-replay.mjs')); }
  finally { hook.deregister(); }
}
const replayTest = recordSession ? test : test.skip;
// fetch answers at once unless a test holds it; beacons are accepted unless a test refuses them.
function setup(t) {
  const requests = [], beacons = [], timers = new Set(), delays = [], env = { requests, beacons, timers, delays, held: null, refuse: false };
  const values = { navigator: { sendBeacon: (url, body) => { if (env.refuse) return false; beacons.push({ url, body }); return true; } },
    fetch: async (url, options) => { requests.push({ url, ...options }); if (env.held) await env.held; return new Response(null, { status: 204 }); },
    setInterval: (callback, delay) => { timers.add(callback); delays.push(delay); return callback; }, clearInterval: callback => timers.delete(callback), document: { hidden: false }, __analyticsRecordStopped: false };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => { delete globalThis.__analyticsRecordOptions; delete globalThis.__analyticsRecordStart; for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return env;
}
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await setImmediate();
  assert.ok(check(), 'timed out');
}
const settle = async () => { for (let i = 0; i < 50; i++) await setImmediate(); };
const seqOf = url => Number(url.match(/\/(\d+)(?:\?|$)/)[1]);
const rawOf = request => request.headers['Content-Encoding'] === 'gzip' ? gunzipSync(request.body) : Buffer.from(request.body);
const beaconRaw = async item => Buffer.from(await item.body.arrayBuffer());
// Mouse-move events of about `size` bytes each; type 3 / source 1 passes privateReplayEvent unchanged.
function emitBytes(total, size = 1000, from = 0) {
  const lines = [];
  for (let bytes = 0, i = from; bytes < total; i++) {
    const event = { type: 3, timestamp: i, data: { source: 1, positions: [{ x: i % 997, y: i % 613, id: i, timeOffset: 0 }], pad: (i * 7919).toString(36).repeat(size / 8) } };
    globalThis.__analyticsRecordOptions.emit(event); const line = JSON.stringify(event) + '\n'; lines.push(line); bytes += Buffer.byteLength(line);
  }
  return lines.join('');
}
replayTest('recorder masks all inputs, samples gestures, excludes canvas, and preserves UTF-8 split across gzip chunks', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  const options = globalThis.__analyticsRecordOptions;
  assert.deepEqual(options.maskInputOptions, { password: true }); assert.equal(options.maskAllInputs, true);
  assert.equal(options.maskInputFn, undefined); assert.equal(options.maskTextFn, undefined);
  for (const selector of ['img', 'video', 'canvas']) assert.ok(options.blockSelector.split(',').includes(selector));
  for (const selector of ['[data-analytics-private]', '.react-flow', '.board-picker', '.board-page-name', '.board-page-input', '.board-page-people', '.cloud-board-section', '.canvas-top > span', '.history-list', '.generation-tray', '.run-diagnostics', '.board-modal:not(:has(.theme-button))', '.custom-nodes', '.template-editor', '.template-details', '.lightbox', '.image-editor', '.board-chat-panel', '.voice-panel', '.cloud-presence', '.cloud-cursor', '.account-menu', '.attention-card', '.codex-share-panel', '.codex-requests', '.codex-teammates', '.board-author', '[role="tooltip"]', 'head title']) assert.ok(options.maskTextSelector.split(',').includes(selector), selector);
  assert.equal(options.recordCanvas, false); assert.equal(options.inlineImages, false);
  assert.deepEqual(options.sampling, { mousemove: 50, scroll: 150, input: 'last' });
  // The JSON prefix has an odd length, so the 1 MiB cut falls inside a two-byte character.
  const event = { type: 2, timestamp: 10, data: { text: 'ї'.repeat(600000) } };
  assert.equal(JSON.stringify(event).indexOf('ї') % 2, 1);
  options.emit(event); recorder.flush();
  await until(() => env.requests.length === 2);
  assert.ok(env.requests.every(request => request.headers['Content-Encoding'] === 'gzip'));
  const [first, second] = env.requests.map(rawOf);
  assert.equal(first.length, chunkBytes); assert.ok(first.toString().endsWith('�'));
  assert.deepEqual(JSON.parse(Buffer.concat([first, second]).toString()), event);
});
replayTest('slow uploads and overlapping flushes never send a chunk uncompressed or out of order', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  let release; env.held = new Promise(resolve => { release = resolve; });
  let expected = emitBytes(1.5 * chunkBytes);
  await until(() => env.requests.length === 1);
  // While the first upload hangs: timer ticks, a visible flush, and a second full chunk, as on a busy board.
  for (const tick of env.timers) tick();
  expected += emitBytes(200 * 1024, 1000, 1e6); recorder.flush();
  expected += emitBytes(1.2 * chunkBytes, 1000, 2e6);
  for (const tick of env.timers) tick();
  await settle();
  env.held = null; release();
  recorder.flush();
  const total = Buffer.byteLength(expected);
  await until(() => env.requests.reduce((sum, request) => sum + rawOf(request).length, 0) === total);
  assert.ok(env.requests.every(request => request.headers['Content-Encoding'] === 'gzip'), env.requests.map(request => request.headers['Content-Encoding']).join());
  assert.deepEqual(env.requests.map(request => seqOf(request.url)), env.requests.map((_, i) => i));
  assert.equal(Buffer.concat(env.requests.map(rawOf)).toString(), expected);
  assert.ok(env.requests.every(request => rawOf(request).length <= chunkBytes));
  assert.equal(state.replayBytes, env.requests.reduce((sum, request) => sum + request.body.length, 0));
});
replayTest('a busy minute of events goes up as one gzip chunk per MiB, not one per 48 KB', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  const expected = emitBytes(3.2 * chunkBytes); recorder.flush();
  const total = Buffer.byteLength(expected);
  await until(() => env.requests.reduce((sum, request) => sum + rawOf(request).length, 0) === total);
  assert.equal(env.requests.length, Math.ceil(total / chunkBytes)); assert.ok(env.requests.length * 10 < total / (48 * 1024));
  assert.deepEqual(env.requests.slice(0, -1).map(request => rawOf(request).length), [chunkBytes, chunkBytes, chunkBytes]);
  assert.ok(env.requests.every(request => request.headers['Content-Encoding'] === 'gzip'));
  // The server counts uploaded body bytes towards the session quota, and so does the client, next to the raw bytes.
  assert.equal(state.replayBytes, env.requests.reduce((sum, request) => sum + request.body.length, 0));
  assert.ok(state.replayBytes < total / 2); assert.equal(state.replayRawBytes, total);
});
replayTest('the raw quota ends a recording at 50 MB of events however well they compress, and queued chunks still go up', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0, replayRawBytes: sessionReplayBytes - 1.5 * chunkBytes }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  // Chunk 0 is queued while chunk 1 is gzipped and crosses the quota.
  const expected = emitBytes(3 * chunkBytes);
  await until(() => env.requests.length === 1); await settle();
  assert.equal(env.requests.length, 1); assert.equal(rawOf(env.requests[0]).toString(), expected.slice(0, chunkBytes));
  assert.equal(globalThis.__analyticsRecordStopped, true);
  assert.equal(state.replayRawBytes, sessionReplayBytes - chunkBytes / 2); assert.ok(state.replayBytes < chunkBytes / 2);
  emitBytes(10 * 1024, 1000, 1e6); recorder.flush(); recorder.flush(true); await settle();
  assert.equal(env.requests.length, 1); assert.equal(env.beacons.length, 0); assert.equal(state.replaySeq, 1);
});
replayTest('a quota reached during the first snapshot, before record() returns, still stops rrweb', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0, replayRawBytes: sessionReplayBytes - chunkBytes / 2 };
  // Without CompressionStream the cut runs synchronously inside rrweb's first emit.
  const saved = globalThis.CompressionStream; globalThis.CompressionStream = undefined; t.after(() => { globalThis.CompressionStream = saved; });
  globalThis.__analyticsRecordStart = options => options.emit({ type: 2, timestamp: 1, data: { text: 'x'.repeat(chunkBytes) } });
  const recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  assert.equal(globalThis.__analyticsRecordStopped, true); assert.equal(state.replaySeq, 0); assert.equal(env.requests.length, 0);
});
replayTest('leaving the page beacons nothing past the raw quota', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0, replayRawBytes: sessionReplayBytes - 10 * 1024 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  emitBytes(20 * 1024); recorder.flush(true);
  assert.equal(env.beacons.length, 0); assert.equal(state.replaySeq, 0); assert.equal(globalThis.__analyticsRecordStopped, true);
});
replayTest('a visible tab uploads on a 2-minute timer, which skips a period in which a chunk filled up', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  assert.equal(flushMs, 2 * 60000); assert.deepEqual(env.delays, [flushMs]);
  let expected = emitBytes(10 * 1024);
  for (const tick of env.timers) tick();
  await until(() => env.requests.length === 1);
  expected += emitBytes(1.2 * chunkBytes, 1000, 1e6);
  await until(() => env.requests.length === 2);
  assert.equal(rawOf(env.requests[1]).length, chunkBytes);
  // That period already uploaded, so its tick waits, and the next one sends the rest.
  for (const tick of env.timers) tick();
  await settle();
  assert.equal(env.requests.length, 2);
  for (const tick of env.timers) tick();
  await until(() => env.requests.length === 3);
  assert.equal(Buffer.concat(env.requests.map(rawOf)).toString(), expected);
});
replayTest('pagehide beacons a small raw piece, and if the page lives on, the next upload confirms it before the rest', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  const expected = emitBytes(150 * 1024);
  recorder.flush(true);
  assert.equal(env.requests.length, 0); assert.equal(env.beacons.length, 1);
  assert.equal(env.beacons[0].url, '/api/analytics/replay/session/0?encoding=identity');
  const beaconed = await beaconRaw(env.beacons[0]);
  assert.equal(beaconed.length, 48 * 1024); assert.equal(state.replaySeq, 1); assert.equal(state.replayBytes, 48 * 1024);
  // Back from the back/forward cache: seq 0 goes up again unchanged, which the server answers without writing.
  recorder.flush();
  await until(() => env.requests.length === 2);
  assert.deepEqual(env.requests.map(request => [seqOf(request.url), request.headers['Content-Encoding']]), [[0, 'identity'], [1, 'gzip']]);
  assert.deepEqual(Buffer.from(env.requests[0].body), beaconed);
  assert.equal(Buffer.concat([beaconed, rawOf(env.requests[1])]).toString(), expected);
  assert.equal(state.replayBytes, 48 * 1024 + env.requests[1].body.length); assert.equal(state.replayRawBytes, Buffer.byteLength(expected));
  // Confirmed now, so neither another upload nor leaving again sends it.
  recorder.flush(); recorder.flush(true); await settle();
  assert.equal(env.requests.length, 2); assert.equal(env.beacons.length, 1);
});
replayTest('a refused beacon spends no seq, so the recording has no gap and nothing is lost', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  const expected = emitBytes(20 * 1024);
  env.refuse = true; recorder.flush(true);
  assert.equal(state.replaySeq, 0); assert.equal(state.replayBytes, 0);
  env.refuse = false; recorder.flush();
  await until(() => env.requests.length === 1);
  assert.equal(seqOf(env.requests[0].url), 0); assert.equal(rawOf(env.requests[0]).toString(), expected);
});
replayTest('a hidden tab skips the timer, flush() uploads all of it as gzip while hidden, and leaving then sends nothing', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  globalThis.document.hidden = true;
  let expected = emitBytes(400 * 1024);
  for (let i = 0; i < 3; i++) for (const tick of env.timers) tick();
  await settle();
  assert.equal(env.requests.length, 0);
  expected += emitBytes(chunkBytes, 1000, 1e6);
  await until(() => env.requests.length === 1);
  assert.equal(rawOf(env.requests[0]).length, chunkBytes);
  // analytics.mjs calls flush() once the tab has stayed hidden for a while: the rest goes up the normal way, not beaconed.
  recorder.flush();
  await until(() => env.requests.length === 2);
  assert.ok(env.requests.every(request => request.headers['Content-Encoding'] === 'gzip'));
  assert.equal(Buffer.concat(env.requests.map(rawOf)).toString(), expected);
  // Nothing was recorded since that upload, so pagehide beacons nothing.
  recorder.flush(true);
  assert.equal(env.beacons.length, 0);
});
replayTest('leaving twice beacons a queued chunk once, in seq order before newer events, and a page that lives on confirms both', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  let release; env.held = new Promise(resolve => { release = resolve; });
  const before = emitBytes(10 * 1024); recorder.flush();
  await until(() => env.requests.length === 1);
  recorder.flush(true);
  const after = emitBytes(5 * 1024, 1000, 1e6); recorder.flush(true);
  assert.deepEqual(env.beacons.map(item => item.url), ['/api/analytics/replay/session/0?encoding=gzip', '/api/analytics/replay/session/1?encoding=identity']);
  assert.equal(gunzipSync(await beaconRaw(env.beacons[0])).toString(), before); assert.equal((await beaconRaw(env.beacons[1])).toString(), after);
  // The held upload of seq 0 finishes, so the page is still there: seq 1 goes up again with the same bytes and encoding.
  env.held = null; release();
  await until(() => env.requests.length === 2); await settle();
  assert.equal(env.requests.length, 2); assert.equal(seqOf(env.requests[1].url), 1); assert.equal(env.requests[1].headers['Content-Encoding'], 'identity');
  assert.equal(Buffer.from(env.requests[1].body).toString(), after); assert.equal(state.replaySeq, 2);
});
replayTest('pagehide cannot reorder or change the encoding of chunks being compressed', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  const first = { type: 2, timestamp: 1, data: { text: 'ї'.repeat(30000) } }, second = { type: 3, timestamp: 2, data: {} };
  globalThis.__analyticsRecordOptions.emit(first); recorder.flush();
  globalThis.__analyticsRecordOptions.emit(second); recorder.flush(true);
  assert.deepEqual(env.beacons.map(item => seqOf(item.url)), [0, 1]);
  const raw = Buffer.concat(await Promise.all(env.beacons.map(beaconRaw)));
  assert.deepEqual(raw.toString().trim().split('\n').map(line => JSON.parse(line)), [first, second]);
  assert.ok(env.beacons.every(item => item.url.endsWith('?encoding=identity')));
  // The gzip that was running when the page left is dropped: only the beaconed pieces go up again, unchanged.
  await until(() => env.requests.length === 2); await settle();
  assert.equal(env.requests.length, 2);
  assert.deepEqual(env.requests.map(request => [seqOf(request.url), request.headers['Content-Encoding']]), [[0, 'identity'], [1, 'identity']]);
  assert.deepEqual(env.requests.map(request => Buffer.from(request.body)), await Promise.all(env.beacons.map(beaconRaw)));
  assert.equal(state.replaySeq, 2);
});
replayTest('stopping on opt-out cancels recorder, timers and queued uploads', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  globalThis.__analyticsRecordOptions.emit({ type: 2, timestamp: 1, data: {} });
  recorder.stop(); recorder.flush(true);
  assert.equal(env.timers.size, 0); assert.equal(globalThis.__analyticsRecordStopped, true); assert.equal(env.beacons.length, 0);
});

replayTest('serialized private attributes are removed before a replay chunk enters the network queue', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  const secret = 'PRIVATE replay content';
  globalThis.__analyticsRecordOptions.emit({ type: 2, timestamp: 1, data: { node: { type: 2, id: 1,
    attributes: { class: 'board-page', title: secret, value: secret, href: `https://example.com/${secret}` }, childNodes: [{ type: 3, id: 2, textContent: '******' }] } } });
  recorder.flush(true);
  const payload = await env.beacons[0].body.text();
  assert.ok(!payload.includes(secret)); assert.ok(!payload.includes('https://example.com'));
  assert.equal(JSON.parse(payload).data.node.attributes.class, 'board-page');
});
replayTest('the first full snapshot uploads at once, so a tab closed before the first timer tick still plays', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  const snapshot = { type: 2, timestamp: 1, data: { node: { type: 0, childNodes: [], id: 1 }, pad: 'x'.repeat(300 * 1024) } };
  globalThis.__analyticsRecordOptions.emit({ type: 4, timestamp: 0, data: { href: 'https://concept.test/', width: 1, height: 1 } });
  globalThis.__analyticsRecordOptions.emit(snapshot);
  await until(() => env.requests.length === 1);
  const lines = rawOf(env.requests[0]).toString().trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(event => event.type), [4, 2]); assert.equal(env.requests[0].headers['Content-Encoding'], 'gzip');
});
