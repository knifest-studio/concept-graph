import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { codexGenerator, describeTask, generators, upscaleTask } from '../graph.mjs';
import { generatorKind, lastGeneratorKey, nanoState, readLastGenerators, rememberGenerator, startingGenerator } from '../src/generator.mjs';
import { invitationDue } from '../src/custom-node-discovery.mjs';
import { firstPromptStep } from '../src/first-prompt.mjs';
import { setLanguage, t } from '../src/i18n.mjs';
import { signSession } from '../cloud/auth.mjs';

// The team's first day on the cloud site (Nov 16 2026): new prompts started on Codex, so people without the helper were
// sent to pair it; the team-key options were disabled without a word; and the first thing a newcomer saw was the
// custom-node invitation instead of where to write a prompt.
const memory = () => { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) }; };
const allowed = nanoState({ configured: true, allowed: true, dailyImages: 100, usedToday: 3, monthlyUsd: 100, teamSpentUsd: 4 });
const noAccess = nanoState({ configured: true, allowed: false }), unknown = nanoState(undefined), spent = nanoState({ configured: true, allowed: true, dailyImages: 100, usedToday: 100, monthlyUsd: 100, teamSpentUsd: 4 });

test('a new prompt starts on the generator that works for this person, and on Codex where Codex is all they have', () => {
  const start = options => startingGenerator({ known: true, nano: allowed, gpt: allowed, codexReady: false, ...options });
  // Nov 16: team access, no helper. Image prompts and describe nodes start on the team key instead of opening pairing.
  assert.equal(start({}), generators.nanoBanana);
  assert.equal(start({ describe: true }), generators.nanoBanana);
  // The generator this person last used wins while it still works for them; a describe node never gets GPT Image.
  assert.equal(start({ last: generators.gptImage }), generators.gptImage);
  assert.equal(start({ describe: true, last: generators.gptImage }), generators.nanoBanana);
  assert.equal(start({ last: codexGenerator, codexReady: true }), null);
  assert.equal(start({ last: generators.nanoBanana, codexReady: true }), generators.nanoBanana);
  // Codex stays the default where it is the only option, or ready with nothing else chosen before.
  assert.equal(start({ nano: noAccess, gpt: noAccess }), null);
  assert.equal(start({ codexReady: true }), null);
  assert.equal(start({ last: generators.nanoBanana, nano: noAccess, gpt: noAccess, codexReady: true }), null, 'access taken away: back to Codex');
  // A used-up day keeps image prompts off the team key; a description costs no daily images, so it still may use it.
  assert.equal(start({ nano: spent, gpt: spent }), null);
  assert.equal(start({ describe: true, nano: spent, gpt: spent }), generators.nanoBanana);
  // Before the site says what this person may use, only a generator they used before is assumed to work.
  assert.equal(start({ known: false, nano: unknown, gpt: unknown }), null);
  assert.equal(start({ known: false, nano: unknown, gpt: unknown, last: generators.nanoBanana }), generators.nanoBanana);
});

test('the last generator is remembered per kind, and upscale or 3D nodes are not remembered', () => {
  const storage = memory();
  assert.deepEqual(readLastGenerators(storage), {});
  rememberGenerator({ text: '' }, generators.gptImage, storage);
  rememberGenerator({ task: describeTask }, generators.nanoBanana, storage);
  rememberGenerator({ task: describeTask }, generators.gptImage, storage);
  rememberGenerator({ task: upscaleTask }, generators.nanoBanana, storage);
  assert.deepEqual(readLastGenerators(storage), { image: generators.gptImage, describe: generators.nanoBanana });
  rememberGenerator({ text: '' }, undefined, storage);
  assert.equal(readLastGenerators(storage).image, codexGenerator);
  storage.values.set(lastGeneratorKey, 'broken');
  assert.deepEqual(readLastGenerators(storage), {});
  assert.deepEqual([generatorKind({}), generatorKind({ task: describeTask }), generatorKind({ task: upscaleTask })], ['image', 'describe', null]);
});

// The editor's own code, run with the tab around it replaced by stand-ins.
const editor = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const part = (start, end) => editor.slice(editor.indexOf(start), editor.indexOf(end, editor.indexOf(start)));
const ref = current => ({ current });

test('prompts the editor adds start on the team key for someone with access and no helper', () => {
  const source = part('  const startOn = data => {', '  const addText = ');
  const startOn = (options = {}) => new Function('cloud', 'generatorKind', 'startingGenerator', 'readLastGenerators', 'readinessRef', 'cloudSession', 'nanoRef', 'gptRef', `${source}; return startOn;`)(
    options.cloud ?? true, generatorKind, startingGenerator, () => options.last || {}, ref({ key: options.readiness || 'helper' }), { nano: options.status === undefined ? {} : options.status }, ref(options.nano || allowed), ref(options.nano || allowed));
  assert.deepEqual(startOn()({}), { generator: generators.nanoBanana });
  assert.deepEqual(startOn()({ task: describeTask }), { generator: generators.nanoBanana });
  assert.deepEqual(startOn()({ task: upscaleTask, upscaler: 'topaz', scale: 2 }), {}, 'upscale and 3D nodes keep their own controls');
  assert.deepEqual(startOn({ readiness: 'ready' })({}), {});
  assert.deepEqual(startOn({ nano: noAccess })({}), {});
  assert.deepEqual(startOn({ cloud: false })({}), {}, 'the local app has only Codex');
  assert.deepEqual(startOn({ readiness: 'ready', last: { image: generators.nanoBanana } })({}), { generator: generators.nanoBanana });
  // Every place that makes a prompt or describe node goes through it.
  assert.match(editor, /data: \{ text, createdAt: new Date\(\)\.toISOString\(\), \.\.\.startOn\(extra\),/);
  assert.match(editor, /data: \{ text: '', createdAt: new Date\(\)\.toISOString\(\), \.\.\.startOn\(\{\}\) \} \}, nodePage/);
});

test('Generate on a Codex prompt without the helper offers the team key beside the pairing steps', async () => {
  setLanguage('en');
  const source = part('  const run = async (nodeId, resumeIntent = null, event) => {', '  runAction.current = run;');
  const tab = ({ nano = allowed, known = true, readiness = 'helper', task } = {}) => {
    const calls = [], node = { id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: 'A robot', ...(task ? { task } : {}) } };
    const env = { alive: ref(true), pairing: false, mcpLocked: ref(false), readOnlyRef: ref(false), generationIntent: () => ({ nodeId: 'p' }), currentGraph: () => ({ nodes: [node], edges: [] }), boardId: 'b',
      notify() {}, inform() {}, starting: null, generationStarting: ref(false), nodeRef: ref([node]), cloud: true, usesSiteGenerator: () => false, model3dTask: 'model3d', generators, isDescribe: () => false,
      model3dRef: ref(nano), gptRef: ref(nano), nanoRef: ref(nano), readinessRef: ref({ key: readiness }), pendingIntent: ref(null), generatorKind, startingGenerator, rememberGenerator() {}, t,
      fixReadiness: () => calls.push(['fix']), cloudSession: { nano: known ? {} : undefined, openPair: (...args) => calls.push(['pair', ...args]) }, track() {}, promptAnalytics: () => ({}),
      setGenerator: (id, generator) => calls.push(['generator', id, generator]), runAction: ref(id => calls.push(['run', id])) };
    return { run: new Function(...Object.keys(env), `${source}; return run;`)(...Object.values(env)), calls };
  };
  let { run, calls } = tab();
  await run('p');
  const [[kind, callback, downloads, alternative]] = calls;
  assert.deepEqual([kind, callback, downloads, alternative.label, alternative.title], ['pair', null, false, 'Generate with Nano Banana', 'Or use the team’s API key']);
  assert.match(alternative.note, /This prompt generates with Codex\. Nano Banana on the team’s key/);
  alternative.run();
  assert.deepEqual(calls.slice(1), [['generator', 'p', generators.nanoBanana], ['run', 'p']]);
  ({ run, calls } = tab({ task: describeTask }));
  await run('p');
  assert.equal(calls[0][3].label, 'Describe with Gemini');
  // Without team access, before the site answers, or with the helper paired but Codex signed out: setup as before.
  for (const options of [{ nano: noAccess }, { known: false }, { readiness: 'signin' }]) { ({ run, calls } = tab(options)); await run('p'); assert.deepEqual(calls, [['fix']]); }
});

test('a team-key option this person cannot use says why and who gives access, instead of ignoring the click', async () => {
  setLanguage('en');
  const named = nanoState({ configured: true, allowed: false, admins: ['Olena', 'Taras'] });
  assert.deepEqual([named.selectable, named.short, named.note], [false, 'no access', 'Not available for your account yet. Ask Olena, Taras: site admins give access in Team access.']);
  assert.equal(nanoState({ configured: true, allowed: false }, 'model3d', { admins: ['Olena'] }).note, '3D generation isn’t available for your account yet. Ask Olena: site admins give access in Team access.');
  assert.equal(nanoState({ configured: false }).short, 'not set up');
  assert.equal(noAccess.note, 'Not available for your account. Ask a site admin for access.', 'no names known: the old wording');
  setLanguage('uk');
  assert.match(nanoState({ configured: true, allowed: false, admins: ['Olena'] }).note, /^Поки недоступно для вашого облікового запису\. Попросіть Olena/);
  setLanguage('en');
  const vite = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  let html;
  try { const { GeneratorPicker } = await vite.ssrLoadModule('/src/GeneratorPicker.jsx'); html = renderToStaticMarkup(React.createElement(GeneratorPicker, { id: 'p', generator: undefined, nano: named, gpt: named, choose() {} })); }
  finally { await vite.close(); }
  assert.doesNotMatch(html, /<option value="nano-banana" disabled/); assert.doesNotMatch(html, /<option value="gpt-image" disabled/);
  assert.match(html, /<option value="nano-banana">Nano Banana · no access<\/option>/);
  assert.match(html, /data-tooltip="Nano Banana \/ GPT Image · Not available for your account yet\. Ask Olena, Taras/);
  // The editor hands each prompt's picker the short reason as well as the note.
  assert.match(editor, /nano=\{\{ selectable: view\.nanoSelectable, note: view\.nanoNote, short: view\.nanoShort, requestable: view\.nanoRequestable, budget: view\.nanoBudget \}\} request=\{canvas\.requestAccess\} gpt=\{\{ selectable: view\.gptSelectable, note: view\.gptNote, short: view\.gptShort,/);
  assert.match(editor, /nanoShort: nano\.short,/); assert.match(editor, /gptShort: gpt\.short,/);
  // Choosing it explains and keeps the prompt as it is.
  const source = part('  const setGenerator = (nodeId, generator) => {', '  const toggleNodeCollapsed = ');
  const told = [], changed = [];
  const setGenerator = new Function('nodeRef', 'mcpLocked', 'gptRef', 'nanoRef', 'inform', 'cloudSession', 'checkpoint', 'putNodes', 'markDirty', 'rememberGenerator', 'generators', 'edgeRef', 'mainImageFor', `${source}; return setGenerator;`)(
    ref([{ id: 'p', type: 'text', data: { text: 'A robot' } }]), ref(false), ref(named), ref(named), (message, notice) => told.push([message, notice]), { refreshNano() {} }, () => {}, value => changed.push(value), () => {}, () => {}, generators, ref([]), () => undefined);
  setGenerator('p', generators.nanoBanana);
  assert.deepEqual([told, changed], [[[named.note, 'generator_unavailable']], []]);
});

test('a newcomer is shown where to write a first prompt and run it; the custom-node invitation waits for their first image', () => {
  const done = { prompt: false, generate: false };
  const step = options => firstPromptStep({ dismissed: false, readOnly: false, emptyBoard: false, done, startedRuns: 0, ownPrompt: null, ...options });
  assert.equal(step({}), 'add');
  assert.equal(step({ emptyBoard: true }), null, 'an empty board already says how to start');
  assert.equal(step({ done: { prompt: true, generate: false }, ownPrompt: { id: 'p' } }), 'write');
  assert.equal(step({ done: { prompt: true, generate: false }, ownPrompt: { id: 'p' }, startedRuns: 1 }), null);
  assert.equal(step({ done: { prompt: true, generate: false } }), null, 'a prompt from an earlier visit is not pointed at');
  assert.equal(step({ dismissed: true }), null); assert.equal(step({ readOnly: true }), null);
  const due = options => invitationDue({ loaded: true, canvas: true, readOnly: false, generated: true, discovery: {}, ...options });
  assert.equal(due({ generated: false }), false, 'not in a newcomer’s first second');
  assert.equal(due({}), true);
  assert.equal(due({ discovery: { invitationSeen: true } }), false); assert.equal(due({ discovery: { used: true } }), false);
  // Only an image prompt is pointed at; a describe node added first does not count as the prompt to write.
  assert.match(editor, /if \(!firstPrompt\.current && !node\.data\.task && !guide\.state\.ownRuns\.length\) firstPrompt\.current = node\.id;/);
  // The checklist does not send someone who can use the team key to set up the helper first.
  assert.match(editor, /checklistSteps\(guide\.state, helperNeeded && !siteReady,/);
});

// The site tells someone without access who can give it: the owner's and admins' names as boards show them, no emails.
let DatabaseSync, worker, Directory;
if (nodeModule.registerHooks) {
  ({ DatabaseSync } = await import('node:sqlite'));
  const hooks = nodeModule.registerHooks({ resolve(specifier, context, next) {
    if (specifier !== 'cloudflare:workers') return next(specifier, context);
    return { url: 'data:text/javascript,' + encodeURIComponent('export const env = {}; export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), shortCircuit: true };
  } });
  try { ({ default: worker, Directory } = await import('../cloud/worker.mjs')); } finally { hooks.deregister(); }
}
function site(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const sql = { exec(query, ...bindings) { const rows = database.prepare(query).all(...bindings).map(row => ({ ...row })); return { toArray: () => rows }; } };
  const env = { SESSION_SECRET: 'session-test', GEMINI_API_KEY: 'test-key', SITE_OWNER_EMAIL: 'owner@studio.example', NANO_BANANA_ALLOWED: 'artist@studio.example', Directory: { idFromName: name => name, get: () => directory } };
  const directory = new Directory({ storage: { sql } }, env);
  // The site owner made the board, so their name is kept on it; the admin's is recorded when they open it.
  const board = directory.createBoard('Robots', { email: 'owner@studio.example', name: 'Olena' });
  directory.changeSharing(board.id, 'owner@studio.example', { access: 'link', linkRole: 'edit' });
  directory.openBoard(board.id, { email: 'admin@studio.example', name: 'Taras' });
  directory.changeTeamAccess('owner@studio.example', { admin: { email: 'admin@studio.example', admin: true } });
  directory.changeTeamAccess('owner@studio.example', { admin: { email: 'quiet@studio.example', admin: true } });
  const call = async (email, path, { method = 'GET', data, name = 'Someone' } = {}) => (await worker.fetch(new Request(`http://localhost:8787${path}`, { method, headers: { Cookie: `cg_session=${await signSession({ name, email }, env.SESSION_SECRET)}`, Origin: 'http://localhost:8787', ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), env));
  return { directory, call, status: async email => (await call(email, '/api/nano')).json() };
}
(nodeModule.registerHooks ? test : test.skip)('GET /api/nano names who gives access to people without it, and nobody to people with it', async t => {
  const { status } = site(t);
  const newcomer = await status('new@studio.example');
  assert.deepEqual([newcomer.allowed, newcomer.admins], [false, ['Olena', 'Taras']], 'an admin who never opened a board has no name to show, and no email is shown instead');
  assert.equal(JSON.stringify(newcomer).includes('@'), false);
  const artist = await status('artist@studio.example');
  assert.deepEqual([artist.allowed, artist.admins], [true, undefined]);
});

(nodeModule.registerHooks ? test : test.skip)('someone without access asks for it; admins see the request in Team access and answer it there', async t => {
  const { call, status } = site(t);
  const ask = async (email, name) => (await call(email, '/api/nano/request', { method: 'POST', data: {}, name })).json();
  const team = async email => (await call(email, '/api/cloud/team')).json();
  const me = async email => (await call(email, '/api/cloud/me')).json();
  assert.equal((await status('nadia@gmail.com')).requested, false);
  assert.deepEqual(await ask('nadia@gmail.com', 'Nadia'), { requested: true });
  assert.deepEqual(await ask('nadia@gmail.com', 'Nadia K.'), { requested: true }, 'asking again keeps one request');
  assert.deepEqual(await ask('max@gmail.com', 'Max'), { requested: true });
  assert.deepEqual(await ask('artist@studio.example', 'Artist'), { allowed: true }, 'nothing to ask for with access');
  assert.deepEqual([(await status('nadia@gmail.com')).requested, (await status('nadia@gmail.com')).allowed], [true, false], 'access is still manual');
  // Admins see who asked, beside Team access and in it; nobody else does.
  assert.equal((await me('owner@studio.example')).accessRequests, 2); assert.equal((await me('admin@studio.example')).accessRequests, 2);
  assert.equal((await me('nadia@gmail.com')).accessRequests, undefined);
  assert.equal((await call('nadia@gmail.com', '/api/cloud/team')).status, 403);
  assert.deepEqual((await team('admin@studio.example')).access.requests.map(item => [item.email, item.name]), [['nadia@gmail.com', 'Nadia K.'], ['max@gmail.com', 'Max']]);
  // Giving access answers the request; dismissing removes it without access.
  let answer = await (await call('admin@studio.example', '/api/cloud/team', { method: 'PATCH', data: { nano: { entry: 'nadia@gmail.com', allowed: true } } })).json();
  assert.deepEqual(answer.access.requests.map(item => item.email), ['max@gmail.com']);
  assert.equal((await status('nadia@gmail.com')).allowed, true);
  assert.equal((await call('max@gmail.com', '/api/cloud/team', { method: 'PATCH', data: { request: { email: 'max@gmail.com', dismiss: true } } })).status, 403, 'only admins answer requests');
  answer = await (await call('owner@studio.example', '/api/cloud/team', { method: 'PATCH', data: { request: { email: 'max@gmail.com', dismiss: true } } })).json();
  assert.deepEqual([answer.access.requests, (await status('max@gmail.com')).allowed, (await me('owner@studio.example')).accessRequests], [[], false, 0]);
});

test('the picker and the Codex setup dialog let someone without access ask for it, once', async () => {
  setLanguage('en');
  const open = nanoState({ configured: true, allowed: false, admins: ['Olena'], requested: false }), asked = nanoState({ configured: true, allowed: false, admins: ['Olena'], requested: true });
  assert.deepEqual([open.requestable, asked.requestable, asked.short, asked.note], [true, false, 'requested', 'Access requested. Olena will see it in Team access.']);
  assert.equal(nanoState({ configured: true, allowed: false }, 'model3d').requestable, false, '3D access is given per person in Team access, not asked for here');
  const vite = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  let render;
  try { const { GeneratorPicker } = await vite.ssrLoadModule('/src/GeneratorPicker.jsx'); render = props => renderToStaticMarkup(React.createElement(GeneratorPicker, { id: 'p', choose() {}, request() {}, ...props })); }
  finally { await vite.close(); }
  assert.match(render({ nano: open, gpt: open }), /<option value="request">Request access…<\/option>/);
  assert.doesNotMatch(render({ nano: asked, gpt: asked }), /value="request"/);
  assert.match(render({ nano: asked, gpt: asked }), /Nano Banana · requested/);
  // Generate without the helper and without access: the setup dialog offers the request, then says it was sent.
  const source = part('  const run = async (nodeId, resumeIntent = null, event) => {', '  runAction.current = run;'), calls = [], node = { id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: 'A robot' } };
  const env = { alive: ref(true), pairing: false, mcpLocked: ref(false), readOnlyRef: ref(false), generationIntent: () => ({ nodeId: 'p' }), currentGraph: () => ({ nodes: [node], edges: [] }), boardId: 'b',
    notify() {}, inform() {}, starting: null, generationStarting: ref(false), nodeRef: ref([node]), cloud: true, usesSiteGenerator: () => false, model3dTask: 'model3d', generators, isDescribe: () => false,
    model3dRef: ref(open), gptRef: ref(open), nanoRef: ref(open), readinessRef: ref({ key: 'helper' }), pendingIntent: ref(null), generatorKind, startingGenerator, rememberGenerator() {}, t, nanoState,
    fixReadiness: () => calls.push(['fix']), cloudSession: { nano: { configured: true, allowed: false, admins: ['Olena'] }, openPair: (...args) => calls.push(['pair', ...args]), requestAccess: async () => { calls.push(['request']); return { requested: true }; } },
    track() {}, promptAnalytics: () => ({}), setGenerator() {}, runAction: ref(() => {}) };
  await new Function(...Object.keys(env), `${source}; return run;`)(...Object.values(env))('p');
  const [, , , card] = calls[0];
  assert.deepEqual([card.title, card.note, card.label, card.stay], ['Or ask for the team’s API key', 'Olena can let you generate with Nano Banana on the team’s key, without Codex.', 'Request access', true]);
  assert.deepEqual(await card.run(), { title: 'Or ask for the team’s API key', note: 'Access requested. Olena will see it in Team access.' });
  assert.deepEqual(calls.map(([kind]) => kind), ['pair', 'request']);
});
