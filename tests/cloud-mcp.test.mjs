import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { signSession } from '../cloud/auth.mjs';
import { signInReturn } from '../src/cloud-boards.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { checkArgs, listedTools, revisionOf, toolByName } from '../cloud/mcp-tools.mjs';

test('add_image_node stores a unique prompt name from caption, filename or the Image fallback', () => {
  const graph = { nodes: [], edges: [], groups: [], runs: [] }, tool = toolByName.get('add_image_node');
  const add = args => {
    const { nodeId } = tool.run({ graph, args: { asset: '12345678-1234-1234-1234-123456789abc.png', ...args }, prepared: {} });
    return graph.nodes.find(node => node.id === nodeId).data;
  };
  assert.equal(add({}).caption, 'Image 1');
  assert.equal(add({ label: 'image.png', caption: '  ' }).caption, 'Image 2');
  const file = add({ label: 'Canyon.jpg' });
  assert.deepEqual([file.caption, file.label], ['Canyon', 'Canyon.jpg']);
  assert.equal(add({ label: 'Canyon.jpg', caption: 'Storm 3' }).caption, 'Storm 3');
  graph.pages = [{ id: 'page-1', name: 'Page 1' }, { id: 'other', name: 'Other' }];
  assert.equal(add({ label: 'Canyon.jpg', pageId: 'other' }).caption, 'Canyon 2');
  assert.equal(add({ caption: 'Storm 3', pageId: 'other' }).caption, 'Storm 3 2');
});

// Only the Cloudflare base classes and KV are replaced; OAuth, routing, Yjs, SQL and the rooms run for real.
let DatabaseSync, worker, BoardRoom, Directory;
if (nodeModule.registerHooks) {
  ({ DatabaseSync } = await import('node:sqlite'));
  const hooks = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== 'cloudflare:workers') return nextResolve(specifier, context);
      return { url: 'data:text/javascript,' + encodeURIComponent('export const env = {}; export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), shortCircuit: true };
    }
  });
  try { ({ default: worker, BoardRoom, Directory } = await import('../cloud/worker.mjs')); }
  finally { hooks.deregister(); }
}
const runtimeTest = nodeModule.registerHooks ? test : test.skip;

test('chat MCP schemas distinguish viewer-access writes from read-only tools', () => {
  assert.equal(toolByName.get('list_chat').annotations.readOnlyHint, true);
  assert.equal(toolByName.get('send_chat').access, 'view');
  assert.equal(toolByName.get('send_chat').annotations.readOnlyHint, false);
  assert.equal(toolByName.get('send_chat').annotations.idempotentHint, false);
  const boardId = '12345678-1234-1234-1234-123456789abc';
  checkArgs({ boardId, text: 'hi', nodeId: 'node' }, toolByName.get('send_chat').inputSchema);
  for (const args of [{ boardId, text: '' }, { boardId, text: 'x'.repeat(2001) }, { boardId, text: 'hi', agent: true }]) assert.throws(() => checkArgs(args, toolByName.get('send_chat').inputSchema));
  assert.throws(() => checkArgs({ boardId, before: '1' }, toolByName.get('list_chat').inputSchema));
});
const site = 'http://localhost:8787', redirect = 'http://localhost:9999/callback';

function png(width = 1, height = 1) {
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]); view.setUint32(16, width); view.setUint32(20, height); bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

// Workers KV as the OAuth library uses it: values with optional metadata, prefix listing, expiry ignored.
function kv() {
  const values = new Map();
  return {
    async get(key, options) { const item = values.get(key); if (!item) return null; const type = typeof options === 'string' ? options : options?.type; return type === 'json' ? JSON.parse(item.value) : item.value; },
    async getWithMetadata(key, options) { const item = values.get(key); return { value: item ? await this.get(key, options) : null, metadata: item?.metadata ?? null }; },
    async put(key, value, options = {}) { values.set(key, { value: typeof value === 'string' ? value : JSON.stringify(value), metadata: options.metadata }); },
    async delete(key) { values.delete(key); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const keys = [...values.keys()].filter(key => key.startsWith(prefix)).sort(), start = cursor ? Number(cursor) : 0, page = keys.slice(start, start + limit);
      return { keys: page.map(name => ({ name, metadata: values.get(name).metadata })), list_complete: start + limit >= keys.length, ...(start + limit < keys.length ? { cursor: String(start + limit) } : {}) };
    },
  };
}

function setup(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql = { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  const directory = new Directory({ storage: { sql } }, {}), files = new Map(), rooms = new Map(), waits = [];
  const env = {
    SESSION_SECRET: 'session-test', OAUTH_KV: kv(),
    Directory: { idFromName: name => name, get: () => directory },
    BoardRoom: { idFromName: name => name, get: name => rooms.get(name) || room(name) },
    FILES: {
      async put(key, bytes, metadata) { files.set(key, { bytes: new Uint8Array(bytes), size: bytes.byteLength, ...metadata }); },
      async get(key) { const file = files.get(key); return file ? { size: file.size, httpMetadata: file.httpMetadata, arrayBuffer: async () => file.bytes.slice().buffer } : null; },
      async head(key) { return files.get(key) || null; },
    },
    ASSETS: { fetch: async () => new Response('static') },
  };
  const room = name => {
    const roomDatabase = new DatabaseSync(':memory:'); t.after(() => roomDatabase.close());
    const roomSql = { exec(query, ...bindings) { const rows = roomDatabase.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
    const values = new Map(), storage = { sql: roomSql, kv: { get: key => values.get(key), put: (key, value) => values.set(key, value), delete: key => values.delete(key) }, transactionSync: callback => callback(),
      get: async key => values.get(key), put: async (key, value) => { values.set(key, value); }, deleteAll: async () => values.clear(), getAlarm: async () => null, setAlarm: async () => {} };
    const created = new BoardRoom({ storage, id: { name }, waitUntil: promise => waits.push(promise), blockConcurrencyWhile: callback => callback(), getWebSockets: () => [] }, env);
    created.onSave = async () => {};
    rooms.set(name, created); t.after(() => created.document.destroy());
    return created;
  };
  const ctx = { waitUntil: promise => waits.push(promise), passThroughOnException() {}, props: {} };
  const request = (path, init = {}) => worker.fetch(new Request(`${site}${path}`, { redirect: 'manual', ...init }), env, ctx);
  return { env, directory, files, rooms, room, request };
}

const cookies = response => response.headers.getSetCookie().map(cookie => cookie.split(';')[0]);

// The flow an MCP client runs: register, send the person to consent, swap the code for a token.
async function connect(request, email, name = 'Lead') {
  const session = `cg_session=${await signSession({ name, email }, 'session-test')}`;
  const registered = await (await request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Agent', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json();
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'boards', resource: `${site}/mcp` });
  const signIn = await request(`/oauth/authorize?${query}`);
  const consent = await request(`/oauth/authorize?${query}`, { headers: { Cookie: session } });
  const html = await consent.text(), handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  const approved = await request(`/oauth/authorize?${query}`, { method: 'POST', headers: { Cookie: [session, ...cookies(consent)].join('; '), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ handle, decision: 'approve' }) });
  const back = new URL(approved.headers.get('Location'));
  const token = await (await request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: redirect, client_id: registered.client_id, code_verifier: verifier, resource: `${site}/mcp` }) })).json();
  let id = 0;
  const rpc = async (method, params) => (await request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }) })).json();
  const tool = async (name, args = {}) => {
    const { result } = await rpc('tools/call', { name, arguments: args });
    return result.isError ? { error: result.content[0].text } : result.content.length === 1 && result.content[0].type === 'text' ? JSON.parse(result.content[0].text) : result.content;
  };
  return { signIn, consent, html, approved, back, token, rpc, tool, session };
}

test('every tool schema is an object schema the checker accepts, and sign-in may return to a pending agent connection', () => {
  assert.ok(listedTools.length >= 40);
  for (const tool of listedTools) { assert.equal(tool.inputSchema.type, 'object', tool.name); assert.equal(typeof tool.description, 'string'); }
  assert.throws(() => checkArgs({ boardId: 'x' }, listedTools.find(tool => tool.name === 'get_board').inputSchema), /boardId is invalid/);
  assert.equal(signInReturn('/oauth/authorize?client_id=a&state=b'), '/oauth/authorize?client_id=a&state=b');
  for (const value of ['//evil.example/oauth/authorize?x', '/oauth/authorize', '/oauth/authorizex?y', `/oauth/authorize?${'a'.repeat(2100)}`, '/oauth/authorize?a#b']) assert.equal(signInReturn(value), '/', value);
  assert.equal(revisionOf(new Uint8Array([1, 2, 3])), revisionOf(new Uint8Array([1, 2, 3])));
  assert.notEqual(revisionOf(new Uint8Array([1, 2, 3])), revisionOf(new Uint8Array([1, 2, 4])));
});

runtimeTest('cloud config lets the Worker answer agent discovery, OAuth and MCP routes', async () => {
  const config = JSON.parse((await readFile(new URL('../cloud/wrangler.jsonc', import.meta.url), 'utf8')));
  for (const route of ['/mcp', '/oauth/*', '/.well-known/*']) assert.ok(config.assets.run_worker_first.includes(route), route);
  assert.equal(config.kv_namespaces.find(item => item.binding === 'OAUTH_KV')?.binding, 'OAUTH_KV');
  assert.ok(config.compatibility_flags.includes('global_fetch_strictly_public'));
});

runtimeTest('an agent finds the sign-in, connects with the person’s consent and gets a token only for this site', async t => {
  const { request } = setup(t);
  const challenge = await request('/mcp', { method: 'POST', body: '{}' });
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get('WWW-Authenticate'), /resource_metadata="http:\/\/localhost:8787\/\.well-known\/oauth-protected-resource\/mcp"/);
  const resource = await (await request('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(resource.resource, `${site}/mcp`); assert.deepEqual(resource.authorization_servers, [site]);
  const metadata = await (await request('/.well-known/oauth-authorization-server')).json();
  assert.equal(metadata.authorization_endpoint, `${site}/oauth/authorize`); assert.equal(metadata.registration_endpoint, `${site}/oauth/register`);

  const { signIn, html, back, token } = await connect(request, 'lead@studio.example');
  // Signed out, the page offers Google sign-in that comes back to this same request.
  const signInHtml = await signIn.text();
  assert.match(signInHtml, /Sign in to connect your agent/);
  assert.match(decodeURIComponent(signInHtml.match(/href="\/api\/auth\/google\?next=([^"]+)"/)[1]), /^\/oauth\/authorize\?response_type=code&/);
  assert.match(html, /Allow Test Agent to use your boards\?/); assert.match(html, /lead@studio\.example/); assert.match(html, /an app on your computer/);
  assert.equal(back.origin + back.pathname, redirect); assert.equal(back.searchParams.get('state'), 'xyz');
  assert.equal(token.token_type.toLowerCase(), 'bearer'); assert.ok(token.access_token && token.refresh_token);

  // Deny goes back to the agent with access_denied; a forged form without the consent cookie is refused.
  const session = `cg_session=${await signSession({ name: 'Lead', email: 'lead@studio.example' }, 'session-test')}`;
  const registered = await (await request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Other', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) })).json();
  const query = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: redirect, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's', scope: 'boards', resource: `${site}/mcp` });
  const page = await request(`/oauth/authorize?${query}`, { headers: { Cookie: session } }), handle = (await page.text()).match(/name="handle" value="([^"]+)"/)[1];
  const forged = await request(`/oauth/authorize?${query}`, { method: 'POST', headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, decision: 'approve' }) });
  assert.equal(forged.status, 400);
  const denied = await request(`/oauth/authorize?${query}`, { method: 'POST', headers: { Cookie: [session, ...cookies(page)].join('; '), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ handle, decision: 'deny' }) });
  assert.equal(new URL(denied.headers.get('Location')).searchParams.get('error'), 'access_denied');
});

runtimeTest('an agent sees and edits a board live, within the person’s role', async t => {
  const { request, directory, rooms, files, env } = setup(t);
  const lead = await connect(request, 'lead@studio.example');
  const init = await lead.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.equal(init.result.serverInfo.name, 'concept-graph-cloud');
  assert.equal((await request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${lead.token.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status, 202);
  assert.ok((await lead.rpc('tools/list')).result.tools.some(tool => tool.name === 'add_sticky'));
  assert.equal((await lead.tool('whoami')).user.email, 'lead@studio.example');

  const { board } = await lead.tool('create_board', { name: 'Robots' });
  assert.equal(board.role, 'owner');
  assert.deepEqual((await lead.tool('list_boards')).boards.map(item => item.name), ['Robots']);
  const boardId = board.id;
  const { asset } = await lead.tool('upload_image', { data: Buffer.from(png(400, 200)).toString('base64') });
  assert.match(asset, /^[\da-f-]{36}\.png$/);
  assert.match((await lead.tool('upload_image', { data: Buffer.from('not an image').toString('base64') })).error, /PNG, JPEG/);

  const prompt = await lead.tool('add_text_node', { boardId, text: 'A courier robot', generator: 'nano-banana', variants: 2 });
  const image = await lead.tool('add_image_node', { boardId, asset, caption: 'Front' });
  assert.deepEqual(await lead.tool('connect_nodes', { boardId, source: image.nodeId, target: prompt.nodeId }).then(value => typeof value.edgeId), 'string');
  const sticky = await lead.tool('add_sticky', { boardId, text: 'Make it friendlier', position: { x: 0, y: 600 } });
  const shape = await lead.tool('add_shape', { boardId, shape: 'ellipse', text: 'Idea', position: { x: 400, y: 600 } });
  const arrow = await lead.tool('add_arrow', { boardId, from: { nodeId: sticky.nodeId }, to: { nodeId: shape.nodeId } });
  const stamp = await lead.tool('add_stamp', { boardId, kind: 'heart', nodeId: image.nodeId });
  assert.match((await lead.tool('add_stamp', { boardId, kind: 'heart', nodeId: arrow.nodeId })).error, /Stamps can go on/);
  assert.match((await lead.tool('connect_nodes', { boardId, source: sticky.nodeId, target: prompt.nodeId })).error, /prompt or image into a prompt/);
  await lead.tool('add_drawing', { boardId, points: [[0, 900], [50, 950], [100, 900]], color: '#e63946' });
  const section = await lead.tool('create_section', { boardId, name: 'Notes', around: [sticky.nodeId, shape.nodeId] });
  assert.ok(section.width >= 400);

  // The room's document holds it all, so everyone on the board sees it at once.
  const live = readCloudGraph(rooms.get(boardId).document);
  assert.deepEqual(live.nodes.map(node => node.type).sort(), ['arrow', 'drawing', 'image', 'shape', 'stamp', 'sticky', 'text']);
  const placed = live.nodes.find(node => node.id === image.nodeId);
  assert.equal(placed.data.aspect, 0.5); assert.equal(placed.data.author.name, 'Lead');
  assert.deepEqual(live.nodes.find(node => node.id === prompt.nodeId).data, { ...live.nodes.find(node => node.id === prompt.nodeId).data, text: 'A courier robot', generator: 'nano-banana', variants: 2 });
  assert.equal(live.nodes.find(node => node.id === arrow.nodeId).data.from.node, sticky.nodeId);
  assert.equal(live.sections[0].name, 'Notes');

  const view = await lead.tool('get_board', { boardId });
  assert.equal(view.board.name, 'Robots'); assert.equal(view.nodes.length, 7); assert.ok(view.nodes.every(node => node.page === 'page-1' && node.size.width > 0));
  assert.equal(view.sections.length, 1); assert.match(view.revision, /^[\da-f]{16}$/);

  // Moving a section carries what lies inside it; moving a node carries its stamp.
  await lead.tool('update_section', { boardId, sectionId: section.sectionId, position: { x: section.x + 100, y: section.y } });
  await lead.tool('update_node', { boardId, nodeId: image.nodeId, position: { x: placed.position.x, y: placed.position.y + 50 } });
  const moved = readCloudGraph(rooms.get(boardId).document), find = id => moved.nodes.find(node => node.id === id);
  assert.equal(find(sticky.nodeId).position.x, 100); assert.equal(find(shape.nodeId).position.x, 500);
  assert.equal(find(stamp.nodeId).position.y, live.nodes.find(node => node.id === stamp.nodeId).position.y + 50);
  assert.match((await lead.tool('update_node', { boardId, nodeId: sticky.nodeId, caption: 'x' })).error, /caption does not apply to a sticky/);

  const page = await lead.tool('add_page', { boardId, name: 'Ideas' });
  assert.match((await lead.tool('add_sticky', { boardId, text: 'Where?' })).error, /2 pages; pass pageId/);
  await lead.tool('add_sticky', { boardId, text: 'Elsewhere', pageId: page.pageId });
  assert.equal((await lead.tool('get_board', { boardId, pageId: page.pageId })).nodes.length, 1);

  // Deleting the image takes its stamp and connection; the arrow's ends stay where they were drawn.
  await lead.tool('delete_nodes', { boardId, nodeIds: [image.nodeId, sticky.nodeId] });
  const after = readCloudGraph(rooms.get(boardId).document);
  assert.ok(!after.nodes.some(node => [image.nodeId, stamp.nodeId, sticky.nodeId].includes(node.id)));
  assert.equal(after.edges.length, 0); assert.equal(after.nodes.find(node => node.id === arrow.nodeId).data.from.node, undefined);

  // apply_graph refuses a replacement built from an older read.
  const stale = view.revision, fresh = await lead.tool('get_board', { boardId });
  assert.match((await lead.tool('apply_graph', { boardId, revision: stale, nodes: [], edges: [], groups: [] })).error, /changed since/);
  const kept = fresh.nodes.filter(node => node.page === 'page-1');
  assert.equal((await lead.tool('apply_graph', { boardId, revision: fresh.revision, nodes: kept, edges: [], groups: [], pages: [{ id: 'page-1', name: 'Main' }] })).applied, true);
  assert.deepEqual(readCloudGraph(rooms.get(boardId).document).pages.map(item => item.name), ['Main']);

  // Custom nodes live in the board.
  const { template } = await lead.tool('create_template', { boardId, name: 'Style', instructions: 'Warm light', assets: [asset] });
  const custom = await lead.tool('add_template_node', { boardId, templateId: template.id, text: 'Robot', pageId: 'page-1' });
  assert.equal(readCloudGraph(rooms.get(boardId).document).nodes.find(node => node.id === custom.nodeId).data.template.instructions, 'Warm light');
  assert.equal((await lead.tool('list_templates', { boardId })).templates.length, 1);

  // Codex prompts run only in a browser; Nano Banana needs the site's key.
  await lead.tool('update_node', { boardId, nodeId: prompt.nodeId, generator: 'codex' });
  // Codex runs on the person's own computer: without their board open there is nothing to start it.
  assert.match((await lead.tool('start_run', { boardId, nodeId: prompt.nodeId })).error, /open the board in Concept Graph with the helper connected/i);
  // With it open, only that person's editing tabs are asked, one at a time, and the first that starts the run answers.
  const boardRoom = rooms.get(boardId), asked = [], codexRun = '11111111-2222-4333-8444-555555555555', theirRun = '66666666-7777-4888-9999-000000000000';
  const tab = (id, email, role, answer) => ({ id, state: { email, role }, answer });
  const tabs = [tab('viewer-tab', 'viewer@studio.example', 'edit', { runId: 'wrong' }), tab('lead-view', 'lead@studio.example', 'view', { runId: 'wrong' }),
    tab('lead-unpaired', 'lead@studio.example', 'owner', { error: 'Connect the Concept Graph helper on the open board first.' }), tab('lead-ready', 'lead@studio.example', 'owner', { runId: codexRun })];
  boardRoom.getConnections = () => tabs;
  boardRoom.sendCustomMessage = (connection, message) => {
    const value = JSON.parse(message); asked.push([connection.id, value.type, value.nodeId ?? value.runId]);
    // A forged answer from a tab that was not asked is ignored.
    boardRoom.onCustomMessage({ id: 'lead-ready' === connection.id ? 'viewer-tab' : 'nobody' }, JSON.stringify({ type: 'agent-answer', requestId: value.requestId, runId: 'forged' }));
    queueMicrotask(() => boardRoom.onCustomMessage(connection, JSON.stringify({ type: 'agent-answer', requestId: value.requestId, ...connection.answer })));
  };
  assert.deepEqual(await lead.tool('start_run', { boardId, nodeId: prompt.nodeId }), { runId: codexRun, generator: 'codex', status: 'started' });
  assert.deepEqual(asked, [['lead-unpaired', 'agent-generate', prompt.nodeId], ['lead-ready', 'agent-generate', prompt.nodeId]]);
  tabs.splice(3, 1);
  assert.match((await lead.tool('start_run', { boardId, nodeId: prompt.nodeId })).error, /Connect the Concept Graph helper/);
  // Cancelling a Codex run this person started goes through their tab too.
  boardRoom.document.getMap('runs').set(codexRun, { id: codexRun, nodeId: prompt.nodeId, status: 'running', by: { name: 'Lead' } });
  tabs[2].answer = { ok: true }; asked.length = 0;
  assert.deepEqual(await lead.tool('cancel_run', { boardId, runId: codexRun }), { cancelled: codexRun });
  assert.deepEqual(asked, [['lead-unpaired', 'agent-cancel', codexRun]]);
  boardRoom.document.getMap('runs').set(theirRun, { id: theirRun, nodeId: prompt.nodeId, status: 'running', by: { name: 'Someone else' } });
  assert.match((await lead.tool('cancel_run', { boardId, runId: theirRun })).error, /Only the person who started/);
  boardRoom.getConnections = () => [];
  // Nano Banana prompts need the site's key and a place on the allowed list.
  await lead.tool('update_node', { boardId, nodeId: prompt.nodeId, generator: 'nano-banana' });
  assert.match((await lead.tool('start_run', { boardId, nodeId: prompt.nodeId })).error, /isn’t set up/);
  Object.assign(env, { GEMINI_API_KEY: 'test-key', NANO_BANANA_ALLOWED: '@elsewhere.example' });
  assert.match((await lead.tool('start_run', { boardId, nodeId: prompt.nodeId })).error, /not available for this account/);

  const images = await lead.tool('get_image', { assets: [asset] });
  assert.equal(images[1].type, 'image'); assert.equal(images[1].mimeType, 'image/png');

  // A viewer reads but cannot change; someone without access sees nothing.
  directory.changeSharing(boardId, 'lead@studio.example', { member: { email: 'viewer@studio.example', role: 'view' } });
  const viewer = await connect(request, 'viewer@studio.example', 'Viewer');
  assert.equal((await viewer.tool('get_board', { boardId })).board.role, 'view');
  assert.match((await viewer.tool('add_sticky', { boardId, text: 'Hi', pageId: 'page-1' })).error, /only view/);
  assert.match((await viewer.tool('rename_board', { boardId, name: 'Mine' })).error, /owner/);
  const stranger = await connect(request, 'stranger@mail.example', 'Stranger');
  assert.match((await stranger.tool('get_board', { boardId })).error, /access/);

  // Chat is a viewer-access write without changing the canvas revision or saving a board version.
  const beforeChat = (await lead.tool('get_board', { boardId })).revision, liveChat = [];
  boardRoom.broadcastCustomMessage = message => liveChat.push(JSON.parse(message));
  const posted = await viewer.tool('send_chat', { boardId, text: '  Review this  ', nodeId: prompt.nodeId });
  assert.equal(posted.message.author.email, 'viewer@studio.example'); assert.equal(posted.message.author.name, 'Viewer'); assert.equal(posted.message.agent, true);
  assert.equal(posted.message.text, 'Review this'); assert.equal(liveChat.at(-1).type, 'chat-message');
  assert.equal((await lead.tool('get_board', { boardId })).revision, beforeChat);
  assert.equal((await lead.tool('list_chat', { boardId })).messages[0].id, posted.message.id);
  for (let index = 0; index < 7; index++) assert.ok((await viewer.tool('send_chat', { boardId, text: `Again ${index}` })).message);
  assert.match((await viewer.tool('send_chat', { boardId, text: 'Ninth' })).error, /Wait/);
  assert.match((await stranger.tool('list_chat', { boardId })).error, /access/);
  assert.match((await stranger.tool('send_chat', { boardId, text: 'No' })).error, /access/);
  assert.match((await lead.tool('send_chat', { boardId, text: '   ' })).error, /1–2000/);
  for (let index = 1; index <= 55; index++) boardRoom.chat().send({ text: `Page ${index}` }, { name: 'Lead', email: 'lead@studio.example' }, { now: index * 2000 });
  const recentChat = await viewer.tool('list_chat', { boardId }); assert.equal(recentChat.messages.length, 50); assert.equal(recentChat.more, true);
  const earlierChat = await viewer.tool('list_chat', { boardId, before: recentChat.messages.at(-1).id }); assert.equal(earlierChat.messages.length, 13); assert.equal(earlierChat.more, false);

  assert.match((await lead.tool('delete_board', { boardId, confirmName: 'robots' })).error, /exact current name/);
  const deleted = await lead.tool('delete_board', { boardId, confirmName: 'Robots' });
  assert.equal(deleted.deleted, boardId); assert.ok(Date.parse(deleted.restorableUntil) > Date.now() + 29 * 24 * 60 * 60 * 1000);
  assert.deepEqual(directory.trashFor('lead@studio.example').map(board => board.id), [boardId]);
  assert.deepEqual((await lead.tool('list_boards')).boards, []);
  assert.ok(files.size >= 1);
});

runtimeTest('room chat authenticates viewers, owns deletion, persists across hibernation and stamps live echoes', async t => {
  const { room } = setup(t), board = room(crypto.randomUUID()), sent = [], broadcasts = [];
  board.sendCustomMessage = (connection, value) => sent.push({ connection, ...JSON.parse(value) });
  board.broadcastCustomMessage = value => broadcasts.push(JSON.parse(value));
  const connection = { id: 'viewer', state: { name: 'Viewer', color: '#aabbcc', email: 'viewer@example.com', role: 'view' }, setState(update) { this.state = update(this.state); } };
  board.onCustomMessage(connection, JSON.stringify({ type: 'chat-send', key: 'one', text: 'hello', author: { name: 'Fake' }, agent: true }));
  assert.equal(sent.at(-1).message.author.name, 'Viewer'); assert.equal(sent.at(-1).message.agent, undefined); assert.equal(sent.at(-1).key, 'one');
  const id = sent.at(-1).message.id;
  board.boardChat = null;
  board.onCustomMessage(connection, JSON.stringify({ type: 'chat-send', key: 'one', text: 'hello' }));
  assert.equal(broadcasts.length, 1); assert.equal(sent.at(-1).message.id, id);
  const other = { ...connection, id: 'other', state: { name: 'Other', email: 'other@example.com', role: 'view' } };
  board.onCustomMessage(other, JSON.stringify({ type: 'chat-delete', id })); assert.equal(sent.at(-1).type, 'chat-failed');
  board.onCustomMessage(connection, JSON.stringify({ type: 'chat-delete', id })); assert.equal(broadcasts.at(-1).type, 'chat-deleted');
  assert.equal(board.chat().history().messages[0].text, '');
});

runtimeTest('room arbitrates eight voice slots and relays bounded signals from their real presence only', async t => {
  const { room } = setup(t), board = room(crypto.randomUUID()), sent = [];
  const connections = Array.from({ length: 9 }, (_, index) => ({ id: `socket-${index}`, state: { role: 'view', email: `${index}@example.com`, __ypsAwarenessIds: [index + 1] }, setState(update) { this.state = update(this.state); } }));
  board.getConnections = () => connections;
  board.sendCustomMessage = (connection, message) => sent.push({ connection: connection.id, ...JSON.parse(message) });
  connections.forEach((connection, index) => board.voiceMessage(connection, { type: 'voice-join', clientId: index + 1, key: `key-${index}` }));
  assert.equal(sent.filter(item => item.type === 'voice-joined').length, 8); assert.match(sent.at(-1).reason, /full/);
  // Clearing all transient room fields changes neither socket admission nor ownership.
  board.voiceMessage(connections[0], { type: 'voice-signal', to: 2, from: 999, data: { candidate: 'ice' } });
  assert.equal(sent.at(-1).connection, 'socket-1'); assert.equal(sent.at(-1).from, 1);
  const count = sent.length;
  board.voiceMessage(connections[8], { type: 'voice-signal', to: 2, data: { candidate: 'no slot' } });
  board.voiceMessage(connections[0], { type: 'voice-signal', to: 9, data: { candidate: 'not admitted' } });
  board.voiceMessage(connections[0], { type: 'voice-signal', to: 2, data: { sdp: 'x'.repeat(25000) } });
  assert.equal(sent.length, count);
  board.voiceMessage(connections[8], { type: 'voice-join', clientId: 2 }); assert.match(sent.at(-1).reason, /connecting/);
  board.voiceMessage(connections[0], { type: 'voice-leave' });
  board.voiceMessage(connections[8], { type: 'voice-join', clientId: 9 }); assert.equal(sent.at(-1).type, 'voice-joined');
  let gone;
  board.broadcastCustomMessage = value => { gone = JSON.parse(value); };
  // Awareness is empty just as after hibernation; socket ownership still permits prompt peer cleanup.
  await board.onClose(connections[8], 1000, 'closed', true); assert.deepEqual(gone, { type: 'voice-left', from: 9 });
});

runtimeTest('ICE endpoint requires authentication and board access, including viewers', async t => {
  const { request, directory } = setup(t);
  const owner = { name: 'Lead', email: 'lead@studio.example' }, board = await directory.createBoard('Voice', owner), path = `/api/boards/${board.id}/voice/ice`;
  assert.equal((await request(path, { method: 'POST' })).status, 401);
  const cookie = async email => `cg_session=${await signSession({ name: 'Person', email }, 'session-test')}`;
  assert.equal((await request(path, { method: 'POST', headers: { Cookie: await cookie('other@studio.example') } })).status, 403);
  directory.changeSharing(board.id, owner.email, { member: { email: 'viewer@studio.example', role: 'view' } });
  const headers = { Cookie: await cookie('viewer@studio.example') };
  assert.deepEqual(await (await request(path, { method: 'POST', headers })).json(), { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
  assert.equal((await request(path, { method: 'POST', headers: { ...headers, Origin: 'https://elsewhere.example' } })).status, 403);
  assert.equal((await request(path, { headers })).status, 405);
});
