import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatClient, chatLinks, chatReadKey } from '../src/board-chat.mjs';
const own = 'me@example.com', other = 'other@example.com';
const message = (id, email = other) => ({ id, time: new Date(id * 1000).toISOString(), author: { name: 'Person', email }, text: `m${id}` });
function setup() {
  const saved = new Map(), sent = [], sounds = []; let hidden = false;
  const client = new ChatClient({ boardId: 'b', email: own, storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) }, send: value => sent.push(value), hidden: () => hidden, sound: () => sounds.push(1) });
  return { client, saved, sent, sounds, hide: value => { hidden = value; } };
}
test('history counts beyond one page, live echoes deduplicate, read cursor stays account-scoped', () => {
  const { client, saved, sounds, hide } = setup(); client.connected(true);
  client.receive({ type: 'chat-history', messages: [message(100)], more: true, latest: 100, unread: 99, after: 0 });
  client.receive({ type: 'chat-message', message: message(101) }); client.receive({ type: 'chat-message', message: message(101) });
  assert.equal(client.state.unread, 100); assert.equal(sounds.length, 1);
  client.visible(true, false); assert.equal(client.state.unread, 100);
  client.visible(true, true); assert.equal(client.state.unread, 0); assert.equal(saved.get(chatReadKey('b', own)), '101');
  hide(true); client.receive({ type: 'chat-message', message: message(102) }); assert.equal(client.state.unread, 1); assert.equal(sounds.length, 2);
  client.receive({ type: 'chat-message', message: message(103, own) }); assert.equal(client.state.unread, 1);
  hide(false); client.visible(true); assert.equal(client.state.unread, 0);
  assert.notEqual(chatReadKey('b', own), chatReadKey('b', other));
});
test('optimistic send retries its durable key and keeps failed text; deletion beats stale history', () => {
  const { client, sent } = setup(); client.connected(true); client.post(' hello ', 'node', 'key');
  client.receive({ type: 'chat-failed', key: 'key', reason: 'Wait' }); assert.equal(client.state.pending[0].error, 'Wait');
  client.retry('key'); assert.equal(sent.at(-1).key, 'key'); assert.equal(sent.at(-1).text, 'hello');
  client.receive({ type: 'chat-message', key: 'key', message: message(1, own) }); assert.equal(client.state.pending.length, 0);
  client.receive({ type: 'chat-deleted', id: 2, author: { email: other } });
  client.receive({ type: 'chat-history', messages: [message(2)], latest: 2, unread: 0, after: 0, more: false });
  assert.equal(client.state.messages.find(item => item.id === 2).deleted, true);
  client.post('retained', undefined, 'two'); client.connected(false); assert.match(client.state.pending[0].error, /Connection/);
});
test('a live message racing a history page counts once and history never makes a sound', () => {
  const { client, sounds } = setup(); client.connected(true);
  client.receive({ type: 'chat-message', message: message(2) }); client.receive({ type: 'chat-message', message: message(3) });
  client.receive({ type: 'chat-history', messages: [message(2), message(1)], latest: 2, unread: 2, after: 0, more: false });
  assert.equal(client.state.unread, 3); assert.equal(sounds.length, 2);
  client.receive({ type: 'chat-deleted', id: 2, author: { email: other } }); assert.equal(client.state.unread, 2);
});
test('linkification allows only http(s) and treats HTML as text', () => {
  const parts = chatLinks('<script>bad</script> javascript:alert(1) https://example.com?q=hi http://x.test');
  assert.deepEqual(parts.filter(part => part.url).map(part => part.url), ['https://example.com?q=hi', 'http://x.test']);
  assert.match(parts[0].text, /<script>/);
});

test('reconnect replaces cached history so missed deletions and paging gaps cannot retain old text', () => {
  const { client } = setup(); client.connected(true);
  client.receive({ type: 'chat-history', messages: [message(2), message(1)], latest: 2, unread: 2, after: 0, more: false });
  client.connected(false); client.connected(true);
  client.receive({ type: 'chat-history', messages: [{ ...message(2), deleted: true, text: '' }, message(100)], latest: 100, unread: 98, after: 0, more: true });
  assert.equal(client.state.messages.some(item => item.id === 1), false);
  assert.equal(client.state.messages.find(item => item.id === 2).text, '');
});

test('reading and closing chat during a history request re-counts unread from the new cursor', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, sent } = setup(); client.connected(true); client.visible(true);
  client.receive({ type: 'chat-message', message: message(101) }); client.visible(false);
  client.receive({ type: 'chat-message', message: message(102) });
  client.receive({ type: 'chat-history', messages: [message(102), message(101)], latest: 102, after: 0, unread: 102, more: true });
  assert.equal(client.state.unread, 1); t.mock.timers.tick(250);
  assert.equal(sent.at(-1).after, 101);
  client.receive({ type: 'chat-history', messages: [message(102), message(101)], latest: 102, after: 101, unread: 1, more: true });
  assert.equal(client.state.unread, 1); client.destroy();
});
