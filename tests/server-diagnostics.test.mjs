import test from 'node:test';
import { generationSettings } from '../graph.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('diagnostics stream while running, are bounded, and survive restart and export', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'concept-diagnostics-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
  };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  const start = async () => {
    const env = { ...process.env, PORT: '0', CONCEPT_GRAPH_DATA: dir, CODEX_BIN: fileURLToPath(new URL('./fixtures/codex-diagnostics.mjs', import.meta.url)) };
    delete env.CONCEPT_GRAPH_DESKTOP; delete env.CONCEPT_GRAPH_SITE; delete env.CONCEPT_GRAPH_HELPER_TOKEN;
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', stdout = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const port = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`server exited ${code}: ${stderr}`)));
      child.stdout.on('data', chunk => { stdout += chunk; const match = stdout.match(/ready at http:\/\/127\.0\.0\.1:(\d+)/); if (match) resolve(match[1]); });
    });
    return `http://127.0.0.1:${port}`;
  };
  let base = await start();
  const call = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const value = await response.json(); assert.ok(response.ok, `${method} ${route}: ${value.error}`); return value;
  };
  const workspace = await call('/api/workspace');
  const route = `/api/boards/${workspace.defaultBoardId}`;
  const node = { id: 'prompt', type: 'text', position: { x: 0, y: 0 }, data: { text: 'A bird', model: 'legacy-model', effort: 'high' } };
  await call(route + '/graph', 'PUT', { revision: 0, nodes: [node], edges: [] });
  const stream = await fetch(base + route + '/events');
  const reader = stream.body.getReader();
  let received = '', sawRunning = false;
  const read = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
      if (received.includes('image_started') && received.includes('agent_message')) sawRunning = true;
    }
  })();
  await call(route + '/runs', 'POST', { nodeId: node.id, revision: 1 });
  let graph;
  for (let i = 0; i < 100; i++) {
    graph = (await call(route)).board.graph;
    if (graph.runs[0]?.status === 'completed') break;
    await delay(30);
  }
  assert.equal(graph.runs[0].status, 'completed');
  assert.equal(sawRunning, true);
  await reader.cancel(); await read;
  const diagnostics = graph.runs[0].diagnostics;
  assert.equal(diagnostics.model, generationSettings.model); assert.equal(diagnostics.effort, generationSettings.effort);
  assert.equal(diagnostics.requestedModel, generationSettings.model); assert.equal(diagnostics.requestedEffort, generationSettings.effort);
  assert.equal(graph.runs[0].target.data.model, 'legacy-model');
  assert.equal(diagnostics.truncated, true);
  assert.equal(diagnostics.events.find(event => event.type === 'agent_message').text.length, 4000);
  assert.equal(diagnostics.events.filter(event => event.type === 'agent_message').length, 2, 'interleaved completed message must not be duplicated');
  assert.ok(diagnostics.events.some(event => event.type === 'image_completed'), 'tool events survive exhausted chat budget');
  assert.deepEqual(Object.fromEntries(Object.entries(diagnostics.events.find(event => event.type === 'image_completed')).filter(([key]) => ['status', 'hasInlineResult', 'hasSavedPath', 'hasFileId'].includes(key))), {
    status: 'completed', hasInlineResult: true, hasSavedPath: false, hasFileId: false,
  });
  assert.ok(diagnostics.events.some(event => event.type === 'turn_completed'), 'final outcome survives exhausted chat budget');
  assert.equal(diagnostics.usage.inputTokens, 100);
  assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE_PROMPT'));
  const archive = await fetch(base + route + '/export'); assert.equal(archive.status, 200);
  const bytes = await archive.arrayBuffer();
  const imported = await fetch(base + '/api/boards/import', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: bytes });
  assert.equal(imported.status, 201);
  const importedId = (await imported.json()).board.id;
  assert.deepEqual((await call(`/api/boards/${importedId}`)).board.graph.runs[0].diagnostics, diagnostics);
  await stop(); base = await start();
  assert.deepEqual((await call(route)).board.graph.runs[0].diagnostics, diagnostics);
});
