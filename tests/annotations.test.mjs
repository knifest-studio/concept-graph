import test from 'node:test';
import assert from 'node:assert/strict';
import { collectInputs, imageNode, nodeSize, validateGraph } from '../graph.mjs';
import { annotationSize, authorInitials, boardAuthor, contrastColor, drawingFromStroke, imageAuthor, simplifyStroke, stamps, strokePath } from '../src/annotations.mjs';
import { alignNodes, canvasView, cleanGroups, edgeDropCreatesPrompt, groupBounds, mergeAddedGroups } from '../src/canvas.mjs';
import { selectedGraph, readNodeClipboard, cloneSelection } from '../src/clipboard.mjs';

const prompt = { id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: 'Generate a cloud' } };
const nodes = () => [
  { id: 'd', ...drawingFromStroke([[-10, 20], [0, 30], [10, 20]], '#2563eb', 4) },
  { id: 's', type: 'sticky', position: { x: 100, y: -300 }, data: { text: 'A note', color: '#fff3ad', author: { name: 'Ada Lovelace', color: '#2563eb' } } },
  { id: 'e', type: 'stamp', position: { x: -50, y: 10 }, data: { kind: 'heart' } },
];
const graph = () => ({ nodes: [structuredClone(prompt), ...nodes()], edges: [], groups: [] });

test('annotation validation bounds point counts, geometry, colors, text, kinds and hidden metadata', () => {
  assert.doesNotThrow(() => validateGraph(graph()));
  const invalid = [
    ['d', { points: [] }], ['d', { points: Array(1001).fill([0, 0]) }], ['d', { points: [[NaN, 0]] }], ['d', { points: [[0, Infinity]] }],
    ['d', { points: [[-1, 0]] }], ['d', { points: [[100001, 0]] }], ['d', { points: [[0, 0, 1]] }], ['d', { points: [['0', 0]] }],
    ['d', { width: 0 }], ['d', { width: 25 }], ['d', { width: '4' }], ['d', { color: '#fff' }],
    ['s', { text: 'x'.repeat(10001) }], ['s', { text: 1 }], ['s', { color: 'red' }], ['s', { color: null }],
    ['e', { kind: 'wow' }], ['e', { kind: '__proto__' }], ['e', { kind: ['star'] }], ['e', { kind: null }],
    ['s', { template: { instructions: 'Should not become generation context', assets: [] } }], ['e', { runId: 'r' }], ['d', { collapsed: true }],
  ];
  for (const [id, patch] of invalid) {
    const value = graph(); Object.assign(value.nodes.find(node => node.id === id).data, patch);
    assert.throws(() => validateGraph(value), /Invalid/, `${id}: ${JSON.stringify(patch).slice(0, 100)}`);
  }
  const limits = graph(); limits.nodes[1].data.points = Array(1000).fill([100000, 0]); limits.nodes[2].data.text = 'x'.repeat(10000);
  assert.doesNotThrow(() => validateGraph(limits));
  for (const kind of Object.keys(stamps)) { const value = graph(); value.nodes[3].data.kind = kind; assert.doesNotThrow(() => validateGraph(value)); }
});

test('annotations never become generation inputs or connection endpoints', () => {
  const value = graph(); assert.deepEqual(collectInputs(value, 'p').snapshot, [prompt]);
  for (const node of value.nodes.slice(1)) {
    assert.throws(() => collectInputs(value, node.id), /prompt/);
    for (const [source, target] of [[node.id, 'p'], ['p', node.id]]) assert.throws(() => validateGraph({ ...value, edges: [{ id: 'edge', source, target }] }), /Annotations/);
    assert.equal(edgeDropCreatesPrompt({ isValid: false, fromNode: node, fromHandle: { type: 'source' } }, true), false);
  }
});

test('stroke simplification preserves endpoints and corners, caps long gestures and normalizes bounds', () => {
  const line = Array.from({ length: 5000 }, (_, i) => [i, i]);
  assert.deepEqual(simplifyStroke(line), [[0, 0], [4999, 4999]]);
  const wave = Array.from({ length: 5000 }, (_, i) => [i, (i % 2) * 50]), simplified = simplifyStroke(wave);
  assert.equal(simplified.length, 1000); assert.deepEqual(simplified[0], wave[0]); assert.deepEqual(simplified.at(-1), wave.at(-1));
  const corners = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]];
  assert.deepEqual(simplifyStroke(corners), [[0, 0], [10, 0], [10, 10]]);
  const node = { id: 'stroke', ...drawingFromStroke([[-50, 100], [-40, 130], [20, 110]], '#8b5cf6', 8) };
  assert.deepEqual(node.position, { x: -56, y: 94 });
  assert.deepEqual(nodeSize(node), annotationSize(node));
  assert.doesNotThrow(() => validateGraph({ nodes: [node], edges: [] }));
  assert.match(strokePath(node.data.points), /Q/); assert.equal(strokePath([]), ''); assert.match(strokePath([[0, 0]]), /l\.01,0/);
  assert.doesNotThrow(() => drawingFromStroke([[20, 30]], '#25243d', 2));
  assert.throws(() => drawingFromStroke([[0, 0], [100001, 0]], '#25243d', 2), /drawing/);
});

test('author snapshots strip email, prefer saved image authors and derive legacy run authors', () => {
  const by = { name: ' Ada Lovelace ', color: '#2563eb', email: 'private@example.com', id: 'private-account' };
  const author = { name: 'Ada Lovelace', color: '#2563eb' };
  assert.deepEqual(boardAuthor(by), author); assert.equal(authorInitials(author), 'AL');
  assert.equal(contrastColor('#ffffff'), '#25243d'); assert.equal(contrastColor('#000000'), '#ffffff');
  const run = { id: 'r', by, target: prompt }, asset = '12345678-1234-1234-1234-123456789abc.png';
  const image = imageNode(run, asset, 0);
  assert.deepEqual(image.data.author, author); by.name = 'Changed'; assert.equal(image.data.author.name, 'Ada Lovelace');
  assert.deepEqual(imageAuthor({ runId: 'r' }, [run]), { name: 'Changed', color: '#2563eb' });
  assert.deepEqual(imageAuthor(image.data, [run]), author);
  assert.equal(imageNode({ id: 'local', target: prompt }, asset, 0).data.author, undefined);
  assert.equal(imageAuthor({ runId: 'missing' }, [run]), undefined);
  assert.equal(boardAuthor({ name: 'private@example.com' }), undefined);
  for (const invalid of [{ ...author, email: 'private@example.com' }, { name: '' }, { name: 'private@example.com' }, { name: 'x'.repeat(81) }, { name: ' Ada ' }, { name: 'Ada', color: 'red' }]) {
    assert.throws(() => validateGraph({ nodes: [{ ...image, data: { ...image.data, author: invalid } }], edges: [] }), /author/);
  }
});

test('group fills validate, survive snapshots, collapse and revision merges without overwriting local edits', () => {
  const value = graph(), group = { id: 'g', name: 'Notes', nodeIds: ['p', 's'], collapsed: false, color: '#ffe5d5' };
  value.groups = [group]; assert.doesNotThrow(() => validateGraph(value));
  assert.deepEqual(cleanGroups([{ ...group, selected: true }]), [group]);
  for (const color of ['', null, 'red', '#abc', '#abcdef00', 3]) assert.throws(() => validateGraph({ ...value, groups: [{ ...group, color }] }), /group/);
  for (const collapsed of [false, true]) assert.equal(canvasView(value.nodes, [], [{ ...group, collapsed }]).nodes[0].data.color, group.color);
  const remote = { ...group, color: '#dceaff', name: 'Renamed' };
  assert.deepEqual(mergeAddedGroups([group], [remote], [group], value.nodes), [remote]);
  const edited = { ...group, color: '#111111' };
  assert.deepEqual(mergeAddedGroups([edited], [remote], [group], value.nodes), [{ ...edited, name: remote.name }]);
  const reset = { ...remote }; delete reset.color;
  assert.equal(Object.hasOwn(mergeAddedGroups([remote], [reset], [remote], value.nodes)[0], 'color'), false);
});

test('annotation clipboard duplication, grouping, bounds, layer order and alignment preserve content', () => {
  const value = graph(); value.nodes.forEach(node => node.selected = true);
  const copied = readNodeClipboard(JSON.stringify(selectedGraph(value.nodes, value.edges))), duplicated = cloneSelection(copied);
  assert.deepEqual(duplicated.nodes.map(node => node.type), value.nodes.map(node => node.type));
  assert.deepEqual(duplicated.nodes.map(node => node.data.points), value.nodes.map(node => node.data.points));
  const group = { id: 'g', name: 'All', collapsed: false, nodeIds: value.nodes.map(node => node.id) };
  const aligned = alignNodes(value.nodes, [], [group]);
  for (const node of nodes()) assert.deepEqual(aligned.find(item => item.id === node.id).position, node.position);
  assert.deepEqual(alignNodes(nodes(), [], []), nodes());
  const view = canvasView(value.nodes, [], [group]);
  assert.ok(view.nodes.filter(node => ['drawing', 'sticky', 'stamp'].includes(node.type)).every(node => node.zIndex > view.nodes.find(node => node.id === 'p').zIndex));
  assert.ok(Number.isFinite(groupBounds(group, value.nodes).height));
  assert.deepEqual(nodeSize(nodes()[1]), { width: 200, height: 200 }); assert.deepEqual(nodeSize(nodes()[2]), { width: 48, height: 48 });
});
