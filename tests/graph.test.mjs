import test from 'node:test';
import assert from 'node:assert/strict';
import { collectInputs, validateGraph, imageFormat } from '../graph.mjs';

const text = (id, value) => ({ id, type: 'text', position: { x: 0, y: 0 }, data: { text: value } });
const image = (id, label) => ({ id, type: 'image', position: { x: 0, y: 0 }, data: { asset: '12345678-1234-1234-1234-123456789abc.png', label } });
const edge = (source, target) => ({ id: source + '-' + target, source, target });

test('a branch gets all ancestors once, keeps image order, and excludes unrelated ideas', () => {
  const graph = { nodes: [text('style', 'Clay render'), text('original', 'Orange helmet'), image('one', 'Original robot'), image('two', 'Palette'), text('edit', 'Make the helmet blue'), text('unrelated', 'Do not include me')], edges: [edge('style', 'original'), edge('original', 'one'), edge('one', 'edit'), edge('style', 'edit'), edge('two', 'edit')] };
  const result = collectInputs(graph, 'edit');
  assert.deepEqual(result.snapshot.map(n => n.id), ['style', 'original', 'one', 'two', 'edit']);
  assert.equal(result.images.length, 2);
  assert.equal(result.prompt.split('Clay render').length - 1, 1);
  assert.ok(!result.prompt.includes('Do not include me'));
  assert.ok(result.prompt.indexOf('FINAL REQUEST') > result.prompt.indexOf('Orange helmet'));
  graph.nodes.find(n => n.id === 'edit').data.text = 'Changed later';
  assert.equal(result.target.data.text, 'Make the helmet blue');
  assert.equal(result.snapshot.at(-1).data.text, 'Make the helmet blue');
});

test('reject cycles, dangling connections, duplicate IDs, and blank prompts', () => {
  assert.throws(() => validateGraph({ nodes: [text('a', 'A'), text('b', 'B')], edges: [edge('a', 'b'), edge('b', 'a')] }), /loop/);
  assert.throws(() => validateGraph({ nodes: [text('a', 'A')], edges: [edge('a', 'missing')] }), /connection/);
  assert.throws(() => validateGraph({ nodes: [text('a', 'A'), text('a', 'B')], edges: [] }), /duplicate/);
  assert.throws(() => collectInputs({ nodes: [text('a', '  ')], edges: [] }, 'a'), /prompt/);
});

test('asset references cannot escape the asset directory', () => {
  const node = image('a', 'Bad'); node.data.asset = '../../auth.json';
  assert.throws(() => validateGraph({ nodes: [node], edges: [] }), /asset/);
});

test('uploads are recognized from bytes, never trusted from file names', () => {
  assert.equal(imageFormat(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'png');
  assert.equal(imageFormat(Buffer.from([255, 216, 255, 0])), 'jpg');
  assert.throws(() => imageFormat(Buffer.from('<script>alert(1)</script>')), /PNG/);
});
