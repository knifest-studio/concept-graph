import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gptDescribeCost, gptDescribeEstimate, gptDescribeModel, gptDescribePrices, gptDescribeRequest, gptDescribeResult } from '../cloud/gpt-describe.mjs';
import { imageAttachment, modelNames } from '../graph.mjs';
import { NanoError } from '../cloud/nano-banana.mjs';
import { siteKind, recordedKind } from '../src/generation-analytics.mjs';
import { checkArgs, runBoardTool, toolByName } from '../cloud/mcp-tools.mjs';
import { setLanguage, t } from '../src/i18n.mjs';

const references = [{ mimeType: 'image/png', data: 'YWJj', label: 'Front', nodeId: 'a', asset: 'a.png', number: 2 }, { mimeType: 'image/jpeg', data: 'ZGVm' }];
const usage = { input_tokens: 81, output_tokens: 1035, output_tokens_details: { reasoning_tokens: 832 } };
const answer = (text = 'A robot.') => ({ status: 'completed', output: [{ type: 'reasoning', content: [{ type: 'output_text', text: 'Private thought' }] }, { type: 'message', content: [{ type: 'output_text', text }] }], usage });
const fails = (status, body, kind, message) => assert.throws(() => gptDescribeResult(status, body), cause => cause instanceof NanoError && cause.kind === kind && (!message || message.test(cause.message)) && !cause.message.includes('GPT Image') && !cause.message.includes('SECRET'));

test('GPT descriptions use Responses, labelled high-detail image inputs, low reasoning and no storage', () => {
  const { url, init } = gptDescribeRequest('Only lighting', references, { key: 'site-key', endpoint: 'http://localhost:8789' });
  assert.equal(url, 'http://localhost:8789/v1/responses'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
  assert.equal(init.headers.Authorization, 'Bearer site-key');
  assert.deepEqual(JSON.parse(init.body), { model: gptDescribeModel, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Only lighting' }, { type: 'input_text', text: imageAttachment(references[0], 0) },
    { type: 'input_image', image_url: 'data:image/png;base64,YWJj', detail: 'high' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,ZGVm', detail: 'high' }] }], reasoning: { effort: 'low' }, max_output_tokens: 8000, store: false });
  assert.equal(modelNames[gptDescribeModel], 'GPT-6.1 Terra');
});

test('GPT text parsing joins message text only and handles refusals, incomplete, failed and malformed responses', () => {
  const body = answer(' First '); body.output.push({ type: 'message', content: [{ type: 'output_text', text: 'Second' }, null] });
  assert.deepEqual(gptDescribeResult(200, body), { text: 'First \n\nSecond', usage });
  body.output[1].content.push({ type: 'refusal', refusal: 'SECRET' }); fails(200, body, 'refused');
  fails(200, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }, 'no_text', /output limit/);
  fails(200, { status: 'failed', error: { code: 'server_error', message: 'SECRET' } }, 'upstream');
  fails(200, { status: 'failed', error: { code: 'rate_limit_exceeded' } }, 'busy');
  for (const bad of [null, '', { output: 'bad' }, { output: [null, { type: 'message', content: 'bad' }] }, answer('  ')]) fails(200, bad, bad === null || bad === '' ? 'upstream' : 'no_text');
});

test('GPT HTTP errors remain actionable without exposing provider details on the board', () => {
  for (const [status, code, kind] of [[400, 'moderation_blocked', 'refused'], [429, 'insufficient_quota', 'config'], [401, '', 'config'], [403, '', 'config'], [404, '', 'config'], [429, '', 'busy'], [503, '', 'busy'], [504, '', 'busy'], [400, '', 'bad_request'], [500, '', 'upstream'], [302, '', 'upstream']]) fails(status, { error: { code, message: 'SECRET' } }, kind);
});

test('GPT budget reserve covers high-detail inputs and all output; reasoning is never charged twice', () => {
  assert.deepEqual(gptDescribePrices, { readOn: '2026-11-17', input: 1, output: 5 });
  assert.equal(gptDescribeEstimate({ promptLength: 301, references: 2 }), (101 + 6000 + 40000) / 1e6);
  assert.equal(gptDescribeCost(usage), (81 + 1035 * 5) / 1e6);
  assert.equal(gptDescribeCost({ input_tokens: 0, output_tokens: 0 }), 0);
  assert.equal(gptDescribeCost({ input_tokens: -1, output_tokens: -2 }), 0);
  for (const bad of [undefined, {}, { input_tokens: 0 }, { input_tokens: NaN, output_tokens: 0 }]) assert.equal(gptDescribeCost(bad, { references: 2 }), gptDescribeEstimate({ references: 2 }));
});

test('MCP creates and switches GPT describe nodes and analytics identifies the model before a run starts', () => {
  const graph = { nodes: [], edges: [], groups: [], runs: [] }, args = { text: '', describe: true, generator: 'gpt-image' };
  checkArgs({ boardId: '12345678-1234-1234-1234-123456789abc', ...args }, toolByName.get('add_text_node').inputSchema);
  const created = runBoardTool(toolByName.get('add_text_node'), { graph, args, templates: [], prepared: {} });
  const node = created.graph.nodes[0]; assert.equal(node.data.generator, 'gpt-image'); assert.equal(node.data.task, 'describe');
  const expected = { generator: 'gpt-image', model: gptDescribeModel, task: 'describe', variants: 1 };
  assert.deepEqual(siteKind(node), expected); assert.deepEqual(recordedKind({ provider: 'gpt-image', model: gptDescribeModel, task: 'describe' }), expected);
  const changed = runBoardTool(toolByName.get('update_node'), { graph: created.graph, args: { nodeId: node.id, generator: 'nano-banana' }, templates: [] });
  const back = runBoardTool(toolByName.get('update_node'), { graph: changed.graph, args: { nodeId: node.id, generator: 'gpt-image' }, templates: [] });
  assert.equal(back.graph.nodes[0].data.mainImage, undefined); assert.deepEqual(siteKind(back.graph.nodes[0]), expected);
});

test('the fake Responses API exercises success, refusal, empty text and errors without opening a socket', async () => {
  const { picture, send } = await import('../scripts/fake-image.mjs');
  const source = (await readFile(new URL('../scripts/fake-openai.mjs', import.meta.url), 'utf8')).replace(/import .*?;\n/g, '');
  let handler, delayed = 0;
  new Function('createServer', 'picture', 'send', 'process', 'console', 'setTimeout', source)(callback => { handler = callback; return { listen() {} }; }, picture, send, { env: {} }, { log() {} }, callback => { delayed++; queueMicrotask(callback); });
  const respond = async marker => {
    const { init } = gptDescribeRequest(marker, references, { key: 'fake', endpoint: 'http://localhost:8789' });
    let status, body;
    await handler({ method: 'POST', url: '/v1/responses', headers: { authorization: init.headers.Authorization }, async *[Symbol.asyncIterator]() { yield Buffer.from(init.body); } }, { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } });
    return { status, body };
  };
  assert.match(gptDescribeResult(200, (await respond('Describe')).body).text, /grey square/);
  assert.match(gptDescribeResult(200, (await respond('[slow]')).body).text, /grey square/); assert.equal(delayed, 1);
  for (const [marker, kind] of [['refuse', 'refused'], ['empty', 'no_text'], ['busy', 'busy'], ['key', 'config'], ['credit', 'config'], ['error', 'upstream']]) { const { status, body } = await respond(`[${marker}]`); fails(status, body, kind); }
});


test('GPT description labels and failures read in Ukrainian', () => {
  setLanguage('uk');
  try {
    for (const text of ['Describe with GPT', 'Describe with Codex, Gemini or GPT', 'GPT took longer than 5 minutes. Try again.', 'GPT failed (500). Try again.', 'GPT returned no description. Try again.', 'GPT reached its output limit without a description. Try a shorter focus or fewer images.', 'This node describes with Codex. {name} on the team’s key can describe it now; you can switch back in its generator menu.']) assert.notEqual(t(text, text.includes('{name}') ? { name: 'GPT' } : undefined), text);
    assert.equal(t('Describe with GPT'), 'Описати через GPT');
  } finally { setLanguage('en'); }
});
