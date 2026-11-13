import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { gunzipSync } from 'node:zlib';
import { setImmediate } from 'node:timers/promises';

let recordSession;
if (nodeModule.registerHooks) {
  const hook = nodeModule.registerHooks({ resolve(specifier, context, next) {
    if (specifier !== '@rrweb/record') return next(specifier, context);
    return { url: 'data:text/javascript,' + encodeURIComponent('export function record(options) { globalThis.__analyticsRecordOptions = options; return () => { globalThis.__analyticsRecordStopped = true; }; }'), shortCircuit: true };
  } });
  try { ({ recordSession } = await import('../src/analytics-replay.mjs')); }
  finally { hook.deregister(); }
}
const replayTest = recordSession ? test : test.skip;
function setup(t) {
  const requests = [], beacons = [], timers = new Set();
  const values = { navigator: { sendBeacon: (url, body) => { beacons.push({ url, body }); return true; } },
    fetch: async (url, options) => { requests.push({ url, ...options }); return new Response(null, { status: 204 }); },
    setInterval: callback => { timers.add(callback); return callback; }, clearInterval: callback => timers.delete(callback), __analyticsRecordStopped: false };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => { delete globalThis.__analyticsRecordOptions; for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { requests, beacons, timers };
}
replayTest('recorder masks passwords, samples gestures, excludes canvas, and preserves UTF-8 through gzip fragments', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  const options = globalThis.__analyticsRecordOptions;
  assert.deepEqual(options.maskInputOptions, { password: true }); assert.equal(options.maskAllInputs, false);
  assert.equal(options.recordCanvas, false); assert.equal(options.inlineImages, false);
  assert.deepEqual(options.sampling, { mousemove: 50, scroll: 150, input: 'last' });
  const event = { type: 2, timestamp: Date.now(), data: { text: 'ї'.repeat(30000) } };
  options.emit(event); recorder.flush();
  const deadline = Date.now() + 2000;
  while (env.requests.length < 2 && Date.now() < deadline) await setImmediate();
  assert.equal(env.requests.length, 2);
  const raw = Buffer.concat(env.requests.map(request => request.headers['Content-Encoding'] === 'gzip' ? gunzipSync(request.body) : Buffer.from(request.body)));
  assert.deepEqual(JSON.parse(raw.toString()), event);
  assert.ok(env.requests.every(request => request.body.byteLength <= 48 * 1024));
});
replayTest('pagehide cannot reorder or change the encoding of chunks being compressed', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  t.after(() => recorder.stop());
  const first = { type: 2, timestamp: 1, data: { text: 'ї'.repeat(30000) } }, second = { type: 3, timestamp: 2, data: {} };
  globalThis.__analyticsRecordOptions.emit(first); recorder.flush();
  globalThis.__analyticsRecordOptions.emit(second); recorder.flush(true);
  assert.deepEqual(env.beacons.map(item => item.url.match(/\/(\d+)\?/)[1]), ['0','1','2']);
  const raw = Buffer.concat(await Promise.all(env.beacons.map(async item => Buffer.from(await item.body.arrayBuffer()))));
  assert.deepEqual(raw.toString().trim().split('\n').map(line => JSON.parse(line)), [first,second]);
  assert.ok(env.beacons.every(item => item.url.endsWith('?encoding=identity')));
});
replayTest('stopping on opt-out cancels recorder, timers and queued uploads', async t => {
  const env = setup(t), state = { replaySeq: 0, replayBytes: 0 }, recorder = await recordSession('session', () => true, state);
  globalThis.__analyticsRecordOptions.emit({ type: 2, timestamp: 1, data: {} });
  recorder.stop(); recorder.flush(true);
  assert.equal(env.timers.size, 0); assert.equal(globalThis.__analyticsRecordStopped, true); assert.equal(env.beacons.length, 0);
});
