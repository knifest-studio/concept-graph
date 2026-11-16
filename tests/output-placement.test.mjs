import test from 'node:test';
import assert from 'node:assert/strict';
import { imageNode, captionHeight, nodeSize } from '../graph.mjs';
import { expectedOutputs, positionRunOutput } from '../src/output-placement.mjs';
import { runPlaceholders } from '../src/run-placeholders.mjs';
import { placeRunOutput, placeRunText } from '../src/run-outputs.mjs';
import { groupBounds } from '../src/canvas.mjs';

const asset = '12345678-1234-1234-1234-123456789abc.png';
const prompt = (id = 'p', x = 0, y = 0, data = {}) => ({ id, type: 'text', position: { x, y }, data: { text: 'A bird', ...data } });
const image = (id, x, y, data = {}) => ({ id, type: 'image', position: { x, y }, data: { asset, ...data } });
const sticky = (id, x, y) => ({ id, type: 'sticky', position: { x, y }, data: { text: '', color: '#fff3ad' } });
const board = (nodes, extra = {}) => ({ nodes, edges: [], groups: [], runs: [], ...extra });
const job = (extra = {}) => ({ id: 'run', nodeId: 'p', status: 'running', outputIds: [], createdAt: '2026-11-16T10:00:00.000Z', ...extra });
const variants = (count, extra = {}) => job({ provider: 'nano-banana', variants: count, ...extra });
const shown = (graph, runs = graph.runs) => runPlaceholders(graph, runs, 'page-1').nodes;
const positions = nodes => nodes.map(node => node.position);
const box = node => ({ x: node.position.x, y: node.position.y - captionHeight(node), width: nodeSize(node).width, height: nodeSize(node).height + captionHeight(node) });
const overlap = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

// One local result placed directly, as the server places a Codex image.
function placed(graph, run, dimensions = { width: 100, height: 100 }) {
  const node = imageNode({ ...run, target: run.target || { position: { x: 0, y: 0 } } }, asset, run.outputIds.length, dimensions);
  positionRunOutput(node, graph, run);
  return node.position;
}

// Delivers a run's results through the shared step every cloud generator uses, checking each lands on the placeholder
// that was shown for it just before.
function deliver(graph, runId, count, { dimensions = () => ({ width: 100, height: 100 }), between } = {}) {
  for (let index = 0; index < count; index++) {
    if (between) graph = between(graph, index);
    const run = graph.runs.find(item => item.id === runId), slot = shown(graph).find(node => node.data.runId === runId);
    graph = placeRunOutput(graph, { runId, nodeId: run.nodeId, run, output: { index }, asset, dimensions: dimensions(index) });
    assert.deepEqual(graph.nodes.find(node => node.id === `${runId}-output-${index}`).position, slot.position);
  }
  return { ...graph, runs: graph.runs.map(run => run.id === runId ? { ...run, status: 'completed' } : run) };
}
const outputs = (graph, runId) => graph.nodes.filter(node => node.data.runId === runId);

test('an empty board puts a result 80px right of its prompt and level with its top, as drawn when folded', () => {
  const graph = board([prompt('p', 30, 50)]);
  assert.deepEqual(placed(graph, job()), { x: 420, y: 50 });
  assert.deepEqual(positions(shown(graph, [job()])), [{ x: 420, y: 50 }]);
  // A folded prompt is a 72px square.
  const folded = board([prompt('p', 30, 50, { collapsed: true })]);
  assert.deepEqual(placed(folded, job()), { x: 182, y: 50 });
  assert.deepEqual(positions(shown(folded, [job()])), [{ x: 182, y: 50 }]);
  // A prompt inside a folded group is that group's 240×72 card, whose top sits 48px above the prompt.
  const hidden = board([prompt('p', 30, 50)], { groups: [{ id: 'g', name: 'G', nodeIds: ['p'], collapsed: true }] });
  assert.deepEqual(placed(hidden, job()), { x: 326, y: 2 });
});

test('square, 2:3 and 16:9 variants stack in one column with a 30px gap below each caption', () => {
  for (const [width, height] of [[100, 100], [1000, 1500], [1600, 900]]) {
    const aspect = height / width, run = variants(4), graph = board([prompt('p', 0, 0, { aspect })], { runs: [run] });
    const slots = shown(graph);
    assert.deepEqual(positions(slots), [0, 1, 2, 3].map(index => ({ x: 390, y: index * (310 * aspect + 30 + 24) })));
    const done = deliver(graph, run.id, 4, { dimensions: () => ({ width, height }) });
    assert.deepEqual(positions(outputs(done, run.id)), positions(slots));
  }
});

test('sixteen variants stay in one column beside their prompt', () => {
  const run = variants(16), graph = board([prompt()], { runs: [run] });
  assert.equal(expectedOutputs(graph, run).length, 16);
  assert.deepEqual(positions(shown(graph)), Array.from({ length: 16 }, (_, index) => ({ x: 390, y: index * 364 })));
  assert.deepEqual(positions(outputs(deliver(graph, run.id, 16), run.id)), Array.from({ length: 16 }, (_, index) => ({ x: 390, y: index * 364 })));
});

test('the largest run, 32 variants, stays in one column, its slots past the started calls queued', () => {
  const run = variants(32, { variantsStarted: 4 }), graph = board([prompt()], { runs: [run] }), slots = shown(graph), column = Array.from({ length: 32 }, (_, index) => ({ x: 390, y: index * 364 }));
  assert.deepEqual(positions(slots), column);
  assert.deepEqual(slots.map(node => node.data.status), [...Array(4).fill('Generating'), ...Array(28).fill('Queued')]);
  assert.deepEqual(positions(outputs(deliver(graph, run.id, 32), run.id)), column);
});

test('a re-run takes the next column at the prompt’s level, past an expanded slideshow or only a folded one’s card', () => {
  let graph = deliver(board([prompt()], { runs: [variants(4)] }), 'run', 4);
  assert.equal(graph.groups.length, 1); assert.equal(graph.groups[0].collapsed, false);
  const again = variants(4, { id: 'again', createdAt: '2026-11-16T10:05:00.000Z' });
  // The expanded frame ends 24px right of its cards; this run's own frame keeps 24px more.
  assert.deepEqual(shown(graph, [again])[0].position, { x: 772, y: 0 });
  // Folded, the slideshow is one image card; the images hidden in it take no room.
  graph = { ...graph, groups: graph.groups.map(group => ({ ...group, collapsed: true })) };
  assert.deepEqual(shown(graph, [again])[0].position, { x: 724, y: 0 });
  graph = deliver({ ...graph, runs: [...graph.runs, again] }, 'again', 4);
  assert.ok(outputs(graph, 'again').every(node => node.position.x === 724));
  // Single results take the next column too.
  const single = deliver(board([prompt()], { runs: [job()] }), 'run', 1);
  assert.deepEqual(placed(single, job({ id: 'next' })), { x: 724, y: 0 });
  // Four columns level with the prompt, then under the first.
  let columns = board([prompt()]);
  for (let index = 0; index < 5; index++) columns = deliver({ ...columns, runs: [...columns.runs, job({ id: `run-${index}`, createdAt: `2026-11-16T10:0${index}:00.000Z` })] }, `run-${index}`, 1);
  assert.deepEqual(columns.nodes.filter(node => node.type === 'image').map(node => node.position), [{ x: 390, y: 0 }, { x: 724, y: 0 }, { x: 1058, y: 0 }, { x: 1392, y: 0 }, { x: 390, y: 358 }]);
});

test('a re-run on one of several stacked prompts stays in its row instead of going under the next prompt’s results', () => {
  const rows = gap => {
    const nodes = [], runs = [];
    for (let row = 0; row < 10; row++) {
      nodes.push(prompt(`p${row}`, 0, row * gap));
      for (let column = 0; column < 4; column++) {
        const id = `old-${row}-${column}`;
        nodes.push(image(`${id}-output-0`, 390 + column * 334, row * gap, { runId: id }));
        runs.push({ id, nodeId: `p${row}`, status: 'completed', outputIds: [`${id}-output-0`], createdAt: '2026-11-16T09:00:00.000Z' });
      }
    }
    return board(nodes, { runs });
  };
  const tight = rows(400);
  assert.deepEqual(placed(tight, job({ nodeId: 'p0' })), { x: 1726, y: 0 });
  assert.deepEqual(positions(shown(tight, [job({ nodeId: 'p0' })])), [{ x: 1726, y: 0 }]);
  // Four variants are taller than the row: they stay level with their prompt, past its results, and land on their slots.
  const four = variants(4, { nodeId: 'p0' }), withFour = { ...tight, runs: [...tight.runs, four] };
  assert.deepEqual(positions(shown(withFour)), [0, 1, 2, 3].map(index => ({ x: 1750, y: index * 364 })));
  deliver(withFour, four.id, 4);
  // A row with room under the prompt’s results keeps the re-run under the first of them.
  assert.deepEqual(placed(rows(800), job({ nodeId: 'p0' })), { x: 390, y: 358 });
  // Without prompts below, a long grid beside the prompt is passed on the level, not followed down.
  const grid = [prompt()];
  for (let row = 0; row < 30; row++) for (let column = 0; column < 4; column++) grid.push(image(`i-${row}-${column}`, 390 + column * 334, row * 358));
  assert.deepEqual(placed(board(grid), job()), { x: 1726, y: 0 });
});

test('a description lands where its placeholder showed, which keeps room for a full description', () => {
  const describe = prompt('p', 0, 0, { text: '', task: 'describe' }), source = image('source', -400, 0), feeds = { id: 'feeds', source: 'source', target: 'p' };
  const run = job({ task: 'describe', provider: 'nano-banana' }), long = 'A small bird sits on a mossy branch in soft morning light. '.repeat(20);
  const graph = board([describe, source, image('below', 390, 200)], { edges: [feeds], runs: [run] }), [slot] = shown(graph);
  assert.deepEqual(slot.style, { width: 310, height: 310 }); assert.deepEqual(slot.position, { x: 724, y: 0 });
  for (const text of ['A bird.', long]) assert.deepEqual(placeRunText(graph, { runId: run.id, nodeId: 'p', run, text }).nodes.find(node => node.id === 'run-output-0').position, slot.position);
  // A run started later on a prompt just below keeps clear of that room, even when its image comes first.
  const later = job({ id: 'later', nodeId: 'q', provider: 'nano-banana', createdAt: '2026-11-16T10:01:00.000Z' });
  let both = board([describe, source, prompt('q', 0, 250)], { edges: [feeds], runs: [run, later] });
  const initial = new Map(shown(both).map(node => [node.id, node.position]));
  assert.deepEqual(initial.get('run-pending-0'), { x: 390, y: 0 });
  both = placeRunOutput(both, { runId: 'later', nodeId: 'q', run: later, output: { index: 0 }, asset, dimensions: { width: 100, height: 100 } });
  assert.deepEqual(both.nodes.find(node => node.id === 'later-output-0').position, initial.get('later-pending-0'));
  both = placeRunText(both, { runId: run.id, nodeId: 'p', run, text: long });
  assert.deepEqual(both.nodes.find(node => node.id === 'run-output-0').position, initial.get('run-pending-0'));
});

test('a 3D run keeps one model-shaped slot per connected image, stacked, and its models land on them', () => {
  const sources = [image('i0', -400, 0), image('i1', -400, 400)], run = job({ task: 'model3d', provider: 'nano-banana' });
  let graph = board([prompt('p', 0, 0, { text: '', task: 'model3d' }), ...sources], { edges: sources.map(node => ({ id: `${node.id}-edge`, source: node.id, target: 'p' })), runs: [run] });
  assert.deepEqual(expectedOutputs(graph, run), [{ type: 'model', aspect: 1 }, { type: 'model', aspect: 1 }]);
  const slots = shown(graph);
  assert.deepEqual(slots.map(node => [node.position, node.style, node.data.status]), [0, 416].map(y => [{ x: 390, y }, { width: 310, height: 386 }, 'Generating 3D']));
  for (const index of [0, 1]) {
    graph = placeRunOutput(graph, { runId: run.id, nodeId: 'p', run: graph.runs.find(item => item.id === run.id), output: { index }, asset: '12345678-1234-1234-1234-123456789abc.glb', model: { name: 'Cube 3D' } });
    const model = graph.nodes.find(node => node.id === `run-output-${index}`);
    assert.equal(model.type, 'model'); assert.deepEqual(model.position, slots[index].position);
  }
});

test('arrows and attached stamps never move a result; drawings and loose stamps do, level with the prompt', () => {
  const arrow = { id: 'arrow', type: 'arrow', position: { x: 300, y: -100 }, data: { from: { x: 300, y: -100 }, to: { x: 1400, y: 1200 }, color: '#6b6e89' } };
  const attached = { id: 'like', type: 'stamp', position: { x: 380, y: 10 }, data: { stamp: 'like', attachedTo: 'p' } };
  assert.deepEqual(placed(board([prompt(), arrow, attached]), job()), { x: 390, y: 0 });
  const loose = { ...attached, data: { stamp: 'like' } };
  assert.deepEqual(placed(board([prompt(), loose]), job()), { x: 452, y: 0 });
  const drawing = { id: 'drawing', type: 'drawing', position: { x: 400, y: 40 }, data: { points: [[0, 0], [100, 100]], color: '#25243d', width: 4 } };
  assert.deepEqual(placed(board([prompt(), drawing]), job()), { x: 528, y: 0 });
});

test('a sticky beside the prompt shifts the result right at its level; a long shape sends it under, never above', () => {
  assert.deepEqual(placed(board([prompt(), sticky('note', 390, -50)]), job()), { x: 614, y: 0 });
  const shape = { id: 'bar', type: 'shape', position: { x: 390, y: 100 }, data: { shape: 'rectangle', width: 2000, height: 200, text: '', color: '#ffffff' } };
  assert.deepEqual(placed(board([prompt(), shape]), job()), { x: 390, y: 348 });
});

test('in a chain, a re-run goes under the prompt’s own result instead of past the next prompt', () => {
  const first = deliver(board([prompt()], { runs: [job()] }), 'run', 1), result = outputs(first, 'run')[0];
  assert.deepEqual(result.position, { x: 390, y: 0 });
  const chain = { ...first, nodes: [...first.nodes, prompt('next', 760, 0)], edges: [...first.edges, { id: 'feeds', source: result.id, target: 'next' }] };
  assert.deepEqual(placed(chain, job({ id: 'again' })), { x: 390, y: 358 });
  // With room before the next prompt, the re-run stays level.
  const roomy = { ...chain, nodes: chain.nodes.map(node => node.id === 'next' ? { ...node, position: { x: 1300, y: 0 } } : node) };
  assert.deepEqual(placed(roomy, job({ id: 'again' })), { x: 724, y: 0 });
});

test('a card dropped under a working run is skipped, and the placeholders move with the results', () => {
  const run = variants(4), drop = sticky('dropped', 400, 330);
  const graph = deliver(board([prompt()], { runs: [run] }), run.id, 4, { between: (graph, index) => index === 1 ? { ...graph, nodes: [...graph.nodes, drop] } : graph });
  const cards = outputs(graph, run.id);
  assert.deepEqual(cards.map(node => node.position.y), [0, 578, 942, 1306]);
  assert.ok(cards.every(node => node.position.x === 390 && !overlap(box(node), box(drop))));
});

test('a moved prompt takes a waiting local run’s results along; a deleted one falls back to its snapshot or earlier results', () => {
  const run = job({ target: prompt('p', 0, 0) });
  const moved = board([prompt('p', 2000, 500)]);
  assert.deepEqual(placed(moved, run), { x: 2390, y: 500 });
  assert.deepEqual(positions(shown(moved, [run])), [{ x: 2390, y: 500 }]);
  // The local server keeps the prompt as submitted.
  assert.deepEqual(placed(board([sticky('other', -500, -500)]), job({ target: prompt('p', 1000, 200) })), { x: 1390, y: 200 });
  // Cloud runs have no snapshot: the prompt’s earlier results show where it stood.
  const earlier = { id: 'old', nodeId: 'p', status: 'completed', outputIds: ['old-output-0'], createdAt: '2026-11-16T09:00:00.000Z' };
  const graph = board([image('old-output-0', 1390, 200, { runId: 'old' })], { runs: [earlier, job()] });
  const next = placeRunOutput(graph, { runId: 'run', nodeId: 'p', run: job(), output: { index: 0 }, asset, dimensions: { width: 100, height: 100 } });
  assert.deepEqual(next.nodes.find(node => node.id === 'run-output-0').position, { x: 1724, y: 200 });
});

test('runs started together on neighbouring prompts keep their own columns, whichever result arrives first', () => {
  const a = variants(4, { id: 'a', nodeId: 'top' }), b = variants(4, { id: 'b', nodeId: 'below', createdAt: '2026-11-16T10:00:01.000Z' });
  let graph = board([prompt('top', 0, 0), prompt('below', 0, 400)], { runs: [b, a] });
  const initial = new Map(shown(graph).map(node => [node.id, node.position]));
  assert.deepEqual([0, 1, 2, 3].map(index => initial.get(`a-pending-${index}`)), [0, 1, 2, 3].map(index => ({ x: 390, y: index * 364 })));
  assert.deepEqual([0, 1, 2, 3].map(index => initial.get(`b-pending-${index}`)), [0, 1, 2, 3].map(index => ({ x: 772, y: 400 + index * 364 })));
  const arrived = { a: 0, b: 0 };
  for (const id of ['b', 'a', 'b', 'b', 'a', 'a', 'b', 'a']) {
    const run = graph.runs.find(item => item.id === id), index = arrived[id]++;
    graph = placeRunOutput(graph, { runId: id, nodeId: run.nodeId, run, output: { index }, asset, dimensions: { width: 100, height: 100 } });
    assert.deepEqual(graph.nodes.find(node => node.id === `${id}-output-${index}`).position, initial.get(`${id}-pending-${index}`));
    for (const slot of shown(graph)) assert.deepEqual(slot.position, initial.get(slot.id));
  }
  const byId = new Map(graph.nodes.map(node => [node.id, node])), [one, two] = graph.groups.map(group => groupBounds(group, graph.nodes, byId));
  assert.equal(graph.groups.length, 2); assert.equal(overlap(one, two), false);
});

test('results do not depend on the order of nodes, groups or runs', () => {
  const nodes = [prompt('top', 0, 0), prompt('below', 0, 450), image('a', 390, 100), image('b', 800, -40, { aspect: 2 }), sticky('note', 1200, 0), image('c', 390, 900)];
  const groups = [{ id: 'g', name: 'G', nodeIds: ['b', 'note'], collapsed: false }, { id: 'h', name: 'H', nodeIds: ['c'], collapsed: true }];
  const runs = [variants(3, { id: 'one', nodeId: 'top' }), job({ id: 'two', nodeId: 'below', createdAt: '2026-11-16T10:00:00.000Z' }), variants(2, { id: 'three', nodeId: 'below', createdAt: '2026-11-16T10:00:02.000Z' })];
  const result = graph => Object.fromEntries(shown(graph, graph.runs).map(node => [node.id, node.position]));
  const expected = result(board(nodes, { groups, runs }));
  assert.equal(Object.keys(expected).length, 6);
  assert.deepEqual(result(board([...nodes].reverse(), { groups: [...groups].reverse(), runs: [...runs].reverse() })), expected);
  for (const position of Object.values(expected)) assert.ok(position.y >= 0 && position.x >= 390);
});
