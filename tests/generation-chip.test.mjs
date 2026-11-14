import test from 'node:test';
import assert from 'node:assert/strict';
import { generationChip, usageRemaining } from '../src/generation-chip.mjs';
import { generationReadiness } from '../src/onboarding.mjs';
import { setLanguage } from '../src/i18n.mjs';

const status = { connected: true, signedIn: true, imageGeneration: true };
const base = { status, readiness: { key: 'ready' }, helperNeeded: true, remaining: null };

test('ready chip is neutral; valid usage is amber only at ten percent or less', () => {
  assert.deepEqual(generationChip(base), { label: 'Codex · Ready', tone: 'neutral' });
  assert.deepEqual(generationChip({ ...base, remaining: 46 }), { label: 'Codex · 46% left', tone: 'neutral' });
  for (const remaining of [0, 1, 10]) assert.equal(generationChip({ ...base, remaining }).tone, 'low');
  assert.equal(generationChip({ ...base, remaining: 10.1 }).tone, 'neutral');
  for (const used of [null, undefined, NaN, Infinity, '90', -1, 101]) assert.equal(usageRemaining(used), null);
  assert.equal(usageRemaining(54), 46); assert.equal(usageRemaining(100), 0);
});

test('helper problems retain readiness wording and delegated Codex never shows your own limits', () => {
  for (const patch of [{ paired: false }, { online: false }, { status: { ...status, connected: false } }, { status: { ...status, signedIn: false } }, { status: { ...status, imageGeneration: false } }]) {
    const readiness = generationReadiness({ required: true, paired: true, status, ...patch });
    assert.deepEqual(generationChip({ ...base, readiness }), { label: readiness.label, tone: 'attention' });
  }
  const readiness = generationReadiness({ required: true, paired: false, status: {}, teammate: { to: 123, user: { name: 'Teammate' } } });
  assert.deepEqual(generationChip({ ...base, readiness, remaining: 1 }), { label: readiness.label, tone: 'neutral' });
  assert.deepEqual(generationChip({ ...base, readiness: { ...readiness, delegate: 0 }, remaining: 1 }), { label: readiness.label, tone: 'neutral' });
  assert.equal(generationChip({ ...base, outdated: true }).label, 'Update helper');
});

test('local readiness still uses the original connection flags and sign-in action', () => {
  assert.equal(generationChip({ ...base, helperNeeded: false }).label, 'Codex · Ready');
  assert.equal(generationChip({ ...base, helperNeeded: false, status: {} }).label, 'Check Codex');
  assert.equal(generationChip({ ...base, helperNeeded: false, desktopMode: true, status: { connected: true } }).label, 'Sign in with ChatGPT');
});

test('chip labels translate into Ukrainian', () => {
  setLanguage('uk');
  try {
    assert.equal(generationChip(base).label, 'Codex · Готово');
    assert.equal(generationChip({ ...base, remaining: 46 }).label, 'Codex · Залишилося 46%');
  } finally { setLanguage('en'); }
});
