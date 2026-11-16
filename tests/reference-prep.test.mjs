import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { fitsLimits, hasAlpha, inspectImage, needsPrep, planReferences, referenceLimits, referenceProblem, targetSize } from '../cloud/reference-prep.mjs';
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
  assert.equal(fitsLimits([10 * MB, 10 * MB], nano), true); assert.equal(fitsLimits([10 * MB, 10 * MB + 1], nano), false); assert.equal(fitsLimits([16 * MB], gpt), false);
});

test('images that cannot be prepared are named before a run starts', () => {
  const image = { asset: 'a.jpg', label: 'Hero shot' }, nano = referenceLimits.nanoBanana;
  assert.equal(referenceProblem([info(jpeg(7680, 4320), 25 * MB)], [image], nano, { binding: true }),
    '“Hero shot” is too large to reduce automatically (25 MB; the limit is 20 MB). Right-click it, choose Resize…, then try again.');
  assert.equal(referenceProblem([info(jpeg(7680, 4320), 19 * MB)], [image], nano, { binding: true }), null);
  // Even an image small enough in pixels cannot fill the whole budget by itself.
  assert.match(referenceProblem([info(png(3000, 2000, 6), 21 * MB)], [image], nano, { binding: true }), /too large to reduce automatically \(21 MB/);
  assert.equal(referenceProblem([info(jpeg(7680, 4320), 12 * MB), info(jpeg(10, 10), 9 * MB)], [image, image], nano), 'Reference images are too large for Nano Banana (20 MB in total). Use fewer or smaller images.');
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
  assert.match(calls[0].input.find(part => part.type === 'text' && part.text.includes('Attachment')).text, /Hero/);
  assert.equal(readCloudGraph(room.document).runs[0].status, 'completed');
  assert.equal(readCloudGraph(room.document).nodes.find(node => node.id === 'i').data.asset, hero, 'the board keeps the original');
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
