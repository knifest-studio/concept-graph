import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasView, alignNodes, moveGroup, groupBounds, pruneGroups, connectionColor } from '../src/canvas.mjs';
import { validateGraph, collectInputs } from '../graph.mjs';

const text = (id, x, y) => ({ id, type: 'text', position: { x, y }, data: { text: id }, measured: { width: 310, height: 170 } });
const image = (id, x, y) => ({ id, type: 'image', position: { x, y }, data: { asset: '12345678-1234-1234-1234-123456789abc.png' }, measured: { width: 310, height: 620 } });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target });
const group = (nodeIds, collapsed = true) => ({ id: 'group', name: 'Group 1', nodeIds, collapsed });

test('folding preserves generation inputs and routes visible connections through the group', () => {
  const nodes = [text('a', 0, 0), image('b', 400, 0), text('c', 800, 0)];
  const edges = [edge('a', 'b'), edge('b', 'c')], groups = [group(['a', 'b'])];
  const before = structuredClone({ nodes, edges, groups });
  const folded = canvasView(nodes, edges, groups);
  assert.ok(folded.nodes.find(node => node.id === 'a').hidden);
  assert.ok(folded.edges[0].hidden);
  assert.equal(folded.edges[1].source, 'group');
  assert.equal(folded.edges[1].target, 'c');
  assert.equal(folded.edges[1].style.stroke, 'var(--purple)');
  assert.equal(connectionColor('text'), 'var(--blue)');
  assert.deepEqual(collectInputs({ nodes, edges, groups }, 'c'), collectInputs({ nodes, edges }, 'c'));
  assert.deepEqual({ nodes, edges, groups }, before);
  const expanded = canvasView(nodes, edges, [{ ...groups[0], collapsed: false }]);
  assert.ok(expanded.nodes.filter(node => node.type !== 'group').every(node => !node.hidden));
  assert.deepEqual(expanded.edges.map(({ source, target }) => ({ source, target })), edges.map(({ source, target }) => ({ source, target })));
});

test('moving or aligning groups preserves member offsets, content and edges without overlaps', () => {
  const nodes = [text('a', 90, 50), image('b', 480, 60), text('c', 300, 10), image('d', 80, 20)];
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('d', 'c')];
  for (const collapsed of [false, true]) {
    const groups = [group(['a', 'b'], collapsed)];
    const moved = moveGroup(nodes, groups[0], { x: 200, y: 300 });
    assert.equal(moved[1].position.x - moved[0].position.x, 390);
    assert.equal(moved[1].position.y - moved[0].position.y, 10);
    assert.deepEqual(moved[2], nodes[2]);
    const aligned = alignNodes(nodes, edges, groups);
    assert.equal(aligned[1].position.x - aligned[0].position.x, 390);
    assert.equal(aligned[1].position.y - aligned[0].position.y, 10);
    assert.deepEqual(aligned.map(node => node.data), nodes.map(node => node.data));
    const view = canvasView(aligned, edges, groups).nodes.filter(node => !node.hidden && !groups[0].nodeIds.includes(node.id));
    const rects = view.map(node => ({ ...node.position, ...(node.type === 'group' ? node.style : node.measured) }));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    }
    assert.deepEqual(alignNodes(aligned, edges, groups), aligned);
  }
});

test('grouped display cycles remain finite; removing members never removes surviving nodes', () => {
  const nodes = [text('a', 0, 0), image('b', 300, 0), text('c', 600, 0)];
  const groups = [group(['a', 'c'])], edges = [edge('a', 'b'), edge('b', 'c')];
  const aligned = alignNodes(nodes, edges, groups);
  assert.ok(aligned.every(node => Number.isFinite(node.position.x) && Number.isFinite(node.position.y)));
  assert.deepEqual(pruneGroups(groups, [nodes[0]]), [group(['a'])]);
  assert.deepEqual(pruneGroups(groups, []), []);
  assert.equal(groupBounds(groups[0], nodes).x, -24);
});

test('saved groups reject missing, duplicate, nested and multiply grouped nodes', () => {
  const nodes = [text('a', 0, 0), text('b', 0, 0)], graph = { nodes, edges: [] };
  assert.equal(validateGraph({ ...graph, groups: [group(['a', 'b'])] }).groups.length, 1);
  for (const groups of [[group(['missing'])], [group(['a', 'a'])], [group(['group'])], [group(['a']), { ...group(['a']), id: 'other' }]]) {
    assert.throws(() => validateGraph({ ...graph, groups }), /group/);
  }
});

const assertSeparated = nodes => {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    assert.ok(a.position.x + a.measured.width <= b.position.x || b.position.x + b.measured.width <= a.position.x
      || a.position.y + a.measured.height <= b.position.y || b.position.y + b.measured.height <= a.position.y, `${a.id} overlaps ${b.id}`);
  }
};
const assertCentered = (nodes, parent, children) => {
  const byId = new Map(nodes.map(node => [node.id, node])), p = byId.get(parent), targets = children.map(id => byId.get(id));
  const center = (Math.min(...targets.map(n => n.position.y)) + Math.max(...targets.map(n => n.position.y + n.measured.height))) / 2;
  assert.equal(p.position.y + p.measured.height / 2, center, `${parent} must sit halfway down its children`);
};

test('left-to-right alignment centers parents against children of different heights at every generation', () => {
  const nodes = [text('root', 400, 500), image('a', 10, 20), text('b', 0, 0), image('c', 20, 20),
    text('a1', 70, 90), image('b1', 0, 0), text('b2', 0, 0), text('separate', 20, 30)];
  const edges = [edge('root', 'a'), edge('root', 'b'), edge('root', 'c'), edge('a', 'a1'), edge('b', 'b1'), edge('b', 'b2')];
  const before = structuredClone({ nodes, edges }), result = alignNodes(nodes, edges, []);
  assertCentered(result, 'root', ['a', 'b', 'c']);
  assertCentered(result, 'a', ['a1']);
  assertCentered(result, 'b', ['b1', 'b2']);
  for (const e of edges) {
    const from = result.find(n => n.id === e.source), to = result.find(n => n.id === e.target);
    assert.ok(from.position.x + from.measured.width < to.position.x);
  }
  assertSeparated(result);
  assert.deepEqual({ nodes, edges }, before);
  assert.deepEqual(alignNodes(result, edges, []), result);
});

test('shared references and skipped generations keep every node once, remain separated and center the root', () => {
  const nodes = [text('root', 0, 0), image('reference', 0, 0), text('a', 0, 0), text('b', 0, 0), image('out', 0, 0)];
  const edges = [edge('root', 'reference'), edge('root', 'a'), edge('root', 'b'), edge('reference', 'a'), edge('reference', 'b'), edge('a', 'out'), edge('b', 'out')];
  const result = alignNodes(nodes, edges, []);
  assertCentered(result, 'root', ['reference', 'a', 'b']);
  assertCentered(result, 'reference', ['a', 'b']);
  assertSeparated(result);
  assert.deepEqual(result.map(n => n.id), nodes.map(n => n.id));
  assert.deepEqual(result.map(n => n.data), nodes.map(n => n.data));
  assert.deepEqual(alignNodes(result, edges, []), result);
  for (const e of edges) assert.ok(result.find(n => n.id === e.source).position.x < result.find(n => n.id === e.target).position.x);
  assert.deepEqual(alignNodes([], [], []), []);
});
