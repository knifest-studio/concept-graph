import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addEdge } from '@xyflow/react';
import { transformWithEsbuild } from 'vite';
import { isGptImage, nameImageConnections } from '../graph.mjs';
import { lodHandleProps } from '../src/canvas.mjs';
import { captureHistory } from '../src/history.mjs';
import { setLanguage, t } from '../src/i18n.mjs';

const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const prompt = () => ({ id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: 'Edit', generator: 'gpt-image' } });
const image = id => ({ id, type: 'image', position: { x: 0, y: 0 }, data: { asset: '12345678-1234-1234-1234-123456789abc.png', caption: id } });

test('prompt input ports keep the unnamed handle first and localize the visible main-image label', async () => {
  const component = source.slice(source.indexOf('function PromptInputs('), source.indexOf('\nfunction FullTextNode('));
  const { code } = await transformWithEsbuild(component, 'ports.jsx', { loader: 'jsx', jsx: 'transform' });
  const Handle = ({ type, position, ...props }) => React.createElement('i', { ...props, 'data-port': props.id || 'default' });
  const Inputs = new Function('React', 'Handle', 'Position', 'isGptImage', 'lodHandleProps', 't', `${code}; return PromptInputs;`)(React, Handle, { Left: 'left' }, isGptImage, lodHandleProps, t);
  try {
    for (const [language, label] of [['en', 'Main image'], ['uk', 'Основне зображення']]) {
      setLanguage(language);
      const html = renderToStaticMarkup(React.createElement(Inputs, { data: prompt().data }));
      assert.ok(html.indexOf('data-port="default"') < html.indexOf('data-port="main"'));
      assert.match(html, /top:68%/); assert.match(html, /top:16px/);
      assert.ok(html.includes(`aria-label="${label}"`)); assert.ok(html.includes(`>${label}</span>`));
      assert.ok(renderToStaticMarkup(React.createElement(Inputs, { data: prompt().data, light: true })).includes(`>${label}</span>`));
    }
    for (const data of [{ text: '' }, { text: '', generator: 'nano-banana' }, { text: '', generator: 'gpt-image', task: 'describe' }, { text: '', generator: 'gpt-image', task: 'upscale' }]) {
      assert.doesNotMatch(renderToStaticMarkup(React.createElement(Inputs, { data })), /data-port="main"|main-image-label/);
    }
  } finally { setLanguage('en'); }
});

test('the canvas connect handler promotes, replaces and clears main in one undo checkpoint without duplicate edges', () => {
  const handler = source.slice(source.indexOf('  const connect = connection => {'), source.indexOf('  const connectEnd ='));
  const nodeRef = { current: [prompt(), image('a'), image('b'), { ...prompt(), id: 'context' }] }, edgeRef = { current: [{ id: 'ap', source: 'a', target: 'p' }] };
  const checkpoints = [], notifications = [];
  const checkpoint = () => checkpoints.push(captureHistory({ nodes: nodeRef.current, edges: edgeRef.current, groups: [] }));
  const connect = new Function('mcpLocked', 'slideSource', 'nodeRef', 'edgeRef', 'notify', 't', 'isGptImage', 'checkpoint', 'addEdge', 'id', 'cloud', 'track', 'effects', 'putNodes', 'nameImageConnections', 'putEdges', 'markDirty', `${handler}; return connect;`)(
    { current: false }, id => id, nodeRef, edgeRef, message => notifications.push(message), t, isGptImage, checkpoint, addEdge, () => 'bp', false, () => {}, { createEdges() {} },
    update => { nodeRef.current = update(nodeRef.current); }, nameImageConnections, edges => { edgeRef.current = edges; }, () => {});
  const attach = (source, targetHandle) => connect({ source, target: 'p', targetHandle });
  attach('context', 'main'); assert.equal(checkpoints.length, 0); assert.match(notifications.pop(), /Connect an image/);
  attach('missing', 'main'); assert.equal(checkpoints.length, 0); assert.match(notifications.pop(), /Connect an image/);
  attach('a', 'main'); assert.equal(nodeRef.current[0].data.mainImage, 'a'); assert.equal(edgeRef.current.length, 1); assert.equal(checkpoints.length, 1);
  attach('b', 'main'); assert.equal(nodeRef.current[0].data.mainImage, 'b'); assert.equal(edgeRef.current.length, 2); assert.equal(checkpoints.length, 2);
  assert.ok(edgeRef.current.every(edge => Object.keys(edge).sort().join() === 'id,source,target'));
  attach('b', null); assert.equal(nodeRef.current[0].data.mainImage, undefined); assert.equal(edgeRef.current.length, 2); assert.equal(checkpoints.length, 3);
  let undo = JSON.parse(checkpoints.pop()); nodeRef.current = undo.nodes; edgeRef.current = undo.edges;
  assert.equal(nodeRef.current[0].data.mainImage, 'b');
  undo = JSON.parse(checkpoints.pop()); nodeRef.current = undo.nodes; edgeRef.current = undo.edges;
  assert.equal(nodeRef.current[0].data.mainImage, 'a'); assert.equal(edgeRef.current.length, 1);
  undo = JSON.parse(checkpoints.pop()); assert.equal(undo.nodes[0].data.mainImage, undefined); assert.equal(undo.edges.length, 1);
  edgeRef.current = [{ id: 'pa', source: 'p', target: 'a' }]; attach('a', 'main');
  assert.equal(checkpoints.length, 0); assert.match(notifications.pop(), /loop/);
});

test('switching a prompt to GPT Image makes its first connected image the main one', async () => {
  const { mainImageFor } = await import('../graph.mjs');
  const nodes = [{ ...prompt(), data: { text: 'Edit' } }, image('a'), image('b'), { id: 'note', type: 'text', position: { x: 0, y: 0 }, data: { text: 'Context' } }];
  const edges = [{ id: 'np', source: 'note', target: 'p' }, { id: 'bp', source: 'b', target: 'p' }, { id: 'ap', source: 'a', target: 'p' }];
  const as = data => ({ ...nodes[0], data: { ...nodes[0].data, ...data } });
  assert.equal(mainImageFor(nodes, edges, as({ generator: 'gpt-image' })), 'b');
  assert.equal(mainImageFor(nodes, edges, as({ generator: 'gpt-image', mainImage: 'a' })), 'a');
  assert.equal(mainImageFor(nodes, edges, as({ generator: 'gpt-image', mainImage: 'gone' })), 'b');
  assert.equal(mainImageFor(nodes, edges, as({ generator: 'nano-banana' })), undefined);
  assert.equal(mainImageFor(nodes, [edges[0]], as({ generator: 'gpt-image' })), undefined);
  assert.match(source, /const main = mainImageFor\(current, edgeRef\.current, \{ \.\.\.item, data \}\); if \(main\) data\.mainImage = main;/);
});
