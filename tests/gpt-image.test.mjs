import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import * as Y from 'yjs';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithEsbuild } from 'vite';
import { signSession } from '../cloud/auth.mjs';
import { gptImageCost, gptImageError, gptImageEstimate, gptImageModel, gptImagePrompt, gptImageRequest, gptImageResult, gptImageSettings } from '../cloud/gpt-image.mjs';
import { clampVariants, generators, gptDescribeModel, gptImagePixels, imageSize, maxVariants, modelNames, validateGraph, variantPresets } from '../graph.mjs';
import { gptDescribeCost, gptDescribeEstimate } from '../cloud/gpt-describe.mjs';
import { NanoError, nanoPrompt } from '../cloud/nano-banana.mjs';
import { nanoState, promptGenerators, usesSiteGenerator } from '../src/generator.mjs';
import { CloudGeneration } from '../src/cloud-generation.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { runPlaceholders } from '../src/run-placeholders.mjs';
import { setLanguage, t as translate } from '../src/i18n.mjs';

// Only Cloudflare base classes are replaced; the Worker, rooms, Yjs and directory SQL run for real.
let worker, BoardRoom, Directory, DatabaseSync;
if (nodeModule.registerHooks) {
  ({ DatabaseSync } = await import('node:sqlite'));
  const hooks = nodeModule.registerHooks({ resolve(specifier, context, next) {
    return specifier === 'cloudflare:workers' ? { url: 'data:text/javascript,' + encodeURIComponent('export const env = {}; export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), shortCircuit: true } : next(specifier, context);
  } });
  try { ({ default: worker, BoardRoom, Directory } = await import('../cloud/worker.mjs')); }
  finally { hooks.deregister(); }
}
const runtimeTest = nodeModule.registerHooks ? test : test.skip;
const user = { name: 'Lead', email: 'lead@studio.example', color: '#0077b6' }, reference = '12345678-1234-1234-1234-123456789abc.png';
const empty = { nodes: [], edges: [], groups: [], runs: [] };
const prompt = (data = {}) => ({ id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: 'A courier robot at dawn', generator: generators.gptImage, ...data } });
const boardGraph = (data, refs = true) => ({ ...empty, nodes: [prompt(data), ...(refs ? [{ id: 'i', type: 'image', position: { x: -400, y: 0 }, data: { asset: reference, caption: 'Front view' } }] : [])], edges: refs ? [{ id: 'ip', source: 'i', target: 'p' }] : [] });
function png(width = 1024, height = 1024) {
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]); view.setUint32(16, width); view.setUint32(20, height); bytes.set([8, 6], 24);
  return bytes;
}
const b64 = bytes => Buffer.from(bytes).toString('base64');
const usage = { input_tokens: 1500, input_tokens_details: { text_tokens: 500, image_tokens: 1000 }, output_tokens: 2200, total_tokens: 3700 };
const answer = (extra = {}) => ({ created: 1794528000, data: [{ b64_json: b64(png()) }], quality: 'medium', output_format: 'png', size: '1024x1024', usage, ...extra });
const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };
const maskId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', baseId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.png', markedId = 'cccccccc-cccc-cccc-cccc-cccccccccccc.png';
const imageMask = source => ({ asset: maskId, marked: markedId, base: baseId, source });

test('a connected main image overrides names, ignores stale choices and refuses a mask on a reference', () => {
  const graph = boardGraph({ text: 'Edit Style', mainImage: 'i' });
  graph.nodes.push({ id: 'style', type: 'image', position: { x: 0, y: 0 }, data: { asset: markedId, caption: 'Style' } });
  graph.edges.unshift({ id: 'sp', source: 'style', target: 'p' });
  const before = structuredClone(graph), request = gptImagePrompt(graph, 'p');
  assert.deepEqual(request.images.map(image => image.nodeId), ['i', 'style']);
  // Connected second, so it is #2 on the board and keeps that number while it is sent first.
  assert.match(request.prompt, /Edit #2 “Front view”, sent as attachment 1\. The other attachments are references for the request\./);
  assert.match(request.prompt, /^#2, sent as attachment 1: “Front view”/m); assert.match(request.prompt, /^#1, sent as attachment 2: “Style”/m);
  assert.deepEqual(graph, before);
  graph.nodes[1].data.mask = imageMask(reference);
  assert.equal(gptImagePrompt(graph, 'p').images[0].asset, baseId);
  delete graph.nodes[1].data.mask;
  graph.nodes[2].data.mask = imageMask(markedId);
  assert.throws(() => gptImagePrompt(graph, 'p'), /The mask is on “Style”, but the main image is “Front view”/);
  graph.nodes[0].data.mainImage = 'style';
  assert.equal(gptImagePrompt(graph, 'p').images[0].nodeId, 'style');
  delete graph.nodes[2].data.mask;
  for (const mainImage of ['missing', 'p']) {
    graph.nodes[0].data.mainImage = mainImage;
    const fallback = gptImagePrompt(graph, 'p');
    assert.equal(fallback.images[0].nodeId, 'style'); assert.doesNotMatch(fallback.prompt, /The other attachments are references/);
  }
  graph.nodes[0].data.mainImage = 'i'; graph.edges = graph.edges.filter(edge => edge.source !== 'i');
  assert.deepEqual(gptImagePrompt(graph, 'p').images.map(image => image.nodeId), ['style']);
  graph.edges.push({ id: 'ip', source: 'i', target: 'p' }); graph.nodes[0].data.generator = generators.nanoBanana;
  assert.deepEqual(nanoPrompt(graph, 'p').images.map(image => image.nodeId), ['style', 'i']);
  assert.doesNotMatch(nanoPrompt(graph, 'p').prompt, /The other attachments are references/);
  const template = boardGraph({ template: { name: 'Style', instructions: '', assets: [markedId] } });
  assert.doesNotMatch(gptImagePrompt(template, 'p').prompt, /The other attachments are references/);
});

runtimeTest('the room syncs a main-image choice and sends its bytes and shape first, before earlier references', async t => {
  const app = setup(t, {}, { text: 'Edit Style', mainImage: 'i' }), calls = fake(t), before = readCloudGraph(app.room.document), next = structuredClone(before);
  next.nodes.push({ id: 'style', type: 'image', position: { x: 0, y: 0 }, data: { asset: markedId, caption: 'Style' } });
  next.edges.unshift({ id: 'sp', source: 'style', target: 'p' });
  app.files.set(`assets/${markedId}`, png(480, 640));
  applyLocalGraph(app.room.document, next, before, 'test');
  const started = await app.start(); assert.equal(started.status, 202); await app.settle();
  assert.equal(calls.length, 1); assert.equal(calls[0].body.size, '1536x1024');
  assert.deepEqual(calls[0].body.images.map(image => image.image_url), [png(640, 480), png(480, 640)].map(bytes => `data:image/png;base64,${b64(bytes)}`));
  // Connected before Style (its connection is older), so it is #1.
  assert.match(calls[0].body.prompt, /Edit #1 “Front view”, sent as attachment 1/); assert.match(calls[0].body.prompt, /^#2: “Style”/m);
  const graph = readCloudGraph(app.room.document);
  assert.equal(graph.nodes.find(node => node.id === 'p').data.mainImage, 'i');
  assert.equal(graph.runs[0].status, 'completed');
  assert.ok(graph.edges.every(edge => Object.keys(edge).sort().join() === 'id,order,source,target' && Number.isFinite(edge.order)));
});

test('GPT mask prompts reorder the target and converted PNG first and number references in the submitted order', () => {
  const graph = boardGraph(), target = graph.nodes[1]; target.data.mask = imageMask(reference);
  graph.nodes.push({ id: 'style', type: 'image', position: { x: 0, y: 0 }, data: { asset: reference, caption: 'Style' } }); graph.edges.unshift({ id: 'sp', source: 'style', target: 'p' });
  const request = gptImagePrompt(graph, 'p');
  assert.deepEqual(request.images.map(image => image.asset), [baseId, reference]); assert.equal(request.mask, maskId);
  assert.match(request.prompt, /^#2, sent as attachment 1: “Front view”/m); assert.match(request.prompt, /^#1, sent as attachment 2: “Style”/m);
  assert.match(request.prompt, /Edit only the masked area of #2 “Front view”, sent as attachment 1\./);
  assert.doesNotMatch(request.prompt, /highlighted edit area/);
  const refs = request.images.map(() => ({ mimeType: 'image/png', data: b64(png(640, 480)), size: { width: 640, height: 480 } }));
  const mask = { mimeType: 'image/png', data: b64(png(640, 480)), size: { width: 640, height: 480 } };
  const body = JSON.parse(gptImageRequest(request.prompt, refs, { key: 'key', mask }).init.body);
  assert.deepEqual(body.mask, { image_url: `data:image/png;base64,${mask.data}` }); assert.equal(body.images.length, 2);
  for (const invalid of [{ ...mask, mimeType: 'image/jpeg' }, { ...mask, size: { width: 1, height: 1 } }]) assert.throws(() => gptImageRequest('edit', refs, { mask: invalid }), /same dimensions/);
  assert.throws(() => gptImageRequest('edit', refs, { mask: { ...mask, data: 'A'.repeat(20971520) } }), /too large/);
  assert.throws(() => gptImageRequest('edit', [], { mask }), /same dimensions/);
});

runtimeTest('the room loads the PNG base and mask from R2, budgets their bytes, and sends no marked copy to OpenAI', async t => {
  const app = setup(t), calls = fake(t), before = readCloudGraph(app.room.document), next = structuredClone(before);
  const target = next.nodes.find(node => node.id === 'i'); target.data.asset = reference.replace('.png', '.jpg'); target.data.mask = imageMask(target.data.asset);
  applyLocalGraph(app.room.document, next, before, 'test');
  app.files.set(`assets/${baseId}`, png(640, 480)); app.files.set(`assets/${maskId}`, png(640, 480));
  assert.equal((await app.start()).status, 202); await app.settle();
  assert.equal(calls.length, 1); assert.equal(calls[0].body.images.length, 1);
  assert.equal(calls[0].body.images[0].image_url, `data:image/png;base64,${b64(png(640, 480))}`);
  assert.deepEqual(calls[0].body.mask, { image_url: `data:image/png;base64,${b64(png(640, 480))}` });
  // Without Cloudflare Images nothing can be reduced: an image over GPT Image's data URL limit is refused before anything is reserved.
  app.files.set(`assets/${maskId}`, new Uint8Array(20 * 1024 * 1024));
  const refused = await app.start(); assert.equal(refused.status, 400); assert.match((await refused.json()).error, /too large for GPT Image/); assert.equal(calls.length, 1);
  assert.equal(app.directory.nanoUsage(user.email).usedToday, 1);
  app.files.set(`assets/${maskId}`, png(12, 12));
  const { run: { id: mismatch } } = await (await app.start()).json(); await app.settle();
  assert.match(app.room.document.getMap('runs').get(mismatch).error, /same dimensions/); assert.equal(calls.length, 1);
});

runtimeTest('stale and multiple masks fail before quota reservation or a paid request', async t => {
  const app = setup(t), calls = fake(t), before = readCloudGraph(app.room.document), next = structuredClone(before);
  next.nodes.find(node => node.id === 'i').data.mask = imageMask(baseId); applyLocalGraph(app.room.document, next, before, 'test');
  let response = await app.start(); assert.equal(response.status, 400); assert.match((await response.json()).error, /no longer matches/);
  const current = readCloudGraph(app.room.document), double = structuredClone(current), image = double.nodes.find(node => node.id === 'i'); image.data.mask.source = reference;
  double.nodes.push({ ...structuredClone(image), id: 'second' }); double.edges.push({ id: 'second-p', source: 'second', target: 'p' });
  applyLocalGraph(app.room.document, double, current, 'test');
  response = await app.start(); assert.equal(response.status, 400); assert.match((await response.json()).error, /Only one masked image/);
  assert.deepEqual(app.directory.nanoUsage(user.email), { usedToday: 0, teamSpentUsd: 0 }); assert.equal(calls.length, 0);
});

test('settings use the company key, the existing limits and only a loopback endpoint override', () => {
  assert.deepEqual(gptImageSettings({}), { configured: false, dailyImages: 100, monthlyUsd: 100, endpoint: 'https://api.openai.com' });
  assert.deepEqual(gptImageSettings({ OPENAI_API_KEY: 'key', NANO_BANANA_DAILY_IMAGES: '2', NANO_BANANA_MONTHLY_USD: '1.25', GPT_IMAGE_ENDPOINT: 'http://127.0.0.1:8789/path' }),
    { configured: true, dailyImages: 2, monthlyUsd: 1.25, endpoint: 'http://127.0.0.1:8789' });
  assert.equal(gptImageSettings({ OPENAI_API_KEY: '  ', GEMINI_API_KEY: 'key' }).configured, false);
  for (const endpoint of ['https://evil.example', 'http://localhost.evil.example', 'file:///tmp/key', 'nonsense']) assert.equal(gptImageSettings({ GPT_IMAGE_ENDPOINT: endpoint }).endpoint, 'https://api.openai.com');
  assert.equal(gptImageSettings({ GPT_IMAGE_ENDPOINT: 'http://[::1]:8789' }).endpoint, 'http://[::1]:8789');
});

test('generation and edit requests keep named context, fixed model/settings and standard aspect sizes', () => {
  const graph = boardGraph(), request = gptImagePrompt(graph, 'p');
  assert.match(request.prompt, /^#1: “Front view”/m);
  const refs = [{ mimeType: 'image/png', data: b64(png()) }], options = { key: 'company-secret' };
  const edit = gptImageRequest(request.prompt, refs, options), body = JSON.parse(edit.init.body);
  assert.equal(edit.url, 'https://api.openai.com/v1/images/edits');
  assert.deepEqual(edit.init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer company-secret' });
  assert.equal(edit.init.redirect, 'manual'); // Workers reject 'error'; a 3xx then fails as a non-OK answer.
  assert.deepEqual(body, { model: gptImageModel, prompt: request.prompt, n: 1, size: '1024x1024', quality: 'medium', output_format: 'png', moderation: 'auto', images: [{ image_url: `data:image/png;base64,${refs[0].data}` }] });
  assert.doesNotMatch(edit.init.body, /company-secret/);
  const plain = gptImageRequest('A robot', [], options);
  assert.equal(plain.url, 'https://api.openai.com/v1/images/generations'); assert.equal(JSON.parse(plain.init.body).images, undefined);
  for (const [aspect, size] of [[undefined, '1024x1024'], [1, '1024x1024'], [.75, '1536x1024'], [.5, '1536x1024'], [1.8, '1024x1536'], [NaN, '1024x1024']]) assert.equal(JSON.parse(gptImageRequest('x', [], { ...options, aspect }).init.body).size, size);
  assert.throws(() => gptImageRequest('x'.repeat(32001), [], options), /32,000/);
  assert.throws(() => gptImagePrompt(boardGraph({ text: 'x'.repeat(32000) }), 'p'), /Connected text/);
  assert.throws(() => gptImageRequest('x', Array(17).fill(refs[0]), options), /16 reference/);
  assert.throws(() => gptImageRequest('x', [{ mimeType: 'image/png', data: 'A'.repeat(20971520) }], options), /too large/);
});

test('the image the request names first is sent first, and the output keeps its shape', () => {
  const image = (id, caption) => ({ id, type: 'image', position: { x: 0, y: 0 }, data: { asset: `${id.repeat(8)}-1234-1234-1234-123456789abc.png`, caption } });
  const graph = (text, extra = []) => ({ ...empty, nodes: [prompt({ text }), image('a', 'Image 35'), image('b', 'Image 32'), image('c', 'Image 3'), ...extra], edges: ['a', 'b', 'c'].map(id => ({ id: `${id}p`, source: id, target: 'p' })) });
  const order = text => [...gptImagePrompt(graph(text), 'p').prompt.matchAll(/^#\d+(?:, sent as attachment \d+)?: “([^”]+)”/gm)].map(match => match[1]);
  assert.deepEqual(order('налаштуй кольори на Image 32 щоб були як на Image 35'), ['Image 32', 'Image 35', 'Image 3']);
  assert.deepEqual(order('Recolor image 3 like Image 35'), ['Image 3', 'Image 35', 'Image 32']);
  assert.deepEqual(order('A courier robot'), ['Image 35', 'Image 32', 'Image 3']);
  // Connection numbers: “Image 35” is #1, “Image 32” #2 and “Image 3” #3, in Ukrainian or English, as words or digits.
  assert.deepEqual(order('зроби картинку 2 як першу'), ['Image 32', 'Image 35', 'Image 3']);
  assert.deepEqual(order('make the third image look like #1'), ['Image 3', 'Image 35', 'Image 32']);
  assert.deepEqual(order('Recolor 2-гу картинку'), ['Image 32', 'Image 35', 'Image 3']);
  // A count is not a number (“2 картинки” asks for two images), and the image named as the style is a reference, not the
  // one to edit; the image to edit follows “на”, “to” or nothing at all.
  assert.deepEqual(order('зроби 2 картинки в стилі третьої картинки'), ['Image 35', 'Image 32', 'Image 3']);
  assert.deepEqual(order('Перенеси стиль з картинки 1 на картинку 3'), ['Image 3', 'Image 35', 'Image 32']);
  assert.deepEqual(order('Apply the style of image 2 to image 3'), ['Image 3', 'Image 35', 'Image 32']);
  // A board name that reads as a number counts as that name in quotes.
  const named = (text, captions) => [...gptImagePrompt({ ...empty, nodes: [prompt({ text }), image('a', captions[0]), image('b', captions[1])], edges: ['a', 'b'].map(id => ({ id: `${id}p`, source: id, target: 'p' })) }, 'p').prompt.matchAll(/^#\d+(?:, sent as attachment \d+)?: “([^”]+)”/gm)].map(match => match[1]);
  assert.deepEqual(named('Edit image 2', ['Image 2', 'Front']), ['Front', 'Image 2']);
  assert.deepEqual(named('Edit “Image 2”', ['Image 2', 'Front']), ['Image 2', 'Front']);
  const landscape = [{ mimeType: 'image/png', data: b64(png()), size: { width: 1982, height: 1341 } }];
  assert.equal(JSON.parse(gptImageRequest('x', landscape, { key: 'k' }).init.body).size, '1536x1024');
  assert.equal(JSON.parse(gptImageRequest('x', landscape, { key: 'k', aspect: 1.5 }).init.body).size, '1024x1536');
});

test('result decoding rejects missing or corrupt images; costs follow text and image usage separately', () => {
  const result = gptImageResult(200, answer({ data: [{ b64_json: b64(png(1536, 1024)) }, { b64_json: b64(png()) }] }));
  assert.equal(result.images.length, 2); assert.deepEqual(imageSize(result.images[0].bytes), { width: 1536, height: 1024 });
  assert.equal(result.images[0].format, 'png'); assert.equal(result.images[0].contentType, 'image/png');
  assert.throws(() => gptImageResult(200, null), /unreadable response/);
  assert.throws(() => gptImageResult(200, { data: [] }), error => error instanceof NanoError && error.kind === 'no_image');
  for (const b64_json of ['!!!', b64(new Uint8Array([1, 2, 3]))]) assert.throws(() => gptImageResult(200, { data: [{ b64_json }] }), NanoError);
  assert.equal(gptImageCost(usage), (500 * 5 + 1000 * 8 + 2200 * 30) / 1e6);
  assert.equal(gptImageCost({ ...usage, output_tokens: 2300, output_tokens_details: { image_tokens: 2200, text_tokens: 100 } }), gptImageCost(usage));
  assert.equal(gptImageCost({ input_tokens: 100, output_tokens: 200 }), (100 * 5 + 200 * 30) / 1e6);
  assert.equal(gptImageCost({ input_tokens: 100, output_tokens: 200 }, { references: 1 }), (100 * 8 + 200 * 30) / 1e6);
  const fallback = { promptLength: 3000, references: 2, images: 4 };
  assert.equal(gptImageEstimate(fallback), 1 + (1000 * 5 + 32000 * 8) / 1e6);
  for (const missing of [undefined, {}, { input_tokens: 1 }]) assert.equal(gptImageCost(missing, fallback), gptImageEstimate(fallback));
  assert.ok(gptImageEstimate() > gptImageCost(usage));
});

test('OpenAI failures distinguish busy, billing, moderation, key and organization verification', () => {
  for (const [status, code, message, kind, text] of [[429, 'rate_limit_exceeded', '', 'busy', /busy/], [429, 'insufficient_quota', '', 'config', /credit/], [400, 'billing_hard_limit_reached', '', 'config', /billing/], [400, 'moderation_blocked', '', 'refused', /safety/], [400, null, 'Content policy violation', 'refused', /declined/], [401, 'invalid_api_key', '', 'config', /API key/], [403, null, 'Your organization must be verified', 'config', /organization must be verified/], [403, '', '', 'config', /denied access/], [400, 'invalid_request', 'secret echoed', 'bad_request', /could not use/], [500, '', '', 'upstream', /failed/]]) {
    const error = gptImageError(status, code, message);
    assert.equal(error.kind, kind); assert.match(error.message, text); assert.doesNotMatch(error.message, /secret echoed/);
    assert.throws(() => gptImageResult(status, { error: { code, message } }), caught => caught.kind === kind);
  }
});

test('GPT Image is a site generator with shared quotas and four placeholders; describe and upscale remain separate', () => {
  const graph = boardGraph(), state = { configured: true, allowed: true, dailyImages: 3, usedToday: 2, monthlyUsd: 50, teamSpentUsd: 2 };
  validateGraph(graph); assert.equal(modelNames[gptImageModel], 'GPT Image');
  assert.equal(usesSiteGenerator(graph.nodes[0].data), true); assert.equal(usesSiteGenerator({}), false);
  assert.equal(nanoState({ configured: false }, generators.gptImage).selectable, false);
  assert.equal(nanoState({ configured: false }, generators.gptImage).note, 'GPT Image isn’t set up on this site');
  assert.equal(nanoState(state, generators.gptImage).note, '1 of 3 left today');
  assert.equal(nanoState({ ...state, usedToday: 3 }, generators.gptImage).ready, false);
  assert.equal(nanoState({ ...state, teamSpentUsd: 50 }, generators.gptImage).ready, false);
  assert.equal(nanoState({ configured: true, allowed: false }, generators.gptImage).selectable, false);
  const run = { id: 'r', nodeId: 'p', provider: generators.gptImage, variants: 4, status: 'running' };
  assert.equal(runPlaceholders(graph, [run], 'page-1').nodes.length, 4);
  validateGraph(boardGraph({ task: 'describe' }));
  for (const task of ['upscale', 'model3d']) assert.throws(() => validateGraph(boardGraph({ task })), /GPT Image only generates images/);
});

test('changed JSX compiles and the real buttons render independent models, limits, and GPT descriptions', async () => {
  for (const file of ['main.jsx', 'CloudWorkspace.jsx', 'TeamAccessDialog.jsx']) await transformWithEsbuild(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'), file, { loader: 'jsx' });
  const source = (await readFile(new URL('../src/GeneratorPicker.jsx', import.meta.url), 'utf8')).replace(/import .*?;\n/g, '');
  const compiled = await transformWithEsbuild(source, 'GeneratorPicker.jsx', { loader: 'jsx', format: 'cjs' });
  const module = { exports: {} };
  new Function('module', 'exports', 'React', 'generators', 'maxVariants', 'variantPresets', 'clampVariants', 't', compiled.code)(module, module.exports, React, generators, maxVariants, variantPresets, clampVariants, translate);
  const ready = nanoState({ configured: true, allowed: true, dailyImages: 100, usedToday: 2, monthlyUsd: 100, teamSpentUsd: 0 }), spent = nanoState({ configured: true, allowed: true, dailyImages: 100, usedToday: 100, monthlyUsd: 100, teamSpentUsd: 0 });
  const props = { id: 'p', cloud: true, canRun: true, nano: ready, gpt: spent, run() {}, cancel() {}, fix() {}, ...promptGenerators({ cloud: true, known: true, codexReady: true, nano: ready, gpt: spent }) };
  const markup = renderToStaticMarkup(React.createElement(module.exports.GeneratorButtons, props));
  assert.match(markup, />Codex<\/span>/); assert.match(markup, />Nano Banana<\/span>/); assert.match(markup, /aria-label="Generate with GPT Image"[^>]*disabled=""/);
  assert.match(markup, /Daily limit reached/);
  const describe = { ...props, describe: true, ...promptGenerators({ cloud: true, describe: true, known: true, codexReady: true, nano: ready, gpt: spent }) };
  const described = renderToStaticMarkup(React.createElement(module.exports.GeneratorButtons, describe));
  assert.match(described, /aria-label="Describe with GPT"/); assert.match(described, />Gemini<\/span>/);
  setLanguage('uk');
  try {
    const uk = renderToStaticMarkup(React.createElement(module.exports.GeneratorButtons, describe));
    assert.match(uk, /Описати через GPT/); assert.match(uk, /Параметри генераторів/);
  } finally { setLanguage('en'); }
  // The variants row: one-click presets, then a field for any other count, which shows a typed count as chosen.
  const { VariantRow, typedVariants } = module.exports, row = props => renderToStaticMarkup(React.createElement(VariantRow, { id: 'p', choose() {}, ...props }));
  const pressed = markup => [...markup.matchAll(/aria-pressed="true"[^>]*>(\d+)</g)].map(match => Number(match[1]));
  const preset = row({ variants: 4 });
  assert.deepEqual([...preset.matchAll(/<button[^>]*>(\d+)<\/button>/g)].map(match => Number(match[1])), [1, 2, 4, 8, 16]);
  assert.deepEqual(pressed(preset), [4]); assert.match(preset, /class="variant-custom" type="text" inputMode="numeric" maxLength="2" placeholder="…"[^>]* value=""/);
  assert.match(preset, /up to 32/); assert.match(preset, /aria-label="Custom number of variants, 1–32"/);
  const custom = row({ variants: 6 });
  assert.deepEqual(pressed(custom), []); assert.match(custom, /class="variant-custom chosen"[^>]* value="6"/);
  const viewer = row({ variants: 12, disabled: true });
  assert.equal(viewer.match(/disabled=""/g).length, 6); assert.match(viewer, /value="12"/);
  // Typed text becomes a count on Enter or blur; nothing usable keeps the current count.
  assert.deepEqual(['6', '16', '40', '99', '1'].map(typedVariants), [6, 16, 32, 32, 1]);
  for (const bad of ['', '0', '00', 'x', '2.5', '-3']) assert.equal(typedVariants(bad), null, bad);
  setLanguage('uk');
  try { assert.match(row({ variants: 1 }), /Варіанти<\/span>.*aria-label="Своя кількість варіантів, 1–32"/s); }
  finally { setLanguage('en'); }
});

test('the local OpenAI stand-in validates real requests and produces PNGs without opening a socket', async () => {
  const { picture, send } = await import('../scripts/fake-image.mjs');
  const source = (await readFile(new URL('../scripts/fake-openai.mjs', import.meta.url), 'utf8')).replace(/import .*?;\n/g, '');
  let handler;
  const createServer = callback => { handler = callback; return { listen() {} }; };
  new Function('createServer', 'picture', 'send', 'process', 'console', source)(createServer, picture, send, { env: {} }, { log() {} });
  const respond = async (prompt, references = [], options = {}) => {
    const { url, init } = gptImageRequest(prompt, references, { key: 'fake', ...options });
    const request = { method: 'POST', url: new URL(url).pathname, headers: { authorization: init.headers.Authorization }, async *[Symbol.asyncIterator]() { yield Buffer.from(init.body); } };
    let status, body;
    await handler(request, { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } });
    return { status, body };
  };
  const generated = await respond('robot'); assert.equal(generated.status, 200); assert.deepEqual(imageSize(gptImageResult(200, generated.body).images[0].bytes), { width: 1024, height: 1024 });
  const edited = await respond('robot', [{ mimeType: 'image/png', data: b64(png()) }]); assert.equal(edited.status, 200); assert.equal(edited.body.usage.input_tokens_details.image_tokens, 1120);
  for (const [mode, code] of [['refuse', 'moderation_blocked'], ['busy', 'rate_limit_exceeded'], ['credit', 'insufficient_quota'], ['key', 'invalid_api_key'], ['verify', 'permission_denied']]) assert.equal((await respond(`[${mode}]`)).body.error.code, code);
  // Generation settings send documented custom sizes, other qualities and a transparent background; the stand-in takes them.
  const wide = await respond('robot', [], { size: '1568x672', quality: 'high', background: 'transparent' });
  assert.equal(wide.status, 200); assert.deepEqual(imageSize(gptImageResult(200, wide.body).images[0].bytes), { width: 1568, height: 672 });
  assert.equal((await respond('robot', [], { size: '1000x1000' })).status, 400);
});

function setup(t, extra = {}, data, refs) {
  const database = new DatabaseSync(':memory:'), files = new Map(), waits = [], values = new Map();
  t.after(() => database.close());
  const sql = { exec(query, ...args) { const rows = database.prepare(query).all(...args).map(row => ({ ...row })); return { toArray: () => rows }; } };
  let directory, room;
  const env = { SESSION_SECRET: 'test', OPENAI_API_KEY: 'company-key', GEMINI_API_KEY: 'gemini-key', NANO_BANANA_ALLOWED: '@studio.example',
    Directory: { idFromName: name => name, get: () => directory }, BoardRoom: { idFromName: name => name, get: () => room },
    FILES: { get: async key => files.has(key) ? { size: files.get(key).length, arrayBuffer: async () => files.get(key).slice().buffer } : null, put: async (key, bytes) => files.set(key, new Uint8Array(bytes)) }, ...extra };
  directory = new Directory({ storage: { sql } }, env);
  const board = directory.createBoard('GPT tests');
  const storage = { kv: { get: key => values.get(key), put: (key, value) => values.set(key, value), delete: key => values.delete(key) },
    get: async key => values.get(key), put: async (key, value) => { values.set(key, value); }, getAlarm: async () => null, setAlarm: async () => {}, transactionSync: callback => callback() };
  room = new BoardRoom({ storage, id: { name: board.id }, waitUntil: promise => waits.push(promise), blockConcurrencyWhile: callback => callback(), getWebSockets: () => [] }, env);
  room.onSave = async () => {};
  t.after(() => room.document.destroy());
  applyLocalGraph(room.document, boardGraph(data, refs), empty, 'seed'); files.set(`assets/${reference}`, png(640, 480));
  const request = async (path, { method = 'GET', email = user.email, data, headers = {} } = {}) => worker.fetch(new Request(`http://localhost:8787${path}`, { method,
    headers: { ...(email ? { Cookie: `cg_session=${await signSession({ name: 'Lead', email }, env.SESSION_SECRET)}` } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
  const update = changes => { const before = readCloudGraph(room.document); applyLocalGraph(room.document, { ...before, nodes: before.nodes.map(node => node.id === 'p' ? { ...node, data: { ...node.data, ...changes } } : node) }, before, 'test'); };
  return { env, directory, room, files, board, request, update, start: () => request(`/api/boards/${board.id}/nano`, { method: 'POST', data: { nodeId: 'p' } }), settle: () => Promise.all(waits) };
}
function fake(t, respond = () => Response.json(answer())) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return respond(init, calls.length); });
  return calls;
}

runtimeTest('Worker and room enforce setup, shared Team access, origin and board edit access without calling OpenAI', async t => {
  const app = setup(t), calls = fake(t), path = `/api/boards/${app.board.id}/nano`;
  const status = await (await app.request('/api/nano')).json();
  assert.deepEqual(status.gptImage, { configured: true, allowed: true, dailyImages: 100, usedToday: 0, monthlyUsd: 100, teamSpentUsd: 0 });
  assert.equal((await app.request(path, { method: 'POST', email: null, data: { nodeId: 'p' } })).status, 401);
  assert.equal((await app.request(path, { method: 'POST', data: { nodeId: 'p' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await app.request(path, { method: 'POST', email: 'outsider@example.com', data: { nodeId: 'p' } })).status, 403);
  assert.equal((await app.room.startNano({ nodeId: 'p', requester: { ...user, email: 'outsider@example.com' } })).status, 403);
  app.directory.ctx.storage.sql.exec("UPDATE boards SET access = 'link', linkRole = 'view' WHERE id = ?", app.board.id);
  assert.equal((await app.start()).status, 403);
  app.directory.ctx.storage.sql.exec("UPDATE boards SET linkRole = 'edit' WHERE id = ?", app.board.id);
  delete app.env.OPENAI_API_KEY;
  const missing = await app.start(); assert.equal(missing.status, 503); assert.match((await missing.json()).error, /GPT Image isn’t set up/);
  assert.equal((await (await app.request('/api/nano')).json()).gptImage.configured, false);
  assert.equal(calls.length, 0);
});

runtimeTest('four edit variants run on the company key, become one slideshow and settle actual shared spend', async t => {
  const app = setup(t, {}, { variants: 4 }), held = gate(); t.after(held.open);
  const calls = fake(t, async () => { await held.promise; return Response.json(answer()); });
  const response = await app.start(); assert.equal(response.status, 202);
  const { run: { id } } = await response.json();
  assert.equal((await app.start()).status, 409);
  assert.equal(app.directory.nanoUsage(user.email).usedToday, 4);
  held.open(); await app.settle();
  assert.equal(calls.length, 4);
  for (const call of calls) { assert.equal(call.url, 'https://api.openai.com/v1/images/edits'); assert.equal(call.init.headers.Authorization, 'Bearer company-key'); assert.equal(call.body.n, 1); assert.equal(call.body.images[0].image_url, `data:image/png;base64,${b64(png(640, 480))}`); }
  const graph = readCloudGraph(app.room.document), run = graph.runs.find(run => run.id === id);
  assert.deepEqual([run.provider, run.model, run.status, run.count, run.variants], [generators.gptImage, gptImageModel, 'completed', 4, 4]);
  assert.equal(graph.groups.length, 1); assert.equal(graph.groups[0].slideshow, true); assert.equal(graph.groups[0].nodeIds.length, 4);
  assert.equal(graph.nodes.filter(node => node.data.runId === id).length, 4); validateGraph(graph);
  assert.deepEqual(app.directory.nanoUsage(user.email), { usedToday: 4, teamSpentUsd: 4 * gptImageCost(usage) });
  const status = await (await app.request('/api/nano')).json(); assert.equal(status.usedToday, status.gptImage.usedToday); assert.equal(status.teamSpentUsd, status.gptImage.teamSpentUsd);
});

runtimeTest('plain prompts use generations without Gemini, and both providers consume the same daily allowance and monthly budget', async t => {
  const app = setup(t, { NANO_BANANA_DAILY_IMAGES: '2' }, {}, false), calls = fake(t);
  const existing = app.directory.reserveNano(user.email, { dailyImages: 2, monthlyUsd: 50, estimateUsd: .1 });
  app.directory.settleNano(existing.reservation, { images: 1, usd: .1 });
  delete app.env.GEMINI_API_KEY;
  assert.equal((await app.start()).status, 202); await app.settle();
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
  app.update({ generator: generators.nanoBanana }); app.env.GEMINI_API_KEY = 'gemini';
  const limited = await app.start(); assert.equal(limited.status, 429); assert.match((await limited.json()).error, /Daily limit/);
  app.env.NANO_BANANA_DAILY_IMAGES = '10'; app.env.NANO_BANANA_MONTHLY_USD = '.17';
  for (const generator of Object.values(generators)) { app.update({ generator }); const budget = await app.start(); assert.equal(budget.status, 429); assert.match((await budget.json()).error, /Team budget/); }
  assert.equal(calls.length, 1); assert.equal(app.directory.nanoUsage(user.email).usedToday, 2);
});

runtimeTest('variants that cannot all fit release every reservation and make no paid calls', async t => {
  const app = setup(t, { NANO_BANANA_DAILY_IMAGES: '2' }, { variants: 3 }), calls = fake(t);
  const response = await app.start(); assert.equal(response.status, 429); assert.match((await response.json()).error, /Only 2 of 3 variants fit/);
  assert.equal(calls.length, 0); assert.deepEqual(app.directory.nanoUsage(user.email), { usedToday: 0, teamSpentUsd: 0 });
});

runtimeTest('provider errors refund, partial variants stay, and failed calls are never retried', async t => {
  const app = setup(t, {}, { variants: 3 }), calls = fake(t, (_, index) => index === 2 ? Response.json(answer()) : Response.json({ error: { code: 'moderation_blocked' } }, { status: 400 }));
  const { run: { id } } = await (await app.start()).json(); await app.settle();
  const run = app.room.document.getMap('runs').get(id);
  assert.deepEqual([run.status, run.count], ['completed', 1]); assert.match(run.error, /2 of 3 variants failed: GPT Image declined/);
  assert.equal(calls.length, 3); assert.deepEqual(app.directory.nanoUsage(user.email), { usedToday: 1, teamSpentUsd: gptImageCost(usage) });
});

runtimeTest('cancelling aborts without helper use or late output, retaining the paid-call estimate', async t => {
  const app = setup(t), held = gate(); t.after(held.open);
  const calls = fake(t, async () => { await held.promise; return Response.json(answer({ usage: undefined })); });
  const { run: { id } } = await (await app.start()).json();
  assert.equal(app.room.cancelNano({ runId: id, email: 'other@studio.example' }).status, 403);
  assert.deepEqual(app.room.cancelNano({ runId: id, email: user.email }), { ok: true }); assert.equal(calls[0].init.signal.aborted, true);
  held.open(); await app.settle();
  assert.equal(app.room.document.getMap('runs').get(id).status, 'cancelled'); assert.equal(calls.length, 1);
  assert.equal(readCloudGraph(app.room.document).nodes.some(node => node.data.runId === id), false);
  assert.equal(app.directory.nanoUsage(user.email).usedToday, 0); assert.ok(app.directory.nanoUsage(user.email).teamSpentUsd >= .25);
});

runtimeTest('lost responses and the five-minute timeout retain estimates without retrying paid requests', async t => {
  const app = setup(t), calls = fake(t, async () => { throw new TypeError('connection lost'); });
  const { run: { id } } = await (await app.start()).json(); await app.settle();
  assert.match(app.room.document.getMap('runs').get(id).error, /Could not reach GPT Image/);
  const spent = app.directory.nanoUsage(user.email).teamSpentUsd;
  assert.ok(spent >= .25); assert.equal(calls.length, 1);
  t.mock.restoreAll();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = fake(t, init => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
  const started = await app.start(), timedId = (await started.json()).run.id;
  t.mock.timers.tick(5 * 60 * 1000 + 1); await app.settle();
  assert.match(app.room.document.getMap('runs').get(timedId).error, /GPT Image took longer than 5 minutes/);
  assert.equal(timed.length, 1); assert.equal(timed[0].init.signal.aborted, true);
  assert.equal(app.directory.nanoUsage(user.email).usedToday, 0); assert.equal(app.directory.nanoUsage(user.email).teamSpentUsd, spent * 2);
});

runtimeTest('missing references fail before paid calls and refund the entire reservation', async t => {
  const app = setup(t), calls = fake(t); app.files.clear();
  const { run: { id } } = await (await app.start()).json(); await app.settle();
  assert.match(app.room.document.getMap('runs').get(id).error, /reference image is missing/); assert.equal(calls.length, 0);
  assert.deepEqual(app.directory.nanoUsage(user.email), { usedToday: 0, teamSpentUsd: 0 });
});

runtimeTest('MCP starts GPT on the server without a tab, reports it in whoami, and interrupted runs never restart paid calls', async t => {
  const app = setup(t), calls = fake(t);
  await app.room.setName(app.board.id);
  const { mcpApi } = await import('../cloud/mcp.mjs');
  const tool = async (name, args = {}) => {
    const response = await mcpApi.fetch(new Request('http://localhost:8787/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), app.env, { props: user });
    const { result } = await response.json(); assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text);
  };
  const started = await tool('start_run', { boardId: app.board.id, nodeId: 'p' }); assert.equal(started.generator, generators.gptImage); await app.settle(); assert.equal(calls.length, 1);
  const identity = await tool('whoami');
  assert.equal(identity.gptImage.configured, true); assert.equal(identity.gptImage.usedToday, identity.nanoBanana.usedToday);
  const { toolByName, runBoardTool } = await import('../cloud/mcp-tools.mjs');
  const next = runBoardTool(toolByName.get('add_text_node'), { graph: boardGraph({}, false), args: { text: 'A robot', generator: generators.gptImage, variants: 4 }, user, templates: [], prepared: {} });
  assert.equal(next.graph.nodes.at(-1).data.generator, generators.gptImage);
  app.room.document.getMap('runs').set('interrupted', { id: 'interrupted', nodeId: 'p', provider: generators.gptImage, status: 'running' });
  // onStart loads the stored snapshot before checking which paid runs lost their in-memory jobs.
  app.room.storedUpdate = () => null;
  await app.room.onStart();
  assert.equal(app.room.document.getMap('runs').get('interrupted').status, 'failed'); assert.equal(calls.length, 1);
});

test('cloud start/cancel uses the shared server route and never a helper', async () => {
  const doc = new Y.Doc(), calls = [], graph = boardGraph({}, false);
  applyLocalGraph(doc, graph, empty, 'seed');
  const jobs = new CloudGeneration({ doc, boardId: 'board', user, ready: () => true, helperApi: () => assert.fail('helper called'), api: async (path, options) => { calls.push([path, options]); return { run: { id: 'run' } }; } });
  await jobs.startNano('p', generators.gptImage);
  assert.equal(JSON.parse(calls[0][1].body).generator, generators.gptImage);
  doc.getMap('runs').set('run', { id: 'run', nodeId: 'p', provider: generators.gptImage, status: 'running', by: user });
  assert.equal(jobs.remote('run'), true); await jobs.cancel('run');
  assert.equal(calls[0][0], '/api/boards/board/nano'); assert.equal(calls[1][0], '/api/boards/board/nano/run/cancel'); doc.destroy();
});

runtimeTest('one prompt runs Nano and GPT together beside Codex, refuses duplicate Nano, and honours each explicit provider', async t => {
  const app = setup(t, {}, { variants: 2 }), held = gate(); t.after(held.open);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) }); await held.promise;
    return Response.json(String(url).includes('openai') ? answer() : { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: b64(png()) }] }] });
  });
  app.room.document.getMap('runs').set('codex', { id: 'codex', nodeId: 'p', status: 'queued' });
  const path = `/api/boards/${app.board.id}/nano`, start = generator => app.request(path, { method: 'POST', data: { nodeId: 'p', generator } });
  const [first, gpt, second] = await Promise.all([start(generators.nanoBanana), start(generators.gptImage), start(generators.nanoBanana)]);
  // Authentication is asynchronous: either Nano request may win, but exactly one must start.
  assert.deepEqual([first.status, second.status].sort(), [202, 409]); assert.equal(gpt.status, 202);
  const nano = first.status === 202 ? first : second;
  const nanoId = (await nano.json()).run.id, gptId = (await gpt.json()).run.id;
  assert.equal(app.room.document.getMap('runs').get(nanoId).provider, generators.nanoBanana);
  assert.equal(app.room.document.getMap('runs').get(gptId).provider, generators.gptImage);
  // The saved default remains GPT; the Nano request used a copy, including its input snapshot.
  assert.equal(readCloudGraph(app.room.document).nodes.find(node => node.id === 'p').data.generator, generators.gptImage);
  assert.equal(app.room.nanoJobs.get(nanoId).request.target.data.generator, generators.nanoBanana);
  assert.equal(app.room.nanoJobs.get(gptId).request.target.data.generator, generators.gptImage);
  held.open(); await app.settle();
  const graph = readCloudGraph(app.room.document);
  assert.equal(graph.runs.find(run => run.id === nanoId).status, 'completed');
  assert.equal(graph.runs.find(run => run.id === gptId).status, 'completed');
  assert.equal(graph.groups.length, 2); assert.equal(calls.length, 4);
  const groups = graph.groups.map(group => group.nodeIds.map(id => graph.nodes.find(node => node.id === id)));
  assert.notDeepEqual(groups[0][0].position, groups[1][0].position); validateGraph(graph);
  for (const generator of [null, 'codex', 'bogus', {}, 42]) assert.equal((await start(generator)).status, 400);
  assert.equal(calls.length, 4);
});

runtimeTest('the room blocks duplicate provider starts while references are still being checked', async t => {
  const app = setup(t), held = gate(); t.after(held.open);
  const checking = app.room.referencesProblem.bind(app.room);
  app.room.referencesProblem = async (...args) => { await held.promise; return checking(...args); };
  fake(t);
  const first = app.room.startNano({ nodeId: 'p', generator: generators.gptImage, requester: user });
  await new Promise(resolve => setImmediate(resolve));
  const duplicate = await app.room.startNano({ nodeId: 'p', generator: generators.gptImage, requester: user });
  assert.equal(duplicate.status, 409);
  held.open(); assert.ok((await first).run.id); await app.settle();
  assert.equal(app.room.nanoStarting.size, 0);
});

runtimeTest('describe models run together and cancelling Gemini leaves GPT running', async t => {
  const app = setup(t, {}, { task: 'describe' }), held = gate(); t.after(held.open);
  t.mock.method(globalThis, 'fetch', async url => {
    await held.promise;
    return Response.json(String(url).includes('openai') ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'GPT description' }] }] }
      : { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Gemini description' }] }] });
  });
  const [gemini, gpt] = await Promise.all([generators.nanoBanana, generators.gptImage].map(generator => app.room.startNano({ nodeId: 'p', generator, requester: user })));
  assert.ok(gemini.run?.id); assert.ok(gpt.run?.id);
  await app.room.cancelNano({ runId: gemini.run.id, email: user.email });
  assert.equal(app.room.document.getMap('runs').get(gemini.run.id).status, 'cancelled');
  assert.ok(['queued', 'running'].includes(app.room.document.getMap('runs').get(gpt.run.id).status));
  held.open(); await app.settle();
  const graph = readCloudGraph(app.room.document), gptRun = graph.runs.find(run => run.id === gpt.run.id);
  assert.equal(gptRun.status, 'completed');
  assert.equal(graph.nodes.find(node => node.id === gptRun.outputIds[0]).data.text, 'GPT description');
  assert.equal(app.directory.nanoUsage(user.email).usedToday, 0);
});

runtimeTest('the room sends GPT Image the chosen size, quality and background, and keeps a masked image’s shape', async t => {
  const app = setup(t, {}, { aspectRatio: '16:9', imageSize: '2K', gptQuality: 'high', background: 'transparent' }), calls = fake(t), path = `/api/boards/${app.board.id}/nano`;
  // A page from before settings would start a run it cannot show, so it is asked to reload; nothing is reserved or sent.
  const stale = await app.start();
  assert.equal(stale.status, 409); assert.match((await stale.json()).error, /^Reload the page to use generation settings\. /);
  assert.equal(calls.length, 0); assert.deepEqual(app.directory.nanoUsage(user.email), { usedToday: 0, teamSpentUsd: 0 });
  assert.equal((await app.request(path, { method: 'POST', data: { nodeId: 'p', settings: 1 } })).status, 202); await app.settle();
  assert.deepEqual([calls[0].body.size, calls[0].body.quality, calls[0].body.background, calls[0].body.output_format], ['2736x1536', 'high', 'transparent', 'png']);
  let run = readCloudGraph(app.room.document).runs[0];
  assert.deepEqual(run.settings, { requested: { aspectRatio: '16:9', imageSize: '2K', gptQuality: 'high', background: 'transparent' }, applied: { aspectRatio: '16:9', imageSize: '2K', gptQuality: 'high', background: 'transparent' } });
  // With a mask the edit keeps its image's shape (640 × 480 here) at the chosen size.
  const before = readCloudGraph(app.room.document), next = structuredClone(before);
  next.nodes.find(node => node.id === 'i').data.mask = imageMask(reference);
  applyLocalGraph(app.room.document, next, before, 'test');
  app.files.set(`assets/${baseId}`, png(640, 480)); app.files.set(`assets/${maskId}`, png(640, 480));
  assert.equal((await app.request(path, { method: 'POST', data: { nodeId: 'p', settings: 1 } })).status, 202); await app.settle();
  const { width, height } = gptImagePixels(480 / 640, '2K');
  assert.equal(calls[1].body.size, `${width}x${height}`); assert.ok(calls[1].body.mask);
  run = readCloudGraph(app.room.document).runs.find(item => item.id !== run.id);
  assert.deepEqual(run.settings.applied, { imageSize: '2K', gptQuality: 'high', background: 'transparent' });
});

runtimeTest('large GPT Image variants go one (4K) or two (2K) at a time, so a room never holds four large answers at once', async t => {
  const app = setup(t, {}, { imageSize: '4K', variants: 4 }), path = `/api/boards/${app.board.id}/nano`;
  let active = 0, peak = 0;
  const calls = fake(t, async () => { peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return Response.json(answer()); });
  for (const [imageSize, lanes] of [['4K', 1], ['2K', 2], [undefined, 4]]) {
    app.update({ imageSize, variants: 6 }); peak = 0; calls.length = 0;
    assert.equal((await app.request(path, { method: 'POST', data: { nodeId: 'p', settings: 1 } })).status, 202);
    const id = readCloudGraph(app.room.document).runs.at(-1).id;
    // The placeholders after the first lanes say Queued until their call starts.
    assert.equal(app.room.document.getMap('runs').get(id).variantsStarted, lanes);
    await app.settle();
    assert.equal(calls.length, 6, imageSize); assert.equal(peak, lanes, imageSize);
    assert.equal(app.room.document.getMap('runs').get(id).status, 'completed');
  }
});

runtimeTest('GPT descriptions run on the OpenAI key without Gemini, spend zero daily images, and place one text output', async t => {
  const app = setup(t, { GEMINI_API_KEY: '', NANO_BANANA_DAILY_IMAGES: '0' }, { task: 'describe', variants: 4 });
  const usage = { input_tokens: 1000, output_tokens: 500, output_tokens_details: { reasoning_tokens: 100 } };
  const calls = fake(t, () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Only the lighting.' }] }], usage }));
  assert.equal((await app.start()).status, 202); await app.settle();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer company-key'); assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].body.model, gptDescribeModel); assert.equal(calls[0].body.store, false);
  assert.match(calls[0].body.input[0].content[0].text, /Describe the attached images/);
  const image = calls[0].body.input[0].content.find(block => block.type === 'input_image');
  assert.equal(image.image_url, `data:image/png;base64,${b64(png(640, 480))}`); assert.equal(image.detail, 'high');
  const graph = readCloudGraph(app.room.document), [run] = graph.runs, output = graph.nodes.find(node => node.id === run.outputIds[0]);
  assert.deepEqual([run.status, run.task, run.model, run.provider, run.outputIds.length], ['completed', 'describe', gptDescribeModel, generators.gptImage, 1]);
  assert.deepEqual([output.type, output.data.text, output.data.runId], ['text', 'Only the lighting.', run.id]);
  assert.ok(graph.edges.some(edge => edge.source === 'p' && edge.target === output.id));
  const spent = app.directory.nanoUsage(user.email); assert.equal(spent.usedToday, 0); assert.equal(spent.teamSpentUsd, gptDescribeCost(usage));
});

runtimeTest('GPT descriptions enforce setup, access and monthly budget before paid calls', async t => {
  const calls = fake(t);
  for (const [extra, status] of [[{ OPENAI_API_KEY: '' }, 503], [{ NANO_BANANA_ALLOWED: '' }, 403], [{ NANO_BANANA_MONTHLY_USD: '0' }, 429]]) {
    const app = setup(t, extra, { task: 'describe' }); assert.equal((await app.start()).status, status); await app.settle();
  }
  assert.equal(calls.length, 0);
});

runtimeTest('GPT description failures settle billed usage or the estimate and never create an empty text node or retry', async t => {
  for (const mode of ['refusal', 'incomplete', 'http', 'lost']) await t.test(mode, async t => {
    const app = setup(t, {}, { task: 'describe' }), usage = { input_tokens: 100, output_tokens: 20 };
    const calls = fake(t, () => {
      if (mode === 'lost') throw new Error('Lost response');
      return mode === 'http' ? Response.json({ error: { code: 'invalid_api_key', message: 'SECRET' } }, { status: 401 })
        : Response.json({ status: mode === 'incomplete' ? 'incomplete' : 'completed', incomplete_details: { reason: 'max_output_tokens' },
          output: mode === 'refusal' ? [{ type: 'message', content: [{ type: 'refusal', refusal: 'SECRET' }] }] : [], usage });
    });
    assert.equal((await app.start()).status, 202); await app.settle();
    const graph = readCloudGraph(app.room.document), [run] = graph.runs;
    assert.equal(run.status, 'failed'); assert.equal(graph.nodes.length, 2); assert.equal(calls.length, 1); assert.doesNotMatch(run.error, /SECRET|GPT Image/);
    const spent = app.directory.nanoUsage(user.email); assert.equal(spent.usedToday, 0);
    assert.equal(spent.teamSpentUsd, mode === 'http' ? 0 : mode === 'lost' ? gptDescribeEstimate({ promptLength: calls[0].body.input[0].content[0].text.length, references: 1 }) : gptDescribeCost(usage));
  });
});

runtimeTest('MCP creates and starts a GPT description on the server with no helper or Gemini key', async t => {
  const app = setup(t, { GEMINI_API_KEY: '' }), calls = fake(t, () => Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'A robot.' }] }], usage: { input_tokens: 200, output_tokens: 100 } }));
  await app.room.setName(app.board.id);
  const { mcpApi } = await import('../cloud/mcp.mjs');
  const tool = async (name, args) => {
    const response = await mcpApi.fetch(new Request('http://localhost:8787/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), app.env, { props: user });
    const { result } = await response.json(); assert.equal(result.isError, undefined, JSON.stringify(result)); return JSON.parse(result.content[0].text);
  };
  const { nodeId } = await tool('add_text_node', { boardId: app.board.id, text: 'Only lighting', describe: true, generator: 'gpt-image' });
  await tool('connect_nodes', { boardId: app.board.id, source: 'i', target: nodeId });
  const started = await tool('start_run', { boardId: app.board.id, nodeId }); await app.settle();
  assert.equal(started.generator, 'gpt-image'); assert.equal(calls.length, 1);
  const run = readCloudGraph(app.room.document).runs[0]; assert.equal(run.status, 'completed'); assert.equal(run.model, gptDescribeModel);
  assert.equal(app.directory.nanoUsage(user.email).usedToday, 0);
});

runtimeTest('cancelled GPT descriptions keep the billed estimate and discard late text', async t => {
  const app = setup(t, {}, { task: 'describe' }), held = gate(); t.after(held.open);
  const calls = fake(t, async () => { await held.promise; return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Late text.' }] }] }); });
  const { run: { id } } = await (await app.start()).json();
  assert.deepEqual(app.room.cancelNano({ runId: id, email: user.email }), { ok: true }); assert.equal(calls[0].init.signal.aborted, true);
  held.open(); await app.settle();
  assert.equal(app.room.document.getMap('runs').get(id).status, 'cancelled'); assert.equal(calls.length, 1);
  assert.equal(readCloudGraph(app.room.document).nodes.length, 2);
  assert.deepEqual(app.directory.nanoUsage(user.email), { usedToday: 0, teamSpentUsd: gptDescribeEstimate({ promptLength: calls[0].body.input[0].content[0].text.length, references: 1 }) });
});
