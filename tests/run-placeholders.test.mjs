import test from 'node:test';
import assert from 'node:assert/strict';
import { imageNode, positionRunOutput, descriptionNode } from '../graph.mjs';
import { codexImageActive, runPlaceholders, waitingSeed } from '../src/run-placeholders.mjs';
import { clipAt } from '../src/waiting-videos.mjs';
import { boxTouches, canvasView } from '../src/canvas.mjs';
import { selectedGraph } from '../src/clipboard.mjs';
import { generationFocusNodes } from '../src/generation-tray.mjs';

const prompt = (id = 'prompt', data = {}, page) => ({ id, type: 'text', position: { x: 30, y: 50 }, data: { text: 'A bird', ...data }, ...(page ? { page } : {}) });
const graph = (nodes = [prompt()], extra = {}) => ({ nodes, edges: [], groups: [], runs: [], ...extra });
const run = (extra = {}) => ({ id: 'run', nodeId: 'prompt', status: 'running', outputIds: [], ...extra });
const pending = (board, runs = [run()], page = 'page-1') => runPlaceholders(board, runs, page);
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

test('active local summaries and shared runs produce canvas-only, inert slots without mutating inputs', () => {
  const board = freeze(graph()), runs = freeze([run(), run({ id: 'queued', status: 'queued' })]);
  const result = pending(board, runs);
  assert.equal(result.nodes.length, 2); assert.equal(result.edges.length, 2);
  assert.deepEqual(board, graph());
  for (const [index, node] of result.nodes.entries()) {
    assert.equal(node.id, `${runs[index].id}-pending-0`); assert.equal(node.type, 'pending');
    for (const flag of ['selectable', 'draggable', 'connectable', 'deletable', 'focusable']) assert.equal(node[flag], false);
    assert.deepEqual(node.style, { width: 310, height: 310 });
    assert.equal(node.data.status, index ? 'Queued' : 'Generating');
    assert.equal(node.data.seed, waitingSeed(node.id));
    assert.equal(result.edges[index].target, node.id); assert.equal(result.edges[index].selectable, false);
    assert.equal(result.edges[index].type, 'pending'); assert.deepEqual(result.edges[index].data, {});
    assert.equal(node.data.spawnAt, undefined);
  }
  assert.deepEqual(pending(board, runs), result);
});

test('terminal, missing and removed runs leave no pending nodes or edges, including after partial success', () => {
  const board = graph();
  for (const status of ['completed', 'cancelled', 'failed', 'error', 'unknown']) {
    assert.deepEqual(pending(board, [run({ status, outputIds: ['real'] })]), { nodes: [], edges: [] });
  }
  assert.deepEqual(pending(board, []), { nodes: [], edges: [] });
  assert.deepEqual(pending(graph([])), { nodes: [], edges: [] });
});

test('Nano Banana keeps the remaining slot IDs and clips as real images arrive', () => {
  const board = graph(), job = run({ provider: 'nano-banana', variants: 4 });
  const before = pending(board, [job]);
  assert.equal(before.nodes.length, 4);
  for (let count = 0; count < 4; count++) {
    const node = imageNode({ ...job, target: board.nodes[0] }, `image-${count}`, count, { width: 100, height: 100 });
    positionRunOutput(node, board, job);
    assert.deepEqual(node.position, before.nodes[count].position);
    board.nodes.push(node); job.outputIds.push(node.id);
    const after = pending(board, [job]);
    assert.deepEqual(after.nodes.map(node => node.id), before.nodes.slice(count + 1).map(node => node.id));
    assert.deepEqual(after.nodes.map(node => node.data.seed), before.nodes.slice(count + 1).map(node => node.data.seed));
    assert.deepEqual(after.nodes.map(node => node.position), before.nodes.slice(count + 1).map(node => node.position));
  }
  assert.deepEqual(pending(board, [job]), { nodes: [], edges: [] });
  assert.equal(pending(graph(), [run({ provider: 'nano-banana' })]).nodes.length, 1);
});

test('Codex shows its first slot, then waits for an active image tool signal, ignoring variants', () => {
  const board = graph(), job = run({ variants: 4 });
  for (let count = 0; count < 4; count++) {
    if (count) assert.equal(pending(board, [job]).nodes.length, 0);
    job.diagnostics = { events: [{ type: 'image_completed' }, { type: 'image_started' }] };
    const result = pending(board, [job]);
    assert.equal(result.nodes.length, 1); assert.equal(result.nodes[0].id, `run-pending-${count}`);
    const node = imageNode({ ...job, target: board.nodes[0] }, `image-${count}`, count);
    positionRunOutput(node, board, job); assert.deepEqual(node.position, result.nodes[0].position);
    board.nodes.push(node); job.outputIds.push(node.id);
    job.diagnostics.events.push({ type: 'image_completed' });
  }
  assert.equal(pending(board, [job]).nodes.length, 0);
  assert.equal(pending(graph(), [run({ variants: 4 })]).nodes.length, 1);
});

test('Codex completion, failure and turn termination clear the active tool signal', () => {
  for (const type of ['image_completed', 'image_failed', 'turn_completed', 'error']) {
    const job = run({ outputIds: ['real'], diagnostics: { events: [{ type: 'image_started' }, { type: 'agent_message' }, { type }] } });
    assert.equal(codexImageActive(job), false);
    assert.equal(pending(graph(), [job]).nodes.length, 0);
  }
  assert.equal(codexImageActive(run({ diagnostics: { events: [{ type: 'image_started' }, { type: 'agent_message' }] } })), true);
  assert.equal(pending(graph(), [run({ outputIds: ['real'], message: 'Generating image…' })]).nodes.length, 0);
});

test('upscale counts frozen inputs first, then snapshots, then distinct directly connected images, falling back to one', () => {
  const images = ['a', 'b', 'c'].map(id => ({ id, type: 'image', position: { x: -400, y: 0 }, data: { asset: id } }));
  const board = graph([prompt('prompt', { task: 'upscale' }), ...images], { edges: [{ source: 'a', target: 'prompt' }, { source: 'a', target: 'prompt' }, { source: 'b', target: 'prompt' }, { source: 'prompt', target: 'c' }] });
  const job = run({ task: 'upscale', provider: 'nano-banana', variants: 4 });
  assert.equal(pending(board, [job]).nodes.length, 2);
  assert.equal(pending(board, [{ ...job, snapshot: images }]).nodes.length, 3);
  const result = pending(board, [{ ...job, images: ['x', 'y', 'z', 'w'], outputIds: ['real'] }]);
  assert.equal(result.nodes.length, 3); assert.equal(result.nodes[0].id, 'run-pending-1');
  assert.equal(result.nodes[0].data.status, 'Upscaling');
  assert.equal(pending(graph(), [job]).nodes.length, 1);
});

test('describe has one text-shaped slot, no clip, and the same initial placement as the text output', () => {
  const board = graph([prompt('prompt', { task: 'describe' })]), job = run({ task: 'describe', provider: 'nano-banana', variants: 4 });
  const result = pending(board, [job]);
  assert.equal(result.nodes.length, 1); assert.equal(result.nodes[0].data.seed, undefined);
  assert.equal(result.nodes[0].data.describe, true); assert.equal(result.nodes[0].data.status, 'Describing');
  assert.deepEqual(result.nodes[0].style, { width: 310, height: 80 });
  const output = descriptionNode({ ...job, target: board.nodes[0] }, 'A bird');
  positionRunOutput(output, board, job); assert.deepEqual(result.nodes[0].position, output.position);
  assert.equal(pending(board, [{ ...job, outputIds: ['description'] }]).nodes.length, 0);
});

test('placement uses real obstacles, groups, existing output sizes, requested aspect and the frozen local target', () => {
  const target = prompt('prompt', { aspect: .5 }), obstacle = { id: 'obstacle', type: 'image', position: { x: 420, y: 50 }, data: { aspect: 2 } };
  const board = graph([target, obstacle], { groups: [{ id: 'g', name: 'G', nodeIds: ['obstacle'], collapsed: false }] });
  const job = run({ target: { ...target, position: { x: 50, y: 60 } }, provider: 'nano-banana', variants: 2 });
  const outputs = pending(board, [job]).nodes, scratch = structuredClone(board), placement = structuredClone(job);
  for (let index = 0; index < 2; index++) {
    const output = imageNode(placement, `image-${index}`, index, { width: 200, height: 100 });
    positionRunOutput(output, scratch, placement);
    assert.deepEqual(outputs[index].position, output.position); assert.equal(outputs[index].style.height, 155);
    scratch.nodes.push(output); placement.outputIds.push(output.id);
  }
  const old = { id: 'old', type: 'image', position: { x: 420, y: 800 }, measured: { width: 310, height: 900 }, data: { aspect: 700 / 310 } };
  assert.equal(pending(graph([target, old]), [run({ provider: 'nano-banana', variants: 2, outputIds: ['old'] })]).nodes[0].position.y, 1554);
  assert.equal(pending(graph([prompt('prompt', { aspect: 'invalid' })])).nodes[0].style.height, 310);
});

test('a single distinct input supplies the aspect, with frozen snapshots and explicit requests taking priority', () => {
  const source = { id: 'source', type: 'image', position: { x: -400, y: 0 }, data: { asset: 'source', aspect: .5 } };
  const board = graph([prompt(), source], { edges: [{ source: 'source', target: 'prompt' }, { source: 'source', target: 'prompt' }] });
  const job = run({ provider: 'nano-banana', variants: 3 });
  const slots = pending(board, [job]).nodes;
  assert.deepEqual(slots.map(node => node.style.height), [155, 155, 155]);
  const scratch = structuredClone(board), placement = { ...job, target: board.nodes[0], outputIds: [] };
  for (let index = 0; index < 3; index++) {
    const output = imageNode(placement, 'output', index, { width: 200, height: 100 });
    positionRunOutput(output, scratch, placement);
    assert.deepEqual(output.position, slots[index].position);
    scratch.nodes.push(output); placement.outputIds.push(output.id);
  }
  const frozen = { ...source, data: { ...source.data, aspect: 2 } };
  assert.equal(pending(board, [{ ...job, snapshot: [frozen] }]).nodes[0].style.height, 620);
  assert.equal(pending(board, [{ ...job, target: prompt('prompt', { aspect: .75 }) }]).nodes[0].style.height, 232.5);
  assert.equal(pending(board, [{ ...job, snapshot: [] }]).nodes[0].style.height, 310);
  const second = { ...source, id: 'second' };
  assert.equal(pending({ ...board, nodes: [...board.nodes, second], edges: [...board.edges, { source: 'second', target: 'prompt' }] }, [job]).nodes[0].style.height, 310);
  assert.equal(pending({ ...board, nodes: [prompt(), { ...source, data: { pixels: { width: 400, height: 100 } } }] }, [job]).nodes[0].style.height, 77.5);
});

test('upscale slots follow each frozen source aspect and keep the remaining positions on completion', () => {
  const images = [.5, 2].map((aspect, index) => ({ id: `source-${index}`, type: 'image', position: { x: -400, y: 0 }, data: { asset: `source-${index}`, aspect } }));
  const board = graph([prompt('prompt', { task: 'upscale', aspect: 1 }), ...images], { edges: images.map(image => ({ source: image.id, target: 'prompt' })) });
  const job = run({ task: 'upscale', snapshot: images }), before = pending(board, [job]).nodes;
  assert.deepEqual(before.map(node => node.style.height), [155, 620]);
  const output = imageNode({ ...job, target: board.nodes[0] }, 'result', 0, { width: 200, height: 100 });
  positionRunOutput(output, board, job); board.nodes.push(output); job.outputIds.push(output.id);
  assert.deepEqual(pending(board, [job]).nodes[0].position, before[1].position);
});

test('browser-only measurements do not move placeholders away from the server’s placement', () => {
  const blocker = { id: 'text', type: 'text', position: { x: 420, y: 0 }, data: { text: 'Tall prompt. '.repeat(100) } };
  const saved = graph([prompt(), blocker]), client = graph([prompt(), { ...blocker, measured: { width: 310, height: 310 } }]);
  assert.deepEqual(pending(client).nodes[0].position, pending(saved).nodes[0].position);
  const output = imageNode({ ...run(), target: saved.nodes[0] }, 'image', 0);
  positionRunOutput(output, saved, run());
  assert.deepEqual(pending(client).nodes[0].position, output.position);
});

test('page filtering and deleted-page fallback follow real placement and never connect across pages', () => {
  const pages = [{ id: 'page-1', name: 'One' }, { id: 'two', name: 'Two' }], board = graph([prompt('prompt', {}, 'two')], { pages });
  const job = run({ page: 'two' });
  assert.equal(pending(board, [job]).nodes.length, 0);
  assert.equal(pending(board, [job], 'two').nodes[0].page, 'two');
  assert.equal(pending(graph([prompt()], { pages }), [job], 'two').nodes.length, 0);
  const deleted = graph([prompt('prompt', {}, 'deleted')], { pages });
  assert.equal(pending(deleted, [run({ page: 'deleted' })]).nodes.length, 1);
});

test('a placeholder beside a tall column shares the real output’s nearer rightward placement', () => {
  const blocker = { id: 'column', type: 'image', position: { x: 420, y: 50 }, data: { aspect: 10 } };
  const board = graph([prompt(), blocker]), job = run(), result = pending(board, [job]);
  assert.deepEqual(result.nodes[0].position, { x: 754, y: 50 });
  const output = imageNode({ ...job, target: board.nodes[0] }, 'image', 0);
  positionRunOutput(output, board, job);
  assert.deepEqual(output.position, result.nodes[0].position);
});

test('canvas can connect and focus pending slots, including folded prompts, while marquee and clipboard ignore them', () => {
  const board = graph(), job = run(), slots = pending(board, [job]);
  const view = canvasView([...board.nodes, ...slots.nodes], slots.edges, [{ id: 'folded', name: 'Folded', nodeIds: ['prompt'], collapsed: true }]);
  assert.equal(view.edges[0].source, 'folded'); assert.equal(view.edges[0].target, slots.nodes[0].id);
  assert.ok(view.nodes.find(node => node.type === 'pending').handles.some(handle => handle.type === 'target'));
  const picked = boxTouches(slots.nodes, { x: -1000, y: -1000, width: 10000, height: 10000 }, { x: -1000, y: -1000 });
  assert.equal(picked.size, 0);
  assert.equal(selectedGraph(slots.nodes, slots.edges).nodes.length, 0);
  assert.deepEqual(generationFocusNodes(job, view.nodes, [{ id: 'folded', collapsed: true, nodeIds: ['prompt'] }]), [{ id: 'folded' }, { id: 'run-pending-0' }]);
});

test('clip choice is deterministic across replicas, varies between slots and tolerates an empty clip list', () => {
  // The seed travels instead of a clip, because only the browser knows which clips the site is hosting.
  assert.equal(waitingSeed('run-pending-3'), waitingSeed('run-pending-3'));
  const clips = Array.from({ length: 8 }, (_, i) => `/clips/0${i + 1}.mp4`);
  const opening = Array.from({ length: 8 }, (_, i) => clipAt(waitingSeed(`run-pending-${i}`), 0, clips));
  assert.equal(new Set(opening).size, 8);
  assert.ok(opening.every(clip => clips.includes(clip)));
  assert.equal(clipAt(waitingSeed('slot'), 0, []), undefined);
});
