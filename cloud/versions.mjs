import * as Y from 'yjs';

// A board's history: the room copies the whole document to R2 every ten minutes while it changes, and at once before a
// large deletion or a restore. The first copy each day also goes to backups/, which a bucket lock keeps from being
// deleted or overwritten for 30 days (see docs/cloud-preview.md).
export const versionEvery = 10 * 60 * 1000;
const hour = 60 * 60 * 1000, day = 24 * hour;
export const reasons = ['auto', 'before-delete', 'before-restore'];
const kept = new Set(['before-delete', 'before-restore']);
const versionId = /^(\d{13})-(auto|before-delete|before-restore)$/, backupId = /^daily-(\d{4}-\d{2}-\d{2})$/;

export const versionKey = (board, at, reason) => `versions/${board}/${String(at).padStart(13, '0')}-${reason}`;
export const backupKey = (board, at) => `backups/${board}/${new Date(at).toISOString().slice(0, 10)}`;
export const versionPrefixes = board => [`versions/${board}/`, `backups/${board}/`];

// The R2 key a version ID names on this board; null for anything else.
export function keyOf(board, id) {
  if (typeof id !== 'string') return null;
  const version = versionId.exec(id), backup = backupId.exec(id);
  return version ? `versions/${board}/${id}` : backup ? `backups/${board}/${backup[1]}` : null;
}

// Deleting many nodes at once (a page, a section, select-all) saves the board as it was just before.
export const removedMany = (before, after) => Number.isInteger(before) && (before - after >= 20 || (before >= 6 && after * 2 <= before));

const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
export const pack = bytes => pipe(bytes, new CompressionStream('gzip'));
export const unpack = bytes => pipe(bytes, new DecompressionStream('gzip'));

// R2 metadata holds strings only. Names, never emails: everyone on the board may read the history.
const names = list => JSON.stringify([...new Set(list)].filter(name => typeof name === 'string' && name).slice(0, 10).map(name => name.slice(0, 40)));
export function versionMetadata({ reason, stats = {}, editors = [], by, removed }) {
  return { reason, nodes: String(stats.nodes ?? 0), images: String(stats.imageCount ?? 0), covers: JSON.stringify((stats.covers || []).slice(0, 4)), editors: names(editors),
    ...(by ? { by: names(by) } : {}), ...(Number.isInteger(removed) ? { removed: String(removed) } : {}) };
}

const list = value => { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []; } catch { return []; } };
const count = value => Math.max(0, Number.parseInt(value, 10) || 0);

// One listed R2 object as people see it; null for anything that is not a version.
export function shownVersion(object) {
  const name = object.key.split('/').pop(), meta = object.customMetadata || {};
  const version = object.key.startsWith('versions/') && versionId.exec(name), daily = object.key.startsWith('backups/') && /^\d{4}-\d{2}-\d{2}$/.test(name);
  if (!version && !daily) return null;
  const at = version ? Number(version[1]) : (object.uploaded ? new Date(object.uploaded).getTime() : Date.parse(`${name}T00:00:00Z`));
  return { id: version ? name : `daily-${name}`, at: new Date(at).toISOString(), reason: version ? version[2] : 'daily', nodes: count(meta.nodes), images: count(meta.images),
    covers: list(meta.covers).slice(0, 4), editors: list(meta.editors), ...(meta.by ? { by: list(meta.by) } : {}), ...(meta.removed ? { removed: count(meta.removed) } : {}) };
}

export async function listAll(bucket, prefix) {
  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor, include: ['customMetadata'] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

// Every version from the last day; then the latest of each hour for two weeks and of each day for 90 days. Copies made
// before a deletion or a restore stay 30 days. Daily backups expire by a bucket lifecycle rule, not here.
export function expiredVersions(entries, now = Date.now()) {
  const keep = new Set(), buckets = new Set();
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const age = now - entry.at;
    if (age > 90 * day) continue;
    if (age < day || (kept.has(entry.reason) && age < 30 * day)) { keep.add(entry.key); continue; }
    const bucket = age < 14 * day ? `h${Math.floor(entry.at / hour)}` : `d${Math.floor(entry.at / day)}`;
    if (!buckets.has(bucket)) { buckets.add(bucket); keep.add(entry.key); }
  }
  return entries.filter(entry => !keep.has(entry.key)).map(entry => entry.key);
}

// What a restore puts back. Generation history only grows: runs missing from the live board return, and none are removed.
export const restoredMaps = ['nodes', 'edges', 'groups', 'pages', 'sections', 'templates'];

const plain = value => value instanceof Y.AbstractType ? value.toJSON() : value;
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const same = (a, b) => stable(plain(a)) === stable(plain(b));

// Shared types cannot move between documents, so a restored node is rebuilt in the live one.
function copy(value) {
  if (value instanceof Y.Map) { const map = new Y.Map(); for (const [key, item] of value) map.set(key, copy(item)); return map; }
  if (value instanceof Y.Array) { const array = new Y.Array(); array.push(value.toArray().map(copy)); return array; }
  if (value instanceof Y.Text) { const text = new Y.Text(); text.applyDelta(value.toDelta()); return text; }
  return value;
}

// Makes the live board match the snapshot in one transaction that reaches everyone connected. Unchanged entries are left
// alone, so a teammate's selection or edit elsewhere survives. Returns how many entries changed.
export function restoreDocument(live, snapshot, origin) {
  let changed = 0;
  live.transact(() => {
    for (const name of restoredMaps) {
      const target = live.getMap(name), source = snapshot.getMap(name);
      for (const key of [...target.keys()]) if (!source.has(key)) { target.delete(key); changed++; }
      for (const [key, value] of source) if (!target.has(key) || !same(target.get(key), value)) { target.set(key, copy(value)); changed++; }
    }
    const runs = live.getMap('runs');
    for (const [key, value] of snapshot.getMap('runs')) if (!runs.has(key)) { runs.set(key, copy(value)); changed++; }
  }, origin);
  return changed;
}
