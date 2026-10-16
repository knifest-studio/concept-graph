import test from 'node:test';
import assert from 'node:assert/strict';
import { runTiming, formatDuration } from '../timing.mjs';

const date = seconds => new Date(seconds * 1000).toISOString();

test('timers distinguish queue waiting from generation and stay fixed after completion', () => {
  const run = { id: 'current', status: 'queued', createdAt: date(0) };
  assert.equal(runTiming(run, [], 70000).label, '70s');
  Object.assign(run, { status: 'running', startedAt: date(60) });
  assert.equal(runTiming(run, [], 70000).label, '10s');
  Object.assign(run, { status: 'completed', finishedAt: date(85) });
  assert.equal(runTiming(run, [], 900000).label, '25s');
  assert.equal(formatDuration(-1000), '0s');
  assert.equal(runTiming({ status: 'running' }, []).label, '0s');
  assert.equal(runTiming({ status: 'running', createdAt: date(0) }, [], 70000).label, '70s');
});

test('historical comparison excludes failures and invalid durations, and uses recent complete requests only', () => {
  const history = [
    { id: 'failed', status: 'error', createdAt: date(0), finishedAt: date(900) },
    { id: 'zero', status: 'completed', createdAt: date(0), finishedAt: date(0) },
    { id: 'invalid', status: 'completed' },
    ...[600, 50, 60, 70, 80, 90].map((seconds, i) => ({ id: String(i), status: 'completed', createdAt: date(0), finishedAt: date(seconds) })),
  ];
  const run = { id: 'current', status: 'running', createdAt: date(0), startedAt: date(0) };
  assert.equal(runTiming(run, history, 999000).comparison, 'Recent requests: 50s–90s total');
  assert.equal(runTiming(run, [], 999000).comparison, '');
  assert.equal(runTiming(run, [history.at(-1)], 999000).comparison, 'Recent requests: 90s total');
});
