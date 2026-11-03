import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rename, mkdir, rmdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=', 'base64');

test('custom templates persist across boards and restarts; failures do not change saved templates or snapshots', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-template-test-'));
  let child, base;
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
  };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const start = async () => {
    const env = { ...process.env, PORT: '0', CONCEPT_GRAPH_DATA: directory, CODEX_BIN: path.join(root, 'tests/fixtures/codex.mjs') };
    delete env.CONCEPT_GRAPH_DESKTOP; delete env.CONCEPT_GRAPH_SITE; delete env.CONCEPT_GRAPH_HELPER_TOKEN;
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', bytes => { errors += bytes.toString(); });
    const port = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => reject(new Error(`server exited ${code}: ${errors}`)));
      child.stdout.on('data', bytes => { const match = bytes.toString().match(/ready at http:\/\/127\.0\.0\.1:(\d+)/); if (match) resolve(match[1]); });
    });
    base = `http://127.0.0.1:${port}`;
  };
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  await start();
  assert.deepEqual((await api('/api/templates')).value, { templates: [] });
  const upload = await fetch(base + '/api/assets', { method: 'POST', body: png });
  assert.equal(upload.status, 200);
  const { asset } = await upload.json();
  const body = { name: 'Multiview', instructions: 'Front, back and side views', assets: [asset] };
  const created = await Promise.all(Array.from({ length: 4 }, (_, i) => api('/api/templates', 'POST', { ...body, name: `Preset ${i}` })));
  assert.ok(created.every(result => result.status === 201));
  const id = created[0].value.template.id;
  assert.equal((await api('/api/templates')).value.templates.length, 4);
  assert.equal((await api('/api/templates', 'POST', { ...body, assets: ['../../secret'] })).status, 400);
  assert.equal((await api('/api/templates', 'POST', { ...body, assets: ['00000000-0000-0000-0000-000000000000.png'] })).status, 404);
  assert.equal((await api('/api/templates')).value.templates.length, 4);

  // An atomic write failure must leave the in-memory library untouched and future requests usable.
  const file = path.join(directory, 'templates.json'), saved = file + '.saved';
  await rename(file, saved); await mkdir(file);
  assert.equal((await api('/api/templates', 'POST', body)).status, 400);
  assert.equal((await api('/api/templates')).value.templates.length, 4);
  await rmdir(file); await rename(saved, file);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).templates.length, 4);
  const updated = await api(`/api/templates/${id}`, 'PUT', { ...body, expected: created[0].value.template });
  assert.equal(updated.status, 200); assert.equal(updated.value.template.name, 'Multiview');
  assert.equal((await api(`/api/templates/${id}`, 'PUT', { ...body, expected: created[0].value.template })).status, 409);

  const board = (await api('/api/workspace')).value.defaultBoardId;
  const node = { id: 'test-custom', type: 'text', position: { x: 0, y: 0 }, data: { text: '', template: { name: body.name, instructions: body.instructions, assets: body.assets } } };
  const bad = structuredClone(node); bad.data.template.assets = ['00000000-0000-0000-0000-000000000000.png'];
  assert.notEqual((await api(`/api/boards/${board}/graph`, 'PUT', { revision: 0, nodes: [bad], edges: [] })).status, 200);
  assert.equal((await api(`/api/boards/${board}/graph`, 'PUT', { revision: 0, nodes: [node], edges: [] })).status, 200);
  assert.equal((await api(`/api/templates/${id}`, 'DELETE', { expected: created[0].value.template })).status, 409);
  assert.equal((await api(`/api/templates/${id}`, 'DELETE', { expected: updated.value.template })).status, 200);
  assert.equal((await api(`/api/boards/${board}/runs`, 'POST', { nodeId: node.id, revision: 1 })).status, 202);
  let graph;
  for (let i = 0; i < 100; i++) {
    graph = (await api(`/api/boards/${board}`)).value.board.graph;
    if (graph.runs[0]?.status === 'completed') break;
    await delay(30);
  }
  assert.equal(graph.runs[0].status, 'completed');
  assert.match(graph.runs[0].prompt, /Front, back and side views/);
  assert.deepEqual(graph.runs[0].images, [asset]);
  assert.deepEqual(graph.runs[0].target.data.template, node.data.template);
  assert.equal((await fetch(base + '/assets/' + asset)).status, 200);
  await stop(); await start();
  assert.equal((await api('/api/templates')).value.templates.length, 3);
  const after = (await api(`/api/boards/${board}`)).value.board.graph;
  assert.deepEqual(after.nodes.find(item => item.id === node.id).data.template, node.data.template);
  assert.deepEqual(after.runs[0].target.data.template, node.data.template);
});
