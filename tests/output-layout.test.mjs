import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSize, imageNode, nodeSize, captionHeight, positionRunOutput, validateGraph } from '../graph.mjs';
import { alignNodes, groupBounds } from '../src/canvas.mjs';

const asset = '12345678-1234-1234-1234-123456789abc.png';
const run = { id: 'run', target: { position: { x: 80, y: 40 } }, outputIds: [] };
const png = (width, height) => {
  const bytes = Buffer.alloc(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20); return bytes;
};
const webp = (type, payload) => {
  const bytes = Buffer.alloc(20 + payload.length + payload.length % 2); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WEBP', 8); bytes.write(type, 12); bytes.writeUInt32LE(payload.length, 16); bytes.set(payload, 20); return bytes;
};

test('image headers expose dimensions for PNG, JPEG, GIF and all three WebP encodings without Buffer APIs', () => {
  const gif = Buffer.from('4749463839617800f000', 'hex');
  const jpeg = Buffer.from('ffd8ffe10002ffc200080800f0007800', 'hex');
  const extended = Buffer.alloc(10); extended.writeUIntLE(119, 4, 3); extended.writeUIntLE(239, 7, 3);
  const lossy = Buffer.from('0000009d012a7800f000', 'hex');
  const lossless = Buffer.alloc(5); lossless[0] = 0x2f; lossless.writeUInt32LE(119 | (239 << 14), 1);
  for (const fixture of [png(120, 240), gif, jpeg, webp('VP8X', extended), webp('VP8 ', lossy), webp('VP8L', lossless)]) {
    const padded = new Uint8Array(fixture.length + 4); padded.set(fixture, 2);
    const bytes = padded.subarray(2, -2);
    assert.deepEqual(imageSize(bytes), { width: 120, height: 240 });
    for (let length = 0; length < fixture.length - (fixture.length % 2); length++) assert.doesNotThrow(() => imageSize(bytes.subarray(0, length)));
    assert.equal(imageSize(bytes.subarray(0, 8)), undefined);
  }
  assert.equal(imageSize(png(0, 20)), undefined);
  assert.equal(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 0])), undefined);
  assert.equal(imageSize(new Uint8Array([1, 2, 3])), undefined);
});

test('aspect metadata is optional on old boards, bounded on new nodes and used before measurement', () => {
  const node = imageNode(run, asset, 0, { width: 100, height: 200 });
  assert.equal(node.data.aspect, 2); assert.equal(nodeSize(node).height, 620);
  const graph = { nodes: [node], edges: [] };
  assert.doesNotThrow(() => validateGraph(graph));
  for (const aspect of [0.1, 10]) { node.data.aspect = aspect; assert.doesNotThrow(() => validateGraph(graph)); }
  for (const aspect of [0, 0.09, 11, NaN, Infinity, '2', null]) { node.data.aspect = aspect; assert.throws(() => validateGraph(graph), /aspect/); }
  delete node.data.aspect; assert.doesNotThrow(() => validateGraph(graph)); assert.equal(nodeSize(node).height, 310);
  assert.equal(imageNode(run, asset, 0, { width: 0, height: 20 }).data.aspect, undefined);
});

test('mixed portrait, landscape, measured and legacy outputs stack with a 30px gap including captions', () => {
  const graph = { nodes: [], edges: [], groups: [] }, current = structuredClone(run);
  for (const [index, dimensions] of [{ width: 100, height: 200 }, { width: 200, height: 100 }, undefined, undefined].entries()) {
    const node = imageNode(current, asset, index, dimensions);
    if (index > 0) node.data.caption = `Image ${index + 1}`;
    if (index === 2) node.measured = { width: 310, height: 450 };
    positionRunOutput(node, graph, current);
    const previous = graph.nodes.at(-1);
    assert.equal(node.position.x, 470);
    if (previous) assert.equal(node.position.y - captionHeight(node) - previous.position.y - nodeSize(previous).height, 30);
    else assert.equal(node.position.y, 40);
    graph.nodes.push(node); current.outputIds.push(node.id);
  }
  assert.deepEqual(graph.nodes.map(node => node.position.y), [40, 714, 923, 1427]);
  const next = imageNode(run, asset, 0, { width: 100, height: 200 });
  positionRunOutput(next, graph, run);
  assert.ok(next.position.y > graph.nodes.at(-1).position.y + 310);
});

test('Auto-align repairs expanded group overlaps using measured heights and captions without mutating inputs', () => {
  const nodes = [imageNode(run, asset, 0), imageNode(run, asset, 1), imageNode(run, asset, 2)];
  nodes[0].measured = { width: 310, height: 620 }; nodes[1].data.aspect = 1.5; nodes[1].data.caption = 'Portrait';
  nodes[2].data.aspect = 0.5;
  const groups = [{ id: 'group', name: 'Group 1', nodeIds: nodes.map(node => node.id), collapsed: false }];
  const before = structuredClone(nodes), aligned = alignNodes(nodes, [], groups);
  assert.deepEqual(nodes, before);
  for (let index = 1; index < aligned.length; index++) {
    assert.equal(aligned[index].position.y - captionHeight(aligned[index]) - aligned[index - 1].position.y - nodeSize(aligned[index - 1]).height, 30);
    assert.equal(aligned[index].position.x - aligned[0].position.x, nodes[index].position.x - nodes[0].position.x);
  }
  const bounds = groupBounds(groups[0], aligned);
  assert.ok(bounds.y + bounds.height > aligned[2].position.y + 155);
  assert.deepEqual(alignNodes(aligned, [], groups), aligned);
  const collapsed = alignNodes(nodes, [], [{ ...groups[0], collapsed: true }]);
  assert.equal(collapsed[1].position.y - collapsed[0].position.y, 340);
});
