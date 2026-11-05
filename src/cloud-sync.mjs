import * as Y from 'yjs';
import { isAnnotation, canAttachStamp, reconcileStampAttachments } from './annotations.mjs';
import { boardPages, defaultPages, maxPages, pageResolver, validPageId } from './pages.mjs';
import { validLayer } from './layers.mjs';
import { maxSections, readSection } from './sections.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copy = value => structuredClone(value);
const keyed = items => new Map((items || []).map(item => [item.id, item]));
// localeCompare without arguments, minus the per-call setup; every replica sorts IDs the same way.
const compare = new Intl.Collator().compare;
const byKey = ([a], [b]) => compare(a, b);
const byRun = (a, b) => compare(a.startedAt, b.startedAt) || compare(a.id, b.id);
const nodeFields = (node, nodes) => {
  const parent = node.type === 'stamp' && nodes.get(node.data.attachedTo);
  return { type: node.type, x: node.position.x, y: node.position.y, page: node.page, z: node.z,
    ...(canAttachStamp(parent) ? { stampAttachment: { nodeId: parent.id, x: node.position.x - parent.position.x, y: node.position.y - parent.position.y } } : {}) };
};
const groupFields = group => ({ name: group.name, collapsed: group.collapsed, nodeIds: group.nodeIds, color: group.color, slideshow: group.slideshow, slide: group.slide });
// One Y.Map per section, so a move, a resize and a rename by different people all survive.
const sectionFields = section => ({ name: section.name, x: section.x, y: section.y, width: section.width, height: section.height, color: section.color, page: section.page });

// Pairs each next item with its previous version. Lists that kept their order (the usual edit) need no maps.
function changes(before = [], next = []) {
  const removed = [], pairs = [];
  if (before.length === next.length && next.every((item, index) => item.id === before[index].id)) {
    next.forEach((item, index) => { if (item !== before[index]) pairs.push([item, before[index]]); });
    return { removed, pairs };
  }
  const previous = keyed(before), incoming = keyed(next);
  for (const id of previous.keys()) if (!incoming.has(id)) removed.push(id);
  for (const [id, item] of incoming) if (item !== previous.get(id)) pairs.push([item, previous.get(id)]);
  return { removed, pairs };
}

function patchFields(map, next, before) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (same(next[key], before[key])) continue;
    if (next[key] === undefined) map.delete(key);
    else map.set(key, copy(next[key]));
  }
}

function patchMaps(map, next, before, fields, nested = false) {
  // An unchanged object has nothing to write, so only edited items are compared field by field.
  const { removed, pairs } = changes(before, next);
  if (!removed.length && !pairs.length) return;
  for (const id of removed) map.delete(id);
  // Only stamps look up their parent, so the ID maps are built on first use.
  const lazy = items => { let map; return { get: id => (map ||= keyed(items)).get(id) }; };
  const previous = lazy(before), incoming = lazy(next);
  for (const [item, old] of pairs) {
    const id = item.id;
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
  const { removed, pairs } = changes(before, next);
  for (const id of removed) map.delete(id);
  for (const [item, old] of pairs) {
    if (old && !map.has(item.id)) continue;
    if (!old || !same(value(item), value(old))) map.set(item.id, copy(value(item)));
  }
}

// Concurrent page creation can repeat an order; every replica breaks the tie by ID.
const readPages = doc => [...doc.getMap('pages')].filter(([id, page]) => validPageId(id) && typeof page?.name === 'string')
  .sort(([a, left], [b, right]) => (Number.isFinite(left.order) ? left.order : 0) - (Number.isFinite(right.order) ? right.order : 0) || compare(a, b))
  .slice(0, maxPages).map(([id, page]) => ({ id, name: page.name.trim().slice(0, 80).trim() || 'Untitled page' }));
// Raw page IDs are kept, as for nodes: a section whose page was deleted concurrently is shown on the first page.
const readSections = doc => [...doc.getMap('sections')].sort(byKey).flatMap(([id, entry]) => { const section = entry instanceof Y.Map && readSection(id, entry.toJSON()); return section ? [section] : []; }).slice(0, maxSections);
// Raw page IDs are kept; a node whose page was deleted concurrently is shown on the first page.
const pageTest = pages => { const page = pageResolver(boardPages({ pages })); return (a, b) => page(a.page) === page(b.page); };

// Shared document fields only; editor-only fields (selection, measurements) are added by the caller's local copy.
const nodeValue = (id, node) => ({ id, type: node.get('type'), position: { x: node.get('x'), y: node.get('y') }, data: node.get('data').toJSON(),
  ...(node.has('page') ? { page: node.get('page') } : {}),
  // An out-of-range layer from another replica falls back to the default instead of invalidating the board.
  ...(validLayer(node.get('z')) ? { z: node.get('z') } : {}) });

// An attached stamp follows its parent's stored position; a stamp whose parent is gone or elsewhere is shown free.
function stampValue(node, parent, anchor, samePage) {
  if (!canAttachStamp(parent) || !samePage(node, parent)) { const { attachedTo, ...data } = node.data; return { ...node, data }; }
  if (anchor?.nodeId === parent.id && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) return { ...node, position: { x: parent.position.x + anchor.x, y: parent.position.y + anchor.y } };
  return node;
}

function acyclic(entries) {
  const indegree = new Map(), outgoing = new Map();
  for (const [, { source, target }] of entries) {
    if (!outgoing.has(source)) outgoing.set(source, []);
    outgoing.get(source).push(target);
    if (!indegree.has(source)) indegree.set(source, 0);
    indegree.set(target, (indegree.get(target) || 0) + 1);
  }
  const ready = [...indegree].filter(([, count]) => !count).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const id = ready.pop(); visited++;
    for (const target of outgoing.get(id) || []) { const count = indegree.get(target) - 1; indegree.set(target, count); if (!count) ready.push(target); }
  }
  return visited === indegree.size;
}

// Simultaneous, individually valid connections can form a cycle; every replica chooses the same DAG (earlier IDs win).
function acceptedEdges(entries, nodes, samePage) {
  const candidates = entries.filter(([, edge]) => {
    const source = nodes.get(edge.source), target = nodes.get(edge.target);
    return source && target && !isAnnotation(source) && !isAnnotation(target) && (target.type === 'text' || target.data.runId) && samePage(source, target);
  });
  // Without a cycle every candidate survives, which is what the edge-by-edge check below would decide.
  if (acyclic(candidates)) return candidates;
  const outgoing = new Map(), accepted = [];
  for (const entry of candidates) {
    const { source, target } = entry[1], pending = [target], visited = new Set();
    while (pending.length) {
      const node = pending.pop();
      if (visited.has(node)) continue;
      visited.add(node); pending.push(...(outgoing.get(node) || []));
    }
    if (visited.has(source)) continue;
    if (!outgoing.has(source)) outgoing.set(source, []);
    outgoing.get(source).push(target); accepted.push(entry);
  }
  return accepted;
}

const optional = (map, key) => map.has(key) ? { [key]: map.get(key) } : {};
// A node belongs to the first group (by ID) that lists it, and a group never spans pages.
function groupValues(entries, nodes, samePage) {
  const occupied = new Set();
  return entries.map(([id, group]) => {
    const members = (group.get('nodeIds') || []).filter(id => nodes.has(id) && !occupied.has(id));
    const nodeIds = members.filter(id => samePage(nodes.get(id), nodes.get(members[0])));
    nodeIds.forEach(id => occupied.add(id));
    return { id, name: group.get('name'), collapsed: group.get('collapsed'), nodeIds, ...optional(group, 'color'), ...optional(group, 'slideshow'), ...optional(group, 'slide') };
  }).filter(group => group.nodeIds.length);
}

const withLocalNode = (local, value) => { const { page, z, ...rest } = local || {}; return { ...rest, ...value }; };
const withLocalGroup = (local, value) => { const { color, slideshow, slide, ...rest } = local || {}; return { ...rest, ...value }; };
const withLocalSection = (local, value) => { const { color, page, ...rest } = local || {}; return { ...rest, ...value }; };
const withLocalEdge = (local, id, edge) => ({ ...local, id, ...copy(edge) });

export function readCloudGraph(doc, local = {}) {
  const locals = keyed(local.nodes), localGroups = keyed(local.groups), localEdges = keyed(local.edges), localSections = keyed(local.sections), pages = readPages(doc), samePage = pageTest(pages);
  const map = doc.getMap('nodes');
  const merged = [...map].sort(byKey).map(([id, node]) => withLocalNode(locals.get(id), nodeValue(id, node)));
  const byId = keyed(merged);
  const nodes = merged.map(node => node.type !== 'stamp' || node.data.attachedTo === undefined ? node
    : stampValue(node, byId.get(node.data.attachedTo), map.get(node.id).get('stampAttachment'), samePage));
  const edges = acceptedEdges([...doc.getMap('edges')].sort(byKey), byId, samePage).map(([id, edge]) => withLocalEdge(localEdges.get(id), id, edge));
  const groups = groupValues([...doc.getMap('groups')].sort(byKey), byId, samePage).map(group => withLocalGroup(localGroups.get(group.id), group));
  const runs = [...doc.getMap('runs').values()].map(copy).sort(byRun);
  const sections = readSections(doc).map(section => withLocalSection(localSections.get(section.id), section));
  return { nodes, edges, groups, runs, ...(pages.length ? { pages } : {}), ...(sections.length ? { sections } : {}) };
}

// Keys kept in sorted order across reads, so a move never re-sorts and an addition is one binary insert.
class SortedKeys {
  constructor() { this.keys = []; }
  update(added, removed) {
    if (removed.size) this.keys = this.keys.filter(key => !removed.has(key));
    if (added.size > 64 && added.size > this.keys.length / 8) this.keys = [...this.keys, ...added].sort(compare);
    else for (const key of added) {
      let low = 0, high = this.keys.length;
      while (low < high) { const middle = (low + high) >> 1; if (compare(this.keys[middle], key) < 0) low = middle + 1; else high = middle; }
      this.keys.splice(low, 0, key);
    }
  }
}

const sameKeys = (local, value) => Object.keys(value).every(key => key in local);
const sameList = (a, b) => a === b || (a?.length === b?.length && a.every((item, index) => item === b[index]));
// A local object that already shows the stored values is reused, so the editor sees no change.
const showsNode = (local, value) => local.id === value.id && local.type === value.type && local.position?.x === value.position.x && local.position?.y === value.position.y && Object.keys(local.position).length === 2
  && local.page === value.page && ('page' in local) === ('page' in value) && local.z === value.z && ('z' in local) === ('z' in value) && same(local.data, value.data);
const showsGroup = (local, value) => local.name === value.name && local.collapsed === value.collapsed && sameList(local.nodeIds, value.nodeIds)
  && ['color', 'slideshow', 'slide'].every(key => local[key] === value[key] && (key in local) === (key in value)) && sameKeys(local, value);
const showsEdge = (local, edge) => Object.keys(edge).every(key => same(local[key], edge[key]));
const showsSection = (local, value) => local.name === value.name && local.x === value.x && local.y === value.y && local.width === value.width && local.height === value.height
  && local.color === value.color && ('color' in local) === ('color' in value) && local.page === value.page && ('page' in local) === ('page' in value) && sameKeys(local, value);

/**
 * The editor's view of a board, read incrementally. Work per transaction follows what changed, and every node,
 * connection, group, section and run that did not change keeps its object identity, so React and React Flow skip it.
 * read() returns exactly what readCloudGraph() returns for the same document and local state.
 */
export class CloudGraphReader {
  constructor(doc) {
    this.doc = doc; this.values = new Map(); this.anchors = new Map(); this.stamps = new Map(); this.derived = new Map();
    this.nodeOrder = new SortedKeys(); this.edgeOrder = new SortedKeys(); this.edgeIds = new Set(); this.runs = new Map(); this.shown = new WeakMap(); this.clean = new WeakMap();
    this.dirty = new Set(doc.getMap('nodes').keys()); this.edgeKeys = new Set(doc.getMap('edges').keys()); this.runKeys = new Set(doc.getMap('runs').keys());
    this.structural = true; this.groupsChanged = true; this.pagesChanged = true; this.sectionsChanged = true; this.runOrder = []; this.sectionList = []; this.sectionValues = new Map();
    const nodes = doc.getMap('nodes');
    this.observers = [
      [nodes, 'Deep', events => { for (const event of events) { if (event.target === nodes) event.keysChanged.forEach(id => this.dirty.add(id)); else this.dirty.add(event.path[0]); } }],
      [doc.getMap('edges'), '', event => { event.keysChanged.forEach(id => this.edgeKeys.add(id)); }],
      [doc.getMap('groups'), 'Deep', () => { this.groupsChanged = true; }],
      [doc.getMap('runs'), '', event => { event.keysChanged.forEach(id => this.runKeys.add(id)); }],
      [doc.getMap('pages'), '', () => { this.pagesChanged = true; }],
      [doc.getMap('sections'), 'Deep', () => { this.sectionsChanged = true; }],
    ];
    for (const [type, deep, listener] of this.observers) type[`observe${deep}`](listener);
  }
  destroy() { for (const [type, deep, listener] of this.observers) type[`unobserve${deep}`](listener); }
  // IDs of every stamp on the board, for applyLocalGraph's attachment check.
  stampIds() { this.refresh(); return this.stamps.keys(); }

  refresh() {
    if (this.pagesChanged) { this.pages = readPages(this.doc); this.samePage = pageTest(this.pages); this.pagesChanged = false; this.structural = true; this.derived.clear(); }
    if (this.dirty.size) {
      const map = this.doc.getMap('nodes'), added = new Set(), removed = new Set();
      for (const id of this.dirty) {
        const node = map.get(id), old = this.values.get(id);
        if (!node) {
          if (old) { this.values.delete(id); this.anchors.delete(id); this.stamps.delete(id); removed.add(id); this.structural = true; }
          continue;
        }
        const value = nodeValue(id, node);
        if (!old) { added.add(id); this.structural = true; }
        else if (old.type !== value.type || old.page !== value.page || old.data.runId !== value.data.runId) this.structural = true;
        this.values.set(id, value); this.anchors.set(id, node.get('stampAttachment'));
        if (value.type === 'stamp') this.stamps.set(id, value); else this.stamps.delete(id);
      }
      this.dirty.clear(); this.nodeOrder.update(added, removed);
    }
    if (this.edgeKeys.size) {
      const map = this.doc.getMap('edges'), added = new Set(), removed = new Set();
      for (const id of this.edgeKeys) {
        const known = this.edgeIds.has(id), present = map.has(id);
        if (present && !known) { added.add(id); this.edgeIds.add(id); } else if (!present && known) { removed.add(id); this.edgeIds.delete(id); }
      }
      this.edgeOrder.update(added, removed); this.edgeKeys.clear(); this.edgesChanged = true;
    }
    if (this.runKeys.size) {
      const map = this.doc.getMap('runs');
      for (const id of this.runKeys) {
        const raw = map.get(id), cached = this.runs.get(id);
        if (raw === undefined) { if (this.runs.delete(id)) this.runsChanged = this.runsResort = true; continue; }
        if (cached?.raw === raw) continue;
        const run = copy(raw);
        if (!cached || cached.run.startedAt !== run.startedAt) this.runsResort = true;
        this.runs.set(id, { raw, run }); this.runsChanged = true;
      }
      this.runKeys.clear();
    }
  }

  // A stamp's shown value depends on its parent; it is rebuilt only when either of them changed.
  node(id) {
    const value = this.values.get(id);
    if (value.type !== 'stamp' || value.data.attachedTo === undefined) return value;
    const parent = this.values.get(value.data.attachedTo), anchor = this.anchors.get(id), cached = this.derived.get(id);
    if (cached?.value === value && cached.parent === parent && cached.anchor === anchor) return cached.shown;
    const shown = stampValue(value, parent, anchor, this.samePage);
    this.derived.set(id, { value, parent, anchor, shown });
    return shown;
  }

  read(local) {
    this.refresh();
    const withLocal = local !== undefined;
    // The caller's lists usually match the stored order item for item; the ID map is only built when they do not.
    const finder = (list = []) => { let byId; return (id, index) => list[index]?.id === id ? list[index] : (byId ||= keyed(list)).get(id); };
    const localNode = finder(local?.nodes), localEdge = finder(local?.edges), localGroup = finder(local?.groups), localSection = finder(local?.sections);
    const nodes = this.nodeOrder.keys.map((id, index) => {
      const value = this.node(id);
      if (!withLocal) return value;
      const current = localNode(id, index);
      if (current && this.shown.get(current) === value) return current;
      if (current && showsNode(current, value)) { this.shown.set(current, value); return current; }
      const merged = withLocalNode(current, value);
      this.shown.set(merged, value);
      return merged;
    });
    if (this.structural || this.edgesChanged) {
      const map = this.doc.getMap('edges');
      this.accepted = acceptedEdges(this.edgeOrder.keys.map(id => [id, map.get(id)]), this.values, this.samePage);
      this.edgesChanged = false;
    }
    if (this.structural || this.groupsChanged) {
      this.groupList = groupValues([...this.doc.getMap('groups')].sort(byKey), this.values, this.samePage);
      this.groupsChanged = false;
    }
    this.structural = false;
    const edges = this.accepted.map(([id, edge], index) => {
      if (!withLocal) { if (!this.clean.has(edge)) this.clean.set(edge, withLocalEdge(undefined, id, edge)); return this.clean.get(edge); }
      const current = localEdge(id, index);
      if (current && (this.shown.get(current) === edge || showsEdge(current, edge))) { this.shown.set(current, edge); return current; }
      const shown = withLocalEdge(current, id, edge);
      this.shown.set(shown, edge);
      return shown;
    });
    const groups = this.groupList.map((group, index) => {
      if (!withLocal) return group;
      const current = localGroup(group.id, index);
      if (current && (this.shown.get(current) === group || showsGroup(current, group))) { this.shown.set(current, group); return current; }
      const shown = withLocalGroup(current, group);
      this.shown.set(shown, group);
      return shown;
    });
    if (this.runsResort) { this.runOrder = [...this.runs.values()].map(({ run }) => run).sort(byRun); this.runsResort = false; this.runsChanged = false; }
    else if (this.runsChanged) { this.runOrder = this.runOrder.map(run => this.runs.get(run.id).run); this.runsChanged = false; }
    // Sections depend on nothing else in the document, so only their own changes re-read them.
    if (this.sectionsChanged) {
      const previous = this.sectionValues;
      this.sectionValues = new Map();
      this.sectionList = readSections(this.doc).map(section => { const old = previous.get(section.id), kept = old && same(old, section) ? old : section; this.sectionValues.set(section.id, kept); return kept; });
      this.sectionsChanged = false;
    }
    const sections = this.sectionList.map((section, index) => {
      if (!withLocal) return section;
      const current = localSection(section.id, index);
      if (current && (this.shown.get(current) === section || showsSection(current, section))) { this.shown.set(current, section); return current; }
      const shown = withLocalSection(current, section);
      this.shown.set(shown, section);
      return shown;
    });
    // Unchanged lists are returned as the caller's own arrays, so state setters can skip them.
    const own = (list, mine) => withLocal && mine && sameList(list, mine) ? mine : list;
    return { nodes: own(nodes, local?.nodes), edges: own(edges, local?.edges), groups: own(groups, local?.groups), runs: this.runOrder, ...(this.pages.length ? { pages: this.pages } : {}),
      ...(sections.length ? { sections: own(sections, local?.sections) } : {}) };
  }
}

// Diff against the caller's snapshot, not today's document: untouched remote fields stay untouched.
export function applyLocalGraph(doc, graph, previous, origin, stampIds) {
  const nodes = reconcileStampAttachments(previous.nodes || [], graph.nodes);
  const ids = new Set(nodes.map(node => node.id)), stored = doc.getMap('pages'), previousPages = previous.pages ?? defaultPages();
  // The implicit first page becomes explicit outside undo history, so a concurrent writer's undo cannot remove it.
  if (graph.pages !== undefined && !stored.size) doc.transact(() => defaultPages().forEach((page, order) => stored.set(page.id, { name: page.name, order })), { pages: 'default' });
  doc.transact(() => {
    // Relative anchors preserve concurrent parent moves and direct stamp edits.
    const map = doc.getMap('nodes');
    for (const node of stampIds ? [...stampIds].map(id => map.get(id)) : map.values()) {
      const data = node instanceof Y.Map && node.get('data');
      if (!(data instanceof Y.Map) || node.get('type') !== 'stamp' || data.get('attachedTo') === undefined) continue;
      const parent = map.get(data.get('attachedTo'));
      if (!(parent instanceof Y.Map) || !canAttachStamp({ type: parent.get('type') })) { data.delete('attachedTo'); node.delete('stampAttachment'); }
    }
    patchMaps(map, nodes, previous.nodes, nodeFields, true);
    patchValues(doc.getMap('edges'), graph.edges, previous.edges, edge => ({ source: edge.source, target: edge.target }));
    patchMaps(doc.getMap('groups'), (graph.groups || []).map(group => group.nodeIds.every(id => ids.has(id)) ? group : { ...group, nodeIds: group.nodeIds.filter(id => ids.has(id)) }).filter(group => group.nodeIds.length), previous.groups, groupFields);
    // A caller that leaves sections out keeps them as they are.
    patchMaps(doc.getMap('sections'), graph.sections ?? previous.sections ?? [], previous.sections ?? [], sectionFields);
    patchValues(doc.getMap('runs'), graph.runs, previous.runs, run => run);
    // New pages sort after every page this replica has seen; existing pages keep their order.
    const order = new Map([...stored].map(([id, page]) => [id, page?.order]));
    let last = Math.max(-1, ...[...order.values()].filter(Number.isFinite));
    const ordered = pages => pages.map(page => ({ ...page, order: Number.isFinite(order.get(page.id)) ? order.get(page.id) : order.set(page.id, ++last).get(page.id) }));
    if (graph.pages !== undefined) patchValues(stored, ordered(graph.pages), ordered(previousPages), page => ({ name: page.name, order: page.order }));
  }, origin);
}
