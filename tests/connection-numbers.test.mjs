import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { collectInputs, connectedSources, duplicateNodes, imageNumbers, localEdges, mainImageFor, runInputRecord, runInputs } from '../graph.mjs';
import { applyLocalGraph, CloudGraphReader, readCloudGraph } from '../src/cloud-sync.mjs';
import { cleanEdges } from '../src/history.mjs';
import { selectedGraph } from '../src/clipboard.mjs';
import { connectionNumbers, curveOf, labelPoint, maxNumberedPrompts, numberList, placeNumbers } from '../src/edge-numbers.mjs';
import { canvasView } from '../src/canvas.mjs';
import { editedFirst, nanoPrompt } from '../cloud/nano-banana.mjs';

const asset = n => `${String(n).repeat(8)}-1234-1234-1234-123456789abc.png`;
const image = (id, n, caption) => ({ id, type: 'image', position: { x: 0, y: n * 400 }, data: { asset: asset(n), ...(caption ? { caption } : {}) } });
const prompt = (id, text = 'Make #2 like image 1') => ({ id, type: 'text', position: { x: 800, y: 0 }, data: { text } });
const edge = (source, target, order) => ({ id: `${source}-${target}`, source, target, ...(order === undefined ? {} : { order }) });
const empty = () => ({ nodes: [], edges: [], groups: [], runs: [] });

test('a prompt numbers its images in the order they were connected; older connections keep their stored order first', () => {
  const nodes = [prompt('p'), image('a', 1), image('b', 2), image('c', 3), { ...prompt('ctx', 'Context'), position: { x: 0, y: 0 } }];
  // Stored order (by ID in the cloud) differs from the order the connections were made in.
  const edges = [edge('c', 'p', 300), edge('ctx', 'p'), edge('a', 'p', 100), edge('b', 'p', 200), { ...edge('a', 'p', 400), id: 'again' }];
  assert.deepEqual(connectedSources(edges, 'p'), ['ctx', 'a', 'b', 'c']);
  const types = new Map(nodes.map(node => [node.id, node.type]));
  assert.deepEqual([...imageNumbers(edges, 'p', id => types.get(id) === 'image')], [['a', 1], ['b', 2], ['c', 3]]);
  const { images, ordered } = runInputs({ nodes, edges }, 'p');
  assert.deepEqual(images.map(item => [item.nodeId, item.number]), [['a', 1], ['b', 2], ['c', 3]]);
  assert.deepEqual(ordered.map(node => node.id), ['ctx', 'a', 'b', 'c', 'p']);
  assert.deepEqual(runInputRecord({ nodes, edges }, 'p').map(item => item.number), [1, 2, 3]);
  // Switched to GPT Image without a main image, the prompt edits #1.
  assert.equal(mainImageFor(nodes, edges, { ...nodes[0], data: { ...nodes[0].data, generator: 'gpt-image' } }), 'a');
  // A board that never stored an order keeps its listed order, as before.
  assert.deepEqual(connectedSources(edges.map(({ order, ...rest }) => rest), 'p'), ['c', 'ctx', 'a', 'b']);
});

test('every generator is told the numbers the board shows, and custom node references stay unnumbered', () => {
  const nodes = [prompt('p'), image('a', 1, 'Front view'), image('b', 2), { id: 'style', type: 'text', position: { x: 0, y: 0 }, data: { text: '', template: { name: 'Style', instructions: '', assets: [asset(9)] } } }];
  const graph = { nodes, edges: [edge('b', 'p', 2), edge('style', 'p', 3), edge('a', 'p', 1)] };
  for (const text of [collectInputs(graph, 'p').prompt, nanoPrompt(graph, 'p').prompt]) {
    assert.deepEqual(text.split('\n').filter(line => /^(#\d|Attachment)/.test(line)).map(line => line.replace(/ \((node ID|file) .*$/, '')),
      ['#1: “Front view”', '#2', 'Attachment 3: “Style reference 1”']);
    assert.match(text, /“image 2”, “the second image”, “картинка 2”/);
  }
  // Without numbered images the prompt does not talk about numbers.
  const references = { nodes: [prompt('p'), nodes[3]], edges: [edge('style', 'p')] };
  assert.doesNotMatch(collectInputs(references, 'p').prompt, /#1|number/);
});

test('copies, pastes and undo keep a prompt’s numbering', () => {
  const nodes = [prompt('p'), image('a', 1), image('b', 2)], graph = { nodes, edges: [edge('b', 'p', 20), edge('a', 'p', 10)] };
  const copy = duplicateNodes(graph, ['p']);
  assert.deepEqual(copy.edges.map(item => item.source), ['a', 'b']);
  assert.ok(copy.edges.every(item => item.order === undefined), 'stored as new connections, in this order');
  assert.deepEqual(selectedGraph(nodes.map(node => ({ ...node, selected: true })), graph.edges).edges.map(item => item.source), ['a', 'b']);
  // A local board's list is its order: undo snapshots, saves and imports fold a stored order into it.
  assert.deepEqual(cleanEdges(graph.edges), [{ id: 'a-p', source: 'a', target: 'p' }, { id: 'b-p', source: 'b', target: 'p' }]);
  assert.deepEqual(cleanEdges([{ id: 'x', source: 'a', target: 'p', order: 'soon', selected: true }]), [{ id: 'x', source: 'a', target: 'p' }]);
  const imported = localEdges([edge('b', 'p', 20), edge('a', 'p', 10)]);
  assert.deepEqual(imported, [{ id: 'a-p', source: 'a', target: 'p' }, { id: 'b-p', source: 'b', target: 'p' }]);
  // A connection made after the import is appended and numbered last.
  assert.deepEqual([...imageNumbers([...imported, edge('c', 'p')], 'p', () => true)], [['a', 1], ['b', 2], ['c', 3]]);
});

test('the cloud stores when each new connection was made, in listed order, and never drops a stored one', t => {
  const doc = new Y.Doc(), base = { ...empty(), nodes: [prompt('p'), image('a', 1), image('b', 2), image('c', 3)] };
  applyLocalGraph(doc, base, empty(), 'seed');
  let now = 5000; t.mock.method(Date, 'now', () => now);
  // Connected c, then a, in one change: listed order wins, even within the same millisecond.
  let before = readCloudGraph(doc), next = { ...structuredClone(before), edges: [{ id: 'zz', source: 'c', target: 'p' }, { id: 'aa', source: 'a', target: 'p' }] };
  applyLocalGraph(doc, next, before, 'test');
  const stored = id => doc.getMap('edges').get(id);
  assert.ok(stored('zz').order < stored('aa').order);
  now = 1000; // A clock that goes back still gives a later connection a later order.
  before = readCloudGraph(doc); next = structuredClone(before); next.edges.push({ id: 'mm', source: 'b', target: 'p' });
  applyLocalGraph(doc, next, before, 'test');
  assert.ok(stored('mm').order > stored('aa').order);
  const graph = readCloudGraph(doc);
  assert.deepEqual(graph.edges.map(item => item.id), ['aa', 'mm', 'zz'], 'the document still lists them by ID');
  assert.deepEqual(runInputs(graph, 'p').images.map(item => item.nodeId), ['c', 'a', 'b']);
  // The incremental reader the editor uses agrees.
  const reader = new CloudGraphReader(doc);
  assert.deepEqual(runInputs(reader.read(), 'p').images.map(item => item.nodeId), ['c', 'a', 'b']);
  reader.destroy();
  // An agent's whole-board edit that leaves orders out keeps the stored ones; a deliberate order is written.
  before = readCloudGraph(doc); next = structuredClone(before); next.edges = next.edges.map(({ order, ...rest }) => rest);
  applyLocalGraph(doc, next, before, 'agent');
  assert.deepEqual(runInputs(readCloudGraph(doc), 'p').images.map(item => item.nodeId), ['c', 'a', 'b']);
  before = readCloudGraph(doc); next = structuredClone(before); next.edges.find(item => item.id === 'zz').order = 99999;
  applyLocalGraph(doc, next, before, 'test');
  assert.deepEqual(runInputs(readCloudGraph(doc), 'p').images.map(item => item.nodeId), ['a', 'b', 'c']);
  doc.destroy();
});

test('a connection made on a computer whose clock is behind still comes last, and a stale local order never shows', t => {
  const a = new Y.Doc(), b = new Y.Doc();
  applyLocalGraph(a, { ...empty(), nodes: [prompt('p'), image('x', 1), image('y', 2), image('z', 3)] }, empty(), 'seed');
  let now = 10_000_000; t.mock.method(Date, 'now', () => now);
  let before = readCloudGraph(a), next = structuredClone(before); next.edges.push({ id: 'x1', source: 'x', target: 'p' }, { id: 'y1', source: 'y', target: 'p' });
  applyLocalGraph(a, next, before, 'a');
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  now = 1000; // Ten thousand seconds behind.
  before = readCloudGraph(b); next = structuredClone(before); next.edges.push({ id: 'z1', source: 'z', target: 'p' });
  applyLocalGraph(b, next, before, 'b');
  assert.deepEqual(runInputs(readCloudGraph(b), 'p').images.map(item => `${item.nodeId}${item.number}`), ['x1', 'y2', 'z3']);
  // A tab from before connections stored an order rewrites one without it: the editor shows what generators read.
  b.getMap('edges').set('x1', { source: 'x', target: 'p' });
  const reader = new CloudGraphReader(b), local = readCloudGraph(b);
  local.edges = local.edges.map(item => item.id === 'x1' ? { ...item, order: 5 } : item);
  const shown = reader.read(local);
  assert.equal(shown.edges.find(item => item.id === 'x1').order, undefined);
  assert.equal(readCloudGraph(b, local).edges.find(item => item.id === 'x1').order, undefined);
  reader.destroy(); a.destroy(); b.destroy();
});

test('GPT Image leads with the image a request names by number, and ignores counts, sizes and colours', () => {
  const images = [4, 3, 2, 1].map(number => ({ label: 'Image', number, nodeId: `n${number}` }));
  const lead = text => editedFirst(images, text)[0].nodeId;
  for (const text of ['make the image 2x bigger', 'background #2a2a2a', 'з 2-х фото', 'з 3-ма картинками', 'обріж третину картинки', 'зроби з картинки 2 варіанти',
    'a second image of the robot', 'photo 3/4 view', 'make 3-d image', 'зроби 2 картинки', 'ще одну другу картинку']) assert.equal(lead(text), 'n4', text);
  for (const text of ['фото 3-х дівчат', 'з п’яти картинок', 'з десяти фото', 'четвертину картинки', 'другу половину картинки']) assert.equal(lead(text), 'n4', text);
  for (const [text, number] of [['на картинці 3', 3], ['на другій картинці', 2], ['для 2-ї картинки', 2], ['3-ю картинку', 3], ['image number 3', 3], ['image two', 2], ['картинку три', 3],
    ['the second attached image', 2], ['другу підключену картинку', 2], ['фотку 2', 2]]) assert.equal(lead(text), `n${number}`, text);
  // A board name made of a picture word loses a tie with a number at the same place.
  const named = [{ label: 'photo', number: 1, nodeId: 'a' }, { label: 'Image', number: 2, nodeId: 'b' }];
  assert.equal(editedFirst(named, 'Edit photo 2')[0].nodeId, 'b'); assert.equal(editedFirst(named, 'Edit the photo')[0].nodeId, 'a');
  for (const [text, number] of [['make image 2 like 1', 2], ['зроби другу картинку як першу', 2], ['the third image', 3], ['3-тю картинку', 3], ['#3 please', 3], ['картинка №2', 2], ['image 2.', 2], ['2nd image', 2]]) assert.equal(lead(text), `n${number}`, text);
  // Long runs of spaces after a picture word stay fast.
  const started = performance.now();
  for (const text of ['image' + ' '.repeat(40000), '#' + ' '.repeat(40000) + 'x', 'другу' + ' '.repeat(40000) + 'x', 'a '.repeat(30000) + 'second image']) editedFirst(images, text);
  assert.ok(performance.now() - started < 500);
});

test('an order that is not a sane time is ignored, and never stops later connections from coming last', () => {
  const doc = new Y.Doc();
  applyLocalGraph(doc, { ...empty(), nodes: [prompt('p'), prompt('q'), image('a', 1), image('b', 2), image('c', 3), image('d', 4)] }, empty(), 'seed');
  let before = readCloudGraph(doc), next = structuredClone(before);
  next.edges.push({ id: 'z', source: 'a', target: 'p', order: Number.MAX_SAFE_INTEGER }, { id: 'y', source: 'b', target: 'p', order: 'soon' });
  applyLocalGraph(doc, next, before, 'agent');
  assert.ok(doc.getMap('edges').get('z').order < 1e14 && doc.getMap('edges').get('y').order < 1e14);
  before = readCloudGraph(doc); next = structuredClone(before);
  next.edges.push(...['d', 'c'].map(source => ({ id: `${source}q`, source, target: 'q' })));
  applyLocalGraph(doc, next, before, 'test');
  assert.deepEqual(runInputs(readCloudGraph(doc), 'q').images.map(item => item.nodeId), ['d', 'c']);
  // Read from a document written by anything else, a crafted order counts as none.
  assert.deepEqual(connectedSources([edge('a', 'p', 2 ** 60), edge('b', 'p', 5)], 'p'), ['a', 'b']);
  doc.destroy();
});

test('undo restores a deleted connection with its number, and two editors agree on the numbers', () => {
  const a = new Y.Doc(), b = new Y.Doc(), origin = {};
  applyLocalGraph(a, { ...empty(), nodes: [prompt('p'), image('x', 1), image('y', 2)], edges: [{ id: 'y1', source: 'y', target: 'p' }] }, empty(), 'seed');
  let before = readCloudGraph(a), next = structuredClone(before); next.edges.push({ id: 'x1', source: 'x', target: 'p' });
  applyLocalGraph(a, next, before, 'seed');
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const numbers = doc => runInputs(readCloudGraph(doc), 'p').images.map(item => `${item.nodeId}${item.number}`);
  assert.deepEqual(numbers(a), ['y1', 'x2']); assert.deepEqual(numbers(b), ['y1', 'x2']);
  const undo = new Y.UndoManager([a.getMap('edges')], { trackedOrigins: new Set([origin]) });
  before = readCloudGraph(a); next = structuredClone(before); next.edges = next.edges.filter(item => item.id !== 'y1');
  applyLocalGraph(a, next, before, origin); assert.deepEqual(numbers(a), ['x1']);
  undo.undo(); assert.deepEqual(numbers(a), ['y1', 'x2']);
  undo.destroy(); a.destroy(); b.destroy();
});

test('a selected prompt labels each image connection with its number; a folded group lists its images on one line', () => {
  const types = { a: 'image', b: 'image', c: 'image', ctx: 'text' }, isImage = id => types[id] === 'image';
  const edges = [edge('b', 'p', 2), edge('ctx', 'p', 3), edge('a', 'p', 1), edge('c', 'p', 4), edge('a', 'q', 1), { ...edge('a', 'p', 5), id: 'again' }];
  assert.deepEqual([...connectionNumbers(edges, ['p'], isImage)], [['a-p', '1'], ['b-p', '2'], ['c-p', '3']]);
  assert.deepEqual([...connectionNumbers(edges, ['p', 'q'], isImage)].sort(), [['a-p', '1'], ['a-q', '1'], ['b-p', '2'], ['c-p', '3']]);
  // b and c are folded into group g, so their connections are one line from the group.
  assert.deepEqual([...connectionNumbers(edges, ['p'], isImage, edge => ['b', 'c'].includes(edge.source) ? 'g' : edge.source)], [['a-p', '1'], ['b-p', '2, 3']]);
  // A line that is not drawn carries no number.
  assert.deepEqual([...connectionNumbers(edges, ['p'], isImage, edge => edge.source === 'b' ? null : edge.source)], [['a-p', '1'], ['c-p', '3']]);
  assert.equal(connectionNumbers(edges, [], isImage).size, 0);
  assert.equal(connectionNumbers(edges, Array.from({ length: maxNumberedPrompts + 1 }, (_, i) => i === 0 ? 'p' : `x${i}`), isImage).size, 0);
  assert.deepEqual([numberList([1]), numberList([2, 1]), numberList([3, 1, 2, 5]), numberList([1, 2, 3, 4, 7, 8])], ['1', '1, 2', '1–3, 5', '1–4, 7, 8']);
});

test('a folded group draws one numbered line per port: a GPT Image prompt’s main image keeps its own number', () => {
  const nodes = [{ ...prompt('p'), data: { text: 'Edit', generator: 'gpt-image', mainImage: 'b' } }, image('a', 1), image('b', 2), image('c', 3)];
  const edges = [edge('a', 'p', 1), edge('b', 'p', 2), edge('c', 'p', 3)], view = canvasView(nodes, edges, [{ id: 'g', name: 'G', nodeIds: ['a', 'b', 'c'], collapsed: true }]);
  const shown = new Map(view.edges.map(item => [item.id, item]));
  const lineOf = item => { const line = shown.get(item.id); return line.hidden ? null : `${line.source}\n${line.targetHandle || ''}`; };
  assert.deepEqual([...connectionNumbers(edges, ['p'], () => true, lineOf)], [['a-p', '1, 3'], ['b-p', '2']]);
});

test('numbers of images far off screen spread along their lines instead of covering each other near the prompt', () => {
  // Three images 1200 units to the left, 300 apart, meeting at one prompt port; only the last 400 units are in view.
  const lines = [0, 300, 600].map((y, index) => ({ id: `e${index}`, label: String(index + 1), curve: curveOf(`M-1200,${y} C-600,${y} -600,300 0,300`) }));
  const placed = placeNumbers(lines, [500, 100, 1], { width: 600, height: 600 });
  assert.equal(placed.length, 3);
  for (const [i, a] of placed.entries()) for (const b of placed.slice(i + 1)) assert.ok(Math.abs(a.x - b.x) >= 26 || Math.abs(a.y - b.y) >= 26, `${a.label} and ${b.label} overlap`);
  for (const number of placed) assert.ok(number.x + 500 >= 18 && number.x + 500 <= 582, 'in view');
  // Nothing in view, nothing drawn.
  assert.deepEqual(placeNumbers(lines, [500, 2000, 1], { width: 600, height: 600 }), []);
});

test('a connection’s number sits on the part of its line in view, clear of panels, or nowhere when none is', () => {
  const curve = curveOf('M0,0 C100,0 100,0 200,0');
  assert.deepEqual(curve, [0, 0, 100, 0, 100, 0, 200, 0]);
  assert.equal(curveOf('M0,0 L10,10'), null);
  // The whole line in view: its middle.
  const middle = labelPoint(curve, [100, 100, 1], { width: 800, height: 400 }); assert.ok(Math.abs(middle.x - 100) < 1e-6 && middle.y === 0);
  // Its start is off screen to the left: the middle of what is left in view.
  const shifted = labelPoint(curve, [-150, 100, 1], { width: 800, height: 400 });
  assert.ok(shifted.x > 150 && shifted.x < 200, String(shifted.x));
  // A panel over the far end pushes the number to the near part; zoom works in screen pixels.
  const panel = labelPoint(curve, [100, 100, 1], { width: 800, height: 400, blocked: [{ left: 180, top: 0, right: 400, bottom: 400 }] });
  assert.ok(panel.x < 70, String(panel.x));
  assert.ok(Math.abs(labelPoint(curve, [100, 100, 2], { width: 800, height: 400 }).x - 100) < 1e-6);
  // Margins are screen pixels at any zoom: at 4× only the part 18 px inside the right edge counts.
  // (A straight line whose x grows evenly with t, so the middle of the visible part is the middle of the screen.)
  const zoomed = labelPoint([0, 0, 200 / 3, 0, 400 / 3, 0, 200, 0], [0, 100, 4], { width: 400, height: 400 });
  assert.ok(Math.abs(zoomed.x * 4 - 200) < 15, String(zoomed.x * 4));
  assert.equal(labelPoint(curve, [100, 900, 1], { width: 800, height: 400 }), null);
});
