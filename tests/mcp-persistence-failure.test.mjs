import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

test('failed workspace write remains fail-stopped across concurrent requests and later filesystem recovery', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'concept-mcp-failstop-'));
  const env = { ...process.env, CONCEPT_GRAPH_DATA: dir, CONCEPT_GRAPH_DESKTOP: '1', PORT: '0', CODEX_BIN: path.resolve('tests/fixtures/codex.mjs') };
  delete env.CONCEPT_GRAPH_MCP_SESSION_FILE; delete env.CONCEPT_GRAPH_SITE; delete env.CONCEPT_GRAPH_HELPER_TOKEN;
  const server = spawn(process.execPath, ['server.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { if (server.exitCode === null && server.signalCode === null) { server.stdin.end(); await once(server, 'exit'); } await rm(dir, { recursive: true, force: true }); });
  let output = '';
  const base = await new Promise((resolve, reject) => {
    server.on('error', reject); server.once('exit', () => reject(new Error('Server exited before it was ready.')));
    server.stdout.on('data', chunk => { output += chunk; const match = output.match(/ready at (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolve(match[1]); });
  });
  const original = await readFile(path.join(dir, 'workspace.json'));
  const initial = await (await fetch(base + '/api/workspace')).json();
  const boardId = initial.defaultBoardId;
  await mkdir(path.join(dir, 'workspace.json.tmp'));
  const request = (url, method, value) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const graph = { revision: 0, nodes: [{ id: 'synthetic', type: 'text', position: { x: 0, y: 0 }, data: { text: 'synthetic' } }], edges: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const responses = await Promise.all([
    request('/api/boards', 'POST', { name: 'Synthetic A' }),
    request('/api/boards', 'POST', { name: 'Synthetic B' }),
    request(`/api/boards/${boardId}/graph`, 'PUT', graph),
  ]);
  for (const response of responses) { assert.ok(!response.ok); assert.equal(typeof (await response.json()).error, 'string'); }
  await rm(path.join(dir, 'workspace.json.tmp'), { recursive: true });
  const afterRepair = await request('/api/boards', 'POST', { name: 'Synthetic C' });
  assert.ok(!afterRepair.ok); assert.match((await afterRepair.json()).error, /storage failed earlier/i);
  assert.deepEqual(await readFile(path.join(dir, 'workspace.json')), original);
});
