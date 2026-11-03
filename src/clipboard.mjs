import { validateGraph, duplicateNodes } from '../graph.mjs';
import { detachMissingStampTargets } from './annotations.mjs';

export const nodeClipboardType = 'application/x-concept-graph-nodes';

// Clipboard APIs accept PNG on all supported desktop browsers; use the full asset.
export async function imageClipboardPng(response) {
  if (!response.ok) throw new Error('Could not load the original image.');
  const blob = await response.blob();
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('Could not decode the image.')); image.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) throw new Error('Could not decode the image.');
    context.drawImage(image, 0, 0);
    return await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not prepare the image.')), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

export function copyImageToClipboard(response) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image copying is not available in this app.');
  // Safari requires write() itself, not the fetch, to run in the user gesture.
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': Promise.resolve(response).then(imageClipboardPng) })]);
}

export function selectedGraph(nodes, edges) {
  const selected = nodes.filter(node => node.selected), ids = new Set(selected.map(node => node.id));
  return structuredClone({ format: nodeClipboardType, version: 1,
    nodes: detachMissingStampTargets(selected.map(({ id, type, position, data, z }) => ({ id, type, position, data, ...(z === undefined ? {} : { z }) }))),
    edges: edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(({ id, source, target }) => ({ id, source, target })),
  });
}

export function readNodeClipboard(text) {
  if (!text || text.length > 4 * 1024 * 1024) return null;
  try {
    const value = JSON.parse(text);
    if (value?.format !== nodeClipboardType || value.version !== 1 || !value.nodes?.length) return null;
    return validateGraph(value);
  } catch { return null; }
}

export function cloneSelection(selection, position, graph = selection) {
  if (!selection.nodes.length) return { nodes: [], edges: [] };
  const left = Math.min(...selection.nodes.map(node => node.position.x)), top = Math.min(...selection.nodes.map(node => node.position.y));
  const offset = { x: (position?.x ?? left + 40) - left, y: (position?.y ?? top + 40) - top };
  const copied = duplicateNodes(graph, selection.nodes.map(node => node.id), { offset });
  return { ...copied, nodes: copied.nodes.map(node => ({ ...node, selected: true })) };
}
