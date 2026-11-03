import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasThumbnailCache, createCanvasThumbnail } from '../src/canvas-thumbnails.mjs';

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
