#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=';
let sequence = 0, active = null;
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  const fail = message => send({ id, error: { message } });
  if (method === 'account/read') return send({ id, result: { account: { type: 'chatgpt' } } });
  if (method === 'modelProvider/capabilities/read') return send({ id, result: { imageGeneration: true } });
  if (method === 'config/read') return send({ id, result: { config: {} } });
  if (method === 'model/list') return send({ id, result: { data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null } });
  if (method === 'thread/start') {
    if (params.model !== 'gpt-6-luna') return fail('Generation must use gpt-6-luna.');
    if (!params.baseInstructions.includes('[[CG_CAPTION:')) return fail('Missing automatic caption instructions.');
    return send({ id, result: { thread: { id: `thread-${++sequence}` } } });
  }
  if (method === 'turn/interrupt') {
    if (active?.threadId === params.threadId) { clearTimeout(active.timer); active = null; }
    return send({ id, result: {} });
  }
  if (method === 'turn/start') {
    if (params.model !== 'gpt-6-luna' || params.effort !== 'low') return fail('Generation must use Luna low.');
    if (active) return fail('Concurrent generation: local and cloud queues must share one slot.');
    const prompt = params.input[0].text;
    if (prompt.includes('WITH_INPUT')) {
      const images = params.input.filter(item => item.type === 'localImage');
      try {
        if (images.length !== 1 || !/[/\\]cloud-jobs[/\\]/.test(images[0].path)
            || readFileSync(images[0].path).toString('base64') !== png) return fail('Cloud input bytes were not passed as a temporary local image.');
      } catch { return fail('Cloud input file is unavailable.'); }
    }
    active = { threadId: params.threadId };
    send({ id, result: { turn: { id: 'turn' } } });
    send({ method: 'item/started', params: { threadId: params.threadId, item: { type: 'imageGeneration', id: 'image' } } });
    if (prompt.includes('HOLD')) return;
    active.timer = setTimeout(() => {
      const threadId = params.threadId;
      if (prompt.includes('FAIL')) {
        active = null;
        send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'failed', error: { message: 'Synthetic cloud generation failure.' } } } });
        return;
      }
      const count = prompt.includes('MULTI') ? 3 : 1;
      for (let n = 0; n < count; n++) send({ method: 'item/completed', params: { threadId, item: {
        type: 'imageGeneration', id: `image-${n}`, result: png,
        ...(n === 1 ? { revisedPrompt: '[[CG_CAPTION:Вид збоку]]\nSide view' } : {}),
      } } });
      active = null;
      send({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed' } } });
    }, 80);
    return;
  }
  send({ id, result: {} });
});
