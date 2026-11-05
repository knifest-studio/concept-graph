import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import * as Y from 'yjs';
import { signSession, userColor } from '../cloud/auth.mjs';
import { NanoError, nanoAllowed, nanoCost, nanoEstimate, nanoPrompt, nanoRequest, nanoResult, nanoSettings } from '../cloud/nano-banana.mjs';
import { validateGraph } from '../graph.mjs';
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

test('the allowed list matches whole emails and whole @domains in any case', () => {
  const list = ' Lead@Studio.example, @team.example;other@mail.example\nplain.example ';
  for (const email of ['lead@studio.example', 'LEAD@Studio.EXAMPLE', 'anyone@team.example', 'Other@Mail.Example', 'x@plain.example']) assert.equal(nanoAllowed(email, list), true, email);
  for (const email of ['someone@studio.example', 'lead@studio.example.evil', 'x@sub.team.example', 'x@evilteam.example', 'team.example@evil.example', 'other@mail.example.org', '@team.example', 'nobody']) assert.equal(nanoAllowed(email, list), false, email);
  assert.equal(nanoAllowed('lead@studio.example', ''), false); assert.equal(nanoAllowed('lead@studio.example', undefined), false);
});

test('settings come from the Worker environment with safe defaults, and the endpoint override stays on this machine', () => {
  const google = 'https://generativelanguage.googleapis.com';
  assert.deepEqual(nanoSettings({}), { configured: false, dailyImages: 50, monthlyUsd: 50, endpoint: google });
  assert.deepEqual(nanoSettings({ GEMINI_API_KEY: 'k', NANO_BANANA_DAILY_IMAGES: '20', NANO_BANANA_MONTHLY_USD: '12.5', NANO_BANANA_ENDPOINT: 'http://127.0.0.1:8788/' }),
    { configured: true, dailyImages: 20, monthlyUsd: 12.5, endpoint: 'http://127.0.0.1:8788' });
  assert.equal(nanoSettings({ GEMINI_API_KEY: '  ' }).configured, false);
  assert.deepEqual(nanoSettings({ NANO_BANANA_DAILY_IMAGES: 'many', NANO_BANANA_MONTHLY_USD: '-1' }), { configured: false, dailyImages: 50, monthlyUsd: 50, endpoint: google });
  assert.equal(nanoSettings({ NANO_BANANA_DAILY_IMAGES: 0 }).dailyImages, 0);
  for (const endpoint of ['https://attacker.example', 'http://localhost.attacker.example', 'file:///etc/passwd', 'not a url']) assert.equal(nanoSettings({ NANO_BANANA_ENDPOINT: endpoint }).endpoint, google, endpoint);
  assert.equal(nanoSettings({ NANO_BANANA_ENDPOINT: 'http://localhost:9000' }).endpoint, 'http://localhost:9000');
});

test('the request sends the prompt, connected context and labelled references, without Codex tool instructions', () => {
  const { prompt, images, target } = nanoPrompt(seed, 'p');
  assert.equal(target.id, 'p'); assert.deepEqual(images, [{ asset: reference, label: 'Front view' }]);
  assert.equal(prompt, 'Create an image for the request at the end. The earlier text is context for it, not separate requests.\n\nContext 1:\nCustom node instructions:\nUse warm light\n\nSoft painterly style\n\nReference images, attached in this order:\nImage 1: Front view\n\nRequest:\nA courier robot at dawn');
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

test('prompts may choose Nano Banana; any other generator value is rejected', () => {
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
  assert.deepEqual(one.position, { x: 470, y: 40 }); assert.equal(one.data.caption, undefined); assert.equal(one.data.aspect, 0.5); assert.deepEqual(one.data.author, user);
  assert.deepEqual(first.edges, [{ id: 'run-output-0-edge', source: 'p', target: 'run-output-0' }]); assert.deepEqual(first.groups, []);
  assert.deepEqual(first.runs.at(-1), { ...run, status: 'running', outputIds: ['run-output-0'], count: 1 });
  const second = placeRunOutput(first, { runId: 'run', nodeId: 'p', run: first.runs.at(-1), author: user, output: { index: 1 }, asset: reference, dimensions: { width: 100, height: 100 } });
  const [a, b] = ['run-output-0', 'run-output-1'].map(id => second.nodes.find(node => node.id === id));
  assert.deepEqual([a.data.caption, b.data.caption], ['Image 1', 'Image 2']);
  assert.deepEqual(b.position, { x: 470, y: 40 + 155 + 30 + 24 });
  assert.deepEqual(second.groups, [{ id: 'run-group', name: 'Group 1', nodeIds: ['run-output-0', 'run-output-1'], collapsed: false, slideshow: true }]);
  assert.equal(second.runs.at(-1).autoGroupId, 'run-group'); assert.equal(first.nodes.find(node => node.id === 'run-output-0').data.caption, undefined);
  assert.equal(placeRunOutput(second, { runId: 'run', nodeId: 'p', run: second.runs.at(-1), author: user, output: { index: 1 }, asset: reference }), null);
  assert.equal(placeRunOutput(second, { runId: 'run', nodeId: 'p', run: { ...second.runs.at(-1), status: 'cancelled' }, author: user, output: { index: 2 }, asset: reference }), null);
  assert.doesNotThrow(() => validateGraph(second));
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
  assert.deepEqual(JSON.parse(calls[0][1].body), { nodeId: 'p', client: doc.clientID, clock: Y.getState(doc.store, doc.clientID) });
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
      async get(key) { const file = files.get(key); return file ? { size: file.size, arrayBuffer: async () => file.bytes.slice().buffer } : null; },
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
  assert.deepEqual(await (await request('/api/nano', { cookie: lead })).json(), { configured: true, allowed: true, dailyImages: 1, usedToday: 0, monthlyUsd: 50, teamSpentUsd: 0, fal: false });
  assert.deepEqual(await (await request('/api/nano', { cookie: outsider })).json(), { configured: true, allowed: false, fal: false });
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
  assert.deepEqual(await (await request('/api/nano', { cookie: lead })).json(), { configured: false, allowed: true, fal: false });
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
  assert.deepEqual(body.input.slice(1), [{ type: 'image', mime_type: 'image/png', data: b64(png(640, 480)) }]);
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
  for (const bad of [1, 5, 2.5]) assert.throws(() => validateGraph({ nodes: [{ id: 'q', type: 'text', position: { x: 0, y: 0 }, data: { text: 'x', variants: bad } }], edges: [] }), /Invalid number of variants/);
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
  assert.deepEqual(body.input.slice(1).map(item => item.type), ['image']);
  assert.deepEqual([run.status, run.task, run.model, run.count], ['completed', 'describe', 'gemini-3.5-flash-lite', 1]);
  const output = graph.nodes.find(node => node.id === run.outputIds[0]);
  assert.deepEqual([output.type, output.data.text], ['text', 'A small courier robot lit from the left.']);
  assert.ok(graph.edges.some(edge => edge.source === 'd' && edge.target === output.id));
  const usage = directory.nanoUsage('lead@studio.example');
  assert.equal(usage.usedToday, 1); assert.equal(Math.round(usage.teamSpentUsd * 1e6), 30000 + Math.round((2000 * .3 + 1000 * 2.5)));
  validateGraph(graph);
});

test('upscale nodes take one to four connected images, and sizes, prices and labels follow the chosen upscaler', async () => {
  const { upscaleFactor, upscaleCost, upscaleEstimate, nanoAspect, falInput, nanoUpscaleFormat, upscaleSettings } = await import('../cloud/upscale.mjs');
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
  assert.deepEqual(falInput('seedvr', 2, 'data:x'), { image_url: 'data:x', upscale_mode: 'factor', upscale_factor: 2, output_format: 'jpg' });
  assert.deepEqual([resolutionLabel({ width: 1024, height: 1024 }), resolutionLabel({ width: 2048, height: 1536 }), resolutionLabel({ width: 2160, height: 3840 }), resolutionLabel({ width: 8192, height: 4096 }), resolutionLabel(undefined)], ['', '2K', '4K', '8K', '']);
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
