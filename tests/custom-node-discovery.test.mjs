import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryKey, plainPrompt, readDiscovery, reusableDuplicate, writeDiscovery } from '../src/custom-node-discovery.mjs';
import { cloneSelection } from '../src/clipboard.mjs';

test('discovery persists across boards and merges invitation, duplication and use records', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.deepEqual(readDiscovery(storage), {});
  writeDiscovery(storage, { invitationSeen: true });
  writeDiscovery(storage, { duplicateSeen: true });
  writeDiscovery(storage, { used: true });
  assert.deepEqual(readDiscovery(storage), { invitationSeen: true, duplicateSeen: true, used: true });
  values.set(discoveryKey, 'broken');
  assert.deepEqual(readDiscovery(storage), {});
  const blocked = { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } };
  assert.deepEqual(writeDiscovery(blocked, { used: true }), { used: true });
});

test('only meaningful plain prompt duplicates qualify; connected inputs survive duplication', () => {
  const prompt = { id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: 'short' } };
  const image = { id: 'i', type: 'image', position: { x: 0, y: 0 }, data: { asset: '12345678-1234-1234-1234-123456789abc.png' } };
  const edge = { id: 'e', source: image.id, target: prompt.id }, nodes = [prompt, image];
  assert.equal(reusableDuplicate(prompt, nodes, []), false);
  assert.equal(reusableDuplicate(prompt, nodes, [edge]), true);
  assert.equal(reusableDuplicate({ ...prompt, data: { text: ' '.repeat(50) } }, nodes, [edge]), false);
  assert.equal(reusableDuplicate({ ...prompt, data: { text: 'a'.repeat(40) } }, nodes, []), false);
  assert.equal(reusableDuplicate({ ...prompt, data: { text: 'a'.repeat(41) } }, nodes, []), true);
  for (const data of [{ text: 'long'.repeat(20), task: 'describe' }, { text: 'long'.repeat(20), task: 'upscale' }, { text: 'long'.repeat(20), template: { name: 'Saved' } }]) assert.equal(plainPrompt({ ...prompt, data }), false);
  const copied = cloneSelection({ nodes: [prompt], edges: [] }, undefined, { nodes, edges: [edge] });
  assert.equal(reusableDuplicate(copied.nodes[0], [...nodes, ...copied.nodes], copied.edges), true);
});
