import { nodeSize, captionHeight } from '../graph.mjs';
import { isAnnotation, canAttachStamp, canAttachArrow, arrowPad, arrowPosition, reconcileStampAttachments } from './annotations.mjs';
import { layerIndex, sameShape } from './layers.mjs';
import { sectionMinimum, sectionPadding } from './sections.mjs';

export const connectionColor = type => type === 'image' ? 'var(--purple)' : 'var(--blue)';

// Accept server-generated captions only while the local caption is unchanged.
export function mergeRemoteImageCaptions(local, remote, base) {
  const before = new Map(base.map(node => [node.id, node]));
  const incoming = new Map(remote.map(node => [node.id, node]));
  return local.map(node => {
    const previous = before.get(node.id), next = incoming.get(node.id);
    if (node.type !== 'image' || previous?.type !== 'image' || next?.type !== 'image'
      || node.data.caption !== previous.data.caption || next.data.caption === previous.data.caption) return node;
    const data = { ...node.data };
    if (next.data.caption === undefined) delete data.caption; else data.caption = next.data.caption;
    return { ...node, data };
  });
}

// Keep a later server caption through undo only while the user has not changed it.
export function preserveRemoteImageCaptions(snapshotNodes, currentNodes, changes, snapshotVersion = 0) {
  const current = new Map(currentNodes.map(node => [node.id, node]));
  return snapshotNodes.map(node => {
    const change = changes.get(node.id), now = current.get(node.id);
    if (node.type !== 'image' || now?.type !== 'image' || !change || change.version <= snapshotVersion
      || node.data.caption !== change.before || now.data.caption !== change.after) return node;
    return { ...node, data: { ...node.data, caption: change.after } };
  });
}

// Generation can finish in the same millisecond as an undo checkpoint.
export function freshOutputNodes(nodes, snapshot, runs) {
  const ids = new Set(snapshot.nodes.map(node => node.id));
  const outputs = runs && new Set(runs.flatMap(run => run.outputIds || []));
  return nodes.filter(node => node.type === 'image' && node.data.runId && node.data.createdAt >= snapshot.capturedAt && !ids.has(node.id) && (!outputs || outputs.has(node.id)));
}

// Accept new server groups without undoing local deletion or regrouping.
export function mergeAddedGroups(local, remote, base, nodes) {
  const known = new Map(base.map(group => [group.id, group]));
  const existing = new Set(local.map(group => group.id));
  const ids = new Set(nodes.map(node => node.id));
  const occupied = new Set(local.flatMap(group => group.nodeIds));
  const result = [...local];
  for (const group of remote) {
    if (known.has(group.id)) {
      const index = result.findIndex(item => item.id === group.id);
      // A local ungroup is intentional; accept only newly arrived members.
      if (index < 0) continue;
      for (const key of ['name', 'color', 'collapsed', 'slideshow', 'slide']) {
        if (result[index][key] !== known.get(group.id)[key] || group[key] === known.get(group.id)[key]) continue;
        const updated = { ...result[index] };
        if (group[key] === undefined) delete updated[key]; else updated[key] = group[key];
        result[index] = updated;
      }
      const previous = new Set(known.get(group.id).nodeIds);
      const added = group.nodeIds.filter(id => !previous.has(id) && ids.has(id) && !occupied.has(id));
      if (added.length) {
        result[index] = { ...result[index], nodeIds: [...result[index].nodeIds, ...added] };
        added.forEach(id => occupied.add(id));
      }
      continue;
    }
    if (existing.has(group.id)) continue;
    const nodeIds = group.nodeIds.filter(id => ids.has(id) && !occupied.has(id));
    if (nodeIds.length < 2) continue;
    nodeIds.forEach(id => occupied.add(id));
    result.push({ ...group, nodeIds });
  }
  return result;
}

export function preserveFreshOutputGroups(snapshotGroups, currentGroups, nodes, freshOutputs, addedGroupIds = new Set()) {
  const result = pruneGroups(snapshotGroups, nodes);
  const freshIds = new Set(freshOutputs.map(node => node.id));
  const ids = new Set(nodes.map(node => node.id));
  const occupied = new Set(result.flatMap(group => group.nodeIds));
  for (const group of currentGroups) {
    if (!addedGroupIds.has(group.id) && !group.nodeIds.some(id => freshIds.has(id))) continue;
    const previous = result.find(item => item.id === group.id);
    const nodeIds = group.nodeIds.filter(id => ids.has(id) && !occupied.has(id) && (!previous || freshIds.has(id)));
    if (previous) previous.nodeIds.push(...nodeIds);
    else if (nodeIds.length >= 2) result.push({ ...group, nodeIds });
    else continue;
    nodeIds.forEach(id => occupied.add(id));
  }
  return result;
}

export function edgeDropCreatesPrompt(state, onPane) {
  return onPane && !state.isValid && !state.toNode && state.fromHandle?.type === 'source' && ['text', 'image'].includes(state.fromNode?.type);
}

// A slide whose image left the group is dropped; the slideshow then shows its first image.
export const cleanGroups = groups => groups.map(({ id, name, nodeIds, collapsed, color, slideshow, slide }) => ({ id, name, nodeIds, collapsed, ...(color === undefined ? {} : { color }),
  ...(slideshow === undefined ? {} : { slideshow }), ...(slide !== undefined && nodeIds.includes(slide) ? { slide } : {}) }));
export function pruneGroups(groups, nodes) {
  const ids = new Set(nodes.map(node => node.id));
  return groups.map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => ids.has(id)) })).filter(group => group.nodeIds.length);
}

const size = nodeSize;
// `byId` (id → node) makes this proportional to the group instead of the board.
export function groupBounds(group, nodes, byId, measure = size) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const add = node => {
    const { width, height } = measure(node);
    left = Math.min(left, node.position.x); top = Math.min(top, node.position.y - captionHeight(node));
    right = Math.max(right, node.position.x + width); bottom = Math.max(bottom, node.position.y + height);
  };
  if (byId) { for (const id of group.nodeIds) { const node = byId.get(id); if (node) add(node); } }
  else { const ids = new Set(group.nodeIds); for (const node of nodes) if (ids.has(node.id)) add(node); }
  const x = left - 24, y = top - 48;
  return { x, y, width: right - x + 24, height: bottom - y + 24 };
}

// Where a line toward `toward` leaves a node's outline (a shape's own outline; a box for anything else), 6px out.
function outlinePoint(box, toward) {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2, dx = toward.x - cx, dy = toward.y - cy, hw = box.width / 2, hh = box.height / 2;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { x: cx, y: cy };
  const rx = Math.abs(dx) / hw, ry = Math.abs(dy) / hh;
  const scale = box.kind === 'ellipse' ? 1 / Math.hypot(rx, ry) : box.kind === 'diamond' ? 1 / (rx + ry) : 1 / Math.max(rx, ry);
  const t = Math.min(1, scale) + (scale < 1 ? 6 / length : 0);
  return { x: cx + dx * t, y: cy + dy * t };
}

// An arrow's two points as drawn: an attached end sits on its node's outline, facing the other end; a free end, or one
// whose node is gone, at its stored point.
export const arrowTargetAt = (nodes, point, except) => stampTargetAt(nodes, point, except, canAttachArrow);

export function arrowEnds(arrow, byId, measure = estimatedSize) {
  const box = end => {
    const node = end.node !== undefined && byId.get(end.node);
    if (!canAttachArrow(node)) return null;
    const { width, height } = measure(node), caption = captionHeight(node);
    return { x: node.position.x, y: node.position.y - caption, width, height: height + caption, kind: node.type === 'shape' ? node.data.shape : 'box', node };
  };
  const a = box(arrow.data.from), b = box(arrow.data.to), centre = (end, frame) => frame ? { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 } : { x: end.x, y: end.y };
  const ca = centre(arrow.data.from, a), cb = centre(arrow.data.to, b);
  return { from: a ? outlinePoint(a, cb) : ca, to: b ? outlinePoint(b, ca) : cb, attached: !!(a || b) };
}

// Arrows whose node was deleted keep that end where it was last drawn, as in FigJam.
export function detachArrows(before, after, measure = estimatedSize) {
  if (!after.some(node => node.type === 'arrow')) return after;
  const kept = new Set(after.map(node => node.id)), byId = new Map(before.map(node => [node.id, node])), lost = end => end.node !== undefined && !kept.has(end.node);
  return after.map(node => {
    if (node.type !== 'arrow' || !(lost(node.data.from) || lost(node.data.to))) return node;
    const ends = arrowEnds(node, byId, measure), free = (end, point) => lost(end) ? { x: point.x, y: point.y } : end;
    const data = { ...node.data, from: free(node.data.from, ends.from), to: free(node.data.to, ends.to) };
    return { ...node, position: arrowPosition(data.from, data.to), data };
  });
}

function arrowView(node, byId, measure, zIndex, cache) {
  const { from, to, attached } = arrowEnds(node, byId, measure), saved = cache.nodes.get(node);
  if (saved && saved.zIndex === zIndex && saved.from.x === from.x && saved.from.y === from.y && saved.to.x === to.x && saved.to.y === to.y) return saved.view;
  const x = Math.min(from.x, to.x) - arrowPad, y = Math.min(from.y, to.y) - arrowPad, width = Math.abs(to.x - from.x) + 2 * arrowPad, height = Math.abs(to.y - from.y) + 2 * arrowPad;
  // An arrow held by a node follows it, so only a free arrow can be dragged on its own.
  const view = { ...node, zIndex, position: { x, y }, width, height, measured: { width, height }, handles: [], draggable: !attached,
    data: { ...node.data, line: { x1: from.x - x, y1: from.y - y, x2: to.x - x, y2: to.y - y }, attached } };
  cache.nodes.set(node, { zIndex, from, to, view });
  return view;
}

// A slideshow steps through its images; `slide` names the one shown, else (or once that image is gone) the first.
export function slideshowState(group, byId) {
  const images = [];
  for (const id of group.nodeIds) { const node = byId.get(id); if (node?.type === 'image') images.push(node); }
  const index = Math.max(0, images.findIndex(node => node.id === group.slide));
  return { images, index, node: images[index] };
}
export const steppedSlide = (group, byId, step) => { const { images, index } = slideshowState(group, byId); return images.length ? images[(index + step + images.length) % images.length].id : undefined; };
// A folded group is a 240×72 card. A folded slideshow shows its image under the 40px header, 310px wide like an image card.
const foldedGroup = Object.freeze({ width: 240, height: 72 });
// `aspects` holds proportions learned from loaded pictures, for images stored without them.
const foldedSize = (slide, aspects) => slide ? { width: 310, height: 40 + Math.round(310 * (slide.data.aspect || aspects?.get(slide.data.asset) || 1)) } : foldedGroup;
export const foldedFrame = (group, byId) => foldedSize(group.slideshow && slideshowState(group, byId).node);

// An unmeasured prompt grows with its text (13px type, 22px lines, ~44 characters per line in a 310px card).
// A light card's connection dot. React Flow measures connection points by their `source`/`target` class and reads the
// side from data-handlepos; without it the links would leave from the bottom and enter from the top.
export const lodHandleProps = type => ({ className: `lod-handle ${type}`, 'data-handlepos': type === 'source' ? 'right' : 'left' });

// A prompt not drawn yet: header, text lines and, when something feeds it, the "Inputs" row, as the card will lay them out,
// up to a square (the card scrolls past that), or the height its bottom edge was dragged to.
export const promptSquare = 310;
// Whether a prompt's text runs past its card, judged as estimatedSize lays it out (light cards cannot measure).
export const promptOverflows = node => 58 + 22.1 * String(node.data?.text || '').split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 44)), 0) > (node.data?.height || promptSquare) + 4;
export function estimatedSize(node, inputs = false) {
  if (node.type !== 'text' || node.measured || node.data?.collapsed) return size(node);
  if (node.data?.height) return { width: 310, height: node.data.height };
  const lines = String(node.data?.text || '').split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 44)), 0);
  return { width: 310, height: Math.min(promptSquare, Math.round(58 + 22.1 * Math.min(lines, 400) + (inputs ? 21.4 : 0))) };
}

// React Flow draws a connection only between handles it knows. These match the CSS: 10px dots centred on the card's
// left and right borders (1px, 2px on custom nodes), so connections to nodes that were never rendered still draw.
export function nodeHandles(node, { width, height }) {
  if (isAnnotation(node)) return [];
  const border = node.type === 'text' && node.data?.template ? 2 : 1, y = height / 2 - 5, handles = [];
  if (node.type === 'text' || node.data?.runId) handles.push({ id: null, type: 'target', position: 'left', x: border - 10, y, width: 10, height: 10 });
  handles.push({ id: null, type: 'source', position: 'right', x: width - border, y, width: 10, height: 10 });
  return handles;
}
// Frames are not positioned, so their handles sit on the node box itself.
const frameHandles = ({ width, height }) => [{ id: null, type: 'target', position: 'left', x: -10, y: height / 2 - 5, width: 10, height: 10 }, { id: null, type: 'source', position: 'right', x: width, y: height / 2 - 5, width: 10, height: 10 }];
const groupHandles = Object.freeze(frameHandles(foldedGroup));
const edgeStyles = { text: Object.freeze({ stroke: connectionColor('text'), strokeWidth: 2 }), image: Object.freeze({ stroke: connectionColor('image'), strokeWidth: 2 }) };

// Per-editor memory for canvasView: unchanged inputs give back the same objects (and arrays), so React Flow skips them.
export const createViewCache = () => ({ nodes: new WeakMap(), frames: new WeakMap(), edges: new WeakMap(), sections: new WeakMap(), sizes: new Map(), layers: null, sectionLayers: null, view: null });
const folded = Object.freeze({ width: 72, height: 72 });
const sameItems = (a, b) => a?.length === b.length && a.every((item, index) => item === b[index]);
const noItems = Object.freeze([]);

// Larger sections lie behind the smaller ones drawn on them, and every section lies behind group frames (-1) and
// connections (0). Equal sizes break the tie by ID, the same way sections nest.
function sectionLayers(sections, cache) {
  if (cache.sectionLayers && sameItems(cache.sectionLayers.sections, sections)) return cache.sectionLayers.layers;
  const order = [...sections].sort((a, b) => b.width * b.height - a.width * a.height || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const layers = new Map(order.map((section, index) => [section.id, index - order.length - 1]));
  cache.sectionLayers = { sections, layers };
  return layers;
}

// The size a node is drawn at: its last measurement, or the same estimate canvasView uses for a card not drawn yet.
export const viewSize = cache => node => (node.data?.collapsed === true ? folded : node.measured || cache.sizes.get(node.id)) || cache.nodes.get(node)?.view.measured || estimatedSize(node);

// Groups are display containers; original node IDs and generation edges stay intact. Sections are background frames
// drawn behind everything.
export function canvasView(nodes, edges, groups, cache = createViewCache(), sections = noItems) {
  const collapsed = new Map();
  for (const group of groups) if (group.collapsed) for (const id of group.nodeIds) collapsed.set(id, group.id);
  if (collapsed.size) for (const node of nodes) if (node.type === 'stamp' && collapsed.has(node.data.attachedTo)) collapsed.set(node.id, collapsed.get(node.data.attachedTo));
  if (!cache.layers || !sameShape(cache.layers.nodes, nodes)) cache.layers = { nodes, index: layerIndex(nodes) };
  else cache.layers.nodes = nodes;
  const layers = cache.layers.index, byId = new Map();
  // A card keeps its last measured size when undo, a reload or a remote edit hands back an unmeasured copy; React Flow
  // re-measures it on screen. Folded cards are always 72px square.
  const known = node => node.data?.collapsed === true ? folded : node.measured || cache.sizes.get(node.id);
  const fed = new Set(edges.map(edge => edge.target)), inputs = node => fed.has(node.id) || !!node.data?.template?.assets?.length;
  const arrows = [];
  const viewNodes = nodes.map((node, index) => {
    byId.set(node.id, node);
    if (node.type === 'arrow') { arrows.push(index); return null; }
    const zIndex = layers.get(node.id), hidden = collapsed.has(node.id), size = known(node), saved = cache.nodes.get(node), input = !size && inputs(node);
    if (saved && saved.zIndex === zIndex && saved.hidden === hidden && saved.size === size && saved.input === input) return saved.view;
    if (node.measured && node.data?.collapsed !== true) cache.sizes.set(node.id, node.measured);
    const view = { ...node, zIndex, hidden, selected: hidden ? false : node.selected };
    if (!hidden) {
      const measured = size || estimatedSize(node, input);
      Object.assign(view, { measured, handles: nodeHandles(node, measured) });
    }
    cache.nodes.set(node, { zIndex, hidden, size, input, view });
    return view;
  });
  const shown = node => known(node) || cache.nodes.get(node)?.view.measured || estimatedSize(node, inputs(node));
  // Arrows follow the nodes they hold, so they are placed once every node is known.
  for (const index of arrows) viewNodes[index] = arrowView(nodes[index], byId, shown, layers.get(nodes[index].id), cache);
  const frames = groups.map(group => {
    const bounds = groupBounds(group, nodes, byId, shown), slides = group.slideshow ? slideshowState(group, byId) : null, slide = slides?.node;
    const { width, height } = group.collapsed ? foldedSize(slide, cache.aspects) : bounds, saved = cache.frames.get(group);
    if (saved && saved.x === bounds.x && saved.y === bounds.y && saved.width === width && saved.height === height && saved.slide === slide) return saved.view;
    const images = slides ? slides.images.length : group.nodeIds.reduce((count, id) => count + (byId.get(id)?.type === 'image'), 0);
    // A stored group colour is kept for older boards but no longer drawn: groups only bundle and fold nodes.
    const view = { id: group.id, type: 'group', position: { x: bounds.x, y: bounds.y }, selected: !!group.selected,
      data: { name: group.name, count: group.nodeIds.length, collapsed: group.collapsed, images,
        ...(slides ? { slideshow: true, index: slides.index, ...(slide ? { slide: { id: slide.id, asset: slide.data.asset, aspect: slide.data.aspect } } : {}) } : {}) },
      // Below the connections' layer (0), so a folded frame never hides the links between its members.
      width, height, measured: { width, height }, style: { width, height }, zIndex: -1, handles: group.collapsed ? (slide ? frameHandles({ width, height }) : groupHandles) : [] };
    cache.frames.set(group, { x: bounds.x, y: bounds.y, width, height, slide, view });
    return view;
  });
  const viewEdges = edges.map(edge => {
    const source = collapsed.get(edge.source) || edge.source, target = collapsed.get(edge.target) || edge.target;
    const kind = byId.get(edge.source)?.type === 'image' ? 'image' : 'text', saved = cache.edges.get(edge);
    if (saved && saved.source === source && saved.target === target && saved.kind === kind) return saved.view;
    const view = { ...edge, source, target, hidden: source === target, style: edgeStyles[kind] };
    cache.edges.set(edge, { source, target, kind, view });
    return view;
  });
  const sectionZ = sections.length ? sectionLayers(sections, cache) : null;
  const sectionViews = sections.map(section => {
    const zIndex = sectionZ.get(section.id), saved = cache.sections.get(section);
    if (saved && saved.zIndex === zIndex) return saved.view;
    const { width, height } = section;
    // Only the title and border pick a section up; its empty inside lets a drag select or pan, as in FigJam.
    const view = { id: section.id, type: 'section', position: { x: section.x, y: section.y }, selected: !!section.selected, dragHandle: '.section-handle',
      data: { name: section.name, color: section.color }, width, height, measured: { width, height }, zIndex, handles: [] };
    cache.sections.set(section, { zIndex, view });
    return view;
  });
  const all = sectionViews.length ? [...sectionViews, ...frames, ...viewNodes] : [...frames, ...viewNodes], last = cache.view;
  cache.view = { nodes: last && sameItems(last.nodes, all) ? last.nodes : all, edges: last && sameItems(last.edges, viewEdges) ? last.edges : viewEdges,
    sections: last && sameItems(last.sections, sectionViews) ? last.sections : sectionViews };
  return cache.view;
}

// Far out, titles of small neighbouring sections would pile up. Like labels on a map, the selected and larger sections
// keep theirs and a title that would overlap one already placed waits until the board is closer. Sizes are screen
// pixels and follow the CSS for .section-title: a pill inside the frame's top-left corner.
// As in FigJam, a title keeps its screen size but never leaves its section: it is cut short to the section's width and
// left out once the section is too small on screen to hold a few letters.
export function visibleTitles(frames, zoom) {
  const size = 15, height = Math.ceil(size * 1.3) + 6, cell = 160, grid = new Map(), shown = new Set();
  const order = [...frames].sort((a, b) => b.selected - a.selected || b.width * b.height - a.width * a.height || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const frame of order) {
    const room = frame.width * zoom - 16;
    if (room < 56 || frame.height * zoom < height + 16) continue;
    const width = Math.min(room, String(frame.data.name).length * size * .62 + 28);
    const left = frame.position.x * zoom + 6, top = frame.position.y * zoom + 6, box = { left, right: left + width, top, bottom: top + height };
    const cells = [];
    for (let x = Math.floor(box.left / cell); x <= Math.floor(box.right / cell); x++) for (let y = Math.floor(box.top / cell); y <= Math.floor(box.bottom / cell); y++) cells.push(`${x}:${y}`);
    if (cells.some(key => grid.get(key)?.some(other => other.left < box.right && box.left < other.right && other.top < box.bottom && box.top < other.bottom))) continue;
    cells.forEach(key => grid.set(key, [...(grid.get(key) || []), box]));
    shown.add(frame.id);
  }
  return shown;
}

// How far the canvas pans: the page's content plus `pad` on every side, so nobody scrolls off into empty space and
// loses the board. It grows as content is added; an empty page keeps a square around the origin.
export function boardExtent({ nodes, sections = [] }, measure = estimatedSize, pad = 2000) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const add = (x, y, width, height) => { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + width); bottom = Math.max(bottom, y + height); };
  for (const node of nodes) { const { width, height } = measure(node); add(node.position.x, node.position.y - captionHeight(node), width, height + captionHeight(node)); }
  for (const section of sections) add(section.x, section.y, section.width, section.height);
  if (left === Infinity) return [[-pad, -pad], [pad, pad]];
  return [[left - pad, top - pad], [right + pad, bottom + pad]];
}

export function moveGroup(nodes, group, position, moveStamps = true) {
  const bounds = groupBounds(group, nodes);
  const dx = position.x - bounds.x, dy = position.y - bounds.y;
  const members = new Set(group.nodeIds);
  const moved = nodes.map(node => members.has(node.id) ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node);
  return moveStamps ? reconcileStampAttachments(nodes, moved) : moved;
}

// A node's drawn box, caption included.
const nodeBox = (node, measure) => { const caption = captionHeight(node), { width, height } = measure(node); return { x: node.position.x, y: node.position.y - caption, width, height: height + caption }; };
const centre = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const holds = (rect, point) => point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
const area = rect => rect.width * rect.height;
// A section lies in another when its centre does and it is smaller; equal ones by ID, so two never hold each other.
const nests = (inner, outer) => inner.id !== outer.id && holds(outer, centre(inner)) && (area(inner) < area(outer) || (area(inner) === area(outer) && inner.id > outer.id));
export const frameBox = (group, nodes, byId, measure = size) => {
  const bounds = groupBounds(group, nodes, byId, measure);
  return group.collapsed ? { ...bounds, ...foldedFrame(group, byId || new Map(nodes.map(node => [node.id, node]))) } : bounds;
};

/**
 * What sections hold, like things dropped into a FigJam section: each node whose centre lies inside, each group whose
 * frame centre lies inside (with all its members), nested sections with their own contents, and the stamps attached to
 * any node taken. `page` is one page's { nodes, groups, sections }; `roots` are section IDs. Returns the node IDs and
 * the section IDs, roots included.
 */
export function sectionContents(page, roots, measure = estimatedSize) {
  const sections = page.sections || [], sectionIds = new Set(), stack = sections.filter(section => roots.has(section.id));
  stack.forEach(section => sectionIds.add(section.id));
  while (stack.length) {
    const outer = stack.pop();
    for (const section of sections) if (!sectionIds.has(section.id) && nests(section, outer)) { sectionIds.add(section.id); stack.push(section); }
  }
  const rects = sections.filter(section => sectionIds.has(section.id)), inside = box => { const point = centre(box); return rects.some(rect => holds(rect, point)); };
  const byId = new Map(page.nodes.map(node => [node.id, node])), nodeIds = new Set(), grouped = new Set();
  if (!rects.length) return { nodeIds, sectionIds };
  // A grouped node goes where its group goes, and an attached stamp where its node goes.
  for (const group of page.groups || []) {
    group.nodeIds.forEach(id => grouped.add(id));
    if (inside(frameBox(group, page.nodes, byId, measure))) for (const id of group.nodeIds) if (byId.has(id)) nodeIds.add(id);
  }
  const follows = node => node.type === 'stamp' && canAttachStamp(byId.get(node.data.attachedTo));
  for (const node of page.nodes) if (!grouped.has(node.id) && !follows(node) && inside(nodeBox(node, measure))) nodeIds.add(node.id);
  for (const node of page.nodes) if (follows(node) && nodeIds.has(node.data.attachedTo)) nodeIds.add(node.id);
  return { nodeIds, sectionIds };
}

// Where everything a section move takes along started. Taken when the move begins, so what it passes over stays put.
export function captureSections(page, roots, measure) {
  const { nodeIds, sectionIds } = sectionContents(page, roots, measure);
  return { nodes: new Map(page.nodes.filter(node => nodeIds.has(node.id)).map(node => [node.id, node.position])),
    sections: new Map((page.sections || []).filter(section => sectionIds.has(section.id)).map(section => [section.id, { x: section.x, y: section.y }])) };
}

// Places captured items at their start plus `delta`; everything else keeps its identity.
export function moveCaptured({ nodes, sections }, capture, delta) {
  const there = (start, x, y) => x === start.x + delta.x && y === start.y + delta.y;
  return {
    nodes: nodes.map(node => { const start = capture.nodes.get(node.id); return !start || there(start, node.position.x, node.position.y) ? node : { ...node, position: { x: start.x + delta.x, y: start.y + delta.y } }; }),
    sections: sections.map(section => { const start = capture.sections.get(section.id); return !start || there(start, section.x, section.y) ? section : { ...section, x: start.x + delta.x, y: start.y + delta.y }; }),
  };
}

// A new section around the chosen nodes, groups (a chosen member takes its whole group) and sections, with room for its title.
export function wrapBounds(page, ids, measure = estimatedSize) {
  const byId = new Map(page.nodes.map(node => [node.id, node])), boxes = [], taken = new Set();
  for (const group of page.groups || []) if (ids.has(group.id) || group.nodeIds.some(id => ids.has(id))) { boxes.push(frameBox(group, page.nodes, byId, measure)); group.nodeIds.forEach(id => taken.add(id)); }
  for (const node of page.nodes) if (ids.has(node.id)) taken.add(node.id);
  for (const node of page.nodes) if (taken.has(node.id) || (node.type === 'stamp' && taken.has(node.data.attachedTo))) boxes.push(nodeBox(node, measure));
  for (const section of page.sections || []) if (ids.has(section.id)) boxes.push(section);
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map(box => box.x)) - sectionPadding.side, y = Math.min(...boxes.map(box => box.y)) - sectionPadding.top;
  const right = Math.max(...boxes.map(box => box.x + box.width)) + sectionPadding.side, bottom = Math.max(...boxes.map(box => box.y + box.height)) + sectionPadding.side;
  return { x, y, width: Math.max(sectionMinimum.width, right - x), height: Math.max(sectionMinimum.height, bottom - y) };
}

// The topmost node under `point` that a stamp (or, with `canAttach`, an arrow end) can hold on to; `nodes` as React Flow
// draws them. Found by geometry, as drawing tools turn off pointer events on cards.
export function stampTargetAt(nodes, point, stampId, canAttach = canAttachStamp) {
  let target, top = -Infinity;
  const layers = layerIndex(nodes);
  for (const node of nodes) {
    if (node.id === stampId || node.hidden || !canAttach(node)) continue;
    const { width, height } = size(node), zIndex = node.zIndex ?? layers.get(node.id);
    if (point.x < node.position.x || point.x > node.position.x + width || point.y < node.position.y || point.y > node.position.y + height || zIndex < top) continue;
    target = node.id; top = zIndex;
  }
  return target;
}

export function attachStampAt(nodes, stampId, point, visibleNodes = nodes) {
  const target = stampTargetAt(visibleNodes, point, stampId);
  return nodes.map(node => {
    if (node.id !== stampId || node.type !== 'stamp') return node;
    const data = { ...node.data };
    if (target === undefined) delete data.attachedTo; else data.attachedTo = target;
    return { ...node, data };
  });
}

// Aligns only the chosen nodes (annotations stay put) and keeps their top-left corner where it was.
export function alignSelection(nodes, edges, groups, ids) {
  const chosen = nodes.filter(node => ids.has(node.id) && !isAnnotation(node));
  if (chosen.length < 2) return nodes;
  const set = new Set(chosen.map(node => node.id));
  const aligned = alignNodes(chosen, edges.filter(edge => set.has(edge.source) && set.has(edge.target)), pruneGroups(groups, chosen));
  const corner = list => ({ x: Math.min(...list.map(node => node.position.x)), y: Math.min(...list.map(node => node.position.y - captionHeight(node))) });
  const before = corner(chosen), after = corner(aligned), dx = before.x - after.x, dy = before.y - after.y;
  const moved = new Map(aligned.map(node => [node.id, { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } }]));
  return reconcileStampAttachments(nodes, nodes.map(node => moved.get(node.id) || node));
}

export function alignNodes(nodes, edges, groups) {
  if (nodes.some(isAnnotation)) {
    const movable = nodes.filter(node => !isAnnotation(node)), ids = new Set(movable.map(node => node.id));
    const aligned = new Map(alignNodes(movable, edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)), pruneGroups(groups, movable)).map(node => [node.id, node]));
    return reconcileStampAttachments(nodes, nodes.map(node => aligned.get(node.id) || node));
  }
  if (!nodes.length) return nodes;
  const repaired = new Map();
  for (const group of groups.filter(group => !group.collapsed)) {
    const members = nodes.filter(node => group.nodeIds.includes(node.id)).sort((a, b) => a.position.y - b.position.y);
    const overlaps = members.some((a, index) => members.slice(index + 1).some(b => a.position.x < b.position.x + size(b).width && b.position.x < a.position.x + size(a).width
      && a.position.y - captionHeight(a) < b.position.y + size(b).height && b.position.y - captionHeight(b) < a.position.y + size(a).height));
    if (!overlaps) continue;
    let bottom;
    for (const node of members) {
      const y = bottom === undefined ? node.position.y : bottom + 30 + captionHeight(node);
      repaired.set(node.id, { ...node, position: { ...node.position, y } });
      bottom = y + size(node).height;
    }
  }
  nodes = nodes.map(node => repaired.get(node.id) || node);
  const owners = new Map(), units = new Map();
  // Legacy nodes keep their array order before dated nodes; groups inherit their oldest member.
  const age = new Map(nodes.map((node, index) => [node.id, { time: Number.isFinite(Date.parse(node.data.createdAt)) ? Date.parse(node.data.createdAt) : -Infinity, index }]));
  const chronological = (a, b) => {
    const left = age.get(a), right = age.get(b);
    return left.time === right.time ? left.index - right.index : left.time - right.time;
  };
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const group of groups) {
    units.set(group.id, frameBox(group, nodes, byId));
    age.set(group.id, age.get([...group.nodeIds].sort(chronological)[0]));
    for (const id of group.nodeIds) owners.set(id, group.id);
  }
  for (const node of nodes) if (!owners.has(node.id)) { owners.set(node.id, node.id); units.set(node.id, { ...node.position, ...size(node) }); }
  const ids = [...units.keys()], children = new Map(ids.map(id => [id, new Set()]));
  for (const edge of edges) {
    const source = owners.get(edge.source), target = owners.get(edge.target);
    if (source && target && source !== target) children.get(source).add(target);
  }
  // Folding separate generations into one group can create display-only cycles.
  const visited = new Set(), active = new Set(), ordered = [];
  const visit = id => {
    visited.add(id); active.add(id);
    for (const child of children.get(id)) {
      if (active.has(child)) children.get(id).delete(child);
      else if (!visited.has(child)) visit(child);
    }
    active.delete(id); ordered.unshift(id);
  };
  for (const id of ids) if (!visited.has(id)) visit(id);
  const level = new Map(ids.map(id => [id, 0]));
  const relevel = () => { for (const id of ordered) for (const child of children.get(id)) level.set(child, Math.max(level.get(child), level.get(id) + 1)); };
  relevel();
  // A parentless source (e.g. an uploaded reference) sits just before the first node another chain feeds,
  // and prompts made only from it follow it there instead of pulling it back to column 0.
  const parentsOf = new Map(ids.map(id => [id, []]));
  for (const id of ids) for (const child of children.get(id)) parentsOf.get(child).push(id);
  const isSource = id => !parentsOf.get(id).length && children.get(id).size > 0;
  const sources = new Set();
  for (const id of ids.filter(isSource)) {
    const anchored = [...children.get(id)].filter(child => parentsOf.get(child).some(other => !isSource(other)));
    const target = anchored.length ? Math.min(...anchored.map(child => level.get(child))) - 1 : 0;
    if (target > level.get(id)) { level.set(id, target); sources.add(id); }
  }
  if (sources.size) relevel();

  // Reserve room for whole branches; shared references use their nearest parent.
  // Moved sources never adopt a node that already hangs off its own tree.
  const parent = new Map(), branches = new Map(ids.map(id => [id, []]));
  for (const allowSources of [false, true]) for (const id of ids) {
    if (sources.has(id) !== allowSources) continue;
    for (const child of children.get(id)) if (!parent.has(child) || (!allowSources && level.get(id) > level.get(parent.get(child)))) parent.set(child, id);
  }
  // Structure decides placement; age only orders siblings and separate trees, oldest first.
  const byAge = [...ids].sort(chronological);
  for (const id of byAge) if (parent.has(id)) branches.get(parent.get(id)).push(id);
  const gap = 60, spans = new Map(), positions = new Map();
  const span = id => {
    const branch = branches.get(id);
    const height = Math.max(units.get(id).height, branch.reduce((sum, child) => sum + span(child), 0) + Math.max(0, branch.length - 1) * gap);
    spans.set(id, height); return height;
  };
  const place = (id, top) => {
    const branch = branches.get(id), height = spans.get(id);
    positions.set(id, { x: 0, y: top + (height - units.get(id).height) / 2 });
    let next = top + (height - branch.reduce((sum, child) => sum + spans.get(child), 0) - Math.max(0, branch.length - 1) * gap) / 2;
    for (const child of branch) { place(child, next); next += spans.get(child) + gap; }
  };
  let top = 0;
  for (const id of byAge.filter(id => !parent.has(id))) { span(id); place(id, top); top += spans.get(id) + gap; }

  // Moving a source can leave an empty level behind; drop it so columns stay contiguous.
  const columns = Object.values(Object.groupBy(ids, id => level.get(id))).sort((a, b) => level.get(a[0]) - level.get(b[0]));
  let left = 80;
  for (const column of columns) {
    for (const id of column) positions.get(id).x = left;
    left += Math.max(...column.map(id => units.get(id).width)) + 110;
  }
  for (const column of [...columns].reverse()) {
    const desired = new Map(column.map(id => {
      const targets = [...children.get(id)];
      const center = targets.length ? (Math.min(...targets.map(child => positions.get(child).y))
        + Math.max(...targets.map(child => positions.get(child).y + units.get(child).height))) / 2
        : positions.get(id).y + units.get(id).height / 2;
      return [id, center - units.get(id).height / 2];
    }));
    column.sort((a, b) => desired.get(a) - desired.get(b) || chronological(a, b));
    // Resolve collisions with the smallest balanced shift, without top-aligning parents.
    const blocks = [], offsets = new Map();
    let offset = 0;
    for (const id of column) {
      offsets.set(id, offset);
      blocks.push({ ids: [id], total: desired.get(id) - offset });
      while (blocks.length > 1) {
        const a = blocks.at(-2), b = blocks.at(-1);
        if (a.total / a.ids.length <= b.total / b.ids.length) break;
        a.ids.push(...b.ids); a.total += b.total; blocks.pop();
      }
      offset += units.get(id).height + gap;
    }
    for (const block of blocks) for (const id of block.ids) positions.get(id).y = block.total / block.ids.length + offsets.get(id);
  }
  const shift = 80 - Math.min(...ids.map(id => positions.get(id).y));
  return nodes.map(node => {
    const owner = owners.get(node.id), before = units.get(owner), after = positions.get(owner);
    return { ...node, position: { x: after.x + (node.position.x - before.x), y: after.y + shift + (node.position.y - before.y) } };
  });
}

// FigJam's selection box takes whatever it touches. An arrow or a drawing counts only where its line runs, not across its
// whole bounding box, and a section the box starts inside is the backdrop of the drag, not something it picked.
// `nodes` are React Flow's (measured sizes); `box` and `start` are in flow coordinates.
export function boxTouches(nodes, box, start) {
  const touched = new Set(), right = box.x + box.width, bottom = box.y + box.height;
  for (const node of nodes) {
    if (node.hidden || node.selectable === false) continue;
    const { x, y } = node.internals?.positionAbsolute || node.position, width = node.measured?.width ?? node.width ?? 0, height = node.measured?.height ?? node.height ?? 0;
    if (x > right || y > bottom || x + width < box.x || y + height < box.y) continue;
    if (node.type === 'section' && start.x > x && start.x < x + width && start.y > y && start.y < y + height) continue;
    if (node.type === 'arrow') { const { x1, y1, x2, y2 } = node.data.line; if (!segmentTouches([x + x1, y + y1], [x + x2, y + y2], box)) continue; }
    if (node.type === 'drawing') {
      const pad = node.data.width / 2, wide = { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad }, points = node.data.points.map(([px, py]) => [x + px, y + py]);
      if (!points.some((point, i) => segmentTouches(points[Math.max(0, i - 1)], point, wide))) continue;
    }
    touched.add(node.id);
  }
  return touched;
}

// Liang–Barsky clipping: whether the segment a→b passes through the rectangle (a single point when a equals b).
function segmentTouches([ax, ay], [bx, by], box) {
  const dx = bx - ax, dy = by - ay;
  let enter = 0, leave = 1;
  for (const [p, q] of [[-dx, ax - box.x], [dx, box.x + box.width - ax], [-dy, ay - box.y], [dy, box.y + box.height - ay]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    if (p < 0) enter = Math.max(enter, q / p); else leave = Math.min(leave, q / p);
    if (enter > leave) return false;
  }
  return true;
}

// A plain box selects what it touches. With Shift it flips what it touches against the selection the drag started from,
// so passing back off an item restores it, as in FigJam.
export function boxSelection(touched, base) {
  if (!base) return touched;
  const ids = new Set(base);
  for (const id of touched) if (!ids.delete(id)) ids.add(id);
  return ids;
}

// Marks exactly `ids` selected among the items `scope` holds (the open page); the list keeps its identity when nothing changes.
export function reselect(items, ids, scope) {
  let changed = false;
  const next = items.map(item => { if (!scope.has(item.id) || !!item.selected === ids.has(item.id)) return item; changed = true; return { ...item, selected: ids.has(item.id) }; });
  return changed ? next : items;
}

// FigJam frames a selection of two or more items in one box. An arrow counts by its line and an image with its caption;
// cards folded into a group are left out.
export function selectionBounds(nodes) {
  let count = 0, left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const node of nodes) {
    if (!node.selected || node.hidden) continue;
    const { x, y } = node.position, line = node.type === 'arrow' && node.data.line, caption = captionHeight(node);
    const box = line ? { x: x + Math.min(line.x1, line.x2), y: y + Math.min(line.y1, line.y2), width: Math.abs(line.x2 - line.x1), height: Math.abs(line.y2 - line.y1) }
      : { x, y: y - caption, width: node.measured?.width ?? node.width ?? 0, height: (node.measured?.height ?? node.height ?? 0) + caption };
    count++; left = Math.min(left, box.x); top = Math.min(top, box.y); right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height);
  }
  return count < 2 ? null : { x: left, y: top, width: right - left, height: bottom - top };
}
