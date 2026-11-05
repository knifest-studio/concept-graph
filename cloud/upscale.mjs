import { runInputs, nanoModel, seedvrModel, topazModel, upscalerOf, upscalers, upscaleScale } from '../graph.mjs';
import { imageFormat, imageTypes } from './assets.mjs';
import { NanoError, nanoPrices } from './nano-banana.mjs';

// Upscaling, run by the board's room like Nano Banana and paid the same way (the person's daily images, the team's month).
// Topaz and SeedVR2 run on fal.ai's queue API (https://fal.ai/docs/model-apis/model-endpoints/queue, read 2026-11-05):
// POST https://queue.fal.run/<model> with `Authorization: Key <FAL_KEY>`, poll the returned status_url until COMPLETED,
// then GET the response_url; image inputs may be base64 data URIs. Nano Banana redraws the image at 2K or 4K
// (`response_format.image_size`, https://aistudio.google.com/docs/image-generation).
export const upscaleModels = Object.freeze({ [upscalers.topaz]: topazModel, [upscalers.seedvr]: seedvrModel, [upscalers.nanoBanana]: nanoModel });
// Nothing larger than 8K on its long side: bigger files would be slow for everyone on the board to open.
export const maxUpscaleSide = 8192;
const falHost = 'https://queue.fal.run', poll = 1500;

// Prices read 2026-11-05 from the fal.ai model pages: Topaz is $0.08 per image up to 24 MP of output, doubling with each
// size step to $1.36 at 512 MP; SeedVR2 is $0.001 per output megapixel. Nano Banana 2.1 bills 1,680 output tokens at 2K
// and 3,780 at 4K (https://aistudio.google.com/docs/pricing).
export const upscalePrices = Object.freeze({ readOn: '2026-11-05', topaz: [[24, .08], [48, .16], [96, .32], [192, .64], [512, 1.36]], seedvrPerMegapixel: .001, nanoTokens: { 2: 1680, 4: 3780 } });

const localEndpoint = value => {
  try { const url = new URL(value); return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol) ? url.origin : null; }
  catch { return null; }
};
// FAL_UPSCALERS=off keeps Topaz and SeedVR2 out of the board while the fal.ai account has no credit, without removing the
// key. The endpoint override exists for a local fake server only, so the key can never be sent to another host by mistake.
export const upscaleSettings = env => ({ fal: typeof env.FAL_KEY === 'string' && env.FAL_KEY.trim() !== '' && String(env.FAL_UPSCALERS ?? '').trim().toLowerCase() !== 'off', endpoint: (env.FAL_ENDPOINT && localEndpoint(env.FAL_ENDPOINT)) || falHost });

// What one upscale node asks for: its connected images, the upscaler and the size.
export function upscaleRequest(graph, nodeId) {
  const { target, images } = runInputs(graph, nodeId);
  return { upscale: true, target, images, upscaler: upscalerOf(target), scale: upscaleScale(target) };
}

// How much larger an image can become: the chosen size, unless that passes 8K. Nano Banana works in fixed sizes instead.
export function upscaleFactor({ width, height }, scale) {
  const factor = Math.min(scale, maxUpscaleSide / Math.max(width, height));
  if (factor < 1.25) throw new NanoError('bad_request', 'This image is already as large as an upscale can make it.');
  return Math.floor(factor * 100) / 100;
}

const megapixels = (width, height) => width * height / 1e6;
export function upscaleCost(upscaler, scale, pixels) {
  // The source image as input, the output image, and room for thinking.
  if (upscaler === upscalers.nanoBanana) return (nanoPrices.imageTokens * nanoPrices.input + upscalePrices.nanoTokens[scale] * nanoPrices.imageOutput + 2000 * nanoPrices.textOutput) / 1e6;
  const size = pixels ? megapixels(pixels.width, pixels.height) : megapixels(maxUpscaleSide, maxUpscaleSide);
  if (upscaler === upscalers.seedvr) return Math.max(.001, size * upscalePrices.seedvrPerMegapixel);
  return (upscalePrices.topaz.find(([most]) => size <= most) || upscalePrices.topaz.at(-1))[1];
}
// Reserved before the call: the largest output the chosen size can produce (an 8K square at worst).
export const upscaleEstimate = (upscaler, scale, source) => upscaleCost(upscaler, scale, source ? (factor => ({ width: Math.round(source.width * factor), height: Math.round(source.height * factor) }))(Math.min(scale, maxUpscaleSide / Math.max(source.width, source.height))) : null);

// Topaz's precision model keeps the picture as it is; SeedVR2 restores detail. Both return JPEG to keep 4K files small.
export function falInput(upscaler, factor, dataUri) {
  if (upscaler === upscalers.seedvr) return { image_url: dataUri, upscale_mode: 'factor', upscale_factor: factor, output_format: 'jpg' };
  return { image_url: dataUri, model: 'Standard V2', upscale_factor: factor, output_format: 'jpeg' };
}

// The shapes Nano Banana 2.1 draws (https://aistudio.google.com/docs/image-generation, read 2026-11-05).
const nanoRatios = [['1:1', 1], ['2:3', 2 / 3], ['3:2', 3 / 2], ['3:4', 3 / 4], ['4:3', 4 / 3], ['4:5', 4 / 5], ['5:4', 5 / 4], ['9:16', 9 / 16], ['16:9', 16 / 9], ['21:9', 21 / 9], ['1:4', 1 / 4], ['4:1', 4], ['1:8', 1 / 8], ['8:1', 8]];
const nearestRatio = ({ width, height }) => nanoRatios.reduce((best, item) => Math.abs(Math.log(item[1] * height / width)) < Math.abs(Math.log(best[1] * height / width)) ? item : best);
export const nanoAspect = size => nearestRatio(size)[0];
// Nano Banana fills whatever shape it is asked for, so an image of another shape would come back cropped or reframed. It
// goes in padded to the nearest shape instead (`frame`, the image at left/top inside it), and the answer is cut back.
export function nanoFrame(size) {
  const [aspect, ratio] = nearestRatio(size), shape = size.width / size.height;
  if (Math.abs(Math.log(ratio / shape)) < .004) return { aspect, frame: { ...size }, left: 0, top: 0, padded: false };
  const frame = ratio > shape ? { width: Math.round(size.height * ratio), height: size.height } : { width: size.width, height: Math.round(size.width / ratio) };
  return { aspect, frame, left: Math.floor((frame.width - size.width) / 2), top: Math.floor((frame.height - size.height) / 2), padded: true };
}
// Where the original sits in an answer of `size` drawn from that frame: the full width or height, and the other side
// from the original's exact shape, so rounding the frame to whole pixels never skews it.
export function nanoContent(plan, source, size) {
  if (plan.frame.width > source.width) {
    const width = Math.min(size.width, Math.round(size.height * source.width / source.height));
    return { left: Math.min(size.width - width, Math.round(plan.left * size.width / plan.frame.width)), top: 0, width, height: size.height };
  }
  const height = Math.min(size.height, Math.round(size.width * source.height / source.width));
  return { left: 0, top: Math.min(size.height - height, Math.round(plan.top * size.height / plan.frame.height)), width: size.width, height };
}
export const nanoUpscalePrompt = 'Upscale this image to a higher resolution. Keep the composition, framing, subjects, colours, lighting, style and every detail exactly as they are, in the same place: only add resolution, sharpness and fine texture. Do not crop, zoom, reframe, add, remove or change anything, and do not add text or borders.';
// The answer comes back as a JPEG; Google accepts no other mime_type here.
export const nanoUpscaleFormat = (scale, frame) => ({ type: 'image', image_size: scale === 4 ? '4K' : '2K', ...(frame ? { aspect_ratio: nanoAspect(frame) } : {}) });

const falError = (status, detail) => {
  if ([401, 403].includes(status)) return new NanoError('config', 'fal.ai rejected the site’s key. Ask the site owner to check FAL_KEY.');
  if (status === 402) return new NanoError('config', 'The site’s fal.ai account is out of credit. Ask the site owner to top it up.');
  if (status === 422 || status === 400) return new NanoError('bad_request', `The upscaler could not use this image${detail ? `: ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}` : '.'}`);
  if (status === 429 || status >= 500) return new NanoError('busy', 'The upscaler is busy right now. Try again in a minute.');
  return new NanoError('upstream', `The upscaler failed${status ? ` (${status})` : ''}. Try again.`);
};
const detailOf = body => typeof body?.detail === 'string' ? body.detail : Array.isArray(body?.detail) ? body.detail.map(item => item?.msg).filter(Boolean).join('; ') : body?.error;
const json = async response => response.json().catch(() => null);
const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); }, { once: true });
});

// One upscale on fal.ai's queue. A cancelled call is also cancelled there, so the site is not billed for work nobody wants.
// `onQueued` runs once fal.ai has accepted the job, from when it may bill it.
export async function falUpscale({ key, endpoint = falHost, model, input, signal, onQueued = () => {}, fetcher = fetch }) {
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  const submitted = await fetcher(`${endpoint}/${model}`, { method: 'POST', headers, body: JSON.stringify(input), signal });
  const queued = await json(submitted);
  if (!submitted.ok) throw falError(submitted.status, detailOf(queued));
  const own = url => typeof url === 'string' && url.startsWith(`${endpoint}/`) ? url : null;
  const statusUrl = own(queued?.status_url), responseUrl = own(queued?.response_url), cancelUrl = own(queued?.cancel_url);
  if (!statusUrl || !responseUrl) throw new NanoError('upstream', 'The upscaler returned an unreadable response. Try again.');
  onQueued();
  const cancel = () => { if (cancelUrl) fetcher(cancelUrl, { method: 'PUT', headers }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const response = await fetcher(statusUrl, { headers, signal }), status = await json(response);
      if (!response.ok) throw falError(response.status, detailOf(status));
      if (status?.status === 'COMPLETED') { if (status.error) throw falError(422, status.error); break; }
      await wait(poll, signal);
    }
    const response = await fetcher(responseUrl, { headers, signal }), result = await json(response);
    if (!response.ok) throw falError(response.status, detailOf(result));
    const url = result?.image?.url;
    // fal.ai serves results over HTTPS (or inline); a local fake may use its own plain-HTTP address.
    if (typeof url !== 'string' || !(/^(https:|data:image\/)/.test(url) || (endpoint !== falHost && url.startsWith(`${endpoint}/`)))) throw new NanoError('upstream', 'The upscaler returned no image. Try again.');
    const file = await fetcher(url, { signal });
    if (!file.ok) throw new NanoError('upstream', 'Could not download the upscaled image. Try again.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let format;
    try { format = imageFormat(bytes); } catch { throw new NanoError('upstream', 'The upscaler returned an image format the board cannot show.'); }
    return { bytes, format, contentType: imageTypes[format] };
  } finally { signal?.removeEventListener('abort', cancel); }
}
