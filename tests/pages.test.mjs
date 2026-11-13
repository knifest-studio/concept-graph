import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { validateGraph, duplicateNodes, imageNode, positionRunOutput, groupRunOutputs, commitGraph } from '../graph.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { CloudGeneration } from '../src/cloud-generation.mjs';
import { exportBoardArchive, importBoardArchive } from '../board-archive.mjs';
import { createBoard, loadWorkspace, writeWorkspace } from '../workspace.mjs';
import { assignPage, boardPages, mergePages, nextPageName, nodePage, pageContent, peersOnPage, readPagePreference, storedPages, targetPage, writePagePreference } from '../src/pages.mjs';

const asset = '12345678-1234-1234-1234-123456789abc.png';
const first = { id: 'page-1', name: 'Page 1' }, second = { id: 'b', name: 'Backgrounds' }, pages = [first, second];
const text = (id, page, position = { x: 0, y: 0 }) => ({ id, type: 'text', position, data: { text: id }, ...(page ? { page } : {}) });
const empty = () => ({ nodes: [], edges: [], groups: [], runs: [] });
const exchange = (a, b) => { Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); Y.applyUpdate(a, Y.encodeStateAsUpdate(b)); };
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }

test('boards without pages have one default page; connections, groups and stamps stay within a page', () => {
  assert.deepEqual(boardPages({ nodes: [], edges: [] }), [first]);
  assert.equal(nodePage(text('a'), boardPages({})), 'page-1');
  const graph = { pages, nodes: [text('a'), text('a2', 'page-1'), text('c', 'b'), text('d', 'b')], edges: [{ id: 'e', source: 'c', target: 'd' }], groups: [{ id: 'g', name: 'G', nodeIds: ['a', 'a2'], collapsed: false }] };
  assert.doesNotThrow(() => validateGraph(graph));
  assert.throws(() => validateGraph({ ...graph, edges: [{ id: 'x', source: 'a', target: 'c' }] }), /Connections cannot span pages/);
  assert.throws(() => validateGraph({ ...graph, groups: [{ id: 'g', name: 'G', nodeIds: ['a', 'c'], collapsed: false }] }), /Groups cannot span pages/);
  const stamp = { id: 's', type: 'stamp', position: { x: 0, y: 0 }, data: { kind: 'like', attachedTo: 'a' }, page: 'b' };
  assert.throws(() => validateGraph({ ...graph, nodes: [...graph.nodes, stamp] }), /stamp attachment/);
  assert.doesNotThrow(() => validateGraph({ ...graph, nodes: [...graph.nodes, { ...stamp, data: { ...stamp.data, attachedTo: 'c' } }] }));
  for (const invalid of [[], [{ id: 'page-1', name: '' }], [first, { ...first }], [{ id: '', name: 'A' }], [{ id: 'x', name: ' A' }], [{ id: 'x', name: 'A', order: 1 }], [{ id: 'x', name: 'x'.repeat(81) }], Array.from({ length: 101 }, (_, i) => ({ id: `p${i}`, name: 'P' }))]) {
    assert.throws(() => validateGraph({ pages: invalid, nodes: [], edges: [] }), /page/i);
  }
  for (const page of [7, '', 'x'.repeat(121), null]) assert.throws(() => validateGraph({ nodes: [{ ...text('a'), page }], edges: [] }), /node page/);
  // A page deleted by a concurrent editor leaves its node visible on the first page with its raw page retained.
  const orphan = { pages, nodes: [text('a'), text('z', 'gone')], edges: [{ id: 'e', source: 'a', target: 'z' }] };
  assert.doesNotThrow(() => validateGraph(orphan));
  assert.equal(nodePage(orphan.nodes[1], pages), 'page-1'); assert.equal(orphan.nodes[1].page, 'gone');
  assert.equal(nodePage(text('legacy'), [second]), 'b');
  assert.deepEqual(pageContent(graph, 'b'), { nodes: [graph.nodes[2], graph.nodes[3]], edges: graph.edges, groups: [] });
  assert.deepEqual(pageContent(graph, 'page-1').groups, graph.groups);
});

test('page helpers name, store, merge and remember pages without touching untouched boards', () => {
  assert.equal(nextPageName([first]), 'Page 2');
  assert.equal(nextPageName([first, { id: 'x', name: 'Page 3' }]), 'Page 4');
  assert.equal(storedPages([first], undefined), undefined);
  assert.deepEqual(storedPages([first], [first, second]), [first]);
  assert.deepEqual(storedPages([{ id: 'page-1', name: 'Concepts' }], undefined), [{ id: 'page-1', name: 'Concepts' }]);
  assert.deepEqual(assignPage({ id: 'n', page: 'b', data: {} }, 'page-1'), { id: 'n', data: {} });
  assert.deepEqual(assignPage({ id: 'n', data: {} }, 'b'), { id: 'n', data: {}, page: 'b' });
  const base = [first, second], local = [{ ...first, name: 'Mine' }], remote = [first, { ...second, name: 'Theirs' }, { id: 'new', name: 'New' }];
  assert.deepEqual(mergePages(local, remote, base), [{ ...first, name: 'Mine' }, { id: 'new', name: 'New' }]);
  assert.deepEqual(mergePages(base, remote, base), [first, { ...second, name: 'Theirs' }, { id: 'new', name: 'New' }]);
  const store = new Map(), storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.deepEqual(readPagePreference(storage, 'k'), { page: 'page-1', viewports: {} });
  writePagePreference(storage, 'k', { page: 'b', viewports: { b: { x: 1, y: 2, zoom: .5 }, gone: { x: 0, y: 0, zoom: 1 } } }, pages);
  assert.deepEqual(readPagePreference(storage, 'k'), { page: 'b', viewports: { b: { x: 1, y: 2, zoom: .5 } } });
  store.set('k', '{"page":7,"viewports":{"b":{"x":"1","y":0,"zoom":1}}}');
  assert.deepEqual(readPagePreference(storage, 'k'), { page: 'page-1', viewports: {} });
  assert.deepEqual(readPagePreference({ getItem: () => { throw new Error('blocked'); } }, 'k'), { page: 'page-1', viewports: {} });
  const peers = [{ id: 1, page: 'b' }, { id: 2 }, { id: 3, page: 'gone' }];
  assert.deepEqual(peersOnPage(peers, pages, 'page-1').map(peer => peer.id), [2, 3]);
  assert.deepEqual(peersOnPage(peers, pages, 'b').map(peer => peer.id), [1]);
});

test('duplicates keep their page and commits keep or replace the page list atomically', async () => {
  const graph = { revision: 1, pages, nodes: [text('a', 'b'), text('c', 'b')], edges: [{ id: 'e', source: 'a', target: 'c' }], groups: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const copies = duplicateNodes(graph, ['c'], { ids: new Map([['c', 'copy']]), edgeIds: new Map([['e', 'copy-edge']]) });
  assert.equal(copies.nodes[0].page, 'b'); assert.deepEqual(copies.edges, [{ id: 'copy-edge', source: 'a', target: 'copy' }]);
  assert.doesNotThrow(() => validateGraph({ ...graph, nodes: [...graph.nodes, ...copies.nodes], edges: [...graph.edges, ...copies.edges] }));
  await assert.rejects(commitGraph(graph, { nodes: [], edges: [], groups: [], pages: [first] }, async () => { throw new Error('disk'); }), /disk/);
  assert.deepEqual(graph.pages, pages); assert.equal(graph.revision, 1);
  await commitGraph(graph, { nodes: [], edges: [], groups: [], pages: [first] }, async () => {});
  assert.deepEqual(graph.pages, [first]);
  const legacy = { revision: 0, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await commitGraph(legacy, { nodes: [text('a')], edges: [], groups: [] }, async () => {});
  assert.equal(Object.hasOwn(legacy, 'pages'), false);
});

test('local run outputs land on the page frozen at submission and fall back to the first page', () => {
  const prompt = text('p', 'b', { x: 0, y: 0 }), blocker = { id: 'blocker', type: 'text', position: { x: 390, y: -20 }, data: { text: 'Page 1 content' } };
  const graph = { pages, nodes: [prompt, blocker], edges: [], groups: [], runs: [] };
  const run = { id: 'run', nodeId: 'p', page: 'b', target: prompt, outputIds: [] };
  const output = imageNode(run, asset, 0);
  positionRunOutput(output, graph, run);
  // Content on another page is not an obstacle.
  assert.equal(output.page, 'b'); assert.deepEqual(output.position, { x: 390, y: 0 });
  graph.nodes.push(output); run.outputIds.push(output.id);
  const second = imageNode(run, asset, 1); positionRunOutput(second, graph, run); graph.nodes.push(second); run.outputIds.push(second.id);
  assert.equal(groupRunOutputs(graph, run), true); assert.doesNotThrow(() => validateGraph(graph));
  // The page was deleted while the run continued.
  const after = { ...graph, pages: [first], nodes: [blocker], groups: [] };
  const late = imageNode(run, asset, 2); positionRunOutput(late, after, run);
  assert.equal(Object.hasOwn(late, 'page'), false); assert.ok(late.position.y > blocker.position.y + 80);
  after.nodes.push(late); run.outputIds.push(late.id);
  assert.doesNotThrow(() => validateGraph(after));
});

function cloudGeneration(doc, state) {
  const services = {
    doc, boardId: 'board', user: { name: 'Artist', color: '#448bfa' }, ready: () => true, onError: () => {},
    request: async () => new Response(new Uint8Array([1])), helperRequest: async () => new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } }),
    api: async () => ({ asset }),
    helperApi: async (url, options = {}) => {
      if (options.method === 'POST') { const input = JSON.parse(options.body); state.jobs.push({ id: input.jobId, boardId: 'board', nodeId: input.nodeId, startedAt: '2026-11-03T10:00:00.000Z', status: 'running', outputs: [] }); return {}; }
      if (options.method === 'DELETE') { state.jobs = state.jobs.filter(job => url !== `/api/cloud-jobs/${job.id}`); return {}; }
      return { jobs: structuredClone(state.jobs) };
    },
  };
  const generation = new CloudGeneration(services); generation.active = true;
  return generation;
}

test('cloud runs freeze their page; outputs stay there or move to the first page if it is deleted', async () => {
  const doc = new Y.Doc(), state = { jobs: [] }, generation = cloudGeneration(doc, state);
  applyLocalGraph(doc, { ...empty(), pages, nodes: [text('p', 'b', { x: 80, y: 40 }), text('other', undefined, { x: 470, y: 40 })] }, empty(), 'seed');
  await generation.start('p'); await new Promise(resolve => setImmediate(resolve));
  const [job] = state.jobs;
  assert.equal(doc.getMap('runs').get(job.id).page, 'b');
  job.status = 'completed'; job.outputs = [{ index: 0 }, { index: 1 }];
  await generation.tick();
  let graph = readCloudGraph(doc);
  const outputs = graph.nodes.filter(node => node.data.runId === job.id);
  assert.deepEqual(outputs.map(node => node.page), ['b', 'b']);
  assert.equal(graph.edges.filter(edge => edge.source === 'p').length, 2); assert.equal(graph.groups.length, 1);
  assert.doesNotThrow(() => validateGraph(graph));
  // Delete the prompt's page after a second submission; late outputs fall back to the first page without edges.
  await generation.start('p'); await new Promise(resolve => setImmediate(resolve));
  const late = state.jobs.at(-1);
  graph = readCloudGraph(doc);
  const removed = { ...structuredClone(graph), pages: [first], nodes: graph.nodes.filter(node => nodePage(node, pages) !== 'b'), edges: [], groups: [] };
  applyLocalGraph(doc, removed, graph, 'delete-page');
  late.status = 'completed'; late.outputs = [{ index: 0 }];
  await generation.tick();
  graph = readCloudGraph(doc);
  const fallback = graph.nodes.find(node => node.data.runId === late.id);
  assert.equal(Object.hasOwn(fallback, 'page'), false); assert.equal(graph.edges.length, 0);
  assert.notDeepEqual(fallback.position, { x: 470, y: 40 });
  assert.doesNotThrow(() => validateGraph(graph));
  generation.stop();
});

test('cloud pages sync in a deterministic order, undo with the board, and keep raw node pages', () => {
  const a = new Y.Doc(), b = new Y.Doc(), origin = {};
  const undo = new Y.UndoManager([a.getMap('nodes'), a.getMap('edges'), a.getMap('groups'), a.getMap('pages')], { trackedOrigins: new Set([origin]) });
  applyLocalGraph(a, { ...empty(), nodes: [text('a')] }, empty(), 'seed'); exchange(a, b);
  let base = readCloudGraph(a);
  assert.equal(Object.hasOwn(base, 'pages'), false); assert.equal(a.getMap('pages').size, 0);
  // Saving an untouched board without a page list writes no pages.
  applyLocalGraph(a, { ...base, nodes: [{ ...base.nodes[0], position: { x: 5, y: 0 } }] }, base, 'move');
  assert.equal(a.getMap('pages').size, 0);
  base = readCloudGraph(a); exchange(a, b);
  applyLocalGraph(a, { ...base, pages: [first, { id: 'x', name: 'Page 2' }], nodes: [...base.nodes, text('on-x', 'x')] }, base, origin);
  applyLocalGraph(b, { ...base, pages: [first, { id: 'w', name: 'Page 2' }] }, base, 'remote');
  exchange(a, b);
  assert.deepEqual(readCloudGraph(a).pages.map(page => page.id), ['page-1', 'w', 'x']);
  assert.deepEqual(readCloudGraph(a), readCloudGraph(b));
  assert.equal(readCloudGraph(b).nodes.find(node => node.id === 'on-x').page, 'x');
  const reloaded = new Y.Doc(); Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(a)); assert.deepEqual(readCloudGraph(reloaded), readCloudGraph(a));
  // Undo removes the added page together with its node; redo restores both.
  undo.undo(); exchange(a, b);
  assert.deepEqual(readCloudGraph(b).pages.map(page => page.id), ['page-1', 'w']); assert.equal(readCloudGraph(b).nodes.some(node => node.id === 'on-x'), false);
  undo.redo(); exchange(a, b);
  assert.deepEqual(readCloudGraph(b).pages.map(page => page.id), ['page-1', 'w', 'x']); assert.equal(readCloudGraph(b).nodes.find(node => node.id === 'on-x').page, 'x');
  // A later page sorts last; renames merge with concurrent additions.
  base = readCloudGraph(a);
  applyLocalGraph(a, { ...base, pages: [...base.pages, { id: 'a-last', name: 'Page 4' }] }, base, 'add');
  applyLocalGraph(b, { ...base, pages: base.pages.map(page => page.id === 'w' ? { ...page, name: 'Renamed' } : page) }, base, 'rename');
  exchange(a, b);
  assert.deepEqual(readCloudGraph(b).pages, [first, { id: 'w', name: 'Renamed' }, { id: 'x', name: 'Page 2' }, { id: 'a-last', name: 'Page 4' }]);
  // B deletes page x while A concurrently adds a prompt and a connection there.
  base = readCloudGraph(a);
  applyLocalGraph(b, { ...base, pages: base.pages.filter(page => page.id !== 'x'), nodes: base.nodes.filter(node => node.page !== 'x') }, base, 'delete');
  applyLocalGraph(a, { ...base, nodes: [...base.nodes, text('late', 'x')], edges: [{ id: 'late-edge', source: 'on-x', target: 'late' }] }, base, 'late');
  exchange(a, b);
  const graph = readCloudGraph(a), orphan = graph.nodes.find(node => node.id === 'late');
  assert.equal(orphan.page, 'x'); assert.equal(nodePage(orphan, graph.pages), 'page-1');
  assert.equal(graph.edges.length, 0); assert.doesNotThrow(() => validateGraph(graph));
  // Cross-page connections and groups written by a faulty client are ignored on every replica.
  a.transact(() => { a.getMap('edges').set('bad', { source: 'a', target: 'on-w' }); a.getMap('groups').set('bad-group', (() => { const group = new Y.Map(); group.set('name', 'Mixed'); group.set('collapsed', false); group.set('nodeIds', ['a', 'on-w']); return group; })()); });
  applyLocalGraph(a, { ...readCloudGraph(a), nodes: [...readCloudGraph(a).nodes, text('on-w', 'w')] }, readCloudGraph(a), 'w');
  const mixed = readCloudGraph(a);
  assert.equal(mixed.edges.some(edge => edge.id === 'bad'), false); assert.deepEqual(mixed.groups.find(group => group.id === 'bad-group').nodeIds, ['a']);
  undo.destroy(); a.destroy(); b.destroy(); reloaded.destroy();
});

test('page boards export as version 5, older archives open on the first page, and local storage is version-guarded', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-pages-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assets = path.join(directory, 'assets'); await mkdir(assets);
  const createdAt = '2026-11-03T10:00:00.000Z';
  const graph = { revision: 4, pages, nodes: [text('a'), text('c', 'b')], edges: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 }, runs: [{ id: 'r', nodeId: 'c', page: 'b', status: 'completed', createdAt, outputIds: [] }] };
  const bytes = await collect(await exportBoardArchive({ name: 'Paged', createdAt, graph }, assets));
  const zip = await yauzl.fromBufferPromise(bytes); let manifest;
  for await (const entry of zip.eachEntry()) if (entry.fileName === 'board.json') manifest = JSON.parse(await collect(await zip.openReadStreamPromise(entry)));
  zip.close();
  assert.equal(manifest.version, 5);
  const imported = await importBoardArchive(bytes, assets);
  assert.deepEqual(imported.graph.pages, pages); assert.deepEqual(imported.graph.nodes.map(node => node.page), [undefined, 'b']); assert.equal(imported.graph.runs[0].page, 'b');
  const archive = async (version, board) => {
    const file = new yazl.ZipFile(); file.addBuffer(Buffer.from(JSON.stringify({ format: 'concept-graph-board', version, exportedAt: createdAt, board, assets: {} })), 'board.json', { compress: false }); file.end();
    return collect(file.outputStream);
  };
  const legacy = { name: 'Old', createdAt, graph: { revision: 2, nodes: [text('a'), text('b')], edges: [{ id: 'e', source: 'a', target: 'b' }], viewport: { x: 0, y: 0, zoom: 1 }, runs: [] } };
  const old = await importBoardArchive(await archive(4, legacy), assets);
  assert.equal(Object.hasOwn(old.graph, 'pages'), false); assert.deepEqual(pageContent(old.graph, 'page-1').nodes.map(node => node.id), ['a', 'b']);
  await assert.rejects(importBoardArchive(await archive(4, { ...legacy, graph: { ...legacy.graph, pages } }), assets), /uses pages/);
  await assert.rejects(importBoardArchive(await archive(9, legacy), assets), /not supported/);
  const storage = path.join(directory, 'storage'); await mkdir(storage);
  const paged = createBoard('Paged', { ...structuredClone(graph), revision: 0 }), plain = createBoard('Plain');
  await writeWorkspace(storage, { version: 1, defaultBoardId: plain.id, boards: [plain] });
  assert.equal(JSON.parse(await readFile(path.join(storage, 'workspace.json'), 'utf8')).version, 1);
  await writeWorkspace(storage, { version: 1, defaultBoardId: plain.id, boards: [plain, paged] });
  assert.equal(JSON.parse(await readFile(path.join(storage, 'workspace.json'), 'utf8')).version, 2);
  assert.deepEqual((await loadWorkspace(storage)).boards[1].graph.pages, pages);
  await writeFile(path.join(storage, 'workspace.json'), JSON.stringify({ version: 3, defaultBoardId: plain.id, boards: [plain] }));
  await assert.rejects(loadWorkspace(storage), /Invalid board storage/);
});

test('agents name the page for new nodes on multi-page boards; node operations infer and check it', () => {
  assert.equal(targetPage({ nodes: [text('a')], edges: [] }), 'page-1');
  const multi = { pages, nodes: [text('a'), text('c', 'b')], edges: [] };
  assert.throws(() => targetPage(multi), /2 pages; pass pageId\. Pages: page-1 \(Page 1\), b \(Backgrounds\)/);
  assert.equal(targetPage(multi, 'b'), 'b');
  assert.throws(() => targetPage(multi, 'missing'), /Page not found: missing/);
  assert.equal(targetPage(multi, undefined, ['c']), 'b');
  assert.throws(() => targetPage(multi, 'page-1', ['c']), /on page b, not page-1/);
  assert.throws(() => targetPage(multi, undefined, ['a', 'c']), /different pages/);
});

test('stdio MCP exposes pages, requires pageId on multi-page boards and keeps page-1 implicit', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'concept-mcp-pages-'));
  const token = 'test-token-'.repeat(5), sessionId = randomUUID(), boardId = randomUUID();
  const board = { id: boardId, name: 'Paged', graph: { revision: 0, pages, nodes: [text('a'), text('c', 'b', { x: 500, y: 300 }), text('d', 'b', { x: 900, y: 900 })], edges: [{ id: 'e', source: 'c', target: 'd' }], groups: [], viewport: { x: 0, y: 0, zoom: 1 }, runs: [] } };
  const writes = [];
  const server = createServer(async (req, res) => {
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers['x-concept-graph-mcp-token'] !== token) return send({ error: 'Unauthorized.' }, 403);
    if (req.url === '/api/mcp/session') return send({ sessionId });
    if (req.url === `/api/boards/${boardId}` && req.method === 'GET') return send({ board });
    if (req.url === `/api/mcp/boards/${boardId}/graph`) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const next = JSON.parse(Buffer.concat(chunks)); writes.push(next);
      try { validateGraph({ ...next, pages: next.pages ?? board.graph.pages }); } catch (error) { return send({ error: error.message }, 400); }
      Object.assign(board.graph, next, { pages: next.pages ?? board.graph.pages, revision: next.revision + 1 });
      return send({ applied: true, revision: board.graph.revision, uiSynchronized: true });
    }
    return send({ error: 'Not found.' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const descriptor = path.join(dir, '.mcp-session.json');
  await writeFile(descriptor, JSON.stringify({ version: 1, port: server.address().port, token, sessionId }), { mode: 0o600 });
  const child = spawn(process.execPath, ['mcp.mjs'], { env: { ...process.env, CONCEPT_GRAPH_MCP_SESSION_FILE: descriptor }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
  t.after(async () => { child.stdin.end(); if (child.exitCode === null) await once(child, 'exit'); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  let nextId = 0;
  const call = (name, args = {}) => new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); });
  const value = response => JSON.parse(response.result.content[0].text);
  const read = value(await call('get_board', { boardId }));
  assert.deepEqual(read.graph.pages, pages); assert.deepEqual(read.graph.nodes.map(node => node.page), ['page-1', 'b', 'b']);
  const missing = await call('add_text_node', { boardId, text: 'Where?' });
  assert.equal(missing.result.isError, true); assert.match(missing.result.content[0].text, /pass pageId/);
  const added = value(await call('add_text_node', { boardId, text: 'Sky', pageId: 'b' }));
  assert.equal(added.pageId, 'b'); assert.equal(board.graph.nodes.find(node => node.id === added.nodeId).page, 'b');
  assert.deepEqual(writes.at(-1).pages, pages);
  const first = value(await call('add_text_node', { boardId, text: 'Ground', pageId: 'page-1' }));
  assert.equal(Object.hasOwn(board.graph.nodes.find(node => node.id === first.nodeId), 'page'), false);
  const wrong = await call('connect_nodes', { boardId, source: 'a', target: 'c' });
  assert.equal(wrong.result.isError, true); assert.match(wrong.result.content[0].text, /different pages/);
  const mismatch = await call('create_group', { boardId, name: 'G', nodeIds: ['c', 'd'], pageId: 'page-1' });
  assert.equal(mismatch.result.isError, true); assert.match(mismatch.result.content[0].text, /on page b, not page-1/);
  assert.equal((await call('align_board', { boardId })).result.isError, true);
  const aligned = value(await call('align_board', { boardId, pageId: 'b' }));
  assert.equal(aligned.nodes, 3); assert.deepEqual(board.graph.nodes.find(node => node.id === 'a').position, { x: 0, y: 0 });
  const replaced = value(await call('get_board', { boardId }));
  const result = await call('apply_graph', { boardId, expectedRevision: replaced.graph.revision, pages: [{ id: 'page-1', name: ' Renamed ' }], nodes: replaced.graph.nodes.filter(node => node.page === 'page-1'), edges: [], groups: [], viewport: replaced.graph.viewport });
  assert.equal(result.result.isError, undefined);
  assert.deepEqual(board.graph.pages, [{ id: 'page-1', name: 'Renamed' }]); assert.ok(board.graph.nodes.every(node => !Object.hasOwn(node, 'page')));
});

test('local server freezes the run page, keeps pages for editors that omit them and rejects cross-page edges', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-pages-server-'));
  const env = { ...process.env, PORT: '0', CONCEPT_GRAPH_DATA: directory, CODEX_BIN: path.join(process.cwd(), 'tests/fixtures/codex.mjs'), CONCEPT_GRAPH_TEST_DELAY_MS: '50' };
  delete env.CONCEPT_GRAPH_SITE; delete env.CONCEPT_GRAPH_HELPER_TOKEN; delete env.CONCEPT_GRAPH_DESKTOP;
  const child = spawn(process.execPath, ['server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); if (child.exitCode === null && child.signalCode === null) await once(child, 'exit'); await rm(directory, { recursive: true, force: true }); });
  let stdout = '';
  const port = await new Promise((resolve, reject) => {
    child.once('exit', code => reject(new Error(`Server exited ${code}`)));
    child.stdout.on('data', chunk => { stdout += chunk; const match = stdout.match(/ready at http:\/\/127\.0\.0\.1:(\d+)/); if (match) resolve(Number(match[1])); });
  });
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, value: await response.json() };
  };
  const boardId = (await request('/api/workspace')).value.defaultBoardId, route = `/api/boards/${boardId}`;
  const nodes = [text('ground', undefined, { x: 390, y: 0 }), { ...text('sky', 'b'), data: { text: 'Make a test image' } }];
  assert.equal((await request(route + '/graph', 'PUT', { revision: 0, pages, nodes, edges: [{ id: 'x', source: 'ground', target: 'sky' }] })).status, 400);
  assert.equal((await request(route + '/graph', 'PUT', { revision: 0, pages, nodes, edges: [] })).status, 200);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'workspace.json'), 'utf8')).version, 2);
  const run = (await request(route + '/runs', 'POST', { nodeId: 'sky', revision: 1 })).value;
  assert.equal(run.page, 'b');
  let graph;
  for (let attempt = 0; attempt < 80; attempt++) {
    graph = (await request(route)).value.board.graph;
    if (graph.runs[0]?.status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const output = graph.nodes.find(node => node.data.runId === run.id);
  assert.equal(graph.runs[0].status, 'completed'); assert.equal(output.page, 'b'); assert.deepEqual(output.position, { x: 390, y: 0 });
  assert.deepEqual(graph.edges.map(edge => [edge.source, edge.target]), [['sky', output.id]]);
  const { pages: kept, ...older } = graph;
  assert.equal((await request(route + '/graph', 'PUT', older)).status, 200);
  assert.deepEqual((await request(route)).value.board.graph.pages, kept);
});
