import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { keepDialogFocus, restoreDialogFocus } from '../src/dialog-focus.mjs';

test('run details show recorded agent activity and handle older or malformed boards', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { RunDiagnostics } = await vite.ssrLoadModule('/src/RunDiagnostics.jsx');
    const render = run => renderToStaticMarkup(React.createElement(RunDiagnostics, { run, loadRun: async () => null, onClose() {} }));
    const run = { id: 'r', status: 'error', target: { data: { text: 'A blue bird' } }, prompt: 'Sent prompt', error: 'Not generated', diagnostics: {
      requestedModel: 'luna', requestedEffort: 'low', model: 'luna', effort: 'medium', events: [{ type: 'agent_message', at: '2026-01-01T00:00:00Z', text: 'No image' }], usage: { inputTokens: 50 },
    } };
    const html = render(run);
    for (const value of ['A blue bird', 'Sent prompt', 'No image', 'luna', 'low', 'medium', 'Not generated', '50', 'included in board exports']) assert.ok(html.includes(value), value);
    assert.match(html, /Text sent to agent/);
    assert.match(html, /Attached reference images are sent separately/);
    assert.match(render({ id: 'queued', status: 'queued' }), /Waiting for this run to start/);
    assert.match(render({ id: 'old', status: 'error', target: { data: { model: 'old-model' } } }), /old-model/);
    assert.match(render({ id: 'old', status: 'error' }), /Diagnostics were not recorded for this run/);
    assert.doesNotThrow(() => render({ id: 'bad', status: 'error', diagnostics: { model: {}, events: [{ type: 'constructor', text: {} }, null], usage: [] } }));
    assert.doesNotThrow(() => render({ id: 'bad', status: 'error', diagnostics: { events: {} } }));
  } finally { await vite.close(); }
});

test('dialog traps tab at its boundaries and restores focus only to a connected element', () => {
  const focused = [];
  const control = (name, visible = true) => ({ getClientRects: () => visible ? [1] : [], focus: () => focused.push(name) });
  const first = control('first'), last = control('last'), hidden = control('hidden', false);
  const ownerDocument = { activeElement: first };
  const root = { ownerDocument, querySelectorAll: () => [first, hidden, last] };
  let prevented = false;
  const event = { key: 'Tab', shiftKey: true, currentTarget: root, preventDefault: () => { prevented = true; } };
  keepDialogFocus(event);
  assert.equal(prevented, true); assert.deepEqual(focused, ['last']);
  ownerDocument.activeElement = last; event.shiftKey = false; prevented = false;
  keepDialogFocus(event);
  assert.equal(prevented, true); assert.deepEqual(focused, ['last', 'first']);
  ownerDocument.activeElement = first; prevented = false;
  keepDialogFocus(event);
  assert.equal(prevented, false);
  restoreDialogFocus({ isConnected: false, focus: () => focused.push('disconnected') });
  restoreDialogFocus({ isConnected: true, focus: () => focused.push('previous') });
  assert.deepEqual(focused, ['last', 'first', 'previous']);
});
