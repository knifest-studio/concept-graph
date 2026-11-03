import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRateLimits } from '../codex.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const unavailable = { available: false, buckets: [] };

test('rate limits preserve real windows and discard unknown and malformed fields', () => {
  const primary = { usedPercent: 25, windowDurationMins: 300, resetsAt: 1730947200 };
  assert.deepEqual(normalizeRateLimits({ rateLimits: { limitId: 'codex', primary, secondary: null, secret: 'private' } }), {
    available: true, buckets: [{ id: 'codex', name: null, primary, secondary: null }],
  });
  assert.deepEqual(normalizeRateLimits({ rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 0, resetsAt: null }, secondary: { usedPercent: 101, windowDurationMins: -1 } },
    other: { limitName: 'Other', secondary: { usedPercent: 100 } },
  } }), { available: true, buckets: [
    { id: 'codex', name: null, primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null }, secondary: null },
    { id: 'other', name: 'Other', primary: null, secondary: { usedPercent: 100, windowDurationMins: null, resetsAt: null } },
  ] });
  for (const value of [undefined, {}, { rateLimits: null }, { rateLimits: { primary: { usedPercent: '42' } } }]) {
    assert.deepEqual(normalizeRateLimits(value), unavailable);
  }
});

for (const scenario of ['available', 'signed-out', 'upstream-error']) test(`limits endpoint: ${scenario}`, { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-limits-'));
  const env = { ...process.env, PORT: '0', CONCEPT_GRAPH_DESKTOP: '1', CONCEPT_GRAPH_DATA: directory,
    CODEX_BIN: path.join(root, 'tests/fixtures/codex-limits.mjs') };
  delete env.CONCEPT_GRAPH_SITE; delete env.CONCEPT_GRAPH_HELPER_TOKEN;
  if (scenario === 'signed-out') env.TEST_SIGNED_OUT = '1';
  if (scenario === 'upstream-error') env.TEST_LIMITS_ERROR = '1';
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited ${code}: ${errors}`)));
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/ready at http:\/\/127\.0\.0\.1:(\d+)/); if (match) resolve(Number(match[1])); });
  });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/status', { method: 'POST' });
  const workspace = await (await fetch(base + '/api/workspace')).json();
  const eventAbort = new AbortController();
  t.after(() => eventAbort.abort());
  const events = scenario === 'available' ? await fetch(`${base}/api/boards/${workspace.defaultBoardId}/events`, { signal: eventAbort.signal }) : null;
  const response = await fetch(base + '/api/limits');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  assert.ok(!body.includes('secret-value') && !body.includes('private diagnostic'));
  const value = JSON.parse(body);
  if (scenario !== 'available') assert.deepEqual(value, unavailable);
  else {
    assert.equal(value.buckets[0].primary.usedPercent, 40);
    const reader = events.body.getReader();
    let stream = '';
    while (!stream.includes('event: limits-changed')) stream += new TextDecoder().decode((await reader.read()).value);
    assert.match(stream, /event: limits-changed\ndata: \{\}/);
    eventAbort.abort();
  }
  assert.ok(!output.includes('secret-value') && !errors.includes('secret-value') && !errors.includes('private diagnostic'));
});
