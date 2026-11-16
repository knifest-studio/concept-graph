import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { startAnalytics, track, setAnalyticsEnabled, analyticsPreferenceKey, analyticsReady } from '../src/analytics.mjs';

function setup(t, { alerts = [] } = {}) {
  const values = new Map([[analyticsPreferenceKey, 'off']]), requests = [], beacons = [], intervals = new Map(), timeouts = new Map(), idle = [], mutations = [];
  let nextTimer = 0, observers = 0;
  // The tab's clock moves only when a test says so.
  const clock = { now: Date.parse('2026-11-16T11:00:00Z') }, realNow = Date.now;
  Date.now = () => clock.now; t.after(() => { Date.now = realNow; });
  const window = new EventTarget(), document = new EventTarget();
  Object.assign(document, { hidden: false, referrer: '', documentElement: { lang: 'en', dataset: {} }, body: { nodeType: 1, matches: () => false, querySelectorAll: () => alerts },
    querySelector: selector => selector === 'meta[name="concept-graph-version"]' ? { content: '6bcce86' } : null });
  window.requestIdleCallback = callback => idle.push(callback);
  const globals = { window, document, localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    navigator: { platform: 'test', language: 'en', userAgent: 'test', maxTouchPoints: 0, sendBeacon: (url, body) => { beacons.push({ url, body }); return true; } },
    innerWidth: 1400, innerHeight: 900, screen: { width: 1400, height: 900 }, devicePixelRatio: 1, matchMedia: () => ({ matches: false }),
    fetch: async (url, options) => { requests.push({ url, ...options }); return new Response(null, { status: 204 }); },
    location: { origin: 'https://concept.test', href: 'https://concept.test/' },
    MutationObserver: class { constructor(callback) { observers++; mutations.push(callback); } observe() {} disconnect() {} },
    setInterval: fn => { const id = ++nextTimer; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    setTimeout: (fn, delay) => { const id = ++nextTimer; timeouts.set(id, { fn, delay, due: clock.now + delay }); return id; }, clearTimeout: id => timeouts.delete(id) };
  const saved = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(() => { for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  // Everything the tab sent, by beacon or fetch, in order.
  const sent = async () => (await Promise.all([...beacons.map(beacon => beacon.body.text()), ...requests.filter(request => request.url === '/api/analytics/events').map(request => request.body)])).flatMap(body => JSON.parse(body).events).sort((a, b) => a.seq - b.seq);
  // Moves the clock and runs the timers that fall due on the way, as the browser would; the minute timers run on whole
  // minutes since the tab opened at 11:00.
  const advance = async ms => {
    for (const end = clock.now + ms; clock.now < end;) {
      const minute = clock.now + 60000 - (clock.now - Date.parse('2026-11-16T11:00:00Z')) % 60000;
      clock.now = Math.min(minute, end, ...[...timeouts.values()].map(timeout => timeout.due).filter(due => due > clock.now));
      for (const [id, { fn, due }] of [...timeouts]) if (due <= clock.now) { timeouts.delete(id); fn(); }
      if (clock.now === minute) for (const fn of [...intervals.values()]) fn();
      await new Promise(resolve => setImmediate(resolve));
    }
  };
  const posted = () => requests.filter(request => request.url === '/api/analytics/events').length;
  return { window, document, values, requests, beacons, intervals, timeouts, idle, mutations, sent, clock, advance, posted, observers: () => observers };
}
const hide = (env, hidden) => { env.document.hidden = hidden; env.document.dispatchEvent(new Event('visibilitychange')); };
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
test('discovery events use the existing cloud pipeline and stop immediately on opt-out', async t => {
  const env = setup(t), report = () => {
    track('theme_changed', { to: 'dark', source: 'settings' });
    track('help_opened', { item: 'shortcuts', via: 'key' });
    track('template_created', { source: 'copy' });
    track('template_applied', { source: 'sidebar_drag' });
    track('tip_event', { tip: 'custom_nodes_invite', action: 'accepted' });
  };
  report(); env.window.dispatchEvent(new Event('pagehide')); assert.equal(env.beacons.length, 0);
  setAnalyticsEnabled(true); const stop = startAnalytics('discovery@example.com'); report();
  env.window.dispatchEvent(new Event('pagehide'));
  const payload = JSON.parse(await env.beacons[0].body.text());
  for (const name of ['theme_changed', 'help_opened', 'template_created', 'template_applied', 'tip_event']) assert.ok(payload.events.some(event => event.name === name), name);
  assert.equal(payload.events.find(event => event.name === 'template_created').details.source, 'copy');
  setAnalyticsEnabled(false); report(); env.window.dispatchEvent(new Event('pagehide')); assert.equal(env.beacons.length, 1);
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

test('a heartbeat is sent only while the tab is visible and was used since the last one; leaving still reports time', async t => {
  const env = setup(t); setAnalyticsEnabled(true); const stop = startAnalytics('hidden@example.com');
  await env.advance(60000); // The first minute counts as used.
  await env.advance(120000); // Nobody touched the tab for two minutes: no heartbeat.
  env.document.dispatchEvent(new Event('pointermove')); await env.advance(60000);
  hide(env, true); await env.advance(180000);
  hide(env, false); await env.advance(60000);
  hide(env, true); env.window.dispatchEvent(new Event('pagehide')); // Closed while hidden, before the delayed upload.
  const events = await env.sent(), session = events.filter(event => event.kind === 'session').map(event => `${event.name}${event.name === 'visibility' ? `:${event.details.visible}` : ''}`);
  assert.deepEqual(session, ['session_start', 'heartbeat', 'heartbeat', 'visibility:false', 'visibility:true', 'heartbeat', 'visibility:false', 'session_end']);
  for (const event of events.filter(event => event.kind === 'session' && event.name !== 'session_start')) { assert.equal(typeof event.details.duration, 'number', event.name); assert.equal(typeof event.details.active, 'number', event.name); }
  assert.deepEqual(events.filter(event => event.name === 'session_end').map(event => [event.details.duration, event.details.active]), [[480000, 180000]]);
  assert.equal(events.find(event => event.name === 'session_start').details.version, '6bcce86');
  stop();
});

test('a tab switch is reported and uploaded only once the tab stays hidden for 30 s; leaving the page beacons at once', async t => {
  const env = setup(t), flushes = [];
  let stub;
  if (nodeModule.registerHooks) stub = nodeModule.registerHooks({ resolve(specifier, context, next) {
    if (specifier !== './analytics-replay.mjs' || !context.parentURL?.endsWith('/src/analytics.mjs')) return next(specifier, context);
    return { url: 'data:text/javascript,' + encodeURIComponent('export async function recordSession() { return { stop() {}, flush(...args) { globalThis.__replayFlushes.push(args); } }; }'), shortCircuit: true };
  } });
  globalThis.__replayFlushes = flushes; t.after(() => { delete globalThis.__replayFlushes; });
  setAnalyticsEnabled(true); const stop = startAnalytics('switch@example.com'); analyticsReady();
  try { await env.idle.at(-1)(); } finally { stub?.deregister(); }
  await env.advance(60000); const first = env.posted(), start = Date.parse('2026-11-16T11:00:00Z');
  assert.equal(first, 1);
  // A quick switch away and back is not reported: no beacon, no upload, no replay flush, and the delayed upload is cancelled.
  hide(env, true); assert.equal(env.timeouts.size, 1); await env.advance(10000); hide(env, false);
  assert.equal(env.beacons.length, 0); assert.equal(env.posted(), first); assert.equal(env.timeouts.size, 0);
  if (stub) assert.deepEqual(flushes, []);
  // Still hidden after 30 s: the hide is reported with the time it began, uploaded by fetch, and the recorder flushes.
  hide(env, true); assert.equal([...env.timeouts.values()][0].delay, 30000); await env.advance(30000);
  assert.equal(env.beacons.length, 0); assert.equal(env.posted(), first + 1);
  if (stub) assert.deepEqual(flushes, [[]]);
  assert.deepEqual((await env.sent()).filter(event => event.name === 'visibility').map(event => [event.details.visible, (event.time - start) / 1000]), [[false, 70]]);
  // Showing it again is reported, but uploads nothing until the minute's timer or, here, leaving the page.
  hide(env, false); await new Promise(resolve => setImmediate(resolve)); assert.equal(env.posted(), first + 1);
  env.window.dispatchEvent(new Event('pagehide'));
  assert.equal(env.beacons.length, 1); if (stub) assert.deepEqual(flushes, [[], [true]]);
  const left = JSON.parse(await env.beacons[0].body.text()).events;
  assert.deepEqual(left.filter(event => event.kind === 'session').map(event => [event.name, event.details.visible, event.details.duration, event.details.active]), [['visibility', true, 100000, 60000], ['session_end', undefined, 100000, 60000]]);
  stop();
});

test('browser errors carry their type, own-script location and noise flag, never their text', async t => {
  const env = setup(t); setAnalyticsEnabled(true); const stop = startAnalytics('errors@example.com'), secret = 'PRIVATE prompt customer@example.com';
  const failure = Object.assign(new Event('error'), { message: `Uncaught TypeError: ${secret}`, error: new TypeError(secret), filename: `https://concept.test/static/index-B3k9.js?q=${secret}`, lineno: 1, colno: 4321 });
  const noise = Object.assign(new Event('error'), { message: 'ResizeObserver loop completed with undelivered notifications.', error: null, filename: '', lineno: 0, colno: 0 });
  const rejected = Object.assign(new Event('unhandledrejection'), { reason: Object.assign(new DOMException(secret, 'AbortError'), { stack: `AbortError: ${secret}\n    at load (https://concept.test/static/index-B3k9.js:1:99)` }) });
  for (const event of [failure, noise, rejected]) env.window.dispatchEvent(event);
  env.window.dispatchEvent(new Event('pagehide'));
  const events = (await env.sent()).filter(event => event.kind === 'error');
  assert.ok(!JSON.stringify(events).includes('PRIVATE') && !JSON.stringify(events).includes('customer'));
  assert.deepEqual(events.map(event => [event.name, event.details.errorType, event.details.location, event.details.noise]), [
    ['window_error', 'TypeError', 'index-B3k9.js:1:4321', undefined], ['window_error', undefined, undefined, 'resize_observer'], ['unhandledrejection', 'AbortError', 'index-B3k9.js:1:99', undefined]]);
  assert.ok(events.every(event => event.details.message === 'Error (details hidden)'));
  stop();
});

test('an error burst is sent once, then as one counted event a minute; known noise once per tab, counted when leaving', async t => {
  const env = setup(t); setAnalyticsEnabled(true); const stop = startAnalytics('burst@example.com');
  const fail = (colno = 4321) => env.window.dispatchEvent(Object.assign(new Event('error'), { message: 'Uncaught TypeError: x is null', error: new TypeError('x is null'), filename: 'https://concept.test/static/index-B3k9.js', lineno: 1, colno }));
  const noise = () => env.window.dispatchEvent(Object.assign(new Event('error'), { message: 'ResizeObserver loop completed with undelivered notifications.', error: null, filename: '', lineno: 0, colno: 0 }));
  // A call moved the board: every frame threw in two places, and the layout skipped frames.
  for (let i = 0; i < 416; i++) { fail(); noise(); }
  fail(99);
  await env.advance(30000); fail(); // Still inside the minute: counted.
  await env.advance(30000); // The minute's timer sends one event for the 416 repeats.
  await env.advance(30000); fail(); await env.advance(30000);
  await env.advance(80000); fail(); // Over a minute since the last one: sent at once, standing for itself.
  await env.advance(600000); noise();
  env.window.dispatchEvent(new Event('pagehide'));
  const errors = (await env.sent()).filter(event => event.kind === 'error'), start = Date.parse('2026-11-16T11:00:00Z');
  assert.deepEqual(errors.filter(event => !event.details.noise).map(event => [event.details.location, event.details.count, (event.time - start) / 1000]), [
    ['index-B3k9.js:1:4321', undefined, 0], ['index-B3k9.js:1:99', undefined, 0], ['index-B3k9.js:1:4321', 416, 60], ['index-B3k9.js:1:4321', 1, 120], ['index-B3k9.js:1:4321', 1, 200]]);
  assert.deepEqual(errors.filter(event => event.details.noise).map(event => [event.details.noise, event.details.count]), [['resize_observer', undefined], ['resize_observer', 416]]);
  // Every occurrence is accounted for: 420 errors in our code and 417 skipped frames.
  const total = noisy => errors.filter(event => !!event.details.noise === noisy).reduce((sum, event) => sum + (event.details.count ?? 1), 0);
  assert.equal(total(false), 420); assert.equal(total(true), 417);
  stop();
});

test('a teammate’s call card is counted once as a notice, while a real alert stays an error', async t => {
  const alert = (text, notice) => ({ nodeType: 1, textContent: text, dataset: notice ? { analyticsNotice: notice } : {}, getAttribute: key => key === 'role' ? 'alert' : null,
    matches: selector => selector.split(',').includes('[role="alert"]'), closest: () => null, querySelectorAll: () => [] });
  const call = alert('Olena Kovalenko is calling everyone Taking you there in 5 s', 'attention_call'), failure = alert('Failed to fetch');
  const env = setup(t, { alerts: [call, failure] }); setAnalyticsEnabled(true); const stop = startAnalytics('notice@example.com');
  // The countdown changes the card's text every second.
  for (const observed of env.mutations) observed([{ addedNodes: [], target: { parentElement: { closest: () => call } } }, { addedNodes: [], target: { parentElement: { closest: () => call } } }]);
  env.window.dispatchEvent(new Event('pagehide'));
  const events = await env.sent();
  assert.deepEqual(events.filter(event => event.name === 'notice').map(event => [event.kind, event.details.target]), [['app', 'attention_call']]);
  assert.deepEqual(events.filter(event => event.kind === 'error').map(event => [event.name, event.details.message]), [['notify', 'Failed to fetch']]);
  assert.ok(!JSON.stringify(events).includes('Olena'));
  stop();
});
test('a phone or tablet beacons at once when hidden, since its timers stop and pagehide rarely comes', async t => {
  const env = setup(t), flushes = [];
  globalThis.matchMedia = query => ({ matches: query === '(pointer: coarse)' });
  let stub;
  if (nodeModule.registerHooks) stub = nodeModule.registerHooks({ resolve(specifier, context, next) {
    if (specifier !== './analytics-replay.mjs' || !context.parentURL?.endsWith('/src/analytics.mjs')) return next(specifier, context);
    return { url: 'data:text/javascript,' + encodeURIComponent('export async function recordSession() { return { stop() {}, flush(...args) { globalThis.__replayFlushes.push(args); } }; }'), shortCircuit: true };
  } });
  globalThis.__replayFlushes = flushes; t.after(() => { delete globalThis.__replayFlushes; });
  setAnalyticsEnabled(true); const stop = startAnalytics('phone@example.com'); analyticsReady();
  try { await env.idle.at(-1)(); } finally { stub?.deregister(); }
  await env.advance(60000);
  hide(env, true);
  assert.equal(env.timeouts.size, 0); assert.equal(env.beacons.length, 1); if (stub) assert.deepEqual(flushes, [[true]]);
  assert.deepEqual(JSON.parse(await env.beacons[0].body.text()).events.filter(event => event.name === 'visibility').map(event => event.details.visible), [false]);
  stop();
});
