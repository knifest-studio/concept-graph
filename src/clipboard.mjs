import { validateGraph } from '../graph.mjs';

export const nodeClipboardType = 'application/x-concept-graph-nodes';

export function selectedGraph(nodes, edges) {
  const selected = nodes.filter(node => node.selected), ids = new Set(selected.map(node => node.id));
  return structuredClone({ format: nodeClipboardType, version: 1,
    nodes: selected.map(({ id, type, position, data }) => ({ id, type, position, data })),
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

export function cloneSelection(selection, position) {
  if (!selection.nodes.length) return { nodes: [], edges: [] };
  const left = Math.min(...selection.nodes.map(node => node.position.x)), top = Math.min(...selection.nodes.map(node => node.position.y));
  const offset = { x: (position?.x ?? left + 40) - left, y: (position?.y ?? top + 40) - top };
  const ids = new Map(selection.nodes.map(node => [node.id, crypto.randomUUID()]));
  return {
    nodes: selection.nodes.map(node => ({ id: ids.get(node.id), type: node.type, data: structuredClone(node.data), selected: true,
      position: { x: node.position.x + offset.x, y: node.position.y + offset.y } })),
    edges: selection.edges.map(edge => ({ id: crypto.randomUUID(), source: ids.get(edge.source), target: ids.get(edge.target) })),
  };
}
