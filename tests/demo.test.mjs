import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importBoardArchive } from '../board-archive.mjs';

test('the reviewed public demo imports with all images, branches and completed history', async t => {
  const archive = await readFile(new URL('../examples/courier-robot.conceptgraph', import.meta.url));
  const expected = (await readFile(new URL('../examples/courier-robot.sha256', import.meta.url), 'utf8')).split(/\s+/)[0];
  assert.equal(createHash('sha256').update(archive).digest('hex'), expected);
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-public-demo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const board = await importBoardArchive(archive, directory);
  assert.equal(board.name, 'Demo · Courier robot');
  assert.equal(board.graph.nodes.length, 6); assert.equal(board.graph.edges.length, 5);
  assert.equal(board.assets.length, 3); assert.equal(board.graph.runs.length, 3);
  assert.ok(board.graph.runs.every(run => run.status === 'completed' && run.outputIds.length === 1));
  const branches = board.graph.runs.filter(run => run.images.length);
  assert.equal(branches.length, 2); assert.deepEqual(branches[0].images, branches[1].images);
  assert.doesNotMatch(JSON.stringify(board.graph), /\/Users\/|\/private\/|knifest|access_token|refresh_token|api_key/i);
});
