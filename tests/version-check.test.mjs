import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newerVersion, watchVersion } from '../src/version-check.mjs';

test('only a different, valid, undismissed version asks for a reload', () => {
  for (const value of [null, {}, { version: '' }, { version: ' ' }, { version: 1 }, { version: 'old' }]) assert.equal(newerVersion('old', value), '');
  assert.equal(newerVersion('', { version: 'new' }), '');
  assert.equal(newerVersion('old', { version: 'new' }), 'new');
  assert.equal(newerVersion('old', { version: 'new' }, 'new'), '');
  assert.equal(newerVersion('old', { version: 'next' }, 'new'), 'next');
});

test('version checks use no-store, visibility, reconnect and ten-minute timers, ignoring failed checks', async () => {
  const document = new EventTarget(), window = new EventTarget(), requests = [], seen = [];
  let timer, delay, response = Response.json({ version: 'new' });
  window.setInterval = (fn, ms) => { timer = fn; delay = ms; return 1; }; window.clearInterval = () => { timer = null; };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const fetch = async (url, options) => { requests.push({ url, ...options }); if (response instanceof Error) throw response; return response.clone(); };
  const stop = watchVersion({ page: 'old', document, window, fetch, updated: version => seen.push(version) });
  await settle(); assert.equal(delay, 600000); assert.deepEqual(seen, ['new']); assert.deepEqual(requests[0], { url: '/version.json', cache: 'no-store' });
  document.hidden = true; timer(); await settle(); assert.equal(requests.length, 1);
  window.dispatchEvent(new Event('concept-graph-reconnected')); await settle(); assert.equal(requests.length, 2);
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); await settle(); assert.equal(requests.length, 3);
  for (const failed of [new Response(null, { status: 404 }), new Response('<html>SPA fallback</html>'), new Error('offline')]) { response = failed; timer(); await settle(); }
  assert.equal(seen.length, 3);
  stop(); assert.equal(timer, null); window.dispatchEvent(new Event('concept-graph-reconnected')); document.dispatchEvent(new Event('visibilitychange')); await settle(); assert.equal(requests.length, 6);
  watchVersion({ page: '', document, window, fetch, updated: () => assert.fail('dev build') })(); assert.equal(timer, null); assert.equal(requests.length, 6);
});

test('version.json stays outside Worker-first routing', async () => {
  const config = JSON.parse(await readFile(new URL('../cloud/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(config.assets.run_worker_first.every(pattern => !new RegExp('^' + pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$').test('/version.json')));
});
