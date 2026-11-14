import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUnseenWhatsNew, markWhatsNewSeen, readWhatsNewSeen, whatsNewEntries, whatsNewSeenKey } from '../src/whats-new.mjs';
import uk from '../src/locales/uk.mjs';

const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }; };
test('new browsers have updates; opening the list acknowledges entries across reloads', () => {
  const saved = storage();
  assert.equal(hasUnseenWhatsNew(readWhatsNewSeen(saved)), true);
  const seen = markWhatsNewSeen(saved);
  assert.equal(hasUnseenWhatsNew(seen), false);
  assert.deepEqual(readWhatsNewSeen(saved), seen);
  assert.equal(hasUnseenWhatsNew(readWhatsNewSeen(saved)), false);
  assert.deepEqual(markWhatsNewSeen(saved), seen);
  const next = [{ id: 'future-update' }, ...whatsNewEntries];
  assert.equal(hasUnseenWhatsNew(seen, next), true);
  assert.equal(hasUnseenWhatsNew(markWhatsNewSeen(saved, next), next), false);
  assert.equal(hasUnseenWhatsNew(readWhatsNewSeen(storage())), true);
});
test('malformed or unavailable storage never breaks help; unknown IDs do not hide new entries', () => {
  for (const raw of ['bad JSON', 'null', '{}', '42']) assert.deepEqual(readWhatsNewSeen({ getItem: () => raw }), []);
  const saved = storage(); saved.setItem(whatsNewSeenKey, '["old-entry",null,42]');
  assert.deepEqual(readWhatsNewSeen(saved), ['old-entry']);
  assert.equal(hasUnseenWhatsNew(readWhatsNewSeen(saved)), true);
  assert.ok(markWhatsNewSeen(saved).includes('old-entry'));
  const blocked = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  assert.deepEqual(readWhatsNewSeen(blocked), []);
  assert.equal(hasUnseenWhatsNew(markWhatsNewSeen(blocked)), false);
  assert.equal(hasUnseenWhatsNew(readWhatsNewSeen(blocked)), true);
});
test('release notes have stable unique IDs and translated titles and benefits', () => {
  assert.equal(whatsNewEntries.length, 6);
  assert.equal(new Set(whatsNewEntries.map(entry => entry.id)).size, whatsNewEntries.length);
  for (const { id, title, benefit } of whatsNewEntries) {
    assert.ok(id && title && benefit); assert.ok(!benefit.includes('\n'));
    assert.ok(uk[title], title); assert.ok(uk[benefit], benefit);
  }
});
