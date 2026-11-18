import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { signSession } from '../cloud/auth.mjs';

// Only the Cloudflare base classes are replaced; routing and SQL run for real.
let DatabaseSync, worker, Directory;
if (nodeModule.registerHooks) {
  ({ DatabaseSync } = await import('node:sqlite'));
  const hooks = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== 'cloudflare:workers') return nextResolve(specifier, context);
      return { url: 'data:text/javascript,' + encodeURIComponent('export const env = {}; export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), shortCircuit: true };
    }
  });
  try { ({ default: worker, Directory } = await import('../cloud/worker.mjs')); }
  finally { hooks.deregister(); }
}
const runtimeTest = nodeModule.registerHooks ? test : test.skip;

function setup(t, settings = {}) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql = { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  const users = [{ email: 'new@studio.example', name: 'Newcomer', last_login_at: '2026-11-05T09:00:00.000Z' }, { email: 'admin@studio.example', name: 'Admin', last_login_at: '2026-11-04T09:00:00.000Z' }];
  const env = {
    SESSION_SECRET: 'session-test', GEMINI_API_KEY: 'test-key', SITE_OWNER_EMAIL: 'Owner@Studio.example', NANO_BANANA_ALLOWED: ' Solo@Mail.example, @team.example;plain.example bad@ ', ...settings,
    DB: { prepare: query => ({ bind() { return this; }, async run() {}, async all() { if (!/FROM users/.test(query)) throw new Error('unexpected'); return { results: users }; } }) },
    Directory: { idFromName: name => name, get: () => directory }, ASSETS: { fetch: async () => new Response('static') },
  };
  const directory = new Directory({ storage: { sql } }, env);
  const as = async address => `cg_session=${await signSession({ name: address.split('@')[0], email: address }, 'session-test')}`;
  const request = async (path, { method = 'GET', email, data, origin } = {}) => worker.fetch(new Request(`http://localhost:8787${path}`, { method,
    headers: { Cookie: await as(email), ...(origin ? { Origin: origin } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), env, { waitUntil() {} });
  return { env, sql, directory, request };
}

runtimeTest('the old allowed list is copied in once, and the directory alone decides who may use Nano Banana', t => {
  const { env, sql, directory } = setup(t);
  assert.deepEqual(directory.nanoEntries().map(row => row.entry), ['@plain.example', '@team.example', 'solo@mail.example']);
  for (const [address, allowed] of [['solo@mail.example', true], ['x@team.example', true], ['x@plain.example', true], ['x@sub.team.example', false], ['other@mail.example', false]]) assert.equal(directory.nanoAllowed(address), allowed, address);
  // Later changes to the variable are not read again: admins keep the list on the site.
  env.NANO_BANANA_ALLOWED = 'late@mail.example';
  const reopened = new Directory({ storage: { sql } }, env);
  assert.equal(reopened.nanoAllowed('late@mail.example'), false);
  assert.equal(reopened.siteRole('OWNER@studio.example'), 'owner'); assert.equal(reopened.siteRole('someone@studio.example'), null);
});

runtimeTest('the owner appoints admins, admins grant and revoke Nano Banana, and nobody else sees or changes it', async t => {
  const { request } = setup(t);
  assert.equal((await (await request('/api/cloud/me', { email: 'owner@studio.example' })).json()).siteRole, 'owner');
  assert.equal((await (await request('/api/cloud/me', { email: 'new@studio.example' })).json()).siteRole, null);
  assert.equal((await request('/api/cloud/team', { email: 'new@studio.example' })).status, 403);
  assert.equal((await request('/api/cloud/team', { method: 'PATCH', email: 'new@studio.example', data: { nano: { entry: 'new@studio.example', allowed: true } } })).status, 403);

  const seen = (await (await request('/api/cloud/team', { email: 'owner@studio.example' })).json()).access;
  assert.equal(seen.role, 'owner'); assert.equal(seen.owner, 'owner@studio.example'); assert.deepEqual(seen.people.map(person => person.email), ['new@studio.example', 'admin@studio.example']);
  assert.equal(seen.imported.entries, 3);
  assert.equal((await request('/api/cloud/team', { method: 'PATCH', email: 'owner@studio.example', origin: 'https://evil.example', data: { admin: { email: 'admin@studio.example', admin: true } } })).status, 403);
  const appointed = await request('/api/cloud/team', { method: 'PATCH', email: 'owner@studio.example', data: { admin: { email: 'Admin@Studio.example', admin: true } } });
  assert.deepEqual((await appointed.json()).access.admins.map(item => item.email), ['admin@studio.example']);

  // The new teammate has no access until an admin gives it; then Generate's status says so.
  assert.equal((await (await request('/api/nano', { email: 'new@studio.example' })).json()).allowed, false);
  const granted = await (await request('/api/cloud/team', { method: 'PATCH', email: 'admin@studio.example', data: { nano: { entry: ' New@Studio.example ', allowed: true } } })).json();
  assert.equal(granted.access.role, 'admin'); assert.equal(granted.access.nano.find(item => item.entry === 'new@studio.example').addedBy, 'admin@studio.example');
  assert.equal((await (await request('/api/nano', { email: 'new@studio.example' })).json()).allowed, true);
  await request('/api/cloud/team', { method: 'PATCH', email: 'admin@studio.example', data: { nano: { entry: 'new@studio.example', allowed: false } } });
  assert.equal((await (await request('/api/nano', { email: 'new@studio.example' })).json()).allowed, false);
  // A domain gives everyone at that address access; an invalid entry is refused.
  await request('/api/cloud/team', { method: 'PATCH', email: 'admin@studio.example', data: { nano: { entry: '@Studio.example', allowed: true } } });
  assert.equal((await (await request('/api/nano', { email: 'new@studio.example' })).json()).allowed, true);
  for (const entry of ['not an email', '@', '@localhost', 'a@b@c', '']) assert.equal((await request('/api/cloud/team', { method: 'PATCH', email: 'admin@studio.example', data: { nano: { entry, allowed: true } } })).status, 400, entry);

  // Admins cannot appoint admins, and the owner cannot be made or unmade one.
  assert.equal((await request('/api/cloud/team', { method: 'PATCH', email: 'admin@studio.example', data: { admin: { email: 'new@studio.example', admin: true } } })).status, 403);
  assert.equal((await request('/api/cloud/team', { method: 'PATCH', email: 'owner@studio.example', data: { admin: { email: 'owner@studio.example', admin: false } } })).status, 400);
  await request('/api/cloud/team', { method: 'PATCH', email: 'owner@studio.example', data: { admin: { email: 'admin@studio.example', admin: false } } });
  assert.equal((await request('/api/cloud/team', { email: 'admin@studio.example' })).status, 403);
});

runtimeTest('without a site owner nobody manages access, and the copied list still applies', async t => {
  const { request, directory } = setup(t, { SITE_OWNER_EMAIL: undefined });
  assert.equal((await request('/api/cloud/team', { email: 'owner@studio.example' })).status, 403);
  assert.equal(directory.nanoAllowed('solo@mail.example'), true);
  assert.deepEqual(directory.model3dEntries(), []);
});

runtimeTest('3D seeds only the owner once, and revocation survives restarts and owner changes', t => {
  const { env, sql, directory } = setup(t);
  assert.deepEqual(directory.model3dEntries().map(row => row.email), ['owner@studio.example']);
  assert.equal(directory.model3dAllowed(' OWNER@Studio.example '), true);
  for (const address of ['solo@mail.example', 'x@team.example', '@team.example', null]) assert.equal(directory.model3dAllowed(address), false);
  directory.changeTeamAccess('owner@studio.example', { model3d: { email: 'owner@studio.example', allowed: false } });
  assert.equal(new Directory({ storage: { sql } }, env).model3dAllowed('owner@studio.example'), false);
  env.SITE_OWNER_EMAIL = 'replacement@studio.example';
  assert.deepEqual(new Directory({ storage: { sql } }, env).model3dEntries(), []);
});

runtimeTest('admins manage per-person 3D separately from image access, including people who have not signed in', async t => {
  const { request, directory } = setup(t, { FAL_KEY: 'test-fal' });
  const patch = (email, model3d) => request('/api/cloud/team', { method: 'PATCH', email, data: { model3d } });
  assert.equal((await patch('new@studio.example', { email: 'new@studio.example', allowed: true })).status, 403);
  assert.equal(directory.model3dAllowed('new@studio.example'), false);
  await request('/api/cloud/team', { method: 'PATCH', email: 'owner@studio.example', data: { admin: { email: 'admin@studio.example', admin: true } } });
  assert.equal(directory.model3dAllowed('admin@studio.example'), false, 'admin status grants no 3D');
  const granted = await (await patch('admin@studio.example', { email: ' Waiting@Studio.example ', allowed: true })).json();
  const entry = granted.access.model3d.find(item => item.email === 'waiting@studio.example');
  assert.equal(entry.addedBy, 'admin@studio.example'); assert.ok(entry.addedAt);
  assert.equal(directory.model3dAllowed('waiting@studio.example'), true); assert.equal(directory.nanoAllowed('waiting@studio.example'), false);
  assert.deepEqual((await (await request('/api/nano', { email: 'solo@mail.example' })).json()).model3d, { configured: true, allowed: false });
  const status = await (await request('/api/nano', { email: 'waiting@studio.example' })).json();
  assert.equal(status.allowed, false); assert.equal(status.model3d.allowed, true); assert.equal(status.model3d.dailyImages, 300);
  await patch('admin@studio.example', { email: 'waiting@studio.example', allowed: false });
  assert.equal((await (await request('/api/nano', { email: 'waiting@studio.example' })).json()).model3d.allowed, false);
  for (const email of ['@studio.example', 'studio.example', 'not an email', 'a@b@c', '', null]) assert.equal((await patch('admin@studio.example', { email, allowed: true })).status, 400, String(email));
  for (const allowed of [undefined, 'true', 1]) assert.equal((await patch('admin@studio.example', { email: 'valid@example.com', allowed })).status, 400);
  assert.equal((await patch('owner@studio.example', null)).status, 400);
});

runtimeTest('3D access stays bounded and existing grants remain idempotent at the limit', async t => {
  const { directory, sql, request } = setup(t);
  for (let i = 0; i < 999; i++) sql.exec('INSERT INTO model3d_access (email, addedAt) VALUES (?, ?)', `person${i}@example.com`, '2026-11-14');
  const change = (email, allowed) => directory.changeTeamAccess('owner@studio.example', { model3d: { email, allowed } });
  assert.equal(change('overflow@example.com', true).status, 400);
  assert.ok(change('owner@studio.example', true).access);
  assert.ok(change('person0@example.com', false).access); assert.ok(change('overflow@example.com', true).access);
  const status = await (await request('/api/nano', { email: 'owner@studio.example' })).json();
  assert.deepEqual(status.model3d, { configured: false, allowed: true });
});

runtimeTest('when the sign-in list cannot be read, Team access says so instead of listing nobody as signed in', async t => {
  const { env, request } = setup(t);
  env.DB = { prepare: () => ({ bind() { return this; }, async run() {}, async all() { throw new Error('D1_ERROR: daily row read limit'); } }) };
  const errors = t.mock.method(console, 'error', () => {});
  const seen = (await (await request('/api/cloud/team', { email: 'owner@studio.example' })).json()).access;
  assert.equal(seen.people, null); assert.equal(seen.role, 'owner'); assert.equal(errors.mock.callCount(), 1);
});


runtimeTest('Video seeds only the owner once and admins grant/revoke it independently of images and 3D', async t => {
  const { directory, sql, env, request } = setup(t, { FAL_KEY: 'test-fal' });
  assert.equal(directory.videoAllowed('owner@studio.example'), true); assert.equal(directory.videoAllowed('solo@mail.example'), false);
  assert.equal(directory.changeTeamAccess('solo@mail.example', { video: { email: 'solo@mail.example', allowed: true } }).status, 403);
  for (const address of ['@studio.example', 'not-an-email', null]) assert.equal(directory.changeTeamAccess('owner@studio.example', { video: { email: address, allowed: true } }).status, 400);
  directory.changeTeamAccess('owner@studio.example', { admin: { email: 'admin@studio.example', admin: true } });
  const granted = directory.changeTeamAccess('admin@studio.example', { video: { email: 'Video@Studio.example', allowed: true } });
  assert.ok(granted.access.video.some(person => person.email === 'video@studio.example')); assert.equal(directory.nanoAllowed('video@studio.example'), false); assert.equal(directory.model3dAllowed('video@studio.example'), false);
  const status = await (await request('/api/nano', { email: 'video@studio.example' })).json(); assert.equal(status.video.allowed, true); assert.equal(status.video.dailyImages, 300);
  directory.changeTeamAccess('owner@studio.example', { video: { email: 'owner@studio.example', allowed: false } });
  const reopened = new Directory({ storage: { sql } }, env); assert.equal(reopened.videoAllowed('owner@studio.example'), false); assert.equal(reopened.videoAllowed('video@studio.example'), true);
  directory.changeTeamAccess('admin@studio.example', { video: { email: 'video@studio.example', allowed: false } }); assert.equal(directory.videoAllowed('video@studio.example'), false);
});

runtimeTest('only the owner sees spending: each person by month and by what they made, refunds and stale holds counted as the budget counts them', async t => {
  const { sql, directory, request } = setup(t);
  const now = Date.parse('2026-11-18T10:00:00.000Z'), limits = { dailyImages: 300, monthlyUsd: 300 };
  // Usage recorded before kinds existed has none and is shown as earlier.
  sql.exec("INSERT INTO nano_usage (id, email, day, month, images, usd, open, createdAt) VALUES ('old', 'new@studio.example', '2026-11-02', '2026-11', 1, 0.04, 0, ?)", now - 16 * 86400000);
  sql.exec("INSERT INTO nano_usage (id, email, day, month, images, usd, open, createdAt) VALUES ('october', 'new@studio.example', '2026-10-30', '2026-10', 1, 1.5, 0, ?)", now - 19 * 86400000);
  const gpt = directory.reserveNanoMany('new@studio.example', { ...limits, estimates: [0.2, 0.2], kind: 'gpt' }, now);
  directory.settleNanoMany([{ id: gpt.reservations[0], images: 1, usd: 0.17 }, { id: gpt.reservations[1], images: 0, usd: 0 }]);
  directory.settleNano(directory.reserveNano('admin@studio.example', { ...limits, estimateUsd: 2.4, kind: 'video' }, now).reservation, { images: 1, usd: 2.25 });
  directory.reserveNano('admin@studio.example', { ...limits, estimateUsd: 0.01, images: 0, kind: 'describe' }, now);
  directory.reserveNano('admin@studio.example', { ...limits, estimateUsd: 0.3, kind: 'not-a-kind' }, now - 20 * 60000);

  const seen = directory.spending('Owner@Studio.example', undefined, now);
  assert.equal(seen.month, '2026-11'); assert.deepEqual(seen.months, ['2026-11', '2026-10']);
  assert.deepEqual(seen.people.map(person => [person.email, Math.round(person.usd * 100) / 100, person.made, person.todayImages]), [['admin@studio.example', 2.56, 3, 1], ['new@studio.example', 0.21, 2, 1]]);
  assert.deepEqual(seen.people[0].kinds.map(item => [item.kind, item.made]), [['video', 1], ['earlier', 1], ['describe', 1]]);
  assert.deepEqual(seen.people[1].kinds.map(item => [item.kind, item.made]), [['gpt', 1], ['earlier', 1]]);
  // Chips count what came out (the refunded GPT call made nothing); the lump of earlier calls is dated from the first recorded kind.
  assert.deepEqual(seen.people[0].kinds.map(item => [item.kind, item.outputs]), [['video', 1], ['earlier', 0], ['describe', 0]]);
  assert.equal(seen.people[1].kinds[0].outputs, 1); assert.equal(seen.splitSince, '2026-11-18');
  assert.equal(Math.round(seen.team.usd * 100) / 100, Math.round(directory.nanoUsage('new@studio.example', now).teamSpentUsd * 100) / 100);
  assert.deepEqual(directory.spending('owner@studio.example', '2026-10', now).people.map(person => person.usd), [1.5]);
  assert.equal(directory.spending('owner@studio.example', '2027-01', now).month, '2026-11');
  assert.equal(directory.spending('owner@studio.example', 'nonsense', now).month, '2026-11');

  await request('/api/cloud/team', { method: 'PATCH', email: 'owner@studio.example', data: { admin: { email: 'admin@studio.example', admin: true } } });
  assert.equal(directory.spending('admin@studio.example', undefined, now), null);
  assert.equal((await request('/api/cloud/spending', { email: 'admin@studio.example' })).status, 403);
  assert.equal((await request('/api/cloud/spending', { email: 'new@studio.example' })).status, 403);
  const shown = await request('/api/cloud/spending?month=2026-10', { email: 'owner@studio.example' });
  assert.equal(shown.status, 200);
  const body = (await shown.json()).spending;
  assert.equal(body.month, '2026-10'); assert.equal(body.dailyImages, 300); assert.equal(body.people[0].name, 'Newcomer');
});

runtimeTest('only the site owner sees who is online and where, boards, generations and spending per person', async t => {
  const { sql, directory, request } = setup(t);
  const board = directory.createBoard('Moodboard', { email: 'new@studio.example', name: 'Newcomer' });
  directory.createBoard('Second', { email: 'new@studio.example', name: 'Newcomer' });
  sql.exec("INSERT INTO board_people (board, email, role) VALUES (?, 'admin@studio.example', 'edit')", board.id);
  directory.settleNano(directory.reserveNano('new@studio.example', { dailyImages: 300, monthlyUsd: 300, estimateUsd: 0.05, kind: 'nano' }).reservation, { images: 1, usd: 0.04 });
  directory.agentSeen('new@studio.example', Date.now() - 60000);

  // Polls mark presence: the boards list (online, no board) and a board's generator status (online on that board).
  assert.equal((await request('/api/cloud/boards', { email: 'admin@studio.example' })).status, 200);
  assert.equal((await request(`/api/nano?board=${board.id}`, { email: 'new@studio.example' })).status, 200);
  // The boards list open in another tab does not hide the board this person still has open.
  await request('/api/cloud/boards', { email: 'new@studio.example' });
  const panel = directory.adminPeople('owner@studio.example', [{ email: 'new@studio.example', name: 'Newcomer', joinedAt: '2026-11-01T09:00:00.000Z', lastLoginAt: '2026-11-05T09:00:00.000Z' }, { email: 'quiet@studio.example', name: 'Quiet' }]);
  const person = address => panel.people.find(item => item.email === address);
  assert.equal(panel.boards, 2);
  assert.deepEqual(person('new@studio.example').online, { board: { id: board.id, name: 'Moodboard' } });
  assert.deepEqual(person('admin@studio.example').online, { board: null });
  assert.equal(person('quiet@studio.example').online, null); assert.equal(person('quiet@studio.example').lastSeen, null);
  assert.deepEqual([person('new@studio.example').ownBoards, person('new@studio.example').sharedBoards, person('admin@studio.example').sharedBoards], [2, 0, 1]);
  assert.deepEqual([person('new@studio.example').todayMade, person('new@studio.example').monthMade, person('new@studio.example').monthUsd], [1, 1, 0.04]);
  assert.ok(person('new@studio.example').agentSeen); assert.equal(person('new@studio.example').joinedAt, '2026-11-01T09:00:00.000Z');
  // The owner is listed even before they do anything; online people come first.
  assert.equal(person('owner@studio.example').role, 'owner');
  assert.deepEqual(panel.people.slice(0, 2).map(item => Boolean(item.online)), [true, true]);
  // Three minutes without a poll: no longer online, but the last visit is kept, also after a restart (memory is lost).
  const later = directory.adminPeople('owner@studio.example', [], Date.now() + 180000);
  assert.equal(later.people.find(item => item.email === 'new@studio.example').online, null);
  const { Directory: Restarted } = { Directory: directory.constructor }, restarted = new Restarted(directory.ctx, directory.env);
  assert.ok(restarted.adminPeople('owner@studio.example').people.find(item => item.email === 'new@studio.example').lastSeen);

  // Site admins and everyone else are refused; the page itself is the app.
  await request('/api/cloud/team', { method: 'PATCH', email: 'owner@studio.example', data: { admin: { email: 'admin@studio.example', admin: true } } });
  assert.equal(directory.adminPeople('admin@studio.example'), null);
  assert.equal((await request('/api/cloud/admin', { email: 'admin@studio.example' })).status, 403);
  assert.equal((await request('/api/cloud/admin', { email: 'new@studio.example' })).status, 403);
  const shown = await request('/api/cloud/admin', { email: 'owner@studio.example' });
  assert.equal(shown.status, 200);
  const body = (await shown.json()).admin;
  assert.equal(body.signIns, true);
  assert.equal(body.people.find(item => item.email === 'new@studio.example').name, 'Newcomer');
  assert.equal(await (await request('/admin', { email: 'new@studio.example' })).text(), 'static');
});
