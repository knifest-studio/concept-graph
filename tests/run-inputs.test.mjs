import test from 'node:test';
import assert from 'node:assert/strict';
import { maxRunInputs, runInputList, runInputRecord, validateRunInputs } from '../graph.mjs';

const asset = n => `${String(n).padStart(8, '0')}-1111-1111-1111-111111111111.png`;
const board = () => ({ nodes: [
  { id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: 'A courier robot' } },
  { id: 'style', type: 'text', position: { x: -400, y: 200 }, data: { text: '', template: { name: 'Style', instructions: 'Warm light', assets: [asset(9), asset(8)] } } },
  { id: 'front', type: 'image', position: { x: -400, y: 0 }, data: { asset: asset(1), caption: 'Front view' } },
  { id: 'side', type: 'image', position: { x: -400, y: 400 }, data: { asset: asset(2), label: 'side.png' } },
  { id: 'far', type: 'image', position: { x: -900, y: 0 }, data: { asset: asset(3), caption: 'Not connected' } },
], edges: [{ id: 'e1', source: 'style', target: 'p' }, { id: 'e2', source: 'front', target: 'p' }, { id: 'e3', source: 'side', target: 'p' }], groups: [], runs: [] });

test('a run records its connected images, their mask and its custom node references, never other nodes', () => {
  const graph = board();
  graph.nodes.find(node => node.id === 'front').data.mask = { asset: asset(4), marked: asset(5), base: asset(6), source: asset(1) };
  assert.deepEqual(runInputRecord(graph, 'p'), [
    { asset: asset(9), template: 'Style' }, { asset: asset(8), template: 'Style' },
    { nodeId: 'front', asset: asset(1), label: 'Front view', number: 1, mask: true }, { nodeId: 'side', asset: asset(2), label: 'side', number: 2 },
  ]);
  validateRunInputs(runInputRecord(graph, 'p'));
  // A prompt's own custom node references count too.
  graph.nodes[0].data.template = { name: 'Hero', instructions: '', assets: [asset(7)] };
  assert.deepEqual(runInputRecord(graph, 'p').at(-1), { asset: asset(7), template: 'Hero' });
});

test('GPT Image lists its main image first; descriptions drop masks; upscales and 3D list only images', () => {
  const graph = board(), prompt = graph.nodes[0];
  graph.nodes.find(node => node.id === 'side').data.mask = { asset: asset(4), marked: asset(5), base: asset(6), source: asset(2) };
  Object.assign(prompt.data, { generator: 'gpt-image', mainImage: 'side' });
  assert.deepEqual(runInputRecord(graph, 'p').map(input => input.nodeId || input.template), ['side', 'Style', 'Style', 'front']);
  assert.equal(runInputRecord(graph, 'p')[0].mask, true);
  delete prompt.data.generator; delete prompt.data.mainImage;
  prompt.data.task = 'describe';
  assert.equal(runInputRecord(graph, 'p').some(input => input.mask), false);
  for (const task of ['upscale', 'model3d']) {
    prompt.data.task = task;
    assert.deepEqual(runInputRecord(graph, 'p'), [{ nodeId: 'front', asset: asset(1), label: 'Front view' }, { nodeId: 'side', asset: asset(2), label: 'side' }], task);
  }
  // A prompt without images records an empty list, which the details show as "No reference images".
  assert.deepEqual(runInputRecord({ ...board(), edges: [] }, 'p'), []);
});

test('run inputs are optional, capped and strictly shaped; the details read only well-formed entries', () => {
  const good = { nodeId: 'front', asset: asset(1), label: 'Front view', mask: true };
  for (const value of [undefined, [], [good], [{ asset: asset(9), template: 'Style' }], Array(maxRunInputs).fill(good)]) assert.doesNotThrow(() => validateRunInputs(value));
  for (const value of [null, 'x', {}, Array(maxRunInputs + 1).fill(good), [null], [{}], [{ asset: '../outside.png' }], [{ ...good, extra: 1 }], [{ ...good, mask: false }],
    [{ ...good, nodeId: '' }], [{ ...good, nodeId: 'x'.repeat(121) }], [{ ...good, label: 'x'.repeat(121) }], [{ asset: asset(9), template: ' ' }], [{ asset: asset(9), template: 'x'.repeat(81) }], [[asset(1)]]]) {
    assert.throws(() => validateRunInputs(value), /Invalid generation inputs/, JSON.stringify(value)?.slice(0, 80));
  }
  assert.equal(runInputList({}), undefined); assert.equal(runInputList(undefined), undefined); assert.equal(runInputList({ inputs: 'x' }), undefined);
  assert.deepEqual(runInputList({ inputs: [good, { asset: 'bad' }, null, { ...good, nodeId: 'side' }] }), [good, { ...good, nodeId: 'side' }]);
  assert.equal(runInputList({ inputs: Array(40).fill(good) }).length, maxRunInputs);
});
