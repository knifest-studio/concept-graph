import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('macOS packaging refuses an unsigned app before creating a disk image', { skip: process.platform !== 'darwin' }, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-signature-test-'));
  try {
    const app = path.join(temp, 'Unsigned.app');
    const executable = path.join(app, 'Contents/MacOS/Unsigned');
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await writeFile(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>studio.knifest.signature-test</string><key>CFBundleExecutable</key><string>Unsigned</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
    const dmg = path.join(temp, 'Unsigned.dmg');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/package-macos-desktop.mjs'), app, dmg], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /codesign failed with status/);
    await assert.rejects(access(dmg), { code: 'ENOENT' });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('notarization refuses an ad hoc preview before creating or submitting a disk image', { skip: process.platform !== 'darwin' }, async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-notary-test-'));
  try {
    const app = path.join(temp, 'Preview.app');
    const executable = path.join(app, 'Contents/MacOS/Preview');
    await mkdir(path.dirname(executable), { recursive: true });
    await cp('/usr/bin/true', executable);
    await writeFile(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>studio.knifest.notary-test</string><key>CFBundleExecutable</key><string>Preview</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
    const signed = spawnSync('codesign', ['--force', '--sign', '-', app], { encoding: 'utf8' });
    assert.equal(signed.status, 0, signed.stderr);
    const dmg = path.join(temp, 'Preview.dmg');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/package-macos-desktop.mjs'), app, dmg], { encoding: 'utf8', env: { ...process.env, CONCEPT_GRAPH_MAC_SIGN_IDENTITY: 'Developer ID Application: Test (TEAMID)', CONCEPT_GRAPH_MAC_NOTARY_PROFILE: 'not-used' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Distribution requires the app and bundled Node/);
    await assert.rejects(access(dmg), { code: 'ENOENT' });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
