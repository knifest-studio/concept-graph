import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Codex, CodexInstaller, codexInstallOptions, resolveCodex } from '../codex.mjs';

async function fixture(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'cg-codex-install-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source'), root = path.join(temporary, 'managed');
  await mkdir(path.join(source, 'bin'), { recursive: true });
  await writeFile(path.join(source, 'bin', 'codex'), '#!/bin/sh\necho fixture\n', { mode: 0o755 });
  const archive = path.join(temporary, 'fixture.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', source, 'bin']);
  const bytes = await readFile(archive);
  const options = { ...codexInstallOptions({ CONCEPT_GRAPH_CODEX_INSTALL_DIR: root }, 'darwin', 'arm64'), sha256: createHash('sha256').update(bytes).digest('hex') };
  const fetch = async (url, init) => {
    assert.equal(url, options.url); assert.equal(init.redirect, 'manual'); assert.ok(init.signal);
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  return { options, bytes, fetch, temporary };
}

test('installer streams a verified archive, reports progress, deduplicates starts and reuses the installation', async t => {
  const f = await fixture(t);
  let installed = 0, calls = 0;
  const installer = new CodexInstaller({ ...f, fetch: async (...args) => { calls++; return f.fetch(...args); }, onInstalled: () => installed++ });
  assert.equal(installer.status().state, 'idle');
  assert.equal(installer.start().state, 'downloading');
  const completion = installer.completion;
  installer.start(); assert.equal(installer.completion, completion);
  await completion;
  assert.deepEqual(installer.status(), { supported: true, state: 'done', received: f.bytes.length, total: f.bytes.length, error: null });
  assert.equal(installed, 1); assert.equal(calls, 1);
  assert.match(await readFile(f.options.executable, 'utf8'), /fixture/);
  assert.deepEqual(await readdir(f.options.root), ['0.163.0']);
  installer.start(); assert.equal(calls, 1);
  const reuse = new CodexInstaller({ ...f, fetch: () => assert.fail('must not download') });
  reuse.start(); await reuse.completion; assert.equal(reuse.status().state, 'done');
});

test('checksum failure cleans temporary files and can be retried', async t => {
  const f = await fixture(t), installer = new CodexInstaller({ ...f, options: { ...f.options, sha256: '0'.repeat(64) } });
  installer.start(); await installer.completion;
  assert.equal(installer.status().state, 'error'); assert.match(installer.status().error, /checksum/);
  assert.deepEqual(await readdir(f.options.root), []);
  installer.options.sha256 = f.options.sha256;
  installer.start(); await installer.completion;
  assert.equal(installer.status().state, 'done');
});

test('download redirects only follow allowlisted HTTPS hosts', async t => {
  const f = await fixture(t);
  for (const location of ['https://evil.example/codex', 'http://github.com/codex', 'https://github.com:444/codex', 'https://user@github.com/codex']) {
    let calls = 0;
    const installer = new CodexInstaller({ ...f, fetch: async () => { calls++; return new Response(null, { status: 302, headers: { location } }); } });
    installer.start(); await installer.completion;
    assert.match(installer.status().error, /host is not allowed/); assert.equal(calls, 1);
    assert.deepEqual(await readdir(f.options.root), []);
  }
  let calls = 0;
  const installer = new CodexInstaller({ ...f, fetch: async url => {
    calls++;
    if (calls === 1) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/codex' } });
    assert.equal(url, 'https://release-assets.githubusercontent.com/codex');
    return new Response(f.bytes);
  } });
  installer.start(); await installer.completion; assert.equal(installer.status().state, 'done');
});

test('oversized headers and streamed bodies are rejected without extracting', async t => {
  const f = await fixture(t);
  for (const oversizedHeader of [true, false]) {
    const installer = new CodexInstaller({ ...f, fetch: async () => oversizedHeader
      ? new Response('small', { headers: { 'content-length': String(256 * 1024 * 1024 + 1) } })
      : new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); } })) });
    installer.start(); await installer.completion;
    assert.match(installer.status().error, /unexpected size/);
    assert.deepEqual(await readdir(f.options.root), []);
  }
});

test('existing incomplete directories and files remain untouched', async t => {
  const f = await fixture(t);
  for (const empty of [true, false]) {
    await mkdir(f.options.directory, { recursive: true });
    if (!empty) await writeFile(path.join(f.options.directory, 'keep.txt'), 'private');
    const installer = new CodexInstaller({ ...f, fetch: () => assert.fail('must not download') });
    installer.start(); await installer.completion;
    assert.match(installer.status().error, /incomplete/);
    assert.deepEqual(await readdir(f.options.directory), empty ? [] : ['keep.txt']);
    await rm(f.options.directory, { recursive: true });
  }
  await writeFile(f.options.directory, 'keep');
  const installer = new CodexInstaller(f);
  installer.start(); await installer.completion;
  assert.match(installer.status().error, /incomplete/);
  assert.equal(await readFile(f.options.directory, 'utf8'), 'keep');
});

test('symlink roots are refused and unsupported platforms never download', async t => {
  const f = await fixture(t), target = path.join(f.temporary, 'target');
  await mkdir(target); await symlink(target, f.options.root);
  const installer = new CodexInstaller(f);
  installer.start(); await installer.completion;
  assert.match(installer.status().error, /regular directory/);
  assert.equal((await lstat(f.options.root)).isSymbolicLink(), true);
  const unsupported = new CodexInstaller({ options: codexInstallOptions({}, 'linux', 'x64'), fetch: () => assert.fail('must not download') });
  unsupported.start(); await unsupported.completion;
  assert.equal(unsupported.status().supported, false); assert.match(unsupported.status().error, /not supported/);
});

test('missing Codex resolves after installation without restarting or changing PATH', async t => {
  const f = await fixture(t), env = { PATH: '', CONCEPT_GRAPH_CODEX_INSTALL_DIR: f.options.root };
  assert.throws(() => resolveCodex(env, 'darwin', 'arm64'), { codexMissing: true });
  const installer = new CodexInstaller(f); installer.start(); await installer.completion;
  assert.equal(resolveCodex(env, 'darwin', 'arm64'), f.options.executable);
  const own = path.join(f.temporary, 'own'); await mkdir(own);
  await symlink(f.options.executable, path.join(own, 'codex'));
  assert.equal(resolveCodex({ ...env, PATH: own }, 'darwin', 'arm64'), path.join(own, 'codex'));
  await chmod(f.options.executable, 0o644);
  assert.throws(() => resolveCodex(env, 'darwin', 'arm64'), { codexMissing: true });
});

test('interrupted downloads and invalid packages clean staging and leave no installation', async t => {
  const f = await fixture(t);
  const cases = [
    { fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('Connection lost')); } })), error: /Connection lost/ },
    { fetch: async () => new Response(f.bytes, { headers: { 'content-length': String(f.bytes.length + 1) } }), error: /incomplete/ },
    { fetch: async () => new Response('broken tar'), options: { ...f.options, sha256: createHash('sha256').update('broken tar').digest('hex') }, error: /Command failed/ },
  ];
  for (const { error, ...overrides } of cases) {
    const installer = new CodexInstaller({ ...f, ...overrides });
    installer.start(); await installer.completion;
    assert.equal(installer.status().state, 'error'); assert.match(installer.status().error, error);
    assert.deepEqual(await readdir(f.options.root), []);
  }
});

test('a destination created during download is not overwritten, even when empty', async t => {
  const f = await fixture(t);
  const installer = new CodexInstaller({ ...f, fetch: async (...args) => {
    await mkdir(f.options.directory);
    return f.fetch(...args);
  } });
  installer.start(); await installer.completion;
  assert.equal(installer.status().state, 'error');
  assert.deepEqual(await readdir(f.options.directory), []);
  assert.deepEqual(await readdir(f.options.root), ['0.163.0']);
});

test('a failed connection recovers with the installed CLI and existing ChatGPT login protocol', async t => {
  const f = await fixture(t), env = { ...process.env };
  t.after(() => { for (const key of ['PATH', 'CODEX_BIN', 'CONCEPT_GRAPH_CODEX_INSTALL_DIR']) {
    if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  } });
  process.env.PATH = '';
  process.env.CODEX_BIN = path.join(f.temporary, 'missing-codex');
  process.env.CONCEPT_GRAPH_CODEX_INSTALL_DIR = f.options.root;
  const codex = new Codex(f.temporary);
  t.after(() => codex.close());
  await assert.rejects(codex.connect(), { codexMissing: true });
  const source = path.join(f.temporary, 'source');
  const worker = await readFile(new URL('./fixtures/codex-login.mjs', import.meta.url), 'utf8');
  await writeFile(path.join(source, 'bin/codex'), worker.replace(/^#![^\n]*/, `#!${process.execPath}`), { mode: 0o755 });
  const archive = path.join(f.temporary, 'login.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', source, 'bin']);
  const bytes = await readFile(archive);
  const installer = new CodexInstaller({ options: { ...f.options, sha256: createHash('sha256').update(bytes).digest('hex') }, fetch: async () => new Response(bytes), onInstalled: () => { codex.connection = null; } });
  installer.start(); await installer.completion;
  assert.equal(installer.status().state, 'done');
  assert.equal((await codex.connect()).connected, true);
  assert.equal((await codex.startChatGPTLogin()).authUrl, 'https://auth.openai.com/oauth/authorize?state=test');
});
