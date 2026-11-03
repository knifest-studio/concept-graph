import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Codex, generatedImageCaption } from '../codex.mjs';

test('captions are extracted only from one unambiguous valid marker', () => {
  assert.equal(generatedImageCaption('[[CG_CAPTION:Вид збоку]]\nportrait'), 'Вид збоку');
  for (const input of [null, '', 'No label', '[[CG_CAPTION:]]', '[[CG_CAPTION:bad\nline]]', '[[CG_CAPTION:a]][[CG_CAPTION:b]]', `[[CG_CAPTION:${'x'.repeat(121)}]]`, '[[CG_CAPTION:a\u0000b]]']) {
    assert.equal(generatedImageCaption(input), '');
  }
});

test('automatic caption instructions and out-of-order image events stay matched to their own prompt', async t => {
  const oldBin = process.env.CODEX_BIN, oldExpectation = process.env.EXPECT_CAPTION_INSTRUCTIONS;
  process.env.CODEX_BIN = fileURLToPath(new URL('./fixtures/codex-captions.mjs', import.meta.url));
  process.env.EXPECT_CAPTION_INSTRUCTIONS = '1';
  const codex = new Codex(process.cwd());
  t.after(() => {
    codex.close();
    if (oldBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = oldBin;
    if (oldExpectation === undefined) delete process.env.EXPECT_CAPTION_INSTRUCTIONS; else process.env.EXPECT_CAPTION_INSTRUCTIONS = oldExpectation;
  });
  const results = [];
  const result = await codex.generate({ prompt: 'Views', images: [], onImage: item => results.push([item.id, generatedImageCaption(item.revisedPrompt)]) });
  assert.equal(result.count, 3);
  assert.deepEqual(results, [['side', 'Вид збоку'], ['front', 'Вид спереду'], ['missing', '']]);
});

test('automatic captions and legacy template preferences survive restart', { timeout: 15000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'concept-caption-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  let child;
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
  };
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  const start = async () => {
    const env = { ...process.env, PORT: '0', CONCEPT_GRAPH_DATA: dir, CODEX_BIN: fileURLToPath(new URL('./fixtures/codex-captions.mjs', import.meta.url)) };
    delete env.CONCEPT_GRAPH_DESKTOP; delete env.CONCEPT_GRAPH_SITE; delete env.CONCEPT_GRAPH_HELPER_TOKEN; delete env.EXPECT_CAPTION_INSTRUCTIONS;
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '', output = '';
    child.stderr.on('data', data => { errors += data; });
    const port = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => reject(new Error(`server exited ${code}: ${errors}`)));
      child.stdout.on('data', data => { output += data; const match = output.match(/ready at http:\/\/127\.0\.0\.1:(\d+)/); if (match) resolve(match[1]); });
    });
    return `http://127.0.0.1:${port}`;
  };
  let base = await start();
  const call = async (route, method = 'GET', value) => {
    const response = await fetch(base + route, { method, ...(value === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) });
    const body = await response.json(); assert.ok(response.ok, `${method} ${route}: ${body.error}`); return body;
  };
  const template = { name: 'Turnaround', instructions: 'Generate separate views', assets: [], labelOutputs: true };
  await call('/api/templates', 'POST', template);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'templates.json'), 'utf8')).version, 2);
  await stop(); base = await start();
  assert.equal((await call('/api/templates')).templates[0].labelOutputs, true);
  const board = (await call('/api/workspace')).defaultBoardId;
  const route = `/api/boards/${board}`;
  const node = { id: 'prompt', type: 'text', position: { x: 0, y: 0 }, data: { text: 'Views', labelOutputs: true } };
  await call(route + '/graph', 'PUT', { revision: 0, nodes: [node], edges: [] });
  await call(route + '/runs', 'POST', { revision: 1, nodeId: node.id });
  let graph;
  for (let n = 0; n < 100; n++) {
    graph = (await call(route)).board.graph;
    if (graph.runs[0]?.status === 'completed') break;
    await delay(25);
  }
  assert.equal(graph.runs[0].status, 'completed');
  assert.equal(graph.runs[0].captionMissing, 1);
  assert.deepEqual(graph.nodes.filter(n => n.type === 'image').map(n => n.data.caption || ''), ['Вид збоку', 'Вид спереду', 'Image 3']);
  assert.deepEqual(graph.groups.map(group => group.nodeIds), [graph.runs[0].outputIds]);
  // Legacy opt-out fields do not disable automatic captions.
  graph.nodes[0].data.labelOutputs = false;
  const saved = await call(route + '/graph', 'PUT', { revision: graph.revision, nodes: graph.nodes, edges: graph.edges });
  await call(route + '/runs', 'POST', { revision: saved.revision, nodeId: node.id });
  for (let n = 0; n < 100; n++) {
    graph = (await call(route)).board.graph;
    if (graph.runs[1]?.status === 'completed') break;
    await delay(25);
  }
  assert.equal(graph.runs[1].status, 'completed');
  assert.deepEqual(graph.runs[1].outputIds.map(id => graph.nodes.find(n => n.id === id)?.data.caption || ''), ['Вид збоку', 'Вид спереду', 'Image 3']);
  assert.deepEqual(graph.groups.map(group => group.nodeIds), graph.runs.map(run => run.outputIds));
  await stop(); base = await start();
  graph = (await call(route)).board.graph;
  assert.deepEqual(graph.runs[0].outputIds.map(id => graph.nodes.find(n => n.id === id)?.data.caption || ''), ['Вид збоку', 'Вид спереду', 'Image 3']);
  assert.deepEqual(graph.groups.map(group => group.nodeIds), graph.runs.map(run => run.outputIds));
  // Simulate a legacy run that crashed before its group was created.
  await stop();
  const workspaceFile = path.join(dir, 'workspace.json');
  const workspace = JSON.parse(await readFile(workspaceFile, 'utf8'));
  const storedGraph = workspace.boards.find(item => item.id === board).graph;
  storedGraph.runs[0].status = 'running';
  delete storedGraph.runs[0].autoGroupId;
  storedGraph.groups = storedGraph.groups.filter(group => !group.nodeIds.includes(storedGraph.runs[0].outputIds[0]));
  await writeFile(workspaceFile, JSON.stringify(workspace));
  base = await start(); graph = (await call(route)).board.graph;
  assert.equal(graph.runs[0].status, 'error');
  assert.deepEqual(graph.groups.map(group => group.nodeIds), [graph.runs[1].outputIds, graph.runs[0].outputIds]);
  // If the user ungrouped during an active run before a crash, do not recreate it.
  await stop();
  const ungrouped = JSON.parse(await readFile(workspaceFile, 'utf8'));
  const active = ungrouped.boards.find(item => item.id === board).graph;
  const removedGroupId = active.runs[0].autoGroupId;
  assert.ok(removedGroupId);
  active.runs[0].status = 'running';
  active.groups = active.groups.filter(group => group.id !== removedGroupId);
  await writeFile(workspaceFile, JSON.stringify(ungrouped));
  base = await start(); graph = (await call(route)).board.graph;
  assert.equal(graph.runs[0].status, 'error');
  assert.equal(graph.runs[0].autoGroupId, removedGroupId);
  assert.deepEqual(graph.groups.map(group => group.nodeIds), [graph.runs[1].outputIds]);
});
