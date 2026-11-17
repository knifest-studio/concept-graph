import { imageSize } from '../graph.mjs';

// Reference images are sent smaller than they are stored, so an 8K upload works as a reference while the board keeps
// the original. Pure rules here; the board room reads the files and makes the copies with Cloudflare Images.
//
// Cloudflare Images takes at most 20 MB through the binding's .input()
// (https://developers.cloudflare.com/images/get-started/limits/, read 2026-11-16).
export const transformInputBytes = 20 * 1024 * 1024;
// GPT Image and upscales keep the 20 MB in total the board has always allowed (Gemini's budget is below).
export const referenceTotalBytes = 20 * 1024 * 1024;
// Each GPT Image data URL is at most 20,971,520 characters (OpenAI Images API reference): about 15 MB of raw bytes.
const gptDataUrl = 20971520, gptImageBytes = Math.floor((gptDataUrl - 32) / 4) * 3;
// Gemini counts the whole request, images as base64 text, against 20 MB: "Inline image data limits your total request
// size (text prompts, system instructions, and inline bytes) to 20MB" (https://aistudio.google.com/docs/image-understanding,
// read 2026-11-16; https://aistudio.google.com/docs/file-input-methods says 100 MB, so the stricter page is followed).
// Images get three quarters of it, less room for the prompt: about 14.8 MB of files.
const geminiRequestBytes = 20 * 1024 * 1024, promptRoom = 256 * 1024;
export const geminiReferenceBytes = Math.floor((geminiRequestBytes - promptRoom) / 4) * 3;
// Gemini bills a fixed number of tokens per image whatever its size, so pixels past 3K buy nothing; GPT Image takes
// edits up to 16,777,216 px. 3D keeps its rule: over 6 MB or 4096 px, a 2048 px JPEG (Hunyuan takes up to 5000 px, 8 MB).
const nano = Object.freeze({ side: 3072, totalBytes: geminiReferenceBytes });
export const referenceLimits = Object.freeze({
  nanoBanana: nano, describe: nano,
  gptImage: Object.freeze({ side: 4096, pixels: 16777216, totalBytes: referenceTotalBytes, maxBytes: gptImageBytes }),
  model3d: Object.freeze({ over: 4096, side: 2048, prepBytes: 6 * 1024 * 1024, format: 'image/jpeg' }),
  // Upscales go in at full size: they exist to add detail.
  upscale: Object.freeze({ totalBytes: referenceTotalBytes, untouched: true }),
});
// A set still too large after the first reduction is tried again at these longest sides before it fails.
export const fallbackSides = Object.freeze([2048, 1536]);
export const headerBytes = 256 * 1024;

export function sniffFormat(bytes) {
  const starts = (values, offset = 0) => values.every((value, i) => bytes[offset + i] === value);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
  if (starts([255, 216, 255])) return 'jpg';
  if (starts([71, 73, 70, 56])) return 'gif';
  if (starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)) return 'webp';
  return null;
}

// Whether the start of a file says the image can be transparent. A PNG whose image data starts past the bytes read is
// taken as transparent, so a copy never loses transparency it might have had.
export function hasAlpha(bytes) {
  const format = sniffFormat(bytes), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === 'png') {
    if (bytes.length < 26) return true;
    if ([4, 6].includes(bytes[25])) return true;
    for (let offset = 8; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (type === 'tRNS') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      offset += 12 + length;
    }
    return true;
  }
  if (format === 'webp') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = String.fromCharCode(...bytes.subarray(offset, offset + 4)), length = view.getUint32(offset + 4, true), start = offset + 8;
      if (type === 'VP8X') return start < bytes.length && !!(bytes[start] & 0x10);
      if (type === 'VP8L') return start + 5 <= bytes.length && !!((view.getUint32(start + 1, true) >>> 28) & 1);
      if (type === 'VP8 ') return false;
      if (type === 'ALPH') return true;
      offset = start + length + (length % 2);
    }
    return true;
  }
  return format === 'gif';
}

// What the room needs to know about a stored image: from the first bytes of the file and its stored size.
export function inspectImage(header, bytes) {
  const size = imageSize(header);
  return { format: sniffFormat(header), size: size?.width > 0 && size?.height > 0 ? { width: size.width, height: size.height } : null, bytes, alpha: hasAlpha(header) };
}

// The largest size within the limits that keeps the shape: never larger than the image, whole pixels, never 0.
export function targetSize({ width, height }, { side = Infinity, pixels = Infinity } = {}) {
  const scale = Math.min(1, side / Math.max(width, height), Math.sqrt(pixels / (width * height)));
  if (!(scale < 1)) return { width, height };
  let w = Math.max(1, Math.min(width, Math.round(width * scale))), h = Math.max(1, Math.min(height, Math.round(height * scale)));
  while (w * h > pixels && (w > 1 || h > 1)) { if (w >= h) w--; else h--; }
  return { width: w, height: h };
}

const longest = size => Math.max(size.width, size.height);
// `share` is the image's part of the set's byte budget: one image may use it all, ten get a tenth each.
export function needsPrep(info, limits, share = Infinity) {
  if (!limits || limits.untouched) return false;
  if (info.format === 'gif' || !info.size) return true;
  return longest(info.size) > (limits.over ?? limits.side ?? Infinity) || info.size.width * info.size.height > (limits.pixels ?? Infinity)
    || info.bytes > Math.min(share, limits.prepBytes ?? limits.maxBytes ?? Infinity);
}

// Transparent images stay PNG, others become JPEG (quality 90); a GIF becomes a still PNG of its first frame. A GPT
// Image mask and the image it edits must both be PNGs.
export function outputFormat(info, { png = false, format } = {}) {
  if (format) return format;
  return png || info.format === 'gif' || info.alpha ? 'image/png' : 'image/jpeg';
}
const extension = format => format === 'image/png' ? 'png' : 'jpg';
const sameFormat = (info, format) => (info.format === 'png' && format === 'image/png') || (info.format === 'jpg' && format === 'image/jpeg');

// One immutable copy per original, size and format: asset names never change, so a stored copy never goes stale.
export const derivedKey = (asset, step) => `derived/${asset}/${step.target ? `${step.target.width}x${step.target.height}` : `fit${step.side}`}.${extension(step.format)}`;

// For each image: whether to send a reduced copy, its size and format. `pair` lists images that must come out the same
// size as each other (a GPT Image mask and its image), so they get an exact size instead of a box.
export function planReferences(infos, limits, { side, pair = [] } = {}) {
  const share = (limits?.totalBytes ?? Infinity) / Math.max(1, infos.length), paired = new Set(pair);
  const applied = limits && side ? { ...limits, side, over: side } : limits;
  return infos.map((info, index) => {
    if (!needsPrep(info, applied, share)) return { prep: false };
    const format = outputFormat(info, { png: paired.has(index), format: limits.format }), target = info.size ? targetSize(info.size, applied) : null;
    // The same size in the same format would only spend a transformation; the size check decides whether it is too large.
    if (target && info.format !== 'gif' && target.width === info.size.width && target.height === info.size.height && sameFormat(info, format)) return { prep: false };
    const box = target ? Math.max(target.width, target.height) : applied.side;
    // A box rather than exact sides, so a photo turned by its EXIF orientation is reduced the same way.
    const transform = { ...(paired.has(index) && target ? { width: target.width, height: target.height } : { width: box, height: box }), fit: 'scale-down', ...(info.format === 'gif' ? { anim: false } : {}) };
    return { prep: true, target, side: box, format, transform };
  });
}

// Whether a set of byte sizes can be sent: the total and, for GPT Image, each data URL.
export const fitsLimits = (sizes, limits) => !limits || (sizes.reduce((total, size) => total + size, 0) <= (limits.totalBytes ?? Infinity) && sizes.every(size => size <= (limits.maxBytes ?? Infinity)));

// Whether the provider takes an image as it is when no copy can be made. The 3072 and 4096 px sides only save tokens;
// a GIF is not a format either provider reads, and 3D needs its JPEG rule.
export const sendsAsIs = (info, limits) => !!info && !limits?.format && ['png', 'jpg', 'webp'].includes(info.format) && info.bytes <= (limits?.maxBytes ?? Infinity);

export const megabytes = bytes => {
  const value = bytes / (1024 * 1024);
  return value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
};

// The first reason a set cannot be sent, found before anything is reserved, or null. Without Cloudflare Images nothing
// can be reduced, so the originals go as they are and must fit.
export function referenceProblem(infos, images, limits, { binding = false, name = 'Nano Banana', upscale = false, model3d = false } = {}) {
  if (infos.some(info => !info)) return upscale || model3d ? 'An image is missing from storage. Reconnect it and try again.' : 'A reference image is missing from storage. Reconnect it and try again.';
  if (upscale) return fitsLimits(infos.map(info => info.bytes), limits) ? null : 'Images to upscale can be at most 20 MB in total. Connect fewer.';
  const plan = planReferences(infos, limits), share = (limits?.totalBytes ?? Infinity) / Math.max(1, infos.length);
  if (binding) {
    // Any image over 20 MB has to be reduced (it alone fills the budget), and the binding cannot read it.
    const index = infos.findIndex(info => info.bytes > transformInputBytes && needsPrep(info, limits, share));
    return index < 0 ? null : tooLargeToReduce(images[index], infos[index].bytes);
  }
  if (model3d) return plan.some(step => step.prep) ? 'This image needs resizing. Ask the site owner to enable Cloudflare Images, or connect a smaller PNG, JPEG or WebP.' : null;
  if (limits?.maxBytes && infos.some(info => info.bytes > limits.maxBytes)) return `A reference image is too large for ${name}. Use a smaller image.`;
  return fitsLimits(infos.map(info => info.bytes), limits) ? null : `Reference images are too large for ${name} (${inTotal(limits)}). Use fewer or smaller images.`;
}

// Recovery offers only originals the binding cannot read; masks must be removed explicitly first.
export const overLimitReferences = (images, infos) => [...new Set(images.filter((image, index) => infos[index]?.bytes > transformInputBytes && typeof image.maskOf !== 'string' && !image.mask).map(image => image.asset))];
export function resizeRecovery(images, infos, problem) {
  const index = images.findIndex((image, index) => infos[index]?.bytes > transformInputBytes && problem === tooLargeToReduce(image, infos[index].bytes));
  return index >= 0 && typeof images[index].maskOf !== 'string' ? overLimitReferences(images, infos) : [];
}

// Rounded down, so the limit shown is never more than the real one (14.8 MB for Gemini, 20 MB otherwise).
const inTotal = limits => `${Math.floor((limits?.totalBytes ?? referenceTotalBytes) / (1024 * 1024) * 10) / 10} MB in total`;
// Inputs a mask made (GPT Image's base and mask, Nano Banana's marked copy) carry `maskOf`, the masked image's label.
// Resize refuses a masked image, so their messages name that image and say to take the mask off first.
const masked = image => typeof image?.maskOf === 'string';
const imageName = image => (masked(image) ? image.maskOf : image?.label) || 'Image';
const resizeHint = image => masked(image) ? 'Remove its mask, choose Resize…, then paint the mask again.' : 'Right-click it, choose Resize…, then try again.';
export const tooLargeToReduce = (image, bytes) => `“${imageName(image)}” is too large to reduce automatically (${megabytes(bytes)} MB; the limit is 20 MB). ${resizeHint(image)}`;
export const couldNotReduce = image => `Could not reduce “${imageName(image)}” to send it. ${resizeHint(image)}`;
export const stillTooLarge = (name, limits) => `Reference images are still too large for ${name} after reducing them (${inTotal(limits)}). Use fewer images.`;
