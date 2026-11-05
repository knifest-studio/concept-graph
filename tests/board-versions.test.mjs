import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import * as Y from 'yjs';
import { expiredVersions, keyOf, pack, removedMany, restoreDocument, shownVersion, unpack, versionEvery, versionMetadata } from '../cloud/versions.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';

// Only the Cloudflare base class is replaced; the room, Yjs and SQL run for real against an in-memory R2.
let DatabaseSync, BoardRoom, Directory, purgeTrash;
if (nodeModule.registerHooks) {
  ({ DatabaseSync } = await import('node:sqlite'));
  const hooks = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== 'cloudflare:workers') return nextResolve(specifier, context);
      return { url: 'data:text/javascript,' + encodeURIComponent('export const env = {}; export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), shortCircuit: true };
    }
  });
  try { ({ BoardRoom, Directory } = await import('../cloud/worker.mjs')); ({ purgeTrash } = await import('../cloud/trash.mjs')); }
  finally { hooks.deregister(); }
}
const runtimeTest = nodeModule.registerHooks ? test : test.skip;
const hour = 60 * 60 * 1000, day = 24 * hour;

function bucket() {
  const objects = new Map();
  return { objects,
    async put(key, body, { customMetadata = {} } = {}) { objects.set(key, { key, body: new Uint8Array(body), customMetadata, uploaded: new Date() }); },
    async get(key) { const object = objects.get(key); return object ? { ...object, arrayBuffer: async () => object.body.slice().buffer } : null; },
    async list({ prefix }) { return { objects: [...objects.values()].filter(object => object.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key)), truncated: false }; },
    async delete(keys) { for (const key of [keys].flat()) objects.delete(key); },
  };
}

const node = (id, extra = {}) => ({ id, type: 'text', position: { x: 0, y: 0 }, data: { text: id }, ...extra });
const graph = nodes => ({ nodes, edges: [], groups: [], runs: [] });

async function openRoom(t, files = bucket()) {
  const values = new Map(), alarms = [];
  const storage = { kv: { get: key => values.get(key), put: (key, value) => values.set(key, structuredClone(value)), delete: key => values.delete(key) }, transactionSync: callback => callback(),
    get: async key => values.get(key), put: async (key, value) => { values.set(key, value); }, getAlarm: async () => alarms.at(-1) ?? null, setAlarm: async at => { alarms.push(at); }, deleteAll: async () => values.clear() };
  const directory = { updateBoardStats() {}, libraryFor: async () => [] };
  const created = new BoardRoom({ storage, id: { name: 'board-1' }, waitUntil() {}, blockConcurrencyWhile: callback => callback(), getWebSockets: () => [] }, { FILES: files, Directory: { idFromName: name => name, get: () => directory } });
  await created.onStart();
  created.getConnections = () => [];
  t.after(() => { created.deleted = true; created.document.destroy(); });
  return { room: created, values, alarms, files };
}

test('versions are kept every day for a day, then hourly for two weeks and daily for 90 days', () => {
  const now = Date.UTC(2026, 10, 5, 12), at = (ago, reason = 'auto') => ({ key: `${ago}-${reason}`, at: now - ago, reason });
  const entries = [at(hour), at(2 * hour), at(25 * hour), at(25 * hour + 60000), at(26 * hour), at(20 * day), at(20 * day + 60000), at(91 * day),
    at(10 * day + 30000, 'before-delete'), at(31 * day, 'before-restore'), at(31 * day - 60000)];
  // Copies made before a deletion or a restore stay 30 days, then count as that day's version like any other.
  assert.deepEqual(expiredVersions(entries, now).sort(), [`${26 * hour}-auto`, `${20 * day + 60000}-auto`, `${91 * day}-auto`, `${31 * day}-before-restore`].sort());
  assert.equal(removedMany(30, 10), true); assert.equal(removedMany(100, 85), false); assert.equal(removedMany(8, 4), true); assert.equal(removedMany(4, 0), false); assert.equal(removedMany(undefined, 0), false);
  // Version IDs name only this board's versions and backups.
  assert.equal(keyOf('b', '1762340000000-auto'), 'versions/b/1762340000000-auto');
  assert.equal(keyOf('b', 'daily-2026-11-05'), 'backups/b/2026-11-05');
  for (const id of ['../other/1762340000000-auto', '1762340000000-auto/x', '1762340000000-other', 'daily-2026-11-5', 42]) assert.equal(keyOf('b', id), null);
  // Metadata keeps display names only, and at most ten of them.
  const meta = versionMetadata({ reason: 'auto', stats: { nodes: 3, imageCount: 1, covers: ['a.png'] }, editors: [...Array.from({ length: 12 }, (_, index) => `Person ${index}`), 'Person 0', ''] });
  assert.deepEqual(shownVersion({ key: 'versions/b/1762340000000-auto', customMetadata: meta }), { id: '1762340000000-auto', at: new Date(1762340000000).toISOString(), reason: 'auto', nodes: 3, images: 1, covers: ['a.png'], editors: Array.from({ length: 10 }, (_, index) => `Person ${index}`) });
  assert.equal(shownVersion({ key: 'versions/b/notes.txt' }), null);
});

test('a restore brings back what was deleted, removes what was added and never shrinks generation history', async () => {
  const live = new Y.Doc(), old = new Y.Doc();
  applyLocalGraph(live, { ...graph([node('a'), node('b', { data: { text: 'first' } }), node('d')]), runs: [{ id: 'run-1', status: 'completed' }] }, {}, 'test');
  Y.applyUpdate(old, await unpack(await pack(Y.encodeStateAsUpdate(live))));
  const before = readCloudGraph(live);
  applyLocalGraph(live, { ...graph([node('b', { data: { text: 'changed' } }), node('c'), node('d')]), runs: [{ id: 'run-1', status: 'completed' }, { id: 'run-2', status: 'completed' }] }, before, 'test');
  const untouched = live.getMap('nodes').get('d');
  const changed = restoreDocument(live, old, 'restore');
  const restored = readCloudGraph(live);
  assert.deepEqual(restored.nodes.map(item => [item.id, item.data.text]).sort(), [['a', 'a'], ['b', 'first'], ['d', 'd']]);
  assert.deepEqual(restored.runs.map(run => run.id).sort(), ['run-1', 'run-2']);
  assert.equal(changed, 3);
  // What did not change is left as it is, so a teammate working on it is not interrupted.
  assert.equal(live.getMap('nodes').get('d'), untouched);
  // Restoring the same version again changes nothing.
  assert.equal(restoreDocument(live, old, 'restore'), 0);
});

runtimeTest('the room keeps versions while the board changes, before a large deletion and before a restore', async t => {
  const { room, values, alarms, files } = await openRoom(t);
  const versions = () => [...files.objects.keys()].filter(key => key.startsWith('versions/'));
  room.document.transact(() => applyLocalGraph(room.document, graph(Array.from({ length: 30 }, (_, index) => node(`n${index}`))), {}, 'test'), { state: { name: 'Alice' } });
  await room.onSave();
  // The first change is kept at once, and it is also the day's backup.
  assert.equal(versions().length, 1);
  assert.deepEqual([...files.objects.keys()].filter(key => key.startsWith('backups/')), [`backups/board-1/${new Date().toISOString().slice(0, 10)}`]);
  const [first] = await room.listVersions();
  assert.deepEqual({ ...first, at: 0, id: first.id.split('-')[1] }, { id: 'auto', at: 0, reason: 'auto', nodes: 30, images: 0, covers: [], editors: ['Alice'] });
  // Within ten minutes another change waits for an alarm, which takes the version once edits stop.
  room.document.transact(() => room.document.getMap('nodes').get('n0').get('data').set('text', 'renamed'), { state: { name: 'Bob' } });
  await room.onSave();
  assert.equal(versions().length, 1);
  assert.ok(alarms.at(-1) > Date.now() + versionEvery - 60000);
  values.set('version:at', Date.now() - versionEvery);
  await room.onAlarm();
  assert.equal(versions().length, 2);
  assert.deepEqual((await room.listVersions())[0].editors, ['Bob']);
  assert.equal([...files.objects.keys()].filter(key => key.startsWith('backups/')).length, 1);
  // Deleting most of the board keeps it as it was a moment before, with who deleted.
  const kept = readCloudGraph(room.document);
  room.document.transact(() => applyLocalGraph(room.document, graph(kept.nodes.slice(0, 5)), kept, 'test'), { state: { name: 'Mallory' } });
  await room.onSave();
  const deletion = (await room.listVersions()).find(version => version.reason === 'before-delete');
  assert.deepEqual({ nodes: deletion.nodes, by: deletion.by, removed: deletion.removed }, { nodes: 30, by: ['Mallory'], removed: 25 });
  // Restoring brings everything back for everyone and keeps the board as it was just before.
  assert.equal(room.document.getMap('nodes').size, 5);
  const restored = await room.restoreVersion({ id: deletion.id, user: { name: 'Carol', email: 'carol@studio.example' } });
  assert.equal(restored.restored.id, deletion.id); assert.ok(restored.restored.changed >= 25);
  assert.equal(room.document.getMap('nodes').size, 30);
  assert.equal(room.document.getMap('nodes').get('n0').get('data').get('text'), 'renamed');
  const listed = await room.listVersions();
  assert.equal(listed.filter(version => version.reason === 'before-restore').length, 1);
  assert.equal(listed.filter(version => version.reason === 'before-delete').length, 1);
  assert.deepEqual(listed.find(version => version.reason === 'before-restore').by, ['Carol']);
  assert.deepEqual(await room.restoreVersion({ id: '../board-2/1762340000000-auto', user: { name: 'Carol' } }), { error: 'Version not found.', status: 404 });
  assert.deepEqual(await room.restoreVersion({ id: '1762340000000-auto', user: { name: 'Carol' } }), { error: 'Version not found.', status: 404 });
  // Erasing a board from the trash removes its versions; daily backups stay until they expire.
  await room.destroy();
  assert.deepEqual(versions(), []);
  assert.equal([...files.objects.keys()].filter(key => key.startsWith('backups/')).length, 1);
});

runtimeTest('boards leave the trash for good after 30 days', async t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql = { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  const directory = new Directory({ storage: { sql } }, {}), destroyed = [];
  const old = directory.createBoard('Old', { email: 'owner@studio.example', name: 'Owner' }), recent = directory.createBoard('Recent', { email: 'owner@studio.example', name: 'Owner' });
  directory.trashBoard(old.id, 'owner@studio.example'); directory.trashBoard(recent.id, 'owner@studio.example');
  database.prepare('UPDATE boards SET deletedAt = ? WHERE id = ?').run(new Date(Date.now() - 31 * day).toISOString(), old.id);
  assert.deepEqual(directory.trashFor('owner@studio.example').map(board => board.name), ['Recent']);
  assert.deepEqual(directory.restoreBoard(old.id, 'owner@studio.example'), { error: 'This board is no longer in Recently deleted.', status: 404 });
  await purgeTrash({ Directory: { idFromName: name => name, get: () => directory }, BoardRoom: { idFromName: name => name, get: name => ({ setName: async () => {}, destroy: async () => { destroyed.push(name); } }) } });
  assert.deepEqual(destroyed, [old.id]);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM boards WHERE id = ?').get(old.id).count, 0);
  assert.deepEqual(directory.trashFor('owner@studio.example').map(board => board.name), ['Recent']);
});
