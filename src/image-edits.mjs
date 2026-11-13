const asset = value => typeof value === 'string' && /^[\da-f-]{36}\.(png|jpg|webp|gif)$/.test(value);
const png = value => asset(value) && value.endsWith('.png');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const validPixels = value => object(value) && ['width', 'height'].every(key => Number.isInteger(value[key]) && value[key] > 0 && value[key] <= 100000);
export const fullRect = pixels => ({ x: 0, y: 0, width: pixels.width, height: pixels.height });
export const validCropRect = (rect, pixels) => object(rect) && validPixels(pixels) && ['x', 'y', 'width', 'height'].every(key => Number.isInteger(rect[key]))
  && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 && rect.x + rect.width <= pixels.width && rect.y + rect.height <= pixels.height;

export function validateImageEdits(data) {
  if (data.uncropped !== undefined && (!object(data.uncropped) || !asset(data.uncropped.asset) || !validCropRect(data.uncropped.rect, data.uncropped.pixels))) throw new Error('Invalid original image crop.');
  if (data.mask !== undefined && (!object(data.mask) || !['asset', 'marked', 'base'].every(key => png(data.mask[key])) || !asset(data.mask.source))) throw new Error('Invalid image mask.');
}

export const imageAssets = node => node?.type === 'image' ? [node.data.asset, node.data.uncropped?.asset, ...['asset', 'marked', 'base', 'source'].map(key => node.data.mask?.[key])].filter(Boolean) : node?.data?.template?.assets || [];
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export function cropRect(rect, pixels) {
  const x = clamp(Math.round(rect.x), 0, pixels.width - 1), y = clamp(Math.round(rect.y), 0, pixels.height - 1);
  return { x, y, width: clamp(Math.round(rect.width), 1, pixels.width - x), height: clamp(Math.round(rect.height), 1, pixels.height - y) };
}

// A resize anchors the opposite edge/corner; Shift preserves the rectangle's starting ratio.
export function dragCrop(rect, handle, dx, dy, pixels, ratioLocked = false) {
  if (handle === 'move') return { ...rect, x: clamp(Math.round(rect.x + dx), 0, pixels.width - rect.width), y: clamp(Math.round(rect.y + dy), 0, pixels.height - rect.height) };
  const west = handle.includes('w'), north = handle.includes('n'), horizontal = west || handle.includes('e'), vertical = north || handle.includes('s');
  const anchorX = west ? rect.x + rect.width : rect.x, anchorY = north ? rect.y + rect.height : rect.y;
  let width = horizontal ? clamp(rect.width + (west ? -dx : dx), 1, west ? anchorX : pixels.width - anchorX) : rect.width;
  let height = vertical ? clamp(rect.height + (north ? -dy : dy), 1, north ? anchorY : pixels.height - anchorY) : rect.height;
  if (ratioLocked) {
    const ratio = rect.width / rect.height;
    if (horizontal && (!vertical || Math.abs(width - rect.width) / rect.width >= Math.abs(height - rect.height) / rect.height)) height = width / ratio;
    else width = height * ratio;
    const maxWidth = horizontal ? west ? anchorX : pixels.width - anchorX : 2 * Math.min(rect.x + rect.width / 2, pixels.width - rect.x - rect.width / 2);
    const maxHeight = vertical ? north ? anchorY : pixels.height - anchorY : 2 * Math.min(rect.y + rect.height / 2, pixels.height - rect.y - rect.height / 2);
    const scale = Math.min(1, maxWidth / width, maxHeight / height); width *= scale; height *= scale;
  }
  return cropRect({ x: horizontal ? west ? anchorX - width : anchorX : rect.x + (rect.width - width) / 2,
    y: vertical ? north ? anchorY - height : anchorY : rect.y + (rect.height - height) / 2, width, height }, pixels);
}

export const maskPlacement = (previous, next) => ({ x: previous.x - next.x, y: previous.y - next.y, width: previous.width, height: previous.height });
export const imageAspect = pixels => clamp(pixels.height / pixels.width, .1, 10);
export function croppedImageData(data, asset, pixels, rect, mask) {
  return { ...data, asset, pixels: { width: rect.width, height: rect.height }, aspect: imageAspect(rect),
    uncropped: { asset: data.uncropped?.asset || data.asset, pixels: data.uncropped?.pixels || pixels, rect }, ...(mask ? { mask } : {}) };
}
export function resetImageData(data) {
  if (!data.uncropped) return data;
  const { uncropped, ...rest } = data;
  return { ...rest, asset: uncropped.asset, pixels: uncropped.pixels, aspect: imageAspect(uncropped.pixels) };
}

export function selectionFromMask(rgba, result = new Uint8ClampedArray(rgba.length)) {
  for (let i = 0; i < rgba.length; i += 4) { result[i] = 230; result[i + 1] = 40; result[i + 2] = 180; result[i + 3] = 255 - rgba[i + 3]; }
  return result;
}
export function maskFromSelection(rgba, result = new Uint8ClampedArray(rgba.length)) {
  for (let i = 0; i < rgba.length; i += 4) { result[i] = result[i + 1] = result[i + 2] = 255; result[i + 3] = rgba[i + 3] >= 128 ? 0 : 255; }
  return result;
}
export const hasSelection = rgba => { for (let i = 3; i < rgba.length; i += 4) if (rgba[i] >= 128) return true; return false; };
export const hasGenerationPrompt = (graph, id) => {
  const targets = new Set(graph.edges.filter(edge => edge.source === id).map(edge => edge.target));
  return graph.nodes.some(node => targets.has(node.id) && node.type === 'text' && !node.data.task);
};

export function generationReferences(images, maskInput = false) {
  if (maskInput) {
    const target = images.find(image => image.mask);
    return target ? [{ ...target, asset: target.mask.base }, ...images.filter(image => image !== target)] : images;
  }
  return images.flatMap(image => image.mask ? [image, { asset: image.mask.marked, label: `${image.label} (highlighted edit area)`, nodeId: image.nodeId }] : [image]);
}
export function maskInstruction(images, maskInput = false) {
  const image = images.find(image => image.mask);
  if (!image) return '';
  return maskInput ? `Edit only the masked area of “${image.label}” (Attachment 1). Keep everything else identical.`
    : `Edit only the highlighted area of “${image.label}”. The attachment immediately after it is a marked copy showing the edit area in magenta. Keep everything else identical. The output must not contain the highlight.`;
}
