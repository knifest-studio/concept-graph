import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, mkdir, copyFile, chmod, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { authorizeHelper } from '../helper-auth.mjs';
import { generationSettings } from '../graph.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sites = ['https://concept-graph-local.knifest.chatgpt.site', 'http://localhost:8787'];
const token = 'cloud-test-token';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=', 'base64');

test('helper authorization accepts a comma-separated origin list and still requires the header token', () => {
  const url = new URL('http://127.0.0.1:43170/api/cloud-jobs?token=' + token);
  const allowed = (origin, supplied, method = 'GET') => authorizeHelper({ method, headers: { origin, 'x-concept-graph-token': supplied } }, url, sites.join(', '), token);
  for (const origin of sites) {
    assert.equal(allowed(origin, token), true);
    assert.equal(allowed(origin, ''), false);
    assert.equal(allowed(origin, '', 'OPTIONS'), true);
  }
  assert.equal(allowed('https://attacker.example', token), false);
  assert.equal(allowed('http://localhost:87870', token), false);
  assert.equal(allowed(undefined, '', 'OPTIONS'), false);
});

async function helperServer(t, script = 'server.mjs', helper = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-cloud-jobs-'));
  const fixture = path.join(directory, 'codex-cloud-jobs.mjs');
  await copyFile(path.join(root, 'tests/fixtures/codex-cloud-jobs.mjs'), fixture);
  await chmod(fixture, 0o755);
  let child, base, output = '';
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); await exited;
  };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const start = async () => {
    const env = { ...process.env, PORT: '0', CONCEPT_GRAPH_DATA: directory, CODEX_BIN: fixture };
    delete env.CONCEPT_GRAPH_DESKTOP; delete env.CONCEPT_GRAPH_MCP_SESSION_FILE;
    delete env.CONCEPT_GRAPH_SITE; delete env.CONCEPT_GRAPH_HELPER_TOKEN;
    if (helper) { env.CONCEPT_GRAPH_SITE = sites.join(', '); env.CONCEPT_GRAPH_HELPER_TOKEN = token; }
    child = spawn(process.execPath, [script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    output = '';
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    base = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Helper exited ${code}: ${errors}`)));
      child.stdout.on('data', data => {
        output += data;
        const match = output.match(/ready at (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) resolve(match[1]);
      });
    });
  };
  await start();
  const request = (route, method = 'GET', value, headers = {}) => fetch(base + route, {
    method, headers: { ...(helper ? { Origin: sites[0], 'X-Concept-Graph-Token': script === 'helper.mjs' ? output.match(/connection code: ([a-f0-9]{64})/)?.[1] : token } : {}),
      ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const call = async (...args) => {
    const response = await request(...args);
    const value = await response.json();
    assert.ok(response.ok, `${args[0]}: ${response.status} ${value.error}`);
    return value;
  };
  const wait = async (route, ready) => {
    let value;
    for (let n = 0; n < 200; n++) {
      value = await call(route);
      if (ready(value)) return value;
      await delay(25);
    }
    assert.fail(`Timed out waiting for ${route}: ${JSON.stringify(value)}`);
  };
  return { directory, request, call, wait, stop, start, output: () => output };
}

const newJob = (overrides = {}) => ({ jobId: randomUUID(), boardId: randomUUID(), nodeId: 'prompt', prompt: 'WITH_INPUT',
  images: [{ asset: randomUUID() + '.png', data: png.toString('base64') }], ...overrides });
const jobRoute = id => '/api/cloud-jobs/' + id;

test('cloud jobs validate, persist, queue with local runs, cancel and acknowledge outputs', { timeout: 30000 }, async t => {
  const { directory, request, call, wait, stop, start } = await helperServer(t);
  const jobDirectory = id => path.join(directory, 'cloud-jobs', id);
  const completed = id => wait(jobRoute(id), job => job.status === 'completed');
  const running = id => wait(jobRoute(id), job => job.status === 'running' && job.progress === 'Generating image…');

  await t.test('both origins can preflight DELETE; wrong tokens and origins are rejected', async () => {
    for (const origin of sites) {
      const response = await request('/api/cloud-jobs', 'OPTIONS', undefined, {
        Origin: origin, 'X-Concept-Graph-Token': '', 'Access-Control-Request-Method': 'DELETE',
        'Access-Control-Request-Headers': 'x-concept-graph-token',
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.match(response.headers.get('access-control-allow-methods'), /\bDELETE\b/);
      assert.match(response.headers.get('access-control-allow-headers'), /x-concept-graph-token/i);
      assert.equal(response.headers.get('vary'), 'Origin');
      assert.equal((await request('/api/cloud-jobs', 'GET', undefined, { Origin: origin })).status, 200);
    }
    for (const headers of [{ 'X-Concept-Graph-Token': '' }, { 'X-Concept-Graph-Token': 'wrong' }, { Origin: 'https://attacker.example' }]) {
      assert.equal((await request('/api/cloud-jobs', 'GET', undefined, headers)).status, 403);
      assert.equal((await request('/api/cloud-jobs', 'POST', newJob(), headers)).status, 403);
    }
    const rejected = await request('/api/cloud-jobs', 'OPTIONS', undefined, { Origin: 'https://attacker.example' });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  });

  let first;
  await t.test('create is idempotent, passes input files to Codex and returns downloadable PNGs', async () => {
    const input = newJob(); first = input.jobId;
    const responses = await Promise.all([request('/api/cloud-jobs', 'POST', input), request('/api/cloud-jobs', 'POST', input)]);
    for (const response of responses) { assert.equal(response.status, 202); assert.equal((await response.json()).job.id, first); }
    const job = await completed(first);
    assert.equal(job.boardId, input.boardId); assert.equal(job.nodeId, input.nodeId);
    assert.ok(job.startedAt); assert.ok(job.finishedAt); assert.ok(job.elapsedMs >= 0);
    assert.equal(job.model, generationSettings.model); assert.equal(job.effort, generationSettings.effort);
    assert.deepEqual(job.outputs, [{ index: 0, format: 'png' }]);
    assert.equal(job.prompt, undefined); assert.equal(job.images, undefined);
    const output = await request(jobRoute(first) + '/outputs/0');
    assert.equal(output.status, 200); assert.equal(output.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await output.arrayBuffer()), png);
    assert.equal((await request(jobRoute(first) + '/outputs/1')).status, 404);
    assert.equal((await request(jobRoute(first) + '/outputs/0', 'GET', undefined, { 'X-Concept-Graph-Token': '' })).status, 403);
    const duplicate = (await call('/api/cloud-jobs', 'POST', { jobId: first })).job;
    assert.deepEqual(duplicate, job);
    assert.equal((await call('/api/cloud-jobs')).jobs.filter(item => item.id === first).length, 1);
    const stored = JSON.parse(await readFile(path.join(jobDirectory(first), 'job.json'), 'utf8'));
    assert.equal(stored.status, 'completed'); assert.deepEqual(stored.outputs, job.outputs);
    // Completion can be observed just before temporary input cleanup finishes.
    for (let n = 0; n < 100 && (await readdir(jobDirectory(first))).some(name => name.startsWith('input-')); n++) await delay(10);
    assert.equal((await readdir(jobDirectory(first))).some(name => name.startsWith('input-')), false);
  });

  await t.test('invalid jobs and non-image base64 leave no job directories', async () => {
    for (const overrides of [
      { jobId: '../escape' }, { boardId: 'not-a-uuid' }, { nodeId: '' }, { prompt: ' ' }, { prompt: 'x'.repeat(150001) },
      { model: '../model?' }, { effort: 'invalid effort' }, { labelOutputs: 'yes' }, { images: Array(11).fill({}) },
      { images: [{ asset: randomUUID() + '.png', data: Buffer.from('not an image').toString('base64') }] },
      { images: [{ asset: '../escape.png', data: png.toString('base64') }] },
      { images: [{ asset: randomUUID() + '.png', data: '!!!!' }] },
    ]) {
      const input = newJob(overrides);
      assert.equal((await request('/api/cloud-jobs', 'POST', input)).status, 400);
      if (/^[\da-f-]{36}$/.test(input.jobId)) await assert.rejects(stat(jobDirectory(input.jobId)), { code: 'ENOENT' });
    }
  });

  await t.test('multiple outputs use generated captions and fallback labels even with labelOutputs false', async () => {
    const { job } = await call('/api/cloud-jobs', 'POST', newJob({ prompt: 'MULTI', images: [], labelOutputs: false }));
    const result = await completed(job.id);
    assert.deepEqual(result.outputs.map(output => output.caption), ['Image 1', 'Вид збоку', 'Image 3']);
  });

  await t.test('cloud jobs ignore legacy model and effort overrides', async () => {
    const { job } = await call('/api/cloud-jobs', 'POST', newJob({ prompt: 'ONE', images: [], model: 'legacy-model', effort: 'high' }));
    await completed(job.id);
    const saved = JSON.parse(await readFile(path.join(jobDirectory(job.id), 'job.json'), 'utf8'));
    assert.equal(saved.model, generationSettings.model); assert.equal(saved.effort, generationSettings.effort);
  });

  await t.test('cloud input requests can exceed the local JSON body limit', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024); png.copy(bytes);
    const input = newJob({ prompt: 'ONE', images: [{ asset: randomUUID() + '.png', data: bytes.toString('base64') }] });
    const { job } = await call('/api/cloud-jobs', 'POST', input);
    assert.equal((await completed(job.id)).outputs.length, 1);
  });

  await t.test('generation failures remain collectable and do not block the next job', async () => {
    const failed = (await call('/api/cloud-jobs', 'POST', newJob({ prompt: 'FAIL', images: [] }))).job;
    const next = (await call('/api/cloud-jobs', 'POST', newJob())).job;
    const result = await wait(jobRoute(failed.id), job => job.status === 'failed');
    assert.match(result.error, /Synthetic cloud generation failure/);
    assert.ok(result.finishedAt); assert.deepEqual(result.outputs, []);
    await completed(next.id);
  });

  await t.test('running jobs cancel; queued jobs can be cancelled and deleted before generation', async () => {
    const held = (await call('/api/cloud-jobs', 'POST', newJob({ prompt: 'HOLD', images: [] }))).job;
    await running(held.id);
    const queued = (await call('/api/cloud-jobs', 'POST', newJob())).job;
    assert.equal((await call(jobRoute(queued.id))).status, 'queued');
    await call(jobRoute(queued.id) + '/cancel', 'POST');
    assert.equal((await call(jobRoute(queued.id))).status, 'cancelled');
    await call(jobRoute(queued.id), 'DELETE');
    await assert.rejects(stat(jobDirectory(queued.id)), { code: 'ENOENT' });
    await call(jobRoute(held.id) + '/cancel', 'POST');
    const cancelled = await call(jobRoute(held.id));
    assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.finishedAt);
    assert.deepEqual(cancelled.outputs, []);
    await call(jobRoute(held.id) + '/cancel', 'POST');
    const next = (await call('/api/cloud-jobs', 'POST', newJob())).job;
    await completed(next.id);
    const deleting = (await call('/api/cloud-jobs', 'POST', newJob({ prompt: 'HOLD', images: [] }))).job;
    await running(deleting.id);
    await call(jobRoute(deleting.id), 'DELETE');
    assert.equal((await request(jobRoute(deleting.id))).status, 404);
    await assert.rejects(stat(jobDirectory(deleting.id)), { code: 'ENOENT' });
  });

  await t.test('cloud and local runs use one generation slot in both directions', async () => {
    const boardId = (await call('/api/workspace')).defaultBoardId;
    const route = `/api/boards/${boardId}`;
    const node = { id: 'local-prompt', type: 'text', position: { x: 0, y: 0 }, data: { text: 'HOLD' } };
    await call(route + '/graph', 'PUT', { revision: 0, nodes: [node], edges: [] });
    const local = await call(route + '/runs', 'POST', { nodeId: node.id, revision: 1 });
    await wait(route, value => value.board.graph.runs[0].message === 'Generating image…');
    const cloud = (await call('/api/cloud-jobs', 'POST', newJob())).job;
    assert.equal((await call(jobRoute(cloud.id))).status, 'queued');
    await call(route + `/runs/${local.id}/cancel`, 'POST');
    await completed(cloud.id);
    const held = (await call('/api/cloud-jobs', 'POST', newJob({ prompt: 'HOLD', images: [] }))).job;
    await running(held.id);
    const graph = (await call(route)).board.graph;
    graph.nodes.find(item => item.id === node.id).data.text = 'ONE';
    const saved = await call(route + '/graph', 'PUT', graph);
    const queued = await call(route + '/runs', 'POST', { nodeId: node.id, revision: saved.revision });
    assert.equal(queued.status, 'queued');
    await call(jobRoute(held.id) + '/cancel', 'POST');
    const final = await wait(route, value => value.board.graph.runs.find(run => run.id === queued.id)?.status === 'completed');
    assert.equal(final.board.graph.runs.find(run => run.id === queued.id).outputIds.length, 1);
  });

  await t.test('restart preserves completed outputs, fails interrupted jobs and prunes jobs older than seven days', async () => {
    const stopped = (await call('/api/cloud-jobs', 'POST', newJob({ prompt: 'HOLD', images: [] }))).job;
    await running(stopped.id);
    await stop();
    const original = JSON.parse(await readFile(path.join(jobDirectory(first), 'job.json'), 'utf8'));
    const interrupted = randomUUID(), queued = randomUUID(), expired = randomUUID();
    for (const [id, status] of [[interrupted, 'running'], [queued, 'queued'], [expired, 'completed']]) {
      const job = { ...original, id, status, outputs: [] };
      delete job.finishedAt;
      if (id === expired) job.startedAt = job.createdAt = job.finishedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      await mkdir(jobDirectory(id));
      await writeFile(path.join(jobDirectory(id), 'job.json'), JSON.stringify(job));
    }
    await start();
    const stoppedJob = await call(jobRoute(stopped.id));
    assert.equal(stoppedJob.status, 'failed'); assert.match(stoppedJob.error, /helper stopped/i);
    assert.equal((await call(jobRoute(first))).status, 'completed');
    assert.deepEqual(Buffer.from(await (await request(jobRoute(first) + '/outputs/0')).arrayBuffer()), png);
    for (const id of [interrupted, queued]) {
      const job = await call(jobRoute(id));
      assert.equal(job.status, 'failed'); assert.match(job.error, /helper stopped/i); assert.ok(job.finishedAt);
      assert.equal((await call('/api/cloud-jobs', 'POST', { jobId: id })).job.status, 'failed');
    }
    assert.equal((await request(jobRoute(expired))).status, 404);
    await assert.rejects(stat(jobDirectory(expired)), { code: 'ENOENT' });
    await call(jobRoute(first), 'DELETE');
    assert.equal((await request(jobRoute(first))).status, 404);
    await assert.rejects(stat(jobDirectory(first)), { code: 'ENOENT' });
    assert.equal((await call('/api/cloud-jobs')).jobs.some(job => job.id === first), false);
  });
});

test('helper launcher honors and prints the configured origin list', { timeout: 10000 }, async t => {
  const helper = await helperServer(t, 'helper.mjs');
  assert.ok(helper.output().includes(sites.join(', ')));
  assert.match(helper.output(), /connection code: [a-f0-9]{64}/);
  assert.equal((await helper.request('/api/cloud-jobs', 'GET', undefined, { Origin: sites[1] })).status, 200);
});

test('cloud job routes are unavailable without helper mode', { timeout: 10000 }, async t => {
  const { request, directory } = await helperServer(t, 'server.mjs', false);
  assert.equal((await request('/api/cloud-jobs')).status, 404);
  assert.equal((await request('/api/cloud-jobs', 'POST', newJob())).status, 404);
  await assert.rejects(stat(path.join(directory, 'cloud-jobs')), { code: 'ENOENT' });
});

test('a helper describes images for the site and reports what it can run', { timeout: 30000 }, async t => {
  const { call, request, wait } = await helperServer(t);
  assert.ok((await call('/api/status', 'POST')).features.includes('describe'));
  assert.equal((await request('/api/cloud-jobs', 'POST', newJob({ task: 'caption' }))).status, 400);
  assert.equal((await request('/api/cloud-jobs', 'POST', newJob({ task: 'describe', images: [] }))).status, 400);
  const job = newJob({ task: 'describe', prompt: 'WITH_INPUT Describe' });
  await call('/api/cloud-jobs', 'POST', job);
  const { jobs } = await wait('/api/cloud-jobs', value => value.jobs.some(item => item.id === job.jobId && item.status === 'completed'));
  const done = jobs.find(item => item.id === job.jobId);
  assert.deepEqual([done.task, done.text, done.progress, done.outputs], ['describe', 'A grey pixel.', 'Description written', []]);
});
