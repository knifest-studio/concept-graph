import test from 'node:test';
import assert from 'node:assert/strict';
import { observePendingSpawns, pendingAnimation, pendingTiming, pendingPulseKeyframes } from '../src/pending-animation.mjs';
import { runPlaceholders } from '../src/run-placeholders.mjs';

const graph = { nodes: [{ id: 'prompt', type: 'text', position: { x: 0, y: 0 }, data: { text: 'A comet' } }], edges: [], groups: [] };
const run = (extra = {}) => ({ id: 'run', nodeId: 'prompt', status: 'queued', outputIds: [], by: { name: 'Knifest' }, ...extra });
const observe = (runs, options = {}, seen = new Map(), board = graph) => observePendingSpawns(seen, board, runs, { now: 100, live: true, userName: 'Knifest', ...options });

test('C1 timing contract and the 900ms pulse flight within its 1500ms period', () => {
  assert.deepEqual(pendingTiming, { stagger: 150, fresh: 2500, fly: 460, impact: 440, ring: 520, splash: 420, fade: 90, pop: 340, pulseWait: 900, pulseFlight: 900, pulsePeriod: 1500 });
  assert.ok(Object.isFrozen(pendingTiming));
  assert.match(pendingPulseKeyframes, /60%,100%\{offset-distance:100%\}/);
});

test('live own queued and running jobs spawn, local jobs need no author', () => {
  for (const status of ['queued', 'running']) {
    assert.equal(observe([run({ status })]).get('run').get('run-pending-0'), 100);
    assert.equal(observe([run({ status, by: undefined })], { local: true }).get('run').size, 1);
  }
});

test('initial loads, reconnect snapshots, peers, missing authors and terminal runs stay still', () => {
  const cases = [[run(), { live: false }], [run({ by: { name: 'Teammate' } }), {}], [run({ by: undefined }), {}], [run(), { userName: undefined }],
    ...['completed', 'cancelled', 'failed', 'error'].map(status => [run({ status }), {}])];
  for (const [job, options] of cases) {
    const seen = observe([job], options);
    assert.equal(seen.get('run').size, 0);
    assert.equal(observe([run()], { now: 200 }, seen), seen);
  }
});

test('server clock skew never affects freshness or stagger', () => {
  for (const startedAt of ['1990-01-01', '2099-01-01', undefined]) {
    const job = run({ startedAt, provider: 'nano-banana', variants: 4 });
    assert.deepEqual([...observe([job]).get('run')], [0, 1, 2, 3].map(index => [`run-pending-${index}`, 100 + index * 150]));
  }
});

test('stagger restarts per run and indexes its initial placeholders, even after partial output', () => {
  const first = run({ provider: 'nano-banana', variants: 4, outputIds: ['already-produced'] }), second = run({ id: 'second', provider: 'nano-banana', variants: 2 });
  const seen = observe([first, second]);
  assert.deepEqual([...seen.get('run').values()], [100, 250, 400]);
  assert.deepEqual([...seen.get('second').values()], [100, 250]);
});

test('rerenders, queued-to-running, undo and later Codex slots never renew the initial claim', () => {
  const job = run(), seen = observe([job]), later = { ...job, status: 'running', outputIds: ['real'] };
  assert.equal(observe([later], { now: 200 }, seen), seen);
  assert.equal(observe([], {}, seen), seen);
  assert.equal(observe([job], { now: 300 }, seen), seen);
  const projected = runPlaceholders(graph, [later], 'page-1', seen);
  assert.equal(projected.nodes[0].data.spawnAt, undefined);
  assert.equal(projected.edges[0].data.spawnAt, undefined);
});

test('node and edge share their clock; waiting videos and placement remain unchanged', () => {
  const job = run({ provider: 'nano-banana', variants: 3 }), seen = observe([job]);
  const before = runPlaceholders(graph, [job], 'page-1'), after = runPlaceholders(graph, [job], 'page-1', seen);
  for (let index = 0; index < 3; index++) {
    const node = after.nodes[index], edge = after.edges[index];
    assert.equal(edge.type, 'pending'); assert.equal(edge.className, 'pending-edge');
    assert.equal(node.data.spawnAt, 100 + index * 150); assert.equal(edge.data.spawnAt, node.data.spawnAt);
    assert.equal(node.data.clip, before.nodes[index].data.clip);
    assert.deepEqual(node.position, before.nodes[index].position); assert.deepEqual(node.style, before.nodes[index].style);
  }
});

test('later variant slots remain static and existing stagger survives partial completion', () => {
  const job = run({ provider: 'nano-banana', variants: 2 }), seen = observe([job]);
  const later = { ...job, variants: 3, outputIds: ['real'] };
  const projected = runPlaceholders(graph, [later], 'page-1', observe([later], { now: 900 }, seen));
  assert.deepEqual(projected.nodes.map(node => node.data.spawnAt), [250, undefined]);
});

test('mount delays catch up to the shared clock; late mounts and reduced motion do not spawn', () => {
  const first = pendingAnimation(1000, 1000), later = pendingAnimation(1000, 1150);
  assert.equal(first.spawn, true); assert.equal(first.style['--pending-impact'], '440ms');
  assert.equal(first.style['--pending-pulse-delay'], '1340ms');
  assert.equal(later.style['--pending-delay'], '-150ms'); assert.equal(later.style['--pending-impact'], '290ms');
  assert.equal(later.style['--pending-pulse-delay'], '1190ms');
  assert.equal(pendingAnimation(1000, 3501).spawn, false);
  assert.equal(pendingAnimation(1450, 3501).spawn, true);
  assert.equal(pendingAnimation(1000, 1000, true).spawn, false);
  assert.equal(pendingAnimation(undefined, 1000).spawn, false);
});

test('off-page initial slots keep their original clock and inputs are not mutated', () => {
  const board = structuredClone(graph); board.nodes[0].page = 'two'; board.pages = [{ id: 'page-1', name: 'One' }, { id: 'two', name: 'Two' }];
  const job = run({ page: 'two' }), snapshot = structuredClone({ board, job }), previous = new Map();
  const seen = observe([job], {}, previous, board);
  assert.equal(previous.size, 0); assert.deepEqual({ board, job }, snapshot);
  assert.equal(runPlaceholders(board, [job], 'page-1', seen).nodes.length, 0);
  const node = runPlaceholders(board, [job], 'two', seen).nodes[0];
  assert.equal(node.data.spawnAt, 100); assert.equal(pendingAnimation(node.data.spawnAt, 3000).spawn, false);
});
