import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { duplicateNodes, imageNode, positionRunOutput, validateGraph } from '../graph.mjs';
import { arrangeLayers, layerIndex, layerOrder, layerShortcut, nextLayer, stackOnTop, topLayer } from '../src/layers.mjs';
import { canvasView, stampTargetAt } from '../src/canvas.mjs';
import { cloneSelection, readNodeClipboard, selectedGraph } from '../src/clipboard.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';

const asset = '12345678-1234-1234-1234-123456789abc.png';
const at = (z, extra = {}) => ({ ...(z === undefined ? {} : { z }), ...extra });
const text = (id, z, x = 0, y = 0) => ({ id, type: 'text', position: { x, y }, data: { text: id }, measured: { width: 310, height: 170 }, ...at(z) });
const image = (id, z) => ({ id, type: 'image', position: { x: 0, y: 0 }, data: { asset }, ...at(z) });
const sticky = (id, z, x = 0, y = 0) => ({ id, type: 'sticky', position: { x, y }, data: { text: '', color: '#fff3ad' }, ...at(z) });
const stamp = (id, z, attachedTo, x = 20, y = 20) => ({ id, type: 'stamp', position: { x, y }, data: { kind: 'heart', ...(attachedTo ? { attachedTo } : {}) }, ...at(z) });
const ids = nodes => layerOrder(nodes).map(node => node.id);
const apply = (nodes, changes) => nodes.map(node => changes.has(node.id) ? { ...node, z: changes.get(node.id) } : node);
const arranged = (nodes, selected, action) => ids(apply(nodes, arrangeLayers(nodes, selected, action)));

test('layer order sorts by z, keeps annotations above prompts and images on ties, then document order', () => {
  assert.deepEqual(ids([sticky('s'), text('b'), image('a'), stamp('m')]), ['b', 'a', 's', 'm']);
  assert.deepEqual(ids([sticky('s', 1), text('b', 3), image('a', 2), stamp('m', -1)]), ['m', 's', 'a', 'b']);
  // Invalid layers count as the default and never break ordering; group frames are not layered.
  assert.deepEqual(ids([text('big', 1e10), text('one', 1), text('nan', NaN), { id: 'g', type: 'group' }]), ['big', 'nan', 'one']);
  assert.equal(topLayer([text('a', 4), text('b', -9), { id: 'g', type: 'group', z: 50 }]), 4);
  assert.equal(nextLayer([]), 1); assert.equal(nextLayer([text('a')]), 1); assert.equal(nextLayer([text('a', 1e9)]), 1e9);
  for (const z of [Infinity, NaN, '1', 1e9 + 1, -1e9 - 1]) assert.throws(() => validateGraph({ nodes: [text('a', z)], edges: [] }), /layer/);
  assert.doesNotThrow(() => validateGraph({ nodes: [text('a', -1e9), text('b', 2.5)], edges: [] }));
});

test('a stamp below its parent renders directly above it, and rendering and placement use the same order', () => {
  // The reported case: a stamp placed on a sticky ended up behind it.
  const nodes = [stamp('stamp', 1, 'note'), text('cover', 2), sticky('note', 3), text('top', 4, 0, 0), sticky('apart', 5, 900, 900)];
  assert.deepEqual(ids(nodes), ['cover', 'note', 'stamp', 'top', 'apart']);
  const view = canvasView(nodes, [], [{ id: 'g', name: 'G', collapsed: false, nodeIds: ['cover', 'top'] }]);
  const z = new Map(view.nodes.map(node => [node.id, node.zIndex]));
  assert.equal(z.get('g'), 0);
  assert.deepEqual(['cover', 'note', 'stamp', 'top', 'apart'].map(id => z.get(id)), [1, 2, 3, 4, 5]);
  // A free stamp is not lifted.
  assert.deepEqual(ids([stamp('free', 1), sticky('note', 2)]), ['free', 'note']);
  // Placement hits the visibly topmost target, with or without render indices.
  const overlap = [text('low', 9, 0, 0), text('high', 1, 0, 0), sticky('side', 0, 400, 0)];
  assert.equal(stampTargetAt(overlap, { x: 50, y: 50 }), 'low');
  assert.equal(stampTargetAt(canvasView(overlap, [], []).nodes, { x: 50, y: 50 }), 'low');
  assert.equal(stampTargetAt(apply(overlap, new Map([['high', 10]])), { x: 50, y: 50 }), 'high');
});

test('new, pasted and duplicated nodes go on top and keep their relative order', () => {
  const board = { nodes: [text('a', 3), sticky('b', 7), stamp('c', 1, 'b')], edges: [] };
  assert.deepEqual(stackOnTop(board.nodes, [text('x', 50), text('y', 2)]).map(node => node.z), [9, 8]);
  const copies = duplicateNodes(board, ['c', 'b', 'a'], { ids: new Map([['a', 'a2'], ['b', 'b2'], ['c', 'c2']]) });
  // The stamp keeps its place directly above its copied sticky.
  assert.deepEqual(Object.fromEntries(copies.nodes.map(node => [node.id, node.z])), { a2: 8, b2: 9, c2: 10 });
  assert.equal(copies.nodes.find(node => node.id === 'c2').data.attachedTo, 'b2');
  const clipboard = readNodeClipboard(JSON.stringify(selectedGraph(board.nodes.map(node => ({ ...node, selected: true })), [])));
  assert.deepEqual(clipboard.nodes.map(node => node.z), [3, 7, 1]);
  const pasted = stackOnTop([text('elsewhere', 40)], cloneSelection(clipboard).nodes);
  assert.deepEqual(pasted.map(node => node.z), [41, 42, 43]);
  assert.deepEqual(selectedGraph([{ ...text('legacy'), selected: true }], []).nodes[0].z, undefined);
  const graph = { nodes: [text('prompt', 12)], edges: [], groups: [] }, run = { id: 'r', target: graph.nodes[0], outputIds: [] };
  const output = imageNode(run, asset, 0); positionRunOutput(output, graph, run);
  assert.equal(output.z, 13);
});

test('front, back, forward and backward reorder the selection one page at a time', () => {
  const nodes = [text('a', 1), text('b', 2), text('c', 3), text('d', 4)];
  assert.deepEqual(arranged(nodes, ['a'], 'front'), ['b', 'c', 'd', 'a']);
  assert.deepEqual(arranged(nodes, ['d', 'b'], 'back'), ['b', 'd', 'a', 'c']);
  assert.deepEqual(arranged(nodes, ['a', 'c'], 'forward'), ['b', 'a', 'd', 'c']);
  assert.deepEqual(arranged(nodes, ['a', 'b'], 'forward'), ['c', 'a', 'b', 'd']);
  assert.deepEqual(arranged(nodes, ['b', 'd'], 'backward'), ['b', 'a', 'd', 'c']);
  // Already in place, empty or group-only selections change nothing.
  for (const [selected, action] of [[['d'], 'front'], [['d'], 'forward'], [['a'], 'back'], [['a'], 'backward'], [[], 'front'], [['g'], 'front']]) assert.equal(arrangeLayers(nodes, selected, action).size, 0);
  assert.throws(() => arrangeLayers(nodes, ['a'], 'sideways'), /Unknown/);
  // Legacy nodes without z get explicit layers on the first change; only changed layers are returned.
  const legacy = [text('a'), text('b'), sticky('s')], changes = arrangeLayers(legacy, ['s'], 'back');
  assert.deepEqual([...changes], [['s', 1], ['a', 2], ['b', 3]]);
  assert.deepEqual([...arrangeLayers(nodes, ['c'], 'forward')], [['d', 3], ['c', 4]]);
});

test('attached stamps move with their parent and never go below it', () => {
  const nodes = [sticky('p', 1), stamp('s1', 2, 'p'), stamp('s2', 3, 'p'), text('q', 4), text('r', 5)];
  assert.deepEqual(arranged(nodes, ['p'], 'forward'), ['q', 'p', 's1', 's2', 'r']);
  assert.deepEqual(arranged(nodes, ['p'], 'front'), ['q', 'r', 'p', 's1', 's2']);
  const raised = apply(nodes, new Map([['p', 6]]));
  assert.deepEqual(ids(raised), ['q', 'r', 'p', 's1', 's2']);
  assert.deepEqual(arranged(raised, ['p'], 'back'), ['p', 's1', 's2', 'q', 'r']);
  // A stamp selected on its own moves within or above its parent's stack.
  assert.deepEqual(arranged(nodes, ['s1'], 'forward'), ['p', 's2', 's1', 'q', 'r']);
  assert.deepEqual(arranged(nodes, ['s2'], 'forward'), ['p', 's1', 'q', 's2', 'r']);
  assert.deepEqual(arranged(nodes, ['s2'], 'backward'), ['p', 's2', 's1', 'q', 'r']);
  assert.deepEqual(arranged(nodes, ['s1'], 'front'), ['p', 's2', 'q', 'r', 's1']);
  assert.equal(arrangeLayers(nodes, ['s1'], 'backward').size, 0);
  assert.equal(arrangeLayers(nodes, ['s1'], 'back').size, 0);
  // Every result renders exactly in its stored order.
  for (const action of ['front', 'forward', 'backward', 'back']) {
    const next = apply(nodes, arrangeLayers(nodes, ['q', 's2'], action));
    assert.deepEqual(ids(next), [...next].sort((a, b) => a.z - b.z).map(node => node.id));
  }
});

test('Figma layer shortcuts map brackets, with physical keys on other layouts', () => {
  const key = (key, extra = {}) => layerShortcut({ key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
  assert.equal(key(']'), 'front'); assert.equal(key('['), 'back');
  assert.equal(key(']', { metaKey: true }), 'forward'); assert.equal(key('[', { ctrlKey: true }), 'backward');
  assert.equal(key('ї', { code: 'BracketRight' }), 'front'); assert.equal(key('х', { code: 'BracketLeft', metaKey: true }), 'backward');
  assert.equal(key('}', { code: 'BracketRight', shiftKey: true }), null); assert.equal(key('a'), null);
  // AltGr layouts type brackets with Ctrl+Alt; that is the plain shortcut.
  assert.equal(key('[', { ctrlKey: true, altKey: true }), 'back');
});

test('layers round-trip through cloud documents and replicas render the same order', () => {
  const a = new Y.Doc(), b = new Y.Doc(), empty = { nodes: [], edges: [], groups: [], runs: [] };
  applyLocalGraph(a, { ...empty, nodes: [sticky('note', 2), stamp('mark', 1, 'note'), text('legacy')] }, empty, 'seed');
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const before = readCloudGraph(b);
  assert.deepEqual(before.nodes.map(node => [node.id, node.z]), [['legacy', undefined], ['mark', 1], ['note', 2]]);
  assert.deepEqual(ids(before.nodes), ['legacy', 'note', 'mark']);
  const next = { ...before, nodes: apply(before.nodes, arrangeLayers(before.nodes, ['legacy'], 'front')) };
  applyLocalGraph(b, next, before, 'b'); Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  assert.deepEqual(ids(readCloudGraph(a).nodes), ['note', 'mark', 'legacy']);
  assert.deepEqual(readCloudGraph(a), readCloudGraph(b));
  // Removing a layer deletes the field; a stale local copy or an invalid remote value never leaks in.
  const cleared = readCloudGraph(a); delete cleared.nodes.find(node => node.id === 'legacy').z;
  applyLocalGraph(a, cleared, readCloudGraph(a), 'a');
  assert.equal(readCloudGraph(a, { nodes: [{ id: 'legacy', z: 99 }] }).nodes.find(node => node.id === 'legacy').z, undefined);
  a.getMap('nodes').get('note').set('z', 1e12);
  assert.doesNotThrow(() => validateGraph(readCloudGraph(a)));
  assert.equal(Object.hasOwn(readCloudGraph(a).nodes.find(node => node.id === 'note'), 'z'), false);
});
