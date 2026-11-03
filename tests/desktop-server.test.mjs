import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('desktop server reports its ephemeral port and accepts only local hosts', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-desktop-server-'));
  const env = { ...process.env, PORT: '0', CONCEPT_GRAPH_DESKTOP: '1', CONCEPT_GRAPH_DATA: directory, CODEX_BIN: path.join(root, 'tests/fixtures/codex.mjs'), CONCEPT_GRAPH_TEST_DELAY_MS: '3000' };
  delete env.CONCEPT_GRAPH_SITE;
  delete env.CONCEPT_GRAPH_HELPER_TOKEN;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
    await rm(directory, { recursive: true, force: true });
  });
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const match = stdout.match(/Concept Graph is ready at http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
  });
  assert.ok(port > 0);
  const url = `http://127.0.0.1:${port}/api/workspace`;
  const workspaceResponse = await fetch(url);
  assert.equal(workspaceResponse.status, 200);
  const { defaultBoardId } = await workspaceResponse.json();
  const setupResponse = await fetch(`http://127.0.0.1:${port}/api/desktop/mcp-setup`);
  assert.equal(setupResponse.status, 200);
  assert.equal(setupResponse.headers.get('cache-control'), 'no-store');
  const setup = await setupResponse.json();
  assert.equal(setup.platform, process.platform);
  assert.equal(setup.command, process.execPath);
  assert.deepEqual(setup.args, [path.join(root, 'mcp.mjs')]);
  assert.equal(typeof setup.available, 'boolean');
  const status = await new Promise((resolve, reject) => {
    const req = request(url, { headers: { Host: 'example.invalid' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  const created = await fetch(`http://127.0.0.1:${port}/api/boards`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Saved before quit' }) });
  assert.equal(created.status, 201);
  const board = await created.json();
  const boardURL = `http://127.0.0.1:${port}/api/boards/${board.id}`;
  const graph = { revision: 0, nodes: [{ id: 'prompt', type: 'text', position: { x: 0, y: 0 }, data: { text: 'Test' } }], edges: [] };
  assert.equal((await fetch(boardURL + '/graph', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(graph) })).status, 200);
  assert.equal((await fetch(boardURL + '/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeId: 'prompt', revision: 1 }) })).status, 202);
  const otherBoard = await (await fetch(`http://127.0.0.1:${port}/api/boards/${defaultBoardId}`)).json();
  assert.equal(otherBoard.board.graph.runs.length, 0);
  const desktopStatus = await (await fetch(`http://127.0.0.1:${port}/api/desktop/status`)).json();
  assert.equal(desktopStatus.activeRuns, true);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdin.end();
  assert.equal(await exited, 0);
  const workspace = JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8'));
  const saved = workspace.boards.find(item => item.id === board.id);
  assert.equal(saved.name, 'Saved before quit');
  assert.ok(['completed', 'cancelled'].includes(saved.graph.runs[0].status));
});

test('desktop preferences survive a restart on a different port and reject invalid changes', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-desktop-preferences-'));
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await exited;
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const start = async () => {
    const env = { ...process.env, PORT: '0', CONCEPT_GRAPH_DESKTOP: '1', CONCEPT_GRAPH_DATA: directory, CODEX_BIN: path.join(root, 'tests/fixtures/codex.mjs') };
    delete env.CONCEPT_GRAPH_SITE;
    delete env.CONCEPT_GRAPH_HELPER_TOKEN;
    const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '', stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const port = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Server exited ${code}: ${stderr}`)));
      child.stdout.on('data', chunk => {
        stdout += chunk;
        const match = stdout.match(/Concept Graph is ready at http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) resolve(Number(match[1]));
      });
    });
    return { child, port, url: `http://127.0.0.1:${port}` };
  };
  const stop = async child => {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end();
    assert.equal(await exited, 0);
  };
  const first = await start();
  let response = await fetch(first.url + '/api/workspace');
  assert.deepEqual((await response.json()).desktopPreferences, { theme: 'light', boardId: null });
  response = await fetch(first.url + '/api/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Remember me' }) });
  const board = await response.json();
  const write = value => fetch(first.url + '/api/desktop/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await write({ theme: 'dark', boardId: board.id })).status, 200);
  assert.equal((await write({ theme: 'blue', boardId: board.id })).status, 400);
  assert.equal((await write({ theme: 'light', boardId: '00000000-0000-0000-0000-000000000000' })).status, 400);
  assert.equal((await write({ theme: 'light', boardId: board.id, extra: true })).status, 400);
  await stop(first.child);
  let second = await start();
  if (second.port === first.port) { await stop(second.child); second = await start(); }
  assert.notEqual(second.port, first.port);
  response = await fetch(second.url + '/api/workspace');
  assert.deepEqual((await response.json()).desktopPreferences, { theme: 'dark', boardId: board.id });
  await stop(second.child);
});
