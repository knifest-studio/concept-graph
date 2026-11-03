import test from 'node:test';
import { templateSnapshot } from '../graph.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

test('stdio MCP discovers the authenticated local app and synchronizes graph edits without overwrites', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'concept-mcp-'));
  const token = 'test-token-'.repeat(5), sessionId = randomUUID(), boardId = randomUUID(), asset = randomUUID() + '.png';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=', 'base64');
  const board = { id: boardId, name: 'Synthetic', graph: { revision: 0, nodes: [], edges: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 }, runs: [] } };
  const templateId = randomUUID();
  let savedTemplate = { id: templateId, name: 'Views', instructions: 'Front and side', assets: [], labelOutputs: true, createdAt: new Date().toISOString() };
  let conflicts = 1, graphWrites = 0, renameConflict = true, renameCalls = 0;
  const server = createServer(async (req, res) => {
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers['x-concept-graph-mcp-token'] !== token) return send({ error: 'Unauthorized.' }, 403);
    if (req.url === '/api/mcp/session') return send({ sessionId });
    if (req.url === '/api/mcp/canvas-screenshot') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png); }
    if (req.url === '/api/workspace') return send({ boards: [{ id: boardId, name: board.name }], defaultBoardId: boardId });
    if (req.url === '/api/templates' && req.method === 'GET') return send({ templates: [savedTemplate] });
    if (req.url === `/api/templates/${templateId}` && req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const value = JSON.parse(Buffer.concat(chunks));
      if (JSON.stringify(value.expected) !== JSON.stringify(savedTemplate)) return send({ error: 'Template changed.' }, 409);
      savedTemplate = { ...savedTemplate, name: value.name, instructions: value.instructions, assets: value.assets, labelOutputs: value.labelOutputs };
      return send({ template: savedTemplate });
    }
    if (req.url === `/api/boards/${boardId}` && req.method === 'GET') return send({ board });
    if (req.url === `/api/boards/${boardId}` && req.method === 'PATCH') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const value = JSON.parse(Buffer.concat(chunks)); renameCalls++;
      if (renameConflict) { renameConflict = false; board.name = 'Concurrent rename'; }
      if (value.expectedName !== board.name) return send({ error: 'Board name changed.' }, 409);
      board.name = value.name; return send({ id: boardId, name: board.name });
    }
    if (req.url === `/api/mcp/boards/${boardId}/graph`) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const next = JSON.parse(Buffer.concat(chunks));
      if (conflicts-- > 0) { board.graph.revision++; if (board.graph.nodes.length) board.graph.nodes[0].data.text = 'Concurrent user edit'; return send({ error: 'Revision conflict.' }, 409); }
      if (next.revision !== board.graph.revision) return send({ error: 'Revision conflict.' }, 409);
      Object.assign(board.graph, next, { revision: next.revision + 1 }); graphWrites++;
      return send({ applied: true, revision: board.graph.revision, uiSynchronized: false });
    }
    if (req.url === '/assets/' + asset) { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png); }
    return send({ error: 'Not found.' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const descriptor = path.join(dir, '.mcp-session.json');
  await writeFile(descriptor, JSON.stringify({ version: 1, port: server.address().port, token, sessionId }), { mode: 0o600 });
  const child = spawn(process.execPath, ['mcp.mjs'], { env: { ...process.env, CONCEPT_GRAPH_MCP_SESSION_FILE: descriptor }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(), errors = [];
  createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); const resolve = pending.get(message.id); if (resolve) { pending.delete(message.id); resolve(message); } });
  child.stderr.on('data', chunk => errors.push(chunk.toString()));
  t.after(async () => { child.stdin.end(); if (child.exitCode === null) await once(child, 'exit'); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  let nextId = 0;
  const request = (method, params = {}) => new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = (name, args = {}) => request('tools/call', { name, arguments: args });
  const initialize = await request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initialize.result.protocolVersion, '2025-06-18');
  const list = await request('tools/list');
  assert.ok(list.result.tools.some(tool => tool.name === 'add_text_node'));
  assert.equal((await request('ping')).result.constructor, Object);
  const invalid = await call('add_text_node', { boardId, text: 'x', extra: 42 });
  assert.equal(invalid.result.isError, true);
  assert.equal((await call('add_text_node', { boardId, text: 'Synthetic prompt' })).result.isError, true);
  assert.equal(graphWrites, 0); assert.equal(board.graph.nodes.length, 0);
  const added = await call('add_text_node', { boardId, text: 'Synthetic prompt' });
  const result = JSON.parse(added.result.content[0].text);
  assert.equal(graphWrites, 1); assert.equal(board.graph.nodes.length, 1); assert.equal(result.revision, 2);
  assert.equal(result.uiSynchronized, false); assert.match(result.warning, /saved/i);
  conflicts = 1;
  const stale = await call('update_node', { boardId, nodeId: result.nodeId, text: 'Agent edit' });
  assert.equal(stale.result.isError, true); assert.match(stale.result.content[0].text, /read the board again/i);
  assert.equal(board.graph.nodes[0].data.text, 'Concurrent user edit'); assert.equal(graphWrites, 1);
  board.graph.runs.push({ id: 'synthetic-history' });
  const replacement = structuredClone(board.graph);
  replacement.nodes.push({ id: randomUUID(), type: 'text', position: { x: 100, y: 20 }, data: { text: 'Another node' } });
  const bulkArgs = { boardId, expectedRevision: replacement.revision, nodes: replacement.nodes, edges: replacement.edges, groups: replacement.groups, viewport: replacement.viewport };
  const bulk = await call('apply_graph', bulkArgs);
  assert.equal(JSON.parse(bulk.result.content[0].text).applied, true);
  assert.equal(board.graph.nodes.length, 2); assert.equal(board.graph.runs[0].id, 'synthetic-history');
  assert.equal((await call('apply_graph', bulkArgs)).result.isError, true);
  assert.equal(board.graph.nodes.length, 2); assert.equal(graphWrites, 2);
  assert.equal((await call('get_board', { boardId })).result.isError, undefined);
  assert.equal((await call('rename_board', { boardId, name: 'Agent rename' })).result.isError, true);
  assert.equal(board.name, 'Concurrent rename'); assert.equal(renameCalls, 1);
  assert.equal((await call('rename_board', { boardId, name: 'Agent rename' })).result.isError, undefined);
  assert.equal(board.name, 'Agent rename'); assert.equal(renameCalls, 2);
  assert.equal((await call('update_node', { boardId, nodeId: result.nodeId, labelOutputs: true })).result.isError, undefined);
  assert.equal(board.graph.nodes.find(n => n.id === result.nodeId).data.labelOutputs, true);
  const snapshot = { name: 'Views', instructions: 'Front and side', assets: [] };
  const nodeData = () => board.graph.nodes.find(n => n.id === result.nodeId).data;
  assert.equal((await call('update_node', { boardId, nodeId: result.nodeId, template: snapshot })).result.isError, undefined);
  assert.equal(nodeData().labelOutputs, false);
  assert.equal((await call('update_node', { boardId, nodeId: result.nodeId, template: { ...snapshot, labelOutputs: true } })).result.isError, undefined);
  assert.equal(nodeData().labelOutputs, true);
  assert.equal((await call('update_node', { boardId, nodeId: result.nodeId, text: 'Keep caption setting' })).result.isError, undefined);
  assert.equal(nodeData().labelOutputs, true);
  assert.equal((await call('update_node', { boardId, nodeId: result.nodeId, template: { ...snapshot, labelOutputs: true }, labelOutputs: false })).result.isError, undefined);
  assert.equal(nodeData().labelOutputs, false);
  assert.equal((await call('update_node', { boardId, nodeId: result.nodeId, template: { ...snapshot, labelOutputs: 'true' } })).result.isError, true);
  assert.equal(nodeData().labelOutputs, false);
  const captioned = await call('add_image_node', { boardId, asset, caption: 'Front view' });
  const captionedId = JSON.parse(captioned.result.content[0].text).nodeId;
  assert.equal(board.graph.nodes.find(n => n.id === captionedId).data.caption, 'Front view');
  const beforeSwitch = structuredClone(board.graph.nodes.find(n => n.id === result.nodeId));
  const beforeEdges = structuredClone(board.graph.edges);
  assert.equal((await call('set_node_template', { boardId, nodeId: result.nodeId, templateId })).result.isError, undefined);
  assert.equal(nodeData().text, beforeSwitch.data.text);
  assert.deepEqual(nodeData().template, templateSnapshot(savedTemplate));
  assert.deepEqual(board.graph.nodes.find(n => n.id === result.nodeId).position, beforeSwitch.position);
  assert.deepEqual(board.graph.edges, beforeEdges);
  assert.equal((await call('clear_node_template', { boardId, nodeId: result.nodeId })).result.isError, undefined);
  assert.equal(nodeData().template, undefined);
  assert.equal(nodeData().text, beforeSwitch.data.text);
  assert.equal((await call('set_node_template', { boardId, nodeId: captionedId, templateId })).result.isError, true);
  assert.equal((await call('update_node', { boardId, nodeId: result.nodeId, collapsed: true })).result.isError, undefined);
  assert.equal(nodeData().collapsed, true);
  assert.equal((await call('update_node', { boardId, nodeId: captionedId, collapsed: true })).result.isError, undefined);
  assert.equal(board.graph.nodes.find(n => n.id === captionedId).data.collapsed, true);
  assert.equal((await call('update_node', { boardId, nodeId: captionedId, labelOutputs: true })).result.isError, true);
  assert.equal((await call('update_node', { boardId, nodeId: captionedId, caption: '' })).result.isError, undefined);
  assert.equal(board.graph.nodes.find(n => n.id === captionedId).data.caption, undefined);
  assert.equal((await call('update_node', { boardId, nodeId: result.nodeId, caption: 'Wrong type' })).result.isError, true);
  assert.equal((await call('update_template', { templateId, name: 'Renamed', instructions: '', assets: [] })).result.isError, undefined);
  assert.equal(savedTemplate.labelOutputs, true);
  assert.equal((await call('update_template', { templateId, name: 'Renamed', instructions: '', assets: [], labelOutputs: false })).result.isError, undefined);
  assert.equal(savedTemplate.labelOutputs, false);
  const image = await call('get_image', { asset });
  assert.equal(image.result.content[0].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(image.result.content[0].data, 'base64'), png);
  const screenshot = await call('get_canvas_screenshot');
  assert.equal(screenshot.result.content[0].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(screenshot.result.content[0].data, 'base64'), png);
  const output = path.join(dir, 'existing.png'); await writeFile(output, 'keep');
  assert.equal((await call('save_image', { asset, path: output })).result.isError, true);
  assert.equal(await readFile(output, 'utf8'), 'keep');
  assert.equal((await call('save_image', { asset, path: dir + '/../escape.png' })).result.isError, true);
  await writeFile(descriptor, JSON.stringify({ version: 1, port: server.address().port, token, sessionId: randomUUID() }), { mode: 0o600 });
  assert.equal((await call('list_boards')).result.isError, true);
  if (process.platform !== 'win32') { await chmod(descriptor, 0o644); assert.equal((await call('list_boards')).result.isError, true); }
  assert.equal(errors.join('').includes(token), false);
});

test('lost or ambiguous mutation responses never invite or perform a blind retry', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'concept-mcp-uncertain-'));
  const token = 'test-token-'.repeat(5), sessionId = randomUUID(), boardId = randomUUID(), nodeId = randomUUID();
  const board = { id: boardId, name: 'Synthetic', graph: { revision: 0, nodes: [{ id: nodeId, type: 'text', position: { x: 0, y: 0 }, data: { text: 'Prompt' } }], edges: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 }, runs: [] } };
  const counts = { create: 0, graph: 0, run: 0 };
  const server = createServer(async (req, res) => {
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers['x-concept-graph-mcp-token'] !== token) return send({ error: 'Unauthorized.' }, 403);
    if (req.url === '/api/mcp/session') return send({ sessionId });
    if (req.url === `/api/boards/${boardId}` && req.method === 'GET') return send({ board });
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/api/boards' && req.method === 'POST') { counts.create++; req.socket.destroy(); return; }
    if (req.url === `/api/mcp/boards/${boardId}/graph`) {
      counts.graph++; const next = JSON.parse(Buffer.concat(chunks));
      Object.assign(board.graph, next, { revision: next.revision + 1 });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{'); return;
    }
    if (req.url === `/api/mcp/boards/${boardId}/runs`) { counts.run++; board.graph.runs.push({ id: randomUUID() }); return send({ error: 'Response failed after commit.' }, 503); }
    return send({ error: 'Not found.' }, 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const descriptor = path.join(dir, 'session.json');
  await writeFile(descriptor, JSON.stringify({ version: 1, port: server.address().port, token, sessionId }), { mode: 0o600 });
  const child = spawn(process.execPath, ['mcp.mjs'], { env: { ...process.env, CONCEPT_GRAPH_MCP_SESSION_FILE: descriptor }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); const resolve = pending.get(message.id); if (resolve) { pending.delete(message.id); resolve(message); } });
  t.after(async () => { child.stdin.end(); if (child.exitCode === null) await once(child, 'exit'); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  let nextId = 0;
  const call = (name, args) => new Promise(resolve => { const id = ++nextId; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'); });
  for (const [name, args] of [['create_board', { name: 'New board' }], ['add_text_node', { boardId, text: 'Added once' }], ['start_run', { boardId, nodeId }]]) {
    const result = await call(name, args);
    assert.equal(result.result.isError, true);
    assert.match(result.result.content[0].text, /may already have been applied/i);
    assert.match(result.result.content[0].text, /before retrying/i);
  }
  assert.deepEqual(counts, { create: 1, graph: 1, run: 1 });
  assert.equal(board.graph.nodes.length, 2); assert.equal(board.graph.runs.length, 1);
});
