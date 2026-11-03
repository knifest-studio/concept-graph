import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cloudHelperDownload, helperDownloadFiles, helperDownloadType, fetchHelperArchive, helperOutdated } from '../src/helper-download.mjs';

test('cloud downloads accept only the three installer filenames and safe direct manifest links', () => {
  for (const [platform, file] of Object.entries(helperDownloadFiles)) {
    const kind = platform.startsWith('macos') ? 'dmg' : 'exe';
    const entry = { file, url: `/downloads/${file}`, size: 80 * 1024 * 1024, sha256: 'a'.repeat(64), kind };
    assert.equal(helperDownloadType(file), kind === 'dmg' ? 'application/x-apple-diskimage' : 'application/vnd.microsoft.portable-executable');
    assert.equal(cloudHelperDownload(platform, entry), entry);
    const versioned = { ...entry, helperVersion: '0.1.1-0123456789' };
    assert.equal(cloudHelperDownload(platform, versioned), versioned);
    for (const patch of [{ file: '../secret' }, { url: '//evil.example/file' }, { url: `/downloads/${file}?other=1` }, { kind: 'app' }, { kind: 'zip' }, { size: 0 }, { sha256: '' }, { unpackedSize: -1 }, { helperVersion: '' }, { helperVersion: null }, { helperVersion: 12 }]) {
      assert.equal(cloudHelperDownload(platform, { ...entry, ...patch }), null);
    }
    assert.equal(cloudHelperDownload('unknown', entry), null);
    assert.equal(cloudHelperDownload(platform, undefined), null);
  }
  for (const file of ['../secret', 'Concept-Graph-Helper-macos-x64.zip', 'Concept-Graph-Helper-windows-x64.zip', 'Concept-Graph-Helper-windows-x64.dmg', 'Concept-Graph-Helper-windows-x64-setup.exe/extra', 'Concept-Graph-Helper-macos-arm64.dmg/extra', 'Concept-Graph-Helper-macos-arm64.dmg\n', 'Concept-Graph-Helper-macos-arm64.dmg%0d%0aX:1', 'concept-graph-helper-macos-arm64.dmg', '__proto__']) {
    assert.equal(helperDownloadType(file), null, file);
  }
});

test('helper update requires a published version and compares source, legacy and packaged helpers', () => {
  const download = { helperVersion: '0.1.1-0123456789' };
  assert.equal(helperOutdated(download.helperVersion, download), false);
  for (const running of [null, undefined, '', '0.1.1-9876543210', '0.1.0-0123456789']) {
    assert.equal(helperOutdated(running, download), true);
  }
  for (const published of [null, undefined, {}]) assert.equal(helperOutdated(null, published), false);
  assert.equal(helperOutdated(download.helperVersion, {}), false);
});

test('helper archive is assembled in order and rejected when a part is altered', async () => {
  const content = Buffer.from('first-second');
  const manifest = { 'macos-arm64': { parts: 2, size: content.length, sha256: createHash('sha256').update(content).digest('hex') } };
  const requested = [], parts = ['first-', 'second'];
  const fakeFetch = async url => {
    requested.push(url);
    if (url.endsWith('manifest.json')) return new Response(JSON.stringify(manifest));
    return new Response(parts[url.endsWith('.001') ? 0 : 1]);
  };
  const archive = await fetchHelperArchive('macos-arm64', () => {}, fakeFetch);
  assert.equal(await archive.text(), 'first-second');
  assert.deepEqual(requested.slice(1), ['/concept-graph-helper-macos-arm64.zip.001', '/concept-graph-helper-macos-arm64.zip.002']);
  parts[1] = 'SEC0ND';
  await assert.rejects(fetchHelperArchive('macos-arm64', () => {}, fakeFetch), /integrity check/);
});
