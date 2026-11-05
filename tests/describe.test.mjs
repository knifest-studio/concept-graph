import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { collectInputs, validateGraph } from '../graph.mjs';
import { placeRunText, runOutputId } from '../src/run-outputs.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=', 'base64');
const asset = '12345678-1234-1234-1234-123456789abc.png';
const image = id => ({ id, type: 'image', position: { x: 0, y: 0 }, data: { asset, caption: 'Robot' } });
const describer = (text = '') => ({ id: 'describe', type: 'text', position: { x: 400, y: 0 }, data: { text, task: 'describe' } });

test('a describe node asks for a description of its images and keeps its focus out of the prompts it feeds', () => {
  assert.throws(() => collectInputs({ nodes: [describer()], edges: [] }, 'describe'), /Connect an image to describe/);
  const graph = { nodes: [image('a'), describer(), { id: 'next', type: 'text', position: { x: 800, y: 0 }, data: { text: 'A poster' } }],
    edges: [{ id: 'e1', source: 'a', target: 'describe' }, { id: 'e2', source: 'describe', target: 'next' }] };
  const inputs = collectInputs(graph, 'describe');
  assert.equal(inputs.task, 'describe');
  assert.deepEqual(inputs.images, [asset]);
  assert.match(inputs.prompt, /Describe the attached images in detail/); assert.match(inputs.prompt, /Image 1: Robot/);
  assert.doesNotMatch(inputs.prompt, /FOCUS/);
  graph.nodes[1] = describer('Only the lighting');
  assert.match(collectInputs(graph, 'describe').prompt, /FOCUS:\nOnly the lighting/);
  assert.doesNotMatch(collectInputs(graph, 'next').prompt, /lighting/);
  assert.equal(collectInputs(graph, 'next').task, undefined);
  assert.throws(() => validateGraph({ nodes: [{ ...describer(), data: { text: '', task: 'caption' } }], edges: [] }), /Invalid node task/);
});

test('a finished cloud description becomes one text node beside its describe node', () => {
  const before = { nodes: [image('a'), describer()], edges: [{ id: 'e1', source: 'a', target: 'describe' }], groups: [], runs: [] };
  const run = { id: 'run', nodeId: 'describe', status: 'running', task: 'describe', by: { name: 'Ann' } };
  const graph = placeRunText(before, { runId: 'run', nodeId: 'describe', run, author: { name: 'Ann' }, text: '  A robot.  ' });
  const node = graph.nodes.find(item => item.id === runOutputId('run', 0));
  assert.deepEqual([node.type, node.data.text, node.data.runId], ['text', 'A robot.', 'run']);
  assert.ok(node.position.x > before.nodes[1].position.x);
  assert.ok(graph.edges.some(edge => edge.source === 'describe' && edge.target === node.id));
  assert.deepEqual(graph.runs[0].outputIds, [node.id]);
  validateGraph(graph);
  assert.equal(placeRunText(graph, { runId: 'run', nodeId: 'describe', run: graph.runs[0], text: 'Again' }), null);
});

test('the local app writes a Codex description into a new text node', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-describe-test-'));
  const env = { ...process.env, PORT: '0', CONCEPT_GRAPH_DATA: directory, CODEX_BIN: path.join(root, 'tests/fixtures/codex.mjs'), CONCEPT_GRAPH_TEST_DELAY_MS: '20' };
  delete env.CONCEPT_GRAPH_DESKTOP; delete env.CONCEPT_GRAPH_SITE; delete env.CONCEPT_GRAPH_HELPER_TOKEN;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; } await rm(directory, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error(`server exited ${code}`)));
    child.stdout.on('data', bytes => { const match = bytes.toString().match(/ready at http:\/\/127\.0\.0\.1:(\d+)/); if (match) resolve(match[1]); });
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  assert.ok((await api('/api/status', 'POST')).value.features.includes('describe'));
  const uploaded = (await (await fetch(base + '/api/assets', { method: 'POST', body: png })).json()).asset;
  const board = (await api('/api/workspace')).value.defaultBoardId;
  const nodes = [{ ...image('a'), data: { asset: uploaded } }, describer()];
  assert.equal((await api(`/api/boards/${board}/graph`, 'PUT', { revision: 0, nodes, edges: [{ id: 'e1', source: 'a', target: 'describe' }] })).status, 200);
  assert.equal((await api(`/api/boards/${board}/runs`, 'POST', { nodeId: 'describe', revision: 1 })).status, 202);
  let graph;
  for (let i = 0; i < 200; i++) {
    graph = (await api(`/api/boards/${board}`)).value.board.graph;
    if (graph.runs[0]?.status === 'completed') break;
    await delay(30);
  }
  const [run] = graph.runs;
  assert.deepEqual([run.status, run.task, run.label, run.message], ['completed', 'describe', 'Describe image', 'Description written']);
  const output = graph.nodes.find(node => node.id === run.outputIds[0]);
  assert.deepEqual([output.type, output.data.text], ['text', 'A small grey square on a plain background.']);
  assert.ok(graph.edges.some(edge => edge.source === 'describe' && edge.target === output.id));
  assert.equal(graph.groups?.length || 0, 0);
});
