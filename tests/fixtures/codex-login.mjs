#!/usr/bin/env node
import { createInterface } from 'node:readline';

let signedIn = false;
const loginId = '5e0744fd-d17a-4386-9914-690a3a085241';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  let result = {};
  if (method === 'account/read') result = { account: signedIn ? { type: 'chatgpt' } : null };
  if (method === 'modelProvider/capabilities/read') result = { imageGeneration: true };
  if (method === 'account/login/start') result = { type: 'chatgpt', loginId, authUrl: process.env.CONCEPT_GRAPH_TEST_LOGIN_URL || 'https://auth.openai.com/oauth/authorize?state=test' };
  if (method === 'account/login/cancel') send({ method: 'account/login/completed', params: { loginId: params.loginId, success: false, error: 'test' } });
  if (method === 'test/complete') {
    signedIn = true;
    send({ method: 'account/login/completed', params: { loginId, success: true } });
    send({ method: 'account/updated', params: { authMode: 'chatgpt' } });
  }
  if (method === 'test/unrelated') send({ method: 'account/login/completed', params: { loginId: 'unrelated', success: true } });
  send({ id, result });
});
