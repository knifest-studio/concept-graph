import test from 'node:test';
import assert from 'node:assert/strict';
import { soundPreferenceKey, readSoundPreference, writeSoundPreference, eventOnce } from '../src/sounds.mjs';
import * as Y from 'yjs';
import { applyLocalGraph } from '../src/cloud-sync.mjs';
import { newOutputIds, cloudFeedback } from '../src/feedback.mjs';

const output = (id, runId = 'r') => ({ id, type: 'image', data: { runId, asset: `${id}.png` } });
const run = ids => [{ id: 'r', outputIds: ids }];

test('sounds default on, persist off/on per viewer, and tolerate unavailable storage', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const key = soundPreferenceKey('cloud:me');
  assert.equal(readSoundPreference(storage, key), true);
  writeSoundPreference(storage, key, false);
  assert.equal(readSoundPreference(storage, key), false);
  assert.equal(readSoundPreference(storage, soundPreferenceKey('cloud:other')), true);
  writeSoundPreference(storage, key, true);
  assert.equal(readSoundPreference(storage, key), true);
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.equal(readSoundPreference(blocked, key), true);
  assert.doesNotThrow(() => writeSoundPreference(blocked, key, false));
  assert.equal(readSoundPreference(null, key), true);
});

test('event IDs dedupe repeated notifications and first-image sound independently per run and event', () => {
  const seen = new Set();
  for (const id of ['start:attempt', 'arrival:r', 'error:r', 'arrival:r2']) {
    assert.equal(eventOnce(seen, id), true);
    assert.equal(eventOnce(seen, id), false);
  }
});

test('outputs animate only on live arrival, once per ID, including progressive outputs', () => {
  const seen = new Set();
  assert.deepEqual(newOutputIds(seen, [output('old')], run(['old']), false), []);
  assert.deepEqual(newOutputIds(seen, [output('old'), output('first')], run(['old', 'first']), true), ['first']);
  assert.deepEqual(newOutputIds(seen, [output('first'), output('second')], run(['first', 'second']), true), ['second']);
  assert.deepEqual(newOutputIds(seen, [output('first'), output('second')], run(['first', 'second']), true), []);
});

test('load/reconnect, undo, thumbnail changes, and duplicated run references never replay arrival', () => {
  const seen = new Set();
  newOutputIds(seen, [output('old')], run(['old']), false);
  assert.deepEqual(newOutputIds(seen, [output('old'), output('offline')], run(['old', 'offline']), false), []);
  newOutputIds(seen, [], run([]), true);
  assert.deepEqual(newOutputIds(seen, [output('old'), output('offline')], run(['old', 'offline']), true), []);
  assert.deepEqual(newOutputIds(seen, [{ ...output('old'), data: { runId: 'r', asset: 'thumbnail' } }], run(['old']), true), []);
  const paste = output('copy');
  assert.deepEqual(newOutputIds(seen, [paste, { id: 'ref', type: 'image', data: {} }, { id: 'prompt', type: 'text', data: {} }], run(['old']), true), []);
  assert.deepEqual(newOutputIds(seen, [paste], run(['copy']), true), []);
});

test('cloud feedback identifies the live author and suppresses initial sync, reconnect and local undo attribution', () => {
  const remote = new Y.Doc(), local = new Y.Doc(), user = { name: 'Teammate', color: '#ac73ed' };
  const provider = { synced: true, wsconnected: true, awareness: { getStates: () => new Map([[remote.clientID, { user }]]) } };
  const empty = { nodes: [], edges: [], groups: [], runs: [] };
  const origin = {}, undo = new Y.UndoManager(local.getMap('nodes'), { trackedOrigins: new Set([origin]) });
  const events = [];
  local.on('afterTransaction', transaction => events.push(transaction));
  applyLocalGraph(remote, { ...empty, nodes: [{ id: 'peer', type: 'text', position: { x: 0, y: 0 }, data: { text: 'Hello' } }] }, empty, {});
  Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
  const incoming = events.at(-1);
  assert.deepEqual(cloudFeedback(incoming, provider, local.clientID, true), { live: true, peer: user });
  assert.equal(cloudFeedback(incoming, provider, local.clientID, false).live, false);
  assert.equal(cloudFeedback(incoming, { ...provider, synced: false }, local.clientID, true).live, false);
  assert.equal(cloudFeedback(incoming, { ...provider, wsconnected: false }, local.clientID, true).live, false);
  local.transact(() => local.getMap('nodes').delete('peer'), origin);
  undo.undo();
  assert.equal(cloudFeedback(events.at(-1), provider, local.clientID, true).peer, null);
  undo.destroy(); remote.destroy(); local.destroy();
});
