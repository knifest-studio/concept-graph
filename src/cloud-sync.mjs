import * as Y from 'yjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copy = value => structuredClone(value);
const keyed = items => new Map((items || []).map(item => [item.id, item]));
const nodeFields = node => ({ type: node.type, x: node.position.x, y: node.position.y });
const groupFields = group => ({ name: group.name, collapsed: group.collapsed, nodeIds: group.nodeIds });

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
    patchFields(entry, fields(item), old ? fields(old) : {});
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

export function readCloudGraph(doc, local = {}) {
  const locals = keyed(local.nodes), localGroups = keyed(local.groups), localEdges = keyed(local.edges);
  const nodes = [...doc.getMap('nodes')].sort(([a], [b]) => a.localeCompare(b)).map(([id, node]) => ({
    ...locals.get(id), id, type: node.get('type'), position: { x: node.get('x'), y: node.get('y') }, data: node.get('data').toJSON(),
  }));
  const ids = new Set(nodes.map(node => node.id)), byId = keyed(nodes), outgoing = new Map(nodes.map(node => [node.id, []]));
  const edges = [];
  // Simultaneous, individually valid connections can form a cycle; every replica chooses the same DAG.
  for (const [id, edge] of [...doc.getMap('edges')].sort(([a], [b]) => a.localeCompare(b))) {
    if (!ids.has(edge.source) || !ids.has(edge.target) || (byId.get(edge.target).type !== 'text' && !byId.get(edge.target).data.runId)) continue;
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
    const nodeIds = (group.get('nodeIds') || []).filter(id => ids.has(id) && !occupied.has(id));
    nodeIds.forEach(id => occupied.add(id));
    return { ...localGroups.get(id), id, name: group.get('name'), collapsed: group.get('collapsed'), nodeIds };
  }).filter(group => group.nodeIds.length);
  const runs = [...doc.getMap('runs').values()].map(copy).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  return { nodes, edges, groups, runs };
}

// Diff against the caller's snapshot, not today's document: untouched remote fields stay untouched.
export function applyLocalGraph(doc, graph, previous, origin) {
  doc.transact(() => {
    patchMaps(doc.getMap('nodes'), graph.nodes, previous.nodes, nodeFields, true);
    patchValues(doc.getMap('edges'), graph.edges, previous.edges, edge => ({ source: edge.source, target: edge.target }));
    patchMaps(doc.getMap('groups'), graph.groups, previous.groups, groupFields);
    patchValues(doc.getMap('runs'), graph.runs, previous.runs, run => run);
  }, origin);
}
