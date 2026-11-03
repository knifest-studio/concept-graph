import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cloudDownloadUploads } from '../scripts/upload-cloud-downloads.mjs';
import { helperDownloadEntry } from '../scripts/helper-build.mjs';

const manifestName = 'concept-graph-helper-downloads.json';

test('upload preflight targets remote R2 with the correct filename, file and MIME type', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-upload-test-'));
  try {
    await assert.rejects(cloudDownloadUploads(temp), /No helper downloads/);
    const manifest = {};
    for (const [platform, file, type] of [['macos-arm64', 'Concept-Graph-Helper-macos-arm64.dmg', 'application/x-apple-diskimage'], ['macos-x64', 'Concept-Graph-Helper-macos-x64.dmg', 'application/x-apple-diskimage'], ['windows-x64', 'Concept-Graph-Helper-windows-x64-setup.exe', 'application/vnd.microsoft.portable-executable']]) {
      await writeFile(path.join(temp, file), 'artifact');
      manifest[platform] = helperDownloadEntry(platform, Buffer.from('artifact'));
      await writeFile(path.join(temp, manifestName), JSON.stringify(manifest));
      const commands = await cloudDownloadUploads(temp);
      assert.deepEqual(commands.find(args => args[3] === `concept-graph-files/downloads/${file}`), ['r2', 'object', 'put', `concept-graph-files/downloads/${file}`, '--file', path.join(temp, file), '--content-type', type, '--remote', '-c', 'cloud/wrangler.jsonc']);
      assert.deepEqual(commands.at(-1), ['r2', 'object', 'put', `concept-graph-files/downloads/${manifestName}`, '--file', path.join(temp, manifestName), '--content-type', 'application/json', '--remote', '-c', 'cloud/wrangler.jsonc']);
    }
    assert.equal((await cloudDownloadUploads(temp)).length, 4);
    const obsolete = path.join(temp, 'Concept-Graph-Helper-windows-x64.zip');
    await writeFile(obsolete, 'old archive');
    await assert.rejects(cloudDownloadUploads(temp), /Unexpected helper download: Concept-Graph-Helper-windows-x64.zip/);
    await rm(obsolete);
    await writeFile(path.join(temp, 'private.txt'), 'not a download');
    await assert.rejects(cloudDownloadUploads(temp), /Unexpected helper download: private.txt/);
    await rm(path.join(temp, 'private.txt'));
    const dmg = path.join(temp, 'Concept-Graph-Helper-macos-arm64.dmg');
    await rm(dmg); await mkdir(dmg);
    await assert.rejects(cloudDownloadUploads(temp), /Unexpected helper download/);
    await rm(dmg, { recursive: true });
    await symlink(path.join(temp, 'Concept-Graph-Helper-windows-x64-setup.exe'), dmg);
    await assert.rejects(cloudDownloadUploads(temp), /Unexpected helper download/);
    await rm(dmg); await writeFile(dmg, '');
    await assert.rejects(cloudDownloadUploads(temp), /Unexpected helper download/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('upload preflight rejects missing, malformed or unsafe manifests and absent referenced installers', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-upload-manifest-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const entry = helperDownloadEntry('windows-x64', Buffer.from('artifact'));
  await writeFile(path.join(temp, entry.file), 'artifact');
  await assert.rejects(cloudDownloadUploads(temp), /Missing helper manifest/);
  const filename = path.join(temp, manifestName);
  await writeFile(filename, '{broken');
  await assert.rejects(cloudDownloadUploads(temp), SyntaxError);
  for (const manifest of [null, [], 'bad', {}, { unknown: entry }, { 'windows-x64': { ...entry, url: 'https://evil.example/file' } }, { 'windows-x64': { ...entry, kind: 'zip' } }, { 'windows-x64': { ...entry, sha256: 'bad' } }]) {
    await writeFile(filename, JSON.stringify(manifest));
    await assert.rejects(cloudDownloadUploads(temp), /Invalid helper (manifest|download)/);
  }
  const manifest = { 'windows-x64': entry, 'macos-arm64': helperDownloadEntry('macos-arm64', Buffer.from('DMG')) };
  await writeFile(filename, JSON.stringify(manifest));
  await assert.rejects(cloudDownloadUploads(temp), /Missing helper download: Concept-Graph-Helper-macos-arm64.dmg/);
  await rm(filename);
  await symlink(path.join(temp, entry.file), filename);
  await assert.rejects(cloudDownloadUploads(temp), /Unexpected helper download: concept-graph-helper-downloads.json/);
  await rm(filename); await mkdir(filename);
  await assert.rejects(cloudDownloadUploads(temp), /Unexpected helper download: concept-graph-helper-downloads.json/);
});

test('downloads reach the Worker before static asset fallback', async () => {
  const config = JSON.parse(await readFile(new URL('../cloud/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(config.assets.run_worker_first.includes('/downloads/*'));
  assert.ok(config.assets.run_worker_first.includes('/concept-graph-helper-downloads.json'));
});
