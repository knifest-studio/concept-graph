import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { BoardChat, chatInput, chatCursor, chatLimit } from '../cloud/chat.mjs';

const alice = { name: 'Alice', email: 'alice@example.com', color: '#abcdef', role: 'view' }, bob = { name: 'Bob', email: 'bob@example.com', role: 'edit' };
function setup(t) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  const sql = { exec: (query, ...args) => ({ toArray: () => database.prepare(query).all(...args) }) };
  // Production exec executes eagerly, including DDL and statements whose results are unused.
  sql.exec = (query, ...args) => { const rows = database.prepare(query).all(...args); return { toArray: () => rows }; };
  return { chat: new BoardChat(sql), sql };
}
test('chat validation rejects bad text, links and cursors without accepting client authors', () => {
  assert.deepEqual(chatInput({ text: '  hi\nthere  ', nodeId: 'node', author: bob, agent: true }), { text: 'hi\nthere', nodeId: 'node' });
  for (const text of ['', ' \n ', null, 'x'.repeat(2001)]) assert.throws(() => chatInput({ text }));
  for (const nodeId of ['', 123, 'x'.repeat(121)]) assert.throws(() => chatInput({ text: 'ok', nodeId }));
  for (const cursor of [-1, NaN, 1.5, '1', null]) assert.throws(() => chatCursor(cursor));
});
test('viewers post with server identity; rate limits and optimistic retries survive reconstruction', t => {
  const { chat, sql } = setup(t);
  const first = chat.send({ text: ' Hi ', author: bob, agent: true, nodeId: 'node' }, alice, { key: 'one', now: 10000 });
  assert.equal(first.message.text, 'Hi'); assert.deepEqual(first.message.author, { name: alice.name, color: alice.color, email: alice.email }); assert.equal(first.message.agent, undefined);
  const resumed = new BoardChat(sql);
  assert.equal(resumed.send({ text: 'Hi' }, alice, { key: 'one', now: 10001 }).duplicate, true);
  assert.equal(resumed.send({ text: 'next' }, alice, { agent: true, now: 10001 }).message.agent, true);
  assert.equal(resumed.history({}, bob.email).messages.length, 2);
});
test('chat pages are stable, unread excludes self/deletions, deletion is author or owner only', t => {
  const { chat, sql } = setup(t);
  for (let i = 1; i <= 61; i++) chat.send({ text: `Message ${i}`, nodeId: 'node' }, i % 2 ? alice : bob, { now: i * 1000 });
  const first = chat.history({ after: 1 }, alice.email);
  assert.equal(first.messages.length, 50); assert.equal(first.messages[0].id, 61); assert.equal(first.more, true); assert.equal(first.unread, 30);
  const earlier = chat.history({ before: first.messages.at(-1).id }, alice.email);
  assert.deepEqual(earlier.messages.map(message => message.id), Array.from({ length: 11 }, (_, i) => 11 - i)); assert.equal(earlier.more, false);
  assert.throws(() => chat.delete(61, bob), /own/);
  chat.delete(61, alice); chat.delete(60, { ...alice, role: 'owner' });
  const resumed = new BoardChat(sql), rows = resumed.history({}, alice.email);
  assert.equal(rows.unread, 29); assert.equal(rows.messages[0].deleted, true); assert.equal(rows.messages[0].text, ''); assert.equal(rows.messages[0].nodeId, undefined);
  assert.throws(() => resumed.history({ before: 'oops' }), /cursor/);
});
test('only the newest 5000 messages survive pruning and IDs never rewind', t => {
  const { chat } = setup(t);
  for (let i = 1; i <= chatLimit + 2; i++) chat.send({ text: `${i}` }, alice, { now: i * 2000 });
  let before, count = 0, oldest;
  do { const page = chat.history({ before }); count += page.messages.length; oldest = page.messages.at(-1)?.id; before = oldest; if (!page.more) break; } while (true);
  assert.equal(count, chatLimit); assert.equal(oldest, 3); assert.equal(chat.history().latest, chatLimit + 2);
});

test('eight quick messages fit a durable sliding window and retries do not consume another slot', t => {
  const { chat, sql } = setup(t);
  for (let i = 0; i < 8; i++) chat.send({ text: `${i}` }, alice, { key: `burst-${i}`, now: 10000 + i });
  const resumed = new BoardChat(sql);
  assert.equal(resumed.send({ text: 'retry' }, alice, { key: 'burst-0', now: 10008 }).duplicate, true);
  assert.throws(() => resumed.send({ text: 'ninth' }, alice, { now: 10008 }), /Wait/);
  assert.doesNotThrow(() => resumed.send({ text: 'another sender' }, bob, { now: 10008 }));
  assert.throws(() => resumed.send({ text: 'too soon' }, alice, { now: 19999 }), /Wait/);
  assert.doesNotThrow(() => resumed.send({ text: 'first slot expired' }, alice, { now: 20000 }));
  assert.throws(() => resumed.send({ text: 'second slot not expired' }, alice, { now: 20000 }), /Wait/);
  assert.doesNotThrow(() => resumed.send({ text: 'next slot expired' }, alice, { now: 20001 }));
});

test('an old single-gap rate row migrates without losing its recent send', t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  database.exec("CREATE TABLE chat_limits (sender TEXT PRIMARY KEY, at INTEGER NOT NULL); INSERT INTO chat_limits VALUES ('alice@example.com', 10000)");
  const sql = { exec(query, ...args) { const rows = database.prepare(query).all(...args); return { toArray: () => rows }; } }, chat = new BoardChat(sql);
  for (let i = 0; i < 7; i++) chat.send({ text: `${i}` }, alice, { now: 10001 + i });
  assert.throws(() => chat.send({ text: 'ninth including migrated message' }, alice, { now: 10008 }), /Wait/);
});
