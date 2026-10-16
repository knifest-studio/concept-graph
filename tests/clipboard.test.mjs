import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedGraph, cloneSelection, readNodeClipboard, nodeClipboardType } from '../src/clipboard.mjs';

const nodes = [
  { id: 'prompt', type: 'text', position: { x: -100, y: 90 }, data: { text: 'Keep my exact prompt' }, selected: true, measured: { width: 310, height: 80 } },
  { id: 'image', type: 'image', position: { x: 290, y: 170 }, data: { asset: '12345678-1234-1234-1234-123456789abc.png', runId: 'original-run' }, selected: true },
  { id: 'other', type: 'text', position: { x: 700, y: 0 }, data: { text: 'Unselected' } },
];
const edges = [{ id: 'inside', source: 'prompt', target: 'image' }, { id: 'outside', source: 'other', target: 'prompt' }];

test('duplicate and clipboard paste preserve content, relative placement and internal connections with fresh IDs', () => {
  const before = structuredClone({ nodes, edges }), selection = selectedGraph(nodes, edges);
  assert.deepEqual(selection.nodes.map(node => node.id), ['prompt', 'image']);
  assert.equal(selection.edges.length, 1);
  assert.ok(selection.nodes.every(node => !('measured' in node) && !('selected' in node)));
  const decoded = readNodeClipboard(JSON.stringify(selection));
  assert.deepEqual(decoded, selection);
  for (const target of [undefined, { x: 900, y: -200 }]) {
    const result = cloneSelection(decoded, target);
    assert.deepEqual(result.nodes[0].position, target || { x: -60, y: 130 });
    assert.equal(result.nodes[1].position.x - result.nodes[0].position.x, 390);
    assert.equal(result.nodes[1].position.y - result.nodes[0].position.y, 80);
    assert.deepEqual(result.nodes.map(node => node.data), nodes.slice(0, 2).map(node => node.data));
    assert.ok(result.nodes.every(node => node.selected && !nodes.some(original => original.id === node.id)));
    assert.equal(new Set(result.nodes.map(node => node.id)).size, 2);
    assert.notEqual(result.edges[0].id, 'inside');
    assert.deepEqual(result.edges.map(({ source, target }) => ({ source, target })), [{ source: result.nodes[0].id, target: result.nodes[1].id }]);
    result.nodes[0].data.text = 'Edited copy';
  }
  assert.deepEqual({ nodes, edges }, before);
  assert.equal(selection.nodes[0].data.text, 'Keep my exact prompt');
  assert.deepEqual(cloneSelection(selectedGraph([], [])), { nodes: [], edges: [] });
});

test('clipboard parsing rejects ordinary text, unrelated JSON, invalid assets, dangling links and cycles', () => {
  const selection = selectedGraph(nodes, edges);
  for (const text of ['ordinary pasted text', '{bad', 'null', JSON.stringify({ nodes: [], edges: [] }), JSON.stringify({ ...selection, version: 2 }), JSON.stringify({ ...selection, nodes: [] })]) assert.equal(readNodeClipboard(text), null);
  for (const value of [
    { ...selection, nodes: [{ ...selection.nodes[1], data: { asset: '../../secrets.png' } }] },
    { ...selection, edges: [{ id: 'dangling', source: 'missing', target: 'prompt' }] },
    { ...selection, edges: [...selection.edges, { id: 'cycle', source: 'image', target: 'prompt' }] },
  ]) assert.equal(readNodeClipboard(JSON.stringify(value)), null);
  assert.equal(selection.format, nodeClipboardType);
});
