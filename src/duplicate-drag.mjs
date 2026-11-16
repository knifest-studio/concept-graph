import { duplicateNodes } from '../graph.mjs';
import { captureSections } from './canvas.mjs';

// Alt (Option on a Mac) held while dragging leaves the original where it is and drags a copy, as in Figma and Miro.
// AltGr reaches the page as Ctrl+Alt on Windows and types characters on many layouts, so it is not the gesture.
export const duplicateGesture = event => !!event?.altKey && !event.ctrlKey;

/**
 * Copies of what a drag picked up, lying exactly over their originals. `dragged` are canvas IDs: cards, group frames
 * (the group with all its members) and sections, which take along what they held when the drag began (`captures`, as
 * captureSections gives them; taken from `page` when missing), groups held by a section included. A member dragged
 * without its frame comes out loose, as Cmd+D leaves it. Connections follow Cmd+D (duplicateNodes): inputs stay, links
 * between copies are remapped and outgoing links are not copied; images keep their stored files.
 * The selection moves to the copies, and selected connections give theirs up as Cmd+D makes them (a box selection
 * takes every connection of its cards along). Returns `map` (original ID → copy ID, for cards, groups and sections), the
 * new `nodes`, `edges`, `groups` and `sections`, the `selected` originals, the `selectedEdges` and `captures` keyed by
 * copied section: what each copy takes along, copies only, so a copy lying over its original never picks the original up.
 */
export function planDragDuplicate(board, dragged, { page = board, measure, captures = new Map(), makeId = () => crypto.randomUUID() } = {}) {
  const nodes = new Map(board.nodes.map(node => [node.id, node])), groups = board.groups || [], sections = board.sections || [];
  const groupById = new Map(groups.map(group => [group.id, group])), sectionById = new Map(sections.map(section => [section.id, section]));
  const nodeIds = new Set(), groupIds = new Set(), sectionIds = new Set(), held = new Map(), inSections = new Set();
  for (const id of dragged) {
    if (nodes.has(id)) nodeIds.add(id);
    else if (groupById.has(id)) groupIds.add(id);
    else if (sectionById.has(id) && !held.has(id)) held.set(id, captures.get(id) || captureSections(page, new Set([id]), measure));
  }
  for (const capture of held.values()) {
    for (const id of capture.nodes.keys()) if (nodes.has(id)) inSections.add(id);
    for (const id of capture.sections.keys()) if (sectionById.has(id)) sectionIds.add(id);
  }
  // A section holds a group only whole (sectionContents), so a group whose members it took along is copied as a group.
  for (const group of groups) { const members = group.nodeIds.filter(id => nodes.has(id)); if (members.length && members.every(id => inSections.has(id))) groupIds.add(group.id); }
  for (const id of groupIds) for (const member of groupById.get(id).nodeIds) if (nodes.has(member)) nodeIds.add(member);
  for (const id of inSections) nodeIds.add(id);
  const order = [...nodeIds], ids = new Map(order.map(id => [id, makeId()])), map = new Map(ids), selected = new Set();
  const copied = order.length ? duplicateNodes({ nodes: board.nodes, edges: board.edges, groups: board.groups, pages: board.pages }, order, { offset: { x: 0, y: 0 }, ids }) : { nodes: [], edges: [] };
  // A copy keeps its original's measured size, so it does not jump while React Flow measures it.
  const copies = copied.nodes.map((copy, index) => {
    const source = nodes.get(order[index]), measured = source.measured || measure?.(source);
    if (source.selected) selected.add(source.id);
    return { ...copy, ...(measured ? { measured } : {}), selected: !!source.selected };
  });
  const groupCopies = [...groupIds].map(id => {
    const group = groupById.get(id), copy = { ...structuredClone(group), id: makeId(), nodeIds: group.nodeIds.filter(member => ids.has(member)).map(member => ids.get(member)), selected: !!group.selected };
    if (group.slide !== undefined) { if (ids.has(group.slide)) copy.slide = ids.get(group.slide); else delete copy.slide; }
    if (group.selected) selected.add(id);
    map.set(id, copy.id);
    return copy;
  });
  const sectionCopies = sections.filter(section => sectionIds.has(section.id)).map(section => {
    const copy = { ...section, id: makeId(), selected: !!section.selected };
    if (section.selected) selected.add(section.id);
    map.set(section.id, copy.id);
    return copy;
  });
  const copiedCaptures = new Map([...held].map(([id, capture]) => [map.get(id), {
    nodes: new Map([...capture.nodes].filter(([nodeId]) => ids.has(nodeId)).map(([nodeId, position]) => [ids.get(nodeId), position])),
    sections: new Map([...capture.sections].filter(([sectionId]) => map.has(sectionId)).map(([sectionId, position]) => [map.get(sectionId), position])),
  }]));
  const selectedEdges = new Set((board.edges || []).filter(edge => edge.selected).map(edge => edge.id));
  return { map, nodes: copies, edges: copied.edges, groups: groupCopies, sections: sectionCopies, selected, selectedEdges, captures: copiedCaptures };
}

// While the copies exist the originals named in `ids` (plan.selected, plan.selectedEdges) are deselected; when the copies
// go (Alt released, Escape) they are selected again.
export const handOverSelection = (items, ids) => items.some(item => item.selected && ids.has(item.id)) ? items.map(item => item.selected && ids.has(item.id) ? { ...item, selected: false } : item) : items;
export const handBackSelection = (items, ids) => items.map(item => !item.selected && ids.has(item.id) ? { ...item, selected: true } : item);

// React Flow keeps moving the originals it picked up when the drag began; while copies exist, those moves go to them.
export function retargetDrag(changes, map) {
  if (!map?.size || !changes.some(change => change.type === 'position' && map.has(change.id))) return changes;
  return changes.map(change => change.type === 'position' && map.has(change.id) ? { ...change, id: map.get(change.id) } : change);
}

// After Escape the rest of the drag moves nothing.
export function dropDrag(changes, ids) {
  return changes.some(change => change.type === 'position' && ids.has(change.id)) ? changes.filter(change => change.type !== 'position' || !ids.has(change.id)) : changes;
}

// Moves the board makes itself, as a drag would: they send originals home or to where their copies were.
export const positionChanges = positions => [...positions].map(([id, position]) => ({ id, type: 'position', position, dragging: true }));
