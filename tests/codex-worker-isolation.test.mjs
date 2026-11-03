import test from 'node:test';
import assert from 'node:assert/strict';
import { Codex } from '../codex.mjs';

test('image runs disable inherited integrations without changing provider, authentication or supplied images', async () => {
  const inherited = { model_provider: 'account-provider', developer_instructions: 'Unrelated global guidance',
    mcp_servers: { 'server.with.dots': { command: 'external-program' }, 'quoted"server': { url: 'https://example.invalid' } } };
  const original = structuredClone(inherited);
  const codex = new Codex('/tmp');
  codex.connect = async () => {};
  codex.status = async () => ({ signedIn: true, imageGeneration: true });
  const calls = [];
  codex.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'config/read') return { config: inherited };
    if (method === 'thread/start') return { thread: { id: 'worker' } };
    if (method === 'turn/start') {
      setImmediate(() => {
        codex.emit('notification', { method: 'item/completed', params: { threadId: 'worker', item: { id: 'image', type: 'imageGeneration', status: 'completed', result: 'image' } } });
        codex.emit('notification', { method: 'turn/completed', params: { threadId: 'worker', turn: { status: 'completed' } } });
      });
      return { turn: { id: 'turn' } };
    }
    return {};
  };
  await codex.generate({ prompt: 'A bird', images: ['/tmp/reference.png'], onImage: async () => {} });
  const thread = calls.find(call => call.method === 'thread/start').params;
  const config = thread.config;
  assert.deepEqual(config.mcp_servers, { 'server.with.dots': { enabled: false }, 'quoted"server': { enabled: false } });
  for (const key of ['skills.include_instructions', 'skills.bundled.enabled', 'cloud.skills.enabled', 'orchestrator.mcp.enabled', 'features.plugins', 'features.apps', 'features.multi_agent', 'features.memories', 'features.shell_tool', 'features.browser_use', 'features.computer_use', 'features.js_repl', 'features.code_mode', 'features.code_mode_only', 'tools.update_plan.enabled']) assert.equal(config[key], false, key);
  assert.equal(config['features.skip_host_skill_discovery'], true);
  assert.equal(config.project_doc_max_bytes, 0);
  assert.equal(config.web_search, 'disabled');
  assert.equal(thread.developerInstructions, '');
  assert.equal(Object.hasOwn(config, 'model_provider'), false);
  assert.equal(Object.hasOwn(config, 'model_providers'), false);
  assert.equal(Object.hasOwn(config, 'forced_login_method'), false);
  assert.deepEqual(inherited, original);
  assert.deepEqual(calls.find(call => call.method === 'turn/start').params.input, [
    { type: 'text', text: 'A bird', text_elements: [] }, { type: 'localImage', path: '/tmp/reference.png' },
  ]);
});

test('invalid or unavailable configuration never falls back to an unisolated image run', async () => {
  for (const response of [{}, { config: [] }, { config: { mcp_servers: [] } }, new Error('Configuration unavailable')]) {
    const codex = new Codex('/tmp');
    codex.connect = async () => {};
    codex.status = async () => ({ signedIn: true, imageGeneration: true });
    const calls = [];
    codex.request = async method => {
      calls.push(method);
      if (method === 'config/read') {
        if (response instanceof Error) throw response;
        return response;
      }
      assert.fail(`Unexpected call after isolation failure: ${method}`);
    };
    await assert.rejects(codex.generate({ prompt: 'A bird', images: [], onImage: async () => {} }));
    assert.deepEqual(calls, ['config/read']);
  }
});
