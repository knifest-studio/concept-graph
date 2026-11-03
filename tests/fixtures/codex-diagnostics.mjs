#!/usr/bin/env node
// Deterministic protocol fixture; it does not contact OpenAI.
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const threadId = 'test-thread';
const notification = (method, params = {}) => send({ method, params: { threadId, ...params } });
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return;
  let result = {};
  if (method === 'account/read') result = { account: { type: 'chatgpt' } };
  if (method === 'modelProvider/capabilities/read') result = { imageGeneration: true };
  if (method === 'config/read') result = { config: {} };
  if (method === 'model/list') result = { data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null };
  if (method === 'thread/start') result = { thread: { id: threadId }, model: params.model, reasoningEffort: 'low' };
  if (method === 'turn/start') {
    send({ id, result: { turn: { id: 'test-turn' } } });
    notification('item/agentMessage/delta', { itemId: 'agent', delta: 'A'.repeat(6000) });
    notification('item/started', { item: { type: 'imageGeneration' } });
    notification('item/completed', { item: { id: 'agent', type: 'agentMessage', text: 'A'.repeat(6000) } });
    notification('item/agentMessage/delta', { itemId: 'agent2', delta: 'B'.repeat(6000) });
    notification('item/agentMessage/delta', { itemId: 'agent3', delta: 'C'.repeat(6000) });
    notification('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 130 } } });
    setTimeout(() => {
      notification('item/completed', { item: { type: 'imageGeneration', id: 'img', status: 'completed', result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=', revisedPrompt: 'PRIVATE_PROMPT' } });
      notification('turn/completed', { turn: { status: 'completed' } });
    }, 700);
    return;
  }
  send({ id, result });
});
