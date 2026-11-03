import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('desktop sign-in starts and cancels without exposing credentials in status', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-desktop-login-'));
  const env = { ...process.env, PORT: '0', CONCEPT_GRAPH_DESKTOP: '1', CONCEPT_GRAPH_DATA: directory, CODEX_BIN: path.join(root, 'tests/fixtures/codex-login.mjs') };
  delete env.CONCEPT_GRAPH_SITE;
  delete env.CONCEPT_GRAPH_HELPER_TOKEN;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
    await rm(directory, { recursive: true, force: true });
  });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${errors}`)));
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/ready at http:\/\/127\.0\.0\.1:(\d+)/); if (match) resolve(Number(match[1])); });
  });
  const base = `http://127.0.0.1:${port}`;
  const started = await fetch(base + '/api/desktop/login', { method: 'POST' });
  assert.equal(started.status, 200);
  assert.equal(started.headers.get('cache-control'), 'no-store');
  const login = await started.json();
  assert.equal(new URL(login.authUrl).hostname, 'auth.openai.com');
  const workspace = await (await fetch(base + '/api/workspace')).text();
  assert.ok(!workspace.includes(login.authUrl));
  assert.ok(!workspace.includes(login.loginId));
  const cancelled = await fetch(base + '/api/desktop/login/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId: login.loginId }) });
  assert.equal(cancelled.status, 200);
});
