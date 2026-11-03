import test from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed, generationRows, generationFocusNodes } from '../src/generation-tray.mjs';
import { canvasView } from '../src/canvas.mjs';

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

test('observed completions fade and expire after four seconds; errors persist until dismissed', () => {
  const running = [run('ok', 'running'), run('local-error', 'running'), run('cloud-error', 'queued'), run('cancel', 'queued')];
  const terminal = [run('ok', 'completed', { finishedAt: date(100) }), run('local-error', 'error', { finishedAt: date(100), error: 'Bad prompt\nFull details' }), run('cloud-error', 'failed', { finishedAt: date(100) }), run('cancel', 'cancelled', { finishedAt: date(100) })];
  const rows = generationRows(terminal, generationRows(running, [], 90000), 100000);
  assert.equal(rows.length, 4); assert.equal(rows.find(row => row.run.id === 'local-error').status, 'Failed · Bad prompt');
  assert.equal(generationRows(terminal, rows, 103500).find(row => row.run.id === 'ok').fading, true);
  const errors = generationRows(terminal, rows, 104000);
  assert.deepEqual(errors.map(row => row.run.id), ['cloud-error', 'local-error']);
  assert.equal(generationRows(terminal, errors, 900000).length, 2);
  assert.equal(generationRows(terminal, errors, 900000, new Set(['cloud-error', 'local-error'])).length, 0);
  assert.equal(generationRows([], errors, 900000).length, 0);
});

test('focus targets the prompt and outputs, using a visible collapsed group when needed', () => {
  const nodes = ['prompt', 'a', 'b', 'unrelated'].map((id, i) => ({ id, type: 'text', data: { text: id }, position: { x: i * 400, y: 0 } }));
  const groups = [{ id: 'outputs', name: 'Outputs', nodeIds: ['a', 'b'], collapsed: true }];
  const view = canvasView(nodes, [], groups);
  assert.deepEqual(generationFocusNodes(run('r', 'completed', { outputIds: ['a', 'b', 'deleted'] }), view.nodes, groups), [{ id: 'outputs' }, { id: 'prompt' }]);
  assert.deepEqual(generationFocusNodes({ nodeId: 'deleted' }, view.nodes, groups), []);
});
