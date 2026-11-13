import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { analyticsRoute, analyticsSchema, purgeAnalytics } from '../cloud/analytics.mjs';
import { eventBytes, replayBytes, sessionReplayBytes, replayKey } from '../src/analytics-core.mjs';

const id = '12345678-1234-1234-1234-123456789abc', user = { email: 'person@example.com' }, now = Date.parse('2026-11-13T12:00:00Z');
function setup(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const db = { prepare(query) { let args = []; return { bind(...values) { args = values; return this; }, async run() { return sqlite.prepare(query).run(...args); }, async first() { return sqlite.prepare(query).get(...args) || null; }, async all() { return { results: sqlite.prepare(query).all(...args) }; } }; },
    async batch(statements) { sqlite.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; } catch (cause) { sqlite.exec('ROLLBACK'); throw cause; } } };
  const files = new Map(), env = { DB: db, FILES: {
    async put(key, bytes) { if (!files.has(key)) files.set(key, new Uint8Array(bytes)); },
    async get(key) { const bytes = files.get(key); return bytes ? { body: new Blob([bytes]).stream() } : null; },
    async list() { return { objects: [...files.keys()].sort().map(key => ({ key })), truncated: false }; },
    async delete(keys) { for (const key of keys) files.delete(key); }
  } };
  const call = (path, { method = 'POST', data, bytes, headers = {}, person = user, admin = false, at = now } = {}) => {
    const url = new URL(`https://cloud.example/api/analytics${path}`), request = new Request(url, { method, headers, ...(method === 'POST' ? { body: bytes || JSON.stringify(data) } : {}) });
    return analyticsRoute(request, env, person, url, { siteRole: async () => admin ? 'admin' : null }, at);
  };
  const send = (seq = 0, extra = {}) => ({ session: id, user: 'forged', events: [{ seq, time: now, kind: 'session', name: 'session_start', details: { width: 1400, height: 900, platform: 'MacIntel' }, ...extra }] });
  return { sqlite, env, files, call, send };
}
test('ingestion binds server identity, deduplicates retries, updates session and refuses hijacking', async t => {
  const { call, send, sqlite } = setup(t);
  assert.equal((await call('/events', { data: send() })).status, 204);
  await call('/events', { data: send() });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM analytics_events').get().n, 1);
  const session = sqlite.prepare('SELECT * FROM analytics_sessions').get();
  assert.equal(session.user, user.email); assert.equal(session.event_count, 1); assert.equal(session.width, 1400);
  await assert.rejects(call('/events', { data: send(1), person: { email: 'other@example.com' } }), { status: 403 });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM analytics_events').get().n, 1);
});
test('ingestion validates streaming byte limit, count, sequence and origin', async t => {
  const { call, send } = setup(t);
  await assert.rejects(call('/events', { bytes: 'x'.repeat(eventBytes + 1) }), { status: 413 });
  await assert.rejects(call('/events', { bytes: '{}' }), { status: 400 });
  await assert.rejects(call('/events', { data: send(), headers: { Origin: 'https://other.example' } }), { status: 403 });
  await assert.rejects(call('/events', { data: send(), headers: { 'Sec-Fetch-Site': 'cross-site' } }), { status: 403 });
  await assert.rejects(call('/events', { data: { session: id, events: Array.from({ length: 201 }, () => send().events[0]) } }), { status: 400 });
});
test('200 events fit parameter limits, and summaries aggregate controls, errors, generations and heatmaps', async t => {
  const { call, send, sqlite } = setup(t);
  const data = send(); data.events = Array.from({ length: 200 }, (_, seq) => ({ seq, time: now, kind: 'click', name: 'Generate', area: 'sidebar', details: { x: .5, y: .5, route: 'board', width: 1400 } }));
  await call('/events', { data });
  await call('/events', { data: send(200, { kind: 'error', name: 'notify', details: { message: 'Failed' } }) });
  await call('/events', { data: send(201, { kind: 'app', name: 'generation_failed', details: { generator: 'codex', duration: 500 } }) });
  const result = await (await call('/overview', { method: 'GET', admin: true })).json();
  assert.equal(result.controls[0].clicks, 200); assert.equal(result.totals.events, 202); assert.equal(result.errors[0].message, 'Failed');
  assert.equal(result.generations[0].failed, 1); assert.equal(result.heatmap[0].count, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM analytics_events').get().n, 202);
});
test('all overview, timeline and replay reads require site admin; owner can only upload', async t => {
  const { call, send } = setup(t); await call('/events', { data: send() });
  for (const path of ['/overview', `/sessions/${id}`, `/sessions/${id}/0`]) await assert.rejects(call(path, { method: 'GET' }), { status: 403 });
  assert.equal((await call(`/sessions/${id}`, { method: 'GET', admin: true })).status, 200);
});
test('replay roundtrip, beacon encoding, ownership and sequence idempotency', async t => {
  const { call, files, sqlite } = setup(t);
  const raw = '{"type":2,"timestamp":1,"data":{"text":"їжак"}}\n', compressed = gzipSync(raw);
  assert.equal((await call(`/replay/${id}/0?encoding=gzip`, { bytes: compressed })).status, 204);
  await call(`/replay/${id}/0?encoding=gzip`, { bytes: compressed });
  assert.equal(files.size, 1); assert.equal(sqlite.prepare('SELECT replay_chunks FROM analytics_sessions').get().replay_chunks, 1);
  assert.equal(await (await call(`/sessions/${id}/0`, { method: 'GET', admin: true })).text(), raw);
  await assert.rejects(call(`/replay/${id}/1`, { bytes: 'x', person: { email: 'other@example.com' } }), { status: 403 });
  await assert.rejects(call(`/replay/${id}/0`, { bytes: 'x' }), { status: 409 });
});
test('replay rejects raw oversize, gzip bombs and session totals beyond the quota', async t => {
  const { call, send, sqlite } = setup(t);
  await assert.rejects(call(`/replay/${id}/0`, { bytes: new Uint8Array(replayBytes + 1) }), { status: 413 });
  await assert.rejects(call(`/replay/${id}/0`, { bytes: gzipSync(new Uint8Array(replayBytes + 1)), headers: { 'Content-Encoding': 'gzip' } }), { status: 413 });
  await call('/events', { data: send() });
  sqlite.prepare('INSERT INTO analytics_replays(session,seq,key,bytes,created,encoding) VALUES (?,?,?,?,?,?)').run(id, 999, 'reserved', sessionReplayBytes - 1, now, 'identity');
  sqlite.prepare('UPDATE analytics_sessions SET replay_bytes = ?').run(sessionReplayBytes - 1);
  await assert.rejects(call(`/replay/${id}/1`, { bytes: 'xx' }), { status: 413 });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM analytics_replays').get().n, 1);
});
test('rate limit is per authenticated account and per minute, persisted across route calls', async t => {
  const { call, send } = setup(t);
  for (let i = 0; i < 120; i++) await call('/events', { data: send(i) });
  await assert.rejects(call('/events', { data: send(121) }), { status: 429 });
  assert.equal((await call('/events', { data: send(122), at: now + 60000 })).status, 204);
});
test('daily cleanup removes expired recordings, orphaned R2 objects, events and rate counters', async t => {
  const { call, send, sqlite, env, files } = setup(t);
  await call('/events', { data: send() });
  const old = now - 181 * 86400000, day = new Date(old).toISOString().slice(0,10), key = replayKey(day, id, 0);
  files.set(key, new Uint8Array([1])); files.set(replayKey('2026-11-13', id, 1), new Uint8Array([2]));
  sqlite.prepare('UPDATE analytics_events SET time = ?').run(old);
  sqlite.prepare('UPDATE analytics_sessions SET last_seen = ?').run(old);
  await purgeAnalytics(env, now);
  assert.equal(files.has(key), false); assert.equal(files.size, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM analytics_events').get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM analytics_sessions').get().n, 0);
});
