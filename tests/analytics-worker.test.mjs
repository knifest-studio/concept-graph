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
test('rate limit is per authenticated account and per 10 minutes, counts replay uploads and keeps one counter row', async t => {
  const { call, send, sqlite, env } = setup(t), window = Math.floor(now / 600000) * 600000;
  // 1,200 requests in the window (120 a minute on average), events and replay uploads alike, in any minute of it.
  for (let i = 0; i < 1199; i++) await call('/events', { data: send(i), at: window + (i % 10) * 60000 });
  assert.equal((await call(`/replay/${id}/0`, { bytes: 'x', at: window + 540000 })).status, 204);
  await assert.rejects(call('/events', { data: send(1200), at: window + 599999 }), { status: 429 });
  await assert.rejects(call(`/replay/${id}/1`, { bytes: 'x', at: window + 30000 }), { status: 429 });
  assert.equal((await call('/events', { data: { ...send(0), session: '22345678-1234-1234-1234-123456789abc' }, person: { email: 'other@example.com' }, at: window + 60000 })).status, 204);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM analytics_limits WHERE user = ?').get(user.email).n, 1);
  assert.equal((await call('/events', { data: send(1202), at: window + 600000 })).status, 204);
  // The daily purge keeps only the current window's counter, so it cannot reset a window in use.
  await purgeAnalytics(env, window + 660000);
  assert.deepEqual(sqlite.prepare('SELECT user, minute, count FROM analytics_limits').all().map(row => ({ ...row })), [{ user: user.email, minute: (window + 600000) / 60000, count: 1 }]);
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
test('ingestion keeps session counters exact without reading the whole session', async t => {
  const { call, send, sqlite, env } = setup(t), queries = [], prepare = env.DB.prepare;
  env.DB.prepare = query => { const statement = prepare(query), bind = statement.bind; statement.bind = (...values) => { queries.push([query, values]); return bind.apply(statement, values); }; return statement; };
  const data = send(); data.events = Array.from({ length: 30 }, (_, seq) => ({ seq, time: now, kind: 'click', name: 'Generate', area: 'sidebar', details: {} }));
  await call('/events', { data });
  // A retry with a duplicate inside the batch and one new event adds only the new one.
  await call('/events', { data: { ...data, events: [...data.events.slice(25), data.events[29], { ...data.events[0], seq: 30 }] } });
  for (let seq = 0; seq < 3; seq++) await call(`/replay/${id}/${seq}`, { bytes: 'x'.repeat(10 + seq) });
  await call(`/replay/${id}/1`, { bytes: 'x'.repeat(11) });
  const session = sqlite.prepare('SELECT event_count, replay_chunks, replay_bytes FROM analytics_sessions').get();
  assert.deepEqual({ ...session }, { event_count: 31, replay_chunks: 3, replay_bytes: 33 });
  // Every lookup into a session's events or replay chunks finds single rows by session and sequence.
  for (const [query, values] of queries) for (const { detail } of sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values)) {
    if (!/analytics_(events|replays)\b/.test(detail) || /^(SCAN|SEARCH) (json_each|CONSTANT)/.test(detail)) continue;
    assert.match(detail, /SEARCH analytics_(events|replays) USING (PRIMARY KEY|(COVERING )?INDEX sqlite_autoindex_\w+) \(session=\? AND seq=\?\)/, query);
  }
});
test('heartbeats move the session’s time without being stored, from new and older tabs alike, and counts stay exact', async t => {
  const { call, send, sqlite } = setup(t);
  const beat = (seq, active) => ({ seq, time: now, kind: 'session', name: 'heartbeat', details: { duration: seq * 60000, active } });
  await call('/events', { data: send() });
  // A tab opened before this change sends a heartbeat every minute, next to what the person did.
  const batch = { session: id, events: [beat(1, 30000), { seq: 2, time: now, kind: 'click', name: 'Generate', area: 'sidebar', details: {} }, beat(3, 90000)] };
  await call('/events', { data: batch });
  await call('/events', { data: batch }); // A retry.
  await call('/events', { data: { session: id, events: [beat(4, 120000)] } });
  assert.deepEqual(sqlite.prepare('SELECT seq, name FROM analytics_events ORDER BY seq').all().map(row => [row.seq, row.name]), [[0, 'session_start'], [2, 'Generate']]);
  assert.deepEqual({ ...sqlite.prepare('SELECT event_count, duration, active FROM analytics_sessions').get() }, { event_count: 2, duration: 240000, active: 120000 });
});
test('the error overview tells problems apart by type and place, adds up repeats, puts noise last and leaves notices out', async t => {
  const { call, sqlite } = setup(t);
  const error = (seq, details, name = 'window_error') => ({ seq, time: now, kind: 'error', name, details: { message: 'Error (details hidden)', ...details } });
  await call('/events', { data: { session: id, events: [
    error(0, { errorType: 'TypeError', location: 'index-B3k9.js:1:4321' }), error(1, { errorType: 'TypeError', location: 'index-B3k9.js:1:4321', count: 416 }),
    error(2, { errorType: 'TypeError', location: 'index-B3k9.js:1:99' }), error(3, {}), error(4, { noise: 'resize_observer' }), error(5, { noise: 'resize_observer', count: 2000 }),
    { seq: 6, time: now, kind: 'app', name: 'notice', details: { target: 'attention_call' } }, error(7, { message: 'Failed to fetch' }, 'notify'),
    { seq: 8, time: now, kind: 'session', name: 'heartbeat', details: { duration: 1, active: 1 } }
  ] } });
  // Heartbeats stored before they stopped being kept are not counted as events either.
  sqlite.prepare("INSERT INTO analytics_events(session, seq, time, user, kind, name, area, board, details) VALUES (?, 9, ?, ?, 'session', 'heartbeat', 'editor', '', '{}')").run(id, now, user.email);
  const result = await (await call('/overview', { method: 'GET', admin: true })).json();
  assert.deepEqual(result.errors.map(row => [row.name, row.errorType, row.location, row.noise, row.message, row.count]), [
    ['window_error', 'TypeError', 'index-B3k9.js:1:4321', null, 'Error (details hidden)', 417], ['notify', null, null, null, 'Failed to fetch', 1],
    ['window_error', null, null, null, 'Error (details hidden)', 1], ['window_error', 'TypeError', 'index-B3k9.js:1:99', null, 'Error (details hidden)', 1],
    ['window_error', null, null, 'resize_observer', 'Error (details hidden)', 2001]]);
  assert.equal(result.totals.events, 8); assert.deepEqual(result.daily.map(row => row.events), [8]);
});
test('the daily cleanup recounts recordings only for old sessions that still count some, not every old session', async t => {
  const { call, send, sqlite, env } = setup(t), old = now - 40 * 86400000, other = '22345678-1234-1234-1234-123456789abc';
  await call('/events', { data: send() }); await call('/events', { data: { ...send(), session: other } });
  sqlite.prepare('UPDATE analytics_sessions SET started = ?').run(old);
  sqlite.prepare('UPDATE analytics_sessions SET replay_chunks = 2, replay_bytes = 50 WHERE id = ?').run(other);
  sqlite.exec('CREATE TABLE rewritten (id TEXT); CREATE TRIGGER count_rewrites AFTER UPDATE ON analytics_sessions BEGIN INSERT INTO rewritten VALUES (NEW.id); END');
  await purgeAnalytics(env, now);
  assert.deepEqual(sqlite.prepare('SELECT id FROM rewritten').all().map(row => row.id), [other]);
  assert.deepEqual({ ...sqlite.prepare('SELECT replay_chunks, replay_bytes FROM analytics_sessions WHERE id = ?').get(other) }, { replay_chunks: 0, replay_bytes: 0 });
  await purgeAnalytics(env, now + 86400000);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rewritten').get().n, 1);
});
test('an event writes only its row, key and time index; the daily cleanup drops the two unused indexes, and the overview still reads its period through the time index', async t => {
  const { call, send, sqlite, env } = setup(t), queries = [], prepare = env.DB.prepare;
  await call('/events', { data: send() });
  const indexes = () => sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'analytics_events' ORDER BY name").all().map(row => row.name);
  assert.deepEqual(indexes(), ['analytics_events_time', 'sqlite_autoindex_analytics_events_1']);
  // A database made before this change has them.
  sqlite.exec('CREATE INDEX analytics_events_name ON analytics_events(name, time); CREATE INDEX analytics_events_user ON analytics_events(user, time)');
  await purgeAnalytics(env, now);
  assert.deepEqual(indexes(), ['analytics_events_time', 'sqlite_autoindex_analytics_events_1']);
  env.DB.prepare = query => { const statement = prepare(query), bind = statement.bind; statement.bind = (...values) => { queries.push([query, values]); return bind.apply(statement, values); }; return statement; };
  await call('/overview', { method: 'GET', admin: true });
  const period = queries.filter(([query]) => /FROM analytics_events WHERE time >= \?/.test(query));
  assert.equal(period.length, 7);
  for (const [query, values] of period) assert.ok(sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values).some(({ detail }) => /analytics_events USING (COVERING )?INDEX analytics_events_time/.test(detail)), query);
});
test('playing a recording writes no rate-limit rows', async t => {
  const { call, sqlite } = setup(t);
  for (let seq = 0; seq < 3; seq++) await call(`/replay/${id}/${seq}`, { bytes: `chunk ${seq}\n` });
  const rows = () => sqlite.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(count), 0) AS used FROM analytics_limits').get();
  const before = rows();
  for (let seq = 0; seq < 3; seq++) assert.equal(await (await call(`/sessions/${id}/${seq}`, { method: 'GET', admin: true })).text(), `chunk ${seq}\n`);
  assert.deepEqual({ ...rows() }, { ...before });
  await call(`/sessions/${id}`, { method: 'GET', admin: true });
  assert.notDeepEqual({ ...rows() }, { ...before });
});
