import { gptImageModel, isDescribe, isUpscale } from '../graph.mjs';
import { decodeImage, localEndpoint, NanoError, nanoPrompt, nanoSettings, nanoStatus } from './nano-banana.mjs';

// Images API contract and prices supplied from the official docs, read 2026-11-13:
// https://developers.openai.com/api/reference/resources/images and https://developers.openai.com/api/docs/pricing
export { gptImageModel };
export const gptImagePrices = Object.freeze({ readOn: '2026-11-13', textInput: 5, imageInput: 8, imageOutput: 30 });
const endpoint = 'https://api.openai.com', maxDataUrl = 20971520;

export function gptImageSettings(env) {
  return { ...nanoSettings(env), configured: typeof env.OPENAI_API_KEY === 'string' && !!env.OPENAI_API_KEY.trim(),
    endpoint: localEndpoint(env.GPT_IMAGE_ENDPOINT) || endpoint };
}
export const gptImageStatus = (user, env, directory) => nanoStatus(user, env, directory, gptImageSettings(env));

export function gptImagePrompt(graph, nodeId) {
  const request = nanoPrompt(graph, nodeId, { maskInput: true, leadEdited: true });
  if (isDescribe(request.target) || isUpscale(request.target)) throw new NanoError('bad_request', 'GPT Image only generates images.');
  if (request.prompt.length > 32000) throw new NanoError('bad_request', 'Connected text is too long for GPT Image (32,000 characters). Disconnect some context.');
  return request;
}

// As on image nodes, aspect is height / width. There is no prompt size picker yet.
export function gptImageSize(aspect = 1) {
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return [[1, '1024x1024'], [2 / 3, '1536x1024'], [1.5, '1024x1536']]
    .sort((a, b) => Math.abs(Math.log(ratio / a[0])) - Math.abs(Math.log(ratio / b[0])))[0][1];
}

export function gptImageRequest(prompt, references, { key, endpoint: base = endpoint, aspect, mask } = {}) {
  // Without a chosen size the output keeps the shape of the image being edited, as Nano Banana does.
  const edited = references[0]?.size;
  if (!(aspect > 0) && edited?.width > 0 && edited?.height > 0) aspect = edited.height / edited.width;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw new NanoError('bad_request', 'GPT Image needs a prompt of at most 32,000 characters.');
  if (references.length > 16) throw new NanoError('bad_request', 'GPT Image accepts at most 16 reference images.');
  const imageUrl = image => {
    const image_url = `data:${image.mimeType};base64,${image.data}`;
    if (image_url.length > maxDataUrl) throw new NanoError('bad_request', 'A reference image is too large for GPT Image. Use a smaller image.');
    return { image_url };
  };
  const images = references.map(imageUrl);
  if (mask && (!images.length || mask.mimeType !== 'image/png' || references[0].mimeType !== 'image/png'
    || !mask.size?.width || mask.size.width !== references[0].size?.width || mask.size.height !== references[0].size?.height)) throw new NanoError('bad_request', 'The mask and its image must be PNGs with the same dimensions. Paint the mask again.');
  return { url: `${base}/v1/images/${images.length ? 'edits' : 'generations'}`, init: {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: gptImageModel, prompt, n: 1, size: gptImageSize(aspect), quality: 'medium', output_format: 'png', moderation: 'auto', ...(images.length ? { images } : {}), ...(mask ? { mask: imageUrl(mask) } : {}) }),
  } };
}

export function gptImageError(status, code = '', message = '') {
  if (code === 'insufficient_quota' || status === 402 || /billing|credit balance|out of credit/i.test(`${code} ${message}`)) return new NanoError('config', 'The site’s OpenAI account is out of credit or needs billing set up. Ask the site owner.');
  if (/moderation_blocked|content_policy|safety/i.test(code) || (status === 400 && /content policy|safety|moderation/i.test(message))) return new NanoError('refused', 'GPT Image declined this prompt or its references (OpenAI’s safety filters). Change them and try again.');
  if (status === 401) return new NanoError('config', 'OpenAI rejected the site’s API key. Ask the site owner to check it.');
  if (status === 403 && /verif/i.test(message)) return new NanoError('config', 'The site’s OpenAI organization must be verified to use GPT Image. Ask the site owner.');
  if (status === 403) return new NanoError('config', 'OpenAI denied access to GPT Image. Ask the site owner to check the API key and organization.');
  if (status === 429 || [503, 504].includes(status) || code === 'rate_limit_exceeded') return new NanoError('busy', 'GPT Image is busy right now. Try again in a minute.');
  if (status === 404 || code === 'model_not_found') return new NanoError('config', 'GPT Image is not available to the site’s OpenAI key.');
  // Provider messages may echo request data; keep unexpected details out of the shared board.
  if (status === 400) return new NanoError('bad_request', 'GPT Image could not use this request. Check the prompt and reference images.');
  return new NanoError('upstream', `GPT Image failed${status ? ` (${status})` : ''}. Try again.`);
}

export function gptImageResult(status, body) {
  if (status < 200 || status > 299) throw gptImageError(status, body?.error?.code || body?.error?.type, body?.error?.message);
  if (!body || typeof body !== 'object') throw new NanoError('upstream', 'GPT Image returned an unreadable response. Try again.');
  const images = (Array.isArray(body.data) ? body.data : []).filter(item => typeof item?.b64_json === 'string' && item.b64_json).map(item => decodeImage(item.b64_json, 'GPT Image'));
  if (!images.length) throw new NanoError('no_image', 'GPT Image returned no image. Try rephrasing the prompt.');
  return { images, usage: body.usage };
}

const tokens = value => Number.isFinite(value) && value >= 0 ? value : 0;
export function gptImageEstimate({ promptLength = 0, references = 0, images = 1 } = {}) {
  // Hold more than a typical medium image costs, including generously sized reference inputs.
  return images * .25 + (Math.ceil(promptLength / 3) * gptImagePrices.textInput + references * 16000 * gptImagePrices.imageInput) / 1e6;
}
export function gptImageCost(usage, fallback) {
  if (!Number.isFinite(usage?.input_tokens) || !Number.isFinite(usage?.output_tokens)) return gptImageEstimate(fallback);
  const input = tokens(usage.input_tokens), detail = usage.input_tokens_details;
  const image = Math.min(input, Number.isFinite(detail?.image_tokens) ? tokens(detail.image_tokens) : fallback?.references ? input : 0);
  const text = Number.isFinite(detail?.text_tokens) ? tokens(detail.text_tokens) : input - image;
  const output = Number.isFinite(usage.output_tokens_details?.image_tokens) ? tokens(usage.output_tokens_details.image_tokens) : tokens(usage.output_tokens);
  return (text * gptImagePrices.textInput + image * gptImagePrices.imageInput + output * gptImagePrices.imageOutput) / 1e6;
}
