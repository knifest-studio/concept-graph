import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codex } from '../codex.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(root, 'tests/fixtures/codex-login.mjs');

async function makeCodex(t, authUrl) {
  const previousBin = process.env.CODEX_BIN, previousUrl = process.env.CONCEPT_GRAPH_TEST_LOGIN_URL;
  process.env.CODEX_BIN = fixture;
  if (authUrl) process.env.CONCEPT_GRAPH_TEST_LOGIN_URL = authUrl;
  else delete process.env.CONCEPT_GRAPH_TEST_LOGIN_URL;
  const codex = new Codex(root);
  t.after(() => {
    codex.close();
    if (previousBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previousBin;
    if (previousUrl === undefined) delete process.env.CONCEPT_GRAPH_TEST_LOGIN_URL; else process.env.CONCEPT_GRAPH_TEST_LOGIN_URL = previousUrl;
  });
  await codex.connect();
  return codex;
}

test('ChatGPT sign-in validates requests and observes the matching completion', async t => {
  const codex = await makeCodex(t);
  const { loginId, authUrl } = await codex.startChatGPTLogin();
  assert.equal(authUrl, 'https://auth.openai.com/oauth/authorize?state=test');
  await assert.rejects(codex.startChatGPTLogin(), /already in progress/);
  await assert.rejects(codex.cancelChatGPTLogin('unrelated'), /No matching/);
  let completed = 0;
  codex.on('login-completed', () => completed++);
  await codex.request('test/unrelated');
  assert.equal(completed, 0);
  const finished = once(codex, 'login-completed');
  const updated = once(codex, 'account-updated');
  await codex.request('test/complete');
  assert.deepEqual((await finished)[0], { success: true, reason: 'completed' });
  await updated;
  assert.equal((await codex.status()).signedIn, true);
  await assert.rejects(codex.cancelChatGPTLogin(loginId), /No matching/);
});

test('ChatGPT sign-in can be cancelled without affecting later attempts', async t => {
  const codex = await makeCodex(t);
  const { loginId } = await codex.startChatGPTLogin();
  const finished = once(codex, 'login-completed');
  await codex.cancelChatGPTLogin(loginId);
  assert.deepEqual((await finished)[0], { success: false, reason: 'cancelled' });
  assert.ok((await codex.startChatGPTLogin()).authUrl);
});

test('ChatGPT sign-in refuses redirects outside the official HTTPS hosts', async t => {
  for (const url of ['http://auth.openai.com/authorize', 'https://auth.openai.com.evil.example/', 'https://user@auth.openai.com/', 'https://chatgpt.com:8443/']) {
    const codex = await makeCodex(t, url);
    await assert.rejects(codex.startChatGPTLogin(), /invalid sign-in request/);
    codex.close();
  }
});

test('a disconnected Codex process ends the pending sign-in', async t => {
  const codex = await makeCodex(t);
  await codex.startChatGPTLogin();
  const finished = once(codex, 'login-completed');
  codex.child.kill();
  assert.deepEqual((await finished)[0], { success: false, reason: 'disconnected' });
});
