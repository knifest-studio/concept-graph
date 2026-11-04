import { canAttachStamp, isAnnotation } from './annotations.mjs';

// Layer order is an optional per-node number; group frames always stay behind their members.
export const maxLayer = 1e9;
export const layerActions = Object.freeze(['front', 'forward', 'backward', 'back']);
export const validLayer = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maxLayer;
const layer = node => validLayer(node.z) ? node.z : 0;

// Equal layers keep annotations above prompts and images, then document order (ID order on cloud boards), so every replica agrees.
export function stackOrder(nodes) {
  return nodes.map((node, index) => [node, index]).filter(([node]) => node.type !== 'group')
    .sort(([a, i], [b, j]) => layer(a) - layer(b) || isAnnotation(a) - isAnnotation(b) || i - j).map(([node]) => node);
}

// A stamp is never hidden by what it marks: one stored below its parent is drawn directly above it.
export function layerOrder(nodes) {
  const stacked = stackOrder(nodes), byId = new Map(stacked.map(node => [node.id, node])), placed = new Set(), waiting = new Map(), order = [];
  for (const node of stacked) {
    const parent = node.type === 'stamp' && byId.get(node.data?.attachedTo);
    if (canAttachStamp(parent) && !placed.has(parent.id)) { waiting.set(parent.id, [...(waiting.get(parent.id) || []), node]); continue; }
    order.push(node, ...(waiting.get(node.id) || [])); placed.add(node.id);
  }
  return order;
}

export const layerIndex = nodes => new Map(layerOrder(nodes).map((node, index) => [node.id, index + 1]));

// True when only fields that never change identity, type or stacking differ (positions, text, selection, size…).
export function sameShape(before, after) {
  if (before === after) return true;
  if (!before || before.length !== after.length) return false;
  for (let index = 0; index < after.length; index++) {
    const a = before[index], b = after[index];
    if (a !== b && (a.id !== b.id || a.type !== b.type || a.z !== b.z || a.data?.attachedTo !== b.data?.attachedTo)) return false;
  }
  return true;
}
export const topLayer = nodes => nodes.reduce((top, node) => node.type === 'group' ? top : Math.max(top, layer(node)), 0);
export const nextLayer = nodes => Math.min(maxLayer, topLayer(nodes) + 1);

// New nodes appear above the whole board and keep their order among themselves.
export function stackOnTop(existing, added) {
  const top = topLayer(existing), rank = layerIndex(added);
  return added.map(node => node.type === 'group' ? node : { ...node, z: Math.min(maxLayer, top + rank.get(node.id)) });
}

// Figma's shortcuts: ] and [ jump to the front or back, ⌘/Ctrl moves one step. Physical bracket keys also work on layouts such as Ukrainian.
export function layerShortcut(event) {
  const typed = event.key === '[' || event.key === ']', key = typed ? event.key : !event.altKey && !event.shiftKey && { BracketLeft: '[', BracketRight: ']' }[event.code];
  if (!key) return null;
  const step = event.metaKey || (event.ctrlKey && !event.altKey);
  return key === ']' ? step ? 'forward' : 'front' : step ? 'backward' : 'back';
}

// Reorders one page and returns only the changed layers. Stamps drawn directly above their parent move with it unless selected on their own.
export function arrangeLayers(nodes, ids, action) {
  if (!layerActions.includes(action)) throw new Error('Unknown layer action.');
  const order = layerOrder(nodes), selected = new Set(ids), units = [];
  for (const node of order) {
    const head = units.at(-1)?.[0];
    if (head && node.type === 'stamp' && node.data?.attachedTo === head.id && (selected.has(head.id) || !selected.has(node.id))) units.at(-1).push(node);
    else units.push([node]);
  }
  const list = units.map(unit => ({ unit, selected: selected.has(unit[0].id) }));
  if (!list.some(item => item.selected)) return new Map();
  let moved = list;
  if (action === 'front') moved = [...list.filter(item => !item.selected), ...list.filter(item => item.selected)];
  else if (action === 'back') moved = [...list.filter(item => item.selected), ...list.filter(item => !item.selected)];
  else if (action === 'forward') for (let i = list.length - 2; i >= 0; i--) { if (list[i].selected && !list[i + 1].selected) [list[i], list[i + 1]] = [list[i + 1], list[i]]; }
  else for (let i = 1; i < list.length; i++) { if (list[i].selected && !list[i - 1].selected) [list[i - 1], list[i]] = [list[i], list[i - 1]]; }
  const next = layerOrder(moved.flatMap(item => item.unit).map((node, index) => ({ ...node, z: index + 1 }))), current = new Map(nodes.map(node => [node.id, node.z])), changes = new Map();
  if (next.every((node, index) => node.id === order[index].id)) return changes;
  next.forEach((node, index) => { if (current.get(node.id) !== index + 1) changes.set(node.id, index + 1); });
  return changes;
}
