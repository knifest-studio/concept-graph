import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { targets, helperFiles, computeHelperVersion, validateHelperSite, helperInfoPlist, helperOutputPaths, helperDownloadEntry, mergeHelperDownloads, updateHelperDownloads } from '../scripts/helper-build.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('helper version hashes sorted bundled contents and includes the package version', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-helper-version-'));
  try {
    await writeFile(path.join(temp, 'package.json'), JSON.stringify({ version: '0.1.1' }));
    for (const file of [...helperFiles].reverse()) { await mkdir(path.dirname(path.join(temp, file)), { recursive: true }); await writeFile(path.join(temp, file), `source: ${file}`); }
    const initial = await computeHelperVersion(temp);
    assert.match(initial, /^0\.1\.1-[a-f0-9]{10}$/);
    assert.equal(await computeHelperVersion(temp), initial);
    await writeFile(path.join(temp, 'unbundled.mjs'), 'not part of the helper');
    assert.equal(await computeHelperVersion(temp), initial);
    for (const file of helperFiles) {
      await writeFile(path.join(temp, file), `changed: ${file}`);
      assert.notEqual(await computeHelperVersion(temp), initial, file);
      await writeFile(path.join(temp, file), `source: ${file}`);
    }
    assert.equal(await computeHelperVersion(temp), initial);
    await writeFile(path.join(temp, 'package.json'), JSON.stringify({ version: '0.1.2' }));
    assert.equal(await computeHelperVersion(temp), initial.replace('0.1.1-', '0.1.2-'));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('helper site accepts HTTPS origins and normalizes the allowlist', () => {
  assert.equal(validateHelperSite(' https://BOARDS.example:443/, https://preview.example:8443 '), 'https://boards.example,https://preview.example:8443');
  assert.equal(validateHelperSite('https://[::1]:8443'), 'https://[::1]:8443');
  for (const site of [undefined, '', ' ', 'http://boards.example', '//boards.example', 'https://user:pass@boards.example', 'https://boards.example/path', 'https://boards.example?', 'https://boards.example#', 'https://boards.example,', 'https://boards.example\n.evil', 'https://boards.example\\evil', 'https://boards.example:bad', 'https://boards.example/<key>Injected</key>']) {
    assert.throws(() => validateHelperSite(site), /HTTPS origins only/, String(site));
  }
});

test('helper Info.plist bakes the site into the native bundle', async () => {
  const template = await readFile(path.join(root, 'desktop/macos-helper/Info.plist'), 'utf8');
  const plist = helperInfoPlist(template, 'https://boards.example/,https://preview.example');
  assert.match(plist, /<key>ConceptGraphHelperSite<\/key><string>https:\/\/boards.example,https:\/\/preview.example<\/string>/);
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>studio\.knifest\.conceptgraph\.helper<\/string>/);
  assert.ok(!plist.includes('__CONCEPT_GRAPH_HELPER_SITE__'));
  assert.match(helperInfoPlist(template, 'https://a&b.example'), /<string>https:\/\/a&amp;b\.example<\/string>/);
  assert.throws(() => helperInfoPlist(template, 'https://boards.example/?a=1&b=2'), /HTTPS origins only/);
  assert.throws(() => helperInfoPlist('<plist/>', 'https://boards.example'), /one site placeholder/);
  assert.throws(() => helperInfoPlist(template + template, 'https://boards.example'), /one site placeholder/);
});

const helperVersion = '0.1.1-0123456789';
const appEntry = helperDownloadEntry('macos-arm64', Buffer.from('DMG'), 90_000_000, helperVersion);
const intelEntry = helperDownloadEntry('macos-x64', Buffer.from('Intel DMG'), 90_000_000, helperVersion);
const windowsEntry = helperDownloadEntry('windows-x64', Buffer.from('EXE'));

test('Mac manifest merge preserves Windows, the other Mac architecture and unrelated entries', () => {
  const original = {
    'windows-x64': windowsEntry,
    'macos-arm64': { size: 456 },
    'macos-x64': intelEntry,
    future: { value: true },
  };
  const before = structuredClone(original);
  const merged = mergeHelperDownloads(original, { 'macos-arm64': appEntry });
  assert.deepEqual(merged, { ...before, 'macos-arm64': appEntry });
  assert.deepEqual(original, before);
  const both = mergeHelperDownloads(merged, { 'macos-x64': intelEntry });
  assert.deepEqual(both['windows-x64'], original['windows-x64']);
  assert.equal(both['macos-arm64'].kind, 'dmg');
  assert.equal(both['macos-x64'].kind, 'dmg');
  assert.equal(both['macos-arm64'].helperVersion, helperVersion);
  assert.equal(both['macos-x64'].helperVersion, helperVersion);
  const windows = helperDownloadEntry('windows-x64', Buffer.from('new EXE'), undefined, helperVersion);
  assert.equal(mergeHelperDownloads(both, { 'windows-x64': windows })['windows-x64'].helperVersion, helperVersion);
  assert.deepEqual(mergeHelperDownloads({}, { 'macos-arm64': appEntry }), { 'macos-arm64': appEntry });
});

test('Mac manifest merge rejects malformed manifests and incompatible download entries', () => {
  for (const manifest of [null, [], 'bad']) assert.throws(() => mergeHelperDownloads(manifest, {}), /Invalid helper manifest/);
  for (const patch of [{ kind: 'command' }, { file: 'wrong.dmg' }, { url: 'https://evil.example/download' }, { size: 0 }, { size: 1.5 }, { sha256: 'bad' }, { unpackedSize: 0 }, { helperVersion: null }, { helperVersion: '' }]) {
    assert.throws(() => mergeHelperDownloads({}, { 'macos-arm64': { ...appEntry, ...patch } }), /Invalid helper download/);
  }
  assert.throws(() => mergeHelperDownloads({}, { 'windows-x64': appEntry }), /Invalid helper download/);
  assert.doesNotThrow(() => mergeHelperDownloads({}, { 'macos-arm64': { ...appEntry, size: 100 * 1024 * 1024 } }));
});

test('cloud manifest records a whole artifact checksum, direct URL and optional installed size', async () => {
  assert.deepEqual(windowsEntry, { file: 'Concept-Graph-Helper-windows-x64-setup.exe', url: '/downloads/Concept-Graph-Helper-windows-x64-setup.exe', size: 3, sha256: '34f2ceae68695a978c5f3bf100de9d47d7d6a520cc3790b439bb36180a74cc50', kind: 'exe' });
  assert.equal(appEntry.unpackedSize, 90_000_000);
  assert.ok(!('parts' in appEntry));
  assert.throws(() => helperDownloadEntry('linux-x64', Buffer.from('no')), /Invalid helper download/);
  assert.throws(() => helperDownloadEntry('__proto__', Buffer.from('no')), /Invalid helper download/);
  assert.throws(() => helperDownloadEntry('windows-x64', Buffer.alloc(0)), /Invalid helper download/);
  const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-download-manifest-'));
  try {
    await updateHelperDownloads(temp, { 'windows-x64': windowsEntry });
    await updateHelperDownloads(temp, { 'macos-arm64': appEntry });
    const filename = path.join(temp, 'concept-graph-helper-downloads.json');
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { 'windows-x64': windowsEntry, 'macos-arm64': appEntry });
    assert.deepEqual(await readdir(temp), ['concept-graph-helper-downloads.json']);
    await writeFile(filename, 'invalid');
    await assert.rejects(updateHelperDownloads(temp, { 'macos-x64': intelEntry }), SyntaxError);
    assert.equal(await readFile(filename, 'utf8'), 'invalid');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('cloud binaries cannot be written into the static site output', () => {
  const root = path.resolve('/tmp/concept-graph-output-test');
  assert.deepEqual(helperOutputPaths(root, {}), { site: path.join(root, 'dist-cloud'), downloads: path.join(root, 'dist-downloads') });
  for (const downloads of [path.join(root, 'dist-cloud'), path.join(root, 'dist-cloud/installers')]) {
    assert.throws(() => helperOutputPaths(root, { CONCEPT_GRAPH_DOWNLOADS_OUTPUT: downloads }), /outside the static site/);
  }
  const site = path.join(root, 'custom-site'), downloads = path.join(root, 'custom-downloads');
  assert.deepEqual(helperOutputPaths(root, { CONCEPT_GRAPH_SITE_OUTPUT: site, CONCEPT_GRAPH_DOWNLOADS_OUTPUT: downloads }), { site, downloads });
  assert.throws(() => helperOutputPaths(root, { CONCEPT_GRAPH_SITE_OUTPUT: site, CONCEPT_GRAPH_DOWNLOADS_OUTPUT: path.join(site, 'installers') }), /outside the static site/);
});

test('cloud download metadata survives clearing the static build output', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-output-lifetime-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const outputs = helperOutputPaths(temp, {});
  await mkdir(outputs.site);
  await writeFile(path.join(outputs.site, 'index.html'), 'old site');
  await updateHelperDownloads(outputs.downloads, { 'windows-x64': windowsEntry });
  await updateHelperDownloads(outputs.downloads, { 'macos-arm64': appEntry });
  await rm(outputs.site, { recursive: true });
  await mkdir(outputs.site);
  await writeFile(path.join(outputs.site, 'index.html'), 'rebuilt site');
  assert.deepEqual(JSON.parse(await readFile(path.join(outputs.downloads, 'concept-graph-helper-downloads.json'), 'utf8')), { 'windows-x64': windowsEntry, 'macos-arm64': appEntry });
  assert.deepEqual(await readdir(outputs.site), ['index.html']);
});

test('Mac helper build refuses unsafe inputs before invoking build or signing tools', { skip: process.platform !== 'darwin' }, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-helper-build-test-'));
  const env = { ...process.env, PATH: '', CONCEPT_GRAPH_HELPER_SITE: 'https://boards.example', CONCEPT_GRAPH_MAC_ARCHS: 'arm64', CONCEPT_GRAPH_NODE_ARCHIVES: temp, CONCEPT_GRAPH_SITE_OUTPUT: path.join(temp, 'output'), CONCEPT_GRAPH_DOWNLOADS_OUTPUT: path.join(temp, 'downloads'), CONCEPT_GRAPH_MAC_SIGN_IDENTITY: '-', CONCEPT_GRAPH_MAC_NOTARY_PROFILE: '' };
  const build = overrides => spawnSync(process.execPath, [path.join(root, 'scripts/build-macos-helper.mjs')], { encoding: 'utf8', env: { ...env, ...overrides } });
  try {
    for (const [overrides, message] of [
      [{ CONCEPT_GRAPH_HELPER_SITE: '' }, /HTTPS origins only/],
      [{ CONCEPT_GRAPH_MAC_ARCHS: '../x64' }, /Build on macOS/],
      [{ CONCEPT_GRAPH_MAC_NOTARY_PROFILE: 'never-submit' }, /Notarization requires/],
      [{ CONCEPT_GRAPH_MAC_SIGN_IDENTITY: 'Apple Development: invalid' }, /full Developer ID Application/],
    ]) {
      const result = build(overrides);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    }
    await writeFile(path.join(temp, targets[0].archive), 'not a verified Node archive');
    const result = build({});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Checksum mismatch/);
    assert.ok(!(await readdir(temp)).includes('output'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('portable builder keeps legacy targets by default and selects only Windows for cloud builds', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-portable-mode-test-'));
  const env = { ...process.env, PATH: '', CONCEPT_GRAPH_NODE_ARCHIVES: temp, CONCEPT_GRAPH_HELPER_SITE: 'https://boards.example', CONCEPT_GRAPH_SITE_OUTPUT: path.join(temp, 'site'), CONCEPT_GRAPH_DOWNLOADS_OUTPUT: path.join(temp, 'downloads') };
  const build = (args, overrides = {}) => spawnSync(process.execPath, [path.join(root, 'scripts/build-portable-helper.mjs'), ...args], { encoding: 'utf8', env: { ...env, ...overrides } });
  try {
    for (const target of targets) await writeFile(path.join(temp, target.archive), 'not a verified Node archive');
    const legacy = build([]), cloud = build(['--cloud']);
    assert.notEqual(legacy.status, 0); assert.match(legacy.stderr, /Checksum mismatch: node-v22\.22\.3-darwin-arm64\.tar\.gz/);
    assert.notEqual(cloud.status, 0); assert.match(cloud.stderr, /Checksum mismatch: node-v22\.22\.3-win-x64\.zip/);
    const missingSite = build(['--cloud'], { CONCEPT_GRAPH_HELPER_SITE: '' });
    assert.notEqual(missingSite.status, 0); assert.match(missingSite.stderr, /HTTPS origins only/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
