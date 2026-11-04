import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasView, createViewCache, visibleTitles, lodHandleProps, estimatedSize, nodeHandles, alignNodes, moveGroup, groupBounds, pruneGroups, connectionColor, freshOutputNodes, mergeAddedGroups, preserveFreshOutputGroups, preserveRemoteImageCaptions, mergeRemoteImageCaptions, restoreFirstImageFallback } from '../src/canvas.mjs';

test('undo restores a neutral first-image caption only for a run that became multi-image after the snapshot', () => {
  const first = caption => ({ id: 'first', type: 'image', data: { runId: 'run', ...(caption === undefined ? {} : { caption }) } });
  const second = { id: 'second', type: 'image', data: { runId: 'run' } };
  const run = { id: 'run', status: 'running', outputIds: ['first', 'second'] };
  const snapshot = { capturedAt: '2026-01-01T12:00:00.000Z', activeRunIds: ['run'] };
  const restore = (nodes = [first()], current = [first('My caption'), second], result = run, point = snapshot) => restoreFirstImageFallback(nodes, current, [result], point);
  assert.equal(restore()[0].data.caption, 'Image 1');
  assert.equal(restore(undefined, undefined, { ...run, status: 'completed', finishedAt: '2026-01-01T12:00:00.000Z' })[0].data.caption, 'Image 1');
  assert.equal(restore(undefined, undefined, { ...run, status: 'cancelled', finishedAt: '2026-01-01T12:00:01.000Z' }, { ...snapshot, activeRunIds: [] })[0].data.caption, 'Image 1');
  assert.equal(restore(undefined, undefined, { ...run, status: 'completed', finishedAt: '2026-01-01T11:59:59.000Z' }, { ...snapshot, activeRunIds: [] })[0].data.caption, undefined);
  assert.equal(restore(undefined, undefined, { ...run, status: 'running', outputIds: ['first'] })[0].data.caption, undefined);
  assert.equal(restore([first('')])[0].data.caption, '');
  assert.equal(restore(undefined, [first(''), second])[0].data.caption, undefined);
  assert.equal(restore([first('Earlier caption')])[0].data.caption, 'Earlier caption');
  assert.equal(restore([second])[0].data.caption, undefined);
  assert.equal(restore(undefined, [second])[0].data.caption, undefined);
});

test('undo preserves only a subsequently merged generation caption, without undoing manual edits', () => {
  const image = caption => ({ id: 'image', type: 'image', data: { runId: 'run', ...(caption === undefined ? {} : { caption }) } });
  const snapshot = [image(undefined)], merged = mergeRemoteImageCaptions(snapshot, [image('Front view')], snapshot);
  assert.notEqual(merged[0], snapshot[0]);
  const changes = new Map([['image', { version: 2, before: undefined, after: 'Front view' }]]);
  const restore = (nodes, current, version = 1) => preserveRemoteImageCaptions(nodes, current, changes, version);
  assert.equal(restore(snapshot, merged)[0].data.caption, 'Front view');
  assert.equal(restore(snapshot, merged, 2)[0].data.caption, undefined);
  assert.equal(restore(snapshot, [image('')])[0].data.caption, undefined);
  assert.equal(restore(snapshot, [image('My caption')])[0].data.caption, undefined);
  assert.equal(restore([image('Earlier caption')], merged)[0].data.caption, 'Earlier caption');
  assert.equal(restore(snapshot, [])[0].data.caption, undefined);
  const localEdit = image('Locally edited');
  assert.equal(mergeRemoteImageCaptions([localEdit], [image('Front view')], snapshot)[0], localEdit);
  assert.equal(preserveRemoteImageCaptions(snapshot, [localEdit], new Map(), 1)[0].data.caption, undefined);
});
import { validateGraph, collectInputs, groupRunOutputs, positionFirstOutput, commitGraph } from '../graph.mjs';

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

test('group bounds make room above captioned images without changing their positions or connections', () => {
  const node = image('a', 100, 200), groups = [group(['a'], false)];
  const plain = groupBounds(groups[0], [node]);
  const captioned = { ...node, data: { ...node.data, caption: 'Front view' } };
  const withCaption = groupBounds(groups[0], [captioned]);
  assert.equal(withCaption.y, plain.y - 24);
  assert.equal(withCaption.y + withCaption.height, plain.y + plain.height);
  assert.deepEqual(canvasView([captioned], [], groups).nodes.find(n => n.id === 'a').position, node.position);
});

test('new remote generation groups respect local grouping, deletion, and ungrouping', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id, i) => image(id, i * 320, 0));
  const remote = [{ id: 'new', name: 'Generation', nodeIds: ['a', 'b', 'c'], collapsed: false }];
  assert.deepEqual(mergeAddedGroups([], remote, [], nodes), remote);
  const local = [{ id: 'manual', name: 'Manual', nodeIds: ['a', 'd'], collapsed: false }];
  assert.deepEqual(mergeAddedGroups(local, remote, [], nodes).map(g => g.nodeIds), [['a', 'd'], ['b', 'c']]);
  assert.deepEqual(mergeAddedGroups(local, remote, [], nodes.filter(n => n.id !== 'c')), local);
  assert.deepEqual(mergeAddedGroups([], remote, remote, nodes), []);
});

test('generation groups contain only existing, ungrouped outputs and ignore single images', () => {
  const nodes = ['a', 'b', 'c', 'other'].map((id, i) => image(id, i * 320, 0));
  const graph = { revision: 1, nodes, groups: [{ id: 'manual', name: 'Group 1', nodeIds: ['a', 'other'], collapsed: false }] };
  assert.equal(groupRunOutputs(graph, { outputIds: ['a', 'missing', 'b'] }), false);
  assert.equal(groupRunOutputs(graph, { outputIds: ['a', 'missing', 'b', 'c'] }), true);
  assert.equal(graph.revision, 2);
  assert.equal(graph.groups[1].name, 'Group 2');
  assert.deepEqual(graph.groups[1].nodeIds, ['b', 'c']);
  assert.equal(groupRunOutputs(graph, { outputIds: ['a', 'b', 'c'] }), false);
});

test('a save returns its assigned revision even when generation changes the graph during persistence', async () => {
  const graph = { revision: 3, nodes: [], edges: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 } };
  let finish;
  const saving = commitGraph(graph, { nodes: [], edges: [], groups: [] }, () => new Promise(resolve => { finish = resolve; }));
  assert.equal(graph.revision, 4);
  graph.revision++;
  finish();
  assert.equal(await saving, 4);
  assert.equal(graph.revision, 5);
});

test('first output is placed below existing content and group frames in its column', () => {
  const output = image('out', 400, 0);
  const graph = { nodes: [image('a', 400, 200), image('b', 800, 900)], groups: [] };
  positionFirstOutput(output, graph);
  assert.equal(output.position.y, 892);
  const grouped = image('next', 400, 0);
  graph.groups = [{ id: 'group', name: 'Group', nodeIds: ['a', 'b'], collapsed: false }];
  positionFirstOutput(grouped, graph);
  assert.equal(grouped.position.y, 1616);
  const nearby = image('nearby', 400, 0);
  positionFirstOutput(nearby, { nodes: [image('far', 400, 1000000)], groups: [] });
  assert.equal(nearby.position.y, 0);
});

test('undo retains the group of outputs that arrived after its snapshot', () => {
  const nodes = ['a', 'b', 'c'].map((id, i) => image(id, i * 320, 0));
  const current = [{ id: 'new', name: 'Generation', nodeIds: ['a', 'b', 'c'], collapsed: false }];
  assert.deepEqual(preserveFreshOutputGroups([], current, nodes, [nodes[1], nodes[2]]), current);
  const oldGroup = [{ id: 'manual', name: 'Manual', nodeIds: ['a'], collapsed: false }];
  assert.deepEqual(preserveFreshOutputGroups(oldGroup, current, nodes, [nodes[1], nodes[2]]).map(g => g.nodeIds), [['a'], ['b', 'c']]);
  assert.deepEqual(preserveFreshOutputGroups([], current, nodes, []), []);
  assert.deepEqual(preserveFreshOutputGroups([], current, nodes, [], new Set(['new'])), current);
});

test('undo preserves generated outputs created in the same millisecond as a checkpoint', () => {
  const capturedAt = '2026-11-01T10:00:00.000Z';
  const existing = image('existing', 0, 0), same = image('same-ms', 0, 0), newer = image('newer', 0, 0), older = image('older', 0, 0);
  existing.data = { ...existing.data, runId: 'run', createdAt: capturedAt };
  same.data = { ...same.data, runId: 'run', createdAt: capturedAt };
  newer.data = { ...newer.data, runId: 'run', createdAt: '2026-11-01T10:00:00.001Z' };
  older.data = { ...older.data, runId: 'run', createdAt: '2026-11-01T09:59:59.999Z' };
  assert.deepEqual(freshOutputNodes([existing, same, newer, older], { nodes: [existing], capturedAt }).map(node => node.id), ['same-ms', 'newer']);
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

test('branches stay next to their parents; age orders only sibling branches and separate trees', () => {
  const dated = (id, day) => ({ ...text(id, 0, 0), data: { text: id, createdAt: `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z` } });
  const nodes = [dated('new-root', 9), dated('new-child', 8), dated('old-child', 2), dated('old-root', 1), dated('middle-child', 4)];
  const edges = [edge('new-root', 'old-child'), edge('old-root', 'new-child'), edge('old-root', 'middle-child')];
  const result = alignNodes(nodes, edges, []), byId = new Map(result.map(node => [node.id, node]));
  assert.ok(byId.get('old-root').position.y < byId.get('new-root').position.y);
  assert.ok(byId.get('middle-child').position.y < byId.get('new-child').position.y);
  // old-child belongs to the newer tree, so structure keeps it below old-root's branch despite its age.
  assert.ok(byId.get('new-child').position.y < byId.get('old-child').position.y);
  for (const item of edges) assert.ok(byId.get(item.source).position.x < byId.get(item.target).position.x);
  assertSeparated(result); assert.deepEqual(alignNodes(result, edges, []), result);
  const legacy = [text('z', 0, 300), text('a', 0, 0), text('m', 0, -200)];
  const fallback = alignNodes(legacy, [], []);
  assert.ok(fallback[0].position.y < fallback[1].position.y && fallback[1].position.y < fallback[2].position.y);
});

test('group chronology uses its oldest member while preserving internal offsets in both states', () => {
  const nodes = [text('new', 0, 0), text('member-new', 400, 50), text('member-old', 400, 250)];
  ['2026-02-01', '2026-01-20', '2026-01-01'].forEach((date, i) => { nodes[i].data.createdAt = `${date}T00:00:00.000Z`; });
  for (const collapsed of [false, true]) {
    const groups = [group(['member-new', 'member-old'], collapsed)], result = alignNodes(nodes, [], groups);
    const bounds = groupBounds(groups[0], result);
    assert.ok(bounds.y < result[0].position.y);
    assert.equal(result[2].position.y - result[1].position.y, 200);
    assert.deepEqual(alignNodes(result, [], groups), result);
  }
});

test('undo treats freshly dated image duplicates as local edits and preserves only real generated output IDs', () => {
  const createdAt = '2026-01-01T00:00:01.000Z';
  const nodes = ['output', 'duplicate'].map(id => ({ id, type: 'image', data: { runId: 'run', createdAt } }));
  assert.deepEqual(freshOutputNodes(nodes, { nodes: [], capturedAt: '2026-01-01T00:00:00.000Z' }, [{ id: 'run', outputIds: ['output'] }]).map(node => node.id), ['output']);
});

test('an uploaded reference sits in the column just before the prompt that first uses it, beside it', () => {
  const nodes = [text('wolf', 0, 0), image('model', 0, 0), text('style', 0, 0), image('styled', 0, 0), text('mix', 0, 0), image('reference', 0, 0), image('early', 0, 0), text('first', 0, 0)];
  const edges = [edge('wolf', 'model'), edge('model', 'style'), edge('style', 'styled'), edge('styled', 'mix'), edge('reference', 'mix'), edge('early', 'first')];
  const result = alignNodes(nodes, edges, []), byId = new Map(result.map(node => [node.id, node]));
  // mix is in column 4, so the reference moves to column 3 next to styled instead of column 0.
  assert.equal(byId.get('reference').position.x, byId.get('styled').position.x);
  assert.ok(byId.get('reference').position.x < byId.get('mix').position.x);
  const center = id => byId.get(id).position.y + (byId.get(id).measured.height / 2);
  assert.ok(Math.abs(center('reference') - center('mix')) < 700);
  // A source already right before its consumer stays in column 0, and the main chain keeps its parent links.
  assert.equal(byId.get('early').position.x, byId.get('wolf').position.x);
  assert.ok(byId.get('styled').position.x < byId.get('mix').position.x);
  assertSeparated(result); assert.deepEqual(alignNodes(result, edges, []), result);
});

test('a prompt made only from a moved reference follows it instead of pulling it back to column 0', () => {
  const nodes = [text('wolf', 0, 0), image('model', 0, 0), text('style', 0, 0), image('styled', 0, 0), text('mix', 0, 0), image('reference', 0, 0), text('own', 0, 0)];
  const edges = [edge('wolf', 'model'), edge('model', 'style'), edge('style', 'styled'), edge('styled', 'mix'), edge('reference', 'mix'), edge('reference', 'own')];
  const result = alignNodes(nodes, edges, []), byId = new Map(result.map(node => [node.id, node]));
  assert.equal(byId.get('reference').position.x, byId.get('styled').position.x);
  assert.equal(byId.get('own').position.x, byId.get('mix').position.x);
  // The reference sits between the two prompts it feeds.
  const center = id => byId.get(id).position.y + byId.get(id).measured.height / 2;
  const [low, high] = [center('mix'), center('own')].sort((a, b) => a - b);
  assert.ok(center('reference') >= low - 1 && center('reference') <= high + 1);
  assertSeparated(result); assert.deepEqual(alignNodes(result, edges, []), result);
});

test('auto-align moves only the selection and keeps its top-left corner', async () => {
  const { alignSelection } = await import('../src/canvas.mjs');
  const text = (id, x, y) => ({ id, type: 'text', position: { x, y }, data: { text: id } });
  const nodes = [text('a', 500, 300), text('b', 100, 900), text('c', -50, -50), { id: 'd', type: 'drawing', position: { x: 520, y: 320 }, data: { points: [[0, 0], [10, 10]], color: '#25243d', width: 4 } }];
  const edges = [{ id: 'e', source: 'a', target: 'b' }];
  const result = alignSelection(nodes, edges, [], new Set(['a', 'b', 'd']));
  const byId = new Map(result.map(node => [node.id, node]));
  assert.deepEqual(byId.get('c').position, { x: -50, y: -50 });
  assert.deepEqual(byId.get('d').position, { x: 520, y: 320 });
  assert.equal(Math.min(byId.get('a').position.x, byId.get('b').position.x), 100);
  assert.ok(byId.get('b').position.x > byId.get('a').position.x);
  assert.equal(alignSelection(nodes, edges, [], new Set(['a', 'd'])), nodes);
});

test('canvas view keeps unchanged objects and lists, so React Flow re-adopts only what changed', () => {
  const nodes = [text('a', 0, 0), image('b', 400, 0), text('c', 800, 0)], edges = [edge('a', 'b'), edge('b', 'c')];
  const groups = [{ id: 'g', name: 'G', nodeIds: ['a', 'b'], collapsed: false }], cache = createViewCache();
  const first = canvasView(nodes, edges, groups, cache);
  const again = canvasView([...nodes], [...edges], [...groups], cache);
  assert.equal(again.nodes, first.nodes);
  assert.equal(again.edges, first.edges);
  const moved = nodes.map(node => node.id === 'c' ? { ...node, position: { x: 900, y: 0 } } : node);
  const next = canvasView(moved, edges, groups, cache);
  assert.notEqual(next.nodes, first.nodes);
  assert.deepEqual(next.nodes.map((node, index) => node === first.nodes[index]), [true, true, true, false]);
  assert.equal(next.edges, first.edges);
  // Moving a member changes only its own card and its frame.
  const inside = canvasView(moved.map(node => node.id === 'a' ? { ...node, position: { x: -50, y: 0 } } : node), edges, groups, cache);
  assert.deepEqual(inside.nodes.map((node, index) => node === next.nodes[index]), [false, false, true, true]);
  // Connections of one kind share a single style object, across views and editors.
  const other = canvasView(moved, [edge('c', 'b'), edge('a', 'c')], [], createViewCache()).edges;
  assert.equal(other[0].style, other[1].style);
  assert.equal(other[0].style, next.edges[0].style);
  assert.equal(canvasView(moved, edges, groups, createViewCache()).edges[1].style, next.edges[1].style);
  assert.equal(next.edges[1].style.stroke, 'var(--purple)');
});

test('unmeasured cards get estimated sizes and handles; measured ones keep their size, also after undo drops it', () => {
  const prompt = { id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: 'x'.repeat(100) } };
  const upload = { id: 'u', type: 'image', position: { x: 400, y: 0 }, data: { asset: 'a.png' } };
  const output = { id: 'o', type: 'image', position: { x: 800, y: 0 }, data: { asset: 'b.png', runId: 'r', aspect: .5 } };
  const note = { id: 's', type: 'sticky', position: { x: 0, y: 400 }, data: { text: '', color: '#fff3ad' } };
  const cache = createViewCache(), view = canvasView([prompt, upload, output, note], [], [], cache), byId = new Map(view.nodes.map(node => [node.id, node]));
  assert.deepEqual(byId.get('p').measured, { width: 310, height: 124 });
  assert.deepEqual(byId.get('p').handles.map(({ type, position, x, y }) => [type, position, x, y]), [['target', 'left', -9, 57], ['source', 'right', 309, 57]]);
  assert.deepEqual(byId.get('u').handles.map(handle => handle.type), ['source']);
  assert.deepEqual(byId.get('o').measured, { width: 310, height: 155 });
  assert.deepEqual(byId.get('o').handles.map(handle => handle.type), ['target', 'source']);
  assert.deepEqual(byId.get('s').handles, []);
  assert.deepEqual(estimatedSize({ id: 'e', type: 'text', data: { text: '' } }), { width: 310, height: 80 });
  assert.deepEqual(nodeHandles({ type: 'text', data: { template: { name: 'T' } } }, { width: 310, height: 100 }).map(handle => handle.x), [-8, 308]);
  // Once measured, a node keeps that size even when undo hands back a copy without it.
  const measured = { ...prompt, measured: { width: 310, height: 210 } };
  assert.deepEqual(canvasView([measured], [], [], cache).nodes[0].measured, measured.measured);
  const restored = canvasView([{ ...prompt, data: { text: 'old' } }], [], [], cache).nodes[0];
  assert.deepEqual(restored.measured, { width: 310, height: 210 });
  assert.equal(restored.handles[0].y, 100);
});

test('group bounds by id map match the scan over all nodes', () => {
  const nodes = [text('a', 90, 50), image('b', 480, 60), text('c', 300, 10)], group = { id: 'g', name: 'G', nodeIds: ['b', 'a', 'missing'], collapsed: false };
  const byId = new Map(nodes.map(node => [node.id, node]));
  assert.deepEqual(groupBounds(group, nodes, byId), groupBounds(group, nodes));
  assert.deepEqual(groupBounds(group, nodes), { x: 66, y: 2, width: 748, height: 702 });
  const frame = canvasView(nodes, [], [{ ...group, collapsed: true }]).nodes[0];
  assert.deepEqual(frame.handles.map(({ type, x, y }) => [type, x, y]), [['target', -10, 31], ['source', 240, 31]]);
  assert.deepEqual(canvasView(nodes, [], [group]).nodes[0].handles, []);
});

test('a folded card is 72px square whatever it last measured, and unfolding uses its last unfolded size', () => {
  const card = { id: 'c', type: 'text', position: { x: 0, y: 0 }, data: { text: 'hi' }, measured: { width: 310, height: 190 } }, cache = createViewCache();
  canvasView([card], [], [], cache);
  const shut = canvasView([{ ...card, data: { ...card.data, collapsed: true } }], [], [], cache).nodes[0];
  assert.deepEqual(shut.measured, { width: 72, height: 72 });
  assert.deepEqual(shut.handles.map(({ x, y }) => [x, y]), [[-9, 31], [71, 31]]);
  const { measured, ...unmeasured } = card;
  assert.deepEqual(canvasView([unmeasured], [], [], cache).nodes[0].measured, measured);
});

test('zoomed-out group titles never overlap: the selected and larger groups keep theirs', () => {
  const frame = (id, x, y, width, height, selected = false, name = 'Group name') => ({ id, position: { x, y }, width, height, selected, data: { name } });
  const frames = [frame('small', 0, 0, 300, 300), frame('big', 100, 0, 2000, 900), frame('far', 0, 5000, 300, 300), frame('picked', 50, 10, 200, 200, true)];
  assert.deepEqual([...visibleTitles(frames, .05)].sort(), ['far', 'picked']);
  // Close enough, every title fits.
  const apart = [frame('a', 0, 0, 1000, 600), frame('b', 1400, 0, 1000, 600), frame('c', 0, 1000, 1000, 600)];
  assert.deepEqual([...visibleTitles(apart, .3)].sort(), ['a', 'b', 'c']);
});

test('light cards expose connection dots on the same sides as full cards', () => {
  // React Flow reads the side from data-handlepos; a missing one bends links to the bottom and top when zoomed out.
  assert.deepEqual(lodHandleProps('source'), { className: 'lod-handle source', 'data-handlepos': 'right' });
  assert.deepEqual(lodHandleProps('target'), { className: 'lod-handle target', 'data-handlepos': 'left' });
});
