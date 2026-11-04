import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { commitGraph, validateGraph } from '../graph.mjs';
import { canvasView, captureSections, createViewCache, moveCaptured, sectionContents, visibleTitles, wrapBounds } from '../src/canvas.mjs';
import { reconcileStampAttachments } from '../src/annotations.mjs';
import { CloudGraphReader, applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { cloneSelection, readNodeClipboard, selectedGraph } from '../src/clipboard.mjs';
import { captureHistory, historySignature, snapshotSignature } from '../src/history.mjs';
import { pageContent } from '../src/pages.mjs';
import { cleanSections, maxSections, mergeSections, nextSectionName, readSection } from '../src/sections.mjs';

const text = (id, x, y, width = 300, height = 100, extra = {}) => ({ id, type: 'text', position: { x, y }, data: { text: id }, measured: { width, height }, ...extra });
const stamp = (id, x, y, attachedTo) => ({ id, type: 'stamp', position: { x, y }, data: { kind: 'like', ...(attachedTo ? { attachedTo } : {}) } });
const section = (id, x, y, width, height, extra = {}) => ({ id, name: `Section ${id}`, x, y, width, height, ...extra });
const ids = set => [...set].sort();

// One page: section S holds a, wide (centre inside, edge outside), group g (frame centre inside, one member outside),
// nested section T with t1 sticking out of S, stamps st1 (follows a) and st3 (free); out, st2 (attached to out) and
// group h (frame centre outside) stay out.
function board() {
  const nodes = [text('a', 100, 100), text('wide', 800, 100), text('out', 900, 200), text('m1', 50, 230), text('m2', 1100, 230),
    text('h1', 600, 50), text('h2', 1900, 50), text('t1', 1000, 400, 150, 80), stamp('st1', -100, -100, 'a'), stamp('st2', 500, 500, 'out'), stamp('st3', 300, 250),
    { id: 'sticky', type: 'sticky', position: { x: 700, y: -150 }, data: { text: '', color: '#fff3ad' } }];
  const groups = [{ id: 'g', name: 'G', nodeIds: ['m1', 'm2'], collapsed: false }, { id: 'h', name: 'H', nodeIds: ['h1', 'h2'], collapsed: false }];
  return { nodes, edges: [], groups, sections: [section('S', 0, 0, 1000, 600), section('T', 600, 350, 600, 200)] };
}

test('sections validate their rectangle, name, colour, page and IDs unique across the canvas', () => {
  const graph = board();
  assert.doesNotThrow(() => validateGraph(graph));
  assert.doesNotThrow(() => validateGraph({ ...graph, sections: [section('S', -5.5, 3, 200, 120, { color: '#E9E2FF', page: 'p2', selected: true })] }));
  const invalid = [{ id: 'a' }, { id: 'g' }, { id: '' }, { id: 'x'.repeat(121) }, { name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 3 },
    { x: NaN }, { y: Infinity }, { x: '1' }, { width: 199 }, { height: 119 }, { width: 2e6 }, { color: 'red' }, { color: '#abc' }, { page: '' }, { page: 'x'.repeat(121) }];
  for (const patch of invalid) assert.throws(() => validateGraph({ ...graph, sections: [{ ...section('S', 0, 0, 400, 300), ...patch }] }), /section/i, JSON.stringify(patch));
  assert.throws(() => validateGraph({ ...graph, sections: [section('S', 0, 0, 400, 300), section('S', 10, 10, 400, 300)] }), /section/i);
  assert.throws(() => validateGraph({ ...graph, sections: {} }), /sections/i);
  assert.throws(() => validateGraph({ nodes: [], edges: [], sections: Array.from({ length: maxSections + 1 }, (_, index) => section(`s${index}`, 0, 0, 400, 300)) }), /sections/i);
  assert.equal(nextSectionName([{ name: 'Section 1' }, { name: 'Section 3' }]), 'Section 2');
  assert.deepEqual(cleanSections([{ ...section('S', 1, 2, 300, 200, { color: '#dceaff' }), selected: true, measured: {} }]), [section('S', 1, 2, 300, 200, { color: '#dceaff' })]);
});

test('a section holds what its centre rule says: nodes by centre, groups by frame centre, nested sections, stamps with their node', () => {
  const page = board(), held = sectionContents(page, new Set(['S']));
  assert.deepEqual(ids(held.sectionIds), ['S', 'T']);
  assert.deepEqual(ids(held.nodeIds), ['a', 'm1', 'm2', 'st1', 'st3', 't1', 'wide']);
  // The nested section takes only its own contents, and never the larger section around it.
  assert.deepEqual(ids(sectionContents(page, new Set(['T'])).nodeIds), ['t1']);
  // Identical sections nest one way only (by ID), so neither move can loop.
  const twins = { nodes: [text('q', 3100, 100, 100, 50)], groups: [], sections: [section('b-twin', 3000, 0, 400, 300), section('a-twin', 3000, 0, 400, 300)] };
  assert.deepEqual(ids(sectionContents(twins, new Set(['a-twin'])).sectionIds), ['a-twin', 'b-twin']);
  assert.deepEqual(ids(sectionContents(twins, new Set(['b-twin'])).sectionIds), ['b-twin']);
  // A folded group is judged by its 240 × 72 card at the frame's corner.
  const folded = { nodes: [text('c1', 5000, 1000), text('c2', 6000, 1000)], groups: [{ id: 'c', name: 'C', nodeIds: ['c1', 'c2'], collapsed: true }],
    sections: [section('U', 4900, 900, 400, 200), section('V', 5900, 900, 500, 300)] };
  assert.deepEqual(ids(sectionContents(folded, new Set(['U'])).nodeIds), ['c1', 'c2']);
  assert.deepEqual(ids(sectionContents(folded, new Set(['V'])).nodeIds), []);
});

test('moving a section takes what it held at the start, nested sections and attached stamps included', () => {
  const page = board(), capture = captureSections(page, new Set(['S']));
  let moved = moveCaptured({ nodes: page.nodes, sections: page.sections }, capture, { x: 100, y: 50 });
  const at = id => moved.nodes.find(node => node.id === id).position;
  assert.deepEqual(at('a'), { x: 200, y: 150 }); assert.deepEqual(at('m2'), { x: 1200, y: 280 }); assert.deepEqual(at('t1'), { x: 1100, y: 450 });
  assert.deepEqual(at('st1'), { x: 0, y: -50 }); assert.deepEqual(at('st3'), { x: 400, y: 300 });
  assert.deepEqual(moved.sections.map(({ id, x, y }) => [id, x, y]), [['S', 100, 50], ['T', 700, 400]]);
  for (const id of ['out', 'st2', 'h1', 'h2', 'sticky']) assert.equal(moved.nodes.find(node => node.id === id), page.nodes.find(node => node.id === id), id);
  // The attachment pass that follows every editor move does not shift an already moved stamp again.
  assert.deepEqual(reconcileStampAttachments(page.nodes, moved.nodes).find(node => node.id === 'st1').position, { x: 0, y: -50 });
  // Later in the same drag the section passes over another node; it is not picked up.
  const far = text('far', 2300, 200), start = [...page.nodes, far];
  moved = moveCaptured({ nodes: start, sections: page.sections }, capture, { x: 2000, y: 0 });
  assert.equal(moved.nodes.find(node => node.id === 'far'), far);
  assert.deepEqual(moved.nodes.find(node => node.id === 'a').position, { x: 2100, y: 100 });
  // Arriving exactly where it already is changes nothing, so React keeps the same objects.
  const again = moveCaptured(moved, capture, { x: 2000, y: 0 });
  assert.ok(again.nodes.every((node, index) => node === moved.nodes[index])); assert.ok(again.sections.every((item, index) => item === moved.sections[index]));
});

test('Delete takes a section with its contents and nested sections; Remove section keeps them', () => {
  const page = board(), held = sectionContents(page, new Set(['S']));
  const removed = new Set([...held.nodeIds, ...held.sectionIds]);
  const after = reconcileStampAttachments(page.nodes, page.nodes.filter(node => !removed.has(node.id)));
  assert.deepEqual(after.map(node => node.id).sort(), ['h1', 'h2', 'out', 'st2', 'sticky']);
  assert.deepEqual(page.sections.filter(item => !removed.has(item.id)), []);
  // Remove section deletes only that frame: what it held, and the section nested in it, stay where they are.
  assert.deepEqual(page.sections.filter(item => item.id !== 'S').map(item => item.id), ['T']);
});

test('wrapping a selection frames it with room for the title and always holds what was wrapped', () => {
  const image = { id: 'img', type: 'image', position: { x: 0, y: 400 }, data: { asset: '11111111-1111-1111-1111-111111111111.png', caption: 'Hello' }, measured: { width: 310, height: 310 } };
  const page = { nodes: [text('p1', 0, 0), text('p2', 500, 200), text('p3', 900, 200), image, stamp('mark', 330, 500, 'img'), stamp('lone', 4000, 0)], groups: [{ id: 'G', name: 'G', nodeIds: ['p2', 'p3'], collapsed: false }], sections: [] };
  // The caption sits above the image; the stamp on it is framed too.
  assert.deepEqual(wrapBounds(page, new Set(['p1', 'img'])), { x: -40, y: -72, width: 458, height: 822 });
  // A chosen member brings its whole group.
  assert.deepEqual(wrapBounds(page, new Set(['p2'])), { x: 436, y: 80, width: 828, height: 284 });
  assert.deepEqual(wrapBounds(page, new Set(['lone'])), { x: 3960, y: -72, width: 200, height: 160 });
  assert.equal(wrapBounds(page, new Set()), null);
  for (const chosen of [['p1', 'img'], ['p2']]) {
    const wrapped = { ...page, sections: [{ id: 'new', name: 'New', ...wrapBounds(page, new Set(chosen)) }] }, held = sectionContents(wrapped, new Set(['new'])).nodeIds;
    for (const id of chosen) assert.ok(held.has(id), id);
  }
  const outer = { ...page, sections: [section('inner', 0, 0, 300, 200)] };
  assert.deepEqual(wrapBounds(outer, new Set(['inner'])), { x: -40, y: -72, width: 380, height: 312 });
});

test('sections draw behind group frames and connections, smaller ones above larger, and groups expose no colour', () => {
  const nodes = [text('a', 100, 100), text('b', 600, 100)], cache = createViewCache();
  const groups = [{ id: 'g', name: 'G', nodeIds: ['a', 'b'], collapsed: false, color: '#ffe5d5' }], sections = [section('small', 50, 50, 300, 200, { color: '#dceaff', selected: true }), section('big', 0, 0, 2000, 900)];
  const view = canvasView(nodes, [], groups, cache, sections);
  assert.deepEqual(view.nodes.map(node => node.id), ['small', 'big', 'g', 'a', 'b']);
  const small = view.sections[0], big = view.sections[1], frame = view.nodes.find(node => node.id === 'g');
  assert.equal(small.type, 'section'); assert.equal(small.dragHandle, '.section-handle'); assert.equal(small.selected, true);
  assert.deepEqual(small.data, { name: 'Section small', color: '#dceaff' }); assert.deepEqual(small.measured, { width: 300, height: 200 });
  assert.ok(big.zIndex < small.zIndex && small.zIndex < frame.zIndex && frame.zIndex < 0);
  assert.equal(Object.hasOwn(frame.data, 'color'), false);
  // Unchanged sections keep their view objects; without sections the view is as before.
  assert.equal(canvasView(nodes, [], groups, cache, sections).sections, view.sections);
  assert.deepEqual(canvasView(nodes, [], groups, createViewCache()).nodes.map(node => node.id), ['g', 'a', 'b']);
  // Far out, titles that would overlap wait for the zoom: the selected and larger sections keep theirs.
  assert.deepEqual([...visibleTitles(view.sections, .05)], ['small']);
  assert.deepEqual([...visibleTitles(view.sections, 1)].sort(), ['big', 'small']);
});

test('pages scope sections, and a local save stores them only when there are some', async () => {
  const pages = [{ id: 'page-1', name: 'Page 1' }, { id: 'p2', name: 'Two' }];
  const graph = { pages, nodes: [], edges: [], sections: [section('one', 0, 0, 300, 200), section('two', 0, 0, 300, 200, { page: 'p2' }), section('lost', 0, 0, 300, 200, { page: 'gone' })] };
  assert.deepEqual(pageContent(graph, 'page-1').sections.map(item => item.id), ['one', 'lost']);
  assert.deepEqual(pageContent(graph, 'p2').sections.map(item => item.id), ['two']);
  assert.equal(Object.hasOwn(pageContent({ nodes: [], edges: [] }, 'page-1'), 'sections'), false);
  const saved = { revision: 1, nodes: [], edges: [], groups: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await commitGraph(saved, { nodes: [], edges: [], groups: [], sections: [section('one', 0, 0, 300, 200)] }, async () => {});
  assert.deepEqual(saved.sections, [section('one', 0, 0, 300, 200)]);
  // An editor or agent that sends no sections keeps them; an empty list removes them and the field.
  await commitGraph(saved, { nodes: [], edges: [], groups: [] }, async () => {});
  assert.equal(saved.sections.length, 1);
  await assert.rejects(commitGraph(saved, { nodes: [], edges: [], groups: [], sections: [] }, async () => { throw new Error('disk'); }), /disk/);
  assert.equal(saved.sections.length, 1);
  await commitGraph(saved, { nodes: [], edges: [], groups: [], sections: [] }, async () => {});
  assert.equal(Object.hasOwn(saved, 'sections'), false);
});

test('revision merges accept sections another editor added or changed, without undoing local edits', () => {
  const base = [section('a', 0, 0, 300, 200), section('b', 0, 0, 300, 200, { color: '#dceaff' })];
  const local = [{ ...base[0], x: 50 }, { ...base[1], selected: true }, section('mine', 9, 9, 300, 200)];
  const remote = [{ ...base[0], x: 70, name: 'Renamed' }, (({ color, ...rest }) => ({ ...rest, width: 400 }))(base[1]), section('theirs', 1, 1, 300, 200)];
  assert.deepEqual(mergeSections(local, remote, base), [{ ...base[0], x: 50, name: 'Renamed' }, (({ color, ...rest }) => ({ ...rest, width: 400, selected: true }))(base[1]), local[2], remote[2]]);
  // A section deleted here stays deleted.
  assert.deepEqual(mergeSections([], remote, base).map(item => item.id), ['theirs']);
});

test('undo snapshots keep sections without editor-only fields', () => {
  const graph = { nodes: [text('a', 0, 0)], edges: [], groups: [], pages: undefined, sections: [{ ...section('S', 0, 0, 400, 300, { color: '#dceaff' }), selected: true }] };
  const snapshot = JSON.parse(captureHistory(graph, { remoteGroupVersion: 2, activeRunIds: ['r'] }));
  assert.deepEqual(snapshot.sections, [section('S', 0, 0, 400, 300, { color: '#dceaff' })]);
  assert.equal(snapshot.remoteGroupVersion, 2); assert.deepEqual(snapshot.activeRunIds, ['r']);
  assert.equal(snapshotSignature(snapshot), historySignature(graph));
  // Selecting a section is not an edit; moving one is.
  assert.equal(historySignature({ ...graph, sections: [{ ...graph.sections[0], selected: false }] }), historySignature(graph));
  assert.notEqual(historySignature({ ...graph, sections: [{ ...graph.sections[0], x: 10 }] }), historySignature(graph));
  assert.equal(historySignature({ ...graph, sections: undefined }), historySignature({ ...graph, sections: [] }));
});

test('copying a selected section copies what it holds; pasting gives fresh IDs on the open page', () => {
  const page = board(), selected = { ...page, sections: page.sections.map(item => item.id === 'T' ? { ...item, selected: true, page: 'p2' } : item) };
  const copy = selectedGraph(selected.nodes, selected.edges, { sections: selected.sections, groups: selected.groups });
  assert.deepEqual(copy.nodes.map(node => node.id), ['t1']); assert.deepEqual(copy.sections, [section('T', 600, 350, 600, 200)]);
  assert.equal(Object.hasOwn(selectedGraph(page.nodes, page.edges, { sections: page.sections }), 'sections'), false);
  const empty = readNodeClipboard(JSON.stringify({ ...copy, nodes: [] }));
  assert.deepEqual(empty.sections, copy.sections);
  const pasted = cloneSelection(readNodeClipboard(JSON.stringify(copy)), { x: 0, y: 0 });
  assert.notEqual(pasted.sections[0].id, 'T'); assert.notEqual(pasted.nodes[0].id, 't1');
  assert.deepEqual([pasted.sections[0].x, pasted.sections[0].y, pasted.sections[0].selected], [0, 0, true]);
  assert.deepEqual(pasted.nodes[0].position, { x: 400, y: 50 });
  assert.deepEqual(cloneSelection(empty, { x: 10, y: 20 }).nodes, []);
});

const exchange = (a, b) => { const left = Y.encodeStateAsUpdate(a), right = Y.encodeStateAsUpdate(b); Y.applyUpdate(a, right); Y.applyUpdate(b, left); assert.deepEqual(readCloudGraph(a), readCloudGraph(b)); };
const empty = () => ({ nodes: [], edges: [], groups: [], runs: [] });

test('team boards sync each section field on its own, never resurrect a deleted one, and undo through the shared history', () => {
  const a = new Y.Doc(), b = new Y.Doc(), origin = {};
  applyLocalGraph(a, { ...empty(), nodes: [text('n', 100, 100)], sections: [section('S', 0, 0, 800, 500)] }, empty(), 'seed'); exchange(a, b);
  let base = readCloudGraph(a);
  assert.deepEqual(base.sections, [section('S', 0, 0, 800, 500)]);
  // One person drags the section while another renames and recolours it.
  const moved = structuredClone(base), renamed = structuredClone(base);
  moved.sections[0].x = 40; moved.sections[0].y = 60; moved.nodes[0].position = { x: 140, y: 160 };
  Object.assign(renamed.sections[0], { name: 'Moodboard', color: '#fff3cd' });
  applyLocalGraph(a, moved, base, origin); applyLocalGraph(b, renamed, base, 'remote'); exchange(a, b);
  assert.deepEqual(readCloudGraph(b).sections, [section('S', 40, 60, 800, 500, { name: 'Moodboard', color: '#fff3cd' })]);
  assert.doesNotThrow(() => validateGraph(readCloudGraph(a)));
  // Undo takes back only this person's move, keeping the teammate's rename.
  const undo = new Y.UndoManager([a.getMap('nodes'), a.getMap('sections')], { trackedOrigins: new Set([origin]) });
  base = readCloudGraph(a);
  const resized = structuredClone(base); resized.sections[0].width = 1200;
  applyLocalGraph(a, resized, base, origin); exchange(a, b);
  undo.undo(); exchange(a, b);
  assert.deepEqual(readCloudGraph(a).sections, [section('S', 40, 60, 800, 500, { name: 'Moodboard', color: '#fff3cd' })]);
  undo.redo(); exchange(a, b); assert.equal(readCloudGraph(b).sections[0].width, 1200);
  // A caller that leaves sections out (generation placing images) keeps them.
  base = readCloudGraph(a);
  const { sections, ...withoutSections } = base;
  applyLocalGraph(a, { ...withoutSections, nodes: [...base.nodes, text('later', 300, 300)] }, base, 'generation');
  assert.equal(readCloudGraph(a).sections.length, 1);
  // A delete wins over a concurrent resize; the resize must not bring the section back.
  base = readCloudGraph(a); exchange(a, b);
  applyLocalGraph(a, { ...base, sections: [] }, base, 'delete');
  const wider = structuredClone(base); wider.sections[0].width = 1600;
  applyLocalGraph(b, wider, base, 'resize'); exchange(a, b);
  assert.equal(Object.hasOwn(readCloudGraph(a), 'sections'), false);
  const reloaded = new Y.Doc(); Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(a)); assert.deepEqual(readCloudGraph(reloaded), readCloudGraph(a));
  undo.destroy(); a.destroy(); b.destroy(); reloaded.destroy();
});

test('a section stored with bad values by another replica is still shown, within bounds', () => {
  const doc = new Y.Doc(), map = doc.getMap('sections');
  doc.transact(() => {
    const entry = new Y.Map(); for (const [key, value] of Object.entries({ name: '', x: 5, y: 6, width: 10, height: 1e9, color: 'red', page: 7 })) entry.set(key, value); map.set('odd', entry);
    const broken = new Y.Map(); broken.set('name', 'No position'); broken.set('width', 300); broken.set('height', 200); map.set('broken', broken);
    map.set('plain', { name: 'Not a map', x: 0, y: 0, width: 300, height: 200 });
  });
  assert.deepEqual(readCloudGraph(doc).sections, [{ id: 'odd', name: 'Section', x: 5, y: 6, width: 200, height: 1e6 }]);
  assert.doesNotThrow(() => validateGraph(readCloudGraph(doc)));
  assert.equal(readSection('x', { name: '  Spaced  ', x: 0, y: 0, width: 300, height: 200 }).name, '  Spaced  ');
  doc.destroy();
});

test('the incremental reader keeps unchanged sections and returns the caller its own list', () => {
  const doc = new Y.Doc(), reader = new CloudGraphReader(doc);
  applyLocalGraph(doc, { ...empty(), nodes: [text('n', 0, 0)], sections: [section('S', 0, 0, 800, 500), section('T', 900, 0, 300, 200)] }, empty(), 'seed');
  const first = reader.read({ nodes: [], edges: [], groups: [], sections: [] });
  const local = { ...first, sections: first.sections.map(item => item.id === 'T' ? { ...item, selected: true } : item) };
  doc.getMap('nodes').get('n').set('x', 50);
  const second = reader.read(local);
  assert.equal(second.sections, local.sections, 'a node move leaves the sections list as it was');
  doc.getMap('sections').get('S').set('x', 25);
  const third = reader.read(second);
  assert.notEqual(third.sections[0], second.sections[0]); assert.equal(third.sections[1], second.sections[1]);
  assert.equal(third.sections[1].selected, true);
  assert.deepEqual(third, readCloudGraph(doc, second));
  reader.destroy(); doc.destroy();
});
