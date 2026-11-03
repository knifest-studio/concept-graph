import * as Y from 'yjs';
import { isAnnotation, canAttachStamp, reconcileStampAttachments } from './annotations.mjs';
import { boardPages, defaultPages, maxPages, pageResolver, validPageId } from './pages.mjs';
import { validLayer } from './layers.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copy = value => structuredClone(value);
const keyed = items => new Map((items || []).map(item => [item.id, item]));
const nodeFields = (node, nodes) => {
  const parent = node.type === 'stamp' && nodes.get(node.data.attachedTo);
  return { type: node.type, x: node.position.x, y: node.position.y, page: node.page, z: node.z,
    ...(canAttachStamp(parent) ? { stampAttachment: { nodeId: parent.id, x: node.position.x - parent.position.x, y: node.position.y - parent.position.y } } : {}) };
};
const groupFields = group => ({ name: group.name, collapsed: group.collapsed, nodeIds: group.nodeIds, color: group.color });

function patchFields(map, next, before) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (same(next[key], before[key])) continue;
    if (next[key] === undefined) map.delete(key);
    else map.set(key, copy(next[key]));
  }
}

function patchMaps(map, next, before, fields, nested = false) {
  const previous = keyed(before), incoming = keyed(next);
  for (const id of previous.keys()) if (!incoming.has(id)) map.delete(id);
  for (const [id, item] of incoming) {
    const old = previous.get(id);
    let entry = map.get(id);
    // Editing a removed nested map must never resurrect its node/group.
    if (!entry && old) continue;
    if (!entry) { entry = new Y.Map(); map.set(id, entry); }
    const nextFields = fields(item, incoming), oldFields = old ? fields(old, previous) : {};
    if (nested && item.type === 'stamp') {
      const sameAnchor = same(nextFields.stampAttachment, oldFields.stampAttachment);
      if (nextFields.stampAttachment && sameAnchor) {
        // Parent motion is derived at read time and must not overwrite a concurrent drop.
        nextFields.x = oldFields.x; nextFields.y = oldFields.y;
      } else if (!sameAnchor) {
        // Detachment must store world coordinates even when the visible position did not change.
        oldFields.x = undefined; oldFields.y = undefined;
      }
    }
    patchFields(entry, nextFields, oldFields);
    if (nested) {
      let data = entry.get('data');
      if (!data) { data = new Y.Map(); entry.set('data', data); }
      patchFields(data, item.data, old?.data || {});
    }
  }
}

function patchValues(map, next, before, value) {
  const previous = keyed(before), incoming = keyed(next);
  for (const id of previous.keys()) if (!incoming.has(id)) map.delete(id);
  for (const [id, item] of incoming) {
    const old = previous.get(id);
    if (old && !map.has(id)) continue;
    if (!old || !same(value(item), value(old))) map.set(id, copy(value(item)));
  }
}

// Concurrent page creation can repeat an order; every replica breaks the tie by ID.
const readPages = doc => [...doc.getMap('pages')].filter(([id, page]) => validPageId(id) && typeof page?.name === 'string')
  .sort(([a, left], [b, right]) => (Number.isFinite(left.order) ? left.order : 0) - (Number.isFinite(right.order) ? right.order : 0) || a.localeCompare(b))
  .slice(0, maxPages).map(([id, page]) => ({ id, name: page.name.trim().slice(0, 80).trim() || 'Untitled page' }));

export function readCloudGraph(doc, local = {}) {
  const locals = keyed(local.nodes), localGroups = keyed(local.groups), localEdges = keyed(local.edges), pages = readPages(doc);
  const nodes = [...doc.getMap('nodes')].sort(([a], [b]) => a.localeCompare(b)).map(([id, node]) => {
    const { page, z, ...localNode } = locals.get(id) || {};
    // An out-of-range layer from another replica falls back to the default instead of invalidating the board.
    return { ...localNode, id, type: node.get('type'), position: { x: node.get('x'), y: node.get('y') }, data: node.get('data').toJSON(), ...(node.has('page') ? { page: node.get('page') } : {}), ...(validLayer(node.get('z')) ? { z: node.get('z') } : {}) };
  });
  // Raw page IDs are kept; a node whose page was deleted concurrently is shown on the first page.
  const page = pageResolver(boardPages({ pages })), samePage = (a, b) => page(a.page) === page(b.page);
  const ids = new Set(nodes.map(node => node.id)), byId = keyed(nodes), outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const node of nodes) {
    if (node.type !== 'stamp' || node.data.attachedTo === undefined) continue;
    const parent = byId.get(node.data.attachedTo), anchor = doc.getMap('nodes').get(node.id).get('stampAttachment');
    if (!canAttachStamp(parent) || !samePage(node, parent)) delete node.data.attachedTo;
    else if (anchor?.nodeId === parent.id && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) node.position = { x: parent.position.x + anchor.x, y: parent.position.y + anchor.y };
  }
  const edges = [];
  // Simultaneous, individually valid connections can form a cycle; every replica chooses the same DAG.
  for (const [id, edge] of [...doc.getMap('edges')].sort(([a], [b]) => a.localeCompare(b))) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || isAnnotation(byId.get(edge.source)) || isAnnotation(byId.get(edge.target))
      || (byId.get(edge.target).type !== 'text' && !byId.get(edge.target).data.runId) || !samePage(byId.get(edge.source), byId.get(edge.target))) continue;
    const pending = [edge.target], visited = new Set();
    while (pending.length) {
      const node = pending.pop();
      if (visited.has(node)) continue;
      visited.add(node); pending.push(...outgoing.get(node));
    }
    if (visited.has(edge.source)) continue;
    outgoing.get(edge.source).push(edge.target);
    edges.push({ ...localEdges.get(id), id, ...copy(edge) });
  }
  const occupied = new Set();
  const groups = [...doc.getMap('groups')].sort(([a], [b]) => a.localeCompare(b)).map(([id, group]) => {
    const members = (group.get('nodeIds') || []).filter(id => ids.has(id) && !occupied.has(id));
    const nodeIds = members.filter(id => samePage(byId.get(id), byId.get(members[0])));
    nodeIds.forEach(id => occupied.add(id));
    const { color: localColor, ...localGroup } = localGroups.get(id) || {};
    return { ...localGroup, id, name: group.get('name'), collapsed: group.get('collapsed'), nodeIds, ...(group.has('color') ? { color: group.get('color') } : {}) };
  }).filter(group => group.nodeIds.length);
  const runs = [...doc.getMap('runs').values()].map(copy).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  return { nodes, edges, groups, runs, ...(pages.length ? { pages } : {}) };
}

// Diff against the caller's snapshot, not today's document: untouched remote fields stay untouched.
export function applyLocalGraph(doc, graph, previous, origin) {
  const nodes = reconcileStampAttachments(previous.nodes || [], graph.nodes);
  const ids = new Set(nodes.map(node => node.id)), stored = doc.getMap('pages'), previousPages = previous.pages ?? defaultPages();
  // The implicit first page becomes explicit outside undo history, so a concurrent writer's undo cannot remove it.
  if (graph.pages !== undefined && !stored.size) doc.transact(() => defaultPages().forEach((page, order) => stored.set(page.id, { name: page.name, order })), { pages: 'default' });
  doc.transact(() => {
    // Relative anchors preserve concurrent parent moves and direct stamp edits.
    for (const node of doc.getMap('nodes').values()) {
      const data = node instanceof Y.Map && node.get('data');
      if (!(data instanceof Y.Map) || node.get('type') !== 'stamp' || data.get('attachedTo') === undefined) continue;
      const parent = doc.getMap('nodes').get(data.get('attachedTo'));
      if (!(parent instanceof Y.Map) || !canAttachStamp({ type: parent.get('type') })) { data.delete('attachedTo'); node.delete('stampAttachment'); }
    }
    patchMaps(doc.getMap('nodes'), nodes, previous.nodes, nodeFields, true);
    patchValues(doc.getMap('edges'), graph.edges, previous.edges, edge => ({ source: edge.source, target: edge.target }));
    patchMaps(doc.getMap('groups'), (graph.groups || []).map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => ids.has(id)) })).filter(group => group.nodeIds.length), previous.groups, groupFields);
    patchValues(doc.getMap('runs'), graph.runs, previous.runs, run => run);
    // New pages sort after every page this replica has seen; existing pages keep their order.
    const order = new Map([...stored].map(([id, page]) => [id, page?.order]));
    let last = Math.max(-1, ...[...order.values()].filter(Number.isFinite));
    const ordered = pages => pages.map(page => ({ ...page, order: Number.isFinite(order.get(page.id)) ? order.get(page.id) : order.set(page.id, ++last).get(page.id) }));
    if (graph.pages !== undefined) patchValues(stored, ordered(graph.pages), ordered(previousPages), page => ({ name: page.name, order: page.order }));
  }, origin);
}
