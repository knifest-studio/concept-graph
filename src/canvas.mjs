import { nodeSize, captionHeight } from '../graph.mjs';
import { isAnnotation, canAttachStamp, reconcileStampAttachments } from './annotations.mjs';
import { layerIndex, sameShape } from './layers.mjs';

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

// A run may gain its second image after the user edited the initially uncaptioned first one.
export function restoreFirstImageFallback(nodes, currentNodes, runs, snapshot) {
  const current = new Map(currentNodes.map(node => [node.id, node]));
  const runsById = new Map(runs.map(run => [run.id, run]));
  const activeAtSnapshot = new Set(snapshot.activeRunIds || []);
  const captured = Date.parse(snapshot.capturedAt);
  return nodes.map(node => {
    if (node.type !== 'image' || !node.data.runId || Object.hasOwn(node.data, 'caption')) return node;
    const now = current.get(node.id), run = runsById.get(node.data.runId);
    if (!now || now.type !== 'image' || now.data.caption === '' || !run || run.outputIds?.length < 2 || run.outputIds?.[0] !== node.id) return node;
    const active = run.status === 'running' || run.status === 'queued';
    const finishedAfter = Number.isFinite(captured) && Number.isFinite(Date.parse(run.finishedAt)) && Date.parse(run.finishedAt) > captured;
    if (!active && !activeAtSnapshot.has(run.id) && !finishedAfter) return node;
    return { ...node, data: { ...node.data, caption: 'Image 1' } };
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
      for (const key of ['name', 'color', 'collapsed']) {
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

export const cleanGroups = groups => groups.map(({ id, name, nodeIds, collapsed, color }) => ({ id, name, nodeIds, collapsed, ...(color === undefined ? {} : { color }) }));
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

// An unmeasured prompt grows with its text (13px type, 22px lines, ~44 characters per line in a 310px card).
// A light card's connection dot. React Flow measures connection points by their `source`/`target` class and reads the
// side from data-handlepos; without it the links would leave from the bottom and enter from the top.
export const lodHandleProps = type => ({ className: `lod-handle ${type}`, 'data-handlepos': type === 'source' ? 'right' : 'left' });

// A prompt not drawn yet: header, text lines and, when something feeds it, the "Inputs" row, as the card will lay them out.
export function estimatedSize(node, inputs = false) {
  if (node.type !== 'text' || node.measured || node.data?.collapsed) return size(node);
  const lines = String(node.data?.text || '').split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 44)), 0);
  return { width: 310, height: Math.round(58 + 22.1 * Math.min(lines, 400) + (inputs ? 21.4 : 0)) };
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
const frameHandles = Object.freeze([{ id: null, type: 'target', position: 'left', x: -10, y: 31, width: 10, height: 10 }, { id: null, type: 'source', position: 'right', x: 240, y: 31, width: 10, height: 10 }]);
const edgeStyles = { text: Object.freeze({ stroke: connectionColor('text'), strokeWidth: 2 }), image: Object.freeze({ stroke: connectionColor('image'), strokeWidth: 2 }) };

// Per-editor memory for canvasView: unchanged inputs give back the same objects (and arrays), so React Flow skips them.
export const createViewCache = () => ({ nodes: new WeakMap(), frames: new WeakMap(), edges: new WeakMap(), sizes: new Map(), layers: null, view: null });
const folded = Object.freeze({ width: 72, height: 72 });
const sameItems = (a, b) => a?.length === b.length && a.every((item, index) => item === b[index]);

// Groups are display containers; original node IDs and generation edges stay intact.
export function canvasView(nodes, edges, groups, cache = createViewCache()) {
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
  const viewNodes = nodes.map(node => {
    byId.set(node.id, node);
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
  const frames = groups.map(group => {
    const bounds = groupBounds(group, nodes, byId, shown);
    const width = group.collapsed ? 240 : bounds.width, height = group.collapsed ? 72 : bounds.height, saved = cache.frames.get(group);
    if (saved && saved.x === bounds.x && saved.y === bounds.y && saved.width === width && saved.height === height) return saved.view;
    const view = { id: group.id, type: 'group', position: { x: bounds.x, y: bounds.y }, selected: !!group.selected,
      data: { name: group.name, count: group.nodeIds.length, collapsed: group.collapsed, color: group.color },
      // Below the connections' layer (0): an opaque group colour must never hide the links between its members.
      width, height, measured: { width, height }, style: { width, height }, zIndex: -1, handles: group.collapsed ? frameHandles : [] };
    cache.frames.set(group, { x: bounds.x, y: bounds.y, width, height, view });
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
  const all = [...frames, ...viewNodes], last = cache.view;
  cache.view = { nodes: last && sameItems(last.nodes, all) ? last.nodes : all, edges: last && sameItems(last.edges, viewEdges) ? last.edges : viewEdges };
  return cache.view;
}

// Far out, titles of small neighbouring groups would pile up. Like labels on a map, the selected and larger groups keep
// theirs and a title that would overlap one already placed waits until the board is closer. Sizes are screen pixels and
// follow the CSS for .group-title.
export function visibleTitles(frames, zoom) {
  const size = Math.min(Math.max(16, 24 * zoom), 20), height = Math.ceil(size * 1.3), cell = 160, grid = new Map(), shown = new Set();
  const order = [...frames].sort((a, b) => b.selected - a.selected || b.width * b.height - a.width * a.height || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const frame of order) {
    const width = Math.min(Math.max(frame.width * zoom, 360), String(frame.data.name).length * size * .62 + 12);
    const left = frame.position.x * zoom, bottom = frame.position.y * zoom - 6, box = { left, right: left + width, top: bottom - height, bottom };
    const cells = [];
    for (let x = Math.floor(box.left / cell); x <= Math.floor(box.right / cell); x++) for (let y = Math.floor(box.top / cell); y <= Math.floor(box.bottom / cell); y++) cells.push(`${x}:${y}`);
    if (cells.some(key => grid.get(key)?.some(other => other.left < box.right && box.left < other.right && other.top < box.bottom && box.top < other.bottom))) continue;
    cells.forEach(key => grid.set(key, [...(grid.get(key) || []), box]));
    shown.add(frame.id);
  }
  return shown;
}

export function moveGroup(nodes, group, position, moveStamps = true) {
  const bounds = groupBounds(group, nodes);
  const dx = position.x - bounds.x, dy = position.y - bounds.y;
  const members = new Set(group.nodeIds);
  const moved = nodes.map(node => members.has(node.id) ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node);
  return moveStamps ? reconcileStampAttachments(nodes, moved) : moved;
}

export function stampTargetAt(nodes, point, stampId) {
  let target, top = -Infinity;
  const layers = layerIndex(nodes);
  for (const node of nodes) {
    if (node.id === stampId || node.hidden || !canAttachStamp(node)) continue;
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
  for (const group of groups) {
    const bounds = groupBounds(group, nodes);
    units.set(group.id, { ...bounds, width: group.collapsed ? 240 : bounds.width, height: group.collapsed ? 72 : bounds.height });
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
