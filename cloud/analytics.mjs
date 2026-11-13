import { readBody } from './assets.mjs';
import { eventBytes, replayBytes, sessionReplayBytes, sessionPattern, validateBatch, replaySequence, replayKey, retentionCutoffs } from '../src/analytics-core.mjs';

const initialized = new WeakMap();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const json = value => Response.json(value, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const empty = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
export function analyticsSchema(db) {
  if (!initialized.has(db)) initialized.set(db, (async () => {
    for (const query of [
      `CREATE TABLE IF NOT EXISTS analytics_sessions (id TEXT PRIMARY KEY, user TEXT NOT NULL, started INTEGER NOT NULL, last_seen INTEGER NOT NULL, day TEXT NOT NULL, event_count INTEGER NOT NULL DEFAULT 0, replay_chunks INTEGER NOT NULL DEFAULT 0, replay_bytes INTEGER NOT NULL DEFAULT 0, duration INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 0, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, platform TEXT NOT NULL DEFAULT '', metadata TEXT NOT NULL DEFAULT '{}')`,
      `CREATE TABLE IF NOT EXISTS analytics_events (session TEXT NOT NULL, seq INTEGER NOT NULL, time INTEGER NOT NULL, user TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, area TEXT NOT NULL, board TEXT NOT NULL, details TEXT NOT NULL, PRIMARY KEY(session, seq))`,
      'CREATE INDEX IF NOT EXISTS analytics_events_time ON analytics_events(time)',
      'CREATE INDEX IF NOT EXISTS analytics_events_name ON analytics_events(name, time)',
      'CREATE INDEX IF NOT EXISTS analytics_events_user ON analytics_events(user, time)',
      'CREATE INDEX IF NOT EXISTS analytics_sessions_time ON analytics_sessions(started)',
      `CREATE TABLE IF NOT EXISTS analytics_replays (session TEXT NOT NULL, seq INTEGER NOT NULL, key TEXT NOT NULL, bytes INTEGER NOT NULL, created INTEGER NOT NULL, encoding TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session, seq))`,
      'CREATE INDEX IF NOT EXISTS analytics_replays_time ON analytics_replays(created)',
      'CREATE TABLE IF NOT EXISTS analytics_limits (user TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(user, minute))'
    ]) await db.prepare(query).run();
  })().catch(cause => { initialized.delete(db); throw cause; }));
  return initialized.get(db);
}
async function allowed(db, user, now, limit = 120) {
  const row = await db.prepare(`INSERT INTO analytics_limits(user, minute, count) VALUES (?, ?, 1) ON CONFLICT(user, minute) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`).bind(user, Math.floor(now / 60000), limit).first();
  if (!row) fail('Analytics rate limit reached.', 429);
}
async function session(db, id, user, now) {
  await db.prepare('INSERT OR IGNORE INTO analytics_sessions(id, user, started, last_seen, day) VALUES (?, ?, ?, ?, ?)').bind(id, user, now, now, new Date(now).toISOString().slice(0, 10)).run();
  const row = await db.prepare('SELECT * FROM analytics_sessions WHERE id = ? AND user = ?').bind(id, user).first();
  if (!row) fail('Session unavailable.', 403);
  return row;
}
async function events(request, env, user, now) {
  let input;
  try { input = JSON.parse(new TextDecoder().decode(await readBody(request, eventBytes))); }
  catch (cause) { if (cause.status) throw cause; fail('Invalid analytics batch.'); }
  const batch = validateBatch(input, now), db = env.DB;
  await session(db, batch.session, user, now);
  const writes = [];
  // Stay below D1's 100 bound parameters per statement and free-tier query limit per invocation.
  for (let offset = 0; offset < batch.events.length; offset += 10) {
    const rows = batch.events.slice(offset, offset + 10);
    writes.push(db.prepare(`INSERT OR IGNORE INTO analytics_events(session, seq, time, user, kind, name, area, board, details) VALUES ${rows.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}`)
      .bind(...rows.flatMap(event => [batch.session, event.seq, event.time, user, event.kind, event.name, event.area, event.board, JSON.stringify(event.details)])));
  }
  const start = batch.events.find(event => event.name === 'session_start'), progress = batch.events.filter(event => ['session_end', 'visibility', 'heartbeat'].includes(event.name)).at(-1)?.details || {};
  writes.push(db.prepare(`UPDATE analytics_sessions SET last_seen = ?, event_count = (SELECT COUNT(*) FROM analytics_events WHERE session = ?), duration = MAX(duration, ?), active = MAX(active, ?) WHERE id = ? AND user = ?`)
    .bind(now, batch.session, progress.duration || 0, progress.active || 0, batch.session, user));
  if (start) writes.push(db.prepare('UPDATE analytics_sessions SET width = ?, height = ?, platform = ?, metadata = ? WHERE id = ? AND user = ?')
    .bind(start.details.width || 0, start.details.height || 0, start.details.platform || '', JSON.stringify(start.details), batch.session, user));
  await db.batch(writes);
  return empty();
}
async function replay(request, env, user, id, seq, now) {
  const encoding = request.headers.get('Content-Encoding') || new URL(request.url).searchParams.get('encoding') || 'identity';
  if (!['gzip', 'identity'].includes(encoding)) fail('Unsupported replay encoding.', 415);
  const bytes = await readBody(request, replayBytes);
  if (!bytes.length) fail('Empty replay chunk.');
  // Replay is a byte stream of newline-delimited rrweb events; large snapshots span chunks.
  // Bound decompression even though chunks need not be independently parseable JSON.
  if (encoding === 'gzip') {
    try { await readBody(new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))), replayBytes); }
    catch (cause) { if (cause.status) throw cause; fail('Invalid replay compression.'); }
  }
  const db = env.DB, current = await session(db, id, user, now), key = replayKey(current.day, id, seq);
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO analytics_replays(session, seq, key, bytes, created, encoding) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM analytics_sessions WHERE id = ? AND user = ? AND replay_bytes + ? <= ?)`)
      .bind(id, seq, key, bytes.length, now, encoding, id, user, bytes.length, sessionReplayBytes),
    db.prepare(`UPDATE analytics_sessions SET replay_bytes = (SELECT COALESCE(SUM(bytes), 0) FROM analytics_replays WHERE session = ?) WHERE id = ? AND user = ?`).bind(id, id, user)
  ]);
  const chunk = await db.prepare('SELECT * FROM analytics_replays WHERE session = ? AND seq = ?').bind(id, seq).first();
  if (!chunk) fail('Session replay limit reached.', 413);
  if (chunk.bytes !== bytes.length || chunk.encoding !== encoding) fail('Replay sequence already reserved.', 409);
  if (!chunk.ready) {
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' }, onlyIf: { etagDoesNotMatch: '*' } });
    await db.batch([
      db.prepare('UPDATE analytics_replays SET ready = 1 WHERE session = ? AND seq = ?').bind(id, seq),
      db.prepare('UPDATE analytics_sessions SET last_seen = ?, replay_chunks = (SELECT COUNT(*) FROM analytics_replays WHERE session = ? AND ready = 1) WHERE id = ? AND user = ?').bind(now, id, id, user)
    ]);
  }
  return empty();
}
const rows = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results || [];
async function overview(env, url, now) {
  const days = Math.max(1, Math.min(180, Number(url.searchParams.get('days')) || 30)), cutoff = now - days * 86400000, db = env.DB;
  const [totals, daily, controls, rage, errors, generations, sessions, heatmap] = await Promise.all([
    db.prepare('SELECT COUNT(DISTINCT session) AS sessions, COUNT(DISTINCT user) AS users, COUNT(*) AS events FROM analytics_events WHERE time >= ?').bind(cutoff).first(),
    rows(db, `SELECT date(time/1000,'unixepoch') AS day, COUNT(*) AS events, COUNT(DISTINCT user) AS users, COUNT(DISTINCT session) AS sessions FROM analytics_events WHERE time >= ? GROUP BY day ORDER BY day`, cutoff),
    rows(db, `WITH controls AS (SELECT area, name, SUM(kind IN ('click','change')) AS clicks, SUM(kind='shortcut') AS shortcuts, COUNT(DISTINCT user) AS users FROM analytics_events WHERE time >= ? AND kind IN ('click','change','shortcut') GROUP BY area,name), ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY area ORDER BY clicks + shortcuts DESC) AS hi, ROW_NUMBER() OVER (PARTITION BY area ORDER BY clicks + shortcuts ASC) AS lo FROM controls) SELECT area,name,clicks,shortcuts,users FROM ranked WHERE hi <= 50 OR lo <= 50 ORDER BY clicks + shortcuts DESC LIMIT 5000`, cutoff),
    rows(db, 'SELECT name, area, COUNT(*) AS count, COUNT(DISTINCT user) AS users FROM analytics_events WHERE time >= ? AND kind = ? GROUP BY name,area ORDER BY count DESC LIMIT 100', cutoff, 'rage'),
    rows(db, "SELECT json_extract(details,'$.message') AS message, COUNT(*) AS count, COUNT(DISTINCT user) AS users FROM analytics_events WHERE time >= ? AND kind = 'error' GROUP BY message ORDER BY count DESC LIMIT 100", cutoff),
    rows(db, `SELECT json_extract(details,'$.generator') AS generator, SUM(name='generation_started') AS started, SUM(name='generation_finished') AS finished, SUM(name='generation_failed') AS failed, AVG(CASE WHEN name IN ('generation_finished','generation_failed') THEN json_extract(details,'$.duration') END) AS duration FROM analytics_events WHERE time >= ? AND name IN ('generation_started','generation_finished','generation_failed') GROUP BY generator`, cutoff),
    rows(db, 'SELECT id,user,started,last_seen,event_count,replay_chunks,replay_bytes,duration,active,width,height,platform FROM analytics_sessions WHERE last_seen >= ? ORDER BY started DESC LIMIT 100', cutoff),
    rows(db, `SELECT json_extract(details,'$.route') AS route, CASE WHEN json_extract(details,'$.width') < 768 THEN 'small' WHEN json_extract(details,'$.width') < 1280 THEN 'medium' ELSE 'large' END AS viewport, ROUND(json_extract(details,'$.x')*50)/50.0 AS x, ROUND(json_extract(details,'$.y')*50)/50.0 AS y, COUNT(*) AS count FROM analytics_events WHERE time >= ? AND kind='click' AND json_type(details,'$.x') IS NOT NULL GROUP BY route,viewport,x,y LIMIT 10000`, cutoff)
  ]);
  return json({ days, totals, daily, controls, rage, errors, generations, sessions, heatmap });
}
export async function analyticsRoute(request, env, user, url, store, now = Date.now()) {
  const path = url.pathname.slice('/api/analytics'.length), method = request.method;
  if (method !== 'GET' && method !== 'POST') fail('Method not allowed.', 405);
  if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') fail('Invalid origin.', 403);
  const admin = path !== '/events' && !path.startsWith('/replay/');
  if (admin && !await store.siteRole(user.email)) fail('Only site admins can view analytics.', 403);
  await analyticsSchema(env.DB);
  await allowed(env.DB, admin ? `${user.email}:admin` : user.email, now, admin ? 2000 : 120);
  if (path === '/events' && method === 'POST') return events(request, env, user.email, now);
  const upload = path.match(/^\/replay\/([^/]+)\/(\d+)$/);
  if (upload && method === 'POST' && sessionPattern.test(upload[1]) && replaySequence(upload[2]) !== null) return replay(request, env, user.email, upload[1], Number(upload[2]), now);
  if (method === 'GET' && path === '/overview') return overview(env, url, now);
  const selected = path.match(/^\/sessions\/([^/]+)(?:\/(\d+))?$/);
  if (selected && method === 'GET' && sessionPattern.test(selected[1])) {
    const id = selected[1];
    if (selected[2] !== undefined) {
      if (replaySequence(selected[2]) === null) fail('Chunk not found.', 404);
      const chunk = await env.DB.prepare('SELECT * FROM analytics_replays WHERE session = ? AND seq = ? AND ready = 1').bind(id, Number(selected[2])).first();
      const object = chunk && await env.FILES.get(chunk.key);
      if (!object) fail('Chunk not found.', 404);
      return new Response(chunk.encoding === 'gzip' ? object.body.pipeThrough(new DecompressionStream('gzip')) : object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    const after = url.searchParams.has('after') ? Math.max(-1, Math.min(1e9, Number(url.searchParams.get('after')) || 0)) : -1;
    return json({ session: await env.DB.prepare('SELECT * FROM analytics_sessions WHERE id = ?').bind(id).first(),
      events: await rows(env.DB, 'SELECT seq,time,kind,name,area,board,details FROM analytics_events WHERE session = ? AND seq > ? ORDER BY seq LIMIT 1000', id, after),
      chunks: await rows(env.DB, 'SELECT seq,bytes FROM analytics_replays WHERE session = ? AND ready = 1 ORDER BY seq', id) });
  }
  fail('Not found.', 404);
}
export async function purgeAnalytics(env, now = Date.now()) {
  await analyticsSchema(env.DB);
  const cutoff = retentionCutoffs(now);
  // Page through R2's lexically sorted date prefix, including orphaned uploads from failed DB writes.
  let cursor;
  do {
    const page = await env.FILES.list({ prefix: 'analytics/replays/', limit: 1000, ...(cursor ? { cursor } : {}) });
    const expired = page.objects.filter(object => object.uploaded ? new Date(object.uploaded).getTime() < cutoff.replays : object.key.slice(18, 28) < new Date(cutoff.replays).toISOString().slice(0, 10)).map(object => object.key);
    if (expired.length) await env.FILES.delete(expired);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM analytics_replays WHERE created < ?').bind(cutoff.replays),
    env.DB.prepare('DELETE FROM analytics_events WHERE time < ?').bind(cutoff.events),
    env.DB.prepare('DELETE FROM analytics_sessions WHERE last_seen < ?').bind(cutoff.events),
    env.DB.prepare('DELETE FROM analytics_limits WHERE minute < ?').bind(Math.floor(now / 60000) - 2),
    env.DB.prepare('UPDATE analytics_sessions SET replay_chunks = (SELECT COUNT(*) FROM analytics_replays WHERE session = analytics_sessions.id AND ready = 1), replay_bytes = (SELECT COALESCE(SUM(bytes),0) FROM analytics_replays WHERE session = analytics_sessions.id) WHERE started < ?').bind(cutoff.replays)
  ]);
}
