import test from 'node:test';
import assert from 'node:assert/strict';
import { shortWhen } from '../src/when.mjs';

test('history and chat times say the day once it is not today, and the year once it is not this year', () => {
  const now = new Date(2026, 10, 19, 10, 0), time = date => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date(2026, 10, 19, 0, 5), yesterday = new Date(2026, 10, 18, 23, 38), week = new Date(2026, 10, 12, 14, 2), lastYear = new Date(2025, 11, 30, 8, 0);
  assert.equal(shortWhen(today, now), time(today));
  assert.equal(shortWhen(yesterday.toISOString(), now), `Yesterday, ${time(yesterday)}`);
  assert.equal(shortWhen(week, now, 'en-US'), `Nov 12, ${time(week)}`);
  assert.equal(shortWhen(week, now, 'uk-UA'), `12 лист., ${time(week)}`);
  assert.equal(shortWhen(lastYear, now, 'en-US'), `Dec 30, 2025, ${time(lastYear)}`);
  assert.equal(shortWhen('not a date', now), '');
});
