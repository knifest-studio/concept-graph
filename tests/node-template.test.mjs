import test from 'node:test';
import assert from 'node:assert/strict';
import { switchNodeTemplate, matchingTemplateId, templateFromNode } from '../src/node-template.mjs';
import { collectInputs } from '../graph.mjs';

test('switching node type preserves prompt and connections while adding or removing saved instructions', () => {
  const asset = '12345678-1234-1234-1234-123456789abc.png';
  const prompt = { id: 'p', type: 'text', position: { x: 400, y: 100 }, data: { text: 'My subject', collapsed: true } };
  const image = { id: 'i', type: 'image', position: { x: 0, y: 100 }, data: { asset, label: 'Reference' } };
  const edges = [{ id: 'e', source: image.id, target: prompt.id }];
  const saved = { id: 'saved', name: '3D Studio', instructions: 'Front and back views', assets: [] };
  const custom = switchNodeTemplate(prompt, saved);
  assert.equal(custom.id, prompt.id);
  assert.deepEqual(custom.position, prompt.position);
  assert.equal(custom.data.text, prompt.data.text);
  assert.equal(custom.data.collapsed, true);
  assert.notEqual(custom.data.template.assets, saved.assets);
  assert.ok(custom.data.template.color);
  const graph = { nodes: [image, custom], edges };
  assert.ok(collectInputs(graph, 'p').prompt.includes('Front and back views'));
  assert.deepEqual(collectInputs(graph, 'p').images, [asset]);
  const normal = switchNodeTemplate(custom, null);
  assert.equal(normal.data.text, 'My subject');
  assert.equal(normal.data.template, undefined);
  assert.ok(!collectInputs({ ...graph, nodes: [image, normal] }, 'p').prompt.includes('Front and back views'));
  assert.deepEqual(edges, [{ id: 'e', source: 'i', target: 'p' }]);
  assert.throws(() => switchNodeTemplate(image, saved), /Only text nodes/);
});

test('picker recognises exact saved snapshots without confusing newer template edits', () => {
  const saved = { id: 'one', name: 'Views', instructions: 'Front', assets: ['a'] };
  assert.equal(matchingTemplateId({ name: 'Views', instructions: 'Front', assets: ['a'] }, [saved]), 'one');
  assert.equal(matchingTemplateId({ name: 'Views', instructions: 'Old', assets: ['a'] }, [saved]), null);
  assert.equal(matchingTemplateId(undefined, [saved]), '');
  assert.equal(matchingTemplateId({ name: 'Views', instructions: 'Front', assets: ['a'], color: '#2563eb' }, [{ ...saved, color: '#7c3aed' }]), null);
});

test('save as custom node captures instructions and images without changing the board', () => {
  const asset = '12345678-1234-1234-1234-123456789abc.png', other = '12345678-1234-1234-1234-123456789def.png';
  const node = { id: 'p', type: 'text', position: { x: 40, y: 80 }, data: { text: 'A red helmet', model: 'legacy-model', effort: 'high', labelOutputs: true, template: { name: 'Views', instructions: 'Front and side', assets: [asset] } } };
  const nodes = [node, { id: 'i', type: 'image', data: { asset: other } }, { id: 'duplicate', type: 'image', data: { asset } }];
  const edges = [{ source: 'i', target: 'p' }, { source: 'duplicate', target: 'p' }], before = structuredClone({ nodes, edges });
  const template = templateFromNode(node, nodes, edges);
  assert.deepEqual(template, { name: 'Views', instructions: 'Front and side\n\nA red helmet', assets: [asset, other], labelOutputs: true });
  assert.deepEqual({ nodes, edges }, before);
  const plain = { ...node, data: { text: 'A bird\nIn flight' } };
  assert.equal(templateFromNode(plain, [], []).name, 'A bird');
  assert.throws(() => templateFromNode({ type: 'image' }, [], []), /Only text/);
  const oversized = { ...node, data: { text: 'A bird', template: { name: 'Too many', instructions: '', assets: Array.from({ length: 11 }, (_, i) => `${String(i).padStart(8, '0')}-1234-1234-1234-123456789abc.png`) } } };
  assert.throws(() => templateFromNode(oversized, [], []), /Invalid custom/);
});
