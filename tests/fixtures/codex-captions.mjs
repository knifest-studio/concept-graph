#!/usr/bin/env node
// Deterministic image events, deliberately completed in a different order.
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=';
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'account/read') return send({ id, result: { account: { type: 'chatgpt' } } });
  if (method === 'modelProvider/capabilities/read') return send({ id, result: { imageGeneration: true } });
  if (method === 'config/read') return send({ id, result: { config: {} } });
  if (method === 'model/list') return send({ id, result: { data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null } });
  if (method === 'thread/start') {
    if (process.env.EXPECT_CAPTION_INSTRUCTIONS === '1' && (!params.baseInstructions.includes('[[CG_CAPTION:') || !params.baseInstructions.includes('every image tool prompt, including single-image requests'))) return send({ id, error: { message: 'Missing caption instructions' } });
    if (process.env.EXPECT_CAPTION_INSTRUCTIONS === '0' && params.baseInstructions.includes('[[CG_CAPTION:')) return send({ id, error: { message: 'Unexpected caption instructions' } });
    return send({ id, result: { thread: { id: 'thread' } } });
  }
  if (method === 'turn/start') {
    send({ id, result: { turn: { id: 'turn' } } });
    for (const itemId of ['front', 'side', 'missing']) send({ method: 'item/started', params: { threadId: 'thread', item: { id: itemId, type: 'imageGeneration' } } });
    for (const [itemId, revisedPrompt] of [['side', '[[CG_CAPTION:Вид збоку]]\nSide view'], ['front', '[[CG_CAPTION:Вид спереду]]\nFront view'], ['missing', 'No metadata']]) {
      send({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'imageGeneration', id: itemId, result: png, revisedPrompt } } });
    }
    return send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
  }
  send({ id, result: {} });
});
