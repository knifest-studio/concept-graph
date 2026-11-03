import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

test('queued MCP generation waits for its editor commit ACK even while another board is running', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'concept-mcp-queue-'));
  const env = { ...process.env, CONCEPT_GRAPH_DATA: dir, CONCEPT_GRAPH_DESKTOP: '1', CONCEPT_GRAPH_MCP_SESSION_FILE: path.join(dir, 'mcp-session.json'), PORT: '0', CODEX_BIN: path.resolve('tests/fixtures/codex.mjs'), CONCEPT_GRAPH_TEST_DELAY_MS: '1800' };
  delete env.CONCEPT_GRAPH_SITE; delete env.CONCEPT_GRAPH_HELPER_TOKEN;
  const child = spawn(process.execPath, ['server.mjs'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const streamAbort = new AbortController();
  t.after(async () => { streamAbort.abort(); if (child.exitCode === null && child.signalCode === null) { child.stdin.end(); await once(child, 'exit'); } await rm(dir, { recursive: true, force: true }); });
  const base = await new Promise((resolve, reject) => {
    let output = ''; child.on('error', reject); child.once('exit', () => reject(new Error('Server exited before startup.')));
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/ready at (http:\/\/127\.0\.0\.1:\d+)/); if (match) resolve(match[1]); });
  });
  const { token } = JSON.parse(await readFile(env.CONCEPT_GRAPH_MCP_SESSION_FILE, 'utf8'));
  const call = async (route, method = 'GET', body, auth = false) => {
    const response = await fetch(base + route, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { 'X-Concept-Graph-MCP-Token': token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    assert.ok(response.ok, `${route}: ${response.status} ${value.error || ''}`);
    return value;
  };
  const initial = await call('/api/workspace'), a = initial.defaultBoardId;
  const b = (await call('/api/boards', 'POST', { name: 'Synthetic B' })).id;
  const graph = id => ({ revision: 0, nodes: [{ id, type: 'text', position: { x: 0, y: 0 }, data: { text: 'Synthetic prompt' } }], edges: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 } });
  await call(`/api/boards/${a}/graph`, 'PUT', graph('node-a'));
  await call(`/api/boards/${b}/graph`, 'PUT', graph('node-b'));
  await call(`/api/boards/${a}/runs`, 'POST', { nodeId: 'node-a', revision: 1 });
  const editor = (await call('/api/desktop/editors', 'POST', { boardId: b })).editorId;
  const response = await fetch(`${base}/api/boards/${b}/events?editor=${editor}`, { signal: streamAbort.signal });
  assert.ok(response.ok);
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  async function event(name) {
    for (;;) {
      while (buffer.includes('\n\n')) {
        const i = buffer.indexOf('\n\n'), frame = buffer.slice(0, i); buffer = buffer.slice(i + 2);
        const kind = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
        if (kind === name) return JSON.parse(data);
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('Editor stream ended.');
      buffer += decoder.decode(value, { stream: true });
    }
  }
  await event('graph');
  await call(`/api/desktop/editors/${editor}/ready`, 'POST', { revision: 1 });
  const startB = call(`/api/mcp/boards/${b}/runs`, 'POST', { nodeId: 'node-b', revision: 1 }, true);
  const prepare = await event('mcp-prepare');
  await call(`/api/desktop/editors/${editor}/ack`, 'POST', { id: prepare.id, phase: 'prepared', revision: 1 });
  const commit = await event('mcp-commit');
  assert.equal(commit.graph.runs[0].status, 'queued');
  let persisted;
  for (let i = 0; i < 180; i++) {
    persisted = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
    if (persisted.boards.find(board => board.id === a).graph.runs[0]?.status === 'completed') break;
    await delay(25);
  }
  assert.equal(persisted.boards.find(board => board.id === a).graph.runs[0].status, 'completed');
  await delay(100);
  persisted = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
  assert.equal(persisted.boards.find(board => board.id === b).graph.runs[0].status, 'queued');
  await call(`/api/desktop/editors/${editor}/ack`, 'POST', { id: commit.id, phase: 'applied', revision: commit.graph.revision });
  const result = await startB;
  assert.equal(result.applied, true); assert.equal(result.uiSynchronized, true);
  for (let i = 0; i < 180; i++) {
    persisted = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
    if (persisted.boards.find(board => board.id === b).graph.runs[0]?.status === 'completed') break;
    await delay(25);
  }
  assert.equal(persisted.boards.find(board => board.id === b).graph.runs[0].status, 'completed');
});
