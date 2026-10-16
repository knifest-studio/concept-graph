import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBoard, loadWorkspace, writeWorkspace, boardName } from '../workspace.mjs';
import { edgeDropCreatesPrompt } from '../src/canvas.mjs';

test('legacy migration preserves every node, edge, run and viewport and is idempotent', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-board-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const graph = { revision: 24, nodes: [{ id: 'original', type: 'text', position: { x: 23, y: -42 }, data: { text: 'Keep my exact text' } }, { id: 'image', type: 'image', position: { x: 99, y: 40 }, data: { asset: '12345678-1234-1234-1234-123456789abc.png', label: 'Original' } }], edges: [{ id: 'edge', source: 'original', target: 'image' }], runs: [{ id: 'history', status: 'completed', snapshot: ['unchanged'] }], viewport: { x: 15, y: -30, zoom: 0.6 } };
  const legacyBytes = JSON.stringify(graph);
  await writeFile(path.join(directory, 'canvas.json'), legacyBytes);
  const workspace = await loadWorkspace(directory);
  assert.deepEqual(workspace.boards[0].graph, graph);
  assert.equal(workspace.boards[0].name, 'My concepts');
  workspace.boards.push(createBoard('Test board'));
  workspace.boards[1].graph.nodes.push({ ...graph.nodes[0], data: { text: 'Independent edits' } });
  await writeWorkspace(directory, workspace);
  const reloaded = await loadWorkspace(directory);
  assert.deepEqual(reloaded, workspace);
  assert.deepEqual(reloaded.boards[0].graph, graph);
  assert.equal(await readFile(path.join(directory, 'canvas.json'), 'utf8'), legacyBytes);
});

test('corrupt storage is rejected without replacing it; board names are validated', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-board-corrupt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'workspace.json');
  await writeFile(file, '{broken');
  await assert.rejects(loadWorkspace(directory), /no data was overwritten/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
  assert.throws(() => boardName('  '));
  assert.throws(() => boardName('x'.repeat(81)));
  assert.equal(boardName('  Characters  '), 'Characters');
});

test('text and image output drops on empty canvas create prompts without duplicates', () => {
  for (const type of ['text', 'image']) {
    const state = { isValid: false, toNode: null, fromHandle: { type: 'source' }, fromNode: { id: type, type } };
    assert.equal(edgeDropCreatesPrompt(state, true), true);
    assert.equal(edgeDropCreatesPrompt(state, false), false);
    assert.equal(edgeDropCreatesPrompt({ ...state, isValid: true }, true), false);
    assert.equal(edgeDropCreatesPrompt({ ...state, toNode: { id: 'target' } }, true), false);
    assert.equal(edgeDropCreatesPrompt({ ...state, fromHandle: { type: 'target' } }, true), false);
    assert.equal(edgeDropCreatesPrompt({ ...state, fromNode: { type: 'group' } }, true), false);
    assert.equal(edgeDropCreatesPrompt({ ...state, fromNode: undefined }, true), false);
  }
});
