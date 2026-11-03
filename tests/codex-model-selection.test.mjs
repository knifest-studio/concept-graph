import test from 'node:test';
import assert from 'node:assert/strict';
import { Codex } from '../codex.mjs';
import { collectInputs, validateGraph, generationSettings } from '../graph.mjs';

const entry = (model, efforts, extra = {}) => ({ model, id: `id-${model}`, displayName: model, isDefault: false,
  defaultReasoningEffort: efforts[0], supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: '' })), ...extra });

test('model list returns the model identifiers and supported efforts across pages', async () => {
  const codex = new Codex('/tmp'); codex.connect = async () => {};
  const calls = [];
  codex.request = async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { data: [entry('second', ['medium'], { isDefault: true })], nextCursor: null }
      : { data: [entry('first', ['low', 'high']), entry('hidden', ['low'], { hidden: true })], nextCursor: 'page-two' };
  };
  const { models } = await codex.models();
  assert.deepEqual(models.map(model => model.id), ['first', 'second']);
  assert.deepEqual(models[0].supportedReasoningEfforts.map(option => option.reasoningEffort), ['low', 'high']);
  assert.equal(models[1].isDefault, true);
  assert.equal(calls[1].params.cursor, 'page-two');
});

test('legacy node settings remain loadable while app generation uses fixed settings', async () => {
  assert.deepEqual(generationSettings, { model: 'gpt-6-luna', effort: 'low' });
  assert.equal(Object.isFrozen(generationSettings), true);
  const node = { id: 'prompt', type: 'text', position: { x: 0, y: 0 }, data: { text: 'A bird', model: 'first', effort: 'high' } };
  const inputs = collectInputs({ nodes: [node], edges: [] }, node.id);
  node.data.model = 'second'; node.data.effort = 'medium';
  assert.equal(inputs.target.data.model, 'first');
  assert.equal(inputs.target.data.effort, 'high');
  for (const [field, value] of [['model', '../bad model'], ['effort', '']]) {
    const invalid = structuredClone(node); invalid.data[field] = value;
    assert.throws(() => validateGraph({ nodes: [invalid], edges: [] }), /Invalid/);
  }

  const codex = new Codex('/tmp'); codex.connect = async () => {}; codex.status = async () => ({ signedIn: true, imageGeneration: true });
  const calls = [];
  codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'model/list') return { data: [entry('first', ['low']), entry(generationSettings.model, [generationSettings.effort])], nextCursor: null };
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start') return { thread: { id: 'thread' }, model: 'first' };
    if (method === 'turn/start') {
      setImmediate(() => {
        codex.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item: { type: 'imageGeneration', id: 'img', result: 'image' } } });
        codex.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
      });
      return { turn: { id: 'turn' } };
    }
    return {};
  };
  await codex.generate({ prompt: inputs.prompt, images: [], ...generationSettings, onImage: async () => {} });
  assert.equal(calls.find(call => call.method === 'thread/start').params.model, generationSettings.model);
  assert.equal(calls.find(call => call.method === 'turn/start').params.model, generationSettings.model);
  assert.equal(calls.find(call => call.method === 'turn/start').params.effort, generationSettings.effort);
  await assert.rejects(codex.generate({ prompt: 'x', images: [], model: 'first', effort: 'ultra' }), /not supported/);
  await assert.rejects(codex.generate({ prompt: 'x', images: [], effort: 'ultra' }), /not supported/);
  calls.length = 0;
  await codex.generate({ prompt: 'x', images: [], onImage: async () => {} });
  const turn = calls.find(call => call.method === 'turn/start').params;
  assert.equal(Object.hasOwn(turn, 'model'), false);
  assert.equal(Object.hasOwn(turn, 'effort'), false);
});
