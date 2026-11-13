import { cropRect, croppedImageData, fullRect, hasSelection, maskFromSelection, maskPlacement, resetImageData, selectionFromMask } from './image-edits.mjs';
import { t } from './i18n.mjs';

export function imageCanvas(width, height) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  if (!canvas.getContext('2d')) throw new Error(t('This browser could not create the image editor.'));
  return canvas;
}
export function loadEditImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer';
    image.onload = () => image.naturalWidth && image.naturalHeight ? resolve(image) : reject(new Error(t('Could not load the image for editing.')));
    image.onerror = () => reject(new Error(t('Could not load the image for editing.'))); image.src = url;
  });
}
export const canvasPixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
export function canvasBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob) reject(new Error(t('Could not export the edited image. Try a smaller image.')));
    else if (blob.size > 30 * 1024 * 1024) reject(new Error(t('The edited image exceeds 30 MB. Choose a smaller crop.')));
    else resolve(blob);
  }, type, .95));
}
export async function loadSelection(mask, pixels, assetUrl) {
  const image = await loadEditImage(assetUrl(mask.asset));
  if (image.naturalWidth !== pixels.width || image.naturalHeight !== pixels.height) throw new Error(t('The mask and its image must be PNGs with the same dimensions. Paint the mask again.'));
  const canvas = imageCanvas(pixels.width, pixels.height), ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
  const rgba = canvasPixels(canvas); selectionFromMask(rgba.data, rgba.data); ctx.putImageData(rgba, 0, 0);
  return canvas;
}

// All files are encoded and checked before uploading; the node changes only once every upload succeeds.
export async function saveMask(image, selection, source, upload) {
  const rgba = canvasPixels(selection);
  if (!hasSelection(rgba.data)) return undefined;
  const mask = imageCanvas(selection.width, selection.height), marked = imageCanvas(selection.width, selection.height);
  maskFromSelection(rgba.data, rgba.data); mask.getContext('2d').putImageData(rgba, 0, 0);
  const maskBlob = await canvasBlob(mask);
  // Preview and submitted highlight use the exact same binary selection as the alpha mask.
  selectionFromMask(rgba.data, rgba.data); mask.getContext('2d').putImageData(rgba, 0, 0);
  const ctx = marked.getContext('2d'); ctx.drawImage(image, 0, 0);
  const base = source.endsWith('.png') ? null : await canvasBlob(marked);
  ctx.globalAlpha = .55; ctx.drawImage(mask, 0, 0); ctx.globalAlpha = 1;
  const blobs = [maskBlob, await canvasBlob(marked), ...(base ? [base] : [])];
  const assets = [];
  for (const blob of blobs) assets.push(await upload(blob));
  return { asset: assets[0], marked: assets[1], base: base ? assets[2] : source, source };
}

export async function saveCrop(data, original, requested, { assetUrl, upload, reset = false }) {
  const pixels = { width: original.naturalWidth, height: original.naturalHeight }, rect = cropRect(requested, pixels);
  const canvas = imageCanvas(rect.width, rect.height); canvas.getContext('2d').drawImage(original, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  let selection;
  if (data.mask) {
    if (data.mask.source !== data.asset) throw new Error(t('The mask on “{name}” no longer matches the image. Paint it again.', { name: data.caption || data.label || t('Image') }));
    const previous = data.uncropped?.rect || fullRect(pixels), current = await loadSelection(data.mask, { width: previous.width, height: previous.height }, assetUrl);
    const at = maskPlacement(previous, rect); selection = imageCanvas(rect.width, rect.height);
    selection.getContext('2d').drawImage(current, at.x, at.y, at.width, at.height);
  }
  const originalAsset = data.uncropped?.asset || data.asset;
  // WebP stays WebP to retain transparency; GIF becomes a still PNG.
  const type = originalAsset.endsWith('.jpg') ? 'image/jpeg' : originalAsset.endsWith('.webp') ? 'image/webp' : 'image/png';
  const blob = reset ? null : await canvasBlob(canvas, type), asset = reset ? originalAsset : await upload(blob);
  let mask;
  if (selection) {
    // JPEG/WebP encoding changes pixels: build the PNG references from the stored crop's decoded pixels.
    const url = blob && !asset.endsWith('.png') ? URL.createObjectURL(blob) : null;
    try { mask = await saveMask(url ? await loadEditImage(url) : canvas, selection, asset, upload); }
    finally { if (url) URL.revokeObjectURL(url); }
  }
  const result = reset ? resetImageData(data) : croppedImageData(data, asset, pixels, rect);
  delete result.mask; if (mask) result.mask = mask;
  return result;
}
