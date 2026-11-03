#!/usr/bin/env node
import { createInterface } from 'node:readline';

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'account/rateLimits/read' && process.env.TEST_LIMITS_ERROR) {
    return send({ id, error: { message: 'private diagnostic' } });
  }
  let result = {};
  if (method === 'account/read') result = { account: process.env.TEST_SIGNED_OUT ? null : { type: 'chatgpt' } };
  if (method === 'modelProvider/capabilities/read') result = { imageGeneration: true };
  if (method === 'account/rateLimits/read') {
    const rateLimits = { limitId: 'codex', limitName: null, primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1730947200 }, secondary: null, sensitive: 'secret-value' };
    result = { rateLimits, rateLimitsByLimitId: { codex: rateLimits }, token: 'secret-value' };
    send({ method: 'account/rateLimits/updated', params: { rateLimits } });
  }
  send({ id, result });
});
