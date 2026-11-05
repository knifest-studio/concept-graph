import { collectInputs, describeModel, isDescribe, nanoModel, promptText, runInputs } from '../graph.mjs';
import { imageFormat, imageTypes } from './assets.mjs';

// Nano Banana 2.1 through the Gemini Interactions API, the request the image-generation guide documents (read 2026-11-04):
// https://aistudio.google.com/docs/image-generation and, for the Interaction object (steps, usage, errors),
// https://aistudio.google.com/api-reference/interactions-api/create-interaction and https://aistudio.google.com/docs/api-errors
export { describeModel, nanoModel };
const apiRevision = '2026-05-20', googleEndpoint = 'https://generativelanguage.googleapis.com';

// Standard paid tier of gemini-nano-banana-2.1 in USD per 1M tokens, read 2026-11-04 from https://aistudio.google.com/docs/pricing.
// A 1K output image is 1120 tokens ($0.0336); thinking is billed as text output; there is no free tier for image output.
export const nanoPrices = Object.freeze({ readOn: '2026-11-04', input: 1.5, textOutput: 7.5, imageOutput: 30, imageTokens: 1120 });
// Standard paid tier of gemini-3.5-flash-lite, same page and day: text and image input, then text and thinking output.
export const describePrices = Object.freeze({ readOn: '2026-11-04', input: .3, output: 2.5 });
export const nanoTimeout = 5 * 60 * 1000;
export const maxReferenceBytes = 20 * 1024 * 1024;

export class NanoError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// Entries are emails or whole domains (`@example.com`), separated by commas, semicolons or spaces, in any case.
export function nanoAllowed(email, list) {
  if (typeof email !== 'string' || typeof list !== 'string') return false;
  const address = email.trim().toLowerCase(), at = address.lastIndexOf('@'), domain = address.slice(at + 1);
  if (at < 1 || !domain) return false;
  return list.toLowerCase().split(/[\s,;]+/).some(entry => entry && (entry.startsWith('@') ? entry.slice(1) === domain : entry.includes('@') ? entry === address : entry === domain));
}

const limit = (value, fallback) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};
// The endpoint override exists for a local fake server only, so the key can never be sent to another host by mistake.
const localEndpoint = value => {
  try { const url = new URL(value); return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol) ? url.origin : null; }
  catch { return null; }
};

export function nanoSettings(env) {
  return {
    configured: typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim() !== '',
    dailyImages: Math.floor(limit(env.NANO_BANANA_DAILY_IMAGES, 50)), monthlyUsd: limit(env.NANO_BANANA_MONTHLY_USD, 50),
    endpoint: (env.NANO_BANANA_ENDPOINT && localEndpoint(env.NANO_BANANA_ENDPOINT)) || googleEndpoint,
  };
}

// The inputs a Codex run would get (runInputs decides which), written for an image model instead of an agent.
export function nanoPrompt(graph, nodeId) {
  // A describe node asks for the same written description Codex would give, from a text model.
  if (isDescribe(graph.nodes.find(node => node.id === nodeId))) {
    const { prompt, images, target } = collectInputs(graph, nodeId);
    return { prompt, images: images.map(asset => ({ asset })), target, describe: true };
  }
  const { target, images, context } = runInputs(graph, nodeId);
  const prompt = [
    context.length ? 'Create an image for the request at the end. The earlier text is context for it, not separate requests.' : '',
    ...context.map((node, i) => `Context ${i + 1}:\n${promptText(node)}`),
    images.length ? 'Reference images, attached in this order:\n' + images.map((image, i) => `Image ${i + 1}: ${image.label}`).join('\n') : '',
    `${context.length || images.length ? 'Request:\n' : ''}${promptText(target)}`,
  ].filter(Boolean).join('\n\n');
  if (prompt.length > 150000) throw new Error('Connected text is too long. Disconnect some context.');
  return { prompt, images, target };
}

// Usage figures are shown only to people who may use the site's Gemini key.
export async function nanoStatus(user, env, directory) {
  const settings = nanoSettings(env), allowed = await directory.nanoAllowed(user.email);
  if (!settings.configured || !allowed) return { configured: settings.configured, allowed };
  const { usedToday, teamSpentUsd } = await directory.nanoUsage(user.email);
  return { configured: true, allowed: true, dailyImages: settings.dailyImages, usedToday, monthlyUsd: settings.monthlyUsd, teamSpentUsd: Math.round(teamSpentUsd * 100) / 100 };
}

export function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

// One request per Generate. `references` are { mimeType, data (base64) } in prompt order.
export function nanoRequest(prompt, references, { key, endpoint }, model = nanoModel) {
  return { url: `${endpoint}/v1beta/interactions`, init: {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'Api-Revision': apiRevision },
    // Nothing needs a follow-up turn, so the interaction is not kept in Google's interaction history.
    body: JSON.stringify({ model, input: [{ type: 'text', text: prompt }, ...references.map(image => ({ type: 'image', mime_type: image.mimeType, data: image.data }))], store: false }),
  } };
}

const blocked = new Set(['safety', 'recitation', 'language', 'prohibited_content', 'spii', 'blocklist', 'content_blocked', 'jailbreak', 'image_safety', 'image_prohibited_content', 'image_recitation', 'image_other']);
// Codes are snake_case, URIs in Interaction.errors, or gRPC names in older error bodies.
const errorCode = value => typeof value === 'string' ? value.split(/[/#]/).pop().toLowerCase() : '';
const clean = (value, length = 200) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, length) : '';

export function nanoError(status, code, message) {
  const busy = 'Nano Banana is busy right now. Try again in a minute.';
  if (blocked.has(code)) return new NanoError('refused', 'Nano Banana declined this prompt or its references (Google’s safety filters). Change them and try again.');
  if (code === 'quota_exceeded') return new NanoError('busy', 'The site’s Gemini quota is used up for now. Try again later, or ask the site owner to raise it.');
  if (status === 429 || [503, 504].includes(status) || ['rate_limit_exceeded', 'too_many_requests', 'resource_exhausted', 'service_unavailable', 'unavailable', 'deadline_exceeded'].includes(code)) return new NanoError('busy', busy);
  if ([401, 403].includes(status) || ['authentication', 'unauthenticated', 'permission_denied'].includes(code)) return new NanoError('config', 'Google rejected the site’s Gemini API key. Ask the site owner to check it.');
  if (status === 402 || code === 'payment_required') return new NanoError('config', 'The site’s Gemini account needs billing set up. Ask the site owner.');
  if (status === 404 || code === 'model_not_found') return new NanoError('config', 'Nano Banana 2.1 is not available to the site’s Gemini key.');
  if (status === 400 || ['invalid_request', 'invalid_argument', 'parameter_unknown', 'failed_precondition', 'out_of_range'].includes(code)) {
    const detail = clean(message);
    return new NanoError('bad_request', `Nano Banana could not use this request${detail ? `: ${detail}` : '.'}`);
  }
  return new NanoError('upstream', `Nano Banana failed${status ? ` (${status})` : ''}. Try again.`);
}

function decodeImage(data) {
  let bytes, format;
  try { const binary = atob(data); bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); }
  catch { throw new NanoError('upstream', 'Nano Banana returned an unreadable image. Try again.'); }
  try { format = imageFormat(bytes); }
  catch { throw new NanoError('upstream', 'Nano Banana returned an image format the board cannot show.'); }
  return { bytes, format, contentType: imageTypes[format] };
}

// Every final image in the response, in order; thought steps can carry draft images, so only model output counts.
export function nanoResult(status, body) {
  if (status < 200 || status > 299) {
    const error = body?.error;
    throw nanoError(status, errorCode(typeof error?.code === 'string' ? error.code : error?.status), error?.message);
  }
  if (!body || typeof body !== 'object') throw new NanoError('upstream', 'Nano Banana returned an unreadable response. Try again.');
  const blocks = [...(Array.isArray(body.steps) ? body.steps : []).filter(step => step?.type === 'model_output').flatMap(step => Array.isArray(step.content) ? step.content : []),
    ...(Array.isArray(body.outputs) ? body.outputs : [])];
  const images = blocks.filter(block => block?.type === 'image' && typeof block.data === 'string' && block.data).map(block => decodeImage(block.data));
  if (!images.length) {
    const failure = Array.isArray(body.errors) ? body.errors[0] : undefined;
    if (failure || ['failed', 'cancelled'].includes(body.status)) throw nanoError(0, errorCode(failure?.code), failure?.message);
    const text = clean(blocks.filter(block => block?.type === 'text').map(block => block.text).join(' '));
    throw new NanoError('no_image', text ? `Nano Banana returned no image: “${text}”` : 'Nano Banana returned no image. Try rephrasing the prompt.');
  }
  return { images, usage: body.usage };
}

const tokens = value => Number.isFinite(value) && value > 0 ? value : 0;
// A deliberately high guess, used to reserve budget before the call and when Google reports no usage:
// the prompt at about 3 characters per token, each reference at full resolution, and a generous thinking allowance.
export function nanoEstimate({ promptLength = 0, references = 0, images = 1 } = {}) {
  const input = Math.ceil(promptLength / 3) + references * nanoPrices.imageTokens;
  return (input * nanoPrices.input + images * nanoPrices.imageTokens * nanoPrices.imageOutput + 4000 * nanoPrices.textOutput) / 1e6;
}

// A description's reserve: the prompt, each reference as a full tile set, and a generous answer with thinking.
export function describeEstimate({ promptLength = 0, references = 0 } = {}) {
  return ((Math.ceil(promptLength / 3) + references * 1500) * describePrices.input + 6000 * describePrices.output) / 1e6;
}
export function describeCost(usage, fallback) {
  if (!usage || typeof usage !== 'object' || !(Number.isFinite(usage.total_input_tokens) || Number.isFinite(usage.total_output_tokens))) return describeEstimate(fallback);
  return (tokens(usage.total_input_tokens) * describePrices.input + (tokens(usage.total_output_tokens) + tokens(usage.total_thought_tokens)) * describePrices.output) / 1e6;
}

// The written answer of a describe call; errors read like those of image calls.
export function describeResult(status, body) {
  if (status < 200 || status > 299) {
    const error = body?.error;
    throw nanoError(status, errorCode(typeof error?.code === 'string' ? error.code : error?.status), error?.message);
  }
  if (!body || typeof body !== 'object') throw new NanoError('upstream', 'Gemini returned an unreadable response. Try again.');
  const blocks = [...(Array.isArray(body.steps) ? body.steps : []).filter(step => step?.type === 'model_output').flatMap(step => Array.isArray(step.content) ? step.content : []),
    ...(Array.isArray(body.outputs) ? body.outputs : [])];
  const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n\n').trim();
  if (!text) {
    const failure = Array.isArray(body.errors) ? body.errors[0] : undefined;
    if (failure || ['failed', 'cancelled'].includes(body.status)) throw nanoError(0, errorCode(failure?.code), failure?.message);
    throw new NanoError('no_text', 'Gemini returned no description. Try again.');
  }
  return { text, usage: body.usage };
}

// What the call cost, from the usage Google returned with it.
export function nanoCost(usage, fallback) {
  if (!usage || typeof usage !== 'object' || !(Number.isFinite(usage.total_input_tokens) || Number.isFinite(usage.total_output_tokens))) return nanoEstimate(fallback);
  const image = (Array.isArray(usage.output_tokens_by_modality) ? usage.output_tokens_by_modality : []).find(entry => String(entry?.modality).toLowerCase() === 'image');
  const imageTokens = image ? tokens(image.tokens) : (fallback?.images ?? 1) * nanoPrices.imageTokens, text = Math.max(0, tokens(usage.total_output_tokens) - imageTokens);
  return (tokens(usage.total_input_tokens) * nanoPrices.input + imageTokens * nanoPrices.imageOutput + (text + tokens(usage.total_thought_tokens)) * nanoPrices.textOutput) / 1e6;
}
