import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'concept-readmes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts')); await mkdir(path.join(root, 'docs'));
  await copyFile(new URL('../scripts/check-readmes.mjs', import.meta.url), path.join(root, 'scripts/check-readmes.mjs'));
  const recorded = {};
  for (const [name, text] of [['README.md', 'English instructions'], ['README.uk.md', 'Українські інструкції']]) {
    await writeFile(path.join(root, name), text);
    recorded[name] = createHash('sha256').update(text).digest('hex');
  }
  await writeFile(path.join(root, 'docs/readme-sync.json'), JSON.stringify(recorded));
  return { root, run: (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/check-readmes.mjs'), ...args], { encoding: 'utf8' }) };
}

test('recorded bilingual instructions pass without Git history', async t => {
  const { run } = await fixture(t);
  assert.equal(run().status, 0);
});

test('English-only edits fail checking and cannot be marked translated', async t => {
  const { root, run } = await fixture(t), record = path.join(root, 'docs/readme-sync.json');
  const before = await readFile(record, 'utf8');
  await writeFile(path.join(root, 'README.md'), 'Changed install instructions');
  assert.notEqual(run().status, 0);
  const update = run('--update');
  assert.notEqual(update.status, 0); assert.match(update.stderr, /Update README.uk.md/);
  assert.equal(await readFile(record, 'utf8'), before);
});

test('paired edits stay stale until reviewed and explicitly recorded', async t => {
  const { root, run } = await fixture(t);
  await writeFile(path.join(root, 'README.md'), 'Updated install instructions');
  await writeFile(path.join(root, 'README.uk.md'), 'Оновлені інструкції зі встановлення');
  assert.notEqual(run().status, 0);
  assert.equal(run('--update').status, 0);
  assert.equal(run().status, 0);
});

test('a Ukrainian-only language correction can be recorded', async t => {
  const { root, run } = await fixture(t);
  await writeFile(path.join(root, 'README.uk.md'), 'Виправлені українські інструкції');
  assert.notEqual(run().status, 0);
  assert.equal(run('--update').status, 0);
  assert.equal(run().status, 0);
});
