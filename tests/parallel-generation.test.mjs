import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { codexGenerator, generators, withGenerator } from '../graph.mjs';
import { nanoState, promptGenerators } from '../src/generator.mjs';
import { loadGeneratorButtons } from './generator-buttons.mjs';
import { runAnalytics } from '../src/generation-analytics.mjs';
import { setLanguage } from '../src/i18n.mjs';

const nano = generators.nanoBanana, gpt = generators.gptImage;
const ready = nanoState({ configured: true, allowed: true, dailyImages: 100, usedToday: 2, monthlyUsd: 100, teamSpentUsd: 0 }), spent = nanoState({ configured: true, allowed: true, dailyImages: 100, usedToday: 100, monthlyUsd: 100, teamSpentUsd: 0 });
const unavailable = nanoState({ configured: false });
const offer = options => promptGenerators({ cloud: true, known: true, codexReady: true, nano: ready, gpt: ready, ...options });

test('model availability covers all three, API-only, Codex-only, unknown status, limits and access requests', () => {
  assert.deepEqual(offer().models.map(model => model.generator), [codexGenerator, nano, gpt]);
  const api = offer({ codexReady: false });
  assert.deepEqual(api.models.map(model => model.generator), [nano, gpt]); assert.equal(api.connect, true);
  for (const options of [{ cloud: false }, { nano: unavailable, gpt: unavailable }, { known: false, codexReady: false }]) {
    assert.deepEqual(offer(options).models.map(model => model.generator), [codexGenerator]); assert.equal(offer(options).connect, false);
  }
  assert.equal(offer({ nano: spent }).models.find(model => model.generator === nano).disabled, true);
  assert.equal(offer({ describe: true, nano: spent }).models.find(model => model.generator === nano).disabled, false);
  assert.equal(offer({ nano: nanoState({ configured: true, allowed: false }) }).request, true);
  assert.deepEqual(offer({ nano: unavailable, codexReady: false }).models.map(model => model.generator), [gpt]);
});

test('model buttons keep independent progress, ownership, limits and setup controls', async () => {
  const { GeneratorButtons } = await loadGeneratorButtons();
  const render = props => renderToStaticMarkup(React.createElement(GeneratorButtons, { id: 'p', cloud: true, canRun: true, userName: 'Me', nano: ready, gpt: ready, ...offer(), ...props }));
  const runs = { codex: { active: true, runId: 'c', byName: 'Me', timer: '12s' }, [gpt]: { active: true, runId: 'g', byName: 'Olena', timer: '4s' } };
  const markup = render({ runs });
  assert.equal((markup.match(/class="model-progress"/g) || []).length, 2);
  assert.match(markup, /Codex · 12s/); assert.match(markup, /GPT Image · \(Olena\)/);
  assert.match(markup, /aria-label="Cancel Codex"/); assert.doesNotMatch(markup, /aria-label="Cancel GPT Image"/);
  assert.match(markup, /aria-label="Generate with Nano Banana" aria-busy="false"[^>]*data-tooltip="[^"]+"(?! disabled)/);
  assert.doesNotMatch(render({ runs, readOnly: true }), /class="model-cancel"/);
  assert.match(render({ ...offer({ codexReady: false }) }), />Connect Codex<\/button>/);
  setLanguage('uk');
  try { assert.match(render({ ...offer({ codexReady: false }) }), />Підключити Codex<\/button>/); }
  finally { setLanguage('en'); }
});

test('a click snapshot preserves the graph and its actual provider before the room record arrives', () => {
  const graph = { nodes: [{ id: 'p', type: 'text', data: { text: 'robot', generator: gpt } }], edges: [], runs: [] }, before = structuredClone(graph);
  const clicked = withGenerator(graph, 'p', nano);
  assert.equal(clicked.nodes[0].data.generator, nano); assert.deepEqual(graph, before);
  assert.equal(withGenerator(graph, 'p', codexGenerator).nodes[0].data.generator, undefined);
  assert.equal(runAnalytics({ id: 'n', nodeId: 'p', provider: nano }, graph).generator, nano);
  assert.equal(runAnalytics({ id: 'g', nodeId: 'p', provider: gpt }, undefined).generator, gpt);
});
