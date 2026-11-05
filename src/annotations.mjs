export const stickyPalette = Object.freeze(['#fff3ad', '#ffd9e5', '#dceaff', '#d9f2d0', '#eadcff']);
export const penPalette = Object.freeze(['#25243d', '#8b5cf6', '#2563eb', '#e63946', '#238636', '#d4a017']);
export const penWidths = Object.freeze([2, 4, 8]);
export const stamps = Object.freeze({ like: '👍', heart: '❤️', star: '⭐', check: '✅', question: '❓', fire: '🔥' });
// FigJam-style shapes hold text; arrows join things and follow them when they move.
export const shapeKinds = Object.freeze(['rectangle', 'ellipse', 'diamond', 'triangle']);
export const shapePalette = Object.freeze(['#ffffff', '#fff3ad', '#ffd9e5', '#dceaff', '#d9f2d0', '#eadcff', '#25243d']);
export const arrowPalette = Object.freeze(['#6b6e89', '#25243d', '#8b5cf6', '#2563eb', '#e63946', '#238636']);
export const shapeDefault = Object.freeze({ width: 180, height: 180 });
export const arrowPad = 16;
export const isAnnotation = node => ['drawing', 'sticky', 'stamp', 'shape', 'arrow'].includes(node?.type);
export const canAttachStamp = node => ['text', 'image', 'sticky', 'shape'].includes(node?.type);
export const canAttachArrow = node => ['text', 'image', 'sticky', 'shape'].includes(node?.type);
export const validColor = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);

// Board identities contain display information only, never account identifiers.
export function boardAuthor(value) {
  const name = typeof value?.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 80 || /[@\u0000-\u001f\u007f]/.test(name)) return undefined;
  return { name, ...(validColor(value.color) ? { color: value.color } : {}) };
}

export function validateAuthor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !boardAuthor(value) || value.name !== value.name.trim()
    || Object.keys(value).some(key => !['name', 'color'].includes(key)) || (value.color !== undefined && !validColor(value.color))) throw new Error('Invalid author.');
}

export const imageAuthor = (data, runs = []) => boardAuthor(data.author) || (data.runId ? boardAuthor(runs.find(run => run.id === data.runId)?.by) : undefined);
export const authorInitials = author => author.name.split(/\s+/u).slice(0, 2).map(part => [...part][0]).join('').toUpperCase();
export function contrastColor(color) {
  const rgb = color.slice(1).match(/../g).map(hex => { const n = parseInt(hex, 16) / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
  return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2] > .179 ? '#25243d' : '#ffffff';
}

export function validateAnnotation(node) {
  const data = node.data;
  const keys = { drawing: ['points', 'color', 'width', 'createdAt'], sticky: ['text', 'color', 'author', 'createdAt'], stamp: ['kind', 'author', 'createdAt', 'attachedTo'],
    shape: ['shape', 'width', 'height', 'color', 'text', 'author', 'createdAt'], arrow: 'from to color dashed startArrow endArrow author createdAt'.split(' ') }[node.type];
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !keys.includes(key))) throw new Error('Invalid annotation data.');
  if (node.type === 'drawing' && (!validColor(data.color) || !Number.isFinite(data.width) || data.width < 1 || data.width > 24
    || !Array.isArray(data.points) || !data.points.length || data.points.length > 1000
    || !data.points.every(point => Array.isArray(point) && point.length === 2 && point.every(n => Number.isFinite(n) && n >= 0 && n <= 100000)))) throw new Error('Invalid drawing.');
  if (node.type === 'sticky' && (typeof data.text !== 'string' || data.text.length > 10000 || !validColor(data.color))) throw new Error('Invalid sticky.');
  if (node.type === 'stamp' && (typeof data.kind !== 'string' || !Object.hasOwn(stamps, data.kind))) throw new Error('Invalid stamp.');
  if (node.type === 'stamp' && data.attachedTo !== undefined && (typeof data.attachedTo !== 'string' || !data.attachedTo || data.attachedTo.length > 120)) throw new Error('Invalid stamp attachment.');
  if (node.type === 'shape' && (!shapeKinds.includes(data.shape) || !validColor(data.color) || ![data.width, data.height].every(n => Number.isFinite(n) && n >= 20 && n <= 4000)
    || (data.text !== undefined && (typeof data.text !== 'string' || data.text.length > 10000)))) throw new Error('Invalid shape.');
  if (node.type === 'arrow' && (!validEnd(data.from) || !validEnd(data.to) || !validColor(data.color)
    || ['dashed', 'startArrow', 'endArrow'].some(key => data[key] !== undefined && typeof data[key] !== 'boolean'))) throw new Error('Invalid arrow.');
}

// An arrow end is a point on the board, or a node it holds on to plus the point where that node last was.
const validEnd = end => !!end && typeof end === 'object' && !Array.isArray(end) && Object.keys(end).every(key => ['x', 'y', 'node'].includes(key))
  && [end.x, end.y].every(n => Number.isFinite(n) && Math.abs(n) <= 1e7) && (end.node === undefined || (typeof end.node === 'string' && !!end.node && end.node.length <= 120));
// An arrow's stored box: its ends' known points plus room for heads and handles.
export const arrowPosition = (from, to) => ({ x: Math.min(from.x, to.x) - arrowPad, y: Math.min(from.y, to.y) - arrowPad });
export const shiftArrow = (data, dx, dy) => ({ ...data, from: { ...data.from, x: data.from.x + dx, y: data.from.y + dy }, to: { ...data.to, x: data.to.x + dx, y: data.to.y + dy } });

// A dragged arrow (or one carried by a section) moves its points with it; an arrow whose points changed is left alone.
export function reconcileArrows(before = [], nodes = []) {
  if (!nodes.some(node => node.type === 'arrow')) return nodes;
  const previous = new Map(before.map(node => [node.id, node]));
  return nodes.map(node => {
    const old = node.type === 'arrow' && previous.get(node.id);
    if (!old || old.type !== 'arrow' || node.data.from !== old.data.from || node.data.to !== old.data.to) return node;
    const dx = node.position.x - old.position.x, dy = node.position.y - old.position.y;
    return dx || dy ? { ...node, data: shiftArrow(node.data, dx, dy) } : node;
  });
}

export function detachMissingStampTargets(nodes) {
  const targets = new Set(nodes.filter(canAttachStamp).map(node => node.id));
  return nodes.map(node => {
    if (node.type !== 'stamp' || node.data.attachedTo === undefined || targets.has(node.data.attachedTo)) return node;
    const data = { ...node.data }; delete data.attachedTo;
    return { ...node, data };
  });
}

// A stamp already moved in the same edit must not receive its parent's delta twice.
export function reconcileStampAttachments(before = [], nodes = []) {
  // Boards without attached stamps, the usual case, need no lookups.
  if (!nodes.some(node => node.type === 'stamp' && node.data.attachedTo !== undefined)) return nodes;
  const previous = new Map(before.map(node => [node.id, node])), current = new Map(nodes.map(node => [node.id, node]));
  return nodes.flatMap(node => {
    if (node.type !== 'stamp' || node.data.attachedTo === undefined) return [node];
    const oldStamp = previous.get(node.id), oldParent = previous.get(node.data.attachedTo), parent = current.get(node.data.attachedTo);
    if (!parent && oldParent && oldStamp?.data.attachedTo === node.data.attachedTo) return [];
    if (!canAttachStamp(parent) || !oldParent || oldStamp?.data.attachedTo !== node.data.attachedTo
      || node.position.x !== oldStamp.position.x || node.position.y !== oldStamp.position.y) return [node];
    const dx = parent.position.x - oldParent.position.x, dy = parent.position.y - oldParent.position.y;
    return [dx || dy ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node];
  });
}

export function annotationSize(node) {
  if (node.type === 'sticky') return { width: 200, height: 200 };
  if (node.type === 'shape') return { width: node.data.width, height: node.data.height };
  if (node.type === 'arrow') return { width: Math.abs(node.data.to.x - node.data.from.x) + 2 * arrowPad, height: Math.abs(node.data.to.y - node.data.from.y) + 2 * arrowPad };
  if (node.type === 'stamp') return { width: 48, height: 48 };
  const padding = node.data.width / 2 + 2;
  return { width: Math.max(1, ...node.data.points.map(point => point[0])) + padding, height: Math.max(1, ...node.data.points.map(point => point[1])) + padding };
}

// Iterative Ramer–Douglas–Peucker avoids recursion on long pointer gestures.
export function simplifyStroke(points, tolerance = .75, limit = 1000) {
  if (points.length < 3) return points.map(point => [...point]);
  const keep = new Set([0, points.length - 1]), stack = [[0, points.length - 1]], threshold = tolerance ** 2;
  while (stack.length) {
    const [first, last] = stack.pop(), a = points[first], b = points[last], dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy;
    let maximum = threshold, index;
    for (let i = first + 1; i < last; i++) {
      const point = points[i], t = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length)) : 0;
      const distance = (point[0] - a[0] - t * dx) ** 2 + (point[1] - a[1] - t * dy) ** 2;
      if (distance > maximum) { maximum = distance; index = i; }
    }
    if (index !== undefined) { keep.add(index); stack.push([first, index], [index, last]); }
  }
  const result = [...keep].sort((a, b) => a - b).map(i => [...points[i]]);
  return result.length <= limit ? result : Array.from({ length: limit }, (_, i) => result[Math.round(i * (result.length - 1) / (limit - 1))]);
}

export function strokePath(points) {
  if (!points.length) return '';
  const [first] = points;
  if (points.length === 1) return `M${first[0]},${first[1]}l.01,0`;
  let path = `M${first[0]},${first[1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    path += `Q${a[0]},${a[1]} ${(a[0] + b[0]) / 2},${(a[1] + b[1]) / 2}`;
  }
  return `${path}L${points.at(-1)[0]},${points.at(-1)[1]}`;
}

export function drawingFromStroke(points, color, width) {
  const simplified = simplifyStroke(points), padding = width / 2 + 2;
  const x = Math.min(...simplified.map(point => point[0])) - padding, y = Math.min(...simplified.map(point => point[1])) - padding;
  const node = { type: 'drawing', position: { x, y }, data: { points: simplified.map(point => [point[0] - x, point[1] - y]), color, width } };
  validateAnnotation(node);
  return node;
}
