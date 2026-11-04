import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { signSession } from '../cloud/auth.mjs';
import { boardRole, canEdit } from '../cloud/access.mjs';
import { copyLibrary, deleteBoardTemplate, libraryCopied, readBoardTemplates, saveBoardTemplate } from '../src/board-templates.mjs';
import { templatePalette } from '../graph.mjs';

// Only the Cloudflare base class is replaced; routing, SQL, Yjs and the rooms run for real.
let DatabaseSync, worker, BoardRoom, Directory;
if (nodeModule.registerHooks) {
  ({ DatabaseSync } = await import('node:sqlite'));
  const hooks = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== 'cloudflare:workers') return nextResolve(specifier, context);
      return { url: 'data:text/javascript,' + encodeURIComponent('export const env = {}; export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), shortCircuit: true };
    }
  });
  try { ({ default: worker, BoardRoom, Directory } = await import('../cloud/worker.mjs')); }
  finally { hooks.deregister(); }
}
const runtimeTest = nodeModule.registerHooks ? test : test.skip;

const library = [{ id: '11111111-1111-4111-8111-111111111111', name: 'Views', instructions: 'Front and side', assets: [], color: templatePalette[2], createdAt: '2026-01-01T00:00:00.000Z' }];

function storage(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  return { database, sql: { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } } };
}

function setup(t, extra = {}) {
  const { sql } = storage(t), directory = new Directory({ storage: { sql } }, extra), routed = [], refreshed = [], served = [];
  const env = {
    SESSION_SECRET: 'session-test', ...extra,
    Directory: { idFromName: name => name, get: () => directory },
    BoardRoom: { idFromName: name => name, get: name => ({ fetch: async request => { routed.push(request); return new Response('routed'); }, setName: async () => {}, refreshAccess: async () => { refreshed.push(name); } }) },
    FILES: { async head() { return null; }, async get() { return null; }, async put() {} },
    ASSETS: { fetch: async request => { served.push(new URL(request.url).pathname); return new Response('app'); } },
  };
  const request = (path, { method = 'GET', cookie, data, headers = {} } = {}) => worker.fetch(new Request(`http://localhost:8787${path}`, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }), env);
  const person = async (email, name) => ({ email, name, cookie: `cg_session=${await signSession({ name, email }, env.SESSION_SECRET)}` });
  return { env, directory, routed, refreshed, served, request, person };
}

function room(t, directory = {}, values = new Map()) {
  const kv = { get: key => values.get(key), put: (key, value) => values.set(key, value), delete: key => values.delete(key) };
  const created = new BoardRoom({ storage: { kv, transactionSync: callback => callback(), get: async key => values.get(key), put: async (key, value) => { values.set(key, value); } },
    id: { name: 'board-1' }, waitUntil() {}, blockConcurrencyWhile: callback => callback(), getWebSockets: () => [] }, { Directory: { idFromName: name => name, get: () => directory } });
  created.onSave = async () => {};
  t.after(() => created.document.destroy());
  return created;
}

function connection(state = null) {
  return { id: crypto.randomUUID(), readyState: 1, state, sent: [], closed: null,
    setState(update) { this.state = typeof update === 'function' ? update(this.state) : update; return this.state; },
    send(message) { this.sent.push(message); }, close(code, reason) { this.closed = [code, reason]; } };
}

const syncMessage = write => { const encoder = encoding.createEncoder(); encoding.writeVarUint(encoder, 0); write(encoder); return encoding.toUint8Array(encoder); };
const access = role => `__YPS:${JSON.stringify({ type: 'access', role })}`;

test('the strongest applicable role wins: owner, then the invitation or the link and everyone setting', () => {
  const board = { owner: 'owner@studio.example', access: 'private', linkRole: 'edit' };
  assert.equal(boardRole(board, 'owner@studio.example'), 'owner');
  assert.equal(boardRole(board, 'owner@studio.example', 'view'), 'owner');
  assert.equal(boardRole(board, 'guest@studio.example'), null);
  assert.equal(boardRole(board, 'guest@studio.example', 'view'), 'view');
  assert.equal(boardRole({ ...board, access: 'link', linkRole: 'view' }, 'guest@studio.example'), 'view');
  assert.equal(boardRole({ ...board, access: 'link', linkRole: 'view' }, 'guest@studio.example', 'edit'), 'edit');
  // An invited viewer can still edit when the link lets anyone edit, as in Google Docs.
  assert.equal(boardRole({ ...board, access: 'link' }, 'guest@studio.example', 'view'), 'edit');
  assert.equal(boardRole({ ...board, access: 'everyone', linkRole: 'view' }, 'guest@studio.example'), 'view');
  assert.equal(boardRole({ owner: null, access: 'everyone', linkRole: 'edit' }, 'anyone@mail.example'), 'edit');
  for (const role of ['owner', 'admin', '', undefined]) assert.equal(boardRole(board, 'guest@studio.example', role), null);
  assert.equal(boardRole({ ...board, access: 'link', linkRole: 'owner' }, 'guest@studio.example'), null);
  assert.equal(boardRole(board, ''), null); assert.equal(boardRole(null, 'owner@studio.example'), null);
  assert.deepEqual(['owner', 'edit', 'view', null].map(canEdit), [true, true, false, false]);
});

runtimeTest('boards made before sharing open to everyone, go to the site owner and copy the old library once', t => {
  const { database, sql } = storage(t);
  database.exec("CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT, imageCount INTEGER, covers TEXT NOT NULL DEFAULT '[]'); CREATE TABLE templates (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  database.prepare('INSERT INTO boards (id, name, createdAt) VALUES (?, ?, ?)').run('old', 'Old board', '2026-01-01T00:00:00.000Z');
  database.prepare('INSERT INTO templates VALUES (?, ?)').run(library[0].id, JSON.stringify(library[0]));
  const ownerless = new Directory({ storage: { sql } }, {});
  assert.deepEqual(ownerless.boardFor('old', 'anyone@mail.example'), { id: 'old', name: 'Old board', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', imageCount: null, covers: [], ownerName: null, access: 'everyone', linkRole: 'edit', role: 'edit' });
  assert.deepEqual(ownerless.changeSharing('old', 'anyone@mail.example', { access: 'private' }), { error: 'This board has no owner, so nobody can change who has access.', status: 403 });
  assert.equal(ownerless.sharing('old', 'anyone@mail.example').canManage, false);
  assert.deepEqual(ownerless.libraryFor('old'), library);
  const owned = new Directory({ storage: { sql } }, { SITE_OWNER_EMAIL: ' Owner@Studio.example ' });
  assert.equal(owned.boardFor('old', 'owner@studio.example').role, 'owner');
  assert.equal(owned.boardFor('old', 'anyone@mail.example').role, 'edit');
  assert.equal(owned.boardFor('old', 'anyone@mail.example').owner, undefined);
  const fresh = owned.createBoard('New board', { email: 'maker@studio.example', name: 'Maker' });
  assert.deepEqual(owned.getBoard(fresh.id), fresh);
  assert.deepEqual({ ...owned.boardFor(fresh.id, 'maker@studio.example'), createdAt: 0, updatedAt: 0 }, { id: fresh.id, name: 'New board', createdAt: 0, updatedAt: 0, imageCount: 0, covers: [], ownerName: 'Maker', access: 'private', linkRole: 'view', role: 'owner' });
  assert.equal(owned.boardFor(fresh.id, 'owner@studio.example').role, null);
  assert.deepEqual(owned.libraryFor(fresh.id), []);
  assert.equal(owned.boardFor(crypto.randomUUID(), 'maker@studio.example'), null);
  // Another site owner later takes over only boards that still have none.
  assert.equal(new Directory({ storage: { sql } }, { SITE_OWNER_EMAIL: 'next@studio.example' }).boardFor('old', 'owner@studio.example').role, 'owner');
  assert.equal(new Directory({ storage: { sql } }, { SITE_OWNER_EMAIL: 'not an email' }).boardFor('old', 'owner@studio.example').role, 'owner');
});

runtimeTest('invitations, roles, link visits and the board list follow the owner’s choices', t => {
  const { sql } = storage(t), directory = new Directory({ storage: { sql } }, {});
  const owner = { email: 'owner@studio.example', name: 'Owner' }, guest = { email: 'guest@mail.example', name: 'Guest' };
  const ids = list => list.map(board => board.id);
  const [secret, linked, team, invited] = ['Secret', 'Linked', 'Team', 'Invited'].map(name => directory.createBoard(name, owner));
  const everyone = directory.createBoard('Legacy');
  assert.deepEqual(directory.changeSharing(linked.id, guest.email, { access: 'link' }), { error: 'Only the board’s owner can change who has access.', status: 403 });
  directory.changeSharing(linked.id, owner.email, { access: 'link' });
  directory.changeSharing(team.id, owner.email, { access: 'everyone', linkRole: 'edit' });
  const { sharing } = directory.changeSharing(invited.id, owner.email, { member: { email: ' Guest@Mail.example ', role: 'view' } });
  assert.deepEqual(sharing, { role: 'owner', canManage: true, owner: { name: 'Owner', email: owner.email }, access: 'private', linkRole: 'view', members: [{ email: guest.email, role: 'view', name: null }], pending: 0 });
  assert.deepEqual(ids(directory.boardsFor(guest.email)), [everyone.id, invited.id, team.id]);
  assert.deepEqual(directory.boardsFor(guest.email).map(board => board.role), ['edit', 'view', 'edit']);
  assert.deepEqual(ids(directory.boardsFor(owner.email)), [everyone.id, invited.id, team.id, linked.id, secret.id]);
  // A link board joins the list once the person opens it, and leaves it when the link stops working.
  assert.equal(directory.boardFor(linked.id, guest.email).role, 'view');
  assert.equal(directory.openBoard(linked.id, guest).board.role, 'view');
  assert.deepEqual(ids(directory.boardsFor(guest.email)), [everyone.id, invited.id, team.id, linked.id]);
  directory.changeSharing(linked.id, owner.email, { access: 'private' });
  assert.deepEqual(ids(directory.boardsFor(guest.email)), [everyone.id, invited.id, team.id]);
  assert.deepEqual(directory.openBoard(linked.id, guest), { error: 'You don’t have access to this board.', status: 403, owner: { name: 'Owner' } });
  assert.deepEqual(directory.openBoard(crypto.randomUUID(), guest), { error: 'Board not found.', status: 404 });
  assert.equal(directory.openBoard(secret.id, guest).status, 403);
  // Changing and removing an invitation.
  directory.changeSharing(invited.id, owner.email, { member: { email: guest.email, role: 'edit' } });
  assert.equal(directory.boardFor(invited.id, guest.email).role, 'edit');
  const opened = directory.openBoard(invited.id, guest);
  assert.deepEqual(opened.sharing, { role: 'edit', canManage: false, owner: { name: 'Owner' }, access: 'private', linkRole: 'view', members: [{ name: 'Guest', role: 'edit' }], pending: 0 });
  directory.changeSharing(invited.id, owner.email, { member: { email: 'later@mail.example', role: 'view' } });
  assert.equal(directory.sharing(invited.id, guest.email).pending, 1);
  assert.deepEqual(directory.sharing(invited.id, owner.email).members.map(member => member.email), [guest.email, 'later@mail.example']);
  directory.changeSharing(invited.id, owner.email, { member: { email: guest.email, role: null } });
  assert.equal(directory.boardFor(invited.id, guest.email).role, null);
  assert.deepEqual(directory.roomAccess(invited.id), { owner: owner.email, access: 'private', linkRole: 'view', members: [['later@mail.example', 'view']] });
  // Invalid changes leave the board as it was.
  for (const [change, message] of [[{ access: 'public' }, 'Choose who can open this board.'], [{ linkRole: 'owner' }, 'Choose “Can view” or “Can edit”.'],
    [{ member: { email: 'not-an-email', role: 'view' } }, 'Enter a valid email address.'], [{ member: { email: guest.email, role: 'owner' } }, 'Choose “Can view” or “Can edit”.'],
    [{ member: null }, 'Choose “Can view” or “Can edit”.'], [{ member: { email: ' OWNER@studio.example', role: 'edit' } }, 'You already own this board.']]) {
    assert.deepEqual(directory.changeSharing(invited.id, owner.email, change), { error: message, status: 400 });
  }
  assert.equal(directory.changeSharing(crypto.randomUUID(), owner.email, {}).status, 404);
  for (let i = 0; i < 199; i++) directory.changeSharing(secret.id, owner.email, { member: { email: `person${i}@mail.example`, role: 'view' } });
  directory.changeSharing(secret.id, owner.email, { member: { email: 'last@mail.example', role: 'view' } });
  assert.equal(directory.changeSharing(secret.id, owner.email, { member: { email: 'extra@mail.example', role: 'view' } }).error, 'A board can have at most 200 invited people.');
  assert.equal(directory.changeSharing(secret.id, owner.email, { member: { email: 'last@mail.example', role: 'edit' } }).sharing.members.at(-1).role, 'edit');
  // The owner opening the board refreshes the name others see.
  directory.openBoard(invited.id, { ...owner, name: 'Owner Renamed' });
  assert.equal(directory.boardFor(invited.id, 'later@mail.example').ownerName, 'Owner Renamed');
});

runtimeTest('board routes give each person their role and let only the owner rename or share', async t => {
  const { request, person, refreshed, directory } = setup(t);
  const owner = await person('owner@studio.example', 'Owner'), guest = await person('guest@mail.example', 'Guest'), headers = { Origin: 'http://localhost:8787' };
  const created = await request('/api/cloud/boards', { method: 'POST', cookie: owner.cookie, data: { name: ' Robots ' } });
  assert.equal(created.status, 201);
  const { board } = await created.json(), path = `/api/cloud/boards/${board.id}`;
  assert.deepEqual({ name: board.name, access: board.access, linkRole: board.linkRole, role: board.role, ownerName: board.ownerName, owner: board.owner }, { name: 'Robots', access: 'private', linkRole: 'view', role: 'owner', ownerName: 'Owner', owner: undefined });
  assert.deepEqual((await (await request('/api/cloud/boards', { cookie: guest.cookie })).json()).boards, []);
  const denied = await request(path, { cookie: guest.cookie });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: 'You don’t have access to this board.', owner: { name: 'Owner' } });
  assert.equal((await request(`${path}/sharing`, { cookie: guest.cookie })).status, 403);
  assert.equal((await request(`/api/cloud/boards/${crypto.randomUUID()}`, { cookie: guest.cookie })).status, 404);
  assert.equal((await request('/api/cloud/boards/not-a-board/sharing', { cookie: guest.cookie })).status, 404);
  assert.equal((await request(`${path}/sharing`, { method: 'PATCH', cookie: guest.cookie, data: { access: 'link' }, headers })).status, 403);
  assert.equal((await request(`${path}/sharing`, { method: 'PATCH', cookie: owner.cookie, data: { access: 'link' }, headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await request(`${path}/sharing`, { method: 'PUT', cookie: owner.cookie, data: {} })).status, 405);
  assert.deepEqual(refreshed, []);
  const shared = await request(`${path}/sharing`, { method: 'PATCH', cookie: owner.cookie, data: { member: { email: guest.email, role: 'view' } }, headers });
  assert.equal(shared.status, 200);
  assert.deepEqual((await shared.json()).sharing.members, [{ email: guest.email, role: 'view', name: null }]);
  assert.deepEqual(refreshed, [board.id]);
  const opened = await (await request(path, { cookie: guest.cookie })).json();
  assert.equal(opened.board.role, 'view'); assert.equal(opened.sharing.canManage, false);
  assert.deepEqual((await (await request(`${path}/sharing`, { cookie: owner.cookie })).json()).sharing.members, [{ email: guest.email, role: 'view', name: 'Guest' }]);
  assert.deepEqual((await (await request('/api/cloud/boards', { cookie: guest.cookie })).json()).boards.map(item => [item.id, item.role]), [[board.id, 'view']]);
  const rename = (cookie, name) => request(path, { method: 'PATCH', cookie, data: { name } });
  const refused = await rename(guest.cookie, 'Mine');
  assert.equal(refused.status, 403); assert.deepEqual(await refused.json(), { error: 'Only the board’s owner can rename it.' });
  assert.equal((await (await rename(owner.cookie, 'Robots v2')).json()).board.name, 'Robots v2');
  assert.equal((await request(path, { method: 'DELETE', cookie: owner.cookie })).status, 405);
  // Nano Banana writes to the board, so it needs edit access.
  const nano = cookie => request(`/api/boards/${board.id}/nano`, { method: 'POST', cookie, data: { nodeId: 'p' } });
  const viewer = await nano(guest.cookie);
  assert.equal(viewer.status, 403); assert.deepEqual(await viewer.json(), { error: 'You can only view this board.' });
  const stranger = await person('stranger@mail.example', 'Stranger');
  assert.deepEqual(await (await nano(stranger.cookie)).json(), { error: 'You don’t have access to this board.' });
  assert.equal((await request(`/api/boards/${board.id}/nano/${crypto.randomUUID()}/cancel`, { method: 'POST', cookie: guest.cookie })).status, 403);
  assert.equal((await nano(owner.cookie)).status, 503);
  directory.changeSharing(board.id, owner.email, { member: { email: guest.email, role: 'edit' } });
  assert.equal((await nano(guest.cookie)).status, 503);
});

runtimeTest('board links serve the app, and Google sign-in returns to the board it started from', async t => {
  const { request, served } = setup(t, { GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'google-secret' }), id = crypto.randomUUID();
  for (const path of [`/b/${id}`, `/b/${id}/`, '/b/anything']) assert.equal(await (await request(path)).text(), 'app');
  assert.deepEqual(served, ['/', '/', '/']);
  assert.equal((await request(`/b/${id}`, { method: 'POST' })).status, 405);
  const begin = async next => {
    const response = await request(`/api/auth/google${next === undefined ? '' : `?next=${encodeURIComponent(next)}`}`);
    const cookie = response.headers.get('Set-Cookie').split(';')[0];
    return { cookie, state: JSON.parse(Buffer.from(cookie.slice('cg_google='.length).split('.')[0], 'base64url').toString()) };
  };
  for (const [next, expected] of [[`/b/${id}`, `/b/${id}`], [undefined, '/'], ['https://attacker.example/b/x', '/'], ['//attacker.example', '/'], [`/b/${id}/../../api`, '/'], ['/b/not-a-board', '/']]) assert.equal((await begin(next)).state.next, expected, next);
  const { cookie, state } = await begin(`/b/${id}`);
  const token = [{ alg: 'RS256' }, { iss: 'https://accounts.google.com', aud: 'client.apps.googleusercontent.com', sub: 'google-1', exp: Math.floor(Date.now() / 1000) + 3600, nonce: state.nonce, email: 'guest@mail.example', email_verified: true, name: 'Guest' }, 'signature']
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id_token: token }));
  t.mock.method(console, 'error', () => {});
  const callback = query => request(`/api/auth/google/callback?state=${state.state}&${query}`, { cookie });
  assert.equal((await callback('code=test')).headers.get('Location'), `/b/${id}`);
  assert.equal((await callback('error=access_denied')).headers.get('Location'), `/b/${id}?auth_error=cancelled`);
  assert.equal((await request(`/api/auth/google/callback?state=wrong&code=test`, { cookie })).headers.get('Location'), '/?auth_error=failed');
});

runtimeTest('board connections admit only people with a role and carry the role the Worker set', async t => {
  const { request, person, routed, directory } = setup(t);
  const owner = await person('owner@studio.example', 'Owner'), guest = await person('guest@mail.example', 'Guest'), stranger = await person('stranger@mail.example', 'Stranger');
  const board = directory.createBoard('Robots', owner), path = `/parties/board-room/${board.id}`;
  directory.changeSharing(board.id, owner.email, { member: { email: guest.email, role: 'view' } });
  const forged = { Upgrade: 'websocket', Origin: 'http://localhost:8787', 'X-Concept-Graph-Role': 'owner', 'X-Concept-Graph-Email': owner.email, 'X-Partykit-Props': '{"role":"owner"}' };
  const denied = await request(path, { cookie: stranger.cookie, headers: forged });
  assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'You don’t have access to this board.' });
  assert.equal((await request(`/parties/board-room/${crypto.randomUUID()}`, { cookie: guest.cookie, headers: forged })).status, 404);
  assert.equal(routed.length, 0);
  assert.equal(await (await request(path, { cookie: guest.cookie, headers: forged })).text(), 'routed');
  assert.equal(await (await request(path, { cookie: owner.cookie, headers: { Upgrade: 'websocket' } })).text(), 'routed');
  assert.deepEqual(routed.map(item => [item.headers.get('x-concept-graph-role'), item.headers.get('x-concept-graph-email'), item.headers.get('x-partykit-props'), item.headers.get('x-partykit-namespace')]),
    [['view', guest.email, null, 'board-room'], ['owner', owner.email, null, 'board-room']]);
  directory.changeSharing(board.id, owner.email, { member: { email: guest.email, role: null } });
  assert.equal((await request(path, { cookie: guest.cookie, headers: forged })).status, 403);
});

runtimeTest('the room ignores a viewer’s document updates but keeps their presence, and re-checks access on demand', async t => {
  const members = [['viewer@mail.example', 'view'], ['editor@mail.example', 'edit']];
  const boardRoom = room(t, { roomAccess: async () => ({ owner: 'owner@studio.example', access: 'private', linkRole: 'view', members }) });
  const remote = new Y.Doc(); t.after(() => remote.destroy());
  remote.getMap('nodes').set('n', 'from the client');
  const update = syncMessage(encoder => syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(remote))), step2 = syncMessage(encoder => syncProtocol.writeSyncStep2(encoder, remote));
  const connect = (role, email) => {
    const socket = connection();
    boardRoom.onConnect(socket, { request: new Request('http://localhost/parties/board-room/board-1', { headers: { ...(role ? { 'x-concept-graph-role': role } : {}), ...(email ? { 'x-concept-graph-email': email } : {}) } }) });
    return socket;
  };
  const viewer = connect('view', 'viewer@mail.example'), unknown = connect('admin', 'odd@mail.example'), missing = connect();
  assert.deepEqual([viewer.state, unknown.state, missing.state], [{ role: 'view', email: 'viewer@mail.example' }, { role: 'view', email: 'odd@mail.example' }, { role: 'view', email: null }]);
  assert.equal(viewer.sent.at(-1), access('view'));
  for (const socket of [viewer, unknown, missing]) { boardRoom.handleMessage(socket, update); boardRoom.handleMessage(socket, step2); }
  assert.equal(boardRoom.document.getMap('nodes').size, 0);
  // A viewer still receives the board and shares their cursor.
  boardRoom.handleMessage(viewer, syncMessage(encoder => syncProtocol.writeSyncStep1(encoder, remote)));
  assert.equal(viewer.sent.at(-1)[0], 0);
  const presence = new awarenessProtocol.Awareness(remote); t.after(() => presence.destroy());
  presence.setLocalState({ user: { name: 'Viewer' }, cursor: { x: 1, y: 2 } });
  const awareness = encoding.createEncoder(); encoding.writeVarUint(awareness, 1); encoding.writeVarUint8Array(awareness, awarenessProtocol.encodeAwarenessUpdate(presence, [remote.clientID]));
  boardRoom.getConnections = () => [];
  boardRoom.handleMessage(viewer, encoding.toUint8Array(awareness));
  assert.deepEqual(boardRoom.document.awareness.getStates().get(remote.clientID).cursor, { x: 1, y: 2 });
  const editor = connect('edit', 'editor@mail.example');
  boardRoom.handleMessage(editor, update);
  assert.equal(boardRoom.document.getMap('nodes').get('n'), 'from the client');
  // After a sharing change: the owner is untouched, a downgraded editor becomes read-only, removed people are disconnected.
  const owner = connect('owner', 'owner@studio.example'), promoted = connect('view', 'editor@mail.example');
  members[1] = ['editor@mail.example', 'view']; members[0] = ['viewer@mail.example', 'edit'];
  boardRoom.getConnections = () => [owner, editor, viewer, promoted, unknown];
  const before = owner.sent.length;
  await boardRoom.refreshAccess();
  assert.equal(owner.sent.length, before);
  assert.deepEqual([editor.state.role, editor.sent.at(-1)], ['view', access('view')]);
  assert.deepEqual([viewer.state.role, viewer.sent.at(-1)], ['edit', access('edit')]);
  assert.equal(promoted.closed, null);
  assert.deepEqual([unknown.closed, unknown.sent.at(-1)], [[4403, 'Access removed'], access(null)]);
  remote.getMap('nodes').set('m', 'after the downgrade');
  boardRoom.handleMessage(editor, syncMessage(encoder => syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(remote))));
  assert.equal(boardRoom.document.getMap('nodes').has('m'), false);
});

runtimeTest('a board made before per-board custom nodes copies the old library into its document once', async t => {
  let calls = 0;
  const values = new Map(), directory = { libraryFor: async () => { calls++; return [...library, { id: 'broken', name: '' }]; } };
  const first = room(t, directory, values);
  await first.onStart();
  assert.equal(calls, 1);
  assert.deepEqual(readBoardTemplates(first.document), library);
  assert.equal(libraryCopied(first.document), true);
  values.set('doc:count', 1); values.set('doc:0', Y.encodeStateAsUpdate(first.document));
  const reopened = room(t, directory, values);
  await reopened.onStart();
  assert.equal(calls, 1);
  assert.deepEqual(readBoardTemplates(reopened.document), library);
  // A failed copy is retried at the next start instead of blocking the board.
  const log = t.mock.method(console, 'error', () => {});
  const failing = room(t, { libraryFor: async () => { throw new Error('Directory unavailable'); } });
  await failing.onStart();
  assert.equal(libraryCopied(failing.document), false);
  assert.equal(log.mock.callCount(), 1);
});

test('board custom nodes are plain values in the document: create, edit, delete and skip invalid entries', () => {
  const doc = new Y.Doc(), other = new Y.Doc();
  try {
    const created = saveBoardTemplate(doc, { name: ' Character sheet ', instructions: 'Front, side, back', assets: [], labelOutputs: true }, null, 'test');
    assert.match(created.id, /^[\da-f-]{36}$/); assert.ok(Date.parse(created.createdAt));
    assert.deepEqual(created, { id: created.id, name: 'Character sheet', instructions: 'Front, side, back', assets: [], labelOutputs: true, color: templatePalette[0], createdAt: created.createdAt });
    const second = saveBoardTemplate(doc, { name: 'Moodboard', instructions: '', assets: [] }, null, 'test');
    assert.equal(second.color, templatePalette[1]);
    const edited = saveBoardTemplate(doc, { name: 'Turnaround', instructions: 'Four views', assets: [], color: templatePalette[5] }, created, 'test');
    assert.deepEqual(edited, { id: created.id, name: 'Turnaround', instructions: 'Four views', assets: [], color: templatePalette[5], createdAt: created.createdAt });
    assert.throws(() => saveBoardTemplate(doc, { name: '', instructions: '', assets: [] }, null, 'test'), /Invalid custom node template/);
    doc.getMap('templates').set('junk', { name: 42 });
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const byId = (a, b) => a.id.localeCompare(b.id);
    assert.deepEqual(readBoardTemplates(other).sort(byId), [edited, second].sort(byId));
    deleteBoardTemplate(doc, second.id, 'test');
    assert.deepEqual(readBoardTemplates(doc).map(item => item.id), [created.id]);
    for (let i = 0; i < 499; i++) doc.getMap('templates').set(`t${i}`, { name: `T${i}`, instructions: '', assets: [], createdAt: '' });
    assert.throws(() => saveBoardTemplate(doc, { name: 'One more', instructions: '', assets: [] }, null, 'test'), /at most 500 custom nodes/);
    assert.equal(copyLibrary(doc, library, 'test'), true);
    assert.equal(copyLibrary(doc, [{ ...library[0], name: 'Changed later' }], 'test'), false);
    assert.equal(readBoardTemplates(doc).find(item => item.id === library[0].id).name, 'Views');
  } finally { doc.destroy(); other.destroy(); }
});
