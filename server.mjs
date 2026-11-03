import http from 'node:http';
import { readFile, writeFile, mkdir, rename, stat, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { exportBoardArchive, importBoardArchive, maxBoardArchiveBytes } from './board-archive.mjs';
import path from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Codex, CodexInstaller, generatedImageCaption } from './codex.mjs';
import { collectInputs, imageNode, imageSize, imageFormat, validateGraph, validateTemplate, groupRunOutputs, positionRunOutput, commitGraph, generationSettings, nextTemplateColor } from './graph.mjs';
import { loadWorkspace, writeWorkspace, createBoard, boardName } from './workspace.mjs';
import { authorizeHelper, helperOrigins } from './helper-auth.mjs';
import { McpCoordinator } from './mcp-coordinator.mjs';
import { boardPages, nodePage, pageField, samePage } from './src/pages.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.CONCEPT_GRAPH_DATA || path.join(root, 'data'));
const assetsDir = path.join(dataDir, 'assets');
const port = Number(process.env.PORT || 4317);
const desktop = process.env.CONCEPT_GRAPH_DESKTOP === '1';
const mcpSessionFile = desktop && process.env.CONCEPT_GRAPH_MCP_SESSION_FILE;
if (mcpSessionFile && !path.isAbsolute(mcpSessionFile)) throw new Error('The MCP session file must use an absolute path.');
let mcpToken = mcpSessionFile ? randomBytes(32).toString('hex') : '';
const mcpSessionId = mcpSessionFile ? randomUUID() : '';
const helperSite = process.env.CONCEPT_GRAPH_SITE;
const helperSites = helperOrigins(helperSite || '');
const helperToken = process.env.CONCEPT_GRAPH_HELPER_TOKEN;
delete process.env.CONCEPT_GRAPH_HELPER_TOKEN;
if (Boolean(helperSite) !== Boolean(helperToken)) throw new Error('Helper site and token must both be configured.');
let helperVersion = null;
if (helperSite) {
  try { helperVersion = JSON.parse(await readFile(path.join(root, 'helper-version.json'), 'utf8')).version || null; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await mkdir(assetsDir, { recursive: true });
const workspace = await loadWorkspace(dataDir);
const templatesFile = path.join(dataDir, 'templates.json');
let templates = [];
try {
  const saved = JSON.parse(await readFile(templatesFile, 'utf8'));
  if (![1, 2].includes(saved?.version) || !Array.isArray(saved.templates) || saved.templates.length > 500
      || (saved.version === 1 && saved.templates.some(template => template?.labelOutputs === true))) throw new Error('Invalid template library.');
  const ids = new Set();
  templates = saved.templates.map(value => {
    if (!/^[\da-f-]{36}$/.test(value?.id || '') || ids.has(value.id) || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Invalid template library.');
    ids.add(value.id);
    return { id: value.id, ...validateTemplate(value), createdAt: value.createdAt };
  });
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('Saved custom nodes could not be read; no data was overwritten. ' + error.message);
}
const preferencesFile = path.join(dataDir, 'desktop-preferences.json');
const validPreferences = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 2 && Object.keys(value).every(key => ['theme', 'boardId'].includes(key))
  && ['light', 'dark'].includes(value.theme)
  && (value.boardId === null || (typeof value.boardId === 'string' && /^[\da-f-]{36}$/.test(value.boardId)));
let desktopPreferences = { theme: 'light', boardId: null };
if (desktop) {
  try {
    const saved = JSON.parse(await readFile(preferencesFile, 'utf8'));
    if (!validPreferences(saved)) throw new Error('Invalid preferences.');
    desktopPreferences = saved;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Desktop preferences could not be read; no data was overwritten. ' + error.message);
  }
}
for (const board of workspace.boards) for (const run of board.graph.runs) {
  if (['queued', 'running'].includes(run.status)) {
    run.status = 'error'; run.error = 'The app stopped during this run. Existing results are preserved; run again to retry.';
    run.finishedAt = new Date().toISOString();
    groupRunOutputs(board.graph, run);
  }
}
let writes = Promise.resolve(), workspaceFailure = null;
function persist() {
  const snapshot = structuredClone(workspace);
  const operation = writes.catch(() => {}).then(async () => {
    if (workspaceFailure) throw new Error('Board storage failed earlier. Restart after fixing the storage problem.');
    try { await writeWorkspace(dataDir, snapshot); }
    catch (error) { workspaceFailure = error; throw error; }
  });
  writes = operation;
  return operation;
}
async function settledWrites() {
  while (true) {
    const pending = writes;
    await pending;
    if (pending === writes) break;
  }
  if (workspaceFailure) throw new Error('Board storage failed earlier. Restart after fixing the storage problem.');
}
async function persistPreferences(value) {
  const snapshot = structuredClone(value);
  const operation = writes.catch(() => {}).then(async () => {
    await writeFile(preferencesFile + '.tmp', JSON.stringify(snapshot));
    await rename(preferencesFile + '.tmp', preferencesFile);
    desktopPreferences = snapshot;
  });
  writes = operation;
  await operation;
}
function updateTemplates(change) {
  const operation = writes.catch(() => {}).then(async () => {
    const { next, result } = await change(templates);
    const temporary = templatesFile + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify({ version: next.some(template => template.labelOutputs === true) ? 2 : 1, templates: next }, null, 2), { flag: 'wx' });
      await rename(temporary, templatesFile);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
    templates = next;
    publish('templates', {});
    return result;
  });
  // Failed template changes never update memory or the library, and must not poison later reads.
  writes = operation.then(() => {}, () => {});
  return operation;
}
async function validTemplateInput(value) {
  const template = validateTemplate(value);
  for (const asset of template.assets) if (!(await stat(path.join(assetsDir, asset))).isFile()) throw new Error('A template reference image is unavailable.');
  return template;
}
await persist();
const boardList = () => ({ defaultBoardId: workspace.defaultBoardId, boards: workspace.boards.map(({ id, name, createdAt }) => ({ id, name, createdAt })) });
function getBoard(id) {
  const board = workspace.boards.find(board => board.id === id);
  if (!board) throw Object.assign(new Error('Board not found.'), { status: 404 });
  return board;
}
const coordinator = new McpCoordinator({ board: getBoard });
function authorizeMcp(request) {
  const supplied = request.headers['x-concept-graph-mcp-token'];
  if (!mcpToken || typeof supplied !== 'string') return false;
  const expected = Buffer.from(mcpToken), actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
const codex = new Codex(dataDir);
const codexInstaller = helperSite ? new CodexInstaller({ onInstalled: () => { codex.connection = null; } }) : null;
let status = { connected: false, signedIn: false, imageGeneration: false };
let activeRun = null;
let processing = false;
let stopping = false;
let queueIdle = Promise.resolve();
const cloudJobsDir = path.join(dataDir, 'cloud-jobs');
const cloudJobs = new Map();
const cloudId = /^[\da-f-]{36}$/;
const maxCloudImageBytes = 30 * 1024 * 1024;
const cloudJobAge = 7 * 24 * 60 * 60 * 1000;
const cloudStopped = 'The helper stopped before this job completed. Start a new run to retry.';
let cloudWrites = Promise.resolve(), cloudChanges = Promise.resolve();
function changeCloudJobs(change) {
  const operation = cloudChanges.catch(() => {}).then(change);
  cloudChanges = operation.then(() => {}, () => {});
  return operation;
}
function saveCloudJob(job) {
  const snapshot = JSON.stringify(job);
  const filename = path.join(cloudJobsDir, job.id, 'job.json');
  const operation = cloudWrites.catch(() => {}).then(async () => {
    await writeFile(filename + '.tmp', snapshot);
    await rename(filename + '.tmp', filename);
  });
  cloudWrites = operation;
  return operation;
}
function cloudJobSummary(job) {
  const { id, boardId, nodeId, status, startedAt, finishedAt, progress, error, outputs } = job;
  return { id, boardId, nodeId, status, startedAt, ...(finishedAt ? { finishedAt } : {}), progress,
    ...(error ? { error } : {}), elapsedMs: Math.max(0, Date.parse(finishedAt || new Date().toISOString()) - Date.parse(startedAt)),
    outputs: outputs.map(output => ({ ...output })) };
}
async function pruneCloudJobs() {
  for (const job of cloudJobs.values()) {
    if ((activeRun?.cloud && activeRun.id === job.id) || ['queued', 'running'].includes(job.status)
        || Date.now() - Date.parse(job.finishedAt || job.createdAt) <= cloudJobAge) continue;
    await rm(path.join(cloudJobsDir, job.id), { recursive: true, force: true });
    cloudJobs.delete(job.id);
  }
}
async function loadCloudJobs() {
  await mkdir(cloudJobsDir, { recursive: true });
  for (const entry of await readdir(cloudJobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(cloudJobsDir, entry.name);
    if (/^\.[\da-f-]{36}\.tmp$/.test(entry.name)) {
      if (Date.now() - (await stat(directory)).mtimeMs > cloudJobAge) await rm(directory, { recursive: true, force: true });
      continue;
    }
    if (!cloudId.test(entry.name)) continue;
    const job = JSON.parse(await readFile(path.join(directory, 'job.json'), 'utf8'));
    if (job.id !== entry.name || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(job.status)
        || !Array.isArray(job.outputs) || !Number.isFinite(Date.parse(job.startedAt))) throw new Error('Invalid saved cloud job: ' + entry.name);
    if (['queued', 'running'].includes(job.status)) {
      job.status = 'failed'; job.finishedAt = new Date().toISOString();
      job.error = job.progress = cloudStopped;
      await saveCloudJob(job);
    }
    cloudJobs.set(job.id, job);
  }
  await pruneCloudJobs();
}
async function createCloudJob(value) {
  if (typeof value?.jobId !== 'string' || !cloudId.test(value.jobId)) throw new Error('A cloud job UUID is required.');
  if (cloudJobs.has(value.jobId)) return cloudJobs.get(value.jobId);
  if (typeof value.boardId !== 'string' || !cloudId.test(value.boardId)
      || typeof value.nodeId !== 'string' || !value.nodeId || value.nodeId.length > 120
      || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 150000
      || (value.model !== undefined && (typeof value.model !== 'string' || !/^[\w.\/:+-]{1,128}$/.test(value.model)))
      || (value.effort !== undefined && (typeof value.effort !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(value.effort)))
      || (value.labelOutputs !== undefined && typeof value.labelOutputs !== 'boolean')
      || !Array.isArray(value.images) || value.images.length > 10) throw new Error('Invalid cloud job.');
  const images = value.images.map(image => {
    if (typeof image?.asset !== 'string' || !/^[\da-f-]{36}\.(png|jpg|gif|webp)$/.test(image.asset)
        || typeof image.data !== 'string' || image.data.length > 4 * Math.ceil(maxCloudImageBytes / 3)
        || image.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('Invalid cloud input image.');
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length > maxCloudImageBytes) throw new Error('Images must be smaller than 30 MB.');
    return { bytes, format: imageFormat(bytes) };
  });
  const now = new Date().toISOString();
  const job = { id: value.jobId, boardId: value.boardId, nodeId: value.nodeId, prompt: value.prompt,
    ...generationSettings,
    labelOutputs: value.labelOutputs === true, images: images.map((image, index) => `input-${index}.${image.format}`),
    status: 'queued', createdAt: now, startedAt: now, progress: 'Queued.', outputs: [] };
  const temporary = path.join(cloudJobsDir, '.' + randomUUID() + '.tmp');
  try {
    await mkdir(temporary);
    for (const [index, image] of images.entries()) await writeFile(path.join(temporary, job.images[index]), image.bytes);
    await writeFile(path.join(temporary, 'job.json'), JSON.stringify(job));
    await rename(temporary, path.join(cloudJobsDir, job.id));
  } finally { await rm(temporary, { recursive: true, force: true }); }
  cloudJobs.set(job.id, job);
  return job;
}
async function processCloudJob(job) {
  const controller = new AbortController();
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  activeRun = { id: job.id, cloud: true, controller, done };
  const directory = path.join(cloudJobsDir, job.id);
  try {
    job.status = 'running'; job.startedAt = new Date().toISOString(); job.progress = 'Preparing your image…';
    await saveCloudJob(job);
    await codex.generate({
      prompt: job.prompt, images: job.images.map(image => path.join(directory, image)), ...generationSettings,
      signal: controller.signal,
      onProgress: message => { job.progress = message; },
      onImage: async item => {
        const bytes = item.savedPath ? await readFile(item.savedPath) : Buffer.from(item.result.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
        if (bytes.length > maxCloudImageBytes) throw new Error('Images must be smaller than 30 MB.');
        const format = imageFormat(bytes), index = job.outputs.length;
        await writeFile(path.join(directory, `output-${index}.${format}`), bytes);
        const caption = generatedImageCaption(item.revisedPrompt);
        if (index === 1 && !job.outputs[0].caption) job.outputs[0].caption = 'Image 1';
        job.outputs.push({ index, format, ...(caption ? { caption } : index ? { caption: `Image ${index + 1}` } : {}) });
        await saveCloudJob(job);
      },
    });
    if (controller.signal.aborted) throw new Error('Cancelled.');
    job.status = 'completed';
    job.progress = `${job.outputs.length} image${job.outputs.length === 1 ? '' : 's'} created`;
  } catch (error) {
    job.status = !stopping && controller.signal.aborted ? 'cancelled' : 'failed';
    job.error = job.progress = stopping ? cloudStopped : error.message;
  } finally {
    try {
      job.finishedAt = new Date().toISOString();
      await saveCloudJob(job);
      for (const image of job.images) await rm(path.join(directory, image), { force: true });
    } finally { activeRun = null; finished(); }
  }
}
async function cancelCloudJob(job) {
  if (activeRun?.cloud && activeRun.id === job.id) {
    const active = activeRun;
    active.controller.abort();
    await active.done;
  } else if (job.status === 'queued') {
    job.status = 'cancelled'; job.progress = 'Cancelled.'; job.finishedAt = new Date().toISOString();
    await saveCloudJob(job);
    for (const image of job.images) await rm(path.join(cloudJobsDir, job.id, image), { force: true });
  }
}
const subscribers = new Map();
function publish(type, value, boardId) {
  const message = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const [response, subscribedBoard] of subscribers) if (!boardId || subscribedBoard === boardId) response.write(message);
}
function publicRun(run) {
  const { snapshot, prompt, images, target, ...summary } = run;
  return summary;
}
// Bound diagnostics and select fields instead of storing raw protocol payloads.
function runDiagnostics(run, boardId) {
  const diagnostics = run.diagnostics = {
    model: null, effort: null, requestedModel: generationSettings.model,
    requestedEffort: generationSettings.effort, events: [],
  };
  let timer, textSize = 0;
  const messages = new Map();
  const messageTypes = new Set(['agent_message', 'reasoning_summary']);
  const safeId = value => typeof value === 'string' && /^[\w.\/:+-]{1,128}$/.test(value) ? value : null;
  const safeText = value => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '') : '';
  const publishSoon = () => {
    if (!timer) timer = setTimeout(() => { timer = null; publish('run', publicRun(run), boardId); }, 300);
  };
  const add = (type, value) => {
    const isMessage = messageTypes.has(type);
    const sameKind = diagnostics.events.filter(item => messageTypes.has(item.type) === isMessage);
    // Reserve lifecycle space so a lengthy chat cannot hide a subsequent tool failure.
    if (isMessage && (sameKind.length >= 64 || textSize >= 8000)) { diagnostics.truncated = true; publishSoon(); return null; }
    if (!isMessage && sameKind.length >= 16) {
      diagnostics.events.splice(diagnostics.events.indexOf(sameKind[0]), 1);
      diagnostics.truncated = true;
    }
    const text = safeText(value).slice(0, isMessage ? Math.min(4000, 8000 - textSize) : 250);
    if (typeof value === 'string' && text.length < value.length) diagnostics.truncated = true;
    const item = { at: new Date().toISOString(), type, ...(text ? { text } : {}) };
    diagnostics.events.push(item);
    if (isMessage) textSize += text.length;
    publishSoon();
    return item;
  };
  const receive = event => {
    if (event.type === 'thread') {
      diagnostics.model = safeId(event.model);
      diagnostics.effort = safeId(event.effort);
      publishSoon();
    } else if (event.type === 'usage') {
      const usage = {};
      for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']) {
        const value = event.usage?.[key];
        if (Number.isSafeInteger(value) && value >= 0) usage[key] = value;
      }
      if (Object.keys(usage).length) { diagnostics.usage = usage; publishSoon(); }
    } else if (event.type === 'agent_delta' || event.type === 'summary_delta') {
      const type = event.type === 'agent_delta' ? 'agent_message' : 'reasoning_summary';
      const value = safeText(event.text);
      if (!value) return;
      const key = `${type}:${event.itemId ?? ''}`;
      const previous = messages.get(key);
      if (previous) {
        const available = Math.max(0, Math.min(4000 - (previous.text?.length || 0), 8000 - textSize));
        previous.text = (previous.text || '') + value.slice(0, available);
        textSize += Math.min(value.length, available);
        if (value.length > available) diagnostics.truncated = true;
        publishSoon();
      } else {
        const item = add(type, value);
        if (item) messages.set(key, item);
      }
    } else if (event.type === 'agent_completed') {
      const key = `agent_message:${event.itemId ?? ''}`;
      if (!messages.has(key) && event.text) {
        const item = add('agent_message', event.text);
        if (item) messages.set(key, item);
      }
    } else if (event.type === 'model_rerouted') {
      add('model_rerouted', `${safeId(event.from) || 'Unknown'} → ${safeId(event.to) || 'Unknown'}`);
    } else if (['worker_context', 'image_started', 'image_completed', 'image_failed', 'turn_started', 'turn_completed', 'error'].includes(event.type)) {
      const item = add(event.type, event.text);
      if (item && event.type.startsWith('image_')) {
        if (typeof event.status === 'string' && /^[a-zA-Z_-]{1,32}$/.test(event.status)) item.status = event.status;
        for (const key of ['hasInlineResult', 'hasSavedPath', 'hasFileId']) if (typeof event[key] === 'boolean') item[key] = event[key];
      }
    }
  };
  return { receive, close: () => { clearTimeout(timer); timer = null; } };
}
async function refreshStatus() {
  try { await codex.connect(); status = await codex.status(); }
  catch (error) { status = { connected: false, signedIn: false, imageGeneration: false, error: error.message, codexMissing: error.codexMissing === true }; }
  if (helperSite) Object.assign(status, { helperVersion, codexMissing: status.codexMissing === true, codexInstall: codexInstaller.status() });
  publish('status', status);
  return status;
}
codex.on('disconnected', () => { status.connected = false; publish('status', status); });
codex.on('limits-changed', () => publish('limits-changed', {}));
codex.on('account-updated', () => publish('limits-changed', {}));
if (desktop) {
  codex.on('account-updated', () => { refreshStatus(); });
  codex.on('login-completed', result => { publish('login', result); refreshStatus(); });
}
if (helperSite) await loadCloudJobs();
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
    while (!stopping && !coordinator.barriers.size) {
      const board = workspace.boards.find(b => b.graph.runs.some(r => r.status === 'queued'));
      const cloudJob = [...cloudJobs.values()].find(job => job.status === 'queued');
      if (cloudJob && (!board || cloudJob.createdAt < board.graph.runs.find(run => run.status === 'queued').createdAt)) {
        await processCloudJob(cloudJob); continue;
      }
      if (!board) break;
      const graph = board.graph;
      const run = graph.runs.find(r => r.status === 'queued');
      const controller = new AbortController();
      let missingCaptions = 0;
      activeRun = { id: run.id, controller };
      const diagnostics = runDiagnostics(run, board.id);
      run.status = 'running'; run.startedAt = new Date().toISOString(); run.message = 'Preparing your image…';
      await persist(); publish('run', publicRun(run), board.id);
      try {
        const result = await codex.generate({
          prompt: run.prompt, images: run.images.map(asset => path.join(assetsDir, asset)), signal: controller.signal,
          ...generationSettings,
          onDiagnostic: diagnostics.receive,
          onProgress: message => { run.message = message; publish('run', publicRun(run), board.id); },
          onImage: async item => {
            const buffer = item.savedPath ? await readFile(item.savedPath) : Buffer.from(item.result.replace(/^data:image\/[^;]+;base64,/, ''), 'base64');
            const asset = await saveImage(buffer);
            const node = imageNode(run, asset, run.outputIds.length, imageSize(buffer));
            const caption = generatedImageCaption(item.revisedPrompt);
            if (caption) node.data.caption = caption;
            else if (run.outputIds.length) { node.data.caption = `Image ${run.outputIds.length + 1}`; missingCaptions++; }
            // The first output needs a fallback only once this run produces a second image.
            if (run.outputIds.length === 1) {
              const first = graph.nodes.find(item => item.id === run.outputIds[0]);
              if (first && !Object.hasOwn(first.data, 'caption')) { first.data.caption = 'Image 1'; missingCaptions++; }
            }
            positionRunOutput(node, graph, run);
            graph.nodes.push(node);
            if (samePage(graph, graph.nodes.find(n => n.id === run.nodeId), node)) graph.edges.push({ id: randomUUID(), source: run.nodeId, target: node.id });
            graph.revision++;
            run.outputIds.push(node.id);
            groupRunOutputs(graph, run, node.id);
            await persist(); publish('graph', graph, board.id); publish('run', publicRun(run), board.id);
          },
        });
        run.status = 'completed'; run.message = `${result.count} image${result.count === 1 ? '' : 's'} created`;
      } catch (error) {
        run.status = controller.signal.aborted ? 'cancelled' : 'error';
        run.error = error.message; run.message = error.message;
      }
      diagnostics.close();
      if (missingCaptions) run.captionMissing = missingCaptions;
      const grouped = groupRunOutputs(graph, run);
      run.finishedAt = new Date().toISOString();
      activeRun = null;
      await persist();
      if (grouped) publish('graph', graph, board.id);
      publish('run', publicRun(run), board.id);
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

const conflict = graph => Object.assign(new Error('Canvas changed.'), { status: 409, graph: structuredClone(graph) });
async function applyGraph(board, next, ensureConnected = () => {}) {
  const graph = board.graph;
  if (next.revision !== graph.revision) throw conflict(graph);
  const nodeIds = new Set((next.nodes || []).map(node => node.id));
  // Editors that do not send pages keep the board's page list.
  next.pages ??= graph.pages;
  next.groups ??= (graph.groups || []).map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => nodeIds.has(id)) })).filter(group => group.nodeIds.length);
  validateGraph(next);
  const nodeAssets = node => node.type === 'image' ? [node.data.asset] : node.data.template?.assets || [];
  const availableAssets = new Set(graph.nodes.flatMap(nodeAssets));
  for (const asset of next.nodes.flatMap(nodeAssets)) {
    if (!availableAssets.has(asset) && !(await stat(path.join(assetsDir, asset))).isFile()) throw new Error('A reference image is unavailable.');
  }
  ensureConnected();
  if (next.revision !== graph.revision) throw conflict(graph);
  return commitGraph(graph, next, persist);
}

async function startRun(board, { nodeId, revision }, ensureConnected = () => {}) {
  const graph = board.graph;
  if (revision !== graph.revision) throw conflict(graph);
  if (graph.runs.some(r => r.nodeId === nodeId && ['queued', 'running'].includes(r.status))) throw Object.assign(new Error('This prompt is already running.'), { status: 409 });
  const inputs = collectInputs(graph, nodeId);
  for (const asset of inputs.images) await stat(path.join(assetsDir, asset));
  ensureConnected();
  if (revision !== graph.revision) throw conflict(graph);
  if (graph.runs.some(r => r.nodeId === nodeId && ['queued', 'running'].includes(r.status))) throw Object.assign(new Error('This prompt is already running.'), { status: 409 });
  const label = inputs.target.data.text.trim() ? inputs.target.data.text : inputs.target.data.template?.name || '';
  const run = { id: randomUUID(), nodeId, ...inputs, ...pageField(nodePage(inputs.target, boardPages(graph))), status: 'queued', createdAt: new Date().toISOString(), outputIds: [], label: label.slice(0, 90) };
  graph.runs.push(run);
  try { await persist(); } catch (error) { graph.runs.splice(graph.runs.indexOf(run), 1); throw error; }
  publish('run', publicRun(run), board.id);
  return publicRun(run);
}
function startQueue() { if (!processing) queueIdle = processQueue(); }

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  try {
    const listeningPort = server.address()?.port || port;
    const allowedHosts = [`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`];
    if (!allowedHosts.includes(request.headers.host)) return json(response, { error: 'Invalid host.' }, 403);
    const url = new URL(request.url, `http://127.0.0.1:${listeningPort}`);
    if (helperSite) {
      if (helperSites.includes(request.headers.origin)) {
        response.setHeader('Access-Control-Allow-Origin', request.headers.origin);
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Concept-Graph-Token');
        response.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        response.setHeader('Vary', 'Origin');
      }
      if (!authorizeHelper(request, url, helperSite, helperToken)) return json(response, { error: 'Unauthorized.' }, 403);
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    } else {
      if (request.headers.origin && !allowedHosts.some(host => request.headers.origin === 'http://' + host)) return json(response, { error: 'Invalid origin.' }, 403);
      // External links may open the app shell; board data and mutations stay same-origin.
      const pageNavigation = request.method === 'GET' && url.pathname === '/'
        && request.headers['sec-fetch-mode'] === 'navigate' && request.headers['sec-fetch-dest'] === 'document';
      if (request.headers['sec-fetch-site'] === 'cross-site' && !pageNavigation) return json(response, { error: 'Cross-site access is disabled.' }, 403);
    }
    if (url.pathname === '/api/cloud-jobs' || url.pathname.startsWith('/api/cloud-jobs/')) {
      if (!helperSite) return json(response, { error: 'Not found.' }, 404);
      if (url.pathname === '/api/cloud-jobs') {
        if (request.method === 'GET') {
          await changeCloudJobs(pruneCloudJobs);
          return json(response, { jobs: [...cloudJobs.values()].map(cloudJobSummary) });
        }
        if (request.method === 'POST') {
          // Ten 30 MB images expand to 400 MB in base64, plus JSON and prompt text.
          const value = JSON.parse((await readBody(request, 10 * 4 * Math.ceil(maxCloudImageBytes / 3) + 4 * 1024 * 1024)).toString());
          const job = await changeCloudJobs(() => createCloudJob(value));
          json(response, { job: cloudJobSummary(job) }, 202); startQueue(); return;
        }
      }
      const route = url.pathname.match(/^\/api\/cloud-jobs\/([\da-f-]{36})(?:\/(cancel|outputs\/(0|[1-9]\d*)))?$/);
      const job = route && cloudJobs.get(route[1]);
      if (!job) return json(response, { error: 'Cloud job not found.' }, 404);
      if (request.method === 'GET' && !route[2]) return json(response, cloudJobSummary(job));
      if (request.method === 'GET' && route[3] !== undefined) {
        const output = job.outputs[Number(route[3])];
        if (!output) return json(response, { error: 'Cloud output not found.' }, 404);
        const bytes = await readFile(path.join(cloudJobsDir, job.id, `output-${output.index}.${output.format}`));
        response.writeHead(200, { 'Content-Type': mime['.' + output.format], 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
        response.end(bytes); return;
      }
      if ((request.method === 'POST' && route[2] === 'cancel') || (request.method === 'DELETE' && !route[2])) {
        await changeCloudJobs(async () => {
          if (cloudJobs.get(job.id) !== job) throw Object.assign(new Error('Cloud job not found.'), { status: 404 });
          await cancelCloudJob(job);
          if (request.method === 'DELETE') {
            await rm(path.join(cloudJobsDir, job.id), { recursive: true, force: true });
            cloudJobs.delete(job.id);
          }
        });
        return json(response, { ok: true });
      }
      return json(response, { error: 'Not found.' }, 404);
    }
    if (request.headers['x-concept-graph-mcp-token'] !== undefined && !authorizeMcp(request)) return json(response, { error: 'Unauthorized MCP session.' }, 403);
    if (url.pathname.startsWith('/api/mcp/')) {
      if (!authorizeMcp(request)) return json(response, { error: 'Unauthorized MCP session.' }, 403);
      if (request.method === 'GET' && url.pathname === '/api/mcp/session') return json(response, { sessionId: mcpSessionId });
      if (request.method === 'GET' && url.pathname === '/api/mcp/canvas-screenshot') {
        const png = await coordinator.requestUI('screenshot');
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' });
        response.end(png); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/mcp/ui') {
        const value = JSON.parse((await readBody(request, 4096)).toString());
        return json(response, await coordinator.requestUI(value.action, value.boardId));
      }
      const route = url.pathname.match(/^\/api\/mcp\/boards\/([\da-f-]{36})\/(graph|runs)$/);
      if (request.method === 'POST' && route) {
        const input = JSON.parse((await readBody(request)).toString());
        if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('A board revision is required.');
        try {
          const result = await coordinator.execute(route[1], input.revision, async (board, ensureConnected) => {
            if (route[2] === 'graph') {
              const revision = await applyGraph(board, input, ensureConnected);
              return { revision, graph: structuredClone(board.graph) };
            }
            const run = await startRun(board, input, ensureConnected);
            return { run, revision: board.graph.revision };
          });
          return json(response, result, route[2] === 'runs' ? 202 : 200);
        } finally { startQueue(); }
      }
      return json(response, { error: 'MCP endpoint not found.' }, 404);
    }
    if (desktop && request.method === 'GET' && url.pathname === '/api/desktop/mcp-setup') {
      response.setHeader('Cache-Control', 'no-store');
      return json(response, { available: !!mcpToken, platform: process.platform, command: process.execPath, args: [path.join(root, 'mcp.mjs')] });
    }
    if (desktop && request.method === 'POST' && url.pathname === '/api/desktop/editors') {
      if (!mcpToken) return json(response, { error: 'MCP coordination is unavailable.' }, 503);
      const { boardId, previousEditorId } = JSON.parse((await readBody(request, 4096)).toString());
      if (previousEditorId !== undefined && (typeof previousEditorId !== 'string' || !/^[\da-f-]{36}$/.test(previousEditorId))) throw new Error('Invalid editor session.');
      return json(response, { editorId: coordinator.register(boardId, previousEditorId) }, 201);
    }
    if (desktop && request.method === 'POST' && url.pathname === '/api/desktop/ui-results') {
      const value = JSON.parse((await readBody(request, 12 * 1024 * 1024)).toString());
      coordinator.uiResult(value.editorId, value);
      return json(response, { ok: true });
    }
    const editorRoute = desktop && url.pathname.match(/^\/api\/desktop\/editors\/([\da-f-]{36})\/(ready|ack|close)$/);
    if (editorRoute && request.method === 'POST') {
      const value = JSON.parse((await readBody(request, 8192)).toString());
      if (editorRoute[2] === 'ready') coordinator.ready(editorRoute[1], value.revision);
      if (editorRoute[2] === 'ack') coordinator.ack(editorRoute[1], value);
      if (editorRoute[2] === 'close') coordinator.close(editorRoute[1]);
      return json(response, { ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/workspace') {
      if (desktop) await settledWrites();
      return json(response, { ...boardList(), status, ...(desktop ? { desktopPreferences, mcpEnabled: !!mcpToken } : {}) });
    }
    if (request.method === 'GET' && url.pathname === '/api/limits') {
      if (!status.connected || !status.signedIn) return json(response, { available: false, buckets: [] });
      try { return json(response, await codex.rateLimits()); }
      catch { return json(response, { available: false, buckets: [] }); }
    }
    if (request.method === 'GET' && url.pathname === '/api/models') {
      if (!status.connected || !status.signedIn) return json(response, { error: 'Connect and sign in to Codex to load models.' }, 503);
      return json(response, await codex.models());
    }
    if (request.method === 'GET' && url.pathname === '/api/templates') {
      await writes.catch(() => {});
      return json(response, { templates });
    }
    if (request.method === 'POST' && url.pathname === '/api/templates') {
      const value = JSON.parse((await readBody(request)).toString());
      const template = await updateTemplates(async current => {
        if (current.length >= 500) throw new Error('You can save at most 500 custom nodes.');
        const input = await validTemplateInput(value);
        const item = { id: randomUUID(), ...input, color: input.color || nextTemplateColor(current), createdAt: new Date().toISOString() };
        return { next: [...current, item], result: item };
      });
      return json(response, { template }, 201);
    }
    const templateRoute = url.pathname.match(/^\/api\/templates\/([\da-f-]{36})$/);
    if (templateRoute && ['PUT', 'DELETE'].includes(request.method)) {
      const value = JSON.parse((await readBody(request)).toString());
      const template = await updateTemplates(async current => {
        const index = current.findIndex(item => item.id === templateRoute[1]);
        if (index < 0) throw Object.assign(new Error('Custom node not found.'), { status: 404 });
        if (!isDeepStrictEqual(value.expected, current[index])) throw Object.assign(new Error('Custom node changed. Reopen it to edit the latest version.'), { status: 409 });
        if (request.method === 'DELETE') return { next: current.filter((_, i) => i !== index), result: null };
        const item = { id: current[index].id, ...await validTemplateInput(value), createdAt: current[index].createdAt };
        return { next: current.map((old, i) => i === index ? item : old), result: item };
      });
      return json(response, request.method === 'DELETE' ? { ok: true } : { template });
    }
    if (desktop && request.method === 'PUT' && url.pathname === '/api/desktop/preferences') {
      const preferences = JSON.parse((await readBody(request, 4096)).toString());
      if (!validPreferences(preferences) || (preferences.boardId && !workspace.boards.some(board => board.id === preferences.boardId))) return json(response, { error: 'Invalid desktop preferences.' }, 400);
      await persistPreferences(preferences);
      return json(response, { ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/desktop/status' && desktop) {
      return json(response, { activeRuns: workspace.boards.some(board => board.graph.runs.some(run => ['queued', 'running'].includes(run.status))) });
    }
    if (helperSite && url.pathname === '/api/codex/install' && ['GET', 'POST'].includes(request.method)) {
      return json(response, request.method === 'POST' ? codexInstaller.start() : codexInstaller.status());
    }
    if ((desktop || helperSite) && request.method === 'POST' && url.pathname === '/api/desktop/login') {
      return json(response, await codex.startChatGPTLogin());
    }
    if ((desktop || helperSite) && request.method === 'POST' && url.pathname === '/api/desktop/login/cancel') {
      const { loginId } = JSON.parse((await readBody(request, 4096)).toString());
      await codex.cancelChatGPTLogin(loginId);
      return json(response, { ok: true });
    }
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
      if (coordinator.barriers.has(board.id)) return json(response, { error: 'The board is being updated by an agent.' }, 423);
      await settledWrites();
      if (coordinator.barriers.has(board.id)) return json(response, { error: 'The board is being updated by an agent.' }, 423);
      const stream = await exportBoardArchive(board, assetsDir);
      const filename = encodeURIComponent(board.name + '.conceptgraph').replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16));
      response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="board.conceptgraph"; filename*=UTF-8''${filename}`, 'Cache-Control': 'no-store' });
      await pipeline(stream, response);
      return;
    }
    if (request.method === 'GET' && board && !action) {
      if (coordinator.barriers.has(board.id)) return json(response, { error: 'The board is being updated by an agent.' }, 423);
      await settledWrites();
      if (coordinator.barriers.has(board.id)) return json(response, { error: 'The board is being updated by an agent.' }, 423);
      return json(response, { board, status });
    }
    if (request.method === 'PATCH' && board && !action) {
      const { name, expectedName } = JSON.parse((await readBody(request)).toString());
      await settledWrites();
      if (typeof expectedName !== 'string' || board.name !== expectedName) return json(response, { error: 'Board name changed. Reopen rename to edit the latest name.' }, 409);
      const oldName = board.name, nextName = boardName(name);
      board.name = nextName;
      try { await persist(); } catch (error) { if (board.name === nextName) board.name = oldName; throw error; }
      publish('boards', boardList());
      return json(response, { id: board.id, name: board.name });
    }
    if (request.method === 'POST' && url.pathname === '/api/status') return json(response, await refreshStatus());
    if (request.method === 'GET' && board && action === 'events') {
      const editor = mcpToken ? coordinator.attach(url.searchParams.get('editor'), board.id, response) : null;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      subscribers.set(response, board.id);
      response.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
      response.write(`event: graph\ndata: ${JSON.stringify(graph)}\n\n`);
      const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15000);
      request.on('close', () => { clearInterval(heartbeat); subscribers.delete(response); if (editor) coordinator.detach(editor, response); });
      return;
    }
    if (request.method === 'PUT' && board && action === 'graph') {
      const done = coordinator.beginWriter(board.id, request.headers['x-concept-graph-ui-session'], request.headers['x-concept-graph-barrier'], request.headers['x-concept-graph-ui-request']);
      try {
        const next = JSON.parse((await readBody(request)).toString());
        return json(response, { revision: await applyGraph(board, next) });
      } finally { done(); }
    }
    if (request.method === 'POST' && url.pathname === '/api/assets') {
      const asset = await saveImage(await readBody(request, 30 * 1024 * 1024));
      return json(response, { asset });
    }
    if (request.method === 'POST' && board && action === 'runs' && !boardRoute[3]) {
      const done = coordinator.beginWriter(board.id, request.headers['x-concept-graph-ui-session']);
      try {
        const input = JSON.parse((await readBody(request)).toString());
        const run = await startRun(board, input);
        json(response, run, 202); startQueue(); return;
      } finally { done(); }
    }
    const cancel = board && action === 'runs' && boardRoute[4] === 'cancel';
    if (request.method === 'POST' && cancel) {
      if (coordinator.barriers.has(board.id)) return json(response, { error: 'The board is being updated by an agent.' }, 423);
      const run = graph.runs.find(r => r.id === boardRoute[3]);
      if (!run) return json(response, { error: 'Run not found.' }, 404);
      if (!activeRun?.cloud && activeRun?.id === run.id) activeRun.controller.abort();
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
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': helperSite ? 'no-store' : url.pathname.startsWith('/assets/') ? 'private, max-age=31536000, immutable' : 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch (error) {
    if (!response.headersSent) json(response, { error: error.code === 'ENOENT' ? 'File not found.' : error.message, ...(error.graph ? { graph: error.graph } : {}) }, error.status || (error.code === 'ENOENT' ? 404 : 400));
    else response.end();
  }
});
server.listen(port, '127.0.0.1', async () => {
  if (mcpToken) {
    const temporary = mcpSessionFile + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(path.dirname(mcpSessionFile), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ version: 1, port: server.address().port, token: mcpToken, sessionId: mcpSessionId }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, mcpSessionFile);
    } catch {
      mcpToken = '';
      console.error('MCP connection is unavailable because its local session file could not be created.');
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  console.log(`Concept Graph is ready at http://127.0.0.1:${server.address().port}`);
});
async function stop() {
  if (stopping) return;
  stopping = true;
  activeRun?.controller.abort();
  server.close();
  for (const s of subscribers.keys()) s.end();
  try { await cloudChanges; await queueIdle; await cloudWrites; await writes; if (workspaceFailure) throw workspaceFailure; }
  catch (error) { console.error('Could not finish saving:', error.message); process.exitCode = 1; }
  finally {
    codex.close();
    if (mcpToken) {
      try {
        const value = JSON.parse(await readFile(mcpSessionFile, 'utf8'));
        if (value.sessionId === mcpSessionId) await rm(mcpSessionFile, { force: true });
      } catch {}
    }
    process.exit();
  }
}
if (desktop) { process.stdin.resume(); process.stdin.once('end', stop); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
