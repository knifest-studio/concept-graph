import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { boardStats } from '../cloud/board-stats.mjs';
import { applyLocalGraph } from '../src/cloud-sync.mjs';
import { boardFromPath, boardPath, coverHue, relativeTime, signInReturn } from '../src/cloud-boards.mjs';

test('board covers use the latest four distinct valid image assets from a Yjs snapshot', () => {
  const doc = new Y.Doc(), restored = new Y.Doc();
  try {
    const asset = index => `${String(index).padStart(36, '0')}.png`;
    const nodes = Array.from({ length: 6 }, (_, index) => ({ id: `i${index}`, type: 'image', position: { x: 0, y: 0 }, data: { asset: asset(index), createdAt: `2026-11-03T10:0${index}:00Z` } }));
    nodes.push({ ...nodes[5], id: 'duplicate' }, { ...nodes[0], id: 'invalid', data: { asset: '../../private', createdAt: '2026-11-03T11:00:00Z' } }, { ...nodes[0], id: 'missing', data: {} }, { ...nodes[0], id: 'text', type: 'text' });
    applyLocalGraph(doc, { nodes, edges: [], groups: [], runs: [] }, {}, 'test');
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
    assert.deepEqual(boardStats(restored), { imageCount: 9, covers: [5, 4, 3, 2].map(asset) });
    restored.getMap('nodes').clear();
    assert.deepEqual(boardStats(restored), { imageCount: 0, covers: [] });
  } finally { doc.destroy(); restored.destroy(); }
});

test('undated images remain valid covers and malformed nodes cannot break metadata saves', () => {
  const doc = new Y.Doc();
  try {
    const asset = '00000000-0000-0000-0000-000000000000.webp';
    doc.getMap('nodes').set('invalid', 'not a node');
    applyLocalGraph(doc, { nodes: [{ id: 'image', type: 'image', position: { x: 0, y: 0 }, data: { asset } }], edges: [], groups: [], runs: [] }, {}, 'test');
    assert.deepEqual(boardStats(doc), { imageCount: 1, covers: [asset] });
  } finally { doc.destroy(); }
});

test('relative times handle boundaries, old data, future clocks and invalid dates', () => {
  const now = Date.parse('2026-11-03T12:00:00Z'), ago = seconds => new Date(now - seconds * 1000).toISOString();
  for (const [seconds, expected] of [[0, 'just now'], [59, 'just now'], [60, '1 minute ago'], [300, '5 minutes ago'], [3600, '1 hour ago'], [86400, '1 day ago'], [2592000, '1 month ago'], [31536000, '1 year ago']]) assert.equal(relativeTime(ago(seconds), now), expected);
  assert.equal(relativeTime(ago(-300), now), 'just now');
  assert.equal(relativeTime('invalid', now), 'recently');
  assert.equal(coverHue('board-id'), coverHue('board-id'));
  assert.ok(coverHue('board-id') >= 0 && coverHue('board-id') < 360);
});

test('board links put the board in the URL and only a board link can be a sign-in return path', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(boardPath(id), `/b/${id}`);
  for (const [path, expected] of [[`/b/${id}`, id], [`/b/${id}/`, id], ['/b/caf%C3%A9', 'café'], ['/', null], ['/b/', null], ['/b', null], [`/b/${id}/extra`, null], [`/boards/${id}`, null], ['/b/%E0%A4%A', null], [`/x/b/${id}`, null]]) {
    assert.equal(boardFromPath(path), expected, path);
  }
  assert.equal(boardFromPath(boardPath(id)), id);
  for (const value of [`/b/${id}`]) assert.equal(signInReturn(value), value);
  for (const value of [undefined, null, '', '/', '//evil.example', 'https://evil.example/b/' + id, `/b/${id}/`, `/b/${id}?x=1`, `/b/${id.toUpperCase()}`, '/b/not-a-board', `/b/${id}/../api`]) assert.equal(signInReturn(value), '/', String(value));
});
