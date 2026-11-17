import { gptDescribeModel, imageAttachment } from '../graph.mjs';
import { gptImageError } from './gpt-image.mjs';
import { NanoError } from './nano-banana.mjs';

// Responses/vision contract and Standard USD per 1M tokens, read 2026-11-17:
// https://developers.openai.com/api/docs/models/gpt-6.1-terra
// https://developers.openai.com/api/reference/resources/responses/methods/create
// https://developers.openai.com/api/docs/guides/images-vision and https://developers.openai.com/api/docs/pricing
export { gptDescribeModel };
export const gptDescribePrices = Object.freeze({ readOn: '2026-11-17', input: 1, output: 5 });
export function gptDescribeRequest(prompt, references, { key, endpoint }) {
  return { url: `${endpoint}/v1/responses`, init: {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: gptDescribeModel, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt },
      ...references.flatMap((image, index) => [...(image.label ? [{ type: 'input_text', text: imageAttachment(image, index) }] : []),
        { type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}`, detail: 'high' }]) ] }],
      reasoning: { effort: 'low' }, max_output_tokens: 8000, store: false }),
  } };
}
const describeError = (status, error) => {
  const cause = gptImageError(status, error?.code || error?.type, error?.message);
  return new NanoError(cause.kind, cause.message.replaceAll('GPT Image', 'GPT'));
};
export function gptDescribeResult(status, body) {
  if (status < 200 || status > 299) throw describeError(status, body?.error);
  if (!body || typeof body !== 'object') throw new NanoError('upstream', 'GPT returned an unreadable response. Try again.');
  const blocks = (Array.isArray(body.output) ? body.output : []).filter(item => item?.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content : []);
  if (blocks.some(block => block?.type === 'refusal')) throw new NanoError('refused', 'GPT declined to describe these images. Change the prompt or references and try again.');
  if (body.error || ['failed', 'cancelled'].includes(body.status)) throw describeError(0, body.error);
  const text = blocks.filter(block => block?.type === 'output_text' && typeof block.text === 'string').map(block => block.text).join('\n\n').trim();
  if (!text) throw new NanoError('no_text', body.incomplete_details?.reason === 'max_output_tokens'
    ? 'GPT reached its output limit without a description. Try a shorter focus or fewer images.' : 'GPT returned no description. Try again.');
  return { text, usage: body.usage };
}
// High detail caps each image at 2,500 patches × 1.2 tokens; reserve the entire output allowance, including reasoning.
export function gptDescribeEstimate({ promptLength = 0, references = 0 } = {}) {
  return ((Math.ceil(promptLength / 3) + references * 3000) * gptDescribePrices.input + 8000 * gptDescribePrices.output) / 1e6;
}
export function gptDescribeCost(usage, fallback) {
  if (!Number.isFinite(usage?.input_tokens) || !Number.isFinite(usage?.output_tokens)) return gptDescribeEstimate(fallback);
  // output_tokens already includes reasoning_tokens.
  return (Math.max(0, usage.input_tokens) * gptDescribePrices.input + Math.max(0, usage.output_tokens) * gptDescribePrices.output) / 1e6;
}
