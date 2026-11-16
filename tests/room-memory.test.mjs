import test from 'node:test';
import assert from 'node:assert/strict';
import { answerMemoryFactor, base64Bytes, callMemoryBytes, expectedOutputBytes, MemoryBudget, model3dMemoryBytes, queueWaitTimeout, requestBytes, roomMemoryBudget, upscaleOutputBytes } from '../cloud/room-memory.mjs';

test('memory leases are FIFO, including an oversized head that must run alone', async () => {
  const budget = new MemoryBudget(10), first = await budget.acquire(6), seen = [];
  const large = budget.acquire(12).then(lease => { seen.push('large'); return lease; });
  const small = budget.acquire(2).then(lease => { seen.push('small'); return lease; });
  await Promise.resolve(); assert.deepEqual(seen, []); assert.equal(budget.used, 6);
  first.release();
  const alone = await large;
  assert.equal(budget.used, 12); assert.deepEqual(seen, ['large']);
  alone.release();
  const last = await small;
  assert.deepEqual(seen, ['large', 'small']); assert.equal(budget.used, 2);
  last.release(); assert.equal(budget.used, 0);
});

test('resizing accounts for retained bytes and drains waiters; release is idempotent', async () => {
  const budget = new MemoryBudget(10), first = await budget.acquire(8);
  const waiting = budget.acquire(4);
  first.resize(6);
  const second = await waiting;
  assert.equal(budget.used, 10);
  first.resize(3); assert.equal(budget.used, 7);
  first.release(); first.release(); first.resize(100);
  assert.equal(budget.used, 4);
  second.release(); assert.equal(budget.used, 0);
});

test('aborting a waiting head rejects it and admits the next waiter immediately', async () => {
  const budget = new MemoryBudget(10), first = await budget.acquire(6), controller = new AbortController();
  const rejected = assert.rejects(budget.acquire(8, controller.signal), { name: 'AbortError' });
  const waiting = budget.acquire(4);
  controller.abort(); await rejected;
  const second = await waiting;
  assert.equal(budget.used, 10); assert.equal(budget.queue.length, 0);
  await assert.rejects(budget.acquire(1, controller.signal), { name: 'AbortError' });
  first.release(); second.release(); assert.equal(budget.used, 0);
});

test('memory estimates include request copies, lean answers, upscale pixels and the sequential 3D lane', () => {
  const mb = 1024 * 1024;
  assert.equal(roomMemoryBudget, 64 * mb);
  assert.deepEqual(['1K', '2K', '4K'].map(imageSize => expectedOutputBytes({ imageSize })), [mb, 2.5 * mb, 6 * mb]);
  assert.deepEqual(['1K', '2K', '4K'].map(imageSize => expectedOutputBytes({ gpt: true, imageSize })), [4 * mb, 10 * mb, 24 * mb]);
  assert.equal(expectedOutputBytes({ describe: true }), mb);
  assert.equal(callMemoryBytes(123, mb), 123 + answerMemoryFactor * mb);
  assert.equal(base64Bytes(4), 8);
  for (const text of ['ascii', 'Київ', '🤖', '\ud800']) assert.equal(requestBytes(text), Buffer.byteLength(text));
  assert.equal(upscaleOutputBytes({ nano: true, scale: 4 }), 6 * mb);
  assert.equal(upscaleOutputBytes({ scale: 4, source: { width: 4096, height: 2048 } }), 8192 * 4096 * 3);
  assert.equal(model3dMemoryBytes(2 * mb), 20 * mb); assert.equal(model3dMemoryBytes(20 * mb), 44 * mb);
  assert.equal(queueWaitTimeout(5 * 60 * 1000), 9 * 60 * 1000);
  assert.equal(queueWaitTimeout(14 * 60 * 1000), 60 * 1000);
});
