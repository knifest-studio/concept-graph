#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=';
let sequence = 0, pending;
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'account/read') return send({ id, result: { account: { type: 'chatgpt' } } });
  if (method === 'modelProvider/capabilities/read') return send({ id, result: { imageGeneration: true } });
  if (method === 'config/read') return send({ id, result: { config: {} } });
  if (method === 'model/list') return send({ id, result: { data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null } });
  if (method === 'thread/start') return send({ id, result: { thread: { id: `thread-${++sequence}` } } });
  if (method === 'turn/interrupt') { clearInterval(pending); return send({ id, result: {} }); }
  if (method === 'turn/start') {
    const threadId = params.threadId, prompt = params.input[0].text;
    const count = prompt.includes('ONE') ? 1 : prompt.includes('STAGED') || prompt.includes('PROGRESSIVE') ? 3 : 2;
    send({ id, result: { turn: { id: 'turn' } } });
    setTimeout(() => {
      const emit = n => send({ method: 'item/completed', params: { threadId, item: { type: 'imageGeneration', id: `image-${n}`, result: png } } });
      const finish = () => send({ method: 'turn/completed', params: { threadId, turn: prompt.includes('ERROR') ? { id: 'turn', status: 'failed', error: { message: 'Synthetic error' } } : { id: 'turn', status: 'completed' } } });
      const staged = prompt.includes('STAGED'), progressive = prompt.includes('PROGRESSIVE');
      const initial = staged ? 1 : progressive ? 2 : count;
      for (let n = 0; n < initial; n++) emit(n);
      if (prompt.includes('HOLD') || staged || progressive) pending = setInterval(() => {
        if (!existsSync(process.env.CONCEPT_GROUP_TEST_RELEASE)) return;
        clearInterval(pending);
        if (staged || progressive) for (let n = initial; n < count; n++) emit(n);
        finish();
      }, 20);
      else finish();
    }, 10);
    return;
  }
  send({ id, result: {} });
});
