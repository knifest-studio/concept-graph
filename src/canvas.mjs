export const connectionColor = type => type === 'image' ? 'var(--purple)' : 'var(--blue)';

export function edgeDropCreatesPrompt(state, onPane) {
  return onPane && !state.isValid && !state.toNode && state.fromHandle?.type === 'source' && ['text', 'image'].includes(state.fromNode?.type);
}

export const cleanGroups = groups => groups.map(({ id, name, nodeIds, collapsed }) => ({ id, name, nodeIds, collapsed }));
export function pruneGroups(groups, nodes) {
  const ids = new Set(nodes.map(node => node.id));
  return groups.map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => ids.has(id)) })).filter(group => group.nodeIds.length);
}

const size = node => ({ width: node.measured?.width || 310, height: node.measured?.height || (node.type === 'text' ? 80 : 310) });
export function groupBounds(group, nodes) {
  const members = nodes.filter(node => group.nodeIds.includes(node.id));
  const x = Math.min(...members.map(node => node.position.x)) - 24;
  const y = Math.min(...members.map(node => node.position.y)) - 48;
  return { x, y, width: Math.max(...members.map(node => node.position.x + size(node).width)) - x + 24,
    height: Math.max(...members.map(node => node.position.y + size(node).height)) - y + 24 };
}

// Groups are display containers; original node IDs and generation edges stay intact.
export function canvasView(nodes, edges, groups) {
  const collapsed = new Map();
  for (const group of groups.filter(group => group.collapsed)) for (const id of group.nodeIds) collapsed.set(id, group.id);
  const types = new Map(nodes.map(node => [node.id, node.type]));
  const frames = groups.map(group => {
    const bounds = groupBounds(group, nodes);
    const width = group.collapsed ? 240 : bounds.width, height = group.collapsed ? 72 : bounds.height;
    return { id: group.id, type: 'group', position: { x: bounds.x, y: bounds.y }, selected: !!group.selected,
      data: { name: group.name, count: group.nodeIds.length, collapsed: group.collapsed },
      width, height, measured: { width, height }, style: { width, height }, zIndex: 0 };
  });
  return {
    nodes: [...frames, ...nodes.map(node => ({ ...node, zIndex: 1, hidden: collapsed.has(node.id), selected: collapsed.has(node.id) ? false : node.selected }))],
    edges: edges.map(edge => {
      const source = collapsed.get(edge.source) || edge.source, target = collapsed.get(edge.target) || edge.target;
      return { ...edge, source, target, hidden: source === target, style: { stroke: connectionColor(types.get(edge.source)), strokeWidth: 2 } };
    }),
  };
}

export function moveGroup(nodes, group, position) {
  const bounds = groupBounds(group, nodes);
  const dx = position.x - bounds.x, dy = position.y - bounds.y;
  const members = new Set(group.nodeIds);
  return nodes.map(node => members.has(node.id) ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node);
}

export function alignNodes(nodes, edges, groups) {
  if (!nodes.length) return nodes;
  const owners = new Map(), units = new Map();
  for (const group of groups) {
    const bounds = groupBounds(group, nodes);
    units.set(group.id, { ...bounds, width: group.collapsed ? 240 : bounds.width, height: group.collapsed ? 72 : bounds.height });
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
  for (const id of ordered) for (const child of children.get(id)) level.set(child, Math.max(level.get(child), level.get(id) + 1));

  // Reserve room for whole branches; shared references use their nearest parent.
  const parent = new Map(), branches = new Map(ids.map(id => [id, []]));
  for (const id of ids) for (const child of children.get(id)) {
    if (!parent.has(child) || level.get(id) > level.get(parent.get(child))) parent.set(child, id);
  }
  for (const id of ids) if (parent.has(id)) branches.get(parent.get(id)).push(id);
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
  for (const id of ids.filter(id => !parent.has(id))) { span(id); place(id, top); top += spans.get(id) + gap; }

  const columns = [];
  for (const id of ids) (columns[level.get(id)] ||= []).push(id);
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
    column.sort((a, b) => desired.get(a) - desired.get(b));
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
