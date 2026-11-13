import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedGraph, cloneSelection, readNodeClipboard, nodeClipboardType, copyImageToClipboard, imageClipboardPng } from '../src/clipboard.mjs';
import { duplicateNodes, validateGraph } from '../graph.mjs';

const nodes = [
  { id: 'prompt', type: 'text', position: { x: -100, y: 90 }, data: { text: 'Keep my exact prompt' }, selected: true, measured: { width: 310, height: 80 } },
  { id: 'image', type: 'image', position: { x: 290, y: 170 }, data: { asset: '12345678-1234-1234-1234-123456789abc.png', runId: 'original-run' }, selected: true },
  { id: 'other', type: 'text', position: { x: 700, y: 0 }, data: { text: 'Unselected' } },
];
const edges = [{ id: 'inside', source: 'prompt', target: 'image' }, { id: 'outside', source: 'other', target: 'prompt' }];

test('main image IDs follow copied edges, including external parents, and drop when clipboard excludes the image', () => {
  const prompt = { ...structuredClone(nodes[0]), data: { text: 'Edit', generator: 'gpt-image', mainImage: 'image' } }, image = structuredClone(nodes[1]);
  const graph = { nodes: [prompt, image], edges: [{ id: 'input', source: 'image', target: 'prompt' }] }, before = structuredClone(graph);
  const together = cloneSelection(selectedGraph(graph.nodes, graph.edges));
  assert.equal(together.nodes[0].data.mainImage, together.nodes[1].id);
  image.selected = false;
  const selection = selectedGraph(graph.nodes, graph.edges), duplicate = cloneSelection(selection, undefined, graph), paste = cloneSelection(selection);
  assert.equal(duplicate.nodes[0].data.mainImage, 'image'); assert.equal(duplicate.edges[0].source, 'image');
  assert.equal(paste.nodes[0].data.mainImage, undefined); assert.equal(paste.edges.length, 0);
  graph.edges = [];
  assert.equal(duplicateNodes(graph, ['prompt', 'image']).nodes[0].data.mainImage, undefined);
  assert.equal(prompt.data.mainImage, before.nodes[0].data.mainImage);
});

test('duplicate and clipboard paste preserve content, relative placement and internal connections with fresh IDs', () => {
  const before = structuredClone({ nodes, edges }), selection = selectedGraph(nodes, edges);
  assert.deepEqual(selection.nodes.map(node => node.id), ['prompt', 'image']);
  assert.equal(selection.edges.length, 1);
  assert.ok(selection.nodes.every(node => !('measured' in node) && !('selected' in node)));
  const decoded = readNodeClipboard(JSON.stringify(selection));
  assert.deepEqual(decoded, selection);
  for (const target of [undefined, { x: 900, y: -200 }]) {
    const result = cloneSelection(decoded, target);
    assert.deepEqual(result.nodes[0].position, target || { x: -60, y: 130 });
    assert.equal(result.nodes[1].position.x - result.nodes[0].position.x, 390);
    assert.equal(result.nodes[1].position.y - result.nodes[0].position.y, 80);
    assert.deepEqual(result.nodes.map(node => { const { createdAt, ...data } = node.data; assert.ok(Number.isFinite(Date.parse(createdAt))); return data; }), nodes.slice(0, 2).map(node => node.data));
    assert.ok(result.nodes.every(node => node.selected && !nodes.some(original => original.id === node.id)));
    assert.equal(new Set(result.nodes.map(node => node.id)).size, 2);
    assert.notEqual(result.edges[0].id, 'inside');
    assert.deepEqual(result.edges.map(({ source, target }) => ({ source, target })), [{ source: result.nodes[0].id, target: result.nodes[1].id }]);
    result.nodes[0].data.text = 'Edited copy';
  }
  assert.deepEqual({ nodes, edges }, before);
  assert.equal(selection.nodes[0].data.text, 'Keep my exact prompt');
  assert.deepEqual(cloneSelection(selectedGraph([], [])), { nodes: [], edges: [] });
});

test('duplicate keeps external parents (including image provenance) and internal edges, but never outgoing edges', () => {
  const prompt = (id, selected = false) => ({ id, selected, type: 'text', position: { x: 0, y: 0 }, data: { text: id, createdAt: '2020-01-01T00:00:00.000Z' } });
  const nodes = [prompt('parent'), prompt('a', true), prompt('b', true), prompt('outside')];
  const edges = [{ id: 'in', source: 'parent', target: 'a' }, { id: 'between', source: 'a', target: 'b' }, { id: 'out', source: 'b', target: 'outside' }];
  const graph = { nodes, edges }, before = structuredClone(graph);
  const copied = cloneSelection(selectedGraph(nodes, edges), undefined, graph), [a, b] = copied.nodes;
  assert.deepEqual(copied.edges.map(({ source, target }) => ({ source, target })), [{ source: 'parent', target: a.id }, { source: a.id, target: b.id }]);
  assert.ok(copied.nodes.every(node => node.data.createdAt > nodes[0].data.createdAt));
  assert.doesNotThrow(() => validateGraph({ nodes: [...nodes, ...copied.nodes], edges: [...edges, ...copied.edges] }));
  assert.deepEqual(graph, before);
  const ids = new Map([['a', 'fixed-copy']]), edgeIds = new Map(), createdAt = new Date().toISOString();
  assert.deepEqual(duplicateNodes(graph, ['a'], { ids, edgeIds, createdAt }), duplicateNodes(graph, ['a'], { ids, edgeIds, createdAt }));
  const image = { id: 'image', type: 'image', position: { x: 0, y: 0 }, data: { asset: '12345678-1234-1234-1234-123456789abc.png', runId: 'generated' } };
  assert.deepEqual(duplicateNodes({ nodes: [nodes[0], image], edges: [{ id: 'provenance', source: 'parent', target: 'image' }] }, ['image']).edges.map(edge => edge.source), ['parent']);
  const cycle = { nodes: nodes.slice(0, 3), edges: [...edges.slice(0, 2), { id: 'cycle', source: 'b', target: 'parent' }] };
  assert.throws(() => duplicateNodes(cycle, ['a']), /loop/);
});

test('a large clipboard selection is validated independently of its source board size', () => {
  const nodes = Array.from({ length: 1050 }, (_, id) => ({ id: String(id), type: 'text', position: { x: 0, y: 0 }, data: { text: 'Prompt' }, selected: true }));
  const copied = cloneSelection(selectedGraph(nodes, []));
  assert.equal(copied.nodes.length, nodes.length); assert.doesNotThrow(() => validateGraph(copied));
});

test('clipboard parsing rejects ordinary text, unrelated JSON, invalid assets, dangling links and cycles', () => {
  const selection = selectedGraph(nodes, edges);
  for (const text of ['ordinary pasted text', '{bad', 'null', JSON.stringify({ nodes: [], edges: [] }), JSON.stringify({ ...selection, version: 2 }), JSON.stringify({ ...selection, nodes: [] })]) assert.equal(readNodeClipboard(text), null);
  for (const value of [
    { ...selection, nodes: [{ ...selection.nodes[1], data: { asset: '../../secrets.png' } }] },
    { ...selection, edges: [{ id: 'dangling', source: 'missing', target: 'prompt' }] },
    { ...selection, edges: [...selection.edges, { id: 'cycle', source: 'image', target: 'prompt' }] },
  ]) assert.equal(readNodeClipboard(JSON.stringify(value)), null);
  assert.equal(selection.format, nodeClipboardType);
});

test('image copy starts during the gesture and copies the original PNG bytes', async t => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
  t.after(() => {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator); else delete globalThis.navigator;
    if (previousItem) Object.defineProperty(globalThis, 'ClipboardItem', previousItem); else delete globalThis.ClipboardItem;
  });
  let items, finish;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { write: values => { items = values; return Promise.resolve(); } } } });
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: class { constructor(value) { this.value = value; } } });
  const response = new Promise(resolve => { finish = resolve; });
  const copying = copyImageToClipboard(response);
  assert.ok(items, 'clipboard write must start synchronously during the user gesture');
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  finish(new Response(png)); await copying;
  assert.deepEqual(new Uint8Array(await (await items[0].value['image/png']).arrayBuffer()), new Uint8Array(await png.arrayBuffer()));
  await assert.rejects(imageClipboardPng(new Response('', { status: 404 })), /Could not load/);
});

test('non-PNG images are converted at their original dimensions and temporary URLs are released', async t => {
  const originals = Object.fromEntries(['Image', 'document', 'URL'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of Object.entries(originals)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  let revoked, drawn, canvas;
  Object.defineProperty(globalThis, 'URL', { configurable: true, value: { createObjectURL: () => 'blob:test', revokeObjectURL: value => { revoked = value; } } });
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: class { constructor() { this.naturalWidth = 2400; this.naturalHeight = 1300; } set src(_value) { queueMicrotask(() => this.onload()); } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas = { getContext: () => ({ drawImage: image => { drawn = image; } }), toBlob: callback => callback(new Blob(['png'], { type: 'image/png' })) } } });
  const png = await imageClipboardPng(new Response(new Blob(['jpeg'], { type: 'image/jpeg' })));
  assert.equal(png.type, 'image/png');
  assert.deepEqual([canvas.width, canvas.height], [2400, 1300]);
  assert.ok(drawn); assert.equal(revoked, 'blob:test');
});
