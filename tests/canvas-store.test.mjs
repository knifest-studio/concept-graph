import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasStore, detailLevel, inputCounts, latestCommands, outsideViewport, runAuthor, runLookups, shallowEqual } from '../src/canvas-store.mjs';
import { sameShape } from '../src/layers.mjs';

test('canvas store notifies only when a published field changes', () => {
  const store = createCanvasStore({ detail: 'full', focusId: null });
  let calls = 0;
  const unsubscribe = store.subscribe(() => calls++);
  const before = store.get();
  assert.equal(store.update({ detail: 'full', focusId: null }), false);
  assert.equal(store.get(), before);
  assert.equal(store.update({ focusId: 'a' }), true);
  assert.deepEqual(store.get(), { detail: 'full', focusId: 'a' });
  assert.equal(calls, 1);
  unsubscribe(); store.update({ focusId: 'b' });
  assert.equal(calls, 1);
});

test('stable commands keep their identity and always run the latest implementation', () => {
  const latest = { current: { edit: () => 'first', remove: id => `remove ${id}` } };
  const commands = latestCommands(latest), edit = commands.edit;
  latest.current = { edit: () => 'second', remove: id => `drop ${id}` };
  assert.equal(commands.edit, edit);
  assert.equal(commands.edit(), 'second');
  assert.equal(commands.remove('n'), 'drop n');
});

test('run lookups give each node its latest run in one pass', () => {
  const runs = [{ id: 'r1', nodeId: 'a' }, { id: 'r2', nodeId: 'b' }, { id: 'r3', nodeId: 'a', by: { name: 'Ada' } }];
  const { latestRun, runById } = runLookups(runs);
  assert.equal(latestRun.get('a'), runs[2]);
  assert.equal(latestRun.get('b'), runs[1]);
  assert.equal(runById.get('r1'), runs[0]);
  assert.deepEqual(runAuthor({ runId: 'r3' }, runById), { name: 'Ada' });
  assert.deepEqual(runAuthor({ author: { name: 'Bo', color: '#2563eb' }, runId: 'r3' }, runById), { name: 'Bo', color: '#2563eb' });
  assert.equal(runAuthor({}, runById), undefined);
});

test('input counts survive moves and typing but follow new connections and node types', () => {
  const nodes = [{ id: 'i', type: 'image', data: {} }, { id: 'p', type: 'text', data: { text: '' } }], edges = [{ id: 'e', source: 'i', target: 'p' }];
  const first = inputCounts(nodes, edges);
  assert.deepEqual(first.counts.get('p'), { images: 1, text: 0 });
  const typed = nodes.map(node => node.id === 'p' ? { ...node, position: { x: 1, y: 1 }, data: { text: 'cat' } } : node);
  assert.equal(inputCounts(typed, edges, first).counts, first.counts);
  const linked = inputCounts(typed, [...edges, { id: 'f', source: 'p', target: 'p' }], first);
  assert.notEqual(linked.counts, first.counts);
  assert.equal(sameShape(nodes, [nodes[0], { ...nodes[1], type: 'image' }]), false);
  assert.equal(sameShape(nodes, [nodes[0], { ...nodes[1], z: 4 }]), false);
  assert.equal(sameShape(nodes, [nodes[1], nodes[0]]), false);
  assert.equal(sameShape(nodes, typed), true);
});

test('detail level switches with slack around each threshold', () => {
  assert.equal(detailLevel(1), 'full');
  assert.equal(detailLevel(.4, 'full'), 'full');
  assert.equal(detailLevel(.37, 'full'), 'low');
  assert.equal(detailLevel(.4, 'low'), 'low');
  assert.equal(detailLevel(.43, 'low'), 'full');
  assert.equal(detailLevel(.15, 'low'), 'low');
  assert.equal(detailLevel(.1, 'low'), 'tiny');
  assert.equal(detailLevel(.15, 'tiny'), 'tiny');
  assert.equal(detailLevel(.2, 'tiny'), 'low');
});

test('viewport test and shallow equality', () => {
  const node = { position: { x: 100, y: 100 }, measured: { width: 310, height: 80 } };
  assert.equal(outsideViewport(node, { x: 0, y: 0, zoom: 1 }, 800, 600), false);
  assert.equal(outsideViewport(node, { x: -500, y: 0, zoom: 1 }, 800, 600), true);
  assert.equal(outsideViewport(node, { x: 0, y: 0, zoom: .1 }, 5, 5), true);
  assert.equal(outsideViewport(node, { x: -1000, y: -1000, zoom: 10 }, 800, 600), false);
  assert.equal(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' }), true);
  assert.equal(shallowEqual({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(shallowEqual({ a: {} }, { a: {} }), false);
  assert.equal(shallowEqual(undefined, undefined), true);
  assert.equal(shallowEqual(null, {}), false);
});
