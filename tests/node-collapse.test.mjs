import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportBoardArchive, importBoardArchive } from '../board-archive.mjs';
import { validateGraph, collectInputs } from '../graph.mjs';
import { alignNodes, canvasView, edgeDropCreatesPrompt, groupBounds } from '../src/canvas.mjs';

const asset = '11111111-1111-1111-1111-111111111111.png';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=', 'base64');
const nodes = [
  { id: 'image', type: 'image', position: { x: 0, y: 0 }, data: { asset, caption: 'Front', collapsed: true } },
  { id: 'text', type: 'text', position: { x: 400, y: 0 }, data: { text: 'Make a side view', template: { name: 'Views', instructions: 'Show the same object', assets: [] }, collapsed: true } },
];
const edges = [{ id: 'edge', source: 'image', target: 'text' }];

test('collapsed nodes remain original node types with correct connections and compact group bounds', () => {
  const group = { id: 'group', name: 'Ideas', nodeIds: ['image'], collapsed: false };
  const view = canvasView(nodes, edges, [group]);
  assert.equal(view.nodes.find(node => node.id === 'image').type, 'image');
  assert.equal(view.nodes.find(node => node.id === 'text').type, 'text');
  assert.deepEqual(view.edges.map(edge => [edge.source, edge.target]), [['image', 'text']]);
  assert.deepEqual(groupBounds(group, nodes), { x: -24, y: -48, width: 120, height: 144 });
  assert.ok(edgeDropCreatesPrompt({ isValid: false, fromHandle: { type: 'source' }, fromNode: view.nodes.find(node => node.id === 'text') }, true));
  const folded = canvasView(nodes, edges, [{ ...group, collapsed: true }]);
  assert.equal(folded.nodes.find(node => node.id === 'image').hidden, true);
  assert.equal(folded.edges[0].source, group.id);
  assert.equal(canvasView(nodes, edges, [group]).nodes.find(node => node.id === 'image').data.collapsed, true);
  const aligned = alignNodes(nodes, edges, []);
  assert.equal(aligned[1].position.x - aligned[0].position.x, 182);
});

test('collapsed state is validated and survives export/import without altering content', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-collapse-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'), destination = path.join(directory, 'destination');
  await mkdir(source); await mkdir(destination); await writeFile(path.join(source, asset), png);
  const board = { name: 'Temporary', createdAt: '2026-01-01T00:00:00.000Z', graph: { nodes, edges, groups: [], runs: [], revision: 0, viewport: { x: 0, y: 0, zoom: 1 } } };
  const bytes = []; for await (const chunk of await exportBoardArchive(board, source)) bytes.push(chunk);
  const imported = await importBoardArchive(Buffer.concat(bytes), destination);
  assert.deepEqual(imported.graph.nodes.map(node => node.data.collapsed), [true, true]);
  assert.deepEqual(imported.graph.nodes.map(node => node.position), nodes.map(node => node.position));
  assert.deepEqual(imported.graph.edges, edges);
  assert.equal(imported.graph.nodes[1].data.text, nodes[1].data.text);
  assert.deepEqual(imported.graph.nodes[1].data.template, nodes[1].data.template);
  assert.equal(collectInputs(imported.graph, 'text').images.length, 1);
  assert.throws(() => validateGraph({ nodes: [{ ...nodes[0], data: { ...nodes[0].data, collapsed: 'yes' } }], edges: [] }), /collapse state/);
});
