import test from 'node:test';
import assert from 'node:assert/strict';
import { startAnalytics, track, setAnalyticsEnabled, analyticsPreferenceKey, analyticsReady } from '../src/analytics.mjs';

function setup(t) {
  const values = new Map([[analyticsPreferenceKey, 'off']]), requests = [], beacons = [], intervals = new Map(), idle = [];
  let nextTimer = 0, observers = 0;
  const window = new EventTarget(), document = new EventTarget();
  Object.assign(document, { hidden: false, referrer: '', documentElement: { lang: 'en', dataset: {} }, body: { nodeType: 1, matches: () => false, querySelectorAll: () => [] }, querySelector: () => null });
  window.requestIdleCallback = callback => idle.push(callback);
  const globals = { window, document, localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    navigator: { platform: 'test', language: 'en', userAgent: 'test', maxTouchPoints: 0, sendBeacon: (url, body) => { beacons.push({ url, body }); return true; } },
    innerWidth: 1400, innerHeight: 900, screen: { width: 1400, height: 900 }, devicePixelRatio: 1, matchMedia: () => ({ matches: false }),
    fetch: async (url, options) => { requests.push({ url, ...options }); return new Response(null, { status: 204 }); },
    MutationObserver: class { constructor() { observers++; } observe() {} disconnect() {} },
    setInterval: fn => { const id = ++nextTimer; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id) };
  const saved = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => { for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { window, values, requests, beacons, intervals, idle, observers: () => observers };
}
test('opt-out creates no observer, recorder, timer or network request; switching on/off is immediate', async t => {
  const env = setup(t), stop = startAnalytics('one@example.com');
  track('must_not_collect'); analyticsReady();
  assert.equal(env.observers(), 0); assert.equal(env.intervals.size, 0); assert.equal(env.idle.length, 0);
  env.window.dispatchEvent(new Event('pagehide')); assert.equal(env.beacons.length, 0);
  setAnalyticsEnabled(true); assert.equal(env.observers(), 1); assert.equal(env.idle.length, 1);
  track('collected'); env.window.dispatchEvent(new Event('pagehide'));
  const before = JSON.parse(await env.beacons[0].body.text());
  assert.ok(before.events.some(event => event.name === 'collected'));
  setAnalyticsEnabled(false); track('must_not_collect_again'); env.window.dispatchEvent(new Event('pagehide'));
  assert.equal(env.intervals.size, 0); assert.equal(env.beacons.length, 1);
  // A pending lazy start checks opt-out again before importing rrweb.
  await env.idle[0](); assert.equal(env.requests.length, 0);
  setAnalyticsEnabled(true); track('resumed'); env.window.dispatchEvent(new Event('pagehide'));
  const after = JSON.parse(await env.beacons[1].body.text());
  assert.equal(after.session, before.session); assert.ok(after.events[0].seq > before.events.at(-1).seq);
  stop();
});
test('opt-out and opt-in propagate from another tab, and logout stops collection', async t => {
  const env = setup(t); setAnalyticsEnabled(true); const stop = startAnalytics('two@example.com');
  env.values.set(analyticsPreferenceKey, 'off');
  const changed = new Event('storage'); changed.key = analyticsPreferenceKey; env.window.dispatchEvent(changed);
  env.window.dispatchEvent(new Event('pagehide')); assert.equal(env.beacons.length, 0); assert.equal(env.intervals.size, 0);
  env.values.set(analyticsPreferenceKey, 'on'); env.window.dispatchEvent(changed);
  track('resumed'); env.window.dispatchEvent(new Event('pagehide')); assert.equal(env.beacons.length, 1);
  stop(); track('after_logout'); env.window.dispatchEvent(new Event('pagehide')); assert.equal(env.beacons.length, 1);
});

test('the browser never queues or sends user values, including arbitrary provider errors or the account email', async t => {
  const env = setup(t); setAnalyticsEnabled(true);
  const email = 'teammate@example.com', secret = 'PRIVATE board content', stop = startAnalytics(email);
  track(`Show prompt: ${secret}`, { message: `The mask on “${secret}” no longer matches the image. Paint it again.` }, 'click');
  track('notify', { message: `Provider echoed ${secret}` }, 'error');
  env.window.dispatchEvent(new Event('pagehide'));
  const payload = JSON.parse(await env.beacons[0].body.text()), encoded = JSON.stringify(payload);
  assert.ok(!encoded.includes(secret)); assert.ok(!encoded.includes(email));
  assert.equal(payload.events.find(event => event.kind === 'click').name, 'Show prompt:');
  assert.equal(payload.events.find(event => event.kind === 'error').details.message, 'Error (details hidden)');
  stop();
});
