import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import * as Y from 'yjs';
import { signSession, userColor } from '../cloud/auth.mjs';
import { readFile } from 'node:fs/promises';
import { defaultDailyImages, defaultMonthlyUsd, NanoError, nanoAllowed, nanoCost, nanoEstimate, nanoPrompt, nanoRequest, nanoResult, nanoSettings, nanoTimeout, staleSettings, staleSettingsError, variantLanes, variantLanesFor, variantRunTimeout } from '../cloud/nano-banana.mjs';
import { clampVariants, imageSize, maxVariants, promptVariants, validateGraph, variantPresets } from '../graph.mjs';
import { runPlaceholders } from '../src/run-placeholders.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { CloudGeneration } from '../src/cloud-generation.mjs';
import { nanoState } from '../src/generator.mjs';
import { placeRunOutput } from '../src/run-outputs.mjs';

// Only the Cloudflare base class is replaced; routing, Yjs, SQL and the rooms run for real. Google is a fake fetch.
let DatabaseSync, worker, BoardRoom, Directory;
if (nodeModule.registerHooks) {
  ({ DatabaseSync } = await import('node:sqlite'));
  const hooks = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== 'cloudflare:workers') return nextResolve(specifier, context);
      return { url: 'data:text/javascript,' + encodeURIComponent('export const env = {}; export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), shortCircuit: true };
    }
  });
  try { ({ default: worker, BoardRoom, Directory } = await import('../cloud/worker.mjs')); }
  finally { hooks.deregister(); }
}
const runtimeTest = nodeModule.registerHooks ? test : test.skip;

// PNG signature and header: enough for format and size detection.
function png(width = 1, height = 1) {
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]); view.setUint32(16, width); view.setUint32(20, height); bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}
const b64 = bytes => Buffer.from(bytes).toString('base64');
const usage = { total_input_tokens: 1500, total_output_tokens: 2280, total_thought_tokens: 400, total_tokens: 4180, output_tokens_by_modality: [{ modality: 'image', tokens: 2240 }, { modality: 'text', tokens: 40 }] };
// The shape of a completed Interaction: a thought step (which may hold a draft image) and the model's output step.
const interaction = (images, extra = {}) => ({ id: 'interaction-1', object: 'interaction', status: 'completed', model: 'gemini-nano-banana-2.1', created: '2026-11-04T10:00:00Z', updated: '2026-11-04T10:00:20Z',
  steps: [{ type: 'thought', summary: [{ type: 'image', mime_type: 'image/png', data: b64(png(8, 8)) }] }, { type: 'model_output', content: [{ type: 'text', text: 'Here is your image.' }, ...images.map(bytes => ({ type: 'image', mime_type: 'image/png', data: b64(bytes) }))] }],
  usage, ...extra });
const user = { name: 'Lead', color: userColor('lead@studio.example') };
const reference = '12345678-1234-1234-1234-123456789abc.png';
const seed = { nodes: [
  { id: 'p', type: 'text', position: { x: 80, y: 40 }, data: { text: 'A courier robot at dawn', generator: 'nano-banana' } },
  { id: 'c', type: 'text', position: { x: -400, y: 200 }, data: { text: 'Soft painterly style', template: { name: 'Style', instructions: 'Use warm light', assets: [] } } },
  { id: 'i', type: 'image', position: { x: -310, y: 0 }, data: { asset: reference, caption: 'Front view' } },
  { id: 'far', type: 'text', position: { x: -900, y: 0 }, data: { text: 'Not connected to the prompt' } },
], edges: [{ id: 'e1', source: 'c', target: 'p' }, { id: 'e2', source: 'i', target: 'p' }, { id: 'e3', source: 'far', target: 'c' }], groups: [], runs: [] };
const empty = { nodes: [], edges: [], groups: [], runs: [] };

test('Nano Banana places highlighted copies directly after masked images; descriptions ignore masks', () => {
  const graph = structuredClone(seed), image = graph.nodes.find(node => node.id === 'i'), marked = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png';
  image.data.mask = { asset: reference, marked, base: reference, source: reference };
  const request = nanoPrompt(graph, 'p');
  assert.deepEqual(request.images.map(image => image.asset), [reference, marked]);
  assert.match(request.prompt, /Attachment 1: “Front view”/); assert.match(request.prompt, /Attachment 2: “Front view \(highlighted edit area\)”/);
  assert.match(request.prompt, /Edit only the highlighted area/); assert.match(request.prompt, /must not contain the highlight/);
  const { init } = nanoRequest(request.prompt, request.images.map(image => ({ ...image, mimeType: 'image/png', data: image.asset })), { key: 'fake', endpoint: 'https://example.test' });
  assert.deepEqual(JSON.parse(init.body).input.filter(part => part.type === 'image').map(part => part.data), [reference, marked]);
  image.data.mask.source = marked;
  assert.throws(() => nanoPrompt(graph, 'p'), /no longer matches/);
  graph.nodes[0].data.task = 'describe'; const describe = nanoPrompt(graph, 'p');
  assert.deepEqual(describe.images.map(image => image.asset), [reference]); assert.doesNotMatch(describe.prompt, /highlight|masked area/);
});

runtimeTest('Nano Banana loads the marked copy from R2, includes its bytes in limits and never calls Google on missing highlights', async t => {
  const app = cloudSetup(t), marked = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', before = readCloudGraph(app.boardRoom.document), next = structuredClone(before);
  next.nodes.find(node => node.id === 'i').data.mask = { asset: reference, marked, base: reference, source: reference };
  applyLocalGraph(app.boardRoom.document, next, before, 'test');
  const calls = []; t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push(JSON.parse(init.body)); return Response.json(interaction([png()])); });
  const start = () => app.boardRoom.startNano({ nodeId: 'p', requester: { ...user, email: 'lead@studio.example' } });
  let result = await start(); assert.ok(result.run); await app.settle();
  assert.match(app.boardRoom.document.getMap('runs').get(result.run.id).error, /reference image is missing/); assert.equal(calls.length, 0);
  app.files.set(`assets/${marked}`, { bytes: png(640, 480), size: 20 * 1024 * 1024 });
  // Without Cloudflare Images nothing can be reduced, so a set over Gemini's budget is refused before anything is reserved.
  result = await start(); assert.equal(result.status, 400); assert.match(result.error, /too large for Nano Banana \(14\.8 MB in total\)/); assert.equal(calls.length, 0);
  assert.equal(app.directory.nanoUsage('lead@studio.example').usedToday, 0);
  app.files.set(`assets/${marked}`, { bytes: png(640, 480), size: 33 });
  result = await start(); await app.settle(); assert.equal(calls.length, 1); assert.equal(calls[0].input.filter(part => part.type === 'image').length, 2);
  assert.equal(app.boardRoom.document.getMap('runs').get(result.run.id).status, 'completed');
});

test('the allowed list matches whole emails and whole @domains in any case', () => {
  const list = ' Lead@Studio.example, @team.example;other@mail.example\nplain.example ';
  for (const email of ['lead@studio.example', 'LEAD@Studio.EXAMPLE', 'anyone@team.example', 'Other@Mail.Example', 'x@plain.example']) assert.equal(nanoAllowed(email, list), true, email);
  for (const email of ['someone@studio.example', 'lead@studio.example.evil', 'x@sub.team.example', 'x@evilteam.example', 'team.example@evil.example', 'other@mail.example.org', '@team.example', 'nobody']) assert.equal(nanoAllowed(email, list), false, email);
  assert.equal(nanoAllowed('lead@studio.example', ''), false); assert.equal(nanoAllowed('lead@studio.example', undefined), false);
});

test('settings come from the Worker environment with safe defaults, and the endpoint override stays on this machine', () => {
  const google = 'https://generativelanguage.googleapis.com';
  assert.deepEqual(nanoSettings({}), { configured: false, dailyImages: 100, monthlyUsd: 100, endpoint: google });
  assert.deepEqual(nanoSettings({ GEMINI_API_KEY: 'k', NANO_BANANA_DAILY_IMAGES: '20', NANO_BANANA_MONTHLY_USD: '12.5', NANO_BANANA_ENDPOINT: 'http://127.0.0.1:8788/' }),
    { configured: true, dailyImages: 20, monthlyUsd: 12.5, endpoint: 'http://127.0.0.1:8788' });
  assert.equal(nanoSettings({ GEMINI_API_KEY: '  ' }).configured, false);
  assert.deepEqual(nanoSettings({ NANO_BANANA_DAILY_IMAGES: 'many', NANO_BANANA_MONTHLY_USD: '-1' }), { configured: false, dailyImages: 100, monthlyUsd: 100, endpoint: google });
  assert.equal(nanoSettings({ NANO_BANANA_DAILY_IMAGES: 0 }).dailyImages, 0);
  for (const endpoint of ['https://attacker.example', 'http://localhost.attacker.example', 'file:///etc/passwd', 'not a url']) assert.equal(nanoSettings({ NANO_BANANA_ENDPOINT: endpoint }).endpoint, google, endpoint);
  assert.equal(nanoSettings({ NANO_BANANA_ENDPOINT: 'http://localhost:9000' }).endpoint, 'http://localhost:9000');
});

test('the deployed limits are 100 images per person a day and $100 a team month, the same as the code falls back to', async () => {
  const { vars } = JSON.parse(await readFile(new URL('../cloud/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual([defaultDailyImages, defaultMonthlyUsd], [100, 100]);
  const deployed = nanoSettings(vars), fallback = nanoSettings({});
  assert.deepEqual([deployed.dailyImages, deployed.monthlyUsd], [fallback.dailyImages, fallback.monthlyUsd]);
});

test('variant counts: presets up to 16, any whole number up to 32, and a run limit that grows by waves under 15 minutes', () => {
  assert.deepEqual(variantPresets, [1, 2, 4, 8, 16]); assert.equal(maxVariants, 32); assert.equal(variantLanes, 4);
  assert.deepEqual([0, -3, 1, 2.4, 2.6, 6, 32, 33, 1000, NaN, '12', ''].map(clampVariants), [1, 1, 1, 2, 3, 6, 32, 32, 32, 1, 12, 1]);
  const node = variants => ({ id: 'q', type: 'text', position: { x: 0, y: 0 }, data: { text: 'x', variants } });
  for (const good of [2, 6, 16, 32]) { assert.doesNotThrow(() => validateGraph({ nodes: [node(good)], edges: [] })); assert.equal(promptVariants(node(good)), good); }
  for (const bad of [0, 1, 33, 2.5]) assert.throws(() => validateGraph({ nodes: [node(bad)], edges: [] }), /Invalid number of variants/);
  assert.deepEqual([1, 4, 5, 8, 16, 20, 32].map(count => variantRunTimeout(count) / 60000), [5, 5, 7, 7, 11, 13, 14]);
  assert.equal(variantRunTimeout(1), nanoTimeout);
  // Large images go fewer at a time, and the run's limit grows with the waves that makes (still under 15 minutes).
  assert.deepEqual([{}, { imageSize: '2K' }, { imageSize: '4K' }, { gpt: true }, { gpt: true, imageSize: '2K' }, { gpt: true, imageSize: '4K' }].map(variantLanesFor), [4, 4, 2, 4, 2, 1]);
  assert.deepEqual([[4, 1], [6, 1], [8, 2], [16, 2], [32, 1]].map(([count, lanes]) => variantRunTimeout(count, lanes) / 60000), [11, 14, 11, 14, 14]);
});

test('the request sends the prompt, connected context and labelled references, without Codex tool instructions', () => {
  const { prompt, images, target } = nanoPrompt(seed, 'p');
  assert.equal(target.id, 'p'); assert.deepEqual(images, [{ asset: reference, label: 'Front view', nodeId: 'i' }]);
  assert.equal(prompt, `Create an image for the request at the end. The earlier text is context for it, not separate requests.\n\nContext 1:\nCustom node instructions:\nUse warm light\n\nSoft painterly style\n\nAttached images, in order. The request may point at an image by its name on the board, its node ID or its file name; each of these means that image:\nAttachment 1: “Front view” (node ID i; file ${reference})\n\nRequest:\nA courier robot at dawn`);
  assert.doesNotMatch(prompt, /built-in image tool|paid API|Not connected/);
  // A lone prompt is sent as written.
  assert.equal(nanoPrompt({ nodes: [seed.nodes[0]], edges: [] }, 'p').prompt, 'A courier robot at dawn');
  assert.throws(() => nanoPrompt(seed, 'i'), /Write an image prompt first/);
  const many = { nodes: [seed.nodes[0], ...Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, type: 'image', position: { x: 0, y: i * 400 }, data: { asset: reference } }))], edges: Array.from({ length: 11 }, (_, i) => ({ id: `e${i}`, source: `r${i}`, target: 'p' })) };
  assert.throws(() => nanoPrompt(many, 'p'), /at most 10/);
  const { url, init } = nanoRequest(prompt, [{ mimeType: 'image/png', data: 'AQID' }], { key: 'secret', endpoint: 'https://generativelanguage.googleapis.com' });
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(init.method, 'POST'); assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'x-goog-api-key': 'secret', 'Api-Revision': '2026-05-20' });
  assert.deepEqual(JSON.parse(init.body), { model: 'gemini-nano-banana-2.1', input: [{ type: 'text', text: prompt }, { type: 'image', mime_type: 'image/png', data: 'AQID' }], store: false });
  assert.doesNotMatch(init.body, /secret/);
});

test('generation and describe interleave exact board names with the corresponding image bytes', () => {
  const graph = structuredClone(seed);
  graph.nodes.find(node => node.id === 'i').data.caption = 'Image 1';
  graph.nodes.push({ id: 'first', type: 'image', position: { x: 0, y: 0 }, data: { asset: reference, label: 'image.png' } });
  graph.edges.unshift({ id: 'e0', source: 'first', target: 'p' });
  for (const describe of [false, true]) {
    if (describe) graph.nodes[0].data.task = 'describe';
    const { prompt, images } = nanoPrompt(graph, 'p');
    assert.deepEqual(prompt.split('\n').filter(line => line.startsWith('Attachment ')), [
      `Attachment 1: “Image” (node ID first; file ${reference}, uploaded as image.png)`,
      `Attachment 2: “Image 1” (node ID i; file ${reference})`,
    ]);
    const references = images.map((image, index) => ({ ...image, mimeType: 'image/png', data: `bytes-${index}` }));
    const { init } = nanoRequest(prompt, references, { key: 'key', endpoint: 'https://generativelanguage.googleapis.com' });
    assert.deepEqual(JSON.parse(init.body).input, [
      { type: 'text', text: prompt },
      { type: 'text', text: `Attachment 1: “Image” (node ID first; file ${reference}, uploaded as image.png)` }, { type: 'image', mime_type: 'image/png', data: 'bytes-0' },
      { type: 'text', text: `Attachment 2: “Image 1” (node ID i; file ${reference})` }, { type: 'image', mime_type: 'image/png', data: 'bytes-1' },
    ]);
  }
});

test('responses give every final image with its format, and failures become clear typed errors', () => {
  const result = nanoResult(200, interaction([png(200, 100), png(64, 64)]));
  assert.deepEqual(result.images.map(image => [image.format, image.contentType, image.bytes.length]), [['png', 'image/png', 33], ['png', 'image/png', 33]]);
  assert.equal(result.usage, usage);
  const fails = (status, body, kind, message) => assert.throws(() => nanoResult(status, body), error => error instanceof NanoError && error.kind === kind && message.test(error.message));
  fails(400, { error: { code: 'safety', message: 'Request blocked due to safety violations.' } }, 'refused', /declined this prompt/);
  fails(400, { error: { code: 'prohibited_content', message: 'Input blocked: prohibited content' } }, 'refused', /safety filters/);
  fails(200, interaction([], { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I can’t   make that image.' }] }] }), 'no_image', /returned no image: “I can’t make that image\.”/);
  fails(200, interaction([], { steps: [] }), 'no_image', /returned no image\. Try rephrasing/);
  fails(200, interaction([], { status: 'failed', steps: [], errors: [{ code: 'https://generativelanguage.googleapis.com/errors/image_safety', message: 'Output blocked' }] }), 'refused', /declined/);
  fails(429, { error: { code: 'rate_limit_exceeded', message: 'Slow down' } }, 'busy', /busy right now/);
  fails(429, { error: { code: 'quota_exceeded', message: 'Quota' } }, 'busy', /quota is used up/);
  fails(503, { error: { code: 'service_unavailable', message: 'Overloaded' } }, 'busy', /busy/);
  fails(500, null, 'upstream', /failed \(500\)/);
  fails(401, { error: { code: 'authentication', message: 'API key not valid' } }, 'config', /rejected the site’s Gemini API key/);
  fails(402, { error: { code: 'payment_required', message: 'Billing' } }, 'config', /billing/);
  fails(404, { error: { code: 'model_not_found', message: 'No model' } }, 'config', /not available to the site’s Gemini key/);
  fails(400, { error: { code: 'invalid_request', message: 'Image\n  too large for this model.' } }, 'bad_request', /could not use this request: Image too large for this model\./);
  fails(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Bad image' } }, 'bad_request', /Bad image/);
  fails(200, interaction([new TextEncoder().encode('not an image')]), 'upstream', /format the board cannot show/);
  fails(200, interaction([], { steps: [{ type: 'model_output', content: [{ type: 'image', data: '%%%' }] }] }), 'upstream', /unreadable image/);
  fails(200, 'nonsense', 'upstream', /unreadable response/);
});

test('cost follows the usage Google returns, with a conservative estimate when it does not', () => {
  // 1500 input tokens at $1.50/M, 2240 image tokens at $30/M, 40 text + 400 thinking tokens at $7.50/M.
  assert.equal(Math.round(nanoCost(usage, { images: 2 }) * 1e6), 72750);
  // Without a modality breakdown, each image is counted at 1120 tokens and the rest of the output as text.
  assert.equal(Math.round(nanoCost({ total_input_tokens: 100, total_output_tokens: 1200 }, { images: 1 }) * 1e6), Math.round(100 * 1.5 + 1120 * 30 + 80 * 7.5));
  const estimate = nanoEstimate({ promptLength: 3000, references: 2, images: 1 });
  assert.equal(Math.round(estimate * 1e6), Math.round((1000 + 2240) * 1.5 + 1120 * 30 + 4000 * 7.5));
  assert.equal(nanoCost(undefined, { promptLength: 3000, references: 2, images: 1 }), estimate);
  assert.ok(estimate > nanoCost(usage, { images: 1 }) / 2 && nanoEstimate() > 0.0336);
});

test('prompts may choose site generators; unknown generator values are rejected', () => {
  assert.doesNotThrow(() => validateGraph(seed));
  assert.throws(() => validateGraph({ nodes: [{ ...seed.nodes[0], data: { text: 'x', generator: 'dall-e' } }], edges: [] }), /Invalid image generator/);
});

test('the generator menu says what Nano Banana can do for this person', () => {
  assert.deepEqual(nanoState(undefined), { selectable: true, ready: true, note: 'Uses the site’s Gemini key', budget: '', fal: true });
  assert.deepEqual(nanoState({ configured: false, allowed: true }), { selectable: false, ready: false, note: 'Nano Banana isn’t set up on this site', budget: '', fal: true });
  assert.deepEqual(nanoState({ configured: true, allowed: false }), { selectable: false, ready: false, note: 'Not available for your account. Ask a site admin for access.', budget: '', fal: true });
  const status = { configured: true, allowed: true, dailyImages: 50, usedToday: 12, monthlyUsd: 50, teamSpentUsd: 3.2 };
  assert.deepEqual(nanoState(status), { selectable: true, ready: true, note: '38 of 50 left today', budget: 'Team: $3.20 of $50 this month', fal: true });
  // Topaz and SeedVR2 need the site's fal.ai key; the status says when it is missing.
  assert.equal(nanoState({ ...status, fal: false }).fal, false);
  assert.deepEqual(nanoState({ ...status, usedToday: 51 }), { selectable: true, ready: false, note: 'Daily limit reached (50/50)', budget: 'Team: $3.20 of $50 this month', fal: true });
  assert.equal(nanoState({ ...status, teamSpentUsd: 50 }).note, 'Team budget for this month is used up');
  assert.equal(nanoState({ ...status, teamSpentUsd: 50 }).ready, false);
});

test('one shared step places each output beside its prompt, captions and groups them, and skips finished runs', () => {
  const run = { id: 'run', nodeId: 'p', label: 'Robot', status: 'running', by: user, startedAt: '2026-11-04T10:00:00.000Z' };
  const before = { nodes: [seed.nodes[0]], edges: [], groups: [], runs: [run] };
  const first = placeRunOutput(before, { runId: 'run', nodeId: 'p', run, author: user, output: { index: 0 }, asset: reference, dimensions: { width: 200, height: 100 } });
  const one = first.nodes.find(node => node.id === 'run-output-0');
  assert.deepEqual(one.position, { x: 470, y: 40 }); assert.equal(one.data.caption, 'Image 1'); assert.equal(one.data.aspect, 0.5); assert.deepEqual(one.data.author, user);
  assert.deepEqual(first.edges, [{ id: 'run-output-0-edge', source: 'p', target: 'run-output-0' }]); assert.deepEqual(first.groups, []);
  assert.deepEqual(first.runs.at(-1), { ...run, status: 'running', outputIds: ['run-output-0'], count: 1 });
  const second = placeRunOutput(first, { runId: 'run', nodeId: 'p', run: first.runs.at(-1), author: user, output: { index: 1 }, asset: reference, dimensions: { width: 100, height: 100 } });
  const [a, b] = ['run-output-0', 'run-output-1'].map(id => second.nodes.find(node => node.id === id));
  assert.deepEqual([a.data.caption, b.data.caption], ['Image 1', 'Image 2']);
  assert.deepEqual(b.position, { x: 470, y: 40 + 155 + 30 + 24 });
  assert.deepEqual(second.groups, [{ id: 'run-group', name: 'Group 1', nodeIds: ['run-output-0', 'run-output-1'], collapsed: false, slideshow: true }]);
  assert.equal(second.runs.at(-1).autoGroupId, 'run-group'); assert.equal(first.nodes.find(node => node.id === 'run-output-0').data.caption, 'Image 1');
  assert.equal(placeRunOutput(second, { runId: 'run', nodeId: 'p', run: second.runs.at(-1), author: user, output: { index: 1 }, asset: reference }), null);
  assert.equal(placeRunOutput(second, { runId: 'run', nodeId: 'p', run: { ...second.runs.at(-1), status: 'cancelled' }, author: user, output: { index: 2 }, asset: reference }), null);
  assert.doesNotThrow(() => validateGraph(second));
});

test('output names use all pages and earlier runs without rewriting model captions or user edits', () => {
  const before = structuredClone(seed);
  before.nodes.find(node => node.id === 'i').data.caption = 'Image 1';
  before.nodes.push({ id: 'old', type: 'image', position: { x: 0, y: 0 }, page: 'other', data: { asset: reference, caption: 'Front view' } });
  const run = { id: 'run', nodeId: 'p', status: 'running' };
  const first = placeRunOutput(before, { runId: run.id, nodeId: 'p', run, output: { index: 0 }, asset: reference });
  assert.equal(first.nodes.at(-1).data.caption, 'Image 2');
  const second = placeRunOutput(first, { runId: run.id, nodeId: 'p', run: first.runs.at(-1), output: { index: 1, caption: '  Front view  ' }, asset: reference });
  assert.equal(second.nodes.at(-1).data.caption, 'Front view 2');
  assert.equal(first.nodes.at(-1).data.caption, 'Image 2');
  second.nodes.find(node => node.id === 'run-output-0').data.caption = 'My name';
  const third = placeRunOutput(second, { runId: run.id, nodeId: 'p', run: second.runs.at(-1), output: { index: 2, caption: 'My name' }, asset: reference });
  assert.equal(third.nodes.at(-1).data.caption, 'My name 2');
  assert.equal(third.nodes.find(node => node.id === 'run-output-0').data.caption, 'My name');
  const next = placeRunOutput(third, { runId: 'next', nodeId: 'p', output: { index: 0 }, asset: reference });
  assert.equal(next.nodes.at(-1).data.caption, 'Image 2');
});

test('Nano Banana prompts start and cancel through the board API, never through the helper', async () => {
  const doc = new Y.Doc(), calls = [], started = [];
  applyLocalGraph(doc, seed, empty, 'seed');
  let live = true;
  const generation = new CloudGeneration({ doc, boardId: 'board', user, ready: () => live, onStart: run => started.push(run.id), onError: () => {},
    api: async (url, options) => { calls.push([url, options]); return url.endsWith('/nano') ? { run: { id: 'nano-run' } } : { ok: true }; },
    helperApi: async () => { throw new Error('The helper must not be used.'); }, helperRequest: async () => { throw new Error('The helper must not be used.'); } });
  doc.getMap('nodes').get('p').get('data').set('text', 'Edited just now');
  await generation.startNano('p');
  assert.equal(calls[0][0], '/api/boards/board/nano'); assert.equal(calls[0][1].method, 'POST');
  // settings: 1 tells the room this page shows generation settings.
  assert.deepEqual(JSON.parse(calls[0][1].body), { nodeId: 'p', client: doc.clientID, clock: Y.getState(doc.store, doc.clientID), settings: 1 });
  assert.deepEqual(started, ['nano-run']);
  doc.getMap('runs').set('nano-run', { id: 'nano-run', nodeId: 'p', status: 'running', provider: 'nano-banana', model: 'gemini-nano-banana-2.1', by: user, startedAt: '2026-11-04T10:00:00.000Z' });
  await generation.startNano('p');
  assert.equal(calls.length, 1, 'a generating prompt is not started twice');
  assert.equal(generation.remote('nano-run'), true);
  await generation.cancel('nano-run');
  assert.deepEqual(calls[1], ['/api/boards/board/nano/nano-run/cancel', { method: 'POST' }]);
  doc.getMap('runs').set('theirs', { id: 'theirs', nodeId: 'c', status: 'running', provider: 'nano-banana', by: { name: 'Other' } });
  await generation.cancel('theirs');
  assert.equal(calls.length, 2);
  live = false;
  await assert.rejects(generation.startNano('c'), /live board connection/);
  doc.destroy();
});

function cloudSetup(t, extra = {}) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql = { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  const files = new Map(), waits = [], rooms = new Map();
  let directory;
  const env = {
    SESSION_SECRET: 'session-test', GEMINI_API_KEY: 'test-gemini-key', NANO_BANANA_ALLOWED: '@studio.example, solo@mail.example',
    Directory: { idFromName: name => name, get: () => directory },
    BoardRoom: { idFromName: name => name, get: name => rooms.get(name) || room(name) },
    FILES: {
      async put(key, bytes, metadata) { files.set(key, { bytes: new Uint8Array(bytes), size: bytes.byteLength, ...metadata }); },
      async get(key) { const file = files.get(key); return file ? { size: file.size, arrayBuffer: async () => file.bytes.slice().buffer, get body() { return new Blob([file.bytes]).stream(); } } : null; },
      async head(key) { return files.get(key) || null; },
      async list({ prefix }) { return { objects: [...files.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key, customMetadata: files.get(key).customMetadata })), truncated: false }; },
      async delete(keys) { for (const key of [keys].flat()) files.delete(key); },
    },
    ASSETS: { fetch: async () => new Response('static') }, ...extra,
  };
  // The directory copies NANO_BANANA_ALLOWED into its own list when it first starts.
  directory = new Directory({ storage: { sql } }, env);
  // One room per board, as Durable Objects are; `values` is the room's own storage.
  const room = (name, values = new Map(), { save = false } = {}) => {
    const storage = { kv: { get: key => values.get(key), put: (key, value) => values.set(key, value), delete: key => values.delete(key) }, transactionSync: callback => callback(),
      get: async key => values.get(key), put: async (key, value) => { values.set(key, value); }, getAlarm: async () => null, setAlarm: async () => {} };
    const created = new BoardRoom({ storage, id: { name }, waitUntil: promise => waits.push(promise), blockConcurrencyWhile: callback => callback(), getWebSockets: () => [] }, env);
    if (!save) created.onSave = async () => {};
    rooms.set(name, created); t.after(() => created.document.destroy());
    return created;
  };
  const request = (path, { method = 'GET', cookie, data, headers = {} } = {}) => worker.fetch(new Request(`http://localhost:8787${path}`, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }), env);
  const cookie = async (email, name = 'Lead') => `cg_session=${await signSession({ name, email }, env.SESSION_SECRET)}`;
  const board = directory.createBoard('Robots'), boardRoom = room(board.id);
  applyLocalGraph(boardRoom.document, seed, empty, 'seed');
  files.set(`assets/${reference}`, { bytes: png(640, 480), size: 33 });
  return { env, directory, files, waits, rooms, room, request, cookie, board, boardRoom, settle: () => Promise.all(waits) };
}

// Holds the fake answer until the test has looked at the running state.
function gate() { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; }

function fakeGemini(t, answer) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url: String(url), init, body: JSON.parse(init.body) }); return answer(init, calls.length); });
  return calls;
}

runtimeTest('Directory reserves Nano Banana usage per person per UTC day and for the team per month, with refunds and expiry', t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql = { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  const directory = new Directory({ storage: { sql } }, {}), now = Date.UTC(2026, 10, 4, 12), limits = { dailyImages: 2, monthlyUsd: 1, estimateUsd: 0.4 };
  const a1 = directory.reserveNano('a@studio.example', limits, now), a2 = directory.reserveNano('a@studio.example', limits, now);
  assert.ok(a1.reservation && a2.reservation && a1.reservation !== a2.reservation);
  // Open reservations count, so a third Generate today and a teammate past the team's budget are refused.
  assert.deepEqual(directory.reserveNano('a@studio.example', limits, now), { error: 'Daily limit reached (2/2).', status: 429 });
  assert.deepEqual(directory.reserveNano('b@studio.example', limits, now), { error: 'Team budget for this month is used up.', status: 429 });
  assert.deepEqual(directory.nanoUsage('a@studio.example', now), { usedToday: 2, teamSpentUsd: 0.8 });
  directory.settleNano(a1.reservation, { images: 0, usd: 0 });
  assert.deepEqual(directory.nanoUsage('a@studio.example', now), { usedToday: 1, teamSpentUsd: 0.4 });
  const b1 = directory.reserveNano('b@studio.example', limits, now);
  assert.ok(b1.reservation);
  directory.settleNano(a2.reservation, { images: 3, usd: 0.1 });
  assert.deepEqual(directory.nanoUsage('a@studio.example', now), { usedToday: 3, teamSpentUsd: 0.5 });
  assert.equal(directory.reserveNano('a@studio.example', limits, now).error, 'Daily limit reached (2/2).');
  // A new UTC day resets the person's images, not the team's month.
  const tomorrow = Date.UTC(2026, 10, 5, 0, 0, 1);
  assert.deepEqual(directory.nanoUsage('a@studio.example', tomorrow), { usedToday: 0, teamSpentUsd: 0.5 });
  // A reservation its room never settled stops holding the person's images after 15 minutes but keeps its estimate in the month.
  assert.deepEqual(directory.nanoUsage('b@studio.example', now + 14 * 60 * 1000), { usedToday: 1, teamSpentUsd: 0.5 });
  assert.deepEqual(directory.nanoUsage('b@studio.example', now + 16 * 60 * 1000), { usedToday: 0, teamSpentUsd: 0.5 });
  assert.deepEqual(directory.nanoUsage('a@studio.example', Date.UTC(2026, 11, 1)), { usedToday: 0, teamSpentUsd: 0 });
  assert.equal(directory.reserveNano('c@studio.example', { ...limits, dailyImages: 0 }, now).status, 429);
  // Existing directories gain the table without losing boards.
  assert.ok(new Directory(directory.ctx, {}).nanoUsage('a@studio.example', now));
});

runtimeTest('Nano Banana routes check sign-in, origin, board, setup, the allowed list and both limits', async t => {
  const { env, request, cookie, board, settle, directory } = cloudSetup(t, { NANO_BANANA_DAILY_IMAGES: '1' });
  const held = gate();
  fakeGemini(t, async () => { await held.promise; return Response.json(interaction([png(64, 64)])); });
  const lead = await cookie('lead@studio.example'), outsider = await cookie('guest@gmail.example', 'Guest'), path = `/api/boards/${board.id}/nano`;
  assert.equal((await request('/api/nano')).status, 401);
  assert.equal((await request(path, { method: 'POST', data: { nodeId: 'p' } })).status, 401);
  assert.deepEqual(await (await request('/api/nano', { cookie: lead })).json(), { configured: true, allowed: true, dailyImages: 1, usedToday: 0, monthlyUsd: 100, teamSpentUsd: 0, gptImage: { configured: false, allowed: true }, fal: false, model3d: { configured: false, allowed: false } });
  assert.deepEqual(await (await request('/api/nano', { cookie: outsider })).json(), { configured: true, allowed: false, gptImage: { configured: false, allowed: false }, fal: false, model3d: { configured: false, allowed: false } });
  assert.equal((await request('/api/nano', { method: 'POST', cookie: lead })).status, 405);
  assert.equal((await request(path, { cookie: lead })).status, 405);
  assert.equal((await request(path, { method: 'POST', cookie: lead, data: { nodeId: 'p' }, headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await request(`/api/boards/${crypto.randomUUID()}/nano`, { method: 'POST', cookie: lead, data: { nodeId: 'p' } })).status, 404);
  const refused = await request(path, { method: 'POST', cookie: outsider, data: { nodeId: 'p' } });
  assert.equal(refused.status, 403); assert.deepEqual(await refused.json(), { error: 'Nano Banana is not available for your account. Ask a site admin for access.' });
  assert.equal((await request(path, { method: 'POST', cookie: lead, data: { nodeId: '' } })).status, 400);
  const notPrompt = await request(path, { method: 'POST', cookie: lead, data: { nodeId: 'i' } });
  assert.equal(notPrompt.status, 400); assert.deepEqual(await notPrompt.json(), { error: 'Write an image prompt first.' });
  const started = await request(path, { method: 'POST', cookie: lead, data: { nodeId: 'p' } });
  assert.equal(started.status, 202);
  const busy = await request(path, { method: 'POST', cookie: lead, data: { nodeId: 'p' } });
  assert.equal(busy.status, 409); assert.deepEqual(await busy.json(), { error: 'This prompt is already generating.' });
  held.open();
  await settle();
  const limited = await request(path, { method: 'POST', cookie: lead, data: { nodeId: 'p' } });
  assert.equal(limited.status, 429); assert.deepEqual(await limited.json(), { error: 'Daily limit reached (1/1).' });
  // Another allowed teammate still has their own day, until the team's month is spent.
  env.NANO_BANANA_MONTHLY_USD = '0.05';
  const budget = await request(path, { method: 'POST', cookie: await cookie('solo@mail.example', 'Solo'), data: { nodeId: 'p' } });
  assert.equal(budget.status, 429); assert.deepEqual(await budget.json(), { error: 'Team budget for this month is used up.' });
  delete env.GEMINI_API_KEY;
  assert.equal((await request(path, { method: 'POST', cookie: lead, data: { nodeId: 'p' } })).status, 503);
  assert.deepEqual(await (await request('/api/nano', { cookie: lead })).json(), { configured: false, allowed: true, gptImage: { configured: false, allowed: true }, fal: false, model3d: { configured: false, allowed: false } });
  assert.equal(directory.nanoUsage('solo@mail.example').usedToday, 0);
});

runtimeTest('Generate places Nano Banana images like Codex outputs for everyone and records what the call cost', async t => {
  const { request, cookie, board, boardRoom, settle, files, directory } = cloudSetup(t);
  const held = gate();
  const calls = fakeGemini(t, async () => { await held.promise; return Response.json(interaction([png(200, 100), png(100, 100)])); });
  const before = readCloudGraph(boardRoom.document);
  const response = await request(`/api/boards/${board.id}/nano`, { method: 'POST', cookie: await cookie('LEAD@studio.example'), data: { nodeId: 'p' } });
  assert.equal(response.status, 202);
  const { run: { id } } = await response.json();
  const running = boardRoom.document.getMap('runs').get(id);
  assert.deepEqual({ ...running, startedAt: 'time', createdAt: 'time' }, { id, nodeId: 'p', label: 'A courier robot at dawn', provider: 'nano-banana', model: 'gemini-nano-banana-2.1', status: 'running', by: user, startedAt: 'time', createdAt: 'time' });
  held.open();
  await settle();
  assert.equal(calls.length, 1);
  const [{ url, init, body }] = calls, headers = new Headers(init.headers);
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(headers.get('x-goog-api-key'), 'test-gemini-key'); assert.equal(headers.get('api-revision'), '2026-05-20');
  assert.equal(body.model, 'gemini-nano-banana-2.1'); assert.equal(body.store, false);
  assert.deepEqual(body.input.slice(1), [{ type: 'text', text: `Attachment 1: “Front view” (node ID i; file ${reference})` }, { type: 'image', mime_type: 'image/png', data: b64(png(640, 480)) }]);
  assert.equal(body.input[0].text, nanoPrompt(before, 'p').prompt);
  const graph = readCloudGraph(boardRoom.document), run = graph.runs.find(item => item.id === id);
  assert.equal(run.status, 'completed'); assert.equal(run.count, 2); assert.ok(Date.parse(run.finishedAt) >= Date.parse(run.startedAt));
  assert.deepEqual(run.outputIds, [`${id}-output-0`, `${id}-output-1`]);
  // The same step a Codex run uses, applied to the board as it was, gives the same images, connections and group.
  let expected = placeRunOutput(before, { runId: id, nodeId: 'p', run: running, author: user, output: { index: 0 }, asset: 'a.png', dimensions: { width: 200, height: 100 } });
  expected = placeRunOutput(expected, { runId: id, nodeId: 'p', run: expected.runs.at(-1), author: user, output: { index: 1 }, asset: 'b.png', dimensions: { width: 100, height: 100 } });
  const shape = item => ({ ...item, data: { ...item.data, asset: undefined, createdAt: undefined } });
  for (const outputId of run.outputIds) assert.deepEqual(shape(graph.nodes.find(node => node.id === outputId)), shape(expected.nodes.find(node => node.id === outputId)));
  assert.deepEqual(graph.edges.filter(edge => edge.source === 'p'), expected.edges.filter(edge => edge.source === 'p'));
  assert.deepEqual(graph.groups, [{ id: `${id}-group`, name: 'Group 1', collapsed: false, slideshow: true, nodeIds: run.outputIds }]);
  for (const outputId of run.outputIds) {
    const asset = graph.nodes.find(node => node.id === outputId).data.asset;
    assert.match(asset, /^[\da-f-]{36}\.png$/); assert.equal(files.get(`assets/${asset}`).httpMetadata.contentType, 'image/png');
  }
  assert.doesNotThrow(() => validateGraph(graph));
  // Boards keep display names only; the requester's email stays on the server.
  assert.doesNotMatch(JSON.stringify(boardRoom.document.toJSON()), /studio\.example/);
  const spent = directory.nanoUsage('lead@studio.example');
  assert.equal(spent.usedToday, 2); assert.equal(Math.round(spent.teamSpentUsd * 1e6), 72750);
});

runtimeTest('refusals and failures end the run with a clear message, refunding calls Google answered without billing', async t => {
  const { request, cookie, board, boardRoom, settle, files, directory } = cloudSetup(t);
  const lead = await cookie('lead@studio.example'), runs = () => readCloudGraph(boardRoom.document).runs;
  // Runs started within the same millisecond sort either way, so each is found by its ID.
  const start = async () => { const response = await request(`/api/boards/${board.id}/nano`, { method: 'POST', cookie: lead, data: { nodeId: 'p' } }); assert.equal(response.status, 202); const { run } = await response.json(); await settle(); return runs().find(item => item.id === run.id); };
  const spentBefore = () => directory.nanoUsage('lead@studio.example').teamSpentUsd;
  let answer;
  const calls = fakeGemini(t, () => answer());
  answer = () => Response.json({ error: { code: 'safety', message: 'Request blocked due to safety violations.' } }, { status: 400 });
  let run = await start();
  assert.equal(run.status, 'failed'); assert.match(run.error, /declined this prompt/); assert.equal(run.count, 0); assert.ok(run.finishedAt);
  assert.deepEqual(directory.nanoUsage('lead@studio.example'), { usedToday: 0, teamSpentUsd: 0 });
  // A text-only answer was billed for what it used.
  answer = () => Response.json(interaction([], { steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot draw that.' }] }], usage: { total_input_tokens: 1000, total_output_tokens: 20 } }));
  run = await start();
  assert.equal(run.error, 'Nano Banana returned no image: “I cannot draw that.”');
  assert.equal(Math.round(spentBefore() * 1e6), Math.round(1000 * 1.5 + 20 * 7.5));
  // No answer at all: the call may have been billed, so its estimate stays.
  answer = () => { throw new TypeError('fetch failed'); };
  const before = spentBefore();
  run = await start();
  assert.equal(run.error, 'Could not reach Nano Banana. Try again.');
  assert.ok(spentBefore() - before > 0.0336);
  // A missing reference fails before anything is sent.
  files.delete(`assets/${reference}`);
  const sent = calls.length, unchanged = spentBefore();
  run = await start();
  assert.match(run.error, /reference image is missing/); assert.equal(calls.length, sent); assert.equal(spentBefore(), unchanged);
  assert.equal(directory.nanoUsage('lead@studio.example').usedToday, 0);
  assert.equal(readCloudGraph(boardRoom.document).nodes.length, seed.nodes.length);
});

runtimeTest('only the requester can cancel; cancelling aborts the call and its late answer adds nothing', async t => {
  const { request, cookie, board, boardRoom, settle, directory } = cloudSetup(t);
  let release;
  const calls = fakeGemini(t, init => new Promise((resolve, reject) => {
    release = () => resolve(Response.json(interaction([png(64, 64)])));
    init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  }));
  const lead = await cookie('lead@studio.example'), teammate = await cookie('other@studio.example', 'Other');
  const { run: { id } } = await (await request(`/api/boards/${board.id}/nano`, { method: 'POST', cookie: lead, data: { nodeId: 'p' } })).json();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  const denied = await request(`/api/boards/${board.id}/nano/${id}/cancel`, { method: 'POST', cookie: teammate });
  assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'Only the person who started this generation can cancel it.' });
  assert.equal((await request(`/api/boards/${board.id}/nano/${crypto.randomUUID()}/cancel`, { method: 'POST', cookie: lead })).status, 404);
  const cancelled = await request(`/api/boards/${board.id}/nano/${id}/cancel`, { method: 'POST', cookie: lead });
  assert.equal(cancelled.status, 200);
  assert.equal(boardRoom.document.getMap('runs').get(id).status, 'cancelled');
  assert.equal(calls[0].init.signal.aborted, true);
  release();
  await settle();
  const run = boardRoom.document.getMap('runs').get(id);
  assert.equal(run.status, 'cancelled'); assert.equal(run.count, 0); assert.equal(run.error, undefined);
  assert.equal(readCloudGraph(boardRoom.document).nodes.length, seed.nodes.length);
  const spent = directory.nanoUsage('lead@studio.example');
  assert.equal(spent.usedToday, 0); assert.ok(spent.teamSpentUsd > 0.0336, 'an aborted call may still be billed');
  // Cancelling a finished run changes nothing.
  assert.equal((await request(`/api/boards/${board.id}/nano/${id}/cancel`, { method: 'POST', cookie: lead })).status, 200);
  assert.equal(boardRoom.document.getMap('runs').get(id).status, 'cancelled');
});

runtimeTest('a Nano Banana run cut off by a room restart fails on load and is never sent again', async t => {
  const { room, board, boardRoom, waits } = cloudSetup(t);
  const held = gate();
  const calls = fakeGemini(t, async () => { await held.promise; return Response.json(interaction([png()])); });
  const started = '2026-11-04T10:00:00.000Z', values = new Map();
  const first = room(`${board.id}-first`, values, { save: true });
  applyLocalGraph(first.document, { ...seed, runs: [
    { id: 'nano', nodeId: 'p', label: 'Robot', provider: 'nano-banana', model: 'gemini-nano-banana-2.1', status: 'running', by: user, startedAt: started, outputIds: ['nano-output-0'] },
    { id: 'codex', nodeId: 'p', label: 'Robot', model: 'gpt-6-luna', status: 'running', by: user, startedAt: started },
    { id: 'done', nodeId: 'p', label: 'Robot', provider: 'nano-banana', status: 'completed', by: user, startedAt: started, count: 1 },
  ] }, empty, 'seed');
  await first.saveSnapshot();
  // A new instance of the same room loads the saved board.
  const restarted = room(`${board.id}-first`, values);
  await restarted.setName(`${board.id}-first`);
  const runs = restarted.document.getMap('runs');
  assert.equal(runs.get('nano').status, 'failed'); assert.equal(runs.get('nano').error, 'Generation was interrupted. Run the prompt again.');
  assert.equal(runs.get('nano').count, 1); assert.ok(runs.get('nano').finishedAt);
  assert.equal(runs.get('codex').status, 'running'); assert.equal(runs.get('done').status, 'completed');
  // The only background work is reading the size of the image placed before sizes were recorded; nothing is sent again.
  assert.equal(waits.length, 1); await Promise.all(waits.splice(0));
  assert.equal(calls.length, 0);
  assert.deepEqual(restarted.document.getMap('nodes').get('i').get('data').get('pixels'), { width: 640, height: 480 });
  assert.equal(restarted.recordSizes(), null);
  // A running room keeps its own job.
  await boardRoom.setName(board.id);
  const result = await boardRoom.startNano({ nodeId: 'p', requester: { name: 'Lead', email: 'lead@studio.example', color: user.color } });
  assert.ok(result.run.id);
  await boardRoom.onStart();
  assert.equal(boardRoom.document.getMap('runs').get(result.run.id).status, 'running');
  held.open();
  await Promise.all(waits);
  assert.equal(boardRoom.document.getMap('runs').get(result.run.id).status, 'completed');
});

runtimeTest('the room waits for the requester’s latest edit before reading the prompt', async t => {
  const { boardRoom, board, settle } = cloudSetup(t);
  const calls = fakeGemini(t, () => Response.json(interaction([png()])));
  await boardRoom.setName(board.id);
  const client = new Y.Doc();
  t.after(() => client.destroy());
  Y.applyUpdate(client, Y.encodeStateAsUpdate(boardRoom.document));
  client.getMap('nodes').get('p').get('data').set('text', 'A courier robot at noon');
  const clock = Y.getState(client.store, client.clientID);
  const pending = boardRoom.startNano({ nodeId: 'p', client: client.clientID, clock, requester: { name: 'Lead', email: 'lead@studio.example', color: user.color } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(boardRoom.document.getMap('runs').size, 0);
  Y.applyUpdate(boardRoom.document, Y.encodeStateAsUpdate(client, Y.encodeStateVector(boardRoom.document)));
  const result = await pending;
  await settle();
  assert.equal(boardRoom.document.getMap('runs').get(result.run.id).label, 'A courier robot at noon');
  assert.match(calls[0].body.input[0].text, /A courier robot at noon/);
  assert.equal(await boardRoom.caughtUp(client.clientID, clock + 5, 10), false);
});

runtimeTest('variants start that many calls at once into one run and slideshow, each counted on its own', async t => {
  const variants = (room, count) => { const before = readCloudGraph(room.document), next = structuredClone(before); next.nodes.find(node => node.id === 'p').data.variants = count; applyLocalGraph(room.document, next, before, 'edit'); };
  const { request, cookie, board, boardRoom, settle, directory } = cloudSetup(t);
  variants(boardRoom, 3);
  const held = gate();
  const calls = fakeGemini(t, async (init, count) => { await held.promise; return count === 2 ? Response.json({ error: { code: 'invalid_argument', message: 'Bad request' } }, { status: 400 }) : Response.json(interaction([png(100, 150)])); });
  const response = await request(`/api/boards/${board.id}/nano`, { method: 'POST', cookie: await cookie('lead@studio.example'), data: { nodeId: 'p' } });
  assert.equal(response.status, 202);
  const { run: { id } } = await response.json();
  held.open(); await settle();
  const graph = readCloudGraph(boardRoom.document), run = graph.runs.find(item => item.id === id);
  assert.equal(calls.length, 3);
  assert.deepEqual([run.status, run.count, run.variants], ['completed', 2, 3]);
  assert.match(run.error, /^1 of 3 variants failed: Nano Banana could not use this request/);
  assert.deepEqual(run.outputIds, [`${id}-output-0`, `${id}-output-1`]);
  assert.deepEqual(graph.groups.map(group => [group.slideshow, group.nodeIds]), [[true, run.outputIds]]);
  assert.equal(directory.nanoUsage('lead@studio.example').usedToday, 2);
  validateGraph(graph);
});

runtimeTest('variants that do not all fit the daily limit start nothing and hold nothing back', async t => {
  const { request, cookie, board, boardRoom, directory } = cloudSetup(t, { NANO_BANANA_DAILY_IMAGES: '2' });
  const before = readCloudGraph(boardRoom.document), next = structuredClone(before);
  next.nodes.find(node => node.id === 'p').data.variants = 3; applyLocalGraph(boardRoom.document, next, before, 'edit');
  const calls = fakeGemini(t, async () => Response.json(interaction([png(100, 100)])));
  const response = await request(`/api/boards/${board.id}/nano`, { method: 'POST', cookie: await cookie('lead@studio.example'), data: { nodeId: 'p' } });
  assert.equal(response.status, 429);
  assert.match((await response.json()).error, /Only 2 of 3 variants fit; choose fewer\.$/);
  assert.equal(calls.length, 0); assert.equal(directory.nanoUsage('lead@studio.example').usedToday, 0);
  assert.equal(readCloudGraph(boardRoom.document).runs.length, 0);
});

const setVariants = (room, count) => { const before = readCloudGraph(room.document), next = structuredClone(before); next.nodes.find(node => node.id === 'p').data.variants = count; applyLocalGraph(room.document, next, before, 'edit'); };
// A call that answers only when it is aborted, as a slow provider looks from the room.
const hanging = init => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))));
const variantEstimate = room => nanoEstimate({ promptLength: nanoPrompt(readCloudGraph(room.document), 'p').prompt.length, references: 1 });

runtimeTest('sixteen variants share one request and keep at most four calls in flight; the rest wait as Queued', async t => {
  const { request, cookie, board, boardRoom, settle, directory } = cloudSetup(t);
  setVariants(boardRoom, 16);
  const held = gate(), seen = [];
  let flying = 0, most = 0;
  const calls = fakeGemini(t, async (init, count) => {
    flying++; most = Math.max(most, flying); seen.push(boardRoom.document.getMap('runs').values().next().value.variantsStarted);
    if (count <= 4) await held.promise; else await new Promise(resolve => setImmediate(resolve));
    flying--; return Response.json(interaction([png(100, 100)]));
  });
  const response = await request(`/api/boards/${board.id}/nano`, { method: 'POST', cookie: await cookie('lead@studio.example'), data: { nodeId: 'p' } });
  assert.equal(response.status, 202);
  const { run: { id } } = await response.json();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 4);
  const running = readCloudGraph(boardRoom.document), statuses = runPlaceholders(running, running.runs, 'page-1').nodes.map(node => node.data.status);
  assert.deepEqual(statuses, [...Array(4).fill('Generating'), ...Array(12).fill('Queued')]);
  held.open(); await settle();
  assert.equal(calls.length, 16); assert.equal(most, 4);
  // Built once: every call sends the very same headers object and the same body text.
  assert.ok(calls.every(call => call.init.headers === calls[0].init.headers && call.init.body === calls[0].init.body));
  assert.deepEqual(seen, [4, 4, 4, 4, ...Array.from({ length: 12 }, (_, index) => index + 5)]);
  const graph = readCloudGraph(boardRoom.document), run = graph.runs.find(item => item.id === id);
  assert.deepEqual([run.status, run.count, run.variants, run.variantsStarted, run.error], ['completed', 16, 16, 16, undefined]);
  assert.deepEqual(graph.groups.map(group => [group.slideshow, group.nodeIds.length]), [[true, 16]]);
  assert.equal(directory.nanoUsage('lead@studio.example').usedToday, 16);
  validateGraph(graph);
});

runtimeTest('cancelling many variants sends no further calls and refunds the ones that never started', async t => {
  const { request, cookie, board, boardRoom, settle, directory } = cloudSetup(t);
  setVariants(boardRoom, 10);
  const calls = fakeGemini(t, hanging), lead = await cookie('lead@studio.example');
  const { run: { id } } = await (await request(`/api/boards/${board.id}/nano`, { method: 'POST', cookie: lead, data: { nodeId: 'p' } })).json();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 4);
  assert.equal((await request(`/api/boards/${board.id}/nano/${id}/cancel`, { method: 'POST', cookie: lead })).status, 200);
  await settle();
  assert.equal(calls.length, 4); assert.ok(calls.every(call => call.init.signal.aborted));
  const run = boardRoom.document.getMap('runs').get(id), spent = directory.nanoUsage('lead@studio.example');
  assert.deepEqual([run.status, run.count], ['cancelled', 0]);
  // The four sent calls may have been billed; the six never sent cost nothing.
  assert.equal(spent.usedToday, 0); assert.equal(Math.round(spent.teamSpentUsd * 1e6), Math.round(4 * variantEstimate(boardRoom) * 1e6));
});

runtimeTest('a run of variants cut off by a room restart refunds the calls it never sent and sends none again', async t => {
  const { room, board, directory, waits } = cloudSetup(t);
  const calls = fakeGemini(t, hanging), values = new Map(), name = `${board.id}-first`, lead = 'lead@studio.example';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = room(name, values, { save: true });
  applyLocalGraph(first.document, seed, empty, 'seed'); setVariants(first, 10);
  await first.setName(name);
  const { run: { id } } = await first.startNano({ nodeId: 'p', requester: { name: 'Lead', email: lead, color: user.color } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 4);
  const estimate = variantEstimate(first), spent = () => Math.round(directory.nanoUsage(lead).teamSpentUsd * 1e6);
  assert.equal(spent(), Math.round(10 * estimate * 1e6));
  await first.saveSnapshot();
  // The room stops with four calls sent; a new instance of it loads what was saved.
  const restarted = room(name, values), before = waits.length;
  await restarted.setName(name);
  await Promise.all(waits.slice(before));
  assert.equal(restarted.document.getMap('runs').get(id).status, 'failed');
  // The four sent calls may have been billed; the six never sent cost nothing.
  assert.equal(spent(), Math.round(4 * estimate * 1e6));
  assert.equal(values.get('variants:reserved'), undefined); assert.equal(calls.length, 4);
  // Cancelling the interrupted run later finds nothing more to refund.
  assert.deepEqual(restarted.cancelNano({ runId: id, email: lead }), { ok: true });
  await Promise.all(waits.slice(before));
  assert.equal(spent(), Math.round(4 * estimate * 1e6));
  // The stopped instance's own calls end here only because this test shares one process with the new one.
  first.cancelNano({ runId: id, email: lead }); await Promise.all(waits);
  assert.equal(calls.length, 4); assert.equal(spent(), Math.round(4 * estimate * 1e6));
});

runtimeTest('slow variants time out one by one and then as a run; calls the run never started cost nothing', async t => {
  const { request, cookie, board, boardRoom, settle, directory } = cloudSetup(t);
  setVariants(boardRoom, 12);
  const calls = fakeGemini(t, hanging), flush = () => new Promise(resolve => setImmediate(resolve));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { run: { id } } = await (await request(`/api/boards/${board.id}/nano`, { method: 'POST', cookie: await cookie('lead@studio.example'), data: { nodeId: 'p' } })).json();
  await flush();
  assert.equal(calls.length, 4);
  // Each call has five minutes; the lanes go on with the next variants.
  t.mock.timers.tick(nanoTimeout); await flush();
  assert.equal(calls.length, 8); assert.ok(calls.slice(0, 4).every(call => call.init.signal.aborted));
  // Three waves give the run nine minutes; the last four variants are never sent.
  t.mock.timers.tick(variantRunTimeout(12) - nanoTimeout); await settle();
  assert.equal(calls.length, 8); assert.ok(calls.every(call => call.init.signal.aborted));
  const run = boardRoom.document.getMap('runs').get(id), spent = directory.nanoUsage('lead@studio.example');
  assert.deepEqual([run.status, run.error, run.count], ['failed', 'Nano Banana took longer than 9 minutes. Try again.', 0]);
  assert.equal(spent.usedToday, 0); assert.equal(Math.round(spent.teamSpentUsd * 1e6), Math.round(8 * variantEstimate(boardRoom) * 1e6));
});

runtimeTest('a run of variants reserves all its calls in one step or none, and settles them in one step', t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql = { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  const directory = new Directory({ storage: { sql } }, {}), now = Date.UTC(2026, 10, 16, 12), usage = email => directory.nanoUsage(email, now);
  const cents = value => Math.round(value * 100);
  const first = directory.reserveNanoMany('a@studio.example', { dailyImages: 5, monthlyUsd: 2, estimates: [.1, .1, .1] }, now);
  assert.equal(new Set(first.reservations).size, 3);
  assert.deepEqual([usage('a@studio.example').usedToday, cents(usage('a@studio.example').teamSpentUsd)], [3, 30]);
  // Three more do not fit five a day: nothing is reserved, and the answer says two would have.
  assert.deepEqual(directory.reserveNanoMany('a@studio.example', { dailyImages: 5, monthlyUsd: 2, estimates: [.1, .1, .1] }, now), { error: 'Daily limit reached (5/5).', status: 429, fit: 2 });
  assert.equal(usage('a@studio.example').usedToday, 3);
  assert.deepEqual(directory.reserveNanoMany('b@studio.example', { dailyImages: 10, monthlyUsd: 1, estimates: [.3, .3, .3] }, now), { error: 'Team budget for this month is used up.', status: 429, fit: 2 });
  assert.equal(usage('b@studio.example').usedToday, 0);
  // 32 rows go in as one JSON value, past the 100 values one Durable Object query may bind.
  const many = directory.reserveNanoMany('c@studio.example', { dailyImages: 32, monthlyUsd: 2, estimates: Array(32).fill(.01) }, now);
  assert.equal(many.reservations.length, 32); assert.equal(usage('c@studio.example').usedToday, 32);
  directory.settleNanoMany(first.reservations.map((id, index) => ({ id, images: index ? 0 : 1, usd: index ? 0 : .05 })));
  assert.deepEqual([usage('a@studio.example').usedToday, cents(usage('a@studio.example').teamSpentUsd)], [1, 5 + 32]);
});

runtimeTest('a describe node can use Gemini on the site key: one text call, a description prompt, no daily images', async t => {
  const { request, cookie, board, boardRoom, settle, directory } = cloudSetup(t, { NANO_BANANA_DAILY_IMAGES: '1' });
  const before = readCloudGraph(boardRoom.document), next = structuredClone(before);
  next.nodes.push({ id: 'd', type: 'text', position: { x: 80, y: 400 }, data: { text: 'Only the lighting', task: 'describe', generator: 'nano-banana' } });
  next.edges.push({ id: 'e4', source: 'i', target: 'd' });
  applyLocalGraph(boardRoom.document, next, before, 'edit');
  // A day's image already used must not stop a description.
  directory.settleNano(directory.reserveNano('lead@studio.example', { dailyImages: 1, monthlyUsd: 50, estimateUsd: .03 }).reservation, { images: 1, usd: .03 });
  const calls = fakeGemini(t, async () => Response.json({ ...interaction([]), model: 'gemini-3.5-flash-lite', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'A small courier robot lit from the left.' }] }],
    usage: { total_input_tokens: 2000, total_output_tokens: 400, total_thought_tokens: 600 } }));
  const response = await request(`/api/boards/${board.id}/nano`, { method: 'POST', cookie: await cookie('lead@studio.example'), data: { nodeId: 'd' } });
  assert.equal(response.status, 202);
  const { run: { id } } = await response.json();
  await settle();
  const [{ body }] = calls, graph = readCloudGraph(boardRoom.document), run = graph.runs.find(item => item.id === id);
  assert.equal(calls.length, 1); assert.equal(body.model, 'gemini-3.5-flash-lite');
  assert.match(body.input[0].text, /Describe the attached images in detail/); assert.match(body.input[0].text, /FOCUS:\nOnly the lighting/);
  assert.deepEqual(body.input.slice(1).map(item => item.type), ['text', 'image']);
  assert.equal(body.input[1].text, `Attachment 1: “Front view” (node ID i; file ${reference})`);
  assert.deepEqual([run.status, run.task, run.model, run.count], ['completed', 'describe', 'gemini-3.5-flash-lite', 1]);
  const output = graph.nodes.find(node => node.id === run.outputIds[0]);
  assert.deepEqual([output.type, output.data.text], ['text', 'A small courier robot lit from the left.']);
  assert.ok(graph.edges.some(edge => edge.source === 'd' && edge.target === output.id));
  const usage = directory.nanoUsage('lead@studio.example');
  assert.equal(usage.usedToday, 1); assert.equal(Math.round(usage.teamSpentUsd * 1e6), 30000 + Math.round((2000 * .3 + 1000 * 2.5)));
  validateGraph(graph);
});

test('upscale nodes take one to four connected images, and sizes, prices and labels follow the chosen upscaler', async () => {
  const { upscaleFactor, upscaleCost, upscaleEstimate, nanoAspect, falInput, nanoUpscaleFormat, upscaleSettings, nanoFrame, nanoContent } = await import('../cloud/upscale.mjs');
  // FAL_UPSCALERS=off keeps the key but turns Topaz and SeedVR2 off.
  assert.deepEqual([upscaleSettings({}).fal, upscaleSettings({ FAL_KEY: 'k' }).fal, upscaleSettings({ FAL_KEY: 'k', FAL_UPSCALERS: 'off' }).fal, upscaleSettings({ FAL_KEY: 'k', FAL_UPSCALERS: 'on' }).fal], [false, true, false, true]);
  const { resolutionLabel, runInputs } = await import('../graph.mjs');
  assert.equal(upscaleFactor({ width: 1024, height: 768 }, 4), 4);
  assert.equal(upscaleFactor({ width: 4096, height: 2048 }, 4), 2);
  assert.throws(() => upscaleFactor({ width: 7000, height: 100 }, 2), /already as large/);
  assert.equal(upscaleCost('topaz', 4, { width: 4096, height: 4096 }), .08);
  assert.equal(upscaleCost('topaz', 4, { width: 8192, height: 4096 }), .16);
  assert.ok(Math.abs(upscaleCost('seedvr', 2, { width: 2000, height: 1500 }) - .003) < 1e-9);
  assert.ok(Math.abs(upscaleCost('nano-banana', 4) - (1120 * 1.5 + 3780 * 30 + 2000 * 7.5) / 1e6) < 1e-9);
  // Before the call the price assumes the largest output, capped at 8K.
  assert.equal(upscaleEstimate('topaz', 4, { width: 4096, height: 4096 }), .32);
  assert.deepEqual([nanoAspect({ width: 640, height: 480 }), nanoAspect({ width: 1080, height: 1920 }), nanoAspect({ width: 1000, height: 1010 })], ['4:3', '9:16', '1:1']);
  assert.deepEqual(nanoUpscaleFormat(4, { width: 640, height: 480 }), { type: 'image', image_size: '4K', aspect_ratio: '4:3' });
  // A 2:1 image goes in padded above and below to 16:9, and the answer is cut back to 2:1; a 4:3 one needs nothing.
  const wide = nanoFrame({ width: 2048, height: 1024 });
  assert.deepEqual(wide, { aspect: '16:9', frame: { width: 2048, height: 1152 }, left: 0, top: 64, padded: true });
  assert.deepEqual(nanoContent(wide, { width: 2048, height: 1024 }, { width: 5504, height: 3072 }), { left: 0, top: 171, width: 5504, height: 2752 });
  assert.equal(nanoFrame({ width: 640, height: 480 }).padded, false);
  assert.deepEqual(nanoFrame({ width: 4000, height: 1000 }).aspect, '4:1');
  assert.deepEqual(falInput('seedvr', 2, 'data:x'), { image_url: 'data:x', upscale_mode: 'factor', upscale_factor: 2, output_format: 'jpg' });
  assert.deepEqual([resolutionLabel({ width: 1024, height: 1024 }), resolutionLabel({ width: 2048, height: 1536 }), resolutionLabel({ width: 2752, height: 1536 }), resolutionLabel({ width: 3072, height: 2048 }), resolutionLabel({ width: 2160, height: 3840 }), resolutionLabel({ width: 8192, height: 4096 }), resolutionLabel(undefined)], ['', '2K', '2K', '3K', '4K', '8K', '']);
  const image = id => ({ id, type: 'image', position: { x: 0, y: 0 }, data: { asset: reference } });
  const graph = count => ({ nodes: [{ id: 'u', type: 'text', position: { x: 0, y: 0 }, data: { text: '', task: 'upscale', upscaler: 'seedvr', scale: 4 } }, ...Array.from({ length: count }, (_, index) => image(`i${index}`))],
    edges: Array.from({ length: count }, (_, index) => ({ id: `e${index}`, source: `i${index}`, target: 'u' })), groups: [], runs: [] });
  assert.equal(runInputs(graph(2), 'u').images.length, 2);
  assert.throws(() => runInputs(graph(0), 'u'), /Connect an image to upscale/);
  assert.throws(() => runInputs(graph(5), 'u'), /at most 4 images/);
  const invalid = changes => { const value = graph(1); Object.assign(value.nodes[0].data, changes); return () => validateGraph(value); };
  assert.throws(invalid({ upscaler: 'magnific' }), /Invalid upscaler/); assert.throws(invalid({ scale: 3 }), /Invalid upscale size/); assert.throws(invalid({ task: 'redraw' }), /Invalid node task/);
  const sized = graph(1); sized.nodes[1].data.pixels = { width: 0, height: 10 };
  assert.throws(() => validateGraph(sized), /Invalid image size/);
});

// The upscale node `u`, fed by the 640×480 reference image.
const upscaleBoard = data => ({ nodes: [{ id: 'u', type: 'text', position: { x: 0, y: 400 }, data: { text: '', task: 'upscale', ...data } }], edges: [{ id: 'iu', source: 'i', target: 'u' }], groups: [], runs: [] });
function addUpscale(boardRoom, data) {
  const before = readCloudGraph(boardRoom.document), extra = upscaleBoard(data);
  applyLocalGraph(boardRoom.document, { ...before, nodes: [...before.nodes, ...extra.nodes], edges: [...before.edges, ...extra.edges] }, before, 'seed');
}

runtimeTest('Topaz upscales through fal.ai’s queue with the site key, and the larger image joins the board with its size', async t => {
  const { boardRoom, board, directory, files, settle } = cloudSetup(t, { FAL_KEY: 'fal-test-key' });
  await boardRoom.setName(board.id);
  addUpscale(boardRoom, { upscaler: 'topaz', scale: 4 });
  const queue = 'https://queue.fal.run/fal-ai/topaz/requests/job-1', calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', auth: init.headers?.Authorization, body: init.body && JSON.parse(init.body) });
    if (String(url) === 'https://queue.fal.run/fal-ai/topaz/upscale/image') return Response.json({ request_id: 'job-1', status_url: `${queue}/status`, response_url: queue, cancel_url: `${queue}/cancel` });
    if (String(url) === `${queue}/status/stream`) return new Response('data: {"status":"IN_PROGRESS"}\n\ndata: {"status":"COMPLETED"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    if (String(url) === `${queue}/status`) return Response.json({ status: 'COMPLETED' });
    if (String(url) === queue) return Response.json({ image: { url: 'https://v3.fal.media/files/out.png', content_type: 'image/png' } });
    if (String(url) === 'https://v3.fal.media/files/out.png') return new Response(png(2560, 1920));
    return new Response('unexpected', { status: 500 });
  });
  const result = await boardRoom.startNano({ nodeId: 'u', requester: { name: 'Lead', email: 'lead@studio.example', color: user.color } });
  assert.ok(result.run.id);
  await settle();
  const [submit] = calls;
  assert.equal(submit.method, 'POST'); assert.equal(submit.auth, 'Key fal-test-key');
  assert.deepEqual({ ...submit.body, image_url: submit.body.image_url.slice(0, 22) }, { image_url: 'data:image/png;base64,', model: 'Standard V2', upscale_factor: 4, output_format: 'jpeg' });
  // The key goes only to fal.ai's queue, never to the image host.
  assert.deepEqual(calls.map(call => [call.url.split('/')[2], call.auth]), [['queue.fal.run', 'Key fal-test-key'], ['queue.fal.run', 'Key fal-test-key'], ['queue.fal.run', 'Key fal-test-key'], ['v3.fal.media', undefined]]);
  const graph = readCloudGraph(boardRoom.document), run = graph.runs.find(item => item.id === result.run.id), output = graph.nodes.find(node => node.data.runId === result.run.id);
  assert.deepEqual({ status: run.status, model: run.model, task: run.task, scale: run.scale, label: run.label }, { status: 'completed', model: 'fal-ai/topaz/upscale/image', task: 'upscale', scale: 4, label: 'Upscale image' });
  assert.deepEqual(output.data.pixels, { width: 2560, height: 1920 });
  assert.equal(output.data.caption, 'Front view upscaled');
  assert.ok(files.has(`assets/${output.data.asset}`));
  assert.ok(graph.edges.some(edge => edge.source === 'u' && edge.target === output.id));
  assert.deepEqual(directory.nanoUsage('lead@studio.example'), { usedToday: 1, teamSpentUsd: .08 });
});

runtimeTest('a fal.ai answer pointing elsewhere is refused, and Topaz without the fal.ai key is not offered', async t => {
  const { boardRoom, board, settle, directory } = cloudSetup(t, { FAL_KEY: 'fal-test-key' });
  await boardRoom.setName(board.id);
  addUpscale(boardRoom, { upscaler: 'seedvr', scale: 2 });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    calls.push(String(url));
    return Response.json({ request_id: 'x', status_url: 'https://attacker.example/status', response_url: 'https://attacker.example/result' });
  });
  const result = await boardRoom.startNano({ nodeId: 'u', requester: { name: 'Lead', email: 'lead@studio.example', color: user.color } });
  await settle();
  assert.deepEqual(calls, ['https://queue.fal.run/fal-ai/seedvr/upscale/image']);
  const run = boardRoom.document.getMap('runs').get(result.run.id);
  assert.deepEqual([run.status, run.error], ['failed', 'The upscaler returned an unreadable response. Try again.']);
  assert.deepEqual(directory.nanoUsage('lead@studio.example'), { usedToday: 0, teamSpentUsd: 0 });
  delete boardRoom.env.FAL_KEY;
  assert.deepEqual(await boardRoom.startNano({ nodeId: 'u', requester: { name: 'Lead', email: 'lead@studio.example', color: user.color } }), { error: 'Topaz and SeedVR2 aren’t set up on this site yet. Choose Nano Banana, or ask the site owner to add a fal.ai key.', status: 503 });
});

runtimeTest('Nano Banana upscales by redrawing the image at 2K or 4K in its own aspect ratio', async t => {
  const { boardRoom, board, settle } = cloudSetup(t);
  await boardRoom.setName(board.id);
  addUpscale(boardRoom, { upscaler: 'nano-banana', scale: 4 });
  const calls = fakeGemini(t, () => Response.json(interaction([png(4096, 3072)])));
  const result = await boardRoom.startNano({ nodeId: 'u', requester: { name: 'Lead', email: 'lead@studio.example', color: user.color } });
  await settle();
  assert.equal(calls.length, 1);
  const { body } = calls[0];
  assert.deepEqual(body.response_format, { type: 'image', image_size: '4K', aspect_ratio: '4:3' });
  assert.match(body.input[0].text, /^Upscale this image/); assert.equal(body.input.length, 2); assert.equal(body.model, 'gemini-nano-banana-2.1');
  const graph = readCloudGraph(boardRoom.document), output = graph.nodes.find(node => node.data.runId === result.run.id);
  assert.deepEqual(output.data.pixels, { width: 4096, height: 3072 });
  assert.equal(graph.runs.find(run => run.id === result.run.id).status, 'completed');
});

test('agents add an upscale node fed by images on one page', async () => {
  const { toolByName, runBoardTool } = await import('../cloud/mcp-tools.mjs');
  const graph = { nodes: [{ id: 'i', type: 'image', position: { x: 0, y: 0 }, data: { asset: reference } }, { id: 'p', type: 'text', position: { x: 0, y: 400 }, data: { text: 'A robot' } }], edges: [], groups: [], runs: [] };
  const run = (args, fal = true) => runBoardTool(toolByName.get('add_upscale_node'), { graph, args, user: { name: 'Lead', email: 'lead@studio.example' }, prepared: { fal }, templates: [] });
  const { result, graph: next } = run({ imageIds: ['i'], upscaler: 'seedvr', scale: 4 });
  const added = next.nodes.find(node => node.id === result.nodeId);
  assert.deepEqual({ ...added.data, createdAt: 0 }, { text: '', task: 'upscale', upscaler: 'seedvr', scale: 4, createdAt: 0 });
  assert.deepEqual(next.edges.map(edge => [edge.source, edge.target]), [['i', result.nodeId]]);
  assert.equal(run({ imageIds: ['i'] }).graph.nodes.at(-1).data.upscaler, 'topaz');
  // While the site's fal.ai upscalers are off, agents get Nano Banana and are told why Topaz is refused.
  assert.equal(run({ imageIds: ['i'] }, false).graph.nodes.at(-1).data.upscaler, 'nano-banana');
  assert.throws(() => run({ imageIds: ['i'], upscaler: 'topaz' }, false), /off on this site/);
  assert.throws(() => run({ imageIds: ['p'] }), /Upscale images only/);
  assert.throws(() => run({ imageIds: ['i'], scale: 3 }), /Invalid upscale size/);
});

// A real RGB PNG, every pixel (x mod 256, y mod 256, 90), for upscales that are padded and cut back.
async function realPng(width, height) {
  const { deflateSync } = await import('node:zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data]))); return Buffer.concat([head, data, tail]); };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([x & 255, y & 255, 90], y * (width * 3 + 1) + 1 + x * 3);
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// Cloudflare Images as the IMAGES binding: records each transformation and answers with what `produce` makes of it.
function fakeImages(produce) {
  const calls = [];
  return { calls, binding: { input(stream) {
    const transforms = [];
    const chain = { transform(options) { transforms.push(options); return chain; }, async output(options) {
      const call = { transforms, output: options, bytes: new Uint8Array(await new Response(stream).arrayBuffer()) };
      calls.push(call);
      const bytes = await produce(call);
      return { response: () => new Response(bytes), contentType: () => options.format };
    } };
    return chain;
  } } };
}
// Just enough of a JPEG for its format and size to be read.
const jpeg = (width, height) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);

runtimeTest('a Nano Banana upscale of a 2:1 image is sent padded to 16:9 and its JPEG answer is cut back to 2:1, not cropped', async t => {
  const images = fakeImages(({ transforms }) => { const { trim } = transforms[0]; return jpeg(320 - trim.left - trim.right, 180 - trim.top - trim.bottom); });
  const { boardRoom, board, files, settle } = cloudSetup(t, { IMAGES: images.binding });
  await boardRoom.setName(board.id);
  files.set(`assets/${reference}`, { bytes: await realPng(200, 100), size: 1 });
  addUpscale(boardRoom, { upscaler: 'nano-banana', scale: 2 });
  const calls = fakeGemini(t, () => Response.json({ ...interaction([]), steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/jpeg', data: b64(jpeg(320, 180)) }] }] }));
  const result = await boardRoom.startNano({ nodeId: 'u', requester: { name: 'Lead', email: 'lead@studio.example', color: user.color } });
  await settle();
  const { body } = calls[0], sent = Buffer.from(body.input[1].data, 'base64');
  assert.equal(body.response_format.aspect_ratio, '16:9'); assert.equal(body.response_format.mime_type, undefined); assert.equal(body.input[1].mime_type, 'image/png');
  // A PNG is padded here, repeating its edges: 200×100 padded to 16:9 is 200×113, the original six rows down.
  assert.deepEqual(imageSize(new Uint8Array(sent)), { width: 200, height: 113 });
  // The 320×180 JPEG answer is cut back to the original's 2:1 through Cloudflare Images.
  assert.deepEqual(images.calls.map(call => [call.transforms, call.output]), [[[{ trim: { top: 10, left: 0, bottom: 10, right: 0 } }], { format: 'image/jpeg', quality: 95 }]]);
  const output = readCloudGraph(boardRoom.document).nodes.find(node => node.data.runId === result.run.id);
  assert.deepEqual(output.data.pixels, { width: 320, height: 160 }); assert.match(output.data.asset, /\.jpg$/);
});

runtimeTest('a PNG answer is cut back here, images other than PNGs are padded through Cloudflare Images, and without it nothing is padded', async t => {
  const images = fakeImages(({ transforms }) => realPng(transforms[0].width, transforms[0].height));
  const { boardRoom, board, files, settle, env } = cloudSetup(t, { IMAGES: images.binding });
  await boardRoom.setName(board.id);
  files.set(`assets/${reference}`, { bytes: await realPng(200, 100), size: 1 });
  addUpscale(boardRoom, { upscaler: 'nano-banana', scale: 2 });
  const answer = await realPng(320, 180);
  let calls = fakeGemini(t, () => Response.json(interaction([answer])));
  let result = await boardRoom.startNano({ nodeId: 'u', requester: { name: 'Lead', email: 'lead@studio.example', color: user.color } });
  await settle();
  assert.deepEqual(readCloudGraph(boardRoom.document).nodes.find(node => node.data.runId === result.run.id).data.pixels, { width: 320, height: 160 });
  assert.equal(images.calls.length, 0);
  // A JPEG to upscale is padded by Cloudflare Images instead.
  const photo = '87654321-4321-4321-4321-cba987654321.jpg';
  files.set(`assets/${photo}`, { bytes: jpeg(200, 100), size: 1 });
  const before = readCloudGraph(boardRoom.document);
  applyLocalGraph(boardRoom.document, { ...before, nodes: [...before.nodes, { id: 'j', type: 'image', position: { x: 0, y: 900 }, data: { asset: photo } }, { id: 'v', type: 'text', position: { x: 400, y: 900 }, data: { text: '', task: 'upscale', upscaler: 'nano-banana', scale: 2 } }], edges: [...before.edges, { id: 'jv', source: 'j', target: 'v' }] }, before, 'seed');
  result = await boardRoom.startNano({ nodeId: 'v', requester: { name: 'Lead', email: 'lead@studio.example', color: user.color } });
  await settle();
  assert.deepEqual(images.calls[0].transforms, [{ width: 200, height: 113, fit: 'pad', background: '#000000' }]);
  assert.equal(readCloudGraph(boardRoom.document).runs.find(run => run.id === result.run.id).status, 'completed');
  // Without the binding the image goes as it is, in the nearest shape.
  delete env.IMAGES; t.mock.restoreAll();
  calls = fakeGemini(t, () => Response.json(interaction([answer])));
  boardRoom.document.getMap('runs').forEach((run, id) => { if (run.nodeId === 'u') boardRoom.document.getMap('runs').delete(id); });
  result = await boardRoom.startNano({ nodeId: 'u', requester: { name: 'Lead', email: 'lead@studio.example', color: user.color } });
  await settle();
  assert.deepEqual(imageSize(new Uint8Array(Buffer.from(calls[0].body.input[1].data, 'base64'))), { width: 200, height: 100 });
  assert.deepEqual(readCloudGraph(boardRoom.document).nodes.find(node => node.data.runId === result.run.id).data.pixels, { width: 320, height: 180 });
});

runtimeTest('3D runs use each fal model and its exact budget, place GLBs/posters sequentially and refund unstarted work', async t => {
  const { cubeGlb } = await import('./fixtures/cube-glb.mjs'), { model3dModels } = await import('../graph.mjs');
  const { boardRoom, board, directory, files, settle } = cloudSetup(t, { SITE_OWNER_EMAIL: 'lead@studio.example', FAL_KEY: 'fal-test-key' }); await boardRoom.setName(board.id);
  const { model3dPrices } = await import('../cloud/model3d.mjs'); let pendingModel = null, activeDownloads = 0, maxDownloads = 0, calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (init.method === 'POST') {
      const modeler = Object.keys(model3dModels).find(key => String(url).endsWith(model3dModels[key])); assert.ok(modeler);
      assert.equal(activeDownloads, 0); pendingModel = modeler; calls.push({ modeler, input: JSON.parse(init.body) });
      return Response.json({ status_url: 'https://queue.fal.run/status', response_url: 'https://queue.fal.run/result', cancel_url: 'https://queue.fal.run/cancel' });
    }
    if (url === 'https://queue.fal.run/status/stream') return new Response('data: {"status":"COMPLETED"}\n\n');
    if (url === 'https://queue.fal.run/status') return Response.json({ status: 'COMPLETED' });
    if (url === 'https://queue.fal.run/result') return Response.json({ [['rodin', 'tripo'].includes(pendingModel) ? 'model_mesh' : 'model_glb']: { url: 'https://media.example/cube.glb' }, ...(pendingModel === 'hunyuan' ? { thumbnail: { url: 'https://media.example/poster.png' } } : pendingModel === 'tripo' ? { rendered_image: { url: 'https://media.example/poster.png' } } : {}) });
    assert.equal(init.headers, undefined);
    if (url.endsWith('.png')) return new Response(png(640, 480));
    if (url.endsWith('.glb')) {
      activeDownloads++; maxDownloads = Math.max(maxDownloads, activeDownloads);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(cubeGlb()); controller.close(); activeDownloads--; } }));
    }
    throw new Error('Unexpected: ' + url);
  });
  const requester = { ...user, email: 'lead@studio.example' }; let spent = 0;
  for (const modeler of Object.keys(model3dModels)) {
    const before = readCloudGraph(boardRoom.document), id = '3d-' + modeler;
    applyLocalGraph(boardRoom.document, { ...before, nodes: [...before.nodes, { id, type: 'text', position: { x: 0, y: 500 }, data: { text: '', task: 'model3d', modeler } }], edges: [...before.edges, { id: 'e-' + modeler, source: 'i', target: id }] }, before, 'seed');
    const started = await boardRoom.startNano({ nodeId: id, requester }); assert.ok(started.run); await settle();
    const graph = readCloudGraph(boardRoom.document), run = graph.runs.find(r => r.id === started.run.id), model = graph.nodes.find(n => n.data.runId === run.id);
    assert.deepEqual([run.status, run.task, run.model, run.label], ['completed', 'model3d', model3dModels[modeler], '3D model']);
    assert.equal(model.type, 'model'); assert.match(model.data.asset, /\.glb$/); assert.ok(files.has('assets/' + model.data.asset));
    assert.equal(model.data.modeler, modeler); assert.deepEqual(model.data.source, { nodeId: 'i', name: 'Front view' });
    assert.equal(model.data.bytes, cubeGlb().length); assert.equal(model.data.usd, model3dPrices[modeler]);
    assert.equal(model.data.author.name, requester.name); assert.ok(Number.isFinite(Date.parse(model.data.createdAt))); validateGraph(graph);
    assert.equal(model.data.name, modeler === 'hunyuan' ? 'Front view 3D' : modeler === 'trellis' ? 'Front view 3D 2' : modeler === 'rodin' ? 'Front view 3D 3' : 'Front view 3D 4');
    assert.equal(['hunyuan', 'tripo'].includes(modeler) ? model.data.poster !== reference : model.data.poster === reference, true);
    assert.equal(files.get('assets/' + model.data.asset).httpMetadata.contentType, 'model/gltf-binary');
    assert.ok(graph.edges.some(e => e.source === id && e.target === model.id)); spent += model3dPrices[modeler];
    assert.ok(Math.abs(directory.nanoUsage(requester.email).teamSpentUsd - spent) < 1e-9);
  }
  assert.equal(maxDownloads, 1); assert.equal(calls.length, 4); assert.equal(directory.nanoUsage(requester.email).usedToday, 4);
  delete boardRoom.env.FAL_KEY;
  assert.equal((await boardRoom.startNano({ nodeId: '3d-hunyuan', requester })).status, 503);
});

runtimeTest('3D rejects invalid files after billing, keeps successful partial outputs, and enforces access/daily/monthly limits', async t => {
  const { cubeGlb } = await import('./fixtures/cube-glb.mjs');
  const app = cloudSetup(t, { SITE_OWNER_EMAIL: 'lead@studio.example', FAL_KEY: 'key', NANO_BANANA_DAILY_IMAGES: '2', NANO_BANANA_MONTHLY_USD: '1' }); await app.boardRoom.setName(app.board.id);
  const before = readCloudGraph(app.boardRoom.document), generator = { id: '3d', type: 'text', position: { x: 0, y: 0 }, data: { text: '', task: 'model3d' } };
  const second = { id: 'i2', type: 'image', position: { x: 0, y: 500 }, data: { asset: reference, caption: 'Side view' } };
  applyLocalGraph(app.boardRoom.document, { ...before, nodes: [...before.nodes, generator, second], edges: [...before.edges, { id: '3di', source: 'i', target: '3d' }, { id: '3di2', source: 'i2', target: '3d' }] }, before, 'seed');
  let submissions = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (init.method === 'POST') { submissions++; return Response.json({ status_url: 'https://queue.fal.run/status', response_url: 'https://queue.fal.run/result' }); }
    if (url.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
    if (url.endsWith('/result')) return Response.json({ model_glb: { url: 'https://media.example/model.glb' } });
    return new Response(submissions === 1 ? cubeGlb() : new Uint8Array(12));
  });
  const requester = { ...user, email: 'lead@studio.example' };
  assert.equal((await app.boardRoom.startNano({ nodeId: '3d', requester: { ...requester, email: 'outsider@example.com' } })).status, 403);
  app.directory.changeTeamAccess(requester.email, { model3d: { email: requester.email, allowed: false } });
  assert.equal(app.directory.nanoAllowed(requester.email), true);
  const denied = await app.boardRoom.startNano({ nodeId: '3d', requester });
  assert.equal(denied.status, 403); assert.equal(denied.error, '3D generation isn’t available for your account. Ask a site admin for access.');
  assert.equal(submissions, 0); assert.deepEqual(app.directory.nanoUsage(requester.email), { usedToday: 0, teamSpentUsd: 0 });
  app.directory.changeTeamAccess(requester.email, { model3d: { email: requester.email, allowed: true } });
  app.directory.changeTeamAccess(requester.email, { nano: { entry: '@studio.example', allowed: false } });
  assert.equal(app.directory.nanoAllowed(requester.email), false);
  const run = await app.boardRoom.startNano({ nodeId: '3d', requester }); assert.ok(run.run); await app.settle();
  const saved = app.boardRoom.document.getMap('runs').get(run.run.id);
  assert.equal(saved.status, 'completed'); assert.equal(saved.count, 1); assert.match(saved.error, /1 of 2 images failed/);
  assert.deepEqual(app.directory.nanoUsage(requester.email), { usedToday: 1, teamSpentUsd: .75 });
  const rejected = await app.boardRoom.startNano({ nodeId: '3d', requester }); assert.equal(rejected.status, 429); assert.match(rejected.error, /budget|limit/); assert.equal(submissions, 2);
});

runtimeTest('3D shrinks large images via IMAGES and fails before billing when resize is unavailable', async t => {
  const { cubeGlb } = await import('./fixtures/cube-glb.mjs'), app = cloudSetup(t, { SITE_OWNER_EMAIL: 'lead@studio.example', FAL_KEY: 'key' }); await app.boardRoom.setName(app.board.id);
  const before = readCloudGraph(app.boardRoom.document);
  applyLocalGraph(app.boardRoom.document, { ...before, nodes: [...before.nodes, { id: '3d', type: 'text', position: { x: 0, y: 0 }, data: { text: '', task: 'model3d' } }], edges: [...before.edges, { id: '3di', source: 'i', target: '3d' }] }, before, 'seed');
  app.files.set('assets/' + reference, { bytes: png(5000, 4500), size: 33 });
  const requester = { ...user, email: 'lead@studio.example' };
  const failed = await app.boardRoom.startNano({ nodeId: '3d', requester }); await app.settle();
  assert.equal(failed.status, 400); assert.match(failed.error, /needs resizing/); assert.equal(failed.run, undefined); assert.equal(app.directory.nanoUsage(requester.email).usedToday, 0);
  const transforms = []; let submitted;
  app.boardRoom.env.IMAGES = { input: () => ({ transform: value => { transforms.push(value); return { output: async ({ format }) => { assert.equal(format, 'image/jpeg'); return { response: () => new Response(jpeg(2048, 1843)) }; } }; } }) };
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (init.method === 'POST') { submitted = JSON.parse(init.body); return Response.json({ status_url: 'https://queue.fal.run/status', response_url: 'https://queue.fal.run/result' }); }
    if (url.endsWith('/status')) return Response.json({ status: 'COMPLETED' }); if (url.endsWith('/result')) return Response.json({ model_glb: { url: 'https://media.example/model.glb' } }); return new Response(cubeGlb());
  });
  const success = await app.boardRoom.startNano({ nodeId: '3d', requester }); await app.settle();
  assert.equal(app.boardRoom.document.getMap('runs').get(success.run.id).status, 'completed'); assert.match(submitted.input_image_url, /^data:image\/jpeg;base64,/); assert.equal(transforms[0].width, 2048); assert.equal(transforms[0].height, 2048);
});

runtimeTest('concurrent 3D runs share one room lane; cancelling a queued run starts no extra paid call', async t => {
  const { cubeGlb } = await import('./fixtures/cube-glb.mjs'), app = cloudSetup(t, { SITE_OWNER_EMAIL: 'lead@studio.example', FAL_KEY: 'key' }); await app.boardRoom.setName(app.board.id);
  const before = readCloudGraph(app.boardRoom.document), generators = ['3da', '3db'].map(id => ({ id, type: 'text', position: { x: 0, y: 500 }, data: { text: '', task: 'model3d' } }));
  applyLocalGraph(app.boardRoom.document, { ...before, nodes: [...before.nodes, ...generators], edges: [...before.edges, ...generators.map(n => ({ id: 'e' + n.id, source: 'i', target: n.id }))] }, before, 'seed');
  const entered = gate(), release = gate(); let submissions = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (init.method === 'POST') { submissions++; entered.open(); await release.promise; return Response.json({ status_url: 'https://queue.fal.run/status', response_url: 'https://queue.fal.run/result', cancel_url: 'https://queue.fal.run/cancel' }); }
    if (url.endsWith('/status')) return Response.json({ status: 'COMPLETED' }); if (url.endsWith('/result')) return Response.json({ model_glb: { url: 'https://media.example/model.glb' } }); return new Response(cubeGlb());
  });
  const requester = { ...user, email: 'lead@studio.example' }, first = await app.boardRoom.startNano({ nodeId: '3da', requester }); await entered.promise;
  const second = await app.boardRoom.startNano({ nodeId: '3db', requester }); assert.equal(submissions, 1);
  await app.boardRoom.cancelNano({ runId: second.run.id, email: requester.email }); release.open(); await app.settle();
  assert.equal(submissions, 1); assert.equal(app.boardRoom.document.getMap('runs').get(first.run.id).status, 'completed'); assert.equal(app.boardRoom.document.getMap('runs').get(second.run.id).status, 'cancelled');
  assert.deepEqual(app.directory.nanoUsage(requester.email), { usedToday: 1, teamSpentUsd: .375 });
});

runtimeTest('fal-only sites report the separate 3D access and shared allowance without requiring Gemini configuration', async t => {
  const app = cloudSetup(t, { SITE_OWNER_EMAIL: 'lead@studio.example', FAL_KEY: 'key', GEMINI_API_KEY: '' }), cookie = await app.cookie('lead@studio.example');
  const status = await (await app.request('/api/nano', { cookie })).json();
  assert.equal(status.configured, false); assert.equal(status.model3d.configured, true); assert.equal(status.model3d.allowed, true); assert.equal(status.model3d.dailyImages, 100);
});

runtimeTest('a 3D thumbnail that fails to store falls back to the source poster', async t => {
  const { cubeGlb } = await import('./fixtures/cube-glb.mjs'), app = cloudSetup(t, { SITE_OWNER_EMAIL: 'lead@studio.example', FAL_KEY: 'key' }); await app.boardRoom.setName(app.board.id);
  const before = readCloudGraph(app.boardRoom.document);
  applyLocalGraph(app.boardRoom.document, { ...before, nodes: [...before.nodes, { id: '3d', type: 'text', position: { x: 0, y: 0 }, data: { text: '', task: 'model3d' } }], edges: [...before.edges, { id: '3di', source: 'i', target: '3d' }] }, before, 'seed');
  const put = app.env.FILES.put.bind(app.env.FILES);
  t.mock.method(app.env.FILES, 'put', async (key, ...args) => { if (key.endsWith('.png')) throw new Error('thumbnail write failed'); return put(key, ...args); });
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (init.method === 'POST') return Response.json({ status_url: 'https://queue.fal.run/status', response_url: 'https://queue.fal.run/result' });
    if (url.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
    if (url.endsWith('/result')) return Response.json({ model_glb: { url: 'https://media.example/model.glb' }, thumbnail: { url: 'https://media.example/poster.png' } });
    return new Response(url.endsWith('.glb') ? cubeGlb() : png(256, 256));
  });
  const started = await app.boardRoom.startNano({ nodeId: '3d', requester: { ...user, email: 'lead@studio.example' } }); await app.settle();
  const graph = readCloudGraph(app.boardRoom.document); assert.equal(graph.runs.find(run => run.id === started.run.id).status, 'completed'); assert.equal(graph.nodes.find(node => node.data.runId === started.run.id).data.poster, reference);
});

test('a stale page’s refusal follows the browser’s language, preferring Ukrainian or English by weight, and matches the translation', async () => {
  const { default: uk } = await import('../src/locales/uk.mjs');
  assert.equal(uk[staleSettings.en], staleSettings.uk);
  const both = `${staleSettings.en} ${staleSettings.uk}`;
  for (const [header, expected] of [['uk', staleSettings.uk], ['uk-UA,uk;q=0.9,en;q=0.8', staleSettings.uk], ['ru-RU,ru;q=0.9,uk;q=0.8,en;q=0.7', staleSettings.uk],
    ['en-US,en;q=0.9,uk;q=0.8', both], ['en;q=0.5,uk;q=0.8', staleSettings.uk], ['uk;q=0,en', both], ['de-DE', both], ['', both], [null, both], ['*', both]]) assert.equal(staleSettingsError(header), expected, String(header));
});

runtimeTest('Nano Banana gets the chosen shape, size and thinking, reserves for them, and stale pages are asked to reload', async t => {
  const { request, cookie, board, boardRoom, settle, directory } = cloudSetup(t), lead = await cookie('lead@studio.example'), path = `/api/boards/${board.id}/nano`;
  const set = changes => { const before = readCloudGraph(boardRoom.document), next = structuredClone(before); Object.assign(next.nodes.find(node => node.id === 'p').data, changes); applyLocalGraph(boardRoom.document, next, before, 'edit'); };
  // A setting Nano Banana cannot use changes nothing it sends, so even a page from before settings may start the run.
  set({ background: 'transparent' });
  const calls = fakeGemini(t, async () => Response.json(interaction([png(100, 100)])));
  assert.equal((await request(path, { method: 'POST', cookie: lead, data: { nodeId: 'p' } })).status, 202); await settle();
  assert.equal(calls[0].body.response_format, undefined); assert.equal(calls[0].body.generation_config, undefined);
  assert.deepEqual(readCloudGraph(boardRoom.document).runs[0].settings, { requested: { background: 'transparent' }, applied: {} });
  set({ aspectRatio: '9:16', imageSize: '4K', nanoThinking: 'minimal', variants: 2 });
  const stale = await request(path, { method: 'POST', cookie: lead, data: { nodeId: 'p' } });
  // Such a page cannot translate the refusal, so it comes in the browser's language, or in both without a clear choice.
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error, `${staleSettings.en} ${staleSettings.uk}`);
  const ukrainian = await request(path, { method: 'POST', cookie: lead, data: { nodeId: 'p' }, headers: { 'Accept-Language': 'uk-UA,uk;q=0.9,en-US;q=0.8' } });
  assert.equal(ukrainian.status, 409); assert.equal((await ukrainian.json()).error, staleSettings.uk);
  assert.equal(calls.length, 1);
  t.mock.restoreAll();
  const held = gate(), waiting = fakeGemini(t, async () => { await held.promise; return Response.json(interaction([png(100, 100)])); });
  const spentBefore = directory.nanoUsage('lead@studio.example').teamSpentUsd;
  assert.equal((await request(path, { method: 'POST', cookie: lead, data: { nodeId: 'p', settings: 1 } })).status, 202);
  await new Promise(resolve => setImmediate(resolve));
  // Both variants are held at the 4K, minimal-thinking estimate while they run.
  const estimate = nanoEstimate({ promptLength: nanoPrompt(readCloudGraph(boardRoom.document), 'p').prompt.length, references: 1, imageSize: '4K', thinking: 'minimal' });
  assert.equal(Math.round((directory.nanoUsage('lead@studio.example').teamSpentUsd - spentBefore) * 1e6), Math.round(2 * estimate * 1e6));
  held.open(); await settle();
  assert.equal(waiting.length, 2);
  for (const call of waiting) { assert.deepEqual(call.body.response_format, { type: 'image', aspect_ratio: '9:16', image_size: '4K' }); assert.deepEqual(call.body.generation_config, { thinking_level: 'minimal' }); }
  const run = readCloudGraph(boardRoom.document).runs.find(item => item.variants === 2);
  assert.deepEqual(run.settings.applied, { aspectRatio: '9:16', imageSize: '4K', nanoThinking: 'minimal' });
  // Agents never come from an old page, so their runs use the settings too.
  assert.equal((await boardRoom.mcp({ tool: 'start_run', args: { nodeId: 'p' }, user: { name: 'Lead', email: 'lead@studio.example' } })).error, undefined);
});
