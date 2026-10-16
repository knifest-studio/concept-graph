import http from 'node:http';
import { readFile, writeFile, mkdir, rename, stat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { exportBoardArchive, importBoardArchive, maxBoardArchiveBytes } from './board-archive.mjs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Codex } from './codex.mjs';
import { collectInputs, imageNode, imageFormat, validateGraph } from './graph.mjs';
import { loadWorkspace, writeWorkspace, createBoard, boardName } from './workspace.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.CONCEPT_GRAPH_DATA || path.join(root, 'data'));
const assetsDir = path.join(dataDir, 'assets');
const port = Number(process.env.PORT || 4317);
await mkdir(assetsDir, { recursive: true });
const workspace = await loadWorkspace(dataDir);
for (const board of workspace.boards) for (const run of board.graph.runs) {
  if (['queued', 'running'].includes(run.status)) {
    run.status = 'error'; run.error = 'The app stopped during this run. Existing results are preserved; run again to retry.';
    run.finishedAt = new Date().toISOString();
  }
}
let writes = Promise.resolve();
function persist() {
  const snapshot = structuredClone(workspace);
  const operation = writes.catch(() => {}).then(() => writeWorkspace(dataDir, snapshot));
  writes = operation;
  return operation;
}
await persist();
const boardList = () => ({ defaultBoardId: workspace.defaultBoardId, boards: workspace.boards.map(({ id, name, createdAt }) => ({ id, name, createdAt })) });
function getBoard(id) {
  const board = workspace.boards.find(board => board.id === id);
  if (!board) throw Object.assign(new Error('Board not found.'), { status: 404 });
  return board;
}
const codex = new Codex(dataDir);
let status = { connected: false, signedIn: false, imageGeneration: false };
let activeRun = null;
let processing = false;
const subscribers = new Map();
function publish(type, value, boardId) {
  const message = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const [response, subscribedBoard] of subscribers) if (!boardId || subscribedBoard === boardId) response.write(message);
}
function publicRun(run) {
  const { snapshot, prompt, images, target, ...summary } = run;
  return summary;
}
async function refreshStatus() {
  try { await codex.connect(); status = await codex.status(); }
  catch (error) { status = { connected: false, signedIn: false, imageGeneration: false, error: error.message }; }
  publish('status', status);
  return status;
}
codex.on('disconnected', () => { status.connected = false; publish('status', status); });
refreshStatus();

async function saveImage(buffer) {
  if (buffer.length > 30 * 1024 * 1024) throw new Error('Images must be smaller than 30 MB.');
  const extension = imageFormat(buffer);
  const name = randomUUID() + '.' + extension;
  await writeFile(path.join(assetsDir, name), buffer);
  return name;
}

async function processQueue() {
  if (processing) return;
  processing = true;
  try {
    let board;
    while ((board = workspace.boards.find(b => b.graph.runs.some(r => r.status === 'queued')))) {
      const graph = board.graph;
      const run = graph.runs.find(r => r.status === 'queued');
      const controller = new AbortController();
      activeRun = { id: run.id, controller };
      run.status = 'running'; run.startedAt = new Date().toISOString(); run.message = 'Preparing your image…';
      await persist(); publish('run', publicRun(run), board.id);
      try {
        const result = await codex.generate({
          prompt: run.prompt, images: run.images.map(asset => path.join(assetsDir, asset)), signal: controller.signal,
          onProgress: message => { run.message = message; publish('run', publicRun(run), board.id); },
          onImage: async item => {
            const buffer = item.savedPath ? await readFile(item.savedPath) : Buffer.from(item.result.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
            const asset = await saveImage(buffer);
            const node = imageNode(run, asset, run.outputIds.length);
            // Keep separate reruns visible without covering earlier results.
            while (graph.nodes.some(n => Math.abs(n.position.x - node.position.x) < 310 && Math.abs(n.position.y - node.position.y) < 320)) node.position.y += 340;
            graph.nodes.push(node);
            if (graph.nodes.some(n => n.id === run.nodeId)) graph.edges.push({ id: randomUUID(), source: run.nodeId, target: node.id });
            graph.revision++;
            run.outputIds.push(node.id);
            await persist(); publish('graph', graph, board.id); publish('run', publicRun(run), board.id);
          },
        });
        run.status = 'completed'; run.message = `${result.count} image${result.count === 1 ? '' : 's'} created`;
      } catch (error) {
        run.status = controller.signal.aborted ? 'cancelled' : 'error';
        run.error = error.message; run.message = error.message;
      }
      run.finishedAt = new Date().toISOString();
      activeRun = null;
      await persist(); publish('run', publicRun(run), board.id);
    }
  } catch (error) { console.error('Could not save generation:', error.message); }
  finally { processing = false; }
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.json': 'application/json' };
async function readBody(request, limit = 4 * 1024 * 1024) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function json(response, value, code = 200) {
  response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  try {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(request.headers.host)) return json(response, { error: 'Invalid host.' }, 403);
    if (request.headers.origin && !allowedHosts.some(host => request.headers.origin === 'http://' + host)) return json(response, { error: 'Invalid origin.' }, 403);
    if (request.headers['sec-fetch-site'] === 'cross-site') return json(response, { error: 'Cross-site access is disabled.' }, 403);
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (request.method === 'GET' && url.pathname === '/api/workspace') return json(response, { ...boardList(), status });
    if (request.method === 'POST' && url.pathname === '/api/boards') {
      const { name } = JSON.parse((await readBody(request)).toString());
      const board = createBoard(name);
      workspace.boards.push(board); await persist(); publish('boards', boardList());
      return json(response, board, 201);
    }
    if (request.method === 'POST' && url.pathname === '/api/boards/import') {
      const imported = await importBoardArchive(await readBody(request, maxBoardArchiveBytes), assetsDir);
      let name, number = 1;
      do {
        const suffix = number === 1 ? ' (imported)' : ` (imported ${number})`;
        name = imported.name.slice(0, 80 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix; number++;
      } while (workspace.boards.some(board => board.name === name));
      const board = createBoard(name, imported.graph);
      workspace.boards.push(board);
      try { await persist(); }
      catch (error) {
        workspace.boards.splice(workspace.boards.indexOf(board), 1);
        try {
          await persist();
          await Promise.all(imported.assets.map(asset => rm(path.join(assetsDir, asset), { force: true })));
        } catch (rollbackError) { console.error('Could not complete import rollback:', rollbackError.message); }
        throw error;
      }
      publish('boards', boardList());
      return json(response, { board: { id: board.id, name: board.name, createdAt: board.createdAt } }, 201);
    }
    if (['/api/state', '/api/graph', '/api/runs', '/api/events'].includes(url.pathname)) return json(response, { error: 'Concept Graph was upgraded. Refresh this tab to use boards.' }, 426);
    const boardRoute = url.pathname.match(/^\/api\/boards\/([\da-f-]{36})(?:\/(graph|events|runs|export)(?:\/([\da-f-]{36})\/(cancel))?)?$/);
    const board = boardRoute ? getBoard(boardRoute[1]) : null;
    const graph = board?.graph;
    const action = boardRoute?.[2];
    if (request.method === 'GET' && board && action === 'export') {
      const stream = await exportBoardArchive(board, assetsDir);
      const filename = encodeURIComponent(board.name + '.conceptgraph').replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16));
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="board.conceptgraph"; filename*=UTF-8''${filename}`, 'Cache-Control': 'no-store' });
      await pipeline(stream, response);
      return;
    }
    if (request.method === 'GET' && board && !action) return json(response, { board, status });
    if (request.method === 'PATCH' && board && !action) {
      const { name } = JSON.parse((await readBody(request)).toString());
      board.name = boardName(name); await persist(); publish('boards', boardList());
      return json(response, { id: board.id, name: board.name });
    }
    if (request.method === 'POST' && url.pathname === '/api/status') return json(response, await refreshStatus());
    if (request.method === 'GET' && board && action === 'events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      subscribers.set(response, board.id);
      response.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
      response.write(`event: graph\ndata: ${JSON.stringify(graph)}\n\n`);
      const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15000);
      request.on('close', () => { clearInterval(heartbeat); subscribers.delete(response); });
      return;
    }
    if (request.method === 'PUT' && board && action === 'graph') {
      const next = JSON.parse((await readBody(request)).toString());
      if (next.revision !== graph.revision) return json(response, { error: 'Canvas changed.', graph }, 409);
      // Older open tabs do not send groups; retain their surviving memberships.
      const nodeIds = new Set((next.nodes || []).map(node => node.id));
      next.groups ??= (graph.groups || []).map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => nodeIds.has(id)) })).filter(group => group.nodeIds.length);
      validateGraph(next);
      const availableAssets = new Set(graph.nodes.filter(n => n.type === 'image').map(n => n.data.asset));
      for (const node of next.nodes.filter(n => n.type === 'image')) {
        if (!availableAssets.has(node.data.asset)) await stat(path.join(assetsDir, node.data.asset));
      }
      if (next.revision !== graph.revision) return json(response, { error: 'Canvas changed.', graph }, 409);
      Object.assign(graph, { nodes: next.nodes, edges: next.edges, groups: next.groups, viewport: next.viewport || graph.viewport, revision: graph.revision + 1 });
      const savedRevision = graph.revision;
      await persist();
      return json(response, { revision: savedRevision });
    }
    if (request.method === 'POST' && url.pathname === '/api/assets') {
      const asset = await saveImage(await readBody(request, 30 * 1024 * 1024));
      return json(response, { asset });
    }
    if (request.method === 'POST' && board && action === 'runs' && !boardRoute[3]) {
      const { nodeId, revision } = JSON.parse((await readBody(request)).toString());
      if (revision !== graph.revision) return json(response, { error: 'Canvas changed. Save and try again.', graph }, 409);
      if (graph.runs.some(r => r.nodeId === nodeId && ['queued', 'running'].includes(r.status))) return json(response, { error: 'This prompt is already running.' }, 409);
      const inputs = collectInputs(graph, nodeId);
      for (const asset of inputs.images) await stat(path.join(assetsDir, asset));
      if (revision !== graph.revision) return json(response, { error: 'Canvas changed. Save and try again.', graph }, 409);
      if (graph.runs.some(r => r.nodeId === nodeId && ['queued', 'running'].includes(r.status))) return json(response, { error: 'This prompt is already running.' }, 409);
      const run = { id: randomUUID(), nodeId, ...inputs, status: 'queued', createdAt: new Date().toISOString(), outputIds: [], label: inputs.target.data.text.slice(0, 90) };
      graph.runs.push(run);
      await persist(); publish('run', publicRun(run), board.id);
      json(response, publicRun(run), 202);
      processQueue();
      return;
    }
    const cancel = board && action === 'runs' && boardRoute[4] === 'cancel';
    if (request.method === 'POST' && cancel) {
      const run = graph.runs.find(r => r.id === boardRoute[3]);
      if (!run) return json(response, { error: 'Run not found.' }, 404);
      if (activeRun?.id === run.id) activeRun.controller.abort();
      else if (run.status === 'queued') { run.status = 'cancelled'; run.message = 'Cancelled.'; await persist(); publish('run', publicRun(run), board.id); }
      return json(response, { ok: true });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, { error: 'Not found.' }, 404);
    let filename;
    if (url.pathname.startsWith('/assets/')) {
      const asset = url.pathname.slice('/assets/'.length);
      if (!/^[\da-f-]{36}\.(png|jpg|webp|gif)$/.test(asset)) return json(response, { error: 'Not found.' }, 404);
      filename = path.join(assetsDir, asset);
    } else {
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      filename = path.resolve(root, 'dist', '.' + relative);
      if (!filename.startsWith(path.join(root, 'dist') + path.sep)) return json(response, { error: 'Not found.' }, 404);
    }
    const bytes = await readFile(filename);
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': url.pathname.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch (error) {
    if (!response.headersSent) json(response, { error: error.code === 'ENOENT' ? 'File not found.' : error.message }, error.status || (error.code === 'ENOENT' ? 404 : 400));
    else response.end();
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Concept Graph is ready at http://127.0.0.1:${port}`));
function stop() { activeRun?.controller.abort(); codex.close(); server.close(); for (const s of subscribers.keys()) s.end(); writes.finally(() => process.exit(0)); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
