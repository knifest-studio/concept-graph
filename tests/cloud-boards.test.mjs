import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { boardStats } from '../cloud/board-stats.mjs';
import { applyLocalGraph } from '../src/cloud-sync.mjs';
import { boardFromPath, boardPath, coverHue, nodeFromHash, nodePath, relativeTime, signInReturn } from '../src/cloud-boards.mjs';

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

test('node links encode IDs as one fragment value without changing the board route', () => {
  const board = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(nodePath(board, 'image-1'), `/b/${board}#node=image-1`);
  for (const id of ['image-1', 'нода 🎨', 'a&node=b#c?d/e+f%=g', "!~*'()._-", 'x'.repeat(120), 'н'.repeat(120)]) {
    const url = new URL(nodePath(board, id), 'https://cloud.example');
    assert.equal(url.origin, 'https://cloud.example'); assert.equal(url.search, '');
    assert.equal(boardFromPath(url.pathname), board); assert.equal(nodeFromHash(url.hash), id);
    assert.equal(signInReturn(url.pathname + url.hash), url.pathname + url.hash);
  }
});

test('node fragments reject empty, ambiguous, malformed and oversized values', () => {
  for (const hash of [undefined, null, 42, '', '#', '#other=x', '#node=', '#node=a&node=b', '#node=a#node=b', '#node=a?x=y', '#node=%', '#node=%GG', '#node=%E0%A4%A', '#node=%FF', '#node=x\n', '#node=' + 'x'.repeat(121), '#node=' + '%41'.repeat(1500)]) assert.equal(nodeFromHash(hash), null, String(hash));
});

test('sign-in accepts only a valid node fragment on a same-site board path', () => {
  const path = '/b/0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(signInReturn(path + '#node=a%26b'), path + '#node=a%26b');
  for (const value of ['https://evil.example' + path + '#node=x', '//evil.example' + path + '#node=x', '/\\evil.example' + path + '#node=x', path + '?next=//evil.example#node=x', path + '/#node=x', path + '#other=x', path + '#node=', path + '#node=%ZZ', path + '#node=x#other=y', path + '#node=x\r\nLocation: evil', path + '\n#node=x', path + '#node=' + 'x'.repeat(121)]) assert.equal(signInReturn(value), '/', value);
});
