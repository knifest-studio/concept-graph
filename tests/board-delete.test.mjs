import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('a local board is deleted only with its exact name, and the last one is replaced by an empty board', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-delete-test-'));
  const env = { ...process.env, PORT: '0', CONCEPT_GRAPH_DATA: directory, CODEX_BIN: path.join(root, 'tests/fixtures/codex.mjs') };
  delete env.CONCEPT_GRAPH_DESKTOP; delete env.CONCEPT_GRAPH_SITE; delete env.CONCEPT_GRAPH_HELPER_TOKEN;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; } await rm(directory, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error(`server exited ${code}`)));
    child.stdout.on('data', bytes => { const match = bytes.toString().match(/ready at http:\/\/127\.0\.0\.1:(\d+)/); if (match) resolve(match[1]); });
  });
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  const first = (await api('/api/workspace')).value.boards[0], second = (await api('/api/boards', 'POST', { name: 'Robots' })).value;
  assert.equal((await api(`/api/boards/${second.id}`, 'DELETE', {})).status, 400);
  assert.equal((await api(`/api/boards/${second.id}`, 'DELETE', { confirmName: 'robots' })).status, 400);
  const deleted = await api(`/api/boards/${second.id}`, 'DELETE', { confirmName: 'Robots' });
  assert.equal(deleted.status, 200); assert.deepEqual(deleted.value.boards.map(board => board.id), [first.id]);
  assert.equal((await api(`/api/boards/${second.id}`)).status, 404);
  const last = await api(`/api/boards/${first.id}`, 'DELETE', { confirmName: first.name });
  assert.equal(last.value.boards.length, 1); assert.notEqual(last.value.boards[0].id, first.id);
  assert.equal(last.value.defaultBoardId, last.value.boards[0].id);
});
