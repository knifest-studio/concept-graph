import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer, transformWithEsbuild } from 'vite';
import { maxModel3dImages, maxUpscaleImages, modelerOf, modelers, upscalerOf, upscalers, upscaleScale, variantPresets } from '../graph.mjs';
import { details } from '../src/analytics-core.mjs';
import { plural, t } from '../src/i18n.mjs';

// main.jsx and CloudWorkspace.jsx are run in parts, with the tab around them replaced by stand-ins.
const main = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const workspace = await readFile(new URL('../src/CloudWorkspace.jsx', import.meta.url), 'utf8');
const part = (source, from, to) => { const start = source.indexOf(from); assert.ok(start >= 0, from); const end = source.indexOf(to, start); assert.ok(end > start, to); return source.slice(start, end); };
const run = (code, env, result) => new Function(...Object.keys(env), `${code}; return ${result};`)(...Object.values(env));
const ref = current => ({ current });

function toasts(cloud = true) {
  const events = [], shown = [];
  const env = { useRef: ref, useCallback: callback => callback, cloud, track: (name, fields, kind = 'app') => events.push([name, details(fields), kind]), setToast: message => shown.push(message),
    toastTimer: ref(null), setTimeout: () => 1, clearTimeout() {} };
  const { notify, inform } = run(part(main, '  const saveFn = useRef(null);\n', '  const refreshTemplates'), env, '{ notify, inform }');
  return { notify, inform, events, shown };
}

test('a toast is an error row only when it reports a problem; news is counted by a fixed ID or not at all', () => {
  const tab = toasts();
  tab.notify('Canvas is too large.');
  tab.inform('Image copied.', 'image_copied');
  tab.inform('Coming: Ann, Bo');
  assert.deepEqual(tab.shown, ['Canvas is too large.', 'Image copied.', 'Coming: Ann, Bo'], 'every toast still shows');
  assert.deepEqual(tab.events, [['notify', { message: 'Canvas is too large.' }, 'error'], ['notice', { target: 'image_copied' }, 'app']]);
  // The local app sends no analytics at all.
  const local = toasts(false);
  local.notify('Canvas is too large.'); local.inform('Image copied.', 'image_copied');
  assert.deepEqual([local.events, local.shown.length], [[], 2]);
});

test('copies and the editor’s confirmations or teammates’ news are not error rows', async () => {
  const logged = [], env = { mcpLocked: ref(false), t, cloudSession: {}, location: { origin: 'https://example.test' }, nodePath: (board, node) => `/b/${board}/n/${node}`, boardId: 'board',
    inform: (message, notice) => logged.push(['news', message, notice]), notify: message => logged.push(['error', message]), navigator: { clipboard: { writeText: async () => {} } },
    document: { execCommand: () => false, createElement: () => ({ style: {}, select() {}, remove() {} }), body: { appendChild() {} } } };
  const copy = run(part(main, '  const copyNodeLink = nodeId => {', '\n  useEffect(() => {\n    if (!loaded) return;'), env, '{ copyNodeLink, copyText }');
  copy.copyNodeLink('node'); copy.copyText('node'); await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(logged.map(([kind, , notice]) => [kind, notice]), [['news', 'link_copied'], ['news', 'id_copied']]);
  env.navigator.clipboard.writeText = async () => { throw new Error('Denied'); };
  logged.length = 0; copy.copyText('node'); await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(logged, [['error', 'Could not copy the ID.']], 'a copy that fails is still an error');
  assert.match(main, /copyText\(row\.value, row\.copy === 'id' \? t\('ID copied\.'\) : t\('File name copied\.'\), t\('Could not copy the ID\.'\), `\$\{row\.copy\}_copied`\)/);
  // No confirmation, progress note or teammate's news is passed to notify anywhere in the editor or the cloud board.
  const news = ['Image copied.', 'copied.', 'Prompt changed — review', 'Signed in to ChatGPT.', 'Some images have generic names', 'Converting {name} to GLB', 'Uploaded a smaller copy',
    'Your agent started a generation', 'Deleted “{name}”', 'Generate an image first', 'isn’t looking at the board', 'added to your canvas', 'Called {', 'Coming: {names}', 'Not now: {names}',
    'Wait a few seconds before calling again.', 'Nobody else is on this board right now.', '{name} has left the board.', 'site.note'];
  const calls = source => [...source.matchAll(/\bnotify(?:\?\.)?\(/g)].map(match => {
    let depth = 0, index = match.index + match[0].length - 1;
    do { if (source[index] === '(') depth++; else if (source[index] === ')') depth--; index++; } while (depth && index < source.length);
    return source.slice(match.index, index);
  });
  const found = [...calls(main), ...calls(workspace)];
  assert.ok(found.length > 40, 'the scan finds the editor’s notify calls');
  for (const call of found) for (const text of news) assert.ok(!call.includes(text), `${call} is news, not a problem`);
});

test('call toasts are counted as notices, and the list of answers is not counted at all', () => {
  const logged = [], next = { inform: (message, notice) => logged.push(['news', message, notice]), notify: message => logged.push(['error', message]) };
  const callMessage = run(part(workspace, '    const callMessage = value => {', '    // The room forgets presence'), { next, t, plural, setCall() {}, user: { name: 'Ann' } }, 'callMessage');
  next.calling = { name: 'Bo', everyone: true, coming: [], later: [] };
  callMessage({ type: 'attention-sent', id: 'call', people: 3 });
  callMessage({ type: 'attention-reply', id: 'call', answer: 'coming', from: { name: 'Bo' } });
  callMessage({ type: 'attention-reply', id: 'call', answer: 'later', from: { name: 'Cy' } });
  for (const reason of ['busy', 'alone', 'left']) callMessage({ type: 'attention-failed', reason });
  assert.deepEqual(logged.map(([kind, , notice]) => [kind, notice]), [['news', 'call_sent'], ['news', undefined], ['news', undefined], ['news', 'call_busy'], ['news', 'call_alone'], ['news', 'call_left']]);
  assert.deepEqual(logged.map(([, message]) => message), ['Called 3 people here', 'Coming: Bo', 'Coming: Bo · Not now: Cy', 'Wait a few seconds before calling again.', 'Nobody else is on this board right now.', 'Bo has left the board.']);
});

test('voice invite toasts say invited and joining, count once as news, and an invite is not shown to someone already in voice', () => {
  const logged = [], calls = [], next = { inform: (message, notice) => logged.push(['news', message, notice]), notify: message => logged.push(['error', message]), voiceStore: { get: () => ({ joined: true }) } };
  const callMessage = run(part(workspace, '    const callMessage = value => {', '    // The room forgets presence'), { next, t, plural, setCall: value => calls.push(value), user: { name: 'Ann' } }, 'callMessage');
  next.calling = { name: 'Bo', everyone: false, voice: true, coming: [], later: [] };
  callMessage({ type: 'attention-sent', id: 'call', voice: true, people: 1 });
  callMessage({ type: 'attention-reply', id: 'call', answer: 'coming', from: { name: 'Bo' } });
  next.calling = { name: '', everyone: true, voice: true, coming: [], later: [] };
  callMessage({ type: 'attention-sent', id: 'all', voice: true, people: 3 });
  assert.deepEqual(logged.map(([kind, message, notice]) => [kind, message, notice]), [['news', 'Invited Bo to voice', 'voice_invite_sent'], ['news', 'Joining voice: Bo', undefined], ['news', 'Invited 3 people to voice', 'voice_invite_sent']]);
  callMessage({ type: 'attention', id: 'x', voice: true, everyone: true, from: { name: 'Bo', clientId: 2 } });
  assert.deepEqual(calls, [], 'already in voice');
});

test('upscaler, size, 3D generator and variant buttons inside a prompt carry fixed analytics names', async () => {
  const { code } = await transformWithEsbuild(part(main, 'const upscaleOptions =', '\nconst ModelNode = props'), 'nodes.jsx', { loader: 'jsx', jsx: 'transform' });
  const view = { active: false, starting: false, timer: '', byName: '', userName: 'Ann', images: 1, nanoReady: true, nanoNote: '', falReady: true, readOnly: false, focus: false, runId: null, error: '' };
  const env = { React, t, plural, upscalers, upscalerOf, upscaleScale, maxUpscaleImages, modelers, modelerOf, maxModel3dImages, useCanvas: () => ({}), useCanvasValue: () => view, shallowEqual() {}, useEffect() {},
    runView() {}, noInputs: {}, failedRun: () => false, NanoReadiness: () => null, NodeContextMenu: ({ children }) => children, Handle: () => null, Position: { Left: 'left', Right: 'right' }, Icon: () => null };
  const { UpscaleNode, Model3dNode } = run(code, env, '{ UpscaleNode, Model3dNode }');
  const names = element => [...renderToStaticMarkup(element).matchAll(/data-analytics-name="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(names(React.createElement(UpscaleNode, { id: 'u', data: { task: 'upscale', text: '' } })), ['Upscaler: Topaz', 'Upscaler: SeedVR2', 'Upscaler: Nano Banana', 'Upscale size: ×2', 'Upscale size: ×4']);
  assert.deepEqual(names(React.createElement(UpscaleNode, { id: 'u', data: { task: 'upscale', upscaler: 'nano-banana', text: '' } })).slice(-2), ['Upscale size: 2K', 'Upscale size: 4K']);
  assert.deepEqual(names(React.createElement(Model3dNode, { id: 'm', data: { task: 'model3d', text: '' } })), ['3D generator: Hunyuan 3D', '3D generator: TRELLIS 2', '3D generator: Rodin', '3D generator: Tripo']);
  for (const name of ['Upscaler: Topaz', 'Upscale size: ×2', '3D generator: TRELLIS 2', 'Variants: 4']) assert.equal(details({ target: name }).target, name, 'the name survives the analytics filter');
  const vite = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { VariantRow } = await vite.ssrLoadModule('/src/GeneratorPicker.jsx');
    const row = names(React.createElement(VariantRow, { id: 'p', variants: 2, choose() {}, compact: true }));
    assert.deepEqual(row, variantPresets.map(count => `Variants: ${count}`));
  } finally { await vite.close(); }
});

test('the shortcut conflict question is a notice, not an error', async () => {
  const settings = await readFile(new URL('../src/ShortcutSettings.jsx', import.meta.url), 'utf8');
  assert.match(settings, /<div className="shortcut-conflict" role="alert" data-analytics-notice="shortcut_conflict">/);
  // A key the browser keeps or that cannot change is still a problem.
  assert.match(settings, /<p className="shortcut-notice" role="alert">/);
});
