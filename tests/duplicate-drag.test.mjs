import test from 'node:test';
import assert from 'node:assert/strict';
import { duplicateGesture, dropDrag, handBackSelection, handOverSelection, planDragDuplicate, positionChanges, retargetDrag } from '../src/duplicate-drag.mjs';
import { captureSections, moveCaptured, moveGroup } from '../src/canvas.mjs';
import { validateGraph } from '../graph.mjs';

const asset = '12345678-1234-1234-1234-123456789abc.png', createdAt = '2020-01-01T00:00:00.000Z';
const prompt = (id, position = { x: 0, y: 0 }, extra = {}) => ({ id, type: 'text', position, data: { text: id, createdAt }, ...extra });
const image = (id, position = { x: 0, y: 0 }, extra = {}) => ({ id, type: 'image', position, data: { asset, runId: 'run', createdAt }, ...extra });
const counter = () => { let next = 0; return () => `copy-${++next}`; };

test('Alt or Option duplicates a drag; AltGr (Ctrl+Alt) and plain drags do not', () => {
  assert.equal(duplicateGesture({ altKey: true }), true);
  assert.equal(duplicateGesture({ altKey: true, metaKey: true, shiftKey: true }), true);
  assert.equal(duplicateGesture({ altKey: true, ctrlKey: true }), false);
  assert.equal(duplicateGesture({ ctrlKey: true }), false);
  assert.equal(duplicateGesture({}), false);
  assert.equal(duplicateGesture(undefined), false);
});

test('a dragged card is copied over itself with its inputs, its file and its size, and the original is left alone', () => {
  const board = { nodes: [prompt('parent', { x: -400, y: 0 }), image('image', { x: 10, y: 20 }, { selected: true, measured: { width: 310, height: 200 } }), prompt('child', { x: 400, y: 0 })],
    edges: [{ id: 'provenance', source: 'parent', target: 'image' }, { id: 'out', source: 'image', target: 'child' }], groups: [], sections: [] };
  const before = structuredClone(board), plan = planDragDuplicate(board, ['image'], { makeId: counter() });
  assert.deepEqual([...plan.map], [['image', 'copy-1']]);
  const [copy] = plan.nodes;
  assert.equal(copy.id, 'copy-1'); assert.deepEqual(copy.position, { x: 10, y: 20 });
  assert.equal(copy.data.asset, asset); assert.deepEqual(copy.measured, { width: 310, height: 200 }); assert.equal(copy.selected, true);
  assert.ok(copy.data.createdAt > createdAt);
  // The input (here the prompt that generated it) is kept; the outgoing link is not copied.
  assert.deepEqual(plan.edges.map(({ source, target }) => ({ source, target })), [{ source: 'parent', target: 'copy-1' }]);
  assert.deepEqual([...plan.selected], ['image']);
  assert.deepEqual(board, before);
  assert.doesNotThrow(() => validateGraph({ nodes: [...board.nodes, ...plan.nodes], edges: [...board.edges, ...plan.edges] }));
  // Links between dragged cards are remapped to the copies.
  const pair = planDragDuplicate({ ...board, nodes: board.nodes.map(node => ({ ...node, selected: true })) }, ['parent', 'image'], { makeId: counter() });
  assert.deepEqual(pair.edges.map(({ source, target }) => ({ source, target })), [{ source: 'copy-1', target: 'copy-2' }]);
  assert.deepEqual(planDragDuplicate(board, ['pending-run:0', 'missing'], { makeId: counter() }), { map: new Map(), nodes: [], edges: [], groups: [], sections: [], selected: new Set(), selectedEdges: new Set(), captures: new Map() });
});

test('the copies take the selection over, connections included, and give it back when withdrawn', () => {
  // A box selection of A and B also selects every connection of theirs, X→A and A→B.
  const edges = [{ id: 'xa', source: 'x', target: 'a', selected: true }, { id: 'ab', source: 'a', target: 'b', selected: true }, { id: 'yz', source: 'y', target: 'z' }];
  const board = { nodes: [prompt('x'), prompt('a', { x: 0, y: 0 }, { selected: true }), prompt('b', { x: 300, y: 0 }, { selected: true }), prompt('y'), prompt('z')], edges, groups: [], sections: [] };
  const plan = planDragDuplicate(board, ['a'], { makeId: counter() });
  assert.deepEqual([...plan.selectedEdges], ['xa', 'ab']);
  assert.ok(plan.edges.every(edge => !edge.selected));
  // While the copy exists nothing of the originals stays selected, so Delete removes only the copy, as after Cmd+D.
  const during = [...handOverSelection(edges, plan.selectedEdges), ...plan.edges];
  assert.deepEqual(during.filter(edge => edge.selected), []);
  assert.deepEqual(during.slice(0, 3).map(({ id, source, target }) => ({ id, source, target })), edges.map(({ id, source, target }) => ({ id, source, target })));
  // Alt released or Escape: the copy's edges go and the originals' connections are selected again.
  const copyIds = new Set(plan.edges.map(edge => edge.id));
  assert.deepEqual(handBackSelection(during.filter(edge => !copyIds.has(edge.id)), plan.selectedEdges), edges);
  // Nothing to hand over leaves the list as it was.
  const plain = edges.map(({ selected, ...edge }) => edge);
  assert.equal(handOverSelection(plain, plan.selectedEdges), plain);
});

test('a dragged group frame copies the group with its name, members and slide; a member dragged alone comes out loose', () => {
  const group = { id: 'group', name: 'Moodboard', nodeIds: ['a', 'b'], collapsed: false, slideshow: true, slide: 'b', selected: true };
  const board = { nodes: [image('a'), image('b', { x: 320, y: 0 }), prompt('outside', { x: 900, y: 0 })], edges: [{ id: 'link', source: 'a', target: 'outside' }], groups: [group], sections: [] };
  const before = structuredClone(board), plan = planDragDuplicate(board, ['group'], { makeId: counter() });
  assert.equal(plan.nodes.length, 2);
  const [copy] = plan.groups, ids = plan.nodes.map(node => node.id);
  assert.deepEqual(copy, { id: plan.map.get('group'), name: 'Moodboard', nodeIds: ids, collapsed: false, slideshow: true, slide: plan.map.get('b'), selected: true });
  assert.ok(plan.nodes.every(node => !node.selected));
  assert.deepEqual([...plan.selected], ['group']);
  assert.deepEqual(plan.edges, []);
  assert.deepEqual(board, before);
  assert.doesNotThrow(() => validateGraph({ nodes: [...board.nodes, ...plan.nodes], edges: board.edges, groups: [...board.groups, ...plan.groups] }));
  // The copy moves as its own group: the drag's moves of the frame reach the copy, and the original stays.
  const moved = moveGroup([...board.nodes, ...plan.nodes], copy, { x: 1000, y: 500 }, false), [a, b] = moved.slice(3);
  assert.deepEqual(moved.slice(0, 3), board.nodes);
  assert.ok(a.position.x > 900 && a.position.y > 400); assert.deepEqual({ x: b.position.x - a.position.x, y: b.position.y - a.position.y }, { x: 320, y: 0 });
  const loose = planDragDuplicate(board, ['a'], { makeId: counter() });
  assert.deepEqual(loose.groups, []); assert.equal(loose.nodes.length, 1);
  // A group and one of its members picked up together are copied once.
  const both = planDragDuplicate(board, ['group', 'a', 'a'], { makeId: counter() });
  assert.equal(both.nodes.length, 2); assert.equal(both.groups.length, 1);
});

test('a section copy takes along copies only, even lying exactly over the original it was copied from', () => {
  const sections = [{ id: 'outer', name: 'Ideas', x: 0, y: 0, width: 800, height: 600, selected: true }, { id: 'inner', name: 'Detail', x: 400, y: 300, width: 300, height: 200 }];
  const group = { id: 'group', name: 'Pair', nodeIds: ['g1', 'g2'], collapsed: false };
  const nodes = [prompt('loose', { x: 40, y: 60 }), prompt('nested', { x: 450, y: 350 }), image('g1', { x: 100, y: 300 }), image('g2', { x: 200, y: 300 }), prompt('far', { x: 2000, y: 0 }),
    { id: 'stamp', type: 'stamp', position: { x: 50, y: 50 }, data: { kind: 'heart', attachedTo: 'loose' } }];
  const board = { nodes, edges: [], groups: [group], sections }, size = () => ({ width: 100, height: 60 });
  const plan = planDragDuplicate(board, ['outer'], { measure: size, makeId: counter() }), copyOf = id => plan.map.get(id);
  assert.deepEqual(plan.nodes.map(node => node.id).sort(), ['loose', 'nested', 'g1', 'g2', 'stamp'].map(copyOf).sort());
  assert.deepEqual(plan.sections.map(section => [section.name, section.x, section.y, section.selected]), [['Ideas', 0, 0, true], ['Detail', 400, 300, false]]);
  assert.equal(plan.groups.length, 1); assert.deepEqual(plan.groups[0].nodeIds, ['g1', 'g2'].map(copyOf));
  assert.equal(plan.nodes.find(node => node.type === 'stamp').data.attachedTo, copyOf('loose'));
  const capture = plan.captures.get(copyOf('outer'));
  assert.deepEqual([...capture.nodes.keys()].sort(), ['loose', 'nested', 'g1', 'g2', 'stamp'].map(copyOf).sort());
  assert.deepEqual([...capture.sections.keys()], ['outer', 'inner'].map(copyOf));
  assert.deepEqual(capture.sections.get(copyOf('outer')), { x: 0, y: 0 });
  // The drag's moves of the original section reach the copy, which takes its copies along and leaves the originals.
  const after = moveCaptured({ nodes: [...nodes, ...plan.nodes], sections: [...sections, ...plan.sections] }, capture, { x: 1000, y: 0 });
  assert.deepEqual(after.nodes.slice(0, nodes.length), nodes);
  assert.deepEqual(after.sections.slice(0, 2), sections);
  assert.ok(after.nodes.slice(nodes.length).every((node, index) => node.position.x === plan.nodes[index].position.x + 1000));
  // Mid-drag the section has passed over a card; what it held when the drag began is what is copied.
  const start = captureSections(board, new Set(['outer']), size);
  const passed = { ...board, nodes: [...nodes.map(node => ({ ...node, position: { x: node.position.x + 2000, y: node.position.y } })), prompt('passed', { x: 2100, y: 100 })],
    sections: sections.map(section => ({ ...section, x: section.x + 2000 })) };
  const midDrag = planDragDuplicate(passed, ['outer'], { measure: size, captures: new Map([['outer', start]]), makeId: counter() });
  assert.ok(!midDrag.map.has('passed') && !midDrag.map.has('far'));
  assert.deepEqual(midDrag.captures.get(midDrag.map.get('outer')).nodes.get(midDrag.map.get('loose')), { x: 40, y: 60 });
  // The section and a card inside it picked up together are copied once.
  assert.equal(planDragDuplicate(board, ['outer', 'loose'], { measure: size, makeId: counter() }).nodes.length, 5);
});

test('stamps and arrows hold on to copied cards only', () => {
  const box = { id: 'box', type: 'shape', position: { x: 0, y: 0 }, data: { shape: 'rectangle', width: 200, height: 100, color: '#ffffff' } };
  const ring = { id: 'ring', type: 'shape', position: { x: 400, y: 0 }, data: { shape: 'ellipse', width: 100, height: 100, color: '#dceaff' } };
  const arrow = { id: 'arrow', type: 'arrow', position: { x: 184, y: 34 }, data: { from: { x: 200, y: 50, node: 'box' }, to: { x: 400, y: 50, node: 'ring' }, color: '#6b6e89' } };
  const stamp = { id: 'stamp', type: 'stamp', position: { x: 10, y: 10 }, data: { kind: 'heart', attachedTo: 'box' } };
  const board = { nodes: [box, ring, arrow, stamp], edges: [], groups: [], sections: [] };
  const all = planDragDuplicate(board, ['box', 'ring', 'arrow', 'stamp'], { makeId: counter() }), copy = id => all.nodes.find(node => node.id === all.map.get(id));
  assert.equal(copy('stamp').data.attachedTo, all.map.get('box'));
  assert.deepEqual([copy('arrow').data.from.node, copy('arrow').data.to.node], [all.map.get('box'), all.map.get('ring')]);
  const alone = planDragDuplicate(board, ['stamp', 'arrow'], { makeId: counter() });
  assert.ok(alone.nodes.every(node => node.data.attachedTo === undefined && node.data.from?.node === undefined && node.data.to?.node === undefined));
  assert.deepEqual(alone.nodes.find(node => node.type === 'arrow').data.from, { x: 200, y: 50 });
});

test('only position changes of picked-up originals are sent to their copies', () => {
  const map = new Map([['a', 'copy-a'], ['group', 'copy-group']]);
  const changes = [{ id: 'a', type: 'position', position: { x: 1, y: 2 }, dragging: true }, { id: 'a', type: 'select', selected: true }, { id: 'a', type: 'dimensions', dimensions: { width: 1, height: 1 } },
    { id: 'group', type: 'position', position: { x: 3, y: 4 }, dragging: false }, { id: 'other', type: 'position', position: { x: 5, y: 6 }, dragging: true }];
  const retargeted = retargetDrag(changes, map);
  assert.deepEqual(retargeted, [{ ...changes[0], id: 'copy-a' }, changes[1], changes[2], { ...changes[3], id: 'copy-group' }, changes[4]]);
  assert.deepEqual(changes[0].id, 'a');
  const untouched = [changes[1], changes[4]];
  assert.equal(retargetDrag(untouched, map), untouched);
  assert.equal(retargetDrag(changes, new Map()), changes);
  assert.deepEqual(dropDrag(changes, new Set(['a', 'group'])), [changes[1], changes[2], changes[4]]);
  assert.equal(dropDrag(untouched, new Set(['a'])), untouched);
  assert.deepEqual(positionChanges(new Map([['a', { x: 1, y: 2 }]])), [{ id: 'a', type: 'position', position: { x: 1, y: 2 }, dragging: true }]);
});
