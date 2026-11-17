import { imageSize, runInputs } from '../graph.mjs';
import { hasAlpha, headerBytes, megabytes, sniffFormat, targetSize } from '../cloud/reference-prep.mjs';
import { imageCanvas, loadEditImage } from './image-edit-canvas.mjs';
import { resizedImageData } from './image-edits.mjs';
import { t } from './i18n.mjs';

// Uploads are capped at 30 MB (cloud/assets.mjs, server.mjs); browsers draw and display images up to 16,384 px.
export const uploadLimits = Object.freeze({ bytes: 30 * 1024 * 1024, side: 16384 });
// Codex fits prompt images within 2048 px itself (openai/codex utils/image), so a 3K copy loses nothing it would use.
export const codexSide = 3072;
export const resizePresets = Object.freeze([['4K', 4096], ['3K', 3072], ['2K', 2048], ['1K', 1024]]);
// Safari refuses canvases over 16,777,216 px (WebKit's limit); larger drawing work goes through smaller steps.
const canvasArea = 16777216, workingArea = 50e6;

export const longerSide = pixels => Math.max(pixels.width, pixels.height);
// The size Resize makes for a longer side, or null when that would not make the image smaller.
export function resizeTarget(pixels, side) {
  if (!(Number.isInteger(side) && side >= 1) || side >= longerSide(pixels)) return null;
  return targetSize(pixels, { side });
}
export const halfSide = pixels => Math.max(1, Math.round(longerSide(pixels) / 2));
// Both Resize… and bulk recovery choose the first smaller preset, then half the image.
export const defaultResizeSide = pixels => resizePresets.find(([, side]) => resizeTarget(pixels, side))?.[1] ?? halfSide(pixels);
export function resizeAllTargets(graph, nodeId, assets) {
  const wanted = new Set(assets), { ordered } = runInputs(graph, nodeId);
  return ordered.filter(node => node.type === 'image' ? !node.data.mask && wanted.has(node.data.asset)
    : node.type === 'text' && node.data.template?.assets.some(asset => wanted.has(asset)));
}
export async function loadResizeImage(asset, assetUrl) {
  const response = await fetch(assetUrl(asset), { credentials: 'same-origin' });
  if (!response.ok) throw new Error(t('Could not load the image for editing.'));
  const blob = await response.blob(), url = URL.createObjectURL(blob);
  try { return { image: await loadEditImage(url), bytes: blob.size }; }
  finally { URL.revokeObjectURL(url); }
}
export async function saveResizedImage(data, image, target, upload) {
  const pixels = { width: image.naturalWidth, height: image.naturalHeight };
  const asset = await upload(await resizedBlob(image, target, resizedType(data.asset)));
  return resizedImageData(data, asset, target, pixels);
}

// A rough guess from the current file: bytes shrink about with the pixel count.
export const estimatedBytes = (bytes, from, to) => Math.max(1, Math.round(bytes * (to.width * to.height) / (from.width * from.height)));
export const sizeText = (pixels, bytes) => bytes ? t('{width} × {height}, {size} MB', { width: pixels.width, height: pixels.height, size: megabytes(bytes) }) : `${pixels.width} × ${pixels.height}`;
// The format a resized copy keeps: JPEG and WebP stay themselves, others (GIF too) become PNG, as a crop does.
export const resizedType = asset => asset.endsWith('.jpg') ? 'image/jpeg' : asset.endsWith('.webp') ? 'image/webp' : 'image/png';

// Sizes to try for an upload that is too large: the full size if it fits, then smaller ones, largest first.
export function uploadSizes(pixels, side = uploadLimits.side) {
  const sizes = [side, 8192, 6144, 4096, 3072, 2048].filter(value => value <= side).map(value => targetSize(pixels, { side: value, pixels: workingArea }));
  return sizes.filter((size, index) => sizes.findIndex(other => other.width === size.width && other.height === size.height) === index);
}

// Halving first keeps the detail that one large jump would alias away; each step draws the one before it.
export function drawScaled(source, width, height) {
  const from = { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height };
  let current = source, size = from;
  while (size.width / 2 >= width && size.height / 2 >= height) {
    const next = { width: Math.round(size.width / 2), height: Math.round(size.height / 2) };
    // A step too large for the browser's canvas is skipped; the next one draws from the same source.
    if (next.width * next.height <= canvasArea) {
      const canvas = imageCanvas(next.width, next.height), context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high'; context.drawImage(current, 0, 0, next.width, next.height);
      if (current !== source) current.width = current.height = 0;
      current = canvas;
    }
    size = next;
  }
  const canvas = imageCanvas(width, height), context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high'; context.drawImage(current, 0, 0, width, height);
  if (current !== source) current.width = current.height = 0;
  return canvas;
}

const encode = (canvas, type, quality = .92) => new Promise(resolve => { try { canvas.toBlob(resolve, type, quality); } catch { resolve(null); } });
const accepted = ['image/png', 'image/jpeg', 'image/webp'];

// A copy of an image file small enough to upload, or null when the file fits as it is. Transparent images become WebP
// (PNG where the browser cannot write WebP), others JPEG; the full size is kept when the re-encoded file fits.
export async function shrinkUpload(file, limits = uploadLimits) {
  const header = new Uint8Array(await file.slice(0, headerBytes).arrayBuffer()), size = imageSize(header);
  if (!sniffFormat(header) || (file.size <= limits.bytes && !(size && longerSide(size) > limits.side))) return null;
  const url = URL.createObjectURL(file), name = file.name || t('Pasted image'), alpha = hasAlpha(header);
  try {
    let image;
    try { image = await loadEditImage(url); }
    catch { throw new Error(t('Could not make a smaller copy of {name}. Reduce it in an image editor and upload it again.', { name })); }
    const from = { width: image.naturalWidth, height: image.naturalHeight };
    for (const target of uploadSizes(from, limits.side)) {
      let canvas;
      try { canvas = drawScaled(image, target.width, target.height); } catch { continue; }
      const tried = new Set();
      for (const type of alpha ? ['image/webp', 'image/png'] : ['image/jpeg']) {
        const blob = await encode(canvas, type);
        if (!blob || tried.has(blob.type)) continue;
        tried.add(blob.type);
        if (accepted.includes(blob.type) && blob.size <= limits.bytes) { canvas.width = canvas.height = 0; return { blob, from, to: target, fromBytes: file.size }; }
      }
      canvas.width = canvas.height = 0;
    }
    throw new Error(t('Could not make a smaller copy of {name}. Reduce it in an image editor and upload it again.', { name }));
  } finally { URL.revokeObjectURL(url); }
}

// A reference copy for Codex no larger than `side`, or null to send the file as it is (also outside a browser).
export async function referenceCopy(blob, side = codexSide) {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
  const header = new Uint8Array(await blob.slice(0, headerBytes).arrayBuffer()), size = imageSize(header);
  if (!sniffFormat(header) || !size || longerSide(size) <= side) return null;
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const target = targetSize({ width: bitmap.width, height: bitmap.height }, { side }), canvas = drawScaled(bitmap, target.width, target.height);
    // Most PNGs say they may be transparent, so those go as WebP, which keeps transparency small (PNG where unsupported).
    let copy = null;
    for (const type of hasAlpha(header) ? ['image/webp', 'image/png'] : ['image/jpeg']) {
      copy = await encode(canvas, type, .9);
      if (copy && accepted.includes(copy.type)) break;
    }
    canvas.width = canvas.height = 0;
    return copy && accepted.includes(copy.type) && copy.size < blob.size ? copy : null;
  } finally { bitmap.close?.(); }
}

// The resized file for Resize: the image's own format where the browser can write it, at most 30 MB.
export async function resizedBlob(image, target, type) {
  const canvas = drawScaled(image, target.width, target.height), blob = await encode(canvas, type, .95);
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error(t('Could not export the edited image. Try a smaller image.'));
  if (blob.size > uploadLimits.bytes) throw new Error(t('The resized image exceeds 30 MB. Choose a smaller size.'));
  return blob;
}
