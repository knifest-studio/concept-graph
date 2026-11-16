import test from 'node:test';
import * as nodeModule from 'node:module';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Y from 'yjs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { ReactFlowProvider } from '@xyflow/react';
import { CloudGeneration } from '../src/cloud-generation.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { failureKind, promptAnalytics, recordedKind, runAnalytics, runTracker, siteKind } from '../src/generation-analytics.mjs';
import { details } from '../src/analytics-core.mjs';
import { errorMessage } from '../src/analytics-privacy.mjs';
import { describeModel, generationSettings, generators, gptImageModel, isDescribe, model3dModels, model3dTask, nanoModel, seedvrModel, topazModel } from '../graph.mjs';
import { generatorKind, startingGenerator, usesSiteGenerator } from '../src/generator.mjs';
import { t } from '../src/i18n.mjs';

// The room runs for real (only Cloudflare's base class is replaced), so the prompt's reading is checked against what it writes.
let DatabaseSync, BoardRoom, Directory;
if (nodeModule.registerHooks) {
  ({ DatabaseSync } = await import('node:sqlite'));
  const hooks = nodeModule.registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier !== 'cloudflare:workers') return nextResolve(specifier, context);
    return { url: 'data:text/javascript,' + encodeURIComponent('export const env = {}; export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), shortCircuit: true };
  } });
  try { ({ BoardRoom, Directory } = await import('../cloud/worker.mjs')); } finally { hooks.deregister(); }
}
const runtimeTest = nodeModule.registerHooks ? test : test.skip;
function png(width, height) {
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]); view.setUint32(16, width); view.setUint32(20, height); bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

const asset = '12345678-1234-1234-1234-123456789abc.png', second = '12345678-1234-1234-1234-123456789def.png';
const user = { name: 'Artist', color: '#448bfa' }, empty = { nodes: [], edges: [], groups: [], runs: [] };
const prompt = (id, data, y = 0) => ({ id, type: 'text', position: { x: 400, y }, data: { text: 'A courier robot at dawn', ...data } });
function board() {
  const doc = new Y.Doc();
  applyLocalGraph(doc, { nodes: [
    { id: 'i', type: 'image', position: { x: 0, y: 0 }, data: { asset, caption: 'Front view', mask: { asset: second, marked: second, base: asset, source: asset } } },
    { id: 'j', type: 'image', position: { x: 0, y: 300 }, data: { asset: second, caption: 'Side view' } },
    prompt('nano', { generator: 'nano-banana', variants: 4 }), prompt('gpt', { generator: 'gpt-image' }, 200), prompt('codex', { variants: 4 }, 400),
    prompt('describe', { generator: 'nano-banana', task: 'describe', text: '' }, 600), prompt('topaz', { task: 'upscale', text: '' }, 800),
    prompt('redraw', { task: 'upscale', upscaler: 'nano-banana', scale: 4, text: '' }, 1000), prompt('model', { task: 'model3d', modeler: 'trellis', text: '' }, 1200),
  ], edges: ['nano', 'gpt', 'codex', 'describe', 'topaz', 'redraw', 'model'].flatMap(target => [{ id: `i-${target}`, source: 'i', target }, { id: `j-${target}`, source: 'j', target }]), groups: [], runs: [] }, empty, 'seed');
  return doc;
}
function tracked(doc, enabled = () => true) {
  const events = [], tracker = runTracker({ runs: doc.getMap('runs'), read: () => readCloudGraph(doc), track: (name, fields) => events.push([name, details(fields)]), enabled });
  return { events, tracker };
}
const finish = (doc, id, fields) => doc.getMap('runs').set(id, { ...doc.getMap('runs').get(id), finishedAt: '2026-11-16T10:00:20.000Z', ...fields });
// The record the room writes for each site run (cloud/board-room.mjs startNano).
const roomRecord = (id, nodeId, fields) => ({ id, nodeId, status: 'running', provider: 'nano-banana', by: user, startedAt: '2026-11-16T10:00:00.000Z', createdAt: '2026-11-16T10:00:00.000Z', inputs: [{ nodeId: 'i', asset }, { nodeId: 'j', asset: second }], ...fields });

test('a site run started from its ID alone is logged with its real generator, model, variants and images', async () => {
  const doc = board(), calls = [], { events, tracker } = tracked(doc);
  // The room answers as it does today: the run's ID only, before its record reaches this tab.
  const generation = new CloudGeneration({ doc, boardId: 'board', user, ready: () => true, onStart: run => tracker.started(run), onError: () => {},
    api: async (url, options) => { calls.push(url); return { run: { id: '11111111-1111-4111-8111-111111111111' } }; } });
  await generation.startNano('nano');
  const [[name, fields]] = events;
  assert.equal(name, 'generation_started');
  assert.deepEqual(fields, { generator: 'nano-banana', model: nanoModel, task: 'image', run: '11111111-1111-4111-8111-111111111111', variants: 4, references: 2, masked: true });
  // The room's record ends it; a success sends no error message or kind.
  doc.getMap('runs').set(fields.run, roomRecord(fields.run, 'nano', { model: nanoModel, variants: 4, status: 'completed', finishedAt: '2026-11-16T10:00:20.000Z', outputIds: ['a', 'b', 'c', 'd'] }));
  const [finished, done] = events[1];
  assert.equal(finished, 'generation_finished');
  assert.deepEqual({ ...done, duration: undefined }, { ...fields, duration: undefined, count: 4 });
  assert.equal(done.duration, 20000); assert.equal('message' in done, false); assert.equal('errorKind' in done, false);
  assert.equal(events.length, 2, 'a run is logged once from start to end');
  doc.getMap('runs').set(fields.run, { ...doc.getMap('runs').get(fields.run), label: 'changed' });
  assert.equal(events.length, 2);
  generation.stop(); tracker.stop(); doc.destroy();
});

test('every kind of site run reads the same from its prompt as from the room’s record', () => {
  const doc = board(), graph = readCloudGraph(doc), node = id => graph.nodes.find(item => item.id === id);
  const cases = [
    ['nano', { model: nanoModel, variants: 4 }, { generator: 'nano-banana', model: nanoModel, task: 'image', variants: 4 }],
    ['gpt', { provider: 'gpt-image', model: gptImageModel }, { generator: 'gpt-image', model: gptImageModel, task: 'image', variants: 1 }],
    ['describe', { model: describeModel, task: 'describe' }, { generator: 'nano-banana', model: describeModel, task: 'describe', variants: 1 }],
    ['topaz', { model: topazModel, task: 'upscale', scale: 2 }, { generator: 'fal', model: topazModel, task: 'upscale', variants: 1 }],
    ['redraw', { model: nanoModel, task: 'upscale', scale: 4 }, { generator: 'nano-banana', model: nanoModel, task: 'upscale', variants: 1 }],
    ['model', { model: model3dModels.trellis, task: 'model3d', modeler: 'trellis' }, { generator: 'fal', model: model3dModels.trellis, task: 'model3d', variants: 1 }],
    // The site route runs a prompt without a site generator on Nano Banana, as the room does.
    ['codex', { model: nanoModel, variants: 4 }, { generator: 'nano-banana', model: nanoModel, task: 'image', variants: 4 }],
  ];
  for (const [id, record, expected] of cases) {
    assert.deepEqual(siteKind(node(id)), expected, id);
    assert.deepEqual(recordedKind(roomRecord('r', id, record)), expected, id);
  }
  assert.equal(recordedKind(roomRecord('seedvr', 'topaz', { model: seedvrModel, task: 'upscale' })).generator, 'fal');
  // Describe, upscale and 3D send no mask; an image prompt's references count every connected image.
  for (const [id, masked] of [['nano', true], ['describe', false], ['topaz', false], ['model', false]]) {
    assert.deepEqual([runAnalytics({ id: 'r', nodeId: id }, graph).references, runAnalytics({ id: 'r', nodeId: id }, graph).masked], [2, masked], id);
  }
  // A recorded run's own inputs decide, even when its prompt has changed since.
  assert.deepEqual(runAnalytics({ ...roomRecord('r', 'nano', { model: nanoModel }), inputs: [{ nodeId: 'i', asset, mask: true }] }, graph), { run: 'r', generator: 'nano-banana', model: nanoModel, task: 'image', variants: 1, references: 1, masked: true });
  assert.deepEqual(runAnalytics({ id: 'gone', nodeId: 'deleted' }, graph).references, 0);
  doc.destroy();
});

runtimeTest('the prompt reads as the record the room writes for every kind of site run', async t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  const sql = { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  const files = new Map([asset, second].map(name => [`assets/${name}`, { bytes: png(640, 480), size: 33 }])), waits = [];
  let directory;
  const env = { SESSION_SECRET: 'test', GEMINI_API_KEY: 'test-gemini-key', OPENAI_API_KEY: 'test-openai-key', FAL_KEY: 'test-fal-key', NANO_BANANA_ALLOWED: '@studio.example',
    Directory: { idFromName: name => name, get: () => directory },
    FILES: { async get(key) { const file = files.get(key); return file ? { size: file.size, arrayBuffer: async () => file.bytes.slice().buffer } : null; }, async head(key) { return files.get(key) || null; }, async put() {} } };
  directory = new Directory({ storage: { sql } }, env);
  const created = directory.createBoard('Robots'), values = new Map();
  const storage = { kv: { get: key => values.get(key), put: (key, value) => values.set(key, value), delete: key => values.delete(key) }, transactionSync: callback => callback(), get: async key => values.get(key), put: async (key, value) => { values.set(key, value); }, getAlarm: async () => null, setAlarm: async () => {} };
  const room = new BoardRoom({ storage, id: { name: created.id }, waitUntil: promise => waits.push(promise), blockConcurrencyWhile: callback => callback(), getWebSockets: () => [] }, env);
  room.onSave = async () => {}; t.after(() => room.document.destroy());
  await room.setName(created.id);
  sql.exec('INSERT INTO model3d_access (email, addedAt) VALUES (?, ?)', 'lead@studio.example', '2026-11-16');
  const seeded = board(); applyLocalGraph(room.document, readCloudGraph(seeded), empty, 'seed'); seeded.destroy();
  // No provider answers; only the record the room writes before it answers is compared.
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 500 }));
  for (const nodeId of ['nano', 'gpt', 'codex', 'describe', 'topaz', 'redraw', 'model']) {
    const graph = readCloudGraph(room.document), result = await room.startNano({ nodeId, requester: { name: 'Lead', email: 'lead@studio.example', color: user.color }, settings: true });
    assert.ok(result.run?.id, `${nodeId}: ${result.error}`);
    const record = room.document.getMap('runs').get(result.run.id);
    assert.deepEqual(runAnalytics({ id: result.run.id, nodeId }, graph), runAnalytics(record, graph), nodeId);
    await Promise.all(waits.splice(0));
  }
});

test('a Generate that never became a run is described as the route it was blocked on would run it', () => {
  const doc = board(), graph = readCloudGraph(doc);
  // Codex waiting for its helper: Codex's model, one image, a describe stays a describe.
  assert.deepEqual(promptAnalytics(graph, 'codex', { site: false }), { generator: 'codex', model: generationSettings.model, task: 'image', variants: 1, references: 2, masked: true });
  assert.deepEqual(promptAnalytics(graph, 'describe', { site: false }), { generator: 'codex', model: generationSettings.model, task: 'describe', variants: 1, references: 2, masked: false });
  // Site access missing: the site's generator and the prompt's variants.
  assert.deepEqual(promptAnalytics(graph, 'nano'), { generator: 'nano-banana', model: nanoModel, task: 'image', variants: 4, references: 2, masked: true });
  assert.deepEqual(details({ ...promptAnalytics(graph, 'model'), errorKind: 'access' }), { generator: 'fal', model: model3dModels.trellis, errorKind: 'access', task: 'model3d', variants: 1, references: 2, masked: false });
  doc.destroy();
});

test('describe, upscale and 3D runs also log their own start; a record already on the board decides', () => {
  const doc = board(), { events, tracker } = tracked(doc);
  for (const [id, nodeId, record] of [['22222222-2222-4222-8222-222222222222', 'topaz', { model: topazModel, task: 'upscale', scale: 2 }], ['33333333-3333-4333-8333-333333333333', 'model', { model: model3dModels.trellis, task: 'model3d', modeler: 'trellis' }], ['44444444-4444-4444-8444-444444444444', 'describe', { model: describeModel, task: 'describe' }]]) {
    doc.getMap('runs').set(id, roomRecord(id, nodeId, record));
    tracker.started({ id, nodeId });
  }
  assert.deepEqual(events.map(([name, fields]) => [name, fields.generator, fields.task]), [
    ['generation_started', 'fal', 'upscale'], ['upscale_started', 'fal', 'upscale'],
    ['generation_started', 'fal', 'model3d'], ['model3d_started', 'fal', 'model3d'],
    ['generation_started', 'nano-banana', 'describe'], ['describe_started', 'nano-banana', 'describe']]);
  tracker.stop(); doc.destroy();
});

test('a Codex run keeps Codex’s model and one image; only a failure carries its message and kind', async () => {
  const doc = board(), { events, tracker } = tracked(doc);
  const generation = new CloudGeneration({ doc, boardId: 'board', user, ready: () => true, onStart: run => tracker.started(run), onError: () => {},
    request: async () => new Response(new Uint8Array([1, 2, 3])), api: async () => ({}), helperRequest: async () => new Response(new Uint8Array([1])),
    helperApi: async (url, options = {}) => options.method === 'POST' ? { ok: true } : { jobs: [] } });
  generation.active = true;
  const id = await generation.start('codex');
  const [name, fields] = events[0];
  assert.equal(name, 'generation_started');
  // The prompt still holds 4 variants from a site generator; Codex makes one image.
  assert.deepEqual(fields, { generator: 'codex', model: generationSettings.model, task: 'image', run: id, variants: 1, references: 2, masked: true });
  finish(doc, id, { status: 'failed', error: 'Generation was interrupted. Run the prompt again.' });
  const failed = events.at(-1)[1];
  assert.equal(events.at(-1)[0], 'generation_failed'); assert.equal(failed.errorKind, 'interrupted'); assert.equal(failed.generator, 'codex');
  // Only a failure sends its text, which analytics keeps only when the interface shows it.
  assert.equal(failed.message, errorMessage('Generation was interrupted. Run the prompt again.'));
  generation.stop(); tracker.stop(); doc.destroy();
});

test('failure kinds come from the fixed texts the room, the helper and the providers write', () => {
  for (const [text, kind] of [
    ['Generation was interrupted. Run the prompt again.', 'interrupted'],
    ['The teammate whose Codex was chosen left the board before this generation started. Run the prompt again.', 'interrupted'],
    ['Nano Banana took longer than 3 minutes. Try again.', 'timeout'],
    ['Nano Banana declined this prompt or its references (Google’s safety filters). Change them and try again.', 'refused'],
    ['The site’s Gemini quota is used up for now. Try again later, or ask the site owner to raise it.', 'quota'],
    ['Daily limit reached (20/20). Only 2 of 4 images fit; connect fewer.', 'quota'],
    ['Team budget for this month is used up.', 'quota'],
    ['Access to the teammate’s Codex ended before this generation started. Ask for access and run the prompt again.', 'access'],
    ['Not available for your account. Ask a site admin for access.', 'access'],
    ['“Daily limit poster” is too large to reduce automatically (31 MB; the limit is 20 MB). Resize it first.', 'reference'],
    ['fal.ai rejected the site’s key. Ask the site owner to check FAL_KEY.', 'config'],
    ['GPT Image is busy right now. Try again in a minute.', 'busy'],
    ['The helper did not accept this job. Run the prompt again.', 'helper'],
    ['Reference images are still too large for Nano Banana after reducing them (40 MB in total). Use fewer images.', 'reference'],
    ['Could not reach the upscaler. Try again.', 'network'],
    ['Failed to fetch', 'network'],
    ['GPT Image returned no image. Try rephrasing the prompt.', 'empty'],
    ['Nano Banana failed (500). Try again.', 'provider'], ['', 'provider'], [undefined, 'provider'],
  ]) assert.equal(failureKind(text), kind, text);
});

test('nothing is followed while analytics is off', () => {
  const doc = board();
  let on = false;
  const { events, tracker } = tracked(doc, () => on);
  tracker.started({ id: '55555555-5555-4555-8555-555555555555', nodeId: 'nano' });
  on = true;
  doc.getMap('runs').set('55555555-5555-4555-8555-555555555555', roomRecord('55555555-5555-4555-8555-555555555555', 'nano', { model: nanoModel, status: 'completed' }));
  assert.deepEqual(events, []);
  tracker.stop(); doc.destroy();
});

test('the tray’s Dismiss all and a prompt’s settings chip have analytics names inside their private containers', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { GenerationTray } = await vite.ssrLoadModule('/src/GenerationTray.jsx');
    const { GenerationSettings } = await vite.ssrLoadModule('/src/GenerationSettings.jsx');
    const now = new Date().toISOString(), failed = id => ({ id, nodeId: 'p', label: 'A private prompt', status: 'failed', error: 'Nano Banana failed. Try again.', createdAt: now, startedAt: now, finishedAt: now, outputIds: [] });
    const tray = renderToStaticMarkup(React.createElement(GenerationTray, { runs: [failed('a'), failed('b')], launching: false, user, viewer: 'cloud', onFocus() {}, onCancel() {} }));
    assert.match(tray, /<button type="button" class="generation-tray-dismiss-all" data-analytics-name="Dismiss all"/);
    const chip = renderToStaticMarkup(React.createElement(ReactFlowProvider, null, React.createElement(GenerationSettings, { id: 'p', data: { text: 'A private prompt', aspectRatio: '16:9' }, generator: 'nano-banana', readOnly: false, change() {} })));
    assert.match(chip, /class="gen-settings-chip set" data-analytics-name="Generation settings"/);
  } finally { await vite.close(); }
});

// The editor's Generate (main.jsx run()), with the tab around it replaced by stand-ins: what it logs when a prompt does
// not start, or fails to start, on a cloud board.
const editor = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const runSource = editor.slice(editor.indexOf('  const run = async (nodeId, resumeIntent = null, event) => {'), editor.indexOf('  runAction.current = run;'));
function editorRun(graph, { site = { selectable: true, ready: true, note: '' }, readiness = 'ready', start } = {}) {
  const events = [], toasts = [], opened = [], ref = current => ({ current });
  const begin = async () => { const error = await start?.(); if (error) throw error; return 'run'; };
  const env = {
    alive: ref(true), pairing: false, mcpLocked: ref(false), readOnlyRef: ref(false), generationIntent: (graph, boardId, nodeId) => ({ nodeId }), currentGraph: () => graph, boardId: 'board',
    notify: message => toasts.push(['error', message]), inform: (message, notice) => toasts.push(['news', message, notice]), starting: null, generationStarting: ref(false), nodeRef: ref(graph.nodes),
    cloud: true, usesSiteGenerator, generatorKind, startingGenerator, rememberGenerator() {}, model3dTask, generators, isDescribe, model3dRef: ref(site), gptRef: ref(site), nanoRef: ref(site), readinessRef: ref({ key: readiness }), pendingIntent: ref(null),
    fixReadiness: () => opened.push('pairing'), effects: { start() {}, failedStart() {} }, userGeneration: ref(null), viewerMoved: ref(false), setStarting() {}, saveNow: async () => {},
    cloudSession: { refreshNano() {}, unpair() {}, jobs: { startNano: begin, start: begin } }, helperNeeded: true, setHelperOffline() {}, openHelper() {}, mergeRemote() {}, focusNode() {}, intentUnchanged: () => true, t,
    track: (name, fields, kind = 'app') => events.push([name, details(fields), kind]), promptAnalytics
  };
  const run = new Function(...Object.keys(env), `${runSource}; return run;`)(...Object.values(env));
  return { run, events, toasts, opened };
}

test('a Generate or Describe blocked before it starts is logged once, with the prompt as it would run and why', async () => {
  const doc = board(), graph = readCloudGraph(doc);
  // The site's daily limit: the toast still shows, but it is not also an error row.
  let tab = editorRun(graph, { site: { selectable: true, ready: false, note: 'Daily limit reached (20/20)' } });
  await tab.run('nano');
  assert.deepEqual(tab.events, [['generation_blocked', { ...details(promptAnalytics(graph, 'nano')), errorKind: 'quota', message: errorMessage('Daily limit reached (20/20)') }, 'app']]);
  assert.equal(tab.events[0][1].variants, 4); assert.equal(tab.events[0][1].references, 2);
  assert.deepEqual(tab.toasts, [['news', 'Daily limit reached (20/20)', undefined]]);
  // A describe the account has no access to.
  tab = editorRun(graph, { site: { selectable: false, ready: false, note: 'Not available for your account. Ask a site admin for access.' } });
  await tab.run('describe');
  assert.deepEqual(tab.events.map(([name, fields]) => [name, fields.generator, fields.task, fields.errorKind, fields.message]), [['generation_blocked', 'nano-banana', 'describe', 'access', 'Not available for your account. Ask a site admin for access.']]);
  // Codex needs its helper first: pairing opens, and the start is logged as Codex would run it.
  tab = editorRun(graph, { readiness: 'helper' });
  await tab.run('codex');
  assert.deepEqual(tab.events, [['generation_blocked', { generator: 'codex', model: generationSettings.model, errorKind: 'helper', task: 'image', variants: 1, references: 2, masked: true }, 'app']]);
  assert.deepEqual(tab.opened, ['pairing']); assert.deepEqual(tab.toasts, []);
  // A prompt that is ready starts and logs nothing here: the run tracker logs the start.
  tab = editorRun(graph, { site: { selectable: true, ready: true, note: '' } });
  await tab.run('nano');
  assert.deepEqual([tab.events, tab.toasts], [[], []]);
  doc.destroy();
});

test('a start the room or Codex refuses is logged with the prompt’s real generator, model and images', async () => {
  const doc = board(), graph = readCloudGraph(doc);
  // A Topaz upscale refused by the room ran on fal.ai, not in Codex.
  let tab = editorRun(graph, { start: () => Object.assign(new Error('Ask a site admin for access.'), { status: 403 }) });
  await tab.run('topaz');
  let [[name, fields, kind]] = tab.events;
  assert.equal(name, 'generation_failed'); assert.equal(kind, 'app');
  assert.deepEqual({ ...fields, duration: undefined }, { generator: 'fal', model: topazModel, errorKind: 'access', message: errorMessage('Ask a site admin for access.'), task: 'upscale', variants: 1, references: 2, masked: false, duration: undefined });
  assert.equal(typeof fields.duration, 'number');
  assert.deepEqual(tab.toasts, [['error', 'Ask a site admin for access.']], 'a failed start is still an error toast');
  // A Codex prompt keeps one variant and Codex's model, even with a site variant count left on the prompt.
  tab = editorRun(graph, { start: () => Object.assign(new Error('Too many requests.'), { status: 429 }) });
  await tab.run('codex');
  [[name, fields]] = tab.events;
  assert.deepEqual([name, fields.generator, fields.model, fields.variants, fields.references, fields.masked, fields.errorKind], ['generation_failed', 'codex', generationSettings.model, 1, 2, true, 'quota']);
  doc.destroy();
});
