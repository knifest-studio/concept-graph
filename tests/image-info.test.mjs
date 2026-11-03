import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, imageInfo } from '../src/image-info.mjs';

const asset = '12345678-1234-1234-1234-123456789abc.png';
const formatDate = value => `date:${value}`;
const rows = info => Object.fromEntries(info.rows.map(row => [row.key, row.note ? `${row.value} (${row.note})` : row.value]));

test('generation time is formatted compactly', () => {
  assert.equal(formatDuration(400), 'under 1 s');
  assert.equal(formatDuration(45_200), '45 s');
  assert.equal(formatDuration(72_000), '1 min 12 s');
  assert.equal(formatDuration(120_000), '2 min');
  assert.equal(formatDuration(3_780_000), '1 h 3 min');
  assert.equal(formatDuration(7_200_000), '2 h');
  for (const value of [-1, NaN, Infinity, undefined]) assert.equal(formatDuration(value), undefined);
});

test('cloud images show author, recorded settings, run duration, template, date and size', () => {
  const run = { id: 'run', nodeId: 'p', label: 'A courier robot', template: 'Character sheet', model: 'gpt-6-luna', effort: 'low', by: { name: 'Knife St', color: '#448bfa' },
    status: 'completed', createdAt: '2026-11-03T10:00:00.000Z', startedAt: '2026-11-03T10:00:05.000Z', finishedAt: '2026-11-03T10:01:17.000Z', outputIds: ['a', 'b', 'c'], count: 3 };
  const node = { id: 'a', type: 'image', data: { asset, runId: 'run', label: 'Result 1', caption: 'Front', createdAt: '2026-11-03T10:00:50.000Z' } };
  const info = imageInfo(node, [run], { width: 1024, height: 1536, formatDate });
  assert.equal(info.kind, 'generated'); assert.deepEqual(info.author, { name: 'Knife St', color: '#448bfa' });
  assert.equal(info.caption, 'Front'); assert.equal(info.prompt, 'A courier robot');
  assert.deepEqual(rows(info), { template: 'Character sheet', model: 'gpt-6-luna', effort: 'Low', duration: '1 min 12 s (Whole run, 3 images)', created: 'date:2026-11-03T10:00:50.000Z', size: '1024 × 1536 px' });
  assert.deepEqual(info.rows.map(row => row.key), ['template', 'model', 'effort', 'duration', 'created', 'size']);
  // The node's own author wins over the run's.
  assert.equal(imageInfo({ ...node, data: { ...node.data, author: { name: 'Owner' } } }, [run]).author.name, 'Owner');
  // A template-only prompt is not repeated as the prompt text.
  assert.equal(imageInfo(node, [{ ...run, label: 'Character sheet' }]).prompt, undefined);
});

test('local runs prefer the model Codex reported, fall back to the request, and leave templates to the snapshot list', () => {
  const target = { id: 'p', type: 'text', position: { x: 0, y: 0 }, data: { text: '  Full original prompt  ', template: { name: 'Style', instructions: 'Ink', assets: [] } } };
  const run = { id: 'run', nodeId: 'p', target, snapshot: [target], label: 'Full original prompt', model: 'gpt-6-luna', effort: 'low', status: 'completed', createdAt: '2026-11-03T10:00:00.000Z',
    startedAt: '2026-11-03T10:00:00.000Z', finishedAt: '2026-11-03T10:00:09.600Z', outputIds: ['a'], diagnostics: { model: 'rerouted-model', effort: 'medium', requestedModel: 'gpt-6-luna', requestedEffort: 'low' } };
  const node = { id: 'a', type: 'image', data: { asset, runId: 'run', label: 'Result 1' } };
  const info = imageInfo(node, [run], { formatDate });
  assert.equal(info.author, undefined); assert.equal(info.prompt, 'Full original prompt');
  assert.deepEqual(rows(info), { model: 'rerouted-model', effort: 'Medium', duration: '10 s', created: 'date:2026-11-03T10:00:09.600Z' });
  const old = { ...run, model: undefined, effort: undefined, diagnostics: { model: null, effort: null, requestedModel: 'older-model', requestedEffort: 'high' } };
  assert.deepEqual(rows(imageInfo(node, [old], { formatDate })), { model: 'older-model', effort: 'High', duration: '10 s', created: 'date:2026-11-03T10:00:09.600Z' });
});

test('unknown or invalid values are omitted rather than guessed', () => {
  const running = { id: 'run', nodeId: 'p', label: 'Working', status: 'running', startedAt: '2026-11-03T10:00:00.000Z', outputIds: ['a'], model: '../bad model', effort: 'Not Valid' };
  const node = { id: 'a', type: 'image', data: { asset, runId: 'run', createdAt: 'not a date' } };
  const info = imageInfo(node, [running], { width: 0, height: 512, formatDate });
  assert.deepEqual(info.rows, []); assert.equal(info.prompt, 'Working');
  // History removed after the image was generated: still a generated image, with nothing invented.
  const orphan = imageInfo({ id: 'b', type: 'image', data: { asset, runId: 'gone' } }, [], { formatDate });
  assert.equal(orphan.kind, 'generated'); assert.deepEqual(orphan.rows, []); assert.equal(orphan.prompt, undefined);
});

test('uploaded references show what exists: file name, date and size', () => {
  const node = { id: 'r', type: 'image', data: { asset, label: 'mood.png', createdAt: '2026-11-03T09:00:00.000Z' } };
  const info = imageInfo(node, [], { width: 640, height: 480, formatDate });
  assert.equal(info.kind, 'reference'); assert.equal(info.author, undefined); assert.equal(info.prompt, undefined);
  assert.deepEqual(rows(info), { name: 'mood.png', created: 'date:2026-11-03T09:00:00.000Z', size: '640 × 480 px' });
  assert.equal(info.rows.find(row => row.key === 'created').label, 'Added');
  // A caption replaces the file name.
  const captioned = imageInfo({ ...node, data: { ...node.data, caption: 'Mood board' } }, [], { formatDate });
  assert.equal(captioned.caption, 'Mood board'); assert.equal(captioned.rows.some(row => row.key === 'name'), false);
});
