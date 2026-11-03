import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { CloudGeneration } from '../src/cloud-generation.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { validateGraph } from '../graph.mjs';

const asset = '12345678-1234-1234-1234-123456789abc.png';
const otherAsset = '12345678-1234-1234-1234-123456789def.png';
const user = { name: 'Artist', color: '#448bfa' };
const startedAt = '2026-11-03T10:00:00.000Z';
function setup() {
  const doc = new Y.Doc(), calls = [], errors = [], state = { live: true, jobs: [], failUpload: false, failDelete: false, failPost: null };
  applyLocalGraph(doc, { nodes: [{ id: 'p', type: 'text', position: { x: 80, y: 40 }, data: { text: 'A cloud', model: 'model', effort: 'low', labelOutputs: true } }, { id: 'i', type: 'image', position: { x: -310, y: 0 }, data: { asset, caption: 'Reference' } }], edges: [{ id: 'reference', source: 'i', target: 'p' }], groups: [], runs: [] }, { nodes: [], edges: [], groups: [], runs: [] }, 'seed');
  const services = {
    doc, boardId: 'board', user, ready: () => state.live, onError: error => errors.push(error),
    request: async url => { calls.push(['cloud-image', url]); return new Response(new Uint8Array([1, 2, 3])); },
    helperRequest: async url => { calls.push(['helper-image', url]); return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } }); },
    api: async (url, options) => {
      calls.push(['cloud-api', url, options]);
      if (state.failUpload) throw new Error('Upload offline');
      return { asset: calls.filter(call => call[0] === 'cloud-api').length === 1 ? asset : otherAsset };
    },
    helperApi: async (url, options = {}) => {
      calls.push(['helper-api', url, options]);
      if (options.method === 'POST' && url === '/api/cloud-jobs') {
        if (state.failPost) throw state.failPost;
        const input = JSON.parse(options.body);
        state.jobs.push({ id: input.jobId, boardId: input.boardId, nodeId: input.nodeId, startedAt, status: 'running', outputs: [] });
        return { job: state.jobs.at(-1) };
      }
      if (options.method === 'DELETE') { if (state.failDelete) throw new Error('Ack offline'); state.jobs = state.jobs.filter(job => url !== `/api/cloud-jobs/${job.id}`); return {}; }
      if (url.endsWith('/cancel')) { state.jobs[0].status = 'cancelled'; return {}; }
      return { jobs: structuredClone(state.jobs) };
    },
  };
  const generation = new CloudGeneration(services); generation.active = true;
  return { doc, calls, errors, state, generation, services };
}
const completed = (id = 'run') => ({ id, boardId: 'board', nodeId: 'p', status: 'completed', startedAt, finishedAt: startedAt, outputs: [{ index: 0, format: 'png', caption: 'Front' }, { index: 1, format: 'png' }] });

test('generation sends collected inputs without legacy model settings; collection inserts each output atomically', async () => {
  const { doc, calls, generation, state } = setup();
  const owned = []; generation.onStart = run => owned.push(run.id);
  await generation.start('p');
  await new Promise(resolve => setImmediate(resolve));
  const posted = calls.find(call => call[0] === 'helper-api' && call[2].method === 'POST');
  const input = JSON.parse(posted[2].body);
  assert.deepEqual(owned, [input.jobId]);
  assert.equal(Object.hasOwn(input, 'model'), false); assert.equal(Object.hasOwn(input, 'effort'), false); assert.equal(input.labelOutputs, true);
  assert.deepEqual(input.images, [{ asset, data: 'AQID' }]); assert.match(input.prompt, /Reference/);
  assert.equal(doc.getMap('runs').get(input.jobId).by.name, 'Artist');
  state.jobs = [completed(input.jobId)];
  let updates = 0; doc.on('update', () => updates++);
  await generation.tick();
  const graph = readCloudGraph(doc), run = graph.runs[0];
  assert.equal(updates, 3); assert.equal(run.status, 'completed'); assert.equal(run.count, 2);
  assert.equal(graph.groups.length, 1); assert.deepEqual(graph.groups[0].nodeIds, run.outputIds);
  assert.equal(graph.nodes.find(node => node.id === run.outputIds[0]).data.caption, 'Front');
  assert.equal(graph.nodes.find(node => node.id === run.outputIds[1]).data.caption, 'Image 2');
  assert.equal(graph.edges.filter(edge => edge.source === 'p').length, 2); assert.doesNotThrow(() => validateGraph(graph));
  assert.equal(state.jobs.length, 0);
  generation.stop(); doc.destroy();
});

test('reload resumes retained output jobs and an unsuccessful acknowledgement never creates duplicates', async () => {
  const { doc, calls, generation, state } = setup(); state.jobs = [completed()]; state.failDelete = true;
  await generation.tick();
  assert.equal(readCloudGraph(doc).runs[0].status, 'completed');
  const snapshot = readCloudGraph(doc), imageCalls = calls.filter(call => call[0] === 'helper-image').length;
  const reload = new CloudGeneration({ ...generation, doc }); reload.active = true; state.failDelete = false;
  await reload.tick();
  assert.deepEqual(readCloudGraph(doc), snapshot); assert.equal(calls.filter(call => call[0] === 'helper-image').length, imageCalls);
  assert.equal(state.jobs.length, 0); generation.stop(); reload.stop(); doc.destroy();
});

test('failed upload retains helper files, retries successfully, and ignores other boards', async () => {
  const { doc, generation, state, calls, errors } = setup();
  state.jobs = [completed(), { ...completed('other'), boardId: 'another-board' }]; state.failUpload = true;
  await generation.tick();
  assert.equal(readCloudGraph(doc).nodes.length, 2); assert.equal(state.jobs.length, 2); assert.equal(errors.at(-1), 'Upload offline');
  assert.equal(calls.some(call => call[2]?.method === 'DELETE'), false);
  state.failUpload = false; await generation.tick();
  assert.equal(readCloudGraph(doc).nodes.length, 4); assert.deepEqual(state.jobs.map(job => job.id), ['other']);
  generation.stop(); doc.destroy();
});

test('offline collection waits and stopped collectors leave jobs available', async () => {
  const { doc, generation, state, calls } = setup(); state.live = false; state.jobs = [completed()];
  await generation.tick(); assert.equal(calls.length, 0); await assert.rejects(generation.start('p'), /live board/);
  state.live = true;
  generation.helperRequest = async () => { generation.stop(); return new Response(new Uint8Array([1])); };
  await generation.tick();
  assert.equal(doc.getMap('runs').size, 0); assert.equal(state.jobs.length, 1); doc.destroy();
});

test('failed and cancelled jobs update summaries and only the owner can cancel', async () => {
  const { doc, generation, state, calls } = setup();
  state.jobs = [{ ...completed(), status: 'failed', error: 'Codex failed' }]; await generation.tick();
  assert.equal(doc.getMap('runs').get('run').status, 'failed'); assert.equal(doc.getMap('runs').get('run').error, 'Codex failed');
  const run = { id: 'cancel', nodeId: 'p', status: 'running', by: { name: 'Other' }, startedAt };
  generation.setRun(run); state.jobs = [{ ...completed('cancel'), status: 'running' }];
  const count = calls.length; await generation.cancel('cancel'); assert.equal(calls.length, count);
  generation.setRun({ ...run, by: user }); await generation.cancel('cancel');
  assert.equal(doc.getMap('runs').get('cancel').status, 'cancelled'); generation.stop(); doc.destroy();
});

test('a lost submission is reconciled on the next successful helper listing', async () => {
  const { doc, generation, state } = setup(); state.failPost = new TypeError('Network disconnected');
  await assert.rejects(generation.start('p'), /Network disconnected/);
  assert.equal(readCloudGraph(doc).runs[0].status, 'queued');
  await generation.tick(); assert.equal(readCloudGraph(doc).runs[0].status, 'failed');
  generation.stop(); doc.destroy();
});

test('cloud summaries follow helper queue and generation timing without resubmitting queued prompts', async () => {
  const { doc, generation, state, calls } = setup();
  const queued = { id: 'queued', nodeId: 'p', status: 'queued', by: user, startedAt, createdAt: startedAt };
  generation.setRun(queued);
  await generation.start('p');
  assert.equal(calls.length, 0);
  state.jobs = [{ ...completed('queued'), status: 'queued' }];
  await generation.tick();
  assert.equal(doc.getMap('runs').get('queued').status, 'queued');
  const later = '2026-11-03T10:02:00.000Z';
  state.jobs[0] = { ...state.jobs[0], status: 'running', startedAt: later };
  await generation.tick();
  const run = doc.getMap('runs').get('queued');
  assert.equal(run.status, 'running'); assert.equal(run.startedAt, later); assert.equal(run.createdAt, startedAt);
  let updates = 0; doc.on('update', () => updates++);
  await generation.tick(); assert.equal(updates, 0);
  generation.setRun(queued);
  state.jobs = [{ ...completed('queued'), startedAt: later }];
  await generation.tick();
  assert.equal(doc.getMap('runs').get('queued').startedAt, later);
  generation.stop(); doc.destroy();
});

test('two tabs collecting the same job converge on one set of outputs and preserve deliberate deletion', async () => {
  const { doc, generation, services } = setup(), other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  const second = new CloudGeneration({ ...services, doc: other }); second.active = true;
  await Promise.all([generation.complete(completed()), second.complete(completed())]);
  const left = Y.encodeStateAsUpdate(doc), right = Y.encodeStateAsUpdate(other);
  Y.applyUpdate(doc, right); Y.applyUpdate(other, left);
  const graph = readCloudGraph(doc);
  assert.deepEqual(graph, readCloudGraph(other)); assert.equal(graph.nodes.length, 4); assert.equal(graph.groups.length, 1);
  const deleted = structuredClone(graph);
  deleted.nodes = deleted.nodes.filter(node => !node.data.runId); deleted.edges = deleted.edges.filter(edge => edge.source !== 'p'); deleted.groups = [];
  applyLocalGraph(doc, deleted, graph, 'artist');
  await generation.complete(completed()); assert.deepEqual(readCloudGraph(doc), deleted);
  generation.stop(); second.stop(); doc.destroy(); other.destroy();
});

test('running polls stream 1 then 3 outputs atomically, without duplicate uploads, and reload finishes the run', async () => {
  const { doc, generation, state, calls, services } = setup();
  generation.helperRequest = async url => {
    calls.push(['helper-image', url]);
    const bytes = new Uint8Array(24), view = new DataView(bytes.buffer);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.set([73, 72, 68, 82], 12);
    view.setUint32(16, 100); view.setUint32(20, url.endsWith('/0') ? 200 : 50);
    return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
  };
  const job = { ...completed(), status: 'running', outputs: [{ index: 0, format: 'png' }] };
  state.jobs = [job];
  const arrivals = [];
  doc.on('update', () => {
    const graph = readCloudGraph(doc), ids = graph.runs[0]?.outputIds || [];
    if (ids.length === arrivals.at(-1)?.length) return;
    arrivals.push(ids);
    for (const id of ids) assert.ok(graph.edges.some(edge => edge.target === id));
    if (ids.length >= 2) assert.deepEqual(graph.groups[0].nodeIds, ids);
  });
  await generation.tick(); await generation.tick();
  let graph = readCloudGraph(doc);
  assert.equal(graph.runs[0].status, 'running'); assert.equal(graph.runs[0].count, 1);
  assert.equal(calls.filter(call => call[0] === 'cloud-api').length, 1);
  job.outputs.push({ index: 1, format: 'png' }, { index: 2, format: 'png' });
  await generation.tick(); await generation.tick();
  graph = readCloudGraph(doc);
  assert.deepEqual(arrivals.map(ids => ids.length), [1, 2, 3]);
  assert.equal(graph.runs[0].status, 'running'); assert.equal(graph.runs[0].count, 3);
  assert.deepEqual(graph.groups[0].nodeIds, ['run-output-0', 'run-output-1', 'run-output-2']);
  const images = graph.runs[0].outputIds.map(id => graph.nodes.find(node => node.id === id));
  assert.deepEqual(images.map(node => node.data.aspect), [2, 0.5, 0.5]);
  assert.deepEqual(images.map(node => node.data.caption), ['Image 1', 'Image 2', 'Image 3']);
  assert.deepEqual(images.map(node => node.position.y - images[0].position.y), [0, 674, 883]);
  assert.equal(calls.filter(call => call[0] === 'cloud-api').length, 3);
  generation.stop();
  const reload = new CloudGeneration(services); reload.active = true;
  await reload.tick();
  state.jobs[0].status = 'completed'; await reload.tick();
  assert.equal(doc.getMap('runs').get('run').status, 'completed'); assert.equal(state.jobs.length, 0);
  assert.equal(calls.filter(call => call[0] === 'helper-image').length, 3);
  assert.doesNotThrow(() => validateGraph(readCloudGraph(doc)));
  reload.stop(); doc.destroy();
});

test('a later upload failure leaves earlier images visible and retries only the missing output', async () => {
  const { doc, generation, state, calls, services } = setup();
  state.jobs = [completed()];
  generation.api = async (url, options) => {
    if (calls.filter(call => call[0] === 'cloud-api').length === 1) throw new Error('Second upload offline');
    return services.api(url, options);
  };
  await generation.tick();
  assert.equal(doc.getMap('nodes').has('run-output-0'), true);
  assert.equal(doc.getMap('runs').get('run').status, 'running'); assert.equal(state.jobs.length, 1);
  generation.api = services.api; await generation.tick();
  assert.equal(doc.getMap('runs').get('run').status, 'completed');
  assert.equal(calls.filter(call => call[0] === 'helper-image' && call[1].endsWith('/0')).length, 1);
  assert.equal(readCloudGraph(doc).nodes.length, 4);
  generation.stop(); doc.destroy();
});

test('streaming respects caption edits, movement, deletion and ungrouping across reloads', async () => {
  for (const caption of ['', 'My caption']) {
    const { doc, generation, state, services, calls } = setup();
    const job = { ...completed(), status: 'running', outputs: [{ index: 0, format: 'png' }] }; state.jobs = [job];
    await generation.tick();
    let before = readCloudGraph(doc), edited = structuredClone(before);
    const first = edited.nodes.find(node => node.id === 'run-output-0');
    first.data.caption = caption; first.position = { x: 999, y: 700 };
    applyLocalGraph(doc, edited, before, 'artist');
    job.outputs.push({ index: 1, format: 'png' }); await generation.tick();
    before = readCloudGraph(doc); edited = structuredClone(before);
    assert.equal(edited.nodes.find(node => node.id === first.id).data.caption, caption);
    assert.equal(edited.nodes.find(node => node.id === 'run-output-1').position.x, 999);
    edited.nodes = edited.nodes.filter(node => node.id !== first.id); edited.edges = edited.edges.filter(edge => edge.target !== first.id); edited.groups = [];
    applyLocalGraph(doc, edited, before, 'artist'); generation.stop();
    const reload = new CloudGeneration(services); reload.active = true;
    job.outputs.push({ index: 2, format: 'png' }); await reload.tick();
    const graph = readCloudGraph(doc);
    assert.equal(graph.nodes.some(node => node.id === first.id), false); assert.deepEqual(graph.groups, []);
    assert.equal(calls.filter(call => call[0] === 'helper-image' && call[1].endsWith('/0')).length, 1);
    assert.equal(graph.runs[0].count, 3); assert.equal(graph.runs[0].status, 'running');
    reload.stop(); doc.destroy();
  }
});

test('a manually grouped first output stays there while later outputs form their own group', async () => {
  const { doc, generation, state } = setup();
  const job = { ...completed(), status: 'running', outputs: [{ index: 0, format: 'png' }] }; state.jobs = [job];
  await generation.tick();
  const before = readCloudGraph(doc), edited = structuredClone(before);
  edited.groups = [{ id: 'manual', name: 'Manual', nodeIds: ['p', 'run-output-0'], collapsed: false }];
  applyLocalGraph(doc, edited, before, 'artist');
  job.outputs.push({ index: 1, format: 'png' }, { index: 2, format: 'png' }); await generation.tick();
  const graph = readCloudGraph(doc);
  assert.deepEqual(graph.groups.find(group => group.id === 'manual').nodeIds, ['p', 'run-output-0']);
  assert.deepEqual(graph.groups.find(group => group.id === 'run-group').nodeIds, ['run-output-1', 'run-output-2']);
  generation.stop(); doc.destroy();
});

test('disconnecting after upload reuses the cached asset on the next poll', async () => {
  const { doc, generation, state, services, calls } = setup(); state.jobs = [completed()];
  generation.api = async (url, options) => { const result = await services.api(url, options); state.live = false; return result; };
  await generation.tick();
  assert.equal(doc.getMap('nodes').has('run-output-0'), false);
  state.live = true; generation.api = services.api; await generation.tick();
  assert.equal(doc.getMap('runs').get('run').status, 'completed');
  assert.equal(calls.filter(call => call[0] === 'cloud-api').length, 2);
  assert.equal(calls.filter(call => call[0] === 'helper-image').length, 2);
  generation.stop(); doc.destroy();
});
