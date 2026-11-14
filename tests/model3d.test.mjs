import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateGraph, runInputs, collectInputs, modelerOf, model3dModels, modelNames, duplicateNodes } from '../graph.mjs';
import { cubeGlb } from './fixtures/cube-glb.mjs';
import { glbLength, validateGlb, maxModelBytes } from '../src/model-assets.mjs';
import { model3dInput, falModel3d, model3dPrices, model3dPoster, storeModelGlb } from '../cloud/model3d.mjs';
import { falQueue } from '../cloud/fal-queue.mjs';
import { falUpscale } from '../cloud/upscale.mjs';
import { imageAssets } from '../src/image-edits.mjs';
import { runBoardTool, toolByName, checkArgs } from '../cloud/mcp-tools.mjs';
import { placeRunOutput } from '../src/run-outputs.mjs';
import { selectedGraph, readNodeClipboard, cloneSelection } from '../src/clipboard.mjs';
import { runPlaceholders } from '../src/run-placeholders.mjs';
import { directInputCounts } from '../src/onboarding.mjs';
import { createCanvasThumbnail } from '../src/canvas-thumbnails.mjs';
import { freshOutputNodes, slideshowState } from '../src/canvas.mjs';
import { boardStats } from '../cloud/board-stats.mjs';
import { generationRows } from '../src/generation-tray.mjs';
import { blockedMediaSelector } from '../src/analytics-privacy.mjs';
import * as Y from 'yjs';
import { applyLocalGraph } from '../src/cloud-sync.mjs';
import { nanoState } from '../src/generator.mjs';
import { setLanguage, t as translate } from '../src/i18n.mjs';

const image = '11111111-1111-1111-1111-111111111111.png', asset = '22222222-2222-2222-2222-222222222222.glb';
const poster = '33333333-3333-3333-3333-333333333333.png';
const node = (id, type, data) => ({ id, type, position: { x: 0, y: 0 }, data });
const model = () => node('model', 'model', { asset, poster, name: 'Cube 3D' });
const graph = (count = 1, modeler) => ({ nodes: [node('g', 'text', { text: '', task: 'model3d', ...(modeler ? { modeler } : {}) }), ...Array.from({ length: count }, (_, i) => node('i' + i, 'image', { asset: image, caption: 'Cube' }))], edges: Array.from({ length: count }, (_, i) => ({ id: 'e' + i, source: 'i' + i, target: 'g' })), groups: [], runs: [], revision: 0 });

test('3D readiness blocks separate access and quota failures with translated reasons', () => {
  const status = { configured: true, allowed: true, dailyImages: 50, usedToday: 1, monthlyUsd: 50, teamSpentUsd: .375 };
  assert.equal(nanoState(status, 'model3d').ready, true);
  const denied = nanoState({ configured: true, allowed: false }, 'model3d');
  assert.equal(denied.ready, false); assert.equal(denied.note, '3D generation isn’t available for your account. Ask a site admin for access.');
  assert.match(nanoState({ configured: false, allowed: true }, 'model3d').note, /3D generation isn’t set up/);
  assert.equal(nanoState({ ...status, usedToday: 50 }, 'model3d').ready, false);
  assert.equal(nanoState({ ...status, teamSpentUsd: 50 }, 'model3d').ready, false);
  setLanguage('uk');
  try {
    assert.match(nanoState({ configured: true, allowed: false }, 'model3d').note, /Генерація 3D недоступна/);
    assert.equal(translate('3D models for {name}', { name: 'Lead' }), '3D-моделі для Lead');
  } finally { setLanguage('en'); }
});

test('3D task validates modelers and one to four direct images; models are excluded from every prompt reference', () => {
  for (const modeler of Object.keys(model3dModels)) {
    const g = graph(4, modeler); assert.equal(validateGraph(g), g); assert.equal(runInputs(g, 'g').images.length, 4); assert.equal(collectInputs(g, 'g').task, 'model3d'); assert.ok(modelNames[model3dModels[modeler]]);
  }
  assert.equal(modelerOf(graph().nodes[0]), 'hunyuan');
  assert.throws(() => runInputs(graph(0), 'g'), /Connect an image/); assert.throws(() => runInputs(graph(5), 'g'), /at most 4/);
  assert.throws(() => validateGraph(graph(1, 'unknown')), /modeler/);
  const g = graph(); g.nodes.push(model()); g.edges.push({ id: 'mg', source: 'model', target: 'g' });
  assert.deepEqual(runInputs(g, 'g').images.map(i => i.asset), [image]);
  for (const task of ['describe', 'upscale', undefined]) {
    g.nodes[0].data = { text: 'A cube', ...(task ? { task } : {}) }; assert.deepEqual(runInputs(g, 'g').images.map(i => i.asset), [image]);
  }
  assert.equal(directInputCounts(g).get('g').images, 1); assert.equal(directInputCounts(g).get('g').text, 0);
  g.nodes[0].data = { text: '', generator: 'gpt-image', task: 'model3d' }; assert.throws(() => validateGraph(g), /GPT Image only/);
});

test('model assets, posters and names validate independently, and clipboard/duplicate keep both files', () => {
  const g = { nodes: [model()], edges: [], groups: [] }; validateGraph(g);
  assert.deepEqual(imageAssets(g.nodes[0]), [asset, poster]);
  for (const change of [{ asset: image }, { poster: asset }, { name: '' }, { name: 3 }]) { const copy = structuredClone(g); Object.assign(copy.nodes[0].data, change); assert.throws(() => validateGraph(copy)); }
  assert.throws(() => validateGraph({ nodes: [node('i', 'image', { asset })], edges: [] }), /Invalid image asset/);
  assert.throws(() => validateGraph({ nodes: [node('t', 'text', { text: '', template: { name: 'Wrong', instructions: '', assets: [asset] } })], edges: [] }), /template/);
  const copy = duplicateNodes(g, ['model']); assert.deepEqual(copy.nodes[0].data.asset, asset); assert.equal(copy.nodes[0].data.poster, poster);
  const clip = readNodeClipboard(JSON.stringify(selectedGraph([{ ...model(), selected: true }], [])));
  assert.equal(cloneSelection(clip).nodes[0].data.asset, asset); assert.equal(cloneSelection(clip).nodes[0].data.poster, poster);
});

test('model facts are optional, bounded and survive copies without changing generation time', () => {
  const facts = { modeler: 'hunyuan', source: { nodeId: 'i0', name: 'Cube' }, bytes: cubeGlb().length, usd: .375, createdAt: '2026-11-14T10:00:00Z', author: { name: 'Lead' } };
  const g = graph(); g.nodes.push({ ...model(), data: { ...model().data, ...facts } }); validateGraph(g);
  for (const key of ['modeler', 'source', 'bytes', 'usd']) { const old = structuredClone(g); delete old.nodes.at(-1).data[key]; validateGraph(old); }
  for (const change of [
    { modeler: 'unknown' }, { modeler: 3 }, { modeler: null }, { bytes: 19 }, { bytes: 1.5 }, { bytes: '100' }, { bytes: maxModelBytes + 1 }, { bytes: Infinity },
    { usd: -1 }, { usd: NaN }, { usd: Infinity }, { usd: '0.375' }, { usd: 1001 }, { usd: null },
    ...[null, [], {}, { nodeId: 'i0' }, { nodeId: 3, name: 'Cube' }, { nodeId: '', name: 'Cube' }, { nodeId: 'x'.repeat(121), name: 'Cube' }, { nodeId: 'i0', name: ' ' }, { nodeId: 'i0', name: 'x'.repeat(121) }, { nodeId: 'i0', name: 'Cube', extra: true }].map(source => ({ source })),
  ]) { const bad = structuredClone(g); Object.assign(bad.nodes.at(-1).data, change); assert.throws(() => validateGraph(bad), /Invalid/); }
  const copied = duplicateNodes(g, ['model', 'i0'], { ids: new Map([['model', 'copy-model'], ['i0', 'copy-image']]) });
  assert.deepEqual(copied.nodes[0].data, { ...g.nodes.at(-1).data, source: { ...facts.source, nodeId: 'copy-image' } });
  const clip = readNodeClipboard(JSON.stringify(selectedGraph([{ ...g.nodes.at(-1), selected: true }], [])));
  assert.deepEqual(cloneSelection(clip).nodes[0].data, g.nodes.at(-1).data);
});

test('GLB validation rejects magic, version, declared length and oversize, and fixture has a real cube mesh', () => {
  const bytes = cubeGlb(); assert.equal(validateGlb(bytes), bytes); assert.equal(glbLength(bytes), bytes.length);
  const document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + new DataView(bytes.buffer).getUint32(12, true))));
  assert.equal(document.accessors[1].count, 36); assert.equal(document.materials.length, 1);
  const bad = change => { const value = bytes.slice(); change(value, new DataView(value.buffer)); return value; };
  assert.throws(() => validateGlb(bad(b => b[0] = 0)), /magic/); assert.throws(() => validateGlb(bad((b,v) => v.setUint32(4, 1, true))), /version/);
  assert.throws(() => validateGlb(bad((b,v) => v.setUint32(8, b.length + 1, true))), /length/);
  assert.throws(() => validateGlb(bad((b,v) => v.setUint32(8, maxModelBytes + 1, true))), /80 MB/);
});

const queue = 'https://queue.fal.run/requests/test', url = 'https://media.example/cube.glb';
function fakeFetch(result, { status = 200, error, onCall = () => {} } = {}) {
  return async (address, init = {}) => {
    onCall(String(address), init);
    if (init.method === 'POST') return Response.json(status === 200 ? { status_url: queue + '/status', response_url: queue, cancel_url: queue + '/cancel' } : { detail: error || 'Bad image' }, { status });
    if (address === queue + '/status/stream') return new Response('data: {"status":"IN_QUEUE","queue_position":0}\n\ndata: {"status":"COMPLETED"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    if (address === queue + '/status') return Response.json({ status: 'COMPLETED' });
    if (address === queue) return Response.json(result);
    if (String(address).endsWith('.glb')) return new Response(cubeGlb());
    if (String(address).endsWith('.png')) return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=', 'base64'));
    throw new Error('Unexpected URL: ' + address);
  };
}
test('all three fal requests use exact inputs/prices and parse model outputs with or without a thumbnail', async () => {
  const uri = 'data:image/png;base64,AQID';
  assert.deepEqual(model3dInput('hunyuan', uri), { input_image_url: uri, generate_type: 'Normal', enable_pbr: false });
  assert.deepEqual(model3dInput('trellis', uri), { image_url: uri, resolution: 1024 });
  assert.deepEqual(model3dInput('rodin', uri), { image_urls: [uri], geometry_file_format: 'glb', material: 'PBR' });
  assert.deepEqual(model3dPrices, { hunyuan: .375, trellis: .3, rodin: .4 });
  for (const modeler of Object.keys(model3dModels)) {
    const calls = [], thumbnail = modeler === 'hunyuan' ? 'https://media.example/thumb.png' : undefined;
    let queued = 0;
    const result = await falModel3d({ key: 'secret', modeler, input: model3dInput(modeler, uri), onQueued: () => queued++, fetcher: fakeFetch({ [modeler === 'rodin' ? 'model_mesh' : 'model_glb']: { url }, ...(thumbnail ? { thumbnail: { url: thumbnail } } : {}) }, { onCall: (url, init) => calls.push({ url, init }) }) });
    assert.deepEqual(result, { url, ...(thumbnail ? { thumbnail } : {}) }); assert.equal(queued, 1);
    assert.equal(calls[0].url, 'https://queue.fal.run/' + model3dModels[modeler]); assert.ok(calls.every(call => call.init.headers.Authorization === 'Key secret' && call.init.redirect === 'manual'));
    if (thumbnail) assert.equal((await model3dPoster(thumbnail, { fetcher: fakeFetch({}) })).format, 'png');
  }
  // Existing upscale still returns the downloaded image, with no key on the result download.
  const calls = [];
  assert.equal((await falUpscale({ key: 'secret', model: 'fal-ai/topaz/upscale/image', input: {}, fetcher: fakeFetch({ image: { url: 'https://media.example/out.png' } }, { onCall: (url, init) => calls.push({ url, init }) }) })).format, 'png');
  assert.equal(calls.at(-1).init.headers, undefined);
});

test('queue errors, unsafe hosts and result URLs fail without exposing the key; abort cancels the accepted job', async () => {
  for (const status of [400, 401, 402, 403, 422, 429, 500]) await assert.rejects(falModel3d({ key: 'secret', modeler: 'hunyuan', input: {}, fetcher: fakeFetch({}, { status }) }), /fal.ai|3D generator/);
  for (const result of [{}, { model_glb: { url: 'http://evil.example/cube.glb' } }, { model_glb: { url }, thumbnail: { url: 'file:///secret' } }]) await assert.rejects(falModel3d({ modeler: 'hunyuan', fetcher: fakeFetch(result) }), /unreadable/);
  const calls = [];
  await assert.rejects(falQueue({ key: 'secret', endpoint: 'https://evil.example', model: 'test', input: {}, fetcher: async (url, init) => { calls.push(url); return Response.json({ status_url: 'https://evil.example/status', response_url: 'https://evil.example/result' }); } }), /unreadable/);
  assert.deepEqual(calls, ['https://queue.fal.run/test']);
  const controller = new AbortController(), cancelled = [];
  await assert.rejects(falQueue({ key: 'secret', model: 'test', input: {}, signal: controller.signal, onQueued: () => controller.abort(), fetcher: async (url, init) => {
    if (init.method === 'PUT') { cancelled.push(url); return Response.json({}); }
    return Response.json({ status_url: queue + '/status', response_url: queue, cancel_url: queue + '/cancel' });
  } }), /abort/i);
  assert.deepEqual(cancelled, [queue + '/cancel']);
  const endpoint = 'http://127.0.0.1:8790', local = endpoint + '/model.glb';
  assert.equal((await falModel3d({ endpoint, modeler: 'trellis', fetcher: async (url, init) => init.method === 'POST' ? Response.json({ status_url: endpoint + '/status', response_url: endpoint + '/result' }) : url.endsWith('/status') ? Response.json({ status: 'COMPLETED' }) : Response.json({ model_glb: { url: local } }) })).url, local);
});

test('a status stream that ends early costs one status check and a reopen, not a poll every few seconds', async () => {
  const calls = [];
  let streams = 0;
  const result = await falQueue({ key: 'secret', model: 'test', input: {}, fetcher: async (url, init = {}) => {
    calls.push(String(url));
    if (init.method === 'POST') return Response.json({ status_url: queue + '/status', response_url: queue });
    if (url === queue + '/status/stream') return new Response(++streams === 1 ? 'data: {"status":"IN_PROGRESS"}\r\n\r\n' : 'event: x\ndata: {"status":\n\ndata: {"status":"COMPLETED"}\n\n');
    if (url === queue + '/status') return Response.json({ status: 'IN_PROGRESS' });
    if (url === queue) return Response.json({ ok: true });
    throw new Error('Unexpected URL: ' + url);
  } });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.slice(1), [queue + '/status/stream', queue + '/status', queue + '/status/stream', queue]);
});

function bucket() {
  const writes = [], parts = [], state = { complete: false, aborted: false };
  return { writes, parts, state, async put(key, bytes, metadata) { writes.push({ key, bytes: bytes.slice(), metadata }); }, async createMultipartUpload() { return {
    async uploadPart(partNumber, bytes) { parts.push(bytes.length); return { partNumber, etag: 'part-' + partNumber }; }, async complete() { state.complete = true; }, async abort() { state.aborted = true; }
  }; } };
}
test('R2 stores small valid GLB with its type and streams large GLBs in bounded parts; invalid streams never complete', async () => {
  const bytes = cubeGlb(), small = bucket(); assert.equal(await storeModelGlb(new Response(bytes), small, asset), bytes.length);
  assert.equal(small.writes[0].metadata.httpMetadata.contentType, 'model/gltf-binary'); assert.deepEqual(small.writes[0].bytes, bytes);
  for (const value of [new Uint8Array(12), bytes.subarray(0, bytes.length - 1)]) { const files = bucket(); await assert.rejects(storeModelGlb(new Response(value), files, asset), /GLB/); assert.equal(files.writes.length, 0); }
  const files = bucket(); await assert.rejects(storeModelGlb(new Response(bytes, { headers: { 'Content-Length': String(maxModelBytes + 1) } }), files, asset), /80 MB/); assert.equal(files.writes.length, 0);
  const length = 11 * 1024 * 1024, header = bytes.slice(0, 12); new DataView(header.buffer).setUint32(8, length, true);
  const response = extra => { let sent = 0; return new Response(new ReadableStream({ pull(controller) { if (sent >= length + extra) { controller.close(); return; } const chunk = new Uint8Array(Math.min(64 * 1024, length + extra - sent)); if (!sent) chunk.set(header); sent += chunk.length; controller.enqueue(chunk); } })); };
  const large = bucket(); assert.equal(await storeModelGlb(response(0), large, asset), length); assert.equal(large.state.complete, true); assert.deepEqual(large.parts, [5*1024*1024, 5*1024*1024, 1024*1024]);
  const bad = bucket(); await assert.rejects(storeModelGlb(response(-1), bad, asset), /length/); assert.equal(bad.state.aborted, true); assert.equal(bad.state.complete, false);
  const aborted = bucket(), controller = new AbortController(); controller.abort(); await assert.rejects(storeModelGlb(new Response(bytes), aborted, asset, controller.signal), /abort/i); assert.equal(aborted.writes.length, 0);
});

test('3D placement, history, placeholders, plain groups, covers and undo preserve model identity and posters', async () => {
  const before = graph(2), run = { id: 'r', nodeId: 'g', task: 'model3d', provider: 'nano-banana', status: 'running', startedAt: new Date().toISOString() };
  assert.equal(runPlaceholders(before, [run], 'page-1').nodes.length, 2);
  const first = placeRunOutput(before, { runId: 'r', nodeId: 'g', run, output: { index: 0 }, asset, model: { name: 'Cube 3D', poster } });
  const second = placeRunOutput(first, { runId: 'r', nodeId: 'g', run: first.runs[0], output: { index: 1 }, asset, model: { name: 'Cube 3D', poster } });
  assert.deepEqual(second.nodes.filter(n => n.type === 'model').map(n => n.data.name), ['Cube 3D', 'Cube 3D 2']); assert.equal(second.groups[0].slideshow, false);
  assert.equal(slideshowState({ ...second.groups[0], slideshow: true }, new Map(second.nodes.map(n => [n.id, n]))).images.length, 0);
  assert.equal(runPlaceholders(second, second.runs, 'page-1').nodes.length, 0); validateGraph(second);
  assert.equal(freshOutputNodes(second.nodes, { nodes: before.nodes, capturedAt: '' }, second.runs).length, 2);
  const doc = new Y.Doc(); applyLocalGraph(doc, second, { nodes: [], edges: [], groups: [], runs: [] });
  assert.ok(boardStats(doc).covers.includes(poster)); assert.equal(boardStats(doc).imageCount, 4); doc.destroy();
  let fetches = 0; assert.deepEqual(await createCanvasThumbnail('/assets/' + asset, { fetchImage: () => { fetches++; } }), { src: '' }); assert.equal(fetches, 0);
  assert.match(blockedMediaSelector, /model-viewer/);
  assert.match(generationRows([run])[0].status, /Generating 3D/);
});

test('MCP adds one 3D generator connected only to image nodes and describes model assets/posters', () => {
  const tool = toolByName.get('add_model3d_node'), g = graph(1), generated = model();
  Object.assign(generated.data, { modeler: 'rodin', source: { nodeId: 'i0', name: 'Cube' }, bytes: cubeGlb().length, usd: .4 }); g.nodes.push(generated);
  const args = { boardId: '11111111-1111-1111-1111-111111111111', imageIds: ['i0'] }; checkArgs(args, tool.inputSchema);
  const ctx = { graph: g, args, prepared: { fal: true }, templates: [], user: { name: 'Lead' } };
  const { graph: next, result } = runBoardTool(tool, ctx); assert.equal(next.nodes.find(n => n.id === result.nodeId).data.modeler, 'hunyuan'); assert.ok(next.edges.some(e => e.source === 'i0' && e.target === result.nodeId));
  assert.throws(() => runBoardTool(tool, { ...ctx, prepared: { fal: false } }), /fal.ai key/);
  assert.throws(() => runBoardTool(tool, { ...ctx, args: { imageIds: ['model'] } }), /image nodes/);
  const shown = runBoardTool(toolByName.get('get_board'), { ...ctx, args: {} }).result.nodes.find(n => n.type === 'model'); assert.equal(shown.data.asset, asset); assert.equal(shown.data.poster, poster);
  assert.deepEqual(shown.data, generated.data);
  checkArgs({ boardId: args.boardId, nodeId: 'model' }, toolByName.get('get_image').inputSchema);
});

test('new viewer code parses without installing packages and package versions stay pinned', async () => {
  const { transform } = await import('esbuild');
  for (const path of ['src/main.jsx', 'src/ModelNode.jsx', 'src/NodeContextMenu.jsx']) await transform(await readFile(new URL('../' + path, import.meta.url), 'utf8'), { loader: 'jsx', format: 'esm' });
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies['@google/model-viewer'], '4.4.0'); assert.equal(pkg.dependencies.three, '0.183.2');
});

test('fake fal queue serves every documented shape and supports pending/cancel without opening a port', async t => {
  const { fakeFalHandler } = await import('../scripts/fake-fal.mjs'), { Readable } = await import('node:stream');
  t.mock.method(console, 'log', () => {});
  const handler = fakeFalHandler({ delay: 5 }), origin = 'http://127.0.0.1:8790';
  const call = async (url, method = 'GET', input) => {
    const request = Readable.from(input ? [Buffer.from(JSON.stringify(input))] : []); Object.assign(request, { url, method, headers: { host: '127.0.0.1:8790', authorization: 'Key fake' } });
    let body, status, headers;
    await handler(request, { writeHead: (s, h) => { status = s; headers = h; }, end: bytes => { body = bytes; } });
    return { status, headers, body, json: () => JSON.parse(body) };
  };
  for (const model of ['fal-ai/topaz/upscale/image', 'fal-ai/seedvr/upscale/image', ...Object.values(model3dModels)]) {
    const queued = (await call('/' + model, 'POST', { image_url: 'data:image/png;base64,AQID' })).json();
    assert.equal((await call(queued.status_url.slice(origin.length))).json().status, 'IN_PROGRESS');
    await new Promise(resolve => setTimeout(resolve, 8));
    assert.equal((await call(queued.status_url.slice(origin.length))).json().status, 'COMPLETED');
    const result = (await call(queued.response_url.slice(origin.length))).json();
    assert.ok(result[model.includes('upscale') ? 'image' : model === model3dModels.rodin ? 'model_mesh' : 'model_glb'].url);
    assert.equal(!!result.thumbnail, model === model3dModels.hunyuan);
    await call(queued.cancel_url.slice(origin.length), 'PUT'); assert.equal((await call(queued.status_url.slice(origin.length))).status, 422);
  }
  const cube = await call('/cube.glb'); assert.equal(cube.headers['Content-Type'], 'model/gltf-binary'); validateGlb(cube.body);
  assert.equal((await call('/thumbnail.png')).headers['Content-Type'], 'image/png');
});

test('clipboard asset checks include models, their posters and hidden template/image references', async () => {
  const { imageAssets } = await import('../src/image-edits.mjs');
  const selection = { nodes: [model(), node('i', 'image', { asset: image }), node('t', 'text', { text: '', template: { name: 'Style', instructions: '', assets: [poster] } })] };
  assert.deepEqual([...new Set(selection.nodes.flatMap(imageAssets))], [asset, poster, image]);
});
