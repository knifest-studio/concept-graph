import test from 'node:test';
import assert from 'node:assert/strict';
import { Codex } from '../codex.mjs';

test('generation emits selected diagnostic fields without raw image data', async () => {
  const codex = new Codex('/tmp');
  codex.connect = async () => {};
  codex.status = async () => ({ signedIn: true, imageGeneration: true });
  const notifications = [];
  const emit = (method, params) => codex.emit('notification', { method, params: { threadId: 'thread', ...params } });
  codex.request = async method => {
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start') return { thread: { id: 'thread' }, model: 'test-model', reasoningEffort: 'medium' };
    if (method === 'turn/start') {
      setImmediate(() => {
        emit('item/agentMessage/delta', { itemId: 'message', delta: 'Working' });
        emit('item/completed', { item: { id: 'message', type: 'agentMessage', text: 'Working' } });
        emit('item/started', { item: { id: 'image', type: 'imageGeneration' } });
        emit('item/completed', { item: { id: 'image', type: 'imageGeneration', result: 'PRIVATE_IMAGE_BYTES', savedPath: '/private/image.png', revisedPrompt: 'PRIVATE_PROMPT' } });
        emit('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 50, outputTokens: 10 } } });
        emit('turn/completed', { turn: { status: 'completed' } });
      });
      return { turn: { id: 'turn' } };
    }
    return {};
  };
  await codex.generate({ prompt: 'test', images: [], onDiagnostic: event => notifications.push(event), onImage: async () => {} });
  assert.deepEqual(notifications.map(event => event.type), ['thread', 'worker_context', 'turn_started', 'agent_delta', 'agent_completed', 'image_started', 'image_completed', 'usage', 'turn_completed']);
  assert.equal(notifications[0].model, 'test-model');
  assert.equal(notifications[0].effort, 'medium');
  const serialized = JSON.stringify(notifications);
  for (const privateValue of ['PRIVATE_IMAGE_BYTES', '/private/image.png', 'PRIVATE_PROMPT']) assert.ok(!serialized.includes(privateValue));
});

test('image failure exposes its type and not the raw image payload', async () => {
  const codex = new Codex('/tmp');
  codex.connect = async () => {};
  codex.status = async () => ({ signedIn: true, imageGeneration: true });
  codex.request = async method => {
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/start') {
      setImmediate(() => codex.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item: { type: 'imageGeneration', failure: { type: 'usageLimitExceeded', secret: 'PRIVATE' } } } }));
      return { turn: { id: 'turn' } };
    }
    return {};
  };
  const diagnostics = [];
  await assert.rejects(codex.generate({ prompt: 'test', images: [], onDiagnostic: event => diagnostics.push(event) }), /usage limit/);
  assert.deepEqual(diagnostics.find(event => event.type === 'image_failed'), {
    type: 'image_failed', text: 'usageLimitExceeded; status=unknown; inline=false; saved=false; fileId=false',
    status: 'unknown', hasInlineResult: false, hasSavedPath: false, hasFileId: false,
  });
  assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE'));
});

test('completed-only agent text is preserved if the worker produces no image', async () => {
  const codex = new Codex('/tmp');
  codex.connect = async () => {};
  codex.status = async () => ({ signedIn: true, imageGeneration: true });
  codex.request = async method => {
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/start') {
      setImmediate(() => {
        codex.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item: { id: 'm1', type: 'agentMessage', text: 'No image is available.' } } });
        codex.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
      });
      return { turn: { id: 'turn' } };
    }
    return {};
  };
  const diagnostics = [];
  await assert.rejects(codex.generate({ prompt: 'test', images: [], onDiagnostic: event => diagnostics.push(event) }), /No image is available/);
  assert.equal(diagnostics.find(event => event.type === 'agent_completed').text, 'No image is available.');
});

test('failed turns report safe structured errors and redacted URLs', async () => {
  const codex = new Codex('/tmp');
  codex.connect = async () => {};
  codex.status = async () => ({ signedIn: true, imageGeneration: true });
  codex.request = async method => {
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/start') {
      setImmediate(() => codex.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'failed', error: { codexErrorInfo: 'modelNotFound', message: 'Failed https://example.com/?secret=123 at /private/file.json' } } } }));
      return { turn: { id: 'turn' } };
    }
    return {};
  };
  const diagnostics = [];
  await assert.rejects(codex.generate({ prompt: 'test', images: [], onDiagnostic: event => diagnostics.push(event) }), /Failed/);
  assert.equal(diagnostics.find(event => event.type === 'error').text, 'modelNotFound: Failed [URL] at [path]');
  assert.equal(diagnostics.find(event => event.type === 'turn_completed').text, 'failed');
});

test('tool statuses and missing output formats are not mistaken for successful images or agent claims', async () => {
  const cases = [
    { item: { status: 'failed' }, kind: 'image_failed', reason: /image generator refused this request/ },
    { item: { status: 'completed', result: '' }, kind: 'image_completed', reason: /finished without returning image bytes/ },
    { item: { status: 'completed', result: '', fileId: 'PRIVATE_FILE_ID' }, kind: 'image_completed', reason: /output format is not supported/ },
  ];
  for (const { item, kind, reason } of cases) {
    const codex = new Codex('/tmp');
    codex.connect = async () => {};
    codex.status = async () => ({ signedIn: true, imageGeneration: true });
    codex.request = async method => {
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start') return { thread: { id: 'thread' } };
      if (method === 'turn/start') {
        setImmediate(() => {
          codex.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item: { id: 'image', type: 'imageGeneration', ...item } } });
          codex.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item: { id: 'agent', type: 'agentMessage', text: 'Agent claims the generator rejected it.' } } });
          codex.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
        });
        return { turn: { id: 'turn' } };
      }
      return {};
    };
    const diagnostics = [];
    await assert.rejects(codex.generate({ prompt: 'test', images: [], onImage: () => assert.fail('No supported image output'), onDiagnostic: event => diagnostics.push(event) }), reason);
    const event = diagnostics.find(event => event.type === kind);
    assert.equal(event.status, item.status);
    assert.equal(event.hasInlineResult, false);
    assert.equal(event.hasSavedPath, false);
    assert.equal(event.hasFileId, Boolean(item.fileId));
    assert.match(diagnostics.find(event => event.type === 'agent_completed').text, /Agent claims/);
    assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_FILE_ID'));
  }
});

test('a failed image item can be followed by a successful retry while retaining both outcomes', async () => {
  const codex = new Codex('/tmp');
  codex.connect = async () => {};
  codex.status = async () => ({ signedIn: true, imageGeneration: true });
  codex.request = async method => {
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start') return { thread: { id: 'thread' } };
    if (method === 'turn/start') {
      setImmediate(() => {
        for (const item of [
          { id: 'failed-image', type: 'imageGeneration', status: 'failed' },
          { id: 'image', type: 'imageGeneration', status: 'completed', result: 'PRIVATE_IMAGE_BYTES' },
        ]) codex.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item } });
        codex.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
      });
      return { turn: { id: 'turn' } };
    }
    return {};
  };
  const diagnostics = [], images = [];
  const result = await codex.generate({ prompt: 'test', images: [], onImage: async item => images.push(item), onDiagnostic: event => diagnostics.push(event) });
  assert.equal(result.count, 1);
  assert.equal(images[0].id, 'image');
  assert.equal(diagnostics.find(event => event.type === 'image_failed').status, 'failed');
  assert.equal(diagnostics.find(event => event.type === 'image_completed').hasInlineResult, true);
  assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_IMAGE_BYTES'));
});
