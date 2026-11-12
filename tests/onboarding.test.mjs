import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyChecklist, readChecklist, writeChecklist, checklistEvent, checklistSteps, directInputs, inputLabel, freePromptPosition, freeSpot, focusViewport, generationIntent, intentUnchanged, generationReadiness } from '../src/onboarding.mjs';

const text = (id, value = 'A bird', x = 0, y = 0) => ({ id, type: 'text', position: { x, y }, data: { text: value } });
const asset = '12345678-1234-1234-1234-123456789abc.png';
const image = (id, x = 0, y = 0) => ({ id, type: 'image', position: { x, y }, data: { asset } });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target });

test('input chip counts directly connected nodes once and excludes ancestors and unrelated nodes', () => {
  const graph = { nodes: [image('i'), text('context'), text('ancestor'), text('target'), image('other')], edges: [edge('i', 'target'), edge('context', 'target'), edge('ancestor', 'context'), { ...edge('i', 'target'), id: 'duplicate-edge' }] };
  assert.deepEqual(directInputs(graph, 'target'), { images: 1, text: 1 });
  assert.equal(inputLabel(directInputs(graph, 'target')), '1 image · 1 text');
  assert.equal(inputLabel({ images: 2, text: 0 }), '2 images'); assert.equal(inputLabel({ images: 0, text: 0 }), '');
});

test('variation placement finds space to the right without moving nodes or group frames', () => {
  const graph = { nodes: [image('source'), text('block', '', 400, 0), image('tall', 400, 300)], edges: [], groups: [{ id: 'g', name: 'Group', collapsed: false, nodeIds: ['block', 'tall'] }] };
  const before = structuredClone(graph), position = freePromptPosition(graph, 'source');
  assert.equal(position.x, 400); assert.ok(position.y < 0); assert.ok(Math.abs(position.y) < 640); assert.deepEqual(graph, before);
  assert.deepEqual(freePromptPosition({ nodes: [image('source')], edges: [] }, 'source'), { x: 400, y: 0 });
  assert.throws(() => freePromptPosition(graph, 'missing'), /no longer exists/);
});

test('new nodes prefer an available spot inside the viewport and fall back nearby when it is full', () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 600 }, board = { nodes: [text('block', '', 500, 0)], edges: [], groups: [] };
  const spot = freeSpot(board, { x: 12000, y: 12000 }, bounds);
  assert.ok(spot.x >= 0 && spot.x + 310 <= 1000 && spot.y >= 0 && spot.y + 150 <= 600);
  const full = { nodes: [{ ...image('full'), measured: { width: 1000, height: 600 } }], edges: [], groups: [] };
  const outside = freeSpot(full, { x: 500, y: 200 }, bounds);
  assert.ok(outside.x >= 1030 || outside.x + 310 <= -30 || outside.y >= 630 || outside.y + 150 <= -54);
  const portrait = freeSpot(board, { x: 200, y: 400 }, bounds, { width: 310, height: 500 });
  assert.ok(portrait.y >= 0 && portrait.y + 500 <= 600);
});

test('focus keeps a readable visible viewport and recenters only an off-screen or tiny prompt', () => {
  const node = text('p', '', 100, 100), viewport = { x: 0, y: 0, zoom: 1 };
  assert.equal(focusViewport(node, viewport, { width: 900, height: 600 }), null);
  assert.deepEqual(focusViewport(text('off', '', 5000, 2000), viewport, { width: 900, height: 600 }), { x: 5155, y: 2075, zoom: 1 });
  assert.equal(focusViewport(node, { ...viewport, zoom: .2 }, { width: 900, height: 600 }).zoom, .85);
  const covered = focusViewport(text('covered', '', 100, 350), viewport, { width: 900, height: 600, occlusion: { x: 26, y: 324, width: 280, height: 200 } });
  assert.ok(covered); assert.ok(covered.y > 425);
});

test('pairing intent ignores positions and unrelated edits but detects target, template, direct context, images and connections', () => {
  const graph = { nodes: [text('ancestor'), image('image'), text('context'), text('target'), text('unrelated')], edges: [edge('ancestor', 'context'), edge('context', 'target'), edge('image', 'target')] };
  const intent = generationIntent(graph, 'board', 'target');
  const moved = structuredClone(graph); moved.nodes[3].position.x = 800; moved.nodes[4].data.text = 'Other artist'; moved.nodes[0].data.text = 'Indirect ancestor';
  assert.equal(intentUnchanged(intent, moved, 'board'), true);
  for (const change of [
    graph => { graph.nodes[3].data.text = 'Changed'; },
    graph => { graph.nodes[2].data.text = 'Changed connected text'; },
    graph => { graph.nodes[1].data.caption = 'Changed reference'; },
    graph => { graph.nodes[1].data.asset = '00000000-0000-0000-0000-000000000000.png'; },
    graph => { graph.nodes[3].data.template = { name: 'Views', instructions: 'Front', assets: [] }; },
    graph => { graph.edges.pop(); },
    graph => { graph.nodes.pop(); graph.nodes = graph.nodes.filter(node => node.id !== 'target'); graph.edges = []; },
  ]) { const next = structuredClone(graph); change(next); assert.equal(intentUnchanged(intent, next, 'board'), false); }
  assert.equal(intentUnchanged(intent, graph, 'another-board'), false); assert.equal(intentUnchanged(null, graph, 'board'), false);
});

test('checklist ticks only personal successful actions and completed tracked runs, and tolerates denied storage', () => {
  const start = emptyChecklist();
  assert.equal(checklistEvent(start, { type: 'prompt', own: false }), start);
  assert.equal(checklistEvent(start, { type: 'run-finished', run: { id: 'teammate', status: 'completed', count: 1 } }), start);
  let state = checklistEvent(start, { type: 'run-started', id: 'mine' });
  for (const status of ['running', 'failed', 'cancelled']) assert.equal(checklistEvent(state, { type: 'run-finished', run: { id: 'mine', status, count: 1 } }), state);
  assert.equal(checklistEvent(state, { type: 'run-finished', run: { id: 'mine', status: 'completed', count: 0 } }), state);
  state = checklistEvent(state, { type: 'run-finished', run: { id: 'mine', status: 'completed', outputIds: ['output'] } });
  assert.equal(state.done.generate, true); assert.equal(state.done.prompt, false);
  for (const type of ['prompt', 'variation', 'helper']) state = checklistEvent(state, { type });
  assert.ok(checklistSteps(state, true, false).every(step => step.done));
  assert.equal(checklistSteps(start, false, false).length, 3); assert.equal(checklistSteps(start, true, true).length, 3);
  assert.equal(checklistEvent(state, { type: 'dismiss' }).dismissed, true);
  assert.equal(checklistEvent(state, { type: 'reopen' }).dismissed, false);
  const store = new Map(), storage = { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) };
  writeChecklist(storage, 'viewer', state); assert.deepEqual(readChecklist(storage, 'viewer'), state);
  assert.deepEqual(readChecklist(storage, 'other-viewer'), emptyChecklist());
  const denied = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Denied'); } };
  assert.deepEqual(readChecklist(denied, 'key'), emptyChecklist()); assert.doesNotThrow(() => writeChecklist(denied, 'key', state));
  storage.setItem('bad', '{bad'); assert.deepEqual(readChecklist(storage, 'bad'), emptyChecklist());
});

test('helper readiness distinguishes pairing, Codex availability, sign-in and generation support', () => {
  const status = { connected: true, signedIn: true, imageGeneration: true };
  assert.equal(generationReadiness({ required: true, paired: false, status }).key, 'helper');
  assert.equal(generationReadiness({ required: true, paired: true, online: false, status }).key, 'helper');
  assert.equal(generationReadiness({ required: true, paired: true, status: { ...status, signedIn: false } }).key, 'signin');
  assert.equal(generationReadiness({ required: true, paired: true, status: { ...status, imageGeneration: false } }).key, 'codex');
  const missing = { connected: false, codexMissing: true, codexInstall: { supported: true, state: 'idle' } };
  assert.deepEqual(generationReadiness({ required: true, paired: true, status: missing }), { key: 'install', label: 'Codex not installed · Install', action: 'Install Codex' });
  assert.equal(generationReadiness({ required: true, paired: false, status: missing }).key, 'helper');
  assert.equal(generationReadiness({ required: true, paired: true, status: { ...missing, codexInstall: { supported: false } } }).key, 'codex');
  assert.equal(generationReadiness({ required: true, paired: true, status }).label, 'Ready to generate');
  assert.equal(generationReadiness({ required: false, paired: false, status: {} }).key, 'ready');
});
