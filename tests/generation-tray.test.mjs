import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceTray, formatElapsed, generationRows, generationFocusNodes, partialFailure, readTrayPreference, retireRows, sameRows, trayPreferenceKey, traySummary, traySummaryText, trayTone, writeTrayPreference } from '../src/generation-tray.mjs';
import { setLanguage } from '../src/i18n.mjs';
import { canvasView } from '../src/canvas.mjs';
import { model3dModels } from '../graph.mjs';

const date = seconds => new Date(seconds * 1000).toISOString();
const run = (id, status, extra = {}) => ({ id, nodeId: 'prompt', label: 'A blue bird\nMore instructions', status, createdAt: date(0), outputIds: [], ...extra });

test('elapsed time follows queue/start/finish timestamps and formats minutes safely', () => {
  for (const [ms, expected] of [[0, '0:00'], [59999, '0:59'], [60000, '1:00'], [3661000, '61:01'], [-1, '0:00'], [NaN, '0:00']]) assert.equal(formatElapsed(ms), expected);
  const queued = run('r', 'queued');
  assert.equal(generationRows([queued], [], 70000)[0].elapsed, '1:10');
  const running = { ...queued, status: 'running', startedAt: date(60) };
  const rows = generationRows([running], [], 70000);
  assert.equal(rows[0].elapsed, '0:10'); assert.equal(rows[0].label, 'A blue bird'); assert.equal(rows[0].status, 'Generating');
  const done = { ...running, status: 'completed', finishedAt: date(85), outputIds: ['a', 'b'] };
  const finished = generationRows([done], rows, 900000)[0];
  assert.equal(finished.elapsed, '0:25'); assert.equal(finished.status, 'Done · 2 images');
  assert.equal(generationRows([run('bad', 'running', { createdAt: 'bad' })], [], 90000)[0].elapsed, '0:00');
});

test('running/queued rows sort first, oldest first; old history stays out of the tray', () => {
  const runs = [run('old-error', 'error', { finishedAt: date(1) }), run('old-done', 'completed', { finishedAt: date(1) }), run('new', 'running', { createdAt: date(30) }), run('queued', 'queued', { createdAt: date(20) }), run('done', 'completed', { finishedAt: date(99), count: 1 })];
  const rows = generationRows(runs, [], 100000);
  assert.deepEqual(rows.map(row => row.run.id), ['queued', 'new', 'done']);
  assert.equal(rows[0].status, 'Queued'); assert.equal(rows[2].status, 'Done · 1 image');
  assert.equal(generationRows([run('template', 'running', { label: '', target: { data: { template: { name: 'Portrait' } } } })])[0].label, 'Portrait');
});

test('a 3D run names its generator and counts models, not images', () => {
  const running = run('mesh', 'running', { task: 'model3d', model: model3dModels.hunyuan, label: 'Robot' });
  const rows = generationRows([running], [], 1000);
  assert.equal(rows[0].label, 'Hunyuan 3D 3.1 Pro · Robot'); assert.equal(rows[0].status, 'Generating 3D');
  const done = { ...running, status: 'completed', finishedAt: date(2), outputIds: ['m'] };
  assert.equal(generationRows([done], rows, 3000)[0].status, 'Done · 1 model');
  assert.equal(generationRows([{ ...done, outputIds: ['m', 'n'] }], rows, 3000)[0].status, 'Done · 2 models');
  assert.equal(generationRows([{ ...running, model: 'unknown' }], [], 1000)[0].label, 'Robot');
  setLanguage('uk');
  try { assert.equal(generationRows([running], [], 1000)[0].status, 'Генерація 3D'); assert.equal(generationRows([{ ...done, outputIds: ['m', 'n', 'o', 'p', 'q'] }], rows, 3000)[0].status, 'Готово · 5 моделей'); }
  finally { setLanguage('en'); }
});

// Runs seen while running, then settled at 100 s; `step` advances the tray like the component does.
const seenRunning = (ids, ctx = {}) => advanceTray(ids.map(id => run(id, 'running', { nodeId: id })), undefined, 90000, ctx);
const step = (runs, state, now, ctx = {}) => advanceTray(runs, state, now, ctx);
const ids = state => state.rows.map(row => row.run.id);

test('a finished row waits while the tab is hidden or nobody touches the page, then clears 6 s after the first visible input', () => {
  const done = [run('ok', 'completed', { finishedAt: date(100), outputIds: ['a'] })];
  let state = step(done, seenRunning(['ok']), 100000, { lastInputAt: 99000 });
  assert.equal(state.rows[0].kind, 'done'); assert.equal(state.rows[0].awaiting, true); assert.equal(state.rows[0].expiresAt, Infinity);
  // An hour later: the person last touched the page before it settled, or touched it only while the tab was hidden.
  assert.deepEqual(ids(step(done, state, 3700000, { lastInputAt: 99000 })), ['ok']);
  state = step(done, state, 3700000, { visible: false, lastInputAt: 3600000 });
  assert.equal(state.rows[0].seenAt, null);
  state = step(done, state, 3700000, { lastInputAt: 3700000 });
  assert.equal(state.rows[0].seenAt, 3700000); assert.equal(state.rows[0].awaiting, false);
  assert.equal(step(done, state, 3705400).rows[0].fading, false);
  assert.equal(step(done, state, 3705500).rows[0].fading, true);
  state = step(done, state, 3706000);
  assert.deepEqual(ids(state), []);
  // Cleared for good: it is not "first seen" again, even with a server clock ahead of this one.
  assert.deepEqual(ids(step([run('ok', 'completed', { finishedAt: date(9999999) })], state, 3707000)), []);
});

test('clicking a row clears it 2 s after the person went to the result', () => {
  const done = [run('ok', 'completed', { finishedAt: date(100) })];
  const state = step(done, seenRunning(['ok']), 100000);
  const viewed = new Map([['ok', 101000]]);
  assert.equal(step(done, state, 102900, { viewed }).rows.length, 1);
  assert.equal(step(done, state, 103000, { viewed }).rows.length, 0);
  // A click while it was still running does not count as seeing the result.
  assert.equal(step(done, state, 103000, { viewed: new Map([['ok', 95000]]) }).rows.length, 1);
});

test('hover or keyboard focus in the tray holds every row; leaving gives a 2 s grace', () => {
  const done = [run('ok', 'completed', { finishedAt: date(100) }), run('stop', 'cancelled', { finishedAt: date(100), nodeId: 'stop' })];
  let state = step(done, seenRunning(['ok', 'stop']), 100000, { lastInputAt: 100000 });
  state = step(done, state, 200000, { hovered: true });
  assert.deepEqual(ids(state), ['ok', 'stop']); assert.ok(state.rows.every(row => !row.fading && row.expiresAt === Infinity));
  assert.deepEqual(ids(step(done, state, 201900, { releasedAt: 200000 })), ['ok', 'stop']);
  assert.deepEqual(ids(step(done, state, 202000, { releasedAt: 200000 })), []);
  // A hidden tab holds them the same way, and showing it again starts the grace.
  assert.deepEqual(ids(step(done, state, 300000, { visible: false })), ['ok', 'stop']);
});

test('my failures stay until dismissed or a newer run of the same prompt answers them; teammates’ clear once seen', () => {
  const me = 'Olena', by = name => ({ by: { name, color: '#f00' } });
  const failures = [run('mine', 'failed', { finishedAt: date(100), error: 'Bad prompt\nFull details', ...by(me) }), run('theirs', 'failed', { finishedAt: date(100), error: 'Too large', nodeId: 'other', ...by('Taras') })];
  let state = step(failures, seenRunning(['mine', 'theirs'], { me }), 100000, { me, lastInputAt: 100500 });
  assert.deepEqual(state.rows.map(row => [row.run.id, row.mine, row.status]), [['mine', true, 'Failed · Bad prompt'], ['theirs', false, 'Failed · Too large']]);
  assert.equal(state.rows[0].expiresAt, Infinity);
  state = step(failures, state, 108000, { me });
  assert.deepEqual(ids(state), ['mine']);
  assert.deepEqual(ids(step(failures, state, 9000000, { me })), ['mine']);
  assert.deepEqual(ids(retireRows(state, ['mine'])), []);
  assert.deepEqual(ids(step(failures, retireRows(state, ['mine']), 9000000, { me })), []);
  const rerun = [...failures, run('again', 'running', { createdAt: date(200), ...by(me) })];
  assert.deepEqual(ids(step(rerun, state, 200000, { me })), ['again']);
  // In local mode there is no name: every run is this person's, and the old status name `error` is a failure.
  const local = [run('a', 'error', { finishedAt: date(100), nodeId: 'a', by: { name: 'Someone' } }), run('b', 'failed', { finishedAt: date(100), nodeId: 'b' })];
  assert.deepEqual(step(local, seenRunning(['a', 'b']), 9000000).rows.map(row => [row.mine, row.expiresAt]), [[true, Infinity], [true, Infinity]]);
});

test('a partial run says how many images failed and why, and holds 15 s after it is seen', () => {
  const partial = [run('p', 'completed', { finishedAt: date(100), count: 12, error: '4 of 16 variants failed: A reference image is too large.' })];
  const state = step(partial, seenRunning(['p']), 100000, { lastInputAt: 100000 });
  const [row] = state.rows;
  assert.equal(row.kind, 'partial'); assert.equal(row.error, false);
  assert.equal(row.status, 'Done · 12 of 16 images · 4 failed'); assert.equal(row.reason, 'A reference image is too large.');
  assert.deepEqual(partialFailure('1 of 2 images failed: Upscaler busy'), { failed: 1, total: 2, reason: 'Upscaler busy' });
  assert.equal(partialFailure('Something else'), null);
  assert.equal(step(partial, state, 114900).rows.length, 1);
  assert.equal(step(partial, state, 115000).rows.length, 0);
  const odd = step([run('q', 'completed', { finishedAt: date(100), count: 3, error: 'Some images were blocked' })], seenRunning(['q']), 100000).rows[0];
  assert.deepEqual([odd.kind, odd.status, odd.reason], ['partial', 'Done · 3 images', 'Some images were blocked']);
  setLanguage('uk');
  try { assert.equal(step(partial, seenRunning(['p']), 100000).rows[0].status, 'Готово · 12 із 16 зображень · не вдалося: 4'); }
  finally { setLanguage('en'); }
});

test('cancelled rows clear 2 s after they settle, seen or not', () => {
  const cancelled = [run('c', 'cancelled', { finishedAt: date(100) })];
  const state = step(cancelled, seenRunning(['c']), 100000);
  assert.equal(state.rows[0].status, 'Cancelled'); assert.equal(state.rows[0].awaiting, false);
  assert.equal(step(cancelled, state, 101900).rows.length, 1);
  assert.equal(step(cancelled, state, 102000).rows.length, 0);
});

test('a run first seen finished shows only if it settled moments ago, with the server clock clamped to this one', () => {
  const ahead = [run('ahead', 'completed', { finishedAt: date(130) })];
  const state = step(ahead, undefined, 100000);
  assert.equal(state.rows[0].settledAt, 100000);
  const seen = step(ahead, state, 100500, { lastInputAt: 100500 });
  assert.equal(seen.rows[0].seenAt, 100500);
  assert.equal(step(ahead, seen, 106499).rows.length, 1);
  assert.equal(step(ahead, seen, 106500).rows.length, 0);
  assert.deepEqual(ids(step([run('reload', 'completed', { finishedAt: date(10) }), run('broken', 'completed', {})], undefined, 100000)), []);
});

test('the summary counts rows by state and the chip takes the worst tone', () => {
  const rows = generationRows([run('a', 'running'), run('b', 'queued', { nodeId: 'b' }), run('c', 'completed', { finishedAt: date(99) }), run('d', 'completed', { finishedAt: date(99), error: '1 of 2 variants failed: x' }), run('e', 'failed', { finishedAt: date(99), nodeId: 'e' })], [], 100000);
  const summary = traySummary(rows);
  assert.deepEqual(summary, { active: 2, done: 1, partial: 1, failed: 1, cancelled: 0 });
  assert.equal(traySummaryText(summary), '2 generating · 2 done · 1 failed');
  assert.equal(trayTone(summary), 'failed');
  assert.equal(trayTone({ ...summary, failed: 0 }), 'partial'); assert.equal(trayTone({ ...summary, failed: 0, partial: 0 }), 'active');
  assert.equal(trayTone({ active: 0, done: 1, partial: 0, failed: 0 }), 'done');
  assert.equal(traySummaryText({ active: 0, done: 0, partial: 0, failed: 0 }), '');
  setLanguage('uk');
  try { assert.equal(traySummaryText(summary), 'Генерується: 2 · Готово: 2 · Не вдалося: 1'); }
  finally { setLanguage('en'); }
});

test('the folded choice is kept per person and survives storage that is empty, broken or missing', () => {
  const memory = new Map(), storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
  const key = trayPreferenceKey('cloud:Olena');
  assert.equal(key, 'concept-graph-generation-tray:cloud:Olena');
  assert.equal(readTrayPreference(storage, key), false); assert.equal(readTrayPreference(storage, key, true), true);
  assert.equal(writeTrayPreference(storage, key, true), true); assert.equal(readTrayPreference(storage, key, false), true);
  writeTrayPreference(storage, key, false); assert.equal(readTrayPreference(storage, key, true), false);
  assert.equal(readTrayPreference(storage, trayPreferenceKey('local'), true), true);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  assert.equal(readTrayPreference(broken, key, true), true); assert.equal(writeTrayPreference(broken, key, true), false);
  assert.equal(readTrayPreference(null, key, false), false); assert.equal(writeTrayPreference(undefined, key, true), false);
});

test('a tick that changes nothing a person can see keeps the same rows', () => {
  const runs = [run('a', 'running')], first = generationRows(runs, [], 100000);
  assert.equal(sameRows(first, generationRows(runs, first, 100400)), true);
  assert.equal(sameRows(first, generationRows(runs, first, 101000)), false);
});

test('focus targets the prompt and outputs, using a visible collapsed group when needed', () => {
  const nodes = ['prompt', 'a', 'b', 'unrelated'].map((id, i) => ({ id, type: 'text', data: { text: id }, position: { x: i * 400, y: 0 } }));
  const groups = [{ id: 'outputs', name: 'Outputs', nodeIds: ['a', 'b'], collapsed: true }];
  const view = canvasView(nodes, [], groups);
  assert.deepEqual(generationFocusNodes(run('r', 'completed', { outputIds: ['a', 'b', 'deleted'] }), view.nodes, groups), [{ id: 'outputs' }, { id: 'prompt' }]);
  assert.deepEqual(generationFocusNodes({ nodeId: 'deleted' }, view.nodes, groups), []);
});
