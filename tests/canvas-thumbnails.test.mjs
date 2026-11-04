import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasThumbnailCache, createCanvasThumbnail, thumbnailWidth, thumbnailWidths } from '../src/canvas-thumbnails.mjs';

test('thumbnail preserves aspect ratio and alpha-capable format and closes its decoded bitmap', async () => {
  let closed = false, drawn, outputType, decodeOptions;
  const bitmap = { width: 1536, height: 1024, close() { closed = true; } };
  const canvas = { getContext: () => ({ drawImage: (...args) => { drawn = args; } }), toBlob: (done, type) => { outputType = type; done({ type }); } };
  const result = await createCanvasThumbnail('/assets/id.png', {
    fetchImage: async () => ({ ok: true, blob: async () => ({ type: 'image/png' }) }),
    decode: async (_, options) => { decodeOptions = options; return bitmap; },
    document: { createElement: () => canvas }, makeURL: () => 'blob:thumb',
  });
  assert.deepEqual(result, { src: 'blob:thumb', aspectRatio: '1536 / 1024', generated: true });
  assert.deepEqual(decodeOptions, { imageOrientation: 'from-image' });
  assert.deepEqual(drawn, [bitmap, 0, 0, 1024, 683]);
  assert.equal(outputType, 'image/webp');
  assert.equal(closed, true);
});

test('animated GIF, missing browser capabilities and decode failures keep the original', async () => {
  let fetched = 0;
  const gif = await createCanvasThumbnail('/assets/a.gif?token=private', { fetchImage: () => { fetched++; } });
  assert.deepEqual(gif, { src: '/assets/a.gif?token=private' });
  assert.equal(fetched, 0);
  const fail = await createCanvasThumbnail('/assets/a.jpg', {
    fetchImage: async () => ({ ok: true, blob: async () => ({ type: 'image/jpeg' }) }),
    decode: async () => { throw new Error('unsupported'); }, document: {},
  });
  assert.deepEqual(fail, { src: '/assets/a.jpg' });
});

test('JPEG thumbnails avoid expensive PNG fallback in browsers without WebP encoding', async () => {
  let requested;
  const result = await createCanvasThumbnail('/assets/a.jpg', {
    fetchImage: async () => ({ ok: true, blob: async () => ({ type: 'image/jpeg' }) }),
    decode: async () => ({ width: 1536, height: 1024, close() {} }),
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: (done, type) => { requested = type; done({ type }); } }) },
    makeURL: () => 'blob:jpeg',
  });
  assert.equal(requested, 'image/jpeg');
  assert.equal(result.src, 'blob:jpeg');
});

test('PNG images keep an alpha-safe PNG when WebP encoding is unavailable', async () => {
  let encoded;
  const png = { type: 'image/png' };
  const result = await createCanvasThumbnail('/assets/a.png', {
    fetchImage: async () => ({ ok: true, blob: async () => png }),
    decode: async () => ({ width: 1536, height: 1024, close() {} }),
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: done => done(png) }) },
    makeURL: blob => { encoded = blob; return 'blob:png'; },
  });
  assert.equal(encoded.type, 'image/png');
  assert.equal(result.src, 'blob:png');
});

test('hosted helper fetch keeps its local-network and credential policy', async () => {
  let options;
  const source = 'http://127.0.0.1:43170/assets/a.png?token=private';
  const result = await createCanvasThumbnail(source, {
    fetchImage: async (_, value) => { options = value; return { ok: false }; },
    decode: async () => {}, document: {},
  });
  assert.deepEqual(result, { src: source });
  assert.deepEqual(options, { targetAddressSpace: 'loopback', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
});

test('cache deduplicates assets, limits concurrent work and revokes evicted blob URLs', async () => {
  let running = 0, peak = 0;
  const pending = [], revoked = [];
  const cache = new CanvasThumbnailCache({ concurrency: 2, maxEntries: 1, revoke: src => revoked.push(src), create: source => new Promise(resolve => {
    running++; peak = Math.max(peak, running);
    pending.push(() => { running--; resolve({ src: `blob:${source}`, generated: true }); });
  }) });
  const first = cache.acquire('a'), duplicate = cache.acquire('a'), second = cache.acquire('b'), third = cache.acquire('c');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  assert.equal(peak, 2);
  pending.shift()();
  assert.deepEqual(await first.ready, await duplicate.ready);
  first.release(); duplicate.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  pending.shift()();
  await second.ready; second.release();
  pending.shift()();
  await third.ready; third.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cache.entries.size, 1);
  assert.deepEqual(revoked.sort(), ['blob:a', 'blob:b']);
});

test('unmounted queued images do not start decoding', async () => {
  let finish;
  const started = [];
  const cache = new CanvasThumbnailCache({ concurrency: 1, create: source => { started.push(source); return new Promise(resolve => { finish = resolve; }); } });
  const first = cache.acquire('a'), skipped = cache.acquire('b');
  skipped.release();
  await new Promise(resolve => setImmediate(resolve));
  finish({ src: 'a' });
  await first.ready;
  assert.deepEqual(await skipped.ready, { src: 'b' });
  assert.deepEqual(started, ['a']);
  first.release();
});

test('sizes are cached apart, shown synchronously once made, and a small one is drawn from a cached large one', async () => {
  const calls = [];
  const cache = new CanvasThumbnailCache({ revoke: () => {}, create: async (source, options) => { calls.push([source, options]); return { src: `blob:${options.maximumWidth}`, aspectRatio: '3 / 2', generated: true }; } });
  assert.equal(cache.shown('a'), undefined);
  const large = cache.acquire('a', thumbnailWidths.large);
  await large.ready;
  assert.equal(cache.peek('a', thumbnailWidths.large).src, 'blob:1024');
  // Until the small size exists the large one stands in, so switching sizes never blanks a card.
  assert.equal(cache.shown('a', thumbnailWidths.small).src, 'blob:1024');
  const small = cache.acquire('a', thumbnailWidths.small);
  await small.ready;
  assert.deepEqual(calls, [['a', { maximumWidth: 1024 }], ['a', { maximumWidth: 256, from: 'blob:1024' }]]);
  assert.equal(cache.shown('a', thumbnailWidths.small).src, 'blob:256');
  assert.equal(cache.aspect('a'), '3 / 2');
  assert.equal(thumbnailWidth(true), 256); assert.equal(thumbnailWidth(false), 1024);
});

test('each size keeps its own limit and held thumbnails are never evicted', async () => {
  const revoked = [];
  const cache = new CanvasThumbnailCache({ maxEntries: { [thumbnailWidths.small]: 1, [thumbnailWidths.large]: 1 }, revoke: src => revoked.push(src), create: async (source, { maximumWidth }) => ({ src: `blob:${maximumWidth}:${source}`, generated: true }) });
  for (const source of ['a', 'b']) { const handle = cache.acquire(source, thumbnailWidths.small); await handle.ready; handle.release(); }
  assert.deepEqual(revoked, ['blob:256:a']);
  const large = cache.acquire('b'); await large.ready; large.release();
  assert.deepEqual(revoked, ['blob:256:a']);
  const release = cache.hold('b');
  const other = cache.acquire('c', thumbnailWidths.small); await other.ready; other.release();
  // `b` is held (as a card would while showing it), so the newer `c` goes instead.
  assert.deepEqual(revoked, ['blob:256:a', 'blob:256:c']);
  release();
  assert.equal(cache.peek('b', thumbnailWidths.small).src, 'blob:256:b');
  assert.equal(cache.peek('b').src, 'blob:1024:b');
});

test('a small thumbnail reads from the given source and keeps GIFs untouched', async () => {
  let fetched;
  const result = await createCanvasThumbnail('/assets/a.png', {
    from: 'blob:large', maximumWidth: 256,
    fetchImage: async url => { fetched = url; return { ok: true, blob: async () => ({ type: 'image/webp' }) }; },
    decode: async () => ({ width: 1024, height: 512, close() {} }),
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: done => done({}) }) }, makeURL: () => 'blob:small',
  });
  assert.equal(fetched, 'blob:large');
  assert.deepEqual(result, { src: 'blob:small', aspectRatio: '1024 / 512', generated: true });
  assert.deepEqual(await createCanvasThumbnail('/assets/a.gif', { from: 'blob:large', maximumWidth: 256 }), { src: '/assets/a.gif' });
});

test('cloud previews: a stored small thumbnail is used without the original, and a missing one is made and stored', async () => {
  const requests = [], bitmap = { width: 256, height: 384, close() {} };
  const canvas = { getContext: () => ({ drawImage() {} }), toBlob: done => done({ type: 'image/webp' }) };
  const stored = await createCanvasThumbnail('/assets/00000000-0000-0000-0000-000000000001.png', {
    shared: true, maximumWidth: 256, makeURL: () => 'blob:preview', document: { createElement: () => canvas }, decode: async () => bitmap,
    fetchImage: async (url, init) => { requests.push([url, init?.method || 'GET']); return { ok: true, status: 200, blob: async () => ({ type: 'image/webp' }) }; },
  });
  assert.deepEqual(stored, { src: 'blob:preview', aspectRatio: '256 / 384', generated: true });
  assert.deepEqual(requests, [['/assets/00000000-0000-0000-0000-000000000001.png/thumb', 'GET']]);
  requests.length = 0;
  const made = await createCanvasThumbnail('/assets/00000000-0000-0000-0000-000000000001.png', {
    shared: true, maximumWidth: 256, makeURL: () => 'blob:made', document: { createElement: () => canvas }, decode: async () => ({ width: 1024, height: 1536, close() {} }),
    fetchImage: async (url, init) => { requests.push([url, init?.method || 'GET']); return url.endsWith('/thumb') && !init ? { ok: true, status: 204 } : { ok: true, status: 200, blob: async () => ({ type: 'image/png' }) }; },
  });
  assert.equal(made.src, 'blob:made');
  assert.deepEqual(requests, [['/assets/00000000-0000-0000-0000-000000000001.png/thumb', 'GET'], ['/assets/00000000-0000-0000-0000-000000000001.png', 'GET'], ['/assets/00000000-0000-0000-0000-000000000001.png/thumb', 'PUT']]);
  // Large thumbnails and local boards never touch the shared previews.
  requests.length = 0;
  await createCanvasThumbnail('/assets/00000000-0000-0000-0000-000000000001.png', { shared: true, makeURL: () => 'blob:large', document: { createElement: () => canvas }, decode: async () => ({ width: 2048, height: 2048, close() {} }),
    fetchImage: async (url, init) => { requests.push([url, init?.method || 'GET']); return { ok: true, blob: async () => ({ type: 'image/png' }) }; } });
  assert.deepEqual(requests, [['/assets/00000000-0000-0000-0000-000000000001.png', 'GET']]);
});
