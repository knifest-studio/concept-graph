import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { commitGraph, duplicateNodes, reconcileStampGraph, validateGraph } from '../graph.mjs';
import { detachMissingStampTargets, reconcileStampAttachments } from '../src/annotations.mjs';
import { alignNodes, attachStampAt, canvasView, groupBounds, moveGroup, stampTargetAt } from '../src/canvas.mjs';
import { cloneSelection, readNodeClipboard, selectedGraph } from '../src/clipboard.mjs';

const text = (id, x = 100, y = 100) => ({ id, type: 'text', position: { x, y }, data: { text: id }, measured: { width: 310, height: 170 } });
const stamp = (id, attachedTo, x = 120, y = 130) => ({ id, type: 'stamp', position: { x, y }, data: { kind: 'heart', ...(attachedTo === undefined ? {} : { attachedTo }) } });
const graph = () => ({ revision: 1, nodes: [text('parent'), text('other', 800, 0), stamp('stamp', 'parent')], edges: [], groups: [], runs: [] });
const moved = (nodes, ids, dx, dy) => nodes.map(node => ids.includes(node.id) ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node);

test('new sticky mounts its focused editor while existing and remote stickies remain in display mode', async () => {
  // Focus reaches the sticky through the canvas store, as in the editor.
  const contents = "export * from './BoardAnnotations.jsx'; export { CanvasContext } from './canvas-context.jsx'; export { createCanvasStore } from './canvas-store.mjs';";
  const result = await build({ stdin: { contents, resolveDir: new URL('../src/', import.meta.url).pathname, loader: 'jsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom', '@xyflow/react'], loader: { '.css': 'empty' }, logLevel: 'silent' });
  const module = { exports: {} }, require = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  const { CanvasContext, StickyNode, createCanvasStore } = module.exports;
  const render = state => renderToStaticMarkup(React.createElement(CanvasContext.Provider, { value: { store: createCanvasStore(state) } }, React.createElement(StickyNode, { id: 'sticky', selected: true, data: { text: '', color: '#fff3ad' }, actions: {} })));
  const initial = render({ focusId: 'sticky', focusControl: 'sticky' });
  assert.match(initial, /<textarea[^>]*autofocus=""/); assert.match(initial, /aria-label="Sticky text"/);
  assert.doesNotMatch(render({ focusId: null, focusControl: 'sticky' }), /<textarea/);
  assert.doesNotMatch(render({ focusId: 'some-prompt', focusControl: 'text' }), /<textarea/);
});

test('stamp attachments validate target identity and type without becoming graph edges', () => {
  const value = graph(); assert.doesNotThrow(() => validateGraph(value));
  value.nodes.push({ id: 'sticky', type: 'sticky', position: { x: 0, y: 0 }, data: { text: '', color: '#fff3ad' } },
    { id: 'image', type: 'image', position: { x: 0, y: 0 }, data: { asset: '12345678-1234-1234-1234-123456789abc.png' } },
    { id: 'drawing', type: 'drawing', position: { x: 0, y: 0 }, data: { points: [[4, 4]], color: '#25243d', width: 4 } });
  for (const attachedTo of ['parent', 'sticky', 'image']) { value.nodes[2].data.attachedTo = attachedTo; assert.doesNotThrow(() => validateGraph(value)); }
  for (const attachedTo of ['missing', 'stamp', 'drawing', '', null, 42, 'x'.repeat(121)]) {
    value.nodes[2].data.attachedTo = attachedTo; assert.throws(() => validateGraph(value), /stamp attachment/);
  }
  delete value.nodes[2].data.attachedTo; assert.doesNotThrow(() => validateGraph(value));
  assert.deepEqual(value.edges, []);
});

test('placement and drop choose the topmost visible target, ignore stamps/drawings and detach on empty canvas', () => {
  const nodes = [text('lower', 0, 0), text('upper', 0, 0), stamp('stamp', 'lower', 0, 0),
    { id: 'sticky', type: 'sticky', position: { x: 20, y: 20 }, data: { text: '', color: '#fff3ad' } },
    { id: 'hidden', type: 'text', hidden: true, zIndex: 10, position: { x: 0, y: 0 }, data: { text: '' } },
    { id: 'drawing', type: 'drawing', zIndex: 20, position: { x: 0, y: 0 }, data: {} }];
  assert.equal(stampTargetAt(nodes, { x: 50, y: 50 }), 'sticky');
  assert.equal(stampTargetAt(nodes, { x: 5, y: 5 }), 'upper');
  assert.equal(stampTargetAt(nodes, { x: -100, y: -100 }), undefined);
  const raised = nodes.map(node => node.id === 'lower' ? { ...node, zIndex: 9 } : node);
  assert.equal(stampTargetAt(raised, { x: 50, y: 50 }), 'lower');
  const attached = attachStampAt(nodes, 'stamp', { x: 50, y: 50 });
  assert.equal(attached[2].data.attachedTo, 'sticky'); assert.equal(nodes[2].data.attachedTo, 'lower');
  assert.equal(Object.hasOwn(attachStampAt(attached, 'stamp', { x: -100, y: -100 })[2].data, 'attachedTo'), false);
  const collapsed = [{ ...text('small', 0, 0), data: { text: '', collapsed: true } }];
  assert.equal(stampTargetAt(collapsed, { x: 71, y: 71 }), 'small'); assert.equal(stampTargetAt(collapsed, { x: 73, y: 73 }), undefined);
});

test('parent and group movement carry stamps once, while direct stamp movement keeps its new position', () => {
  const value = graph(), before = structuredClone(value);
  const next = reconcileStampAttachments(value.nodes, moved(value.nodes, ['parent'], -30, 70));
  assert.deepEqual(next[2].position, { x: 90, y: 200 });
  const both = moved(value.nodes, ['parent', 'stamp'], -30, 70);
  assert.deepEqual(reconcileStampAttachments(value.nodes, both), both);
  const stampOnly = moved(value.nodes, ['stamp'], 60, -10);
  assert.deepEqual(reconcileStampAttachments(value.nodes, stampOnly), stampOnly);
  for (const nodeIds of [['parent'], ['parent', 'stamp']]) {
    const group = { id: 'g', name: 'Group', nodeIds, collapsed: false }, bounds = groupBounds(group, value.nodes);
    const grouped = moveGroup(value.nodes, group, { x: bounds.x + 40, y: bounds.y - 30 });
    assert.deepEqual(grouped[2].position, { x: 160, y: 100 });
  }
  assert.deepEqual(value, before);
});

test('auto-align moves attached stamps with their parent and keeps unattached annotations fixed', () => {
  const value = graph(); value.nodes.push(stamp('free', undefined, -400, 300));
  const aligned = alignNodes(value.nodes, [], []), parent = aligned.find(node => node.id === 'parent'), attached = aligned.find(node => node.id === 'stamp');
  assert.deepEqual(attached.position, { x: parent.position.x + 20, y: parent.position.y + 30 });
  assert.deepEqual(aligned.find(node => node.id === 'free').position, value.nodes[3].position);
  assert.deepEqual(alignNodes(aligned, [], []), aligned);
  const folded = canvasView(value.nodes, [], [{ id: 'g', name: 'Group', collapsed: true, nodeIds: ['parent'] }]);
  assert.equal(folded.nodes.find(node => node.id === 'stamp').hidden, true);
});

test('parent deletion cascades only its stamps and dangling references can be detached without mutation', () => {
  const value = graph(); value.nodes.push(stamp('other-stamp', 'other'));
  const next = reconcileStampAttachments(value.nodes, value.nodes.filter(node => node.id !== 'parent'));
  assert.deepEqual(next.map(node => node.id), ['other', 'other-stamp']);
  const reattached = value.nodes.filter(node => node.id !== 'parent').map(node => node.id === 'stamp' ? { ...node, data: { ...node.data, attachedTo: 'other' } } : node);
  assert.equal(reconcileStampAttachments(value.nodes, reattached).some(node => node.id === 'stamp'), true);
  const detached = detachMissingStampTargets(value.nodes.filter(node => node.id !== 'parent'));
  assert.equal(Object.hasOwn(detached.find(node => node.id === 'stamp').data, 'attachedTo'), false);
  assert.deepEqual(detached.find(node => node.id === 'stamp').position, value.nodes[2].position);
  assert.equal(value.nodes[2].data.attachedTo, 'parent');
});

test('MCP graph edits move and delete attached stamps while snapshot commits preserve exact coordinates', async () => {
  const before = graph(), requested = structuredClone(before); requested.nodes[0].position = { x: 300, y: -100 };
  const next = reconcileStampGraph(before, requested); assert.doesNotThrow(() => validateGraph(next));
  assert.deepEqual(next.nodes[2].position, { x: 320, y: -70 });
  const current = structuredClone(before); await commitGraph(current, next, async () => {});
  const restored = reconcileStampGraph(current, before); assert.deepEqual(restored.nodes, before.nodes);
  const snapshot = structuredClone(before); snapshot.nodes[2].position = { ...current.nodes[2].position };
  await commitGraph(current, snapshot, async () => {}); assert.deepEqual(current.nodes, snapshot.nodes);
  const removed = { ...current, nodes: current.nodes.filter(node => node.id !== 'parent'), groups: [{ id: 'g', name: 'Mixed', collapsed: false, nodeIds: ['stamp', 'other'] }] };
  const result = reconcileStampGraph(current, removed); assert.doesNotThrow(() => validateGraph(result));
  assert.deepEqual(result.nodes.map(node => node.id), ['other']); assert.deepEqual(result.groups[0].nodeIds, ['other']);
  const invalid = { ...before, nodes: [...before.nodes, stamp('bad', 'missing')] };
  assert.throws(() => validateGraph(reconcileStampGraph(before, invalid)), /stamp attachment/);
});

test('duplicate and clipboard include only selected stamps, remap copied parents, and detach stamp-only copies', () => {
  const value = graph(); value.nodes.push(stamp('unselected', 'parent', 140, 150));
  assert.deepEqual(duplicateNodes(value, ['parent']).nodes.map(node => node.type), ['text']);
  const copies = duplicateNodes(value, ['parent', 'stamp']);
  assert.equal(copies.nodes[1].data.attachedTo, copies.nodes[0].id); assert.equal(copies.nodes.length, 2);
  assert.equal(Object.hasOwn(duplicateNodes(value, ['stamp']).nodes[0].data, 'attachedTo'), false);
  const selected = value.nodes.map(node => ({ ...node, selected: ['parent', 'stamp'].includes(node.id) }));
  const clipboard = readNodeClipboard(JSON.stringify(selectedGraph(selected, []))), pasted = cloneSelection(clipboard, { x: -500, y: 50 });
  assert.equal(pasted.nodes[1].data.attachedTo, pasted.nodes[0].id);
  assert.deepEqual(pasted.nodes[1].position, { x: -480, y: 80 });
  const onlyStamp = readNodeClipboard(JSON.stringify(selectedGraph(value.nodes.map(node => ({ ...node, selected: node.id === 'stamp' })), [])));
  assert.equal(Object.hasOwn(onlyStamp.nodes[0].data, 'attachedTo'), false);
  assert.equal(value.nodes[2].data.attachedTo, 'parent');
});
