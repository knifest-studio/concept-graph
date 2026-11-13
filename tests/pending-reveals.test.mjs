import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { matchingPlaceholder, prunePlaceholders } from '../src/pending-reveals.mjs';
import { runPlaceholders } from '../src/run-placeholders.mjs';
import { placeRunOutput } from '../src/run-outputs.mjs';

const slot = (extra = {}) => ({ id: 'run-pending-0', runId: 'run', x: 420, y: 50, width: 310, height: 155, clip: '/waiting/01.mp4', time: 4.5, ...extra });

test('reveal matches run and consumed position, independently of variant output index', () => {
  const first = slot(), second = slot({ id: 'run-pending-1', y: 259 });
  const slots = new Map([[first.id, first], [second.id, second]]);
  const output = { id: 'run-output-3', data: { runId: 'run' }, position: { x: 420, y: 50 } };
  assert.equal(matchingPlaceholder(slots, output.data.runId, output.position, 100), first);
  slots.delete(first.id);
  assert.equal(matchingPlaceholder(slots, output.data.runId, output.position, 101), undefined);
  assert.equal(matchingPlaceholder(slots, 'run', { x: 420, y: 259 }, 101), second);
});

test('different runs, moved outputs, descriptions and clients without a displayed slot have no reveal', () => {
  const first = slot(), slots = new Map([[first.id, first]]);
  assert.equal(matchingPlaceholder(slots, 'other-run', { x: 420, y: 50 }, 100), undefined);
  assert.equal(matchingPlaceholder(slots, 'run', { x: 421, y: 50 }, 100), undefined);
  assert.equal(matchingPlaceholder(new Map(), 'run', { x: 420, y: 50 }, 100), undefined);
  first.describe = true;
  assert.equal(matchingPlaceholder(slots, 'run', { x: 420, y: 50 }, 100), undefined);
});

test('recent unmounts retain playback for handoff, stale slots expire and live cards remain eligible', () => {
  const live = slot(), recent = slot({ id: 'recent', y: 259, unmountedAt: 500 });
  const stale = slot({ id: 'stale', y: 900, unmountedAt: 0 });
  const slots = new Map([live, recent, stale].map(item => [item.id, item]));
  assert.equal(matchingPlaceholder(slots, 'run', { x: 420, y: 259 }, 1000), recent);
  assert.equal(matchingPlaceholder(slots, 'run', { x: 420, y: 900 }, 1000), undefined);
  const before = structuredClone([...slots]);
  matchingPlaceholder(slots, 'run', { x: 420, y: 50 }, 1000);
  assert.deepEqual([...slots], before);
  prunePlaceholders(slots, 1000);
  assert.deepEqual([...slots.keys()], [live.id, recent.id]);
  prunePlaceholders(slots, 1500);
  assert.deepEqual([...slots.keys()], [live.id]);
});

test('real Nano Banana placements consume shown slots in arrival order when variant indexes arrive 0, 2, 1', () => {
  const prompt = { id: 'prompt', type: 'text', position: { x: 30, y: 50 }, data: { text: 'A bird', aspect: .5 } };
  let run = { id: 'run', nodeId: 'prompt', status: 'running', provider: 'nano-banana', variants: 3, outputIds: [] };
  let graph = { nodes: [prompt], edges: [], groups: [], runs: [run], revision: 0 };
  const slots = new Map(runPlaceholders(graph, [run], 'page-1').nodes.map(node => [node.id, slot({ id: node.id, x: node.position.x, y: node.position.y, seed: node.data.seed })]));
  for (const [arrival, index] of [0, 2, 1].entries()) {
    graph = placeRunOutput(graph, { runId: run.id, nodeId: prompt.id, run, output: { index, caption: 'Bird' }, asset: `image-${index}`, dimensions: { width: 200, height: 100 } });
    run = graph.runs[0];
    const output = graph.nodes.find(node => node.id === `run-output-${index}`);
    const match = matchingPlaceholder(slots, output.data.runId, output.position, 100);
    assert.equal(match.id, `run-pending-${arrival}`);
    slots.delete(match.id);
    assert.ok(graph.nodes.every(node => node.type !== 'pending'));
    assert.ok(graph.nodes.every(node => !Object.hasOwn(node.data, 'clip') && !Object.hasOwn(node.data, 'reveal')));
  }
  assert.equal(slots.size, 0);
});

test('a first nonzero variant preserves real placement and skips a reveal when it misses shown slots', () => {
  const prompt = { id: 'prompt', type: 'text', position: { x: 30, y: 50 }, data: { text: 'A bird', aspect: .5 } };
  const run = { id: 'run', nodeId: 'prompt', status: 'running', provider: 'nano-banana', variants: 3, outputIds: [] };
  const graph = { nodes: [prompt], edges: [], groups: [], runs: [run], revision: 0 };
  const slots = new Map(runPlaceholders(graph, [run], 'page-1').nodes.map(node => [node.id, slot({ id: node.id, x: node.position.x, y: node.position.y })]));
  const next = placeRunOutput(graph, { runId: run.id, nodeId: prompt.id, run, output: { index: 2, caption: 'Bird' }, asset: 'image-2', dimensions: { width: 200, height: 100 } });
  const output = next.nodes.find(node => node.id === 'run-output-2');
  assert.deepEqual(output.position, { x: 420, y: 730 });
  assert.equal(matchingPlaceholder(slots, run.id, output.position, 100), undefined);
});

test('the reveal JSX, image readiness wiring and CSS parse without a browser or build output', () => {
  for (const file of ['ImageReveal.jsx', 'PendingNode.jsx', 'main.jsx', 'style.css']) {
    const loader = file.endsWith('.css') ? 'css' : 'jsx';
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    assert.doesNotThrow(() => transformSync(source, { loader, target: 'es2022' }));
  }
});
