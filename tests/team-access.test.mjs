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
});
