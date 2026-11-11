import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mergeAddedGroups } from '../src/canvas.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

async function setup(t, prompt) {
  const dir = await mkdtemp(path.join(tmpdir(), 'concept-groups-'));
  const release = path.join(dir, 'release');
  let child, base;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
  }
  t.after(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });
  async function start() {
    const env = { ...process.env, PORT: '0', CONCEPT_GRAPH_DATA: dir, CODEX_BIN: path.join(root, 'tests/fixtures/codex-groups.mjs'), CONCEPT_GROUP_TEST_RELEASE: release };
    delete env.CONCEPT_GRAPH_DESKTOP; delete env.CONCEPT_GRAPH_SITE; delete env.CONCEPT_GRAPH_HELPER_TOKEN;
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '', output = '';
    child.stderr.on('data', data => { errors += data; });
    const port = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => reject(new Error(`server exited ${code}: ${errors}`)));
      child.stdout.on('data', data => { output += data; const match = output.match(/ready at http:\/\/127\.0\.0\.1:(\d+)/); if (match) resolve(match[1]); });
    });
    base = `http://127.0.0.1:${port}`;
  }
  await start();
  async function tryCall(route, method = 'GET', value) {
    const response = await fetch(base + route, { method, ...(value === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }) });
    return { response, body: await response.json() };
  }
  async function call(route, method = 'GET', value) {
    const { response, body } = await tryCall(route, method, value);
    assert.ok(response.ok, `${method} ${route}: ${body.error}`); return body;
  }
  const board = (await call('/api/workspace')).defaultBoardId, route = `/api/boards/${board}`;
  const node = { id: 'prompt', type: 'text', position: { x: 0, y: 0 }, data: { text: prompt } };
  await call(route + '/graph', 'PUT', { revision: 0, nodes: [node], edges: [], groups: [] });
  const graph = async () => (await call(route)).board.graph;
  const run = async () => call(route + '/runs', 'POST', { revision: (await graph()).revision, nodeId: node.id });
  async function waitFor(predicate) {
    for (let n = 0; n < 300; n++) { const value = await graph(); if (predicate(value)) return value; await delay(20); }
    assert.fail('Timed out waiting for generation state');
  }
  const terminal = id => waitFor(g => g.runs.some(r => r.id === id && ['completed', 'error', 'cancelled'].includes(r.status)));
  const events = async () => {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(base + route + '/events', { signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '';
    return async predicate => {
      while (true) {
        while (buffer.includes('\n\n')) {
          const at = buffer.indexOf('\n\n'), message = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (!message.startsWith('event: graph\n')) continue;
          const value = JSON.parse(message.slice('event: graph\ndata: '.length));
          if (predicate(value)) return value;
        }
        const { value, done } = await reader.read();
        assert.equal(done, false, 'event stream closed');
        buffer += decoder.decode(value, { stream: true });
      }
    };
  };
  return { call, tryCall, graph, route, run, terminal, waitFor, events, release: () => writeFile(release, 'continue'), restart: async () => { await stop(); await start(); } };
}

const runById = (graph, id) => graph.runs.find(run => run.id === id);
function assertGroupFor(graph, expected) {
  const groups = graph.groups.filter(group => expected.some(id => group.nodeIds.includes(id)));
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].nodeIds].sort(), [...expected].sort());
  assert.ok(groups[0].nodeIds.every(id => graph.nodes.find(node => node.id === id)?.type === 'image'));
}

test('results are grouped during generation and later images join the same group', { timeout: 15000 }, async t => {
  const app = await setup(t, 'PROGRESSIVE'), nextEvent = await app.events(), run = await app.run();
  let graph = await nextEvent(g => runById(g, run.id)?.outputIds.length === 2);
  assert.equal(runById(graph, run.id).status, 'running');
  const firstTwo = runById(graph, run.id).outputIds;
  assertGroupFor(graph, firstTwo);
  const groupId = graph.groups.find(g => g.nodeIds.includes(firstTwo[0])).id;
  await app.release(); graph = await nextEvent(g => runById(g, run.id)?.outputIds.length === 3);
  assert.equal(graph.groups.find(g => g.id === groupId).nodeIds.length, 3);
  graph = await app.terminal(run.id);
  assert.equal(runById(graph, run.id).outputIds.length, 3);
  assertGroupFor(graph, runById(graph, run.id).outputIds);
  assert.equal(graph.groups.find(g => g.id === groupId).nodeIds.length, 3);
  await app.restart(); graph = await app.graph();
  assertGroupFor(graph, runById(graph, run.id).outputIds);
});

test('ungrouping during a run is respected when further images arrive', { timeout: 15000 }, async t => {
  const app = await setup(t, 'PROGRESSIVE'), run = await app.run();
  let graph = await app.waitFor(g => runById(g, run.id)?.outputIds.length === 2);
  assertGroupFor(graph, runById(graph, run.id).outputIds);
  graph.groups = [];
  await app.call(app.route + '/graph', 'PUT', graph);
  await app.release(); graph = await app.terminal(run.id);
  assert.equal(runById(graph, run.id).outputIds.length, 3);
  assert.deepEqual(graph.groups, []);
  await app.restart(); graph = await app.graph();
  assert.deepEqual(graph.groups, []);
});

test('an in-progress automatic group survives a restart without duplication', { timeout: 15000 }, async t => {
  const app = await setup(t, 'HOLD'), run = await app.run();
  let graph = await app.waitFor(g => runById(g, run.id)?.outputIds.length === 2);
  assert.equal(runById(graph, run.id).status, 'running');
  assertGroupFor(graph, runById(graph, run.id).outputIds);
  const id = graph.groups[0].id;
  await app.restart(); graph = await app.graph();
  assertGroupFor(graph, runById(graph, run.id).outputIds);
  assert.equal(graph.groups.length, 1);
  assert.equal(graph.groups[0].id, id);
});

test('manually regrouped results stay put while later outputs join the run group', { timeout: 15000 }, async t => {
  const app = await setup(t, 'PROGRESSIVE'), run = await app.run();
  let graph = await app.waitFor(g => runById(g, run.id)?.outputIds.length === 2);
  const [first, second] = runById(graph, run.id).outputIds;
  const group = graph.groups.find(g => g.nodeIds.includes(first));
  group.nodeIds = [second];
  graph.groups.push({ id: 'manual', name: 'Manual', nodeIds: ['prompt', first], collapsed: false });
  await app.call(app.route + '/graph', 'PUT', graph);
  await app.release(); graph = await app.terminal(run.id);
  const third = runById(graph, run.id).outputIds[2];
  assert.deepEqual(graph.groups.find(g => g.id === 'manual').nodeIds, ['prompt', first]);
  assert.deepEqual(graph.groups.find(g => g.id === group.id).nodeIds, [second, third]);
});

test('a stale local edit merges a new output into its existing group before retrying', { timeout: 15000 }, async t => {
  const app = await setup(t, 'PROGRESSIVE'), run = await app.run();
  const base = await app.waitFor(g => runById(g, run.id)?.outputIds.length === 2);
  const local = structuredClone(base);
  local.nodes.find(n => n.id === 'prompt').data.text = 'User edited prompt';
  await app.release();
  await app.terminal(run.id);
  const conflict = await app.tryCall(app.route + '/graph', 'PUT', local);
  assert.equal(conflict.response.status, 409);
  const remote = conflict.body.graph;
  const known = new Set(base.nodes.map(n => n.id));
  const nodes = [...local.nodes, ...remote.nodes.filter(n => !known.has(n.id))];
  const edgeIds = new Set(local.edges.map(e => e.id));
  const edges = [...local.edges, ...remote.edges.filter(e => !edgeIds.has(e.id))];
  const groups = mergeAddedGroups(local.groups, remote.groups, base.groups, nodes);
  await app.call(app.route + '/graph', 'PUT', { revision: remote.revision, nodes, edges, groups, viewport: local.viewport });
  const saved = await app.graph();
  assert.equal(saved.nodes.find(n => n.id === 'prompt').data.text, 'User edited prompt');
  assertGroupFor(saved, runById(saved, run.id).outputIds);
});

test('a single output is not grouped; repeated multi-image runs get separate persistent groups', { timeout: 15000 }, async t => {
  const app = await setup(t, 'ONE');
  let run = await app.run(), graph = await app.terminal(run.id);
  assert.equal(runById(graph, run.id).outputIds.length, 1);
  assert.equal(graph.nodes.find(node => node.id === runById(graph, run.id).outputIds[0]).data.caption, 'Image 1');
  assert.deepEqual(graph.groups, []);
  graph.nodes.find(node => node.id === 'prompt').data.text = 'TWO';
  await app.call(app.route + '/graph', 'PUT', graph);
  const first = await app.run(); graph = await app.terminal(first.id);
  const firstIds = runById(graph, first.id).outputIds;
  assert.equal(firstIds.length, 2); assertGroupFor(graph, firstIds);
  assert.deepEqual(firstIds.map(id => graph.nodes.find(node => node.id === id).data.caption), ['Image 2', 'Image 3']);
  assert.equal(runById(graph, first.id).captionMissing, 2);
  const second = await app.run(); graph = await app.terminal(second.id);
  const secondIds = runById(graph, second.id).outputIds;
  assert.equal(secondIds.length, 2); assertGroupFor(graph, firstIds); assertGroupFor(graph, secondIds);
  assert.deepEqual(secondIds.map(id => graph.nodes.find(node => node.id === id).data.caption), ['Image 4', 'Image 5']);
  assert.notEqual(graph.groups.find(g => g.nodeIds.includes(firstIds[0])).id, graph.groups.find(g => g.nodeIds.includes(secondIds[0])).id);
  const groups = structuredClone(graph.groups);
  await app.restart(); graph = await app.graph();
  assert.deepEqual(graph.groups, groups);
  assertGroupFor(graph, firstIds); assertGroupFor(graph, secondIds);
});

for (const [mode, expected] of [['ERROR', 'error'], ['HOLD', 'cancelled']]) {
  test(`partial images stay grouped after ${expected}`, { timeout: 15000 }, async t => {
    const app = await setup(t, mode), run = await app.run();
    let graph = await app.waitFor(g => runById(g, run.id)?.outputIds.length === 2);
    if (mode === 'HOLD') await app.call(`${app.route}/runs/${run.id}/cancel`, 'POST', {});
    graph = await app.terminal(run.id);
    assert.equal(runById(graph, run.id).status, expected);
    assertGroupFor(graph, runById(graph, run.id).outputIds);
    assert.deepEqual(runById(graph, run.id).outputIds.map(id => graph.nodes.find(node => node.id === id).data.caption), ['Image 1', 'Image 2']);
    assert.equal(runById(graph, run.id).captionMissing, 2);
  });
}

for (const action of ['group', 'delete']) {
  test(`generation respects an output ${action === 'group' ? 'manually grouped' : 'deleted'} while running`, { timeout: 15000 }, async t => {
    const app = await setup(t, 'STAGED'), run = await app.run();
    let graph = await app.waitFor(g => runById(g, run.id)?.outputIds.length === 1);
    const first = runById(graph, run.id).outputIds[0];
    if (action === 'group') graph.groups.push({ id: 'manual', name: 'Manual', nodeIds: ['prompt', first], collapsed: false });
    else { graph.nodes = graph.nodes.filter(node => node.id !== first); graph.edges = graph.edges.filter(edge => edge.target !== first && edge.source !== first); }
    await app.call(app.route + '/graph', 'PUT', graph);
    await app.release(); graph = await app.terminal(run.id);
    assert.equal(runById(graph, run.id).status, 'completed');
    const remaining = runById(graph, run.id).outputIds.filter(id => id !== first);
    assert.equal(remaining.length, 2); assertGroupFor(graph, remaining);
    if (action === 'group') assert.deepEqual(graph.groups.find(group => group.id === 'manual').nodeIds, ['prompt', first]);
    else assert.ok(!graph.nodes.some(node => node.id === first));
  });
}

for (const caption of ['Мій підпис', '']) {
  test(`a manually ${caption ? 'edited' : 'cleared'} first caption is not overwritten when more images arrive`, { timeout: 15000 }, async t => {
    const app = await setup(t, 'STAGED'), run = await app.run();
    let graph = await app.waitFor(g => runById(g, run.id)?.outputIds.length === 1);
    const first = runById(graph, run.id).outputIds[0];
    graph.nodes.find(node => node.id === first).data.caption = caption;
    await app.call(app.route + '/graph', 'PUT', graph);
    await app.release(); graph = await app.terminal(run.id);
    assert.deepEqual(runById(graph, run.id).outputIds.map(id => graph.nodes.find(node => node.id === id).data.caption), [caption, 'Image 1', 'Image 2']);
    assert.equal(runById(graph, run.id).captionMissing, 3);
  });
}
