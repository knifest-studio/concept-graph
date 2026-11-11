#!/usr/bin/env node
// Local stdio MCP client for the running Concept Graph desktop service.
import { createInterface } from 'node:readline';
import { lstat, open, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { alignNodes, moveGroup, pruneGroups } from './src/canvas.mjs';
import { switchNodeTemplate } from './src/node-template.mjs';
import { duplicateNodes, templatePalette, templateSnapshot, reconcileStampGraph, imageName, uniqueImageName } from './graph.mjs';
import { boardPages, nodePage, pageContent, pageField, targetPage } from './src/pages.mjs';
import { maxLayer, nextLayer } from './src/layers.mjs';

const assetPattern = /^[\da-f-]{36}\.(png|jpg|webp|gif)$/;
const uuidPattern = /^[\da-f-]{36}$/;
const maxImage = 30 * 1024 * 1024, maxArchive = 512 * 1024 * 1024;
const fail = message => { throw new Error(message); };
const text = (description, extra = {}) => ({ type: 'string', description, ...extra });
const number = (description, extra = {}) => ({ type: 'number', description, ...extra });
const boolean = description => ({ type: 'boolean', description });
const array = (description, items, extra = {}) => ({ type: 'array', description, items, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const boardId = text('Board ID', { pattern: uuidPattern.source });
const itemId = text('Node, edge, or group ID', { minLength: 1, maxLength: 120 });
const assetId = text('Image asset ID', { pattern: assetPattern.source });
const position = object({ x: number('Canvas x'), y: number('Canvas y') }, ['x', 'y']);
const viewport = object({ x: number('Pan x'), y: number('Pan y'), zoom: number('Zoom', { minimum: 0.15, maximum: 2 }) }, ['x', 'y', 'zoom']);
const templateFields = { color: text('Template tag colour', { enum: templatePalette }), name: text('Template name', { minLength: 1, maxLength: 80 }), instructions: text('Additional instructions', { maxLength: 100000 }), assets: array('Reference image asset IDs, in order', assetId, { maxItems: 10 }), labelOutputs: boolean('Legacy setting retained for compatibility; captions are automatic') };
const template = object(templateFields, ['name', 'instructions', 'assets']);
const ids = array('Item IDs', itemId, { minItems: 1, maxItems: 2000, uniqueItems: true });
const groupColor = text('Legacy group fill as #rrggbb, kept for older boards but no longer shown; empty clears it', { pattern: '^(#[0-9a-fA-F]{6})?$' });
const layer = number('Layer order on its page; higher draws in front. Omitted means 0; ties put annotations above prompts and images', { minimum: -maxLayer, maximum: maxLayer });
const graphNode = { ...object({ id: itemId, type: text('text, image, drawing, sticky, stamp, shape, or arrow'), position, z: layer, data: { type: 'object', properties: {}, additionalProperties: true } }, ['id', 'type', 'position', 'data']), additionalProperties: true };
const graphEdge = { ...object({ id: itemId, source: itemId, target: itemId }, ['id', 'source', 'target']), additionalProperties: true };
const pageId = text('Page ID from get_board. Required for new nodes and page-wide actions on boards with several pages; otherwise checked against the nodes', { minLength: 1, maxLength: 120 });
const graphPage = object({ id: text('Page ID', { minLength: 1, maxLength: 120 }), name: text('Page name', { minLength: 1, maxLength: 80 }) }, ['id', 'name']);
const graphGroup = { ...object({ id: itemId, name: text('Group name', { minLength: 1, maxLength: 80 }), color: text('Legacy group fill as #rrggbb, no longer shown', { pattern: '^#[0-9a-fA-F]{6}$' }), nodeIds: ids, collapsed: boolean('Whether the group is collapsed'),
  slideshow: boolean('Folded, the group shows one image at a time; generated runs start as slideshows'), slide: text('Image ID the folded slideshow shows; defaults to its first image', { minLength: 1, maxLength: 120 }) }, ['id', 'name', 'nodeIds', 'collapsed']), additionalProperties: true };
const graphSection = { ...object({ id: itemId, name: text('Section name', { minLength: 1, maxLength: 80 }), x: number('Left edge'), y: number('Top edge'), width: number('Width', { minimum: 200 }), height: number('Height', { minimum: 120 }),
  color: text('Background as #rrggbb; omit for the neutral default', { pattern: '^#[0-9a-fA-F]{6}$' }), page: pageId }, ['id', 'name', 'x', 'y', 'width', 'height']), additionalProperties: true };
const localPath = text('Absolute local file path. Existing files are never overwritten.', { minLength: 1, maxLength: 4096 });
const withBoard = properties => ({ boardId, ...properties });
const tools = [];
function define(name, description, properties, required, handler, readOnly = false) {
  const destructive = new Set(['rename_board', 'apply_graph', 'update_node', 'set_node_template', 'clear_node_template', 'delete_nodes', 'delete_edges', 'update_group', 'ungroup', 'align_board', 'set_viewport', 'cancel_run', 'update_template', 'delete_template', 'undo', 'redo']);
  tools.push({ name, description, inputSchema: object(properties, required), annotations: { readOnlyHint: readOnly, destructiveHint: destructive.has(name), openWorldHint: ['start_run', 'usage_limits', 'export_board', 'import_board', 'upload_image', 'save_image', 'get_image', 'get_canvas_screenshot'].includes(name) }, handler });
}

function check(value, schema, label = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
    for (const key of schema.required || []) if (!(key in value)) fail(`${label}.${key} is required.`);
    for (const [key, item] of Object.entries(value)) {
      if (!(key in schema.properties)) { if (!schema.additionalProperties) fail(`${label}.${key} is not supported.`); continue; }
      check(item, schema.properties[key], `${label}.${key}`);
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || (schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value))) fail(`${label} is invalid.`);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value)) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) fail(`${label} must be a valid number.`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || (schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems) || (schema.uniqueItems && new Set(value).size !== value.length)) fail(`${label} is invalid.`);
    value.forEach((item, index) => check(item, schema.items, `${label}[${index}]`));
  }
}

function sessionFile() {
  if (process.env.CONCEPT_GRAPH_MCP_SESSION_FILE) {
    if (!path.isAbsolute(process.env.CONCEPT_GRAPH_MCP_SESSION_FILE)) fail('The Concept Graph MCP session path must be absolute.');
    return path.normalize(process.env.CONCEPT_GRAPH_MCP_SESSION_FILE);
  }
  if (process.platform === 'darwin') return path.join(homedir(), 'Library/Application Support/Concept Graph Settings/mcp-session.json');
  if (process.platform === 'win32') {
    if (!process.env.LOCALAPPDATA) fail('LOCALAPPDATA is unavailable. Start Concept Graph and retry.');
    return path.join(process.env.LOCALAPPDATA, 'Concept Graph', 'mcp-session.json');
  }
  fail('This platform requires an explicit Concept Graph MCP session path.');
}

async function connect() {
  let descriptor;
  try {
    const file = sessionFile();
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error();
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino || current.size > 8192
        || (process.platform !== 'win32' && ((current.mode & 0o077) || (typeof process.getuid === 'function' && current.uid !== process.getuid())))) throw new Error();
      descriptor = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  } catch { fail('Concept Graph is not available. Open the desktop application and try again.'); }
  if (descriptor?.version !== 1 || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || typeof descriptor.token !== 'string' || descriptor.token.length < 32 || descriptor.token.length > 256 || typeof descriptor.sessionId !== 'string' || descriptor.sessionId.length < 16 || descriptor.sessionId.length > 128) fail('Concept Graph connection information is invalid. Reopen the app.');
  const context = { base: `http://127.0.0.1:${descriptor.port}`, token: descriptor.token };
  let identity;
  try { identity = await api(context, '/api/mcp/session'); }
  catch { fail('Could not verify the running Concept Graph. Reopen the app and try again.'); }
  if (identity?.sessionId !== descriptor.sessionId) fail('The Concept Graph session changed. Reopen the app and try again.');
  return context;
}

async function api(context, route, { method = 'GET', body, binary = false, timeout = 30000 } = {}) {
  const headers = { 'X-Concept-Graph-MCP-Token': context.token };
  if (body !== undefined && !Buffer.isBuffer(body)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
  const uncertain = 'The action may already have been applied. Check the board state or run history before retrying; do not automatically repeat it.';
  let response;
  try { response = await fetch(context.base + route, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeout) }); }
  catch { fail(mutating ? `Could not confirm the Concept Graph response. ${uncertain}` : 'Cannot reach the running Concept Graph. Open the app and try again.'); }
  if (!response.ok) {
    let message = `Concept Graph request failed (${response.status}).`;
    try { const value = await response.json(); if (typeof value.error === 'string' && value.error.length <= 1000) message = value.error; } catch {}
    if (mutating && response.status >= 500) message += ` ${uncertain}`;
    const error = new Error(message); error.status = response.status; throw error;
  }
  try { return binary ? Buffer.from(await response.arrayBuffer()) : await response.json(); }
  catch { fail(mutating ? `Could not read the Concept Graph response. ${uncertain}` : 'Could not read the Concept Graph response. Try again.'); }
}

function safePath(value) {
  if (!path.isAbsolute(value) || value.split(/[\\/]/).includes('..') || value.includes('\0')) fail('Use an absolute file path without parent traversal.');
  return path.normalize(value);
}
async function readLocal(value, max) {
  const filename = safePath(value), info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) fail('Choose a regular file within the permitted size.');
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const current = await file.stat();
    if (!current.isFile() || current.size > max || current.dev !== info.dev || current.ino !== info.ino) fail('Choose a regular file within the permitted size.');
    return await file.readFile();
  } finally { await file.close(); }
}
async function saveLocal(filename, bytes) { await writeFile(safePath(filename), bytes, { flag: 'wx', mode: 0o600 }); }
const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const boardRoute = id => `/api/boards/${id}`;
const getBoard = (c, id) => api(c, boardRoute(id));
const ensureItems = (items, wanted, label) => {
  const map = new Map(items.map(item => [item.id, item]));
  for (const id of wanted) if (!map.has(id)) fail(`${label} not found: ${id}`);
  return map;
};
async function changeGraph(c, id, operation) {
  const { board } = await getBoard(c, id);
  let graph = structuredClone(board.graph);
  const result = await operation(graph);
  graph = reconcileStampGraph(board.graph, graph);
  try {
    const saved = await api(c, `/api/mcp/boards/${id}/graph`, { method: 'POST', timeout: 60000,
      body: { revision: graph.revision, nodes: graph.nodes, edges: graph.edges, groups: graph.groups || [], pages: graph.pages, viewport: graph.viewport } });
    return { ...result, revision: saved.revision, uiSynchronized: saved.uiSynchronized, ...(saved.uiSynchronized === false ? { warning: 'The change was saved, but the open canvas did not acknowledge it. Reopen the board or app before editing it.' } : {}) };
  } catch (error) {
    if (error.status === 409) fail('The board changed while the operation was being prepared. Read the board again and decide whether to retry.');
    throw error;
  }
}
const origin = value => value || { x: 0, y: 0 };

define('status', 'Show Concept Graph connection and account status.', {}, [], async c => api(c, '/api/workspace'), true);
define('usage_limits', 'Read available Codex usage windows; these are not an image count.', {}, [], async c => api(c, '/api/limits'), true);
define('get_canvas_screenshot', 'Return a PNG screenshot of the current Concept Graph app viewport, including canvas, sidebar and header. Only the visible app content is captured; other apps and the screen are not. The window must be visible and ready.', {}, [], async c => { const bytes = await api(c, '/api/mcp/canvas-screenshot', { binary: true, timeout: 40000 }); if (bytes.length > 8 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('The app screenshot is invalid or too large.'); return { content: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }] }; }, true);
define('list_boards', 'List boards and the default board.', {}, [], async c => { const { boards, defaultBoardId } = await api(c, '/api/workspace'); return { boards, defaultBoardId }; }, true);
define('select_board', 'Select and display a board in the open Concept Graph window. Requires one ready desktop window; reports success only after the board is open.', { boardId }, ['boardId'], async (c, a) => api(c, '/api/mcp/ui', { method: 'POST', timeout: 40000, body: { action: 'select_board', boardId: a.boardId } }));
for (const action of ['undo', 'redo']) define(action, `${action === 'undo' ? 'Undo the last' : 'Redo the last undone'} edit in the open Concept Graph window. If changed is true and saved is false, do not repeat: the edit already changed the canvas.`, {}, [], async c => api(c, '/api/mcp/ui', { method: 'POST', timeout: 40000, body: { action } }));
define('create_board', 'Create an empty board.', { name: text('Board name', { minLength: 1, maxLength: 80 }) }, ['name'], async (c, a) => api(c, '/api/boards', { method: 'POST', body: a }));
define('rename_board', 'Rename an existing board. If another editor changes the name concurrently, the rename fails without overwriting it.', withBoard({ name: text('New board name', { minLength: 1, maxLength: 80 }) }), ['boardId', 'name'], async (c, a) => { const { board } = await getBoard(c, a.boardId); return api(c, boardRoute(a.boardId), { method: 'PATCH', body: { name: a.name, expectedName: board.name } }); });
define('get_board', 'Get the last saved revision of a board with pages, nodes (each with its page), connections, groups, sections (each with its page) and viewport. Connections and groups stay within one page. A section is a named background frame; it holds whatever lies inside it and stores no member list. The editor autosaves with a short delay; a mutation flushes pending edits and returns a conflict if the saved revision changed. Set includeHistory to include generation history.', withBoard({ includeHistory: boolean('Include full generation history') }), ['boardId'], async (c, a) => { const { board } = await getBoard(c, a.boardId); const pages = boardPages(board.graph); board.graph.pages = pages; board.graph.nodes = board.graph.nodes.map(node => ({ ...node, page: nodePage(node, pages) })); if (board.graph.sections) board.graph.sections = board.graph.sections.map(section => ({ ...section, page: nodePage(section, pages) })); if (!a.includeHistory) { board.historyCount = board.graph.runs.length; delete board.graph.runs; } return board; }, true);
define('apply_graph', 'Atomically replace the complete editable graph. First call get_board and supply its current revision as expectedRevision. All existing nodes, edges and groups omitted here are removed. Pass pages to rename, add or remove pages (their nodes must be removed too); omit pages to keep them. Pass sections to replace the complete section list; omit sections to keep them. A node without page is on the reserved first page page-1. Generation history is preserved. A conflict is never retried automatically.', withBoard({ expectedRevision: { type: 'integer', minimum: 0, description: 'Revision obtained from a fresh get_board call' }, pages: array('Complete ordered page list', graphPage, { minItems: 1, maxItems: 100 }), nodes: array('Complete node list', graphNode, { maxItems: 2000 }), edges: array('Complete connection list', graphEdge, { maxItems: 10000 }), groups: array('Complete group list', graphGroup, { maxItems: 2000 }), sections: array('Complete section list', graphSection, { maxItems: 2000 }), viewport }), ['boardId', 'expectedRevision', 'nodes', 'edges', 'groups', 'viewport'], async (c, a) => {
  // Missing page already means page-1, so an unchanged board keeps its stored form.
  const onPage = ({ page, ...item }) => ({ ...item, ...(page === undefined ? {} : pageField(page)) });
  const nodes = a.nodes.map(onPage), sections = a.sections?.map(onPage);
  const pages = a.pages?.map(page => ({ id: page.id, name: page.name.trim() }));
  try {
    const saved = await api(c, `/api/mcp/boards/${a.boardId}/graph`, { method: 'POST', timeout: 60000, body: { revision: a.expectedRevision, nodes, edges: a.edges, groups: a.groups, pages, sections, viewport: a.viewport } });
    return { applied: saved.applied, revision: saved.revision, uiSynchronized: saved.uiSynchronized, ...(saved.uiSynchronized === false ? { warning: 'The change was saved, but the open canvas did not acknowledge it. Reopen the board or app before editing it.' } : {}) };
  } catch (error) { if (error.status === 409) fail('The board changed. Read it again before preparing another complete graph replacement.'); throw error; }
});
define('export_board', 'Export a board with its images to a new local .conceptgraph file; never overwrites a file.', withBoard({ path: localPath }), ['boardId', 'path'], async (c, a) => { const bytes = await api(c, boardRoute(a.boardId) + '/export', { binary: true, timeout: 120000 }); await saveLocal(a.path, bytes); return { path: safePath(a.path), bytes: bytes.length }; });
define('import_board', 'Import a board from a local .conceptgraph file as a new board.', { path: localPath }, ['path'], async (c, a) => api(c, '/api/boards/import', { method: 'POST', body: await readLocal(a.path, maxArchive), timeout: 120000 }));
define('upload_image', 'Upload a local PNG, JPEG, WebP or GIF reference image and return its asset ID.', { path: localPath }, ['path'], async (c, a) => api(c, '/api/assets', { method: 'POST', body: await readLocal(a.path, maxImage), timeout: 60000 }));
define('get_image', 'Return original image bytes as image content for visual inspection.', { asset: assetId }, ['asset'], async (c, a) => { const bytes = await api(c, '/assets/' + a.asset, { binary: true, timeout: 60000 }); const ext = path.extname(a.asset).slice(1); return { content: [{ type: 'image', data: bytes.toString('base64'), mimeType: ext === 'jpg' ? 'image/jpeg' : 'image/' + ext }] }; }, true);
define('save_image', 'Save an original image to a new local file; never overwrites a file.', { asset: assetId, path: localPath }, ['asset', 'path'], async (c, a) => { const bytes = await api(c, '/assets/' + a.asset, { binary: true, timeout: 60000 }); await saveLocal(a.path, bytes); return { path: safePath(a.path), bytes: bytes.length }; });
define('add_text_node', 'Add a text prompt node to a board page. With describe, it is a describe node: connect images to it and start_run writes their detailed description into a new text node.', withBoard({ text: text('Prompt text; for a describe node, an optional focus for the description', { maxLength: 100000 }), describe: boolean('Make a describe (image-to-text) node'), labelOutputs: boolean('Legacy setting retained for compatibility; captions are automatic'), position, pageId }), ['boardId', 'text'], async (c, a) => { const id = randomUUID(); return changeGraph(c, a.boardId, g => { const page = targetPage(g, a.pageId); g.nodes.push({ id, type: 'text', position: origin(a.position), z: nextLayer(g.nodes), data: { text: a.text, createdAt: new Date().toISOString(), ...(a.describe ? { task: 'describe' } : {}), ...(a.labelOutputs === undefined ? {} : { labelOutputs: a.labelOutputs }) }, ...pageField(page) }); return { nodeId: id, pageId: page }; }); });
define('add_image_node', 'Add an uploaded image asset to a board page.', withBoard({ asset: assetId, label: text('Original file name. Used to derive a name when caption is omitted', { maxLength: 100000 }), caption: text('Visible image name used to refer to it in prompts', { maxLength: 120 }), position, pageId }), ['boardId', 'asset'], async (c, a) => { const id = randomUUID(); return changeGraph(c, a.boardId, g => { const page = targetPage(g, a.pageId); g.nodes.push({ id, type: 'image', position: origin(a.position), z: nextLayer(g.nodes), data: { asset: a.asset, createdAt: new Date().toISOString(), label: a.label || 'Reference image', caption: uniqueImageName(g.nodes, a.caption?.trim() || imageName({ data: { label: a.label } })) }, ...pageField(page) }); return { nodeId: id, pageId: page }; }); });
define('update_node', 'Update prompt text, image caption, label, position, layer order, collapsed state, or copied custom-node settings.', withBoard({ nodeId: itemId, z: layer, collapsed: boolean('Whether this node is collapsed'), text: text('Text prompt', { maxLength: 100000 }), labelOutputs: boolean('Legacy setting retained for compatibility; captions are automatic'), label: text('Original file name. Used to derive a name when caption is omitted', { maxLength: 100000 }), caption: text('Visible caption above the image; empty clears it', { maxLength: 120 }), position, template, pageId }), ['boardId', 'nodeId'], async (c, a) => changeGraph(c, a.boardId, g => { const node = ensureItems(g.nodes, [a.nodeId], 'Node').get(a.nodeId); targetPage(g, a.pageId, [a.nodeId]); if (a.position) node.position = a.position; if (a.z !== undefined) node.z = a.z; if (a.collapsed !== undefined) node.data.collapsed = a.collapsed; if (a.text !== undefined) { if (node.type !== 'text') fail('Only text nodes have prompt text.'); node.data.text = a.text; } if (a.labelOutputs !== undefined) { if (node.type !== 'text') fail('Only text nodes have image caption settings.'); node.data.labelOutputs = a.labelOutputs; } if (a.template) { if (node.type !== 'text') fail('Only text nodes can have custom-node settings.'); node.data.template = templateSnapshot(a.template); if (a.labelOutputs === undefined) node.data.labelOutputs = a.template.labelOutputs === true; } if (a.label !== undefined) { if (node.type !== 'image') fail('Only image nodes have image labels.'); node.data.label = a.label; } if (a.caption !== undefined) { if (node.type !== 'image') fail('Only image nodes have captions.'); if (a.caption) node.data.caption = a.caption; else delete node.data.caption; } return { nodeId: a.nodeId }; }));
define('delete_nodes', 'Delete nodes and their connections from a board; original image files and history remain.', withBoard({ nodeIds: ids, pageId }), ['boardId', 'nodeIds'], async (c, a) => changeGraph(c, a.boardId, g => { ensureItems(g.nodes, a.nodeIds, 'Node'); if (a.pageId !== undefined) targetPage(g, a.pageId, a.nodeIds); const selected = new Set(a.nodeIds); g.nodes = g.nodes.filter(n => !selected.has(n.id)); g.edges = g.edges.filter(e => !selected.has(e.source) && !selected.has(e.target)); g.groups = pruneGroups(g.groups || [], g.nodes); return { deleted: a.nodeIds.length }; }));
define('duplicate_nodes', 'Duplicate nodes from one page, internal connections and incoming parent connections with new IDs; copies stay on that page.', withBoard({ nodeIds: ids, offset: position, pageId }), ['boardId', 'nodeIds'], async (c, a) => {
  const newIds = new Map(a.nodeIds.map(id => [id, randomUUID()])), edgeIds = new Map(), createdAt = new Date().toISOString();
  return changeGraph(c, a.boardId, g => {
    ensureItems(g.nodes, a.nodeIds, 'Node'); targetPage(g, a.pageId, a.nodeIds);
    const copies = duplicateNodes(g, a.nodeIds, { offset: a.offset, ids: newIds, edgeIds, createdAt });
    g.nodes.push(...copies.nodes); g.edges.push(...copies.edges);
    return { nodeIds: [...newIds.values()], edgeIds: copies.edges.map(edge => edge.id) };
  });
});
define('connect_nodes', 'Connect a source node to a text node on the same page, such as an image to a describe node. Cycles are rejected.', withBoard({ source: itemId, target: itemId, pageId }), ['boardId', 'source', 'target'], async (c, a) => { const id = randomUUID(); return changeGraph(c, a.boardId, g => { const found = ensureItems(g.nodes, [a.source, a.target], 'Node'); targetPage(g, a.pageId, [a.source, a.target]); if (!['text', 'image'].includes(found.get(a.source).type) || found.get(a.target).type !== 'text') fail('Connect a text or image source to a text node.'); if (g.edges.some(e => e.source === a.source && e.target === a.target)) fail('That connection already exists.'); g.edges.push({ id, source: a.source, target: a.target }); return { edgeId: id }; }); });
define('delete_edges', 'Delete connections from a board.', withBoard({ edgeIds: ids }), ['boardId', 'edgeIds'], async (c, a) => changeGraph(c, a.boardId, g => { ensureItems(g.edges, a.edgeIds, 'Connection'); const selected = new Set(a.edgeIds); g.edges = g.edges.filter(e => !selected.has(e.id)); return { deleted: a.edgeIds.length }; }));
define('create_group', 'Group two or more existing nodes on the same page.', withBoard({ name: text('Group name', { minLength: 1, maxLength: 80 }), nodeIds: array('Node IDs', itemId, { minItems: 2, maxItems: 2000, uniqueItems: true }), collapsed: boolean('Collapse the group'), slideshow: boolean('Show one image at a time while folded'), color: groupColor, pageId }), ['boardId', 'name', 'nodeIds'], async (c, a) => { const id = randomUUID(); return changeGraph(c, a.boardId, g => { ensureItems(g.nodes, a.nodeIds, 'Node'); targetPage(g, a.pageId, a.nodeIds); g.groups ||= []; g.groups.push({ id, name: a.name.trim(), nodeIds: a.nodeIds, collapsed: !!a.collapsed, ...(a.slideshow ? { slideshow: true } : {}), ...(a.color ? { color: a.color } : {}) }); return { groupId: id }; }); });
define('update_group', 'Rename, collapse, expand, or move a group, turn it into a slideshow or back, or pick the image a folded slideshow shows, while retaining its nodes.', withBoard({ groupId: itemId, name: text('Group name', { minLength: 1, maxLength: 80 }), collapsed: boolean('Whether group is collapsed'), slideshow: boolean('Show one image at a time while folded'), slide: text('Image ID in this group for the folded slideshow to show', { minLength: 1, maxLength: 120 }), color: groupColor, position }), ['boardId', 'groupId'], async (c, a) => changeGraph(c, a.boardId, g => { const group = ensureItems(g.groups || [], [a.groupId], 'Group').get(a.groupId); if (a.slide !== undefined && (!group.nodeIds.includes(a.slide) || g.nodes.find(node => node.id === a.slide)?.type !== 'image')) fail('Pick an image from this group.'); if (a.position) g.nodes = moveGroup(g.nodes, group, a.position); if (a.name !== undefined) group.name = a.name.trim(); if (a.collapsed !== undefined) group.collapsed = a.collapsed; if (a.slideshow !== undefined) { if (a.slideshow) group.slideshow = true; else { delete group.slideshow; delete group.slide; } } if (a.slide !== undefined) group.slide = a.slide; if (a.color !== undefined) { if (a.color) group.color = a.color; else delete group.color; } return { groupId: a.groupId }; }));
define('ungroup', 'Remove a group while retaining its nodes and connections.', withBoard({ groupId: itemId }), ['boardId', 'groupId'], async (c, a) => changeGraph(c, a.boardId, g => { ensureItems(g.groups || [], [a.groupId], 'Group'); g.groups = g.groups.filter(group => group.id !== a.groupId); return { groupId: a.groupId }; }));
define('align_board', 'Arrange the nodes of one page left to right using estimated dimensions. Tall nodes or images may overlap; inspect the window screenshot afterward.', withBoard({ pageId }), ['boardId'], async (c, a) => changeGraph(c, a.boardId, g => { const page = targetPage(g, a.pageId), scoped = pageContent(g, page), aligned = new Map(alignNodes(scoped.nodes, scoped.edges, scoped.groups).map(node => [node.id, node])); g.nodes = g.nodes.map(node => aligned.get(node.id) || node); return { nodes: scoped.nodes.length, pageId: page }; }));
define('set_viewport', 'Set saved canvas pan and zoom.', withBoard({ viewport }), ['boardId', 'viewport'], async (c, a) => changeGraph(c, a.boardId, g => { g.viewport = a.viewport; return { viewport: g.viewport }; }));
define('list_runs', 'List recent generation history and status. Use get_run for the complete original inputs and diagnostics.', withBoard({ limit: number('Maximum number of recent runs (1–200)', { minimum: 1, maximum: 200 }) }), ['boardId'], async (c, a) => { const all = (await getBoard(c, a.boardId)).board.graph.runs; return { total: all.length, runs: all.slice(-Math.floor(a.limit || 50)).map(({ snapshot, prompt, images, target, diagnostics, ...run }) => run) }; }, true);
define('get_run', 'Get one generation’s full history, including original prompt, image assets and snapshots.', withBoard({ runId: text('Run ID', { pattern: uuidPattern.source }) }), ['boardId', 'runId'], async (c, a) => { const runs = (await getBoard(c, a.boardId)).board.graph.runs; const run = runs.find(value => value.id === a.runId); if (!run) fail('Run not found.'); return run; }, true);
define('start_run', 'Start image generation from a text or custom node using the user’s signed-in Codex account. On a board conflict, read the latest state before trying again.', withBoard({ nodeId: itemId }), ['boardId', 'nodeId'], async (c, a) => { const { board } = await getBoard(c, a.boardId); const result = await api(c, `/api/mcp/boards/${a.boardId}/runs`, { method: 'POST', body: { nodeId: a.nodeId, revision: board.graph.revision }, timeout: 60000 }); return { ...result, ...(result.uiSynchronized === false ? { warning: 'Generation was queued, but the open canvas did not acknowledge it. Do not start it again; reopen the board or app to synchronize.' } : {}) }; });
define('cancel_run', 'Cancel a queued or active generation.', withBoard({ runId: text('Run ID', { pattern: uuidPattern.source }) }), ['boardId', 'runId'], async (c, a) => api(c, `${boardRoute(a.boardId)}/runs/${a.runId}/cancel`, { method: 'POST' }));
define('list_templates', 'List saved custom-node templates with instructions and reference assets.', {}, [], async c => api(c, '/api/templates'), true);
define('set_node_template', 'Apply a saved custom node to an existing text node, keeping its text, position and connections.', withBoard({ nodeId: itemId, templateId: text('Saved custom-node template ID', { pattern: uuidPattern.source }) }), ['boardId', 'nodeId', 'templateId'], async (c, a) => {
  const saved = (await api(c, '/api/templates')).templates.find(item => item.id === a.templateId);
  if (!saved) fail('Custom node template not found.');
  return changeGraph(c, a.boardId, graph => {
    const node = ensureItems(graph.nodes, [a.nodeId], 'Node').get(a.nodeId);
    if (node.type !== 'text') fail('Only text nodes can use a custom node.');
    graph.nodes = graph.nodes.map(item => item.id === a.nodeId ? switchNodeTemplate(item, saved) : item);
    return { nodeId: a.nodeId, templateId: a.templateId };
  });
});
define('clear_node_template', 'Turn a custom text node back into a plain text node, keeping its text, position and connections.', withBoard({ nodeId: itemId }), ['boardId', 'nodeId'], async (c, a) => changeGraph(c, a.boardId, graph => {
  const node = ensureItems(graph.nodes, [a.nodeId], 'Node').get(a.nodeId);
  if (node.type !== 'text') fail('Only text nodes can use a custom node.');
  graph.nodes = graph.nodes.map(item => item.id === a.nodeId ? switchNodeTemplate(item, null) : item);
  return { nodeId: a.nodeId };
}));
define('create_template', 'Save a reusable custom text node with additional instructions and reference image assets.', templateFields, ['name', 'instructions', 'assets'], async (c, a) => api(c, '/api/templates', { method: 'POST', body: a }));
define('update_template', 'Update a saved custom-node template. Existing nodes keep their snapshots.', { templateId: text('Template ID', { pattern: uuidPattern.source }), ...templateFields }, ['templateId', 'name', 'instructions', 'assets'], async (c, a) => { const expected = (await api(c, '/api/templates')).templates.find(t => t.id === a.templateId); if (!expected) fail('Custom node template not found.'); const labelOutputs = a.labelOutputs ?? expected.labelOutputs, color = a.color ?? expected.color; return api(c, '/api/templates/' + a.templateId, { method: 'PUT', body: { name: a.name, instructions: a.instructions, assets: a.assets, ...(color === undefined ? {} : { color }), ...(labelOutputs === undefined ? {} : { labelOutputs }), expected } }); });
define('delete_template', 'Delete a saved template. Existing nodes keep their snapshots.', { templateId: text('Template ID', { pattern: uuidPattern.source }) }, ['templateId'], async (c, a) => { const expected = (await api(c, '/api/templates')).templates.find(t => t.id === a.templateId); if (!expected) fail('Custom node template not found.'); return api(c, '/api/templates/' + a.templateId, { method: 'DELETE', body: { expected } }); });
define('add_template_node', 'Add a custom-node snapshot to a board page, optionally with extra prompt text.', withBoard({ templateId: text('Template ID', { pattern: uuidPattern.source }), text: text('Additional prompt', { maxLength: 100000 }), labelOutputs: boolean('Legacy setting retained for compatibility; captions are automatic'), position, pageId }), ['boardId', 'templateId'], async (c, a) => { const saved = (await api(c, '/api/templates')).templates.find(t => t.id === a.templateId); if (!saved) fail('Custom node template not found.'); const id = randomUUID(); return changeGraph(c, a.boardId, g => { const page = targetPage(g, a.pageId); g.nodes.push({ id, type: 'text', position: origin(a.position), z: nextLayer(g.nodes), data: { text: a.text || '', createdAt: new Date().toISOString(), ...((a.labelOutputs ?? saved.labelOutputs) ? { labelOutputs: true } : {}), template: templateSnapshot(saved) }, ...pageField(page) }); return { nodeId: id, pageId: page }; }); });

const byName = new Map(tools.map(tool => [tool.name, tool]));
const supportedVersions = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  const hasId = Object.hasOwn(message, 'id');
  if (!hasId) return;
  try {
    let result;
    if (message.method === 'initialize') result = { protocolVersion: supportedVersions.has(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'concept-graph', version: '0.1.1' }, instructions: 'Open the Concept Graph desktop app before using tools. Graph edits are synchronized with its live board.' };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') result = { tools: tools.map(({ handler, ...item }) => item) };
    else if (message.method === 'tools/call') {
      const tool = byName.get(message.params?.name);
      if (!tool) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool.' } }); return; }
      try {
        const args = message.params.arguments || {};
        check(args, tool.inputSchema);
        const value = await tool.handler(await connect(), args);
        result = value?.content ? value : json(value);
      } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message || 'Operation failed.' }] }; }
    } else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found.' } }); return; }
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'MCP request failed.' } }); }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => { if (line.length > 4 * 1024 * 1024) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large.' } }); return; } let value; try { value = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; } void handle(value); });
