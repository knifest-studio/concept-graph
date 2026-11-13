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
import { generators, imageSize, modelNames, validateGraph } from '../graph.mjs';
import { NanoError, nanoPrompt } from '../cloud/nano-banana.mjs';
import { nanoState, usesSiteGenerator } from '../src/generator.mjs';
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
  assert.match(request.prompt, /Edit “Front view” \(Attachment 1\)\. The other attachments are references for the request\./);
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
  assert.match(calls[0].body.prompt, /Edit “Front view” \(Attachment 1\)/);
  const graph = readCloudGraph(app.room.document);
  assert.equal(graph.nodes.find(node => node.id === 'p').data.mainImage, 'i');
  assert.equal(graph.runs[0].status, 'completed');
  assert.ok(graph.edges.every(edge => Object.keys(edge).sort().join() === 'id,source,target'));
});

test('GPT mask prompts reorder the target and converted PNG first and number references in the submitted order', () => {
  const graph = boardGraph(), target = graph.nodes[1]; target.data.mask = imageMask(reference);
  graph.nodes.push({ id: 'style', type: 'image', position: { x: 0, y: 0 }, data: { asset: reference, caption: 'Style' } }); graph.edges.unshift({ id: 'sp', source: 'style', target: 'p' });
  const request = gptImagePrompt(graph, 'p');
  assert.deepEqual(request.images.map(image => image.asset), [baseId, reference]); assert.equal(request.mask, maskId);
  assert.match(request.prompt, /Attachment 1: “Front view”/); assert.match(request.prompt, /Attachment 2: “Style”/); assert.match(request.prompt, /Edit only the masked area/);
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
  app.files.set(`assets/${maskId}`, new Uint8Array(20 * 1024 * 1024));
  const { run: { id } } = await (await app.start()).json(); await app.settle();
  assert.match(app.room.document.getMap('runs').get(id).error, /20 MB in total/); assert.equal(calls.length, 1);
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
  assert.deepEqual(gptImageSettings({}), { configured: false, dailyImages: 50, monthlyUsd: 50, endpoint: 'https://api.openai.com' });
  assert.deepEqual(gptImageSettings({ OPENAI_API_KEY: 'key', NANO_BANANA_DAILY_IMAGES: '2', NANO_BANANA_MONTHLY_USD: '1.25', GPT_IMAGE_ENDPOINT: 'http://127.0.0.1:8789/path' }),
    { configured: true, dailyImages: 2, monthlyUsd: 1.25, endpoint: 'http://127.0.0.1:8789' });
  assert.equal(gptImageSettings({ OPENAI_API_KEY: '  ', GEMINI_API_KEY: 'key' }).configured, false);
  for (const endpoint of ['https://evil.example', 'http://localhost.evil.example', 'file:///tmp/key', 'nonsense']) assert.equal(gptImageSettings({ GPT_IMAGE_ENDPOINT: endpoint }).endpoint, 'https://api.openai.com');
  assert.equal(gptImageSettings({ GPT_IMAGE_ENDPOINT: 'http://[::1]:8789' }).endpoint, 'http://[::1]:8789');
});

test('generation and edit requests keep named context, fixed model/settings and standard aspect sizes', () => {
  const graph = boardGraph(), request = gptImagePrompt(graph, 'p');
  assert.match(request.prompt, /Attachment 1: “Front view”/);
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
  const order = text => [...gptImagePrompt(graph(text), 'p').prompt.matchAll(/Attachment \d: “([^”]+)”/g)].map(match => match[1]);
  assert.deepEqual(order('налаштуй кольори на Image 32 щоб були як на Image 35'), ['Image 32', 'Image 35', 'Image 3']);
  assert.deepEqual(order('Recolor image 3 like Image 35'), ['Image 3', 'Image 35', 'Image 32']);
  assert.deepEqual(order('A courier robot'), ['Image 35', 'Image 32', 'Image 3']);
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
  for (const task of ['describe', 'upscale']) assert.throws(() => validateGraph(boardGraph({ task })), /GPT Image only generates images/);
});

test('changed JSX compiles and the real picker renders three cloud generators, disabled setup, and no GPT descriptions', async () => {
  for (const file of ['main.jsx', 'CloudWorkspace.jsx', 'TeamAccessDialog.jsx']) await transformWithEsbuild(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'), file, { loader: 'jsx' });
  const source = (await readFile(new URL('../src/GeneratorPicker.jsx', import.meta.url), 'utf8')).replace(/import .*?;\n/g, '');
  const compiled = await transformWithEsbuild(source, 'GeneratorPicker.jsx', { loader: 'jsx', format: 'cjs' });
  const module = { exports: {} };
  new Function('module', 'exports', 'React', 'generators', 'maxVariants', 't', compiled.code)(module, module.exports, React, generators, 4, translate);
  const props = { id: 'p', generator: generators.gptImage, nano: { selectable: true, note: 'Ready' }, gpt: { selectable: false, note: 'GPT Image isn’t set up on this site' }, choose() {} };
  const markup = renderToStaticMarkup(React.createElement(module.exports.GeneratorPicker, { ...props, generator: null }));
  assert.match(markup, /value="nano-banana"/); assert.match(markup, /value="gpt-image" disabled/); assert.match(markup, /GPT Image isn’t set up/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(module.exports.GeneratorPicker, { ...props, describe: true })), /GPT Image/);
  setLanguage('uk');
  try {
    const uk = renderToStaticMarkup(React.createElement(module.exports.GeneratorPicker, { ...props, generator: null, gpt: nanoState({ configured: false }, generators.gptImage) }));
    assert.match(uk, /GPT Image не налаштовано/); assert.equal(translate('Generate with GPT Image'), 'Згенерувати через GPT Image');
  } finally { setLanguage('en'); }
});

test('the local OpenAI stand-in validates real requests and produces PNGs without opening a socket', async () => {
  const { picture, send } = await import('../scripts/fake-image.mjs');
  const source = (await readFile(new URL('../scripts/fake-openai.mjs', import.meta.url), 'utf8')).replace(/import .*?;\n/g, '');
  let handler;
  const createServer = callback => { handler = callback; return { listen() {} }; };
  new Function('createServer', 'picture', 'send', 'process', 'console', source)(createServer, picture, send, { env: {} }, { log() {} });
  const respond = async (prompt, references = []) => {
    const { url, init } = gptImageRequest(prompt, references, { key: 'fake' });
    const request = { method: 'POST', url: new URL(url).pathname, headers: { authorization: init.headers.Authorization }, async *[Symbol.asyncIterator]() { yield Buffer.from(init.body); } };
    let status, body;
    await handler(request, { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } });
    return { status, body };
  };
  const generated = await respond('robot'); assert.equal(generated.status, 200); assert.deepEqual(imageSize(gptImageResult(200, generated.body).images[0].bytes), { width: 1024, height: 1024 });
  const edited = await respond('robot', [{ mimeType: 'image/png', data: b64(png()) }]); assert.equal(edited.status, 200); assert.equal(edited.body.usage.input_tokens_details.image_tokens, 1120);
  for (const [mode, code] of [['refuse', 'moderation_blocked'], ['busy', 'rate_limit_exceeded'], ['credit', 'insufficient_quota'], ['key', 'invalid_api_key'], ['verify', 'permission_denied']]) assert.equal((await respond(`[${mode}]`)).body.error.code, code);
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
  assert.deepEqual(status.gptImage, { configured: true, allowed: true, dailyImages: 50, usedToday: 0, monthlyUsd: 50, teamSpentUsd: 0 });
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
  await jobs.startNano('p');
  doc.getMap('runs').set('run', { id: 'run', nodeId: 'p', provider: generators.gptImage, status: 'running', by: user });
  assert.equal(jobs.remote('run'), true); await jobs.cancel('run');
  assert.equal(calls[0][0], '/api/boards/board/nano'); assert.equal(calls[1][0], '/api/boards/board/nano/run/cancel'); doc.destroy();
});
