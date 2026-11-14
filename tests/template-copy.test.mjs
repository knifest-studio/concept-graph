import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc } from 'yjs';
import { templatePalette } from '../graph.mjs';
import { importBoardTemplates, readBoardTemplates, saveBoardTemplate } from '../src/board-templates.mjs';
import { templateCopy } from '../cloud/template-copy.mjs';

const asset = '12345678-1234-1234-1234-123456789abc.png';
const value = { name: 'Character multiview', instructions: 'front, side and back', assets: [asset], color: templatePalette[0], labelOutputs: true };
function setup() {
  const source = new Doc(), destination = new Doc(), hidden = new Doc();
  const original = saveBoardTemplate(source, value);
  const docs = { source, destination, hidden }, roles = { source: 'view', destination: 'edit', hidden: null, empty: 'view' };
  docs.empty = new Doc();
  const store = { boardFor: async id => roles[id] === undefined ? null : { id, role: roles[id] }, boardsFor: async () => Object.entries(roles).map(([id, role]) => ({ id, role, name: id })) };
  const room = async id => ({ listTemplates: () => readBoardTemplates(docs[id]), importTemplates: values => ({ templates: importBoardTemplates(docs[id], values) }) });
  const call = (method, selections, origin) => templateCopy(new Request('https://example.com/api/boards/destination/template-copy', { method, headers: origin ? { Origin: origin } : {} }), { boardId: 'destination', user: { email: 'artist@example.com' }, store, room, input: async () => ({ selections }) });
  return { source, destination, original, roles, call };
}

test('lists only accessible other boards with templates, previews and image counts', async () => {
  const { call, original } = setup();
  assert.deepEqual(await call('GET'), { boards: [{ id: 'source', name: 'source', templates: [{ id: original.id, name: value.name, color: value.color, preview: value.instructions, imageCount: 1 }] }] });
});

test('copies are independent with globally accessible immutable assets, including labelOutputs', async () => {
  const { call, original, source, destination, roles } = setup();
  const { templates: [copy] } = await call('POST', [{ boardId: 'source', id: original.id }]);
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.color, value.color); assert.equal(copy.labelOutputs, true);
  assert.deepEqual(copy.assets, [asset]);
  saveBoardTemplate(destination, { ...copy, instructions: 'changed' }, copy);
  assert.equal(readBoardTemplates(source)[0].instructions, value.instructions);
  source.destroy(); roles.source = null;
  assert.deepEqual(readBoardTemplates(destination)[0].assets, [asset]);
});

test('source view and destination edit are enforced before mutation, with safe origin and input bounds', async () => {
  const { call, original, destination, roles } = setup();
  const selected = [{ boardId: 'source', id: original.id }];
  roles.destination = 'view'; await assert.rejects(call('POST', selected), { status: 403 });
  await assert.rejects(call('GET'), { status: 403 });
  roles.destination = 'edit'; roles.source = null; await assert.rejects(call('POST', selected), { status: 403 });
  roles.source = 'view';
  await assert.rejects(call('POST', selected, 'https://evil.example'), { status: 403 });
  for (const selection of [[], null, [...selected, ...selected], [{ boardId: 'destination', id: original.id }], [{ boardId: 'source' }], Array(501).fill(selected[0])]) await assert.rejects(call('POST', selection), { status: 400 });
  await assert.rejects(call('POST', [...selected, { boardId: 'source', id: 'missing' }]), { status: 404 });
  assert.equal(readBoardTemplates(destination).length, 0);
});

test('batch validates every value and the 500 limit atomically, including near-full destinations', () => {
  const doc = new Doc();
  importBoardTemplates(doc, Array(499).fill(value));
  let transactions = 0; doc.on('afterTransaction', () => transactions++);
  assert.throws(() => importBoardTemplates(doc, [value, value]), /at most 500/);
  assert.equal(transactions, 0); assert.equal(readBoardTemplates(doc).length, 499);
  assert.throws(() => importBoardTemplates(doc, [{ ...value, assets: Array(11).fill(asset) }]), /Invalid/);
  importBoardTemplates(doc, [value]);
  assert.equal(transactions, 1); assert.equal(readBoardTemplates(doc).length, 500);
  assert.equal(new Set(readBoardTemplates(doc).map(item => item.id)).size, 500);
});
