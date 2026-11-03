import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { duplicateNodes, templateSnapshot } from '../graph.mjs';

const empty = () => ({ nodes: [], edges: [], groups: [], runs: [] });
const node = id => ({ id, type: 'text', position: { x: 0, y: 0 }, data: { text: 'Before', model: 'default', collapsed: false } });
function pair() {
  const a = new Y.Doc(), b = new Y.Doc();
  applyLocalGraph(a, { ...empty(), nodes: [node('n'), node('other')], edges: [{ id: 'e', source: 'n', target: 'other' }] }, empty(), 'seed');
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return { a, b, before: readCloudGraph(a) };
}
function exchange(a, b) {
  const left = Y.encodeStateAsUpdate(a), right = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(a, right); Y.applyUpdate(b, left);
  assert.deepEqual(readCloudGraph(a), readCloudGraph(b));
}

test('two disconnected documents merge different node fields and group fields', () => {
  const { a, b, before } = pair();
  const first = structuredClone(before), second = structuredClone(before);
  first.nodes[0].data.text = 'Artist A'; second.nodes[0].data.model = 'artist-b';
  applyLocalGraph(a, first, before, 'a'); applyLocalGraph(b, second, before, 'b'); exchange(a, b);
  assert.deepEqual(readCloudGraph(a).nodes[0].data, { text: 'Artist A', model: 'artist-b', collapsed: false });
  const grouped = readCloudGraph(a);
  grouped.groups = [{ id: 'g', name: 'Group', collapsed: false, nodeIds: ['n', 'other'] }];
  applyLocalGraph(a, grouped, readCloudGraph(a), 'a'); exchange(a, b);
  const base = readCloudGraph(a), left = structuredClone(base), right = structuredClone(base);
  left.groups[0].name = 'Renamed'; right.groups[0].collapsed = true;
  applyLocalGraph(a, left, base, 'a'); applyLocalGraph(b, right, base, 'b'); exchange(a, b);
  assert.equal(readCloudGraph(a).groups[0].name, 'Renamed'); assert.equal(readCloudGraph(a).groups[0].collapsed, true);
  a.destroy(); b.destroy();
});

test('delete wins over a concurrent nested edit, including a stale edit after receiving deletion', () => {
  const { a, b, before } = pair(), deleted = structuredClone(before), edited = structuredClone(before);
  deleted.nodes.shift(); deleted.edges = []; edited.nodes[0].data.text = 'Too late';
  applyLocalGraph(a, deleted, before, 'a'); applyLocalGraph(b, edited, before, 'b'); exchange(a, b);
  applyLocalGraph(b, edited, before, 'b'); exchange(a, b);
  assert.deepEqual(readCloudGraph(a).nodes.map(node => node.id), ['other']); assert.deepEqual(readCloudGraph(a).edges, []);
  a.destroy(); b.destroy();
});

test('drag positions sync without replacing data and preserve local React Flow props', () => {
  const { a, b, before } = pair(), dragged = structuredClone(before), edited = structuredClone(before);
  dragged.nodes[0].position = { x: 321, y: -90 }; edited.nodes[0].data.text = 'While dragging';
  applyLocalGraph(a, dragged, before, 'a'); applyLocalGraph(b, edited, before, 'b'); exchange(a, b);
  const local = structuredClone(before); Object.assign(local.nodes[0], { selected: true, dragging: true, measured: { width: 310, height: 160 } });
  const graph = readCloudGraph(b, local);
  assert.deepEqual(graph.nodes[0].position, { x: 321, y: -90 }); assert.equal(graph.nodes[0].data.text, 'While dragging');
  assert.equal(graph.nodes[0].selected, true); assert.equal(graph.nodes[0].dragging, true); assert.deepEqual(graph.nodes[0].measured, { width: 310, height: 160 });
  assert.equal(a.getMap('nodes').get('n').has('selected'), false);
  a.destroy(); b.destroy();
});

test('stale snapshots preserve remote additions and untouched fields; no-op emits no update', () => {
  const { a, b, before } = pair(), left = structuredClone(before), right = structuredClone(before);
  right.nodes.push(node('remote')); right.nodes[0].data.effort = 'high';
  applyLocalGraph(b, right, before, 'b'); Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  left.nodes[0].position.x = 50; applyLocalGraph(a, left, before, 'a'); exchange(a, b);
  assert.equal(readCloudGraph(a).nodes.length, 3); assert.equal(readCloudGraph(a).nodes[0].data.effort, 'high');
  let updates = 0; a.on('update', () => updates++);
  const graph = readCloudGraph(a); graph.nodes[0].selected = true;
  applyLocalGraph(a, graph, readCloudGraph(a), 'a'); assert.equal(updates, 0);
  a.destroy(); b.destroy();
});

test('local undo does not undo remote edits or generation summaries', () => {
  const { a, b, before } = pair(), origin = {}, undo = new Y.UndoManager([a.getMap('nodes'), a.getMap('edges'), a.getMap('groups')], { trackedOrigins: new Set([origin]) });
  const left = structuredClone(before), right = structuredClone(before);
  left.nodes[0].data.text = 'Local'; right.nodes[0].data.model = 'Remote';
  applyLocalGraph(a, left, before, origin); applyLocalGraph(b, right, before, 'remote'); exchange(a, b);
  a.getMap('runs').set('r', { id: 'r', nodeId: 'n', status: 'running', startedAt: new Date().toISOString() });
  undo.undo();
  assert.equal(readCloudGraph(a).nodes[0].data.text, 'Before'); assert.equal(readCloudGraph(a).nodes[0].data.model, 'Remote');
  assert.equal(readCloudGraph(a).runs.length, 1); undo.redo(); assert.equal(readCloudGraph(a).nodes[0].data.text, 'Local');
  undo.destroy(); a.destroy(); b.destroy();
});

test('concurrent additions converge in stable order and simultaneous connections cannot expose a cycle', () => {
  const { a, b, before } = pair(), left = structuredClone(before), right = structuredClone(before);
  left.nodes.push(node('a-new')); right.nodes.push(node('b-new'));
  left.edges = []; right.edges = [];
  applyLocalGraph(a, left, before, 'a'); applyLocalGraph(b, right, before, 'b'); exchange(a, b);
  const graph = readCloudGraph(a), forward = structuredClone(graph), reverse = structuredClone(graph);
  forward.edges.push({ id: 'forward', source: 'n', target: 'other' });
  reverse.edges.push({ id: 'reverse', source: 'other', target: 'n' });
  applyLocalGraph(a, forward, graph, 'a'); applyLocalGraph(b, reverse, graph, 'b'); exchange(a, b);
  assert.equal(readCloudGraph(a).edges.length, 1);
  a.destroy(); b.destroy();
});

test('duplication syncs parent edges, timestamps and template colour in one undoable cloud edit', () => {
  const { a, b, before } = pair(), origin = {}, undo = new Y.UndoManager([a.getMap('nodes'), a.getMap('edges')], { trackedOrigins: new Set([origin]) });
  const initial = structuredClone(before);
  initial.nodes[1].data.template = templateSnapshot({ name: 'Views', instructions: 'Front', assets: [], color: '#0f766e' });
  applyLocalGraph(a, initial, before, 'seed'); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const copies = duplicateNodes(initial, ['other']), graph = { ...initial, nodes: [...initial.nodes, ...copies.nodes], edges: [...initial.edges, ...copies.edges] };
  applyLocalGraph(a, graph, initial, origin); exchange(a, b);
  const copy = readCloudGraph(b).nodes.find(node => node.id === copies.nodes[0].id);
  assert.equal(copy.data.template.color, '#0f766e'); assert.ok(copy.data.createdAt);
  assert.ok(readCloudGraph(b).edges.some(edge => edge.source === 'n' && edge.target === copy.id));
  undo.undo(); exchange(a, b); assert.deepEqual(readCloudGraph(a), initial);
  undo.redo(); exchange(a, b); assert.equal(readCloudGraph(b).nodes.length, 3);
  undo.destroy(); a.destroy(); b.destroy();
});
