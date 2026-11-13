import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFile } from 'node:fs/promises';
import { SESSION_MAX_AGE, sessionIdentity, signSession } from '../cloud/auth.mjs';
import { collectInputs, templatePalette } from '../graph.mjs';

// Only the Cloudflare base class is replaced; routing, Yjs and SQL run for real.
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

function setup(t) {
  const database = new DatabaseSync(':memory:');
  const usersDatabase = new DatabaseSync(':memory:');
  t.after(() => { database.close(); usersDatabase.close(); });
  const sql = { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  const directory = new Directory({ storage: { sql } }, {}), files = new Map(), routed = [];
  const env = {
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'google-test-secret', SESSION_SECRET: 'session-test',
    DB: {
      prepare(query) {
        const statement = usersDatabase.prepare(query);
        let bindings = [];
        return {
          bind(...values) { bindings = values; return this; },
          async run() { return statement.run(...bindings); }
        };
      }
    },
    Directory: { idFromName: name => name, get: () => directory },
    BoardRoom: { idFromName: name => name, get: () => ({ fetch: async request => { routed.push(request); return new Response('routed'); } }) },
    FILES: {
      async put(key, bytes, metadata) { files.set(key, { body: bytes.slice(), size: bytes.length, httpEtag: '"test-etag"', ...metadata }); },
      async get(key) { return files.get(key) || null; },
      async head(key) { return files.get(key) || null; }
    },
    ASSETS: { fetch: async () => new Response('static') }
  };
  const request = (path, { method = 'GET', cookie, data, headers = {}, bytes, origin = 'http://localhost:8787' } = {}) => worker.fetch(new Request(`${origin}${path}`, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(data !== undefined ? { body: JSON.stringify(data) } : bytes ? { body: bytes } : {})
  }), env);
  return { env, request, directory, files, routed, usersDatabase };
}

test('cloud config binds the user database and routes privacy through the Worker', async () => {
  const config = JSON.parse(await readFile(new URL('../cloud/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.d1_databases, [{ binding: 'DB', database_name: 'concept-graph-cloud', database_id: 'cb8f2e9c-34aa-4861-883e-498832370baf' }]);
  assert.ok(config.assets.run_worker_first.includes('/privacy'));
});

runtimeTest('privacy is public without cookies, Google configuration, D1 or static assets', async t => {
  const { request, env } = setup(t);
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'DB', 'ASSETS']) delete env[key];
  const response = await request('/privacy', { origin: 'https://cloud.example' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.has('Set-Cookie'), false);
  const html = await response.text();
  for (const text of ['<html lang="en">', 'Privacy Policy', 'Google account ID', 'Cloudflare', 'OpenAI', 'Codex/ChatGPT', 'private to the person who created it', 'email addresses and roles of the people invited', 'sign-in count', "Google's Gemini API for Nano Banana", "OpenAI's Images API for GPT Image under the site owner's accounts", 'shared daily and monthly limits', 'mailto:knifest17@gmail.com']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script|<link|<iframe|<img/i);
  const head = await request('/privacy', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await request('/privacy', { method: 'POST' })).status, 405);
});

runtimeTest('HTTP login, me, logout and protected routes enforce cookie sessions', async t => {
  const { request, env } = setup(t);
  for (const path of ['/api/cloud/me', '/api/cloud/boards', '/api/templates', '/api/assets', '/assets/no.png', '/downloads/Concept-Graph-Helper-macos-arm64.dmg', '/parties/board-room/missing', '/api/unknown']) {
    const response = await request(path);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Sign in required.' });
  }
  assert.equal(await (await request('/')).text(), 'static');
  assert.deepEqual(await (await request('/api/auth/config')).json(), { devLogin: false });
  assert.equal((await request('/api/auth/dev', { method: 'POST', data: {} })).status, 404);
  env.DEV_LOGIN = '1';
  assert.deepEqual(await (await request('/api/auth/config')).json(), { devLogin: true });
  assert.equal((await request('/api/auth/dev', { method: 'POST', data: { email: 'artist@example.com', name: ' ' } })).status, 400);
  assert.equal((await request('/api/auth/dev', { method: 'POST', data: { email: 'bad', name: 'Artist' } })).status, 400);
  assert.equal((await request('/api/auth/dev', { method: 'POST', bytes: '{broken' })).status, 400);
  const login = await request('/api/auth/dev', { method: 'POST', data: { email: ' Artist@Example.COM ', name: ' Artist ' } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('Set-Cookie'), /HttpOnly; SameSite=Lax; Path=\//);
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  assert.deepEqual(await login.json(), { user: sessionIdentity({ name: 'Artist', email: 'artist@example.com' }), siteRole: null });
  assert.deepEqual(await (await request('/api/cloud/me', { cookie })).json(), { user: sessionIdentity({ name: 'Artist', email: 'artist@example.com' }), siteRole: null });
  assert.equal((await request('/api/cloud/login', { method: 'POST', cookie, data: { code: 'old', name: 'Artist' } })).status, 404);
  const logout = await request('/api/cloud/logout', { method: 'POST', cookie });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('Set-Cookie'), /cg_session=;.*Max-Age=0/);
  assert.equal((await request('/api/cloud/me', { cookie: logout.headers.get('Set-Cookie').split(';')[0] })).status, 401);
});

async function beginGoogle(request, origin = 'http://localhost:8787') {
  const response = await request('/api/auth/google', { origin });
  assert.equal(response.status, 302);
  const target = new URL(response.headers.get('Location'));
  const cookie = response.headers.get('Set-Cookie').split(';')[0];
  const state = JSON.parse(Buffer.from(cookie.slice('cg_google='.length).split('.')[0], 'base64url').toString());
  return { response, target, cookie, state };
}

function googleToken(state, changes = {}, header = { alg: 'RS256' }) {
  const claims = {
    iss: 'https://accounts.google.com', aud: 'test-client.apps.googleusercontent.com', sub: 'google-user-123',
    exp: Math.floor(Date.now() / 1000) + 3600, nonce: state.nonce,
    email: ' Artist@Example.COM ', email_verified: true, name: '  Художник 🎨  ', ...changes
  };
  return [header, claims, 'test-signature'].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
}

const callbackPath = state => `/api/auth/google/callback?state=${state.state}&code=test-code`;

runtimeTest('Google sign-in lazily records users and repeat sign-in preserves creation time and increments count', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 3) });
  const { request, usersDatabase } = setup(t);
  const rows = () => usersDatabase.prepare('SELECT * FROM users ORDER BY email').all().map(row => ({ ...row }));
  assert.equal(usersDatabase.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get(), undefined);
  let state, claims = {};
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id_token: googleToken(state, claims) }));
  const login = async () => {
    const next = await beginGoogle(request); state = next.state;
    const response = await request(callbackPath(state), { cookie: next.cookie });
    assert.equal(response.headers.get('Location'), '/');
    assert.ok(response.headers.getSetCookie().some(cookie => cookie.startsWith('cg_session=')));
  };
  await login();
  const created = '2026-11-03T00:00:00.000Z';
  assert.deepEqual(rows(), [{ email: 'artist@example.com', google_sub: 'google-user-123', name: 'Художник 🎨', created_at: created, last_login_at: created, login_count: 1 }]);
  t.mock.timers.tick(60000);
  claims = { email: 'ARTIST@example.com', name: "Artist's new name" };
  await login();
  assert.deepEqual(rows(), [{ email: 'artist@example.com', google_sub: 'google-user-123', name: "Artist's new name", created_at: created, last_login_at: '2026-11-03T00:01:00.000Z', login_count: 2 }]);
  claims = { email: 'another@example.com', sub: 'google-user-456', name: 'Another person' };
  await login();
  assert.equal(rows().length, 2);
  assert.equal(rows()[0].google_sub, 'google-user-456');
  assert.equal(rows()[0].login_count, 1);
});

runtimeTest('local dev sign-in records normalized users, counts repeat logins and preserves an existing Google ID', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 3) });
  const { request, env, usersDatabase } = setup(t);
  env.DEV_LOGIN = '1';
  const data = { name: ' Developer ', email: ' DEV@Example.COM ' };
  assert.equal((await request('/api/auth/dev', { method: 'POST', data })).status, 200);
  const created = '2026-11-03T00:00:00.000Z';
  assert.deepEqual({ ...usersDatabase.prepare('SELECT * FROM users').get() }, { email: 'dev@example.com', google_sub: null, name: 'Developer', created_at: created, last_login_at: created, login_count: 1 });
  usersDatabase.prepare('UPDATE users SET google_sub = ? WHERE email = ?').run('existing-google-id', 'dev@example.com');
  t.mock.timers.tick(60000);
  assert.equal((await request('/api/auth/dev', { method: 'POST', data: { ...data, name: 'Renamed developer' } })).status, 200);
  assert.deepEqual({ ...usersDatabase.prepare('SELECT * FROM users').get() }, { email: 'dev@example.com', google_sub: 'existing-google-id', name: 'Renamed developer', created_at: created, last_login_at: '2026-11-03T00:01:00.000Z', login_count: 2 });
});

runtimeTest('D1 create and upsert failures or a missing binding are logged without blocking Google or dev sessions', async t => {
  const { request, env } = setup(t), database = env.DB;
  env.DEV_LOGIN = '1';
  let state;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id_token: googleToken(state) }));
  const log = t.mock.method(console, 'error', () => {});
  for (const phase of ['CREATE', 'INSERT', 'missing']) {
    env.DB = phase === 'missing' ? undefined : {
      prepare(query) {
        if (!query.startsWith(phase)) return database.prepare(query);
        return { bind() { return this; }, async run() { throw new Error('D1 unavailable'); } };
      }
    };
    const next = await beginGoogle(request); state = next.state;
    const google = await request(callbackPath(state), { cookie: next.cookie });
    assert.equal(google.headers.get('Location'), '/');
    const local = await request('/api/auth/dev', { method: 'POST', data: { name: 'Developer', email: 'dev@example.com' } });
    assert.equal(local.status, 200);
    for (const response of [google, local]) {
      const cookie = response.headers.getSetCookie().find(cookie => cookie.startsWith('cg_session=')).split(';')[0];
      assert.equal((await request('/api/cloud/me', { cookie })).status, 200);
    }
  }
  assert.equal(log.mock.callCount(), 6);
  assert.ok(log.mock.calls.every(call => call.arguments[0] === 'Failed to record user sign-in:'));
});

runtimeTest('Google sign-in binds random state, nonce and S256 PKCE to a ten-minute cookie', async t => {
  const { request, env } = setup(t);
  const first = await beginGoogle(request, 'https://cloud.example');
  const { target, state, response, cookie } = first;
  assert.equal(target.origin + target.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  for (const [key, value] of Object.entries({ client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: 'https://cloud.example/api/auth/google/callback', response_type: 'code', scope: 'openid email profile',
    prompt: 'select_account', state: state.state, nonce: state.nonce, code_challenge_method: 'S256' })) {
    assert.equal(target.searchParams.get(key), value);
  }
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state.verifier))).toString('base64url');
  assert.equal(target.searchParams.get('code_challenge'), challenge);
  assert.equal(target.searchParams.has('code_verifier'), false);
  assert.equal(target.searchParams.has('client_secret'), false);
  assert.match(response.headers.get('Set-Cookie'), /HttpOnly; SameSite=Lax; Path=\/api\/auth\/google; Max-Age=600; Secure$/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal((await request('/api/cloud/me', { cookie, origin: 'https://cloud.example' })).status, 401);
  const second = await beginGoogle(request);
  for (const key of ['state', 'nonce', 'verifier']) {
    assert.match(state[key], /^[\w-]{43}$/);
    assert.notEqual(state[key], second.state[key]);
  }
  for (const path of ['/api/auth/google', '/api/auth/google/callback', '/api/auth/config']) {
    assert.equal((await request(path, { method: 'POST' })).status, 405);
  }
});

runtimeTest('Google callback exchanges the code and PKCE verifier, creates a session and clears the temporary cookie', async t => {
  const { request, env } = setup(t), origin = 'https://cloud.example';
  const { cookie, state } = await beginGoogle(request, origin);
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(Object.fromEntries(options.body), { code: 'test-code', client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${origin}/api/auth/google/callback`,
      grant_type: 'authorization_code', code_verifier: state.verifier });
    return Response.json({ id_token: googleToken(state), access_token: 'discard-me' });
  });
  const response = await request(callbackPath(state), { cookie, origin });
  assert.equal(response.status, 302); assert.equal(response.headers.get('Location'), '/');
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /^cg_google=;.*Max-Age=0; Secure$/);
  assert.match(cookies[1], new RegExp(`^cg_session=.+; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}; Secure$`));
  const session = cookies[1].split(';')[0];
  assert.deepEqual(await (await request('/api/cloud/me', { cookie: session, origin })).json(), {
    user: sessionIdentity({ name: 'Художник 🎨', email: 'artist@example.com' }), siteRole: null
  });
  assert.equal((await request('/api/cloud/boards', { cookie: session, origin, method: 'POST', data: { name: 'Anyone can edit' } })).status, 201);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal((await request(callbackPath(state), { cookie: cookies[0].split(';')[0], origin })).headers.get('Location'), '/?auth_error=failed');
  assert.equal(fetch.mock.callCount(), 1);
});

runtimeTest('Google callback rejects missing, tampered, stale, future, cross-origin and mismatched state before exchange', async t => {
  const { request, env } = setup(t), { cookie, state } = await beginGoogle(request);
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Must not exchange.'); });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signedState = async changes => {
    const payload = Buffer.from(JSON.stringify({ ...state, ...changes })).toString('base64url');
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return `cg_google=${payload}.${Buffer.from(signature).toString('base64url')}`;
  };
  const time = Math.floor(Date.now() / 1000);
  const cases = [
    {}, { cookie: cookie + 'bad' }, { cookie: cookie.replace(/=./, '=!') },
    { cookie: await signedState({ iat: time - 600 }) }, { cookie: await signedState({ iat: time + 60 }) },
    { cookie: await signedState({ kind: 'session' }) }, { cookie: await signedState({ verifier: 'short' }) },
    { cookie, origin: 'http://127.0.0.1:8787' }
  ];
  for (const options of cases) {
    const response = await request(callbackPath(state), options);
    assert.equal(response.headers.get('Location'), '/?auth_error=failed');
    assert.equal(response.headers.getSetCookie().length, 1);
    assert.match(response.headers.get('Set-Cookie'), /^cg_google=;.*Max-Age=0/);
  }
  for (const suffix of ['?state=wrong&code=test', `?state=${state.state}`]) {
    assert.equal((await request('/api/auth/google/callback' + suffix, { cookie })).headers.get('Location'), '/?auth_error=failed');
  }
  const cancelled = await request(`/api/auth/google/callback?state=${state.state}&error=access_denied&error_description=private`, { cookie });
  assert.equal(cancelled.headers.get('Location'), '/?auth_error=cancelled');
  const providerError = await request(`/api/auth/google/callback?state=${state.state}&error=server_error`, { cookie });
  assert.equal(providerError.headers.get('Location'), '/?auth_error=failed');
  assert.equal(fetch.mock.callCount(), 0);
});

runtimeTest('Google callback fails closed for exchange errors, malformed tokens and invalid identity claims', async t => {
  const { request, usersDatabase } = setup(t), { cookie, state } = await beginGoogle(request);
  let result;
  t.mock.method(globalThis, 'fetch', async () => { if (result instanceof Error) throw result; return result; });
  const invalidClaims = [
    { iss: 'https://attacker.example' }, { aud: 'another-client' }, { aud: ['test-client.apps.googleusercontent.com'] },
    { azp: 'another-client' }, { exp: Math.floor(Date.now() / 1000) }, { exp: '9999999999' }, { exp: null },
    { nonce: 'wrong' }, { nonce: undefined }, { email_verified: false }, { email_verified: 'true' },
    { email: undefined }, { email: 'invalid' }, { sub: '' }, { sub: undefined }
  ];
  const responses = [new Error('network error'), new Response('private upstream error', { status: 400 }),
    new Response('not json'), Response.json({}), ...['bad', 'a.b.c', googleToken(state, {}, { alg: 'none' }),
      ...invalidClaims.map(claims => googleToken(state, claims))].map(id_token => Response.json({ id_token }))];
  for (const response of responses) {
    result = response;
    const failure = await request(callbackPath(state), { cookie });
    assert.equal(failure.status, 302); assert.equal(failure.headers.get('Location'), '/?auth_error=failed');
    assert.equal(failure.headers.getSetCookie().length, 1);
  }
  assert.equal(usersDatabase.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get(), undefined);
});

runtimeTest('Google profile names fall back to email and clamp to the existing limit', async t => {
  const { request } = setup(t), { cookie, state } = await beginGoogle(request);
  let claims;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ id_token: googleToken(state, claims) }));
  for (const [name, expected] of [[undefined, 'artist'], ['', 'artist'], ['  ', 'artist'], [42, 'artist'], ['x'.repeat(60), 'x'.repeat(40)]]) {
    claims = { name, email: 'artist@example.com', iss: 'accounts.google.com' };
    const response = await request(callbackPath(state), { cookie });
    assert.equal(response.headers.get('Location'), '/');
    const session = response.headers.getSetCookie()[1].split(';')[0];
    assert.equal((await (await request('/api/cloud/me', { cookie: session })).json()).user.name, expected);
  }
});

runtimeTest('Google configuration failures redirect safely and dev sign-in requires an explicit flag and loopback host', async t => {
  const { request, env } = setup(t), input = { name: 'Developer', email: 'developer@example.com' };
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET']) {
    const value = env[key]; delete env[key];
    for (const path of ['/api/auth/google', '/api/auth/google/callback']) {
      const response = await request(path);
      assert.equal(response.status, 302); assert.equal(response.headers.get('Location'), '/?auth_error=unavailable');
      assert.match(response.headers.get('Set-Cookie'), /cg_google=;.*Max-Age=0/);
    }
    env[key] = value;
  }
  for (const flag of [undefined, '', '0', 'true', 1]) {
    env.DEV_LOGIN = flag;
    assert.equal((await request('/api/auth/dev', { method: 'POST', data: input })).status, 404);
    assert.deepEqual(await (await request('/api/auth/config')).json(), { devLogin: false });
  }
  env.DEV_LOGIN = '1';
  for (const origin of ['https://cloud.example', 'http://localhost.attacker.example:8787', 'http://127.0.0.2:8787', 'http://[::1]:8787']) {
    assert.equal((await request('/api/auth/dev', { method: 'POST', data: input, origin })).status, 404);
    assert.deepEqual(await (await request('/api/auth/config', { origin })).json(), { devLogin: false });
  }
  assert.equal((await request('/api/auth/dev')).status, 405);
  assert.equal((await request('/api/auth/dev', { method: 'POST', data: input, headers: { Origin: 'https://attacker.example' } })).status, 403);
  for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787']) {
    assert.equal((await request('/api/auth/dev', { method: 'POST', data: input, origin })).status, 200);
  }
  delete env.SESSION_SECRET;
  assert.equal((await request('/api/auth/dev', { method: 'POST', data: input })).status, 503);
});

runtimeTest('boards use SQLite, UUID ids, trimmed limits, rename and newest-first order', async t => {
  const { request, directory, env } = setup(t), cookie = `cg_session=${await signSession({ name: 'Artist', email: 'artist@example.com' }, env.SESSION_SECRET)}`;
  assert.deepEqual(await (await request('/api/cloud/boards', { cookie })).json(), { boards: [] });
  const first = await request('/api/cloud/boards', { cookie, method: 'POST', data: { name: ' First ' } });
  assert.equal(first.status, 201);
  const { board } = await first.json();
  assert.equal(board.name, 'First');
  assert.match(board.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  assert.ok(Number.isFinite(Date.parse(board.createdAt)));
  const second = directory.createBoard('Second');
  assert.deepEqual((await (await request('/api/cloud/boards', { cookie })).json()).boards.map(item => item.id), [second.id, board.id]);
  const renamed = await request(`/api/cloud/boards/${board.id}`, { cookie, method: 'PATCH', data: { name: " Artist's board " } });
  assert.deepEqual((await renamed.json()).board, { ...board, name: "Artist's board" });
  assert.equal((await request('/api/cloud/boards', { cookie, method: 'POST', data: { name: 'a'.repeat(81) } })).status, 400);
  assert.equal((await request(`/api/cloud/boards/${crypto.randomUUID()}`, { cookie, method: 'PATCH', data: { name: 'Missing' } })).status, 404);
});

runtimeTest('Directory adds board stats to an existing database without losing boards or templates', t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec("CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL); CREATE TABLE templates (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  database.prepare('INSERT INTO boards VALUES (?, ?, ?)').run('legacy', 'Old board', '2026-01-01T00:00:00.000Z');
  database.prepare('INSERT INTO templates VALUES (?, ?)').run('template', JSON.stringify({ id: 'template', name: 'Saved node' }));
  const ctx = { storage: { sql: { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } } } };
  const directory = new Directory(ctx, {});
  assert.deepEqual(directory.getBoard('legacy'), { id: 'legacy', name: 'Old board', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', imageCount: null, covers: [] });
  directory.createBoard('New board');
  directory.updateBoardStats('legacy', { updatedAt: '2099-01-01T00:00:00.000Z', imageCount: 2, covers: ['cover.png'] });
  assert.equal(directory.listBoards()[0].id, 'legacy');
  const reopened = new Directory(ctx, {});
  assert.deepEqual(reopened.getBoard('legacy').covers, ['cover.png']);
  assert.equal(reopened.getBoard('legacy').imageCount, 2);
  assert.equal(reopened.listBoards().length, 2);
  assert.deepEqual(reopened.listTemplates(), [{ id: 'template', name: 'Saved node' }]);
});

runtimeTest('board saves publish stats through the worker, deduplicate snapshots and retry metadata failures', async t => {
  const { env, directory, request } = setup(t), board = directory.createBoard('Images');
  const values = new Map(), calls = [];
  let fail = false;
  const storage = { kv: { get: key => values.get(key), put: (key, value) => values.set(key, structuredClone(value)), delete: key => values.delete(key) }, transactionSync: callback => callback(), getAlarm: async () => null, setAlarm: async () => {} };
  const roomEnv = { FILES: { objects: new Map(), async put(key, body, options = {}) { this.objects.set(key, { key, body, customMetadata: options.customMetadata }); }, async get(key) { return this.objects.get(key) || null; }, async list({ prefix }) { return { objects: [...this.objects.values()].filter(object => object.key.startsWith(prefix)), truncated: false }; }, async delete(keys) { for (const key of [keys].flat()) this.objects.delete(key); } }, Directory: { idFromName: name => name, get: () => ({ updateBoardStats(id, stats) { calls.push({ id, ...stats }); if (fail) throw new Error('Directory unavailable'); directory.updateBoardStats(id, stats); } }) } };
  const room = new BoardRoom({ storage, id: { name: board.id } }, roomEnv);
  t.after(() => room.document.destroy());
  const { applyLocalGraph } = await import('../src/cloud-sync.mjs');
  const asset = '00000000-0000-0000-0000-000000000000.png';
  applyLocalGraph(room.document, { nodes: [{ id: 'image', type: 'image', position: { x: 0, y: 0 }, data: { asset, createdAt: '2026-11-03T10:00:00Z' } }], edges: [], groups: [], runs: [] }, {}, 'test');
  await room.onSave();
  await Promise.all([room.onSave(), room.onSave()]);
  assert.equal(calls.length, 1);
  assert.deepEqual(directory.getBoard(board.id).covers, [asset]);
  assert.equal(directory.getBoard(board.id).imageCount, 1);
  room.document.getMap('nodes').get('image').set('x', 100);
  fail = true;
  await assert.rejects(room.onSave(), /Directory unavailable/);
  const recovered = new BoardRoom({ storage, id: { name: board.id } }, roomEnv);
  t.after(() => recovered.document.destroy());
  await recovered.onLoad();
  assert.equal(recovered.document.getMap('nodes').get('image').get('x'), 100);
  fail = false;
  await recovered.onSave();
  assert.equal(calls.length, 3);
  await recovered.onSave();
  assert.equal(calls.length, 3);
  const cookie = `cg_session=${await signSession({ name: 'Artist', email: 'artist@example.com' }, env.SESSION_SECRET)}`;
  const result = (await (await request('/api/cloud/boards', { cookie })).json()).boards[0];
  assert.deepEqual(result.covers, [asset]); assert.equal(result.imageCount, 1); assert.ok(Date.parse(result.updatedAt));
  recovered.document.getMap('nodes').clear();
  await recovered.onSave();
  assert.deepEqual(directory.getBoard(board.id).covers, []);
  assert.equal(directory.getBoard(board.id).imageCount, 0);
});

runtimeTest('asset upload uses magic bytes, authenticated download, private caching and ETags', async t => {
  const { request, env, files } = setup(t), cookie = `cg_session=${await signSession({ name: 'Artist', email: 'artist@example.com' }, env.SESSION_SECRET)}`;
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const upload = await request('/api/assets', { method: 'POST', cookie, bytes, headers: { 'Content-Type': 'text/plain' } });
  assert.equal(upload.status, 200);
  const { asset } = await upload.json();
  assert.match(asset, /^[\da-f-]{36}\.png$/);
  assert.equal(files.get(`assets/${asset}`).httpMetadata.contentType, 'image/png');
  const download = await request(`/assets/${asset}`, { cookie });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('Content-Type'), 'image/png');
  assert.equal(download.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
  assert.equal(download.headers.get('ETag'), '"test-etag"');
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  assert.equal((await request(`/assets/${asset}`)).status, 401);
  assert.equal((await request(`/assets/${asset}`, { cookie, headers: { 'If-None-Match': 'W/"test-etag"' } })).status, 304);
  assert.equal((await request('/api/assets', { method: 'POST', cookie, bytes: 'not an image' })).status, 400);
  assert.equal((await request('/api/assets', { method: 'POST', cookie, bytes, headers: { 'Content-Length': String(30 * 1024 * 1024 + 1) } })).status, 413);
  assert.equal((await request('/assets/00000000-0000-0000-0000-000000000000.png', { cookie })).status, 404);
  assert.equal((await request('/assets/invalid.svg', { cookie })).status, 404);
});

runtimeTest('image previews are stored once per asset, validated, and served like assets', async t => {
  const { request, env, files } = setup(t), cookie = `cg_session=${await signSession({ name: 'Artist', email: 'artist@example.com' }, env.SESSION_SECRET)}`;
  const { asset } = await (await request('/api/assets', { method: 'POST', cookie, bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) })).json();
  // A minimal JPEG header: SOF0 with 200 × 100.
  const jpeg = size => new Uint8Array([255, 216, 255, 192, 0, 17, 8, size >> 8, size & 255, 0, 200, 3, 1, 34, 0, 2, 17, 1, 3, 17, 1, 255, 217]);
  assert.equal((await request(`/assets/${asset}/thumb`, { cookie })).status, 204);
  assert.equal((await request(`/assets/${asset}/thumb`, { method: 'PUT', bytes: jpeg(100) })).status, 401);
  assert.equal((await request(`/assets/${asset}/thumb`, { method: 'PUT', cookie, bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) })).status, 400);
  assert.equal((await request(`/assets/${asset}/thumb`, { method: 'PUT', cookie, bytes: jpeg(2000) })).status, 400);
  assert.equal((await request('/assets/00000000-0000-0000-0000-000000000000.png/thumb', { method: 'PUT', cookie, bytes: jpeg(100) })).status, 404);
  assert.equal((await request(`/assets/${asset}/thumb`, { method: 'PUT', cookie, bytes: jpeg(100) })).status, 201);
  assert.equal((await request(`/assets/${asset}/thumb`, { method: 'PUT', cookie, bytes: jpeg(120) })).status, 200);
  assert.deepEqual(files.get(`thumbs/${asset}`).body, jpeg(100));
  const preview = await request(`/assets/${asset}/thumb`, { cookie });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(preview.headers.get('Cache-Control'), 'private, max-age=31536000, immutable');
  assert.equal((await request(`/assets/${asset}/thumb`, { cookie, headers: { 'If-None-Match': '"test-etag"' } })).status, 304);
  assert.equal((await request(`/assets/${asset}/thumb`)).status, 401);
});

runtimeTest('helper manifest is public, streamed from R2 and never cached or served by static assets', async t => {
  const { request, env, files } = setup(t);
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'DB', 'ASSETS']) delete env[key];
  const manifest = { 'windows-x64': { file: 'Concept-Graph-Helper-windows-x64-setup.exe' } };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const key = 'downloads/concept-graph-helper-downloads.json';
  files.set(key, { body, size: bytes.length, httpEtag: '"manifest-etag"', httpMetadata: { contentType: 'text/plain' } });
  const reads = [];
  for (const method of ['get', 'head']) {
    const original = env.FILES[method];
    env.FILES[method] = async key => { reads.push([method, key]); return original(key); };
  }
  const response = await request('/concept-graph-helper-downloads.json', { cookie: 'cg_session=forged', headers: { 'If-None-Match': '"manifest-etag"' } });
  assert.equal(response.status, 200);
  assert.equal(response.body, body);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Content-Length'), String(bytes.length));
  assert.equal(response.headers.has('Set-Cookie'), false);
  assert.deepEqual(await response.json(), manifest);
  const head = await request('/concept-graph-helper-downloads.json', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get('Content-Type'), 'application/json');
  assert.equal(head.headers.get('Cache-Control'), 'no-store');
  assert.equal(head.headers.get('Content-Length'), String(bytes.length));
  files.set(key, { body: '{"updated":true}', size: 16 });
  assert.deepEqual(await (await request('/concept-graph-helper-downloads.json')).json(), { updated: true });
  assert.deepEqual(reads, [['get', key], ['head', key], ['get', key]]);
});

runtimeTest('helper manifest returns uncached JSON errors when absent and rejects writes before reading R2', async t => {
  const { request, env } = setup(t), reads = [];
  for (const method of ['get', 'head']) env.FILES[method] = async key => { reads.push([method, key]); return null; };
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await request('/concept-graph-helper-downloads.json', { method });
    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { error: 'Method not allowed.' });
  }
  assert.deepEqual(reads, []);
  const response = await request('/concept-graph-helper-downloads.json');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'Helper downloads not found.' });
  const head = await request('/concept-graph-helper-downloads.json', { method: 'HEAD' });
  assert.equal(head.status, 404);
  assert.equal(head.body, null);
  assert.equal(head.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(reads, [['get', 'downloads/concept-graph-helper-downloads.json'], ['head', 'downloads/concept-graph-helper-downloads.json']]);
});

runtimeTest('helper downloads stream authenticated installers with attachment headers, lengths and ETags', async t => {
  const { request, env, files } = setup(t), cookie = `cg_session=${await signSession({ name: 'Artist', email: 'artist@example.com' }, env.SESSION_SECRET)}`;
  const names = ['Concept-Graph-Helper-macos-arm64.dmg', 'Concept-Graph-Helper-macos-x64.dmg', 'Concept-Graph-Helper-windows-x64-setup.exe'];
  for (const file of names) {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    files.set(`downloads/${file}`, { body, size: bytes.length, httpEtag: '"download-etag"' });
    const response = await request(`/downloads/${file}`, { cookie });
    assert.equal(response.status, 200);
    assert.equal(response.body, body);
    assert.equal(response.headers.get('Content-Type'), file.endsWith('.dmg') ? 'application/x-apple-diskimage' : 'application/vnd.microsoft.portable-executable');
    assert.equal(response.headers.get('Content-Disposition'), `attachment; filename="${file}"`);
    assert.equal(response.headers.get('Content-Length'), String(bytes.length));
    assert.equal(response.headers.get('ETag'), '"download-etag"');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-cache');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    const head = await request(`/downloads/${file}`, { cookie, method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('Content-Length'), String(bytes.length));
    assert.equal(head.body, null);
    const cached = await request(`/downloads/${file}`, { cookie, headers: { 'If-None-Match': 'W/"download-etag"' } });
    assert.equal(cached.status, 304);
    assert.equal(cached.body, null);
    assert.equal((await request(`/downloads/${file}`, { headers: { 'If-None-Match': '*' } })).status, 401);
  }
});

runtimeTest('helper downloads reject invalid filenames and methods before reading R2', async t => {
  const { request, env } = setup(t), cookie = `cg_session=${await signSession({ name: 'Artist', email: 'artist@example.com' }, env.SESSION_SECRET)}`;
  const reads = [];
  env.FILES.get = async key => { reads.push(key); return null; };
  const file = 'Concept-Graph-Helper-windows-x64-setup.exe';
  assert.equal((await request(`/downloads/${file}`)).status, 401);
  assert.equal((await request(`/downloads/${file}`, { cookie: 'cg_session=forged' })).status, 401);
  for (const name of ['private.txt', 'Concept-Graph-Helper-macos-arm64.zip', 'Concept-Graph-Helper-windows-x64.zip', file + '/extra', file + '%0a', file + '%2fsecret', '%2e%2e%2fsecret', '__proto__']) {
    assert.equal((await request(`/downloads/${name}`, { cookie })).status, 404, name);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await request(`/downloads/${file}`, { cookie, method })).status, 405);
  assert.deepEqual(reads, []);
  assert.equal((await request(`/downloads/${file}`, { cookie })).status, 404);
  assert.deepEqual(reads, [`downloads/${file}`]);
});

runtimeTest('team templates mirror local CRUD, optimistic conflicts, image references and immutable node snapshots', async t => {
  const { request, env, directory } = setup(t), cookie = `cg_session=${await signSession({ name: 'Artist', email: 'artist@example.com' }, env.SESSION_SECRET)}`;
  const otherCookie = `cg_session=${await signSession({ name: 'Other artist', email: 'other@example.com' }, env.SESSION_SECRET)}`;
  const upload = await request('/api/assets', { method: 'POST', cookie, bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) });
  const { asset } = await upload.json();
  assert.deepEqual(await (await request('/api/templates', { cookie })).json(), { templates: [] });
  const input = { name: ' Views ', instructions: 'Front and side', assets: [asset], labelOutputs: true };
  const created = await request('/api/templates', { cookie, method: 'POST', data: input });
  assert.equal(created.status, 201);
  const { template } = await created.json();
  assert.deepEqual(template, { id: template.id, name: 'Views', instructions: input.instructions, assets: [asset], labelOutputs: true, color: templatePalette[0], createdAt: template.createdAt });
  assert.match(template.id, /^[\da-f-]{36}$/); assert.ok(Number.isFinite(Date.parse(template.createdAt)));
  const route = `/api/templates/${template.id}`;
  for (const method of ['PUT', 'DELETE']) assert.equal((await request(route, { method, data: { ...input, expected: template } })).status, 401);
  assert.deepEqual(await (await request('/api/templates', { cookie: otherCookie })).json(), { templates: [template] });
  const node = { id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: '', template: { name: template.name, instructions: template.instructions, assets: [...template.assets] } } };
  const before = structuredClone(node);
  const expected = Object.fromEntries(Object.entries(template).reverse());
  const changed = await request(route, { cookie: otherCookie, method: 'PUT', data: { ...input, name: 'Updated', expected } });
  assert.equal(changed.status, 200);
  const updated = (await changed.json()).template;
  assert.equal(updated.id, template.id); assert.equal(updated.createdAt, template.createdAt);
  assert.equal((await request(route, { cookie, method: 'PUT', data: { ...input, expected: template } })).status, 409);
  const conflict = await request(route, { cookie, method: 'DELETE', data: { expected: template } });
  assert.equal(conflict.status, 409); assert.deepEqual(await conflict.json(), { error: 'Custom node changed. Reopen it to edit the latest version.' });
  assert.deepEqual(await (await request(route, { cookie, method: 'DELETE', data: { expected: updated } })).json(), { ok: true });
  assert.equal((await request(route, { cookie, method: 'DELETE', data: { expected: updated } })).status, 404);
  assert.deepEqual(await (await request('/api/templates', { cookie })).json(), { templates: [] });
  assert.deepEqual(node, before);
  const inputs = collectInputs({ nodes: [node], edges: [] }, node.id);
  assert.match(inputs.prompt, /Front and side/); assert.deepEqual(inputs.images, [asset]);
  assert.equal((await request(`/assets/${asset}`, { cookie })).status, 200);
  const board = directory.createBoard('Existing board');
  const saved = await (await request('/api/templates', { cookie, method: 'POST', data: { ...input, labelOutputs: false } })).json();
  const reopened = new Directory(directory.ctx, env);
  assert.deepEqual(reopened.listTemplates(), [saved.template]); assert.deepEqual(reopened.getBoard(board.id), board);
});

runtimeTest('templates validate references, 100000-character instructions and the 500-template limit without overwriting data', async t => {
  const { request, env, directory } = setup(t), cookie = `cg_session=${await signSession({ name: 'Artist', email: 'artist@example.com' }, env.SESSION_SECRET)}`;
  const input = { name: 'Valid', instructions: '', assets: [] };
  for (const patch of [{ name: ' ' }, { name: 'x'.repeat(81) }, { instructions: 42 }, { instructions: 'x'.repeat(100001) }, { assets: ['../../secret'] }, { assets: Array(11).fill('00000000-0000-0000-0000-000000000000.png') }, { labelOutputs: 'yes' }]) {
    assert.equal((await request('/api/templates', { cookie, method: 'POST', data: { ...input, ...patch } })).status, 400);
  }
  assert.equal((await request('/api/templates', { cookie, method: 'POST', bytes: '{bad' })).status, 400);
  const missing = await request('/api/templates', { cookie, method: 'POST', data: { ...input, assets: ['00000000-0000-0000-0000-000000000000.png'] } });
  assert.equal(missing.status, 404);
  assert.deepEqual(await (await request('/api/templates', { cookie })).json(), { templates: [] });
  const created = await request('/api/templates', { cookie, method: 'POST', data: { ...input, instructions: 'Ж'.repeat(100000) } });
  assert.equal(created.status, 201);
  const { template } = await created.json();
  assert.equal(template.instructions.length, 100000);
  assert.equal((await request(`/api/templates/${template.id}`, { cookie, method: 'PUT', data: { ...input, assets: ['bad'], expected: template } })).status, 400);
  assert.deepEqual(directory.listTemplates(), [template]);
  for (let i = 1; i < 500; i++) directory.createTemplate({ ...input, name: `Template ${i}` });
  assert.equal((await request('/api/templates', { cookie, method: 'POST', data: input })).status, 400);
  assert.equal(directory.listTemplates().length, 500);
  const updates = await Promise.all(['First editor', 'Second editor'].map(name => request(`/api/templates/${template.id}`, { cookie, method: 'PUT', data: { ...input, name, expected: template } })));
  assert.deepEqual(updates.map(response => response.status).sort(), [200, 409]);
  assert.equal(directory.listTemplates().length, 500);
});

runtimeTest('template CAS rechecks the version after asynchronous R2 reference validation', async t => {
  const { request, env, directory } = setup(t), cookie = `cg_session=${await signSession({ name: 'Artist', email: 'artist@example.com' }, env.SESSION_SECRET)}`;
  const value = { name: 'Initial', instructions: '', assets: [] }, { template } = directory.createTemplate(value);
  env.FILES.head = async () => {
    directory.changeTemplate(template.id, template, { ...value, name: 'Concurrent edit' });
    return { size: 8 };
  };
  const response = await request(`/api/templates/${template.id}`, { cookie, method: 'PUT', data: { ...value, assets: ['00000000-0000-0000-0000-000000000000.png'], expected: template } });
  assert.equal(response.status, 409); assert.equal(directory.listTemplates()[0].name, 'Concurrent edit');
});

runtimeTest('template colours are assigned least-used, validated and saved on update', async t => {
  const { request, env } = setup(t), cookie = `cg_session=${await signSession({ name: 'Artist', email: 'artist@example.com' }, env.SESSION_SECRET)}`;
  const input = { name: 'Coloured type', instructions: '', assets: [] }, saved = [];
  for (let i = 0; i < templatePalette.length + 1; i++) {
    const response = await request('/api/templates', { cookie, method: 'POST', data: input });
    assert.equal(response.status, 201); saved.push((await response.json()).template);
    assert.equal(saved.at(-1).color, templatePalette[i % templatePalette.length]);
  }
  const template = saved[0], route = `/api/templates/${template.id}`;
  assert.equal((await request('/api/templates', { cookie, method: 'POST', data: { ...input, color: 'red' } })).status, 400);
  assert.equal((await request(route, { cookie, method: 'PUT', data: { ...input, color: 'red', expected: template } })).status, 400);
  const updated = await request(route, { cookie, method: 'PUT', data: { ...input, color: templatePalette[3], expected: template } });
  assert.equal(updated.status, 200); assert.equal((await updated.json()).template.color, templatePalette[3]);
  assert.equal(template.color, templatePalette[0]);
});

runtimeTest('adding template storage preserves a pre-existing Directory boards database', t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  const sql = { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  sql.exec('CREATE TABLE boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL)').toArray();
  sql.exec('INSERT INTO boards VALUES (?, ?, ?)', 'legacy', 'Keep this board', '2026-01-01T00:00:00.000Z').toArray();
  const directory = new Directory({ storage: { sql } }, {});
  assert.equal(directory.getBoard('legacy').name, 'Keep this board'); assert.deepEqual(directory.listTemplates(), []);
  directory.createTemplate({ name: 'New library', instructions: '', assets: [] });
  assert.equal(new Directory(directory.ctx, {}).listTemplates().length, 1);
  assert.equal(directory.getBoard('legacy').name, 'Keep this board');
});

runtimeTest('real PartyServer router gates board upgrades and cannot expose Directory', async t => {
  const { request, env, directory, routed } = setup(t), board = directory.createBoard('Shared');
  const cookie = `cg_session=${await signSession({ name: 'Artist', email: 'artist@example.com' }, env.SESSION_SECRET)}`;
  const headers = { Upgrade: 'websocket', Origin: 'http://localhost:8787' };
  assert.equal((await request(`/parties/board-room/${board.id}`, { headers })).status, 401);
  assert.equal((await request(`/parties/board-room/${crypto.randomUUID()}`, { cookie, headers })).status, 404);
  assert.equal((await request(`/parties/board-room/${board.id}`, { cookie })).status, 426);
  assert.equal((await request('/parties/directory/boards', { cookie, headers })).status, 404);
  assert.equal((await request(`/parties/board-room/${board.id}`, { cookie, headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
  assert.equal(routed.length, 0);
  assert.equal(await (await request(`/parties/board-room/${board.id}`, { cookie, headers })).text(), 'routed');
  assert.equal(routed.length, 1);
  assert.equal(routed[0].headers.get('x-partykit-namespace'), 'board-room');
});

runtimeTest('Yjs snapshots chunk, reload, roll back failed writes and remove stale chunks', async t => {
  const values = new Map();
  let failKey;
  const storage = {
    kv: { get: key => values.get(key), put(key, value) { if (key === failKey) throw new Error('disk full'); values.set(key, structuredClone(value)); }, delete: key => values.delete(key) },
    transactionSync(callback) {
      const previous = new Map(values);
      try { return callback(); }
      catch (error) { values.clear(); for (const [key, value] of previous) values.set(key, value); throw error; }
    },
    getAlarm: async () => null, setAlarm: async () => {}
  };
  const files = { objects: new Map(), async put(key, body, options = {}) { this.objects.set(key, { key, body, customMetadata: options.customMetadata }); }, async get(key) { return this.objects.get(key) || null; }, async list({ prefix }) { return { objects: [...this.objects.values()].filter(object => object.key.startsWith(prefix)), truncated: false }; }, async delete(keys) { for (const key of [keys].flat()) this.objects.delete(key); } };
  const makeRoom = () => { const room = new BoardRoom({ storage, id: { name: 'snapshot-test' } }, { FILES: files, Directory: { idFromName: name => name, get: () => ({ updateBoardStats() {} }) } }); t.after(() => room.document.destroy()); return room; };
  const room = makeRoom();
  await room.onLoad();
  room.document.getMap('nodes').set('large', 'x'.repeat(1200000));
  await room.onSave();
  assert.equal(values.get('doc:count'), 3);
  for (let i = 0; i < 3; i++) assert.ok(values.get(`doc:${i}`).byteLength <= 512 * 1024);
  const restored = makeRoom();
  await restored.onLoad();
  assert.equal(restored.document.getMap('nodes').get('large'), 'x'.repeat(1200000));
  const before = new Map(values);
  room.document.getMap('nodes').set('extra', 'y'.repeat(100000));
  failKey = 'doc:1';
  await assert.rejects(room.onSave(), /disk full/);
  assert.deepEqual(values, before);
  failKey = undefined;
  room.document.getMap('nodes').clear();
  room.getConnections = () => [];
  await room.onClose({ id: 'last', state: null }, 1000, '', true);
  assert.equal(values.get('doc:count'), 1);
  assert.equal(values.has('doc:1'), false);
  assert.equal(values.has('doc:2'), false);
  const empty = makeRoom();
  await empty.onLoad();
  assert.equal(empty.document.getMap('nodes').size, 0);
  values.delete('doc:0');
  await assert.rejects(makeRoom().onLoad(), /Incomplete board snapshot/);
});

runtimeTest('analytics ingestion requires a signed-in cookie and admin pages/reads require the Team access site role', async t => {
  const { request, directory } = setup(t), cookie = `cg_session=${await signSession({ email: 'person@example.com', name: 'Person' }, 'session-test')}`;
  assert.equal((await request('/api/analytics/events', { method: 'POST', data: {} })).status, 401);
  assert.equal((await request('/admin/analytics')).status, 401);
  assert.equal((await request('/admin/analytics', { cookie })).status, 403);
  assert.equal((await request('/api/analytics/overview', { cookie })).status, 403);
  directory.env.SITE_OWNER_EMAIL = 'person@example.com';
  assert.equal((await request('/admin/analytics', { cookie })).status, 200);
});
