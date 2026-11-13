import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { duplicateNodes, templateSnapshot, validateGraph } from '../graph.mjs';
import { drawingFromStroke } from '../src/annotations.mjs';

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

test('main-image promotion syncs with its edge in one transaction and undo restores both', () => {
  const a = new Y.Doc(), b = new Y.Doc(), origin = {}, asset = '11111111-1111-1111-1111-111111111111.png';
  const graph = { ...empty(), nodes: [{ ...node('p'), data: { text: 'Edit', generator: 'gpt-image' } }, { id: 'i', type: 'image', position: { x: 0, y: 0 }, data: { asset } }] };
  applyLocalGraph(a, graph, empty(), 'seed'); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const undo = new Y.UndoManager([a.getMap('nodes'), a.getMap('edges')], { trackedOrigins: new Set([origin]) });
  try {
    const next = structuredClone(graph); next.nodes[0].data.mainImage = 'i'; next.edges.push({ id: 'ip', source: 'i', target: 'p' });
    applyLocalGraph(a, next, graph, origin); exchange(a, b);
    let shown = readCloudGraph(b); assert.equal(shown.nodes.find(node => node.id === 'p').data.mainImage, 'i'); assert.deepEqual(shown.edges, next.edges);
    assert.deepEqual(a.getMap('edges').get('ip'), { source: 'i', target: 'p' });
    undo.undo(); exchange(a, b); shown = readCloudGraph(b);
    assert.equal(shown.nodes.find(node => node.id === 'p').data.mainImage, undefined); assert.equal(shown.edges.length, 0);
    undo.redo(); exchange(a, b); assert.equal(readCloudGraph(b).nodes.find(node => node.id === 'p').data.mainImage, 'i');
  } finally { undo.destroy(); a.destroy(); b.destroy(); }
});

test('crop and mask fields sync without stripping and a single transaction undoes the edit and its new prompt together', () => {
  const a = new Y.Doc(), b = new Y.Doc(), asset = '11111111-1111-1111-1111-111111111111.png';
  const graph = { ...empty(), nodes: [{ id: 'image', type: 'image', position: { x: 0, y: 0 }, data: { asset, caption: 'Storm' } }] };
  applyLocalGraph(a, graph, empty(), 'seed'); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const origin = {}, undo = new Y.UndoManager([a.getMap('nodes'), a.getMap('edges')], { trackedOrigins: new Set([origin]) });
  const next = structuredClone(graph);
  next.nodes[0].data.mask = { asset, marked: asset, base: asset, source: asset };
  next.nodes[0].data.uncropped = { asset, pixels: { width: 10, height: 10 }, rect: { x: 1, y: 1, width: 8, height: 8 } };
  next.nodes.push(node('p')); next.edges.push({ id: 'ip', source: 'image', target: 'p' });
  applyLocalGraph(a, next, graph, origin); exchange(a, b); validateGraph(readCloudGraph(b));
  assert.deepEqual(readCloudGraph(b).nodes.find(node => node.id === 'image').data, next.nodes[0].data);
  undo.undo(); exchange(a, b); assert.equal(readCloudGraph(a).nodes.length, 1); assert.equal(readCloudGraph(b).edges.length, 0);
  assert.equal(readCloudGraph(b).nodes[0].data.mask, undefined); assert.equal(readCloudGraph(b).nodes[0].data.uncropped, undefined);
  undo.redo(); exchange(a, b); assert.deepEqual(readCloudGraph(b).nodes.find(node => node.id === 'image').data.mask, next.nodes[0].data.mask);
  undo.destroy(); a.destroy(); b.destroy();
});

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

test('group fill merges independently, resets on every replica and supports local undo', () => {
  const { a, b } = pair();
  let before = readCloudGraph(a), grouped = structuredClone(before);
  grouped.groups = [{ id: 'g', name: 'Before', collapsed: false, nodeIds: ['n', 'other'] }];
  applyLocalGraph(a, grouped, before, 'seed'); exchange(a, b);
  before = readCloudGraph(a);
  const left = structuredClone(before), right = structuredClone(before), origin = {};
  const undo = new Y.UndoManager(a.getMap('groups'), { trackedOrigins: new Set([origin]) });
  left.groups[0].color = '#e9e2ff'; right.groups[0].name = 'Remote name'; right.groups[0].collapsed = true;
  applyLocalGraph(a, left, before, origin); applyLocalGraph(b, right, before, 'remote'); exchange(a, b);
  assert.deepEqual(readCloudGraph(a).groups[0], { ...left.groups[0], name: 'Remote name', collapsed: true });
  undo.undo(); exchange(a, b);
  assert.equal(Object.hasOwn(readCloudGraph(a, { groups: left.groups }).groups[0], 'color'), false);
  assert.equal(readCloudGraph(a).groups[0].name, 'Remote name'); assert.equal(readCloudGraph(a).groups[0].collapsed, true);
  undo.redo(); exchange(a, b); assert.equal(readCloudGraph(a).groups[0].color, '#e9e2ff');
  before = readCloudGraph(a); const reset = structuredClone(before); delete reset.groups[0].color;
  applyLocalGraph(b, reset, before, 'reset'); exchange(a, b); assert.equal(Object.hasOwn(readCloudGraph(a).groups[0], 'color'), false);
  undo.destroy(); a.destroy(); b.destroy();
});

test('annotations and author metadata sync, undo, duplicate and reject concurrent annotation edges', () => {
  const { a, b, before } = pair(), origin = {}, undo = new Y.UndoManager([a.getMap('nodes'), a.getMap('groups')], { trackedOrigins: new Set([origin]) });
  const graph = structuredClone(before), author = { name: 'Artist', color: '#2563eb' };
  graph.nodes.push({ id: 'drawing', ...drawingFromStroke([[10, 20], [100, 200]], '#2563eb', 4) },
    { id: 'sticky', type: 'sticky', position: { x: 10, y: 20 }, data: { text: 'Note', color: '#fff3ad', author } },
    { id: 'stamp', type: 'stamp', position: { x: 100, y: 200 }, data: { kind: 'like', author } });
  graph.groups.push({ id: 'g', name: 'Notes', collapsed: false, color: '#dceaff', nodeIds: ['drawing', 'sticky', 'stamp'] });
  applyLocalGraph(a, graph, before, origin); exchange(a, b); assert.deepEqual(readCloudGraph(b).nodes.find(node => node.id === 'sticky').data.author, author);
  assert.doesNotThrow(() => validateGraph(readCloudGraph(a)));
  const reloaded = new Y.Doc(); Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(a)); assert.deepEqual(readCloudGraph(reloaded), readCloudGraph(a)); reloaded.destroy();
  undo.undo(); exchange(a, b); assert.deepEqual(readCloudGraph(a), before);
  undo.redo(); exchange(a, b);
  const base = readCloudGraph(a), edited = structuredClone(base); edited.nodes.find(node => node.id === 'sticky').position.x = 500;
  const copied = duplicateNodes(base, ['drawing', 'sticky', 'stamp']); edited.nodes.push(...copied.nodes);
  applyLocalGraph(a, edited, base, origin); exchange(a, b);
  assert.equal(readCloudGraph(b).nodes.find(node => node.id === 'sticky').position.x, 500);
  for (const [id, source, target] of [['a', 'drawing', 'n'], ['b', 'n', 'stamp'], ['c', 'sticky', 'stamp']]) a.getMap('edges').set(id, { source, target });
  exchange(a, b); assert.deepEqual(readCloudGraph(a).edges, before.edges);
  assert.doesNotThrow(() => validateGraph(readCloudGraph(a)));
  undo.destroy(); a.destroy(); b.destroy();
});

function stampPair() {
  const a = new Y.Doc(), b = new Y.Doc();
  a.clientID = 400; b.clientID = 200;
  const graph = { ...empty(), nodes: [
    { ...node('parent'), position: { x: 100, y: 100 } }, { ...node('other'), position: { x: 800, y: 0 } },
    { id: 'stamp', type: 'stamp', position: { x: 120, y: 130 }, data: { kind: 'heart', attachedTo: 'parent' } },
  ], groups: [{ id: 'g', name: 'Stamps', collapsed: false, nodeIds: ['stamp'] }] };
  applyLocalGraph(a, graph, empty(), 'seed'); Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return { a, b, before: readCloudGraph(a) };
}

test('cloud parent moves and direct stamp moves merge as relative offsets and undo independently', () => {
  const { a, b, before } = stampPair(), origin = {}, undo = new Y.UndoManager(a.getMap('nodes'), { trackedOrigins: new Set([origin]) });
  const parentMove = structuredClone(before), stampMove = structuredClone(before);
  parentMove.nodes.find(node => node.id === 'parent').position = { x: 200, y: 50 };
  stampMove.nodes.find(node => node.id === 'stamp').position = { x: 130, y: 150 };
  applyLocalGraph(a, parentMove, before, origin); applyLocalGraph(b, stampMove, before, 'remote'); exchange(a, b);
  assert.deepEqual(readCloudGraph(a).nodes.find(node => node.id === 'stamp').position, { x: 230, y: 100 });
  assert.deepEqual(a.getMap('nodes').get('stamp').get('stampAttachment'), { nodeId: 'parent', x: 30, y: 50 });
  undo.undo(); exchange(a, b);
  assert.deepEqual(readCloudGraph(a).nodes.find(node => node.id === 'stamp').position, { x: 130, y: 150 });
  undo.redo(); exchange(a, b);
  assert.deepEqual(readCloudGraph(a).nodes.find(node => node.id === 'stamp').position, { x: 230, y: 100 });
  assert.doesNotThrow(() => validateGraph(readCloudGraph(a))); undo.destroy(); a.destroy(); b.destroy();
});

test('cloud reattachment wins independently of the old parent moving and survives persisted Yjs snapshots', () => {
  const { a, b, before } = stampPair(), parentMove = structuredClone(before), reattached = structuredClone(before);
  parentMove.nodes.find(node => node.id === 'parent').position.x += 200;
  const stamp = reattached.nodes.find(node => node.id === 'stamp'); stamp.data.attachedTo = 'other'; stamp.position = { x: 810, y: 20 };
  applyLocalGraph(a, parentMove, before, 'move'); applyLocalGraph(b, reattached, before, 'reattach'); exchange(a, b);
  let graph = readCloudGraph(a); assert.equal(graph.nodes.find(node => node.id === 'stamp').data.attachedTo, 'other');
  assert.deepEqual(graph.nodes.find(node => node.id === 'stamp').position, { x: 810, y: 20 });
  const moved = structuredClone(graph); moved.nodes.find(node => node.id === 'other').position = { x: 900, y: 200 };
  applyLocalGraph(a, moved, graph, 'move-new-parent'); exchange(a, b);
  graph = readCloudGraph(a); assert.deepEqual(graph.nodes.find(node => node.id === 'stamp').position, { x: 910, y: 220 });
  const reloaded = new Y.Doc(); Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(a)); assert.deepEqual(readCloudGraph(reloaded), graph);
  assert.doesNotThrow(() => validateGraph(graph)); reloaded.destroy(); a.destroy(); b.destroy();
});

test('cloud detachment preserves the drop position during a concurrent parent move and after earlier parent moves', () => {
  const { a, b, before } = stampPair(), parentMove = structuredClone(before), detached = structuredClone(before);
  parentMove.nodes.find(node => node.id === 'parent').position = { x: 300, y: 50 };
  const stamp = detached.nodes.find(node => node.id === 'stamp'); delete stamp.data.attachedTo; stamp.position = { x: -200, y: -300 };
  applyLocalGraph(a, parentMove, before, 'move'); applyLocalGraph(b, detached, before, 'detach'); exchange(a, b);
  assert.deepEqual(readCloudGraph(a).nodes.find(node => node.id === 'stamp').position, stamp.position);
  const base = readCloudGraph(a), attached = structuredClone(base); attached.nodes.find(node => node.id === 'stamp').data.attachedTo = 'parent';
  applyLocalGraph(a, attached, base, 'attach'); exchange(a, b);
  const old = readCloudGraph(a), moved = structuredClone(old); moved.nodes.find(node => node.id === 'parent').position.x += 100;
  applyLocalGraph(a, moved, old, 'move-again'); exchange(a, b);
  const last = readCloudGraph(b), drop = structuredClone(last); delete drop.nodes.find(node => node.id === 'stamp').data.attachedTo;
  const position = drop.nodes.find(node => node.id === 'stamp').position;
  applyLocalGraph(b, drop, last, 'detach-in-place'); exchange(a, b);
  assert.deepEqual(readCloudGraph(a).nodes.find(node => node.id === 'stamp').position, position);
  a.destroy(); b.destroy();
});

test('parent deletion removes known cloud stamps while a concurrent late stamp detaches and remains editable', () => {
  const { a, b, before } = stampPair(), origin = {}, undo = new Y.UndoManager([a.getMap('nodes'), a.getMap('groups')], { trackedOrigins: new Set([origin]) });
  const deleted = structuredClone(before), late = structuredClone(before);
  deleted.nodes = deleted.nodes.filter(node => node.id !== 'parent');
  late.nodes.push({ id: 'late-stamp', type: 'stamp', position: { x: 159, y: 160 }, data: { kind: 'star', attachedTo: 'parent' } });
  applyLocalGraph(a, deleted, before, origin); applyLocalGraph(b, late, before, 'late'); exchange(a, b);
  const detached = readCloudGraph(b), stamp = detached.nodes.find(node => node.id === 'late-stamp');
  assert.deepEqual(detached.nodes.map(node => node.id), ['late-stamp', 'other']); assert.deepEqual(detached.groups, []);
  assert.equal(Object.hasOwn(stamp.data, 'attachedTo'), false); assert.deepEqual(stamp.position, { x: 159, y: 160 });
  assert.doesNotThrow(() => validateGraph(detached));
  const edited = structuredClone(detached); edited.nodes.find(node => node.id === 'late-stamp').position = { x: 500, y: 600 };
  applyLocalGraph(b, edited, detached, 'move-detached'); exchange(a, b);
  assert.deepEqual(readCloudGraph(a).nodes.find(node => node.id === 'late-stamp').position, { x: 500, y: 600 });
  assert.equal(b.getMap('nodes').get('late-stamp').get('data').has('attachedTo'), false);
  undo.undo(); exchange(a, b);
  assert.equal(readCloudGraph(a).nodes.find(node => node.id === 'stamp').data.attachedTo, 'parent');
  assert.equal(Object.hasOwn(readCloudGraph(a).nodes.find(node => node.id === 'late-stamp').data, 'attachedTo'), false);
  undo.redo(); exchange(a, b); assert.deepEqual(readCloudGraph(a).nodes.map(node => node.id), ['late-stamp', 'other']);
  undo.destroy(); a.destroy(); b.destroy();
});

test('slideshow fields sync between replicas and clear everywhere', () => {
  const { a, b } = pair();
  let before = readCloudGraph(a), next = structuredClone(before);
  next.groups = [{ id: 'g', name: 'Run', collapsed: true, slideshow: true, slide: 'other', nodeIds: ['n', 'other'] }];
  applyLocalGraph(a, next, before, 'seed'); exchange(a, b);
  assert.deepEqual(readCloudGraph(b).groups[0], next.groups[0]);
  before = readCloudGraph(b); next = structuredClone(before);
  delete next.groups[0].slideshow; delete next.groups[0].slide;
  applyLocalGraph(b, next, before, 'remote'); exchange(a, b);
  const shown = readCloudGraph(a, { groups: [{ id: 'g', name: 'Run', collapsed: true, slideshow: true, slide: 'other', nodeIds: ['n', 'other'] }] }).groups[0];
  assert.equal(Object.hasOwn(shown, 'slideshow'), false); assert.equal(Object.hasOwn(shown, 'slide'), false);
});
