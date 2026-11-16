import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { couldNotReduce, fitsLimits, geminiReferenceBytes, hasAlpha, inspectImage, needsPrep, planReferences, referenceLimits, referenceProblem, sendsAsIs, targetSize } from '../cloud/reference-prep.mjs';
import { imageSize } from '../graph.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { CloudGeneration } from '../src/cloud-generation.mjs';
import { referenceCopy } from '../src/image-resize.mjs';

// Only the Cloudflare base classes are replaced; the board room, its Yjs document and the directory's SQL run for real.
let BoardRoom, Directory, DatabaseSync;
if (nodeModule.registerHooks) {
  ({ DatabaseSync } = await import('node:sqlite'));
  const hooks = nodeModule.registerHooks({ resolve(specifier, context, next) {
    return specifier === 'cloudflare:workers' ? { url: 'data:text/javascript,' + encodeURIComponent('export const env = {}; export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), shortCircuit: true } : next(specifier, context);
  } });
  try { ({ BoardRoom, Directory } = await import('../cloud/worker.mjs')); }
  finally { hooks.deregister(); }
}
const runtimeTest = nodeModule.registerHooks ? test : test.skip;
const MB = 1024 * 1024;

// Headers only: enough for format, size and transparency to be read.
function png(width, height, color = 6, chunks = []) {
  const parts = [[137, 80, 78, 71, 13, 10, 26, 10]], chunk = (type, body) => { const out = new Uint8Array(12 + body.length), view = new DataView(out.buffer); view.setUint32(0, body.length); out.set([...type].map(c => c.charCodeAt(0)), 4); out.set(body, 8); return out; };
  const header = new Uint8Array(13), view = new DataView(header.buffer); view.setUint32(0, width); view.setUint32(4, height); header.set([8, color, 0, 0, 0], 8);
  return Uint8Array.from([...parts[0], ...chunk('IHDR', header), ...chunks.flatMap(([type, body]) => [...chunk(type, body)]), ...chunk('IDAT', new Uint8Array(2))]);
}
const jpeg = (width, height, padding = 0) => Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9, ...new Uint8Array(padding)]);
const gif = (width, height) => Uint8Array.from([71, 73, 70, 56, 57, 97, width & 255, width >> 8, height & 255, height >> 8, 0, 0, 0]);
function webp(type, flags = 0) {
  const body = type === 'VP8X' ? [flags, 0, 0, 0, 99, 0, 0, 99, 0, 0] : type === 'VP8L' ? [0x2f, 99, 0, 0, flags] : [0, 0, 0, 0x9d, 0x01, 0x2a, 100, 0, 100, 0];
  return Uint8Array.from([...'RIFF'].map(c => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map(c => c.charCodeAt(0)), [...type].map(c => c.charCodeAt(0)), [body.length, 0, 0, 0], body));
}
const info = (bytes, size) => inspectImage(bytes, size ?? bytes.length);

test('reduced sizes keep the shape in whole pixels, never enlarge and never reach 0', () => {
  assert.deepEqual(targetSize({ width: 7680, height: 4320 }, { side: 3072 }), { width: 3072, height: 1728 });
  assert.deepEqual(targetSize({ width: 4320, height: 7680 }, { side: 3072 }), { width: 1728, height: 3072 });
  assert.deepEqual(targetSize({ width: 1000, height: 800 }, { side: 3072 }), { width: 1000, height: 800 });
  assert.deepEqual(targetSize({ width: 5000, height: 4500 }, { side: 2048 }), { width: 2048, height: 1843 });
  assert.deepEqual(targetSize({ width: 10000, height: 3 }, { side: 3072 }), { width: 3072, height: 1 });
  assert.deepEqual(targetSize({ width: 3, height: 10000 }, { side: 2048 }), { width: 1, height: 2048 });
  assert.deepEqual(targetSize({ width: 5000, height: 5000 }, { side: 4096, pixels: 16777216 }), { width: 4096, height: 4096 });
  const limited = targetSize({ width: 6000, height: 3001 }, { pixels: 1e6 });
  assert.ok(limited.width * limited.height <= 1e6 && limited.width > 1400 && Number.isInteger(limited.width) && Number.isInteger(limited.height));
});

test('transparency is read from the file header: PNG colour types and tRNS, WebP flags, GIF', () => {
  assert.equal(hasAlpha(png(10, 10, 6)), true); assert.equal(hasAlpha(png(10, 10, 4)), true);
  assert.equal(hasAlpha(png(10, 10, 2)), false); assert.equal(hasAlpha(png(10, 10, 3)), false);
  assert.equal(hasAlpha(png(10, 10, 2, [['tRNS', new Uint8Array(6)]])), true); assert.equal(hasAlpha(png(10, 10, 3, [['PLTE', new Uint8Array(3)], ['tRNS', new Uint8Array(1)]])), true);
  // A header whose image data begins past what was read might hide a tRNS chunk.
  assert.equal(hasAlpha(png(10, 10, 2, [['iCCP', new Uint8Array(40)]]).subarray(0, 50)), true);
  assert.equal(hasAlpha(jpeg(10, 10)), false); assert.equal(hasAlpha(gif(10, 10)), true);
  assert.equal(hasAlpha(webp('VP8X', 0x10)), true); assert.equal(hasAlpha(webp('VP8X', 0)), false);
  assert.equal(hasAlpha(webp('VP8L', 0x10)), true); assert.equal(hasAlpha(webp('VP8L', 0)), false); assert.equal(hasAlpha(webp('VP8 ')), false);
});

test('only images past their provider limits are reduced, with the right format and size', () => {
  const nano = referenceLimits.nanoBanana, gpt = referenceLimits.gptImage;
  // An 8K photo is reduced to 3K for Nano Banana; a small image is sent as it is.
  let plan = planReferences([info(jpeg(7680, 4320), 12 * MB), info(png(800, 600, 2), 100000)], nano);
  assert.deepEqual(plan[0], { prep: true, target: { width: 3072, height: 1728 }, side: 3072, format: 'image/jpeg', transform: { width: 3072, height: 3072, fit: 'scale-down' } });
  assert.deepEqual(plan[1], { prep: false });
  // Over its share of the 20 MB: an opaque PNG becomes a JPEG of the same size, a transparent one stays as it is.
  plan = planReferences([info(png(3000, 2000, 2), 12 * MB), info(png(3000, 2000, 6), 12 * MB)], nano);
  assert.equal(plan[0].format, 'image/jpeg'); assert.deepEqual(plan[0].target, { width: 3000, height: 2000 }); assert.deepEqual(plan[1], { prep: false });
  assert.equal(needsPrep(info(png(3000, 2000, 2), 12 * MB), nano), false, 'one image may use the whole budget');
  // A GIF becomes a still PNG.
  assert.deepEqual(planReferences([info(gif(400, 300))], nano)[0].transform, { width: 400, height: 400, fit: 'scale-down', anim: false });
  assert.equal(planReferences([info(gif(400, 300))], nano)[0].format, 'image/png');
  // GPT Image: 4K, and the mask with its image get one exact size, both PNG.
  plan = planReferences([info(png(6000, 4000, 2)), info(jpeg(5000, 1000)), info(png(6000, 4000, 6))], gpt, { pair: [0, 2] });
  for (const index of [0, 2]) assert.deepEqual([plan[index].format, plan[index].transform], ['image/png', { width: 4096, height: 2731, fit: 'scale-down' }]);
  assert.equal(plan[1].format, 'image/jpeg'); assert.deepEqual(plan[1].target, { width: 4096, height: 819 });
  // A set still too large is planned again at a smaller side.
  assert.deepEqual(planReferences([info(jpeg(3000, 2000))], nano, { side: 2048 })[0].target, { width: 2048, height: 1365 });
  // 3D keeps its rule: over 4096 px or 6 MB, a 2048 px JPEG.
  assert.deepEqual(planReferences([info(png(5000, 4500))], referenceLimits.model3d)[0].transform, { width: 2048, height: 2048, fit: 'scale-down' });
  assert.equal(planReferences([info(png(3000, 3000), 2 * MB)], referenceLimits.model3d)[0].prep, false);
  assert.equal(planReferences([info(png(3000, 3000), 7 * MB)], referenceLimits.model3d)[0].format, 'image/jpeg');
  // Upscales go in at full size.
  assert.equal(planReferences([info(jpeg(7680, 4320), 15 * MB)], referenceLimits.upscale)[0].prep, false);
  assert.equal(fitsLimits([10 * MB, 10 * MB], gpt), true); assert.equal(fitsLimits([10 * MB, 10 * MB + 1], gpt), false); assert.equal(fitsLimits([16 * MB], gpt), false);
  // Gemini counts base64 text against one 20 MB request: images get three quarters of it, less room for the prompt.
  assert.ok(Math.ceil(geminiReferenceBytes / 3) * 4 + 256 * 1024 <= 20 * MB && geminiReferenceBytes > 14.5 * MB);
  assert.equal(fitsLimits([7 * MB, 7 * MB], nano), true); assert.equal(fitsLimits([10 * MB, 5 * MB], nano), false); assert.equal(fitsLimits([15 * MB], nano), false);
  // A 16 MB opaque PNG under 3K would be 21 MB of base64: it goes as a JPEG of the same size.
  assert.equal(needsPrep(info(png(3000, 2000, 2), 16 * MB), nano, nano.totalBytes), true); assert.equal(needsPrep(info(png(3000, 2000, 2), 14 * MB), nano, nano.totalBytes), false);
  assert.deepEqual([planReferences([info(png(3000, 2000, 2), 16 * MB)], nano)[0].format, planReferences([info(png(3000, 2000, 2), 16 * MB)], nano)[0].target], ['image/jpeg', { width: 3000, height: 2000 }]);
  // Without a copy, an original goes only in a format the provider reads and within GPT Image's data URL limit; 3D keeps its JPEG rule.
  assert.equal(sendsAsIs(info(jpeg(7680, 4320), 5 * MB), nano), true); assert.equal(sendsAsIs(info(gif(400, 300)), nano), false);
  assert.equal(sendsAsIs(info(png(6000, 4000), 16 * MB), gpt), false); assert.equal(sendsAsIs(info(png(6000, 4000), 9 * MB), gpt), true);
  assert.equal(sendsAsIs(info(png(5000, 4500)), referenceLimits.model3d), false); assert.equal(sendsAsIs(null, nano), false);
});

test('images that cannot be prepared are named before a run starts', () => {
  const image = { asset: 'a.jpg', label: 'Hero shot' }, nano = referenceLimits.nanoBanana;
  assert.equal(referenceProblem([info(jpeg(7680, 4320), 25 * MB)], [image], nano, { binding: true }),
    '“Hero shot” is too large to reduce automatically (25 MB; the limit is 20 MB). Right-click it, choose Resize…, then try again.');
  assert.equal(referenceProblem([info(jpeg(7680, 4320), 19 * MB)], [image], nano, { binding: true }), null);
  // Even an image small enough in pixels cannot fill the whole budget by itself.
  assert.match(referenceProblem([info(png(3000, 2000, 6), 21 * MB)], [image], nano, { binding: true }), /too large to reduce automatically \(21 MB/);
  assert.equal(referenceProblem([info(jpeg(7680, 4320), 12 * MB), info(jpeg(10, 10), 3 * MB)], [image, image], nano), 'Reference images are too large for Nano Banana (14.8 MB in total). Use fewer or smaller images.');
  assert.equal(referenceProblem([info(jpeg(7680, 4320), 12 * MB), info(jpeg(10, 10), 9 * MB)], [image, image], referenceLimits.gptImage, { name: 'GPT Image' }), 'Reference images are too large for GPT Image (20 MB in total). Use fewer or smaller images.');
  // Resize refuses a masked image, so the copies its mask made name that image and say to remove the mask first.
  const marked = { asset: 'b.png', label: 'Hero shot (highlighted edit area)', maskOf: 'Hero shot' };
  assert.equal(referenceProblem([info(jpeg(10, 10), MB), info(png(7680, 4320), 25 * MB)], [image, marked], nano, { binding: true }),
    '“Hero shot” is too large to reduce automatically (25 MB; the limit is 20 MB). Remove its mask, choose Resize…, then paint the mask again.');
  assert.equal(couldNotReduce({ asset: 'm.png', maskOf: 'Hero shot' }), 'Could not reduce “Hero shot” to send it. Remove its mask, choose Resize…, then paint the mask again.');
  assert.equal(couldNotReduce({ asset: 'm.png', maskOf: '' }), 'Could not reduce “Image” to send it. Remove its mask, choose Resize…, then paint the mask again.');
  assert.equal(referenceProblem([info(jpeg(7680, 4320), 12 * MB)], [image], nano), null, 'without Cloudflare Images an image that fits is sent as it is');
  assert.equal(referenceProblem([info(png(10, 10), 16 * MB)], [image], referenceLimits.gptImage, { name: 'GPT Image' }), 'A reference image is too large for GPT Image. Use a smaller image.');
  assert.match(referenceProblem([info(png(5000, 4500))], [image], referenceLimits.model3d, { model3d: true }), /needs resizing/);
  assert.equal(referenceProblem([info(jpeg(10, 10), 15 * MB), info(jpeg(10, 10), 6 * MB)], [image, image], referenceLimits.upscale, { binding: true, upscale: true }), 'Images to upscale can be at most 20 MB in total. Connect fewer.');
  assert.match(referenceProblem([null], [image], nano), /reference image is missing/);
});

// R2 with ranged reads and streamed bodies, and Cloudflare Images answering with what `produce` makes of each call.
function storage() {
  const files = new Map();
  return { files, binding: {
    async get(key) { const file = files.get(key); return file ? { size: file.size, arrayBuffer: async () => file.bytes.slice().buffer, get body() { return new Blob([file.bytes]).stream(); } } : null; },
    async head(key) { const file = files.get(key); return file ? { size: file.size } : null; },
    async put(key, bytes, options) { files.set(key, { bytes: new Uint8Array(bytes), size: bytes.byteLength, ...options }); },
  } };
}
function fakeImages(produce) {
  const calls = [];
  return { calls, binding: { input(stream) {
    const transforms = [];
    const chain = { transform(options) { transforms.push(options); return chain; }, async output(options) {
      const call = { transforms, output: options, bytes: new Uint8Array(await new Response(stream).arrayBuffer()) };
      calls.push(call);
      return { response: () => new Response(produce(call)) };
    } };
    return chain;
  } } };
}
const roomWith = (t, env) => {
  const values = new Map(), room = new BoardRoom({ storage: { kv: { get: key => values.get(key), put: (key, value) => values.set(key, value), delete: key => values.delete(key) }, transactionSync: callback => callback(), getAlarm: async () => null, setAlarm: async () => {} },
    id: { name: 'board' }, waitUntil() {}, blockConcurrencyWhile: callback => callback(), getWebSockets: () => [] }, env);
  t.after(() => room.document.destroy());
  return room;
};
const hero = '11111111-1111-1111-1111-111111111111.jpg', mask = '22222222-2222-2222-2222-222222222222.png', base = '33333333-3333-3333-3333-333333333333.png';

runtimeTest('a reduced copy is made once from the streamed original, kept under derived/, and the original stays', async t => {
  const r2 = storage(), images = fakeImages(({ transforms, output }) => (assert.equal(output.format, 'image/jpeg'), jpeg(transforms[0].width, Math.round(transforms[0].width * 9 / 16))));
  const room = roomWith(t, { FILES: r2.binding, IMAGES: images.binding }), original = jpeg(7680, 4320, 100);
  r2.files.set(`assets/${hero}`, { bytes: original, size: 12 * MB });
  const [sent] = await room.prepareReferences([{ asset: hero, label: 'Hero', nodeId: 'i' }], 'nanoBanana');
  assert.deepEqual([sent.mimeType, sent.size, sent.label, sent.nodeId, sent.asset], ['image/jpeg', { width: 3072, height: 1728 }, 'Hero', 'i', hero]);
  assert.deepEqual(imageSize(Buffer.from(sent.data, 'base64')), { width: 3072, height: 1728 });
  assert.deepEqual([images.calls[0].transforms, images.calls[0].output], [[{ width: 3072, height: 3072, fit: 'scale-down' }], { format: 'image/jpeg', quality: 90 }]);
  assert.deepEqual(images.calls[0].bytes, original, 'Cloudflare Images reads the original itself');
  assert.ok(r2.files.has(`derived/${hero}/3072x1728.jpg`)); assert.deepEqual(r2.files.get(`assets/${hero}`).bytes, original);
  // The next run finds the copy and spends no transformation.
  await room.prepareReferences([{ asset: hero, label: 'Hero', nodeId: 'i' }], 'nanoBanana');
  assert.equal(images.calls.length, 1);
  // A copy that is not what was asked for (Cloudflare Images returns large animations untouched) is never sent.
  r2.files.set(`assets/${hero.replace('.jpg', '.gif')}`, { bytes: gif(9000, 9000), size: 5 * MB });
  const untouched = roomWith(t, { FILES: r2.binding, IMAGES: fakeImages(() => gif(9000, 9000)).binding });
  await assert.rejects(untouched.prepareReferences([{ asset: hero.replace('.jpg', '.gif'), label: 'Loop' }], 'nanoBanana'), /Could not reduce “Loop” to send it/);
});

runtimeTest('images over 20 MB that need reducing fail clearly; mask pairs stay one PNG size; a set too large is reduced further', async t => {
  const r2 = storage(), images = fakeImages(({ transforms, output }) => output.format === 'image/png' ? png(transforms[0].width, transforms[0].height) : jpeg(transforms[0].width, Math.round(transforms[0].width * .75), transforms[0].width >= 3072 ? 8 * MB : 3 * MB));
  const room = roomWith(t, { FILES: r2.binding, IMAGES: images.binding });
  r2.files.set(`assets/${hero}`, { bytes: jpeg(7680, 4320), size: 25 * MB });
  await assert.rejects(room.prepareReferences([{ asset: hero, label: 'Hero' }], 'nanoBanana'), /“Hero” is too large to reduce automatically \(25 MB/);
  assert.equal(images.calls.length, 0);
  // GPT Image edits a 6000×4000 image through its mask: both go as PNGs of exactly the same size.
  r2.files.set(`assets/${base}`, { bytes: png(6000, 4000, 2), size: 9 * MB }); r2.files.set(`assets/${mask}`, { bytes: png(6000, 4000, 6), size: MB });
  const [image, painted] = await room.prepareReferences([{ asset: base, label: 'Hero' }, { asset: mask }], 'gptImage', { pair: [0, 1] });
  assert.deepEqual([image.mimeType, painted.mimeType], ['image/png', 'image/png']); assert.deepEqual(image.size, painted.size); assert.deepEqual(image.size, { width: 4096, height: 2731 });
  assert.deepEqual(images.calls.map(call => call.transforms[0]), [{ width: 4096, height: 2731, fit: 'scale-down' }, { width: 4096, height: 2731, fit: 'scale-down' }]);
  // Three 4K photos come out at 8 MB each at 3K (24 MB), so the set is made again at 2048 px.
  images.calls.length = 0;
  const photos = ['4', '5', '6'].map(digit => `${digit.repeat(8)}-1111-1111-1111-111111111111.jpg`);
  for (const asset of photos) r2.files.set(`assets/${asset}`, { bytes: jpeg(4000, 3000), size: 5 * MB });
  const sent = await room.prepareReferences(photos.map(asset => ({ asset, label: asset })), 'nanoBanana');
  assert.deepEqual(images.calls.map(call => call.transforms[0].width), [3072, 3072, 3072, 2048, 2048, 2048]);
  assert.ok(sent.every(item => item.size.width === 2048 && item.byteLength === 3 * MB + 23));
  // Copies that never get small enough fail with a message to use fewer images.
  const stubborn = roomWith(t, { FILES: r2.binding, IMAGES: fakeImages(({ transforms }) => jpeg(transforms[0].width, transforms[0].width, 8 * MB)).binding });
  const more = ['7', '8', '9'].map(digit => `${digit.repeat(8)}-1111-1111-1111-111111111111.jpg`);
  for (const asset of more) r2.files.set(`assets/${asset}`, { bytes: jpeg(4000, 3000), size: 5 * MB });
  await assert.rejects(stubborn.prepareReferences(more.map(asset => ({ asset })), 'nanoBanana'), /still too large for Nano Banana after reducing them/);
});

runtimeTest('without Cloudflare Images, or when a copy cannot be made, an original the provider takes is sent as it is', async t => {
  const r2 = storage(), photo = jpeg(4000, 3000, 50), loop = gif(400, 300), gifAsset = hero.replace('.jpg', '.gif');
  r2.files.set(`assets/${hero}`, { bytes: photo, size: 5 * MB }); r2.files.set(`assets/${gifAsset}`, { bytes: loop, size: MB });
  // No binding (local development, self-hosting): the originals go as they did before copies existed.
  const plain = roomWith(t, { FILES: r2.binding });
  assert.equal(await plain.referencesProblem({ images: [{ asset: hero, label: 'Photo' }, { asset: gifAsset, label: 'Loop' }] }, false, 'Nano Banana'), null);
  const sent = await plain.prepareReferences([{ asset: hero, label: 'Photo' }, { asset: gifAsset, label: 'Loop' }], 'nanoBanana');
  assert.deepEqual(sent.map(item => [item.mimeType, item.size]), [['image/jpeg', { width: 4000, height: 3000 }], ['image/gif', { width: 400, height: 300 }]]);
  assert.deepEqual(Buffer.from(sent[0].data, 'base64'), Buffer.from(photo));
  assert.ok(![...r2.files.keys()].some(key => key.startsWith('derived/')));
  // A binding that fails (Images not enabled on the account): the photo still goes as it is; a GIF, which no provider reads, cannot.
  const broken = fakeImages(() => { throw new Error('Images is not enabled'); });
  const failing = roomWith(t, { FILES: r2.binding, IMAGES: broken.binding });
  const [original] = await failing.prepareReferences([{ asset: hero, label: 'Photo' }], 'nanoBanana');
  assert.deepEqual([original.mimeType, original.size, original.byteLength], ['image/jpeg', { width: 4000, height: 3000 }, photo.length]);
  await assert.rejects(failing.prepareReferences([{ asset: gifAsset, label: 'Loop' }], 'nanoBanana'), /Could not reduce “Loop” to send it\. Right-click it/);
  // An original that cannot be reduced and keeps the set over Gemini's budget is named, not the set.
  const big = '44444444-1111-1111-1111-111111111111.png';
  r2.files.set(`assets/${big}`, { bytes: png(3000, 2000, 2), size: 16 * MB });
  await assert.rejects(failing.prepareReferences([{ asset: big, label: 'Poster' }], 'nanoBanana'), /Could not reduce “Poster” to send it/);
  // A mask and the image it edits fall back together, so GPT Image still gets two PNGs of one size.
  r2.files.set(`assets/${base}`, { bytes: png(6000, 4000, 2), size: 9 * MB }); r2.files.set(`assets/${mask}`, { bytes: png(6000, 4000, 6), size: MB });
  const half = fakeImages(({ bytes, transforms }) => { if (bytes[25] === 2) throw new Error('decode failed'); return png(transforms[0].width, transforms[0].height); });
  const pair = await roomWith(t, { FILES: r2.binding, IMAGES: half.binding }).prepareReferences([{ asset: base, label: 'Hero' }, { asset: mask }], 'gptImage', { pair: [0, 1] });
  assert.deepEqual(pair.map(item => [item.mimeType, item.size]), [['image/png', { width: 6000, height: 4000 }], ['image/png', { width: 6000, height: 4000 }]]);
});

runtimeTest('a set within 3K but over Gemini\'s base64 budget is reduced further; mask copies name the masked image', async t => {
  const r2 = storage(), images = fakeImages(({ transforms }) => jpeg(transforms[0].width, Math.round(transforms[0].width * .75), 3 * MB));
  const room = roomWith(t, { FILES: r2.binding, IMAGES: images.binding });
  // Three 2400 px JPEGs of 6 MB: under 3K, but 18 MB would be 24 MB of base64 in one request.
  const photos = ['a', 'b', 'c'].map(letter => `${letter.repeat(8)}-1111-1111-1111-111111111111.jpg`);
  for (const asset of photos) r2.files.set(`assets/${asset}`, { bytes: jpeg(2400, 1800), size: 6 * MB });
  const sent = await room.prepareReferences(photos.map(asset => ({ asset, label: asset })), 'nanoBanana');
  assert.deepEqual(images.calls.map(call => call.transforms[0].width), [2048, 2048, 2048]);
  assert.ok(sent.every(item => item.size.width === 2048));
  // Nano Banana: the marked copy a mask made is too large to reduce; the message names the image and the way out.
  const marked = '55555555-1111-1111-1111-111111111111.png';
  r2.files.set(`assets/${hero}`, { bytes: jpeg(4000, 3000), size: 5 * MB }); r2.files.set(`assets/${marked}`, { bytes: png(4000, 3000, 6), size: 25 * MB });
  const nanoRequest = { images: [{ asset: hero, label: 'Hero', nodeId: 'i', mask: { marked } }, { asset: marked, label: 'Hero (highlighted edit area)', nodeId: 'i' }, { asset: photos[0], label: 'Other', nodeId: 'o' }] };
  assert.equal(await room.referencesProblem(nanoRequest, false, 'Nano Banana'),
    '“Hero” is too large to reduce automatically (25 MB; the limit is 20 MB). Remove its mask, choose Resize…, then paint the mask again.');
  // GPT Image: the same for the mask itself, which has no label of its own.
  r2.files.set(`assets/${base}`, { bytes: png(4000, 3000, 2), size: 5 * MB }); r2.files.set(`assets/${mask}`, { bytes: png(4000, 3000, 6), size: 25 * MB });
  assert.match(await room.referencesProblem({ images: [{ asset: base, label: 'Hero', nodeId: 'i', mask: { asset: mask } }], mask }, true, 'GPT Image'), /^“Hero” is too large to reduce automatically \(25 MB.*Remove its mask/);
  // Other images keep the Resize message.
  r2.files.set(`assets/${photos[1]}`, { bytes: jpeg(7680, 4320), size: 25 * MB });
  assert.match(await room.referencesProblem({ images: [{ asset: photos[1], label: 'Plain', nodeId: 'p' }] }, false, 'Nano Banana'), /^“Plain”.*Right-click it, choose Resize…/);
});

runtimeTest('Generate refuses an image that cannot be reduced before reserving anything, and sends a 3K copy otherwise', async t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  const sql = { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  const r2 = storage(), images = fakeImages(({ transforms }) => jpeg(transforms[0].width, Math.round(transforms[0].width * 9 / 16)));
  let directory;
  const env = { GEMINI_API_KEY: 'test-key', NANO_BANANA_ALLOWED: '@studio.example', FILES: r2.binding, IMAGES: images.binding, Directory: { idFromName: name => name, get: () => directory } };
  directory = new Directory({ storage: { sql } }, env);
  const room = roomWith(t, env), requester = { name: 'Lead', email: 'lead@studio.example' };
  room.onSave = async () => {};
  const waits = []; room.ctx.waitUntil = promise => waits.push(promise);
  const graph = { nodes: [{ id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: 'A courier robot', generator: 'nano-banana' } }, { id: 'i', type: 'image', position: { x: -400, y: 0 }, data: { asset: hero, caption: 'Hero' } }],
    edges: [{ id: 'e', source: 'i', target: 'p' }], groups: [], runs: [] };
  applyLocalGraph(room.document, graph, { nodes: [], edges: [], groups: [], runs: [] }, 'seed');
  const calls = []; t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push(JSON.parse(init.body)); return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: Buffer.from(png(64, 64)).toString('base64') }] }], usage: { total_input_tokens: 100, total_output_tokens: 1120 } }); });
  r2.files.set(`assets/${hero}`, { bytes: jpeg(7680, 4320), size: 25 * MB });
  const refused = await room.startNano({ nodeId: 'p', requester });
  assert.equal(refused.status, 400); assert.match(refused.error, /“Hero” is too large to reduce automatically/);
  assert.equal(readCloudGraph(room.document).runs.length, 0); assert.deepEqual(directory.nanoUsage(requester.email), { usedToday: 0, teamSpentUsd: 0 }); assert.equal(calls.length, 0);
  r2.files.set(`assets/${hero}`, { bytes: jpeg(7680, 4320), size: 12 * MB });
  const started = await room.startNano({ nodeId: 'p', requester }); assert.ok(started.run); await Promise.all(waits);
  const sent = calls[0].input.find(part => part.type === 'image');
  assert.equal(sent.mime_type, 'image/jpeg'); assert.deepEqual(imageSize(Buffer.from(sent.data, 'base64')), { width: 3072, height: 1728 });
  assert.match(calls[0].input.find(part => part.type === 'text' && part.text.startsWith('#1')).text, /Hero/);
  assert.equal(readCloudGraph(room.document).runs[0].status, 'completed');
  assert.equal(readCloudGraph(room.document).nodes.find(node => node.id === 'i').data.asset, hero, 'the board keeps the original');
  // Without Cloudflare Images a 4K photo is sent as it is, as before reduced copies existed.
  delete env.IMAGES; r2.files.set(`assets/${hero}`, { bytes: jpeg(4000, 3000), size: 5 * MB }); waits.length = 0;
  assert.ok((await room.startNano({ nodeId: 'p', requester })).run); await Promise.all(waits);
  assert.deepEqual(imageSize(Buffer.from(calls[1].input.find(part => part.type === 'image').data, 'base64')), { width: 4000, height: 3000 });
  assert.equal(readCloudGraph(room.document).runs.at(-1).status, 'completed'); assert.equal(images.calls.length, 1);
});

// Variants build one request from the prepared references and send it in every call; preparing them happens once per
// run, before the first call.
runtimeTest('sixteen variants reduce their reference once and send that same copy in every call', async t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  const sql = { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  const r2 = storage(), images = fakeImages(({ transforms }) => jpeg(transforms[0].width, Math.round(transforms[0].width * 9 / 16))), reads = new Map(), get = r2.binding.get;
  r2.binding.get = (key, options) => { reads.set(key, (reads.get(key) || 0) + 1); return get(key, options); };
  let directory;
  const env = { GEMINI_API_KEY: 'test-key', NANO_BANANA_ALLOWED: '@studio.example', FILES: r2.binding, IMAGES: images.binding, Directory: { idFromName: name => name, get: () => directory } };
  directory = new Directory({ storage: { sql } }, env);
  const room = roomWith(t, env), requester = { name: 'Lead', email: 'lead@studio.example' };
  room.onSave = async () => {};
  const waits = []; room.ctx.waitUntil = promise => waits.push(promise);
  const graph = { nodes: [{ id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: 'A courier robot', generator: 'nano-banana', variants: 16 } }, { id: 'i', type: 'image', position: { x: -400, y: 0 }, data: { asset: hero, caption: 'Hero' } }],
    edges: [{ id: 'e', source: 'i', target: 'p' }], groups: [], runs: [] };
  applyLocalGraph(room.document, graph, { nodes: [], edges: [], groups: [], runs: [] }, 'seed');
  const bodies = []; t.mock.method(globalThis, 'fetch', async (url, init) => { bodies.push(init.body); return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: Buffer.from(png(64, 64)).toString('base64') }] }], usage: { total_input_tokens: 100, total_output_tokens: 1120 } }); });
  r2.files.set(`assets/${hero}`, { bytes: jpeg(7680, 4320), size: 12 * MB });
  assert.ok((await room.startNano({ nodeId: 'p', requester })).run); await Promise.all(waits);
  assert.equal(bodies.length, 16); assert.equal(new Set(bodies).size, 1, 'every variant sends the same body');
  assert.equal(images.calls.length, 1, 'the reference is reduced once');
  const derived = [...reads.keys()].filter(key => key.startsWith('derived/'));
  assert.equal(derived.length, 1); assert.equal(reads.get(derived[0]), 1, 'the reduced copy is read once for the whole run');
  assert.deepEqual(imageSize(Buffer.from(JSON.parse(bodies[0]).input.find(part => part.type === 'image').data, 'base64')), { width: 3072, height: 1728 });
  const run = readCloudGraph(room.document).runs[0];
  assert.equal(run.status, 'completed'); assert.equal(run.outputIds.length, 16);
  assert.equal(directory.nanoUsage(requester.email).usedToday, 16);
});

test('images for Codex go through the browser copy one at a time, and the original is sent when no copy is made', async () => {
  let active = 0, most = 0;
  const shrink = async blob => { active++; most = Math.max(most, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; const bytes = new Uint8Array(await blob.arrayBuffer()); if (bytes[0] === 2) throw new Error('decode failed'); return bytes[0] === 1 ? new Blob([new Uint8Array([9])]) : null; };
  const generation = new CloudGeneration({ doc: null, boardId: 'board', user: { name: 'Lead' }, request: async url => new Response(new Uint8Array([Number(url.slice(-1))])), shrink });
  const inputs = await generation.inputs(['a1', 'a2', 'a3']);
  assert.deepEqual(inputs.map(input => [...Buffer.from(input.data, 'base64')]), [[9], [2], [3]]);
  assert.equal(most, 1);
  // Outside a browser no copy can be drawn, so the file goes as it is.
  assert.equal(await referenceCopy(new Blob([jpeg(7680, 4320)])), null);
});
