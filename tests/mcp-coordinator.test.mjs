import test from 'node:test';
import assert from 'node:assert/strict';
import { McpCoordinator } from '../mcp-coordinator.mjs';

function fixture(onEvent = () => {}) {
  const board = { id: 'board', graph: { revision: 0, runs: [], nodes: [] } };
  const coordinator = new McpCoordinator({ board: id => { if (id !== board.id) throw new Error('missing board'); return board; }, timeout: 40 });
  const events = [];
  const id = coordinator.register(board.id);
  let editor;
  const stream = { write(message) {
    const event = /^event: (.+)$/m.exec(message)?.[1], payload = JSON.parse(/^data: (.+)$/m.exec(message)[1]);
    events.push(event);
    queueMicrotask(() => onEvent({ event, payload, coordinator, board, id, editor, stream }));
  } };
  editor = coordinator.attach(id, board.id, stream);
  coordinator.ready(id, 0);
  return { coordinator, board, editor, id, stream, events };
}
const acknowledge = ({ event, payload, coordinator, board, id }) => {
  if (event === 'mcp-prepare') coordinator.ack(id, { id: payload.id, phase: 'prepared', revision: board.graph.revision });
  if (event === 'mcp-commit') coordinator.ack(id, { id: payload.id, phase: 'applied', revision: board.graph.revision });
};
const expectStatus = (promise, status) => assert.rejects(promise, error => error.status === status);

test('coordinator flushes, commits, acknowledges and releases the live editor', async () => {
  const f = fixture(acknowledge);
  const result = await f.coordinator.execute('board', 0, async board => { board.graph.revision++; return { revision: board.graph.revision }; });
  assert.deepEqual(result, { revision: 1, applied: true, uiSynchronized: true });
  assert.deepEqual(f.events, ['mcp-prepare', 'mcp-commit', 'mcp-release']);
  assert.equal(f.coordinator.barriers.size, 0);
});

test('unsaved user edit invalidates stale agent revision without committing', async () => {
  const f = fixture(context => { if (context.event === 'mcp-prepare') context.board.graph.revision++; acknowledge(context); });
  let applied = false;
  await expectStatus(f.coordinator.execute('board', 0, async () => { applied = true; }), 409);
  assert.equal(applied, false); assert.deepEqual(f.events, ['mcp-prepare', 'mcp-abort']);
});

test('coordinator refuses active generation, multiple editors, disconnected editor and in-flight writers', async () => {
  const f = fixture(acknowledge);
  f.board.graph.runs.push({ status: 'running' });
  await expectStatus(f.coordinator.execute('board', 0, async () => ({})), 423);
  f.board.graph.runs = [];
  const second = f.coordinator.register('board');
  await expectStatus(f.coordinator.execute('board', 0, async () => ({})), 423);
  f.coordinator.close(second);
  f.coordinator.detach(f.editor, f.stream);
  await expectStatus(f.coordinator.execute('board', 0, async () => ({})), 423);
  f.coordinator.close(f.id);
  const end = f.coordinator.beginWriter('board');
  await expectStatus(f.coordinator.execute('board', 0, async () => ({})), 423);
  end();
  assert.equal((await f.coordinator.execute('board', 0, async () => ({}))).applied, true);
});

test('barrier blocks new editors and rogue writers while allowing the matching save', async () => {
  let blocked = false, allowed = false;
  const f = fixture(context => {
    if (context.event === 'mcp-prepare') {
      assert.throws(() => context.coordinator.register('board'), error => error.status === 423);
      assert.throws(() => context.coordinator.beginWriter('board'), error => error.status === 423);
      blocked = true;
      const end = context.coordinator.beginWriter('board', context.id, context.payload.id); end(); allowed = true;
    }
    acknowledge(context);
  });
  await f.coordinator.execute('board', 0, async () => ({}));
  assert.equal(blocked, true); assert.equal(allowed, true);
});

test('disconnect before commit fails without applying; disconnect after commit reports applied without UI ACK', async () => {
  const before = fixture(context => { if (context.event === 'mcp-prepare') context.coordinator.detach(context.editor, context.stream); });
  let calls = 0;
  await expectStatus(before.coordinator.execute('board', 0, async () => { calls++; return {}; }), 503);
  assert.equal(calls, 0);
  const after = fixture(context => {
    if (context.event === 'mcp-prepare') acknowledge(context);
    if (context.event === 'mcp-commit') context.coordinator.detach(context.editor, context.stream);
  });
  const result = await after.coordinator.execute('board', 0, async board => { calls++; board.graph.revision++; return { revision: board.graph.revision }; });
  assert.equal(calls, 1); assert.equal(result.applied, true); assert.equal(result.uiSynchronized, false);
  assert.equal(after.board.graph.revision, 1);
});

test('missing ACK times out without committing and releases the barrier', async () => {
  const f = fixture(); let applied = false;
  await expectStatus(f.coordinator.execute('board', 0, async () => { applied = true; }), 503);
  assert.equal(applied, false); assert.equal(f.coordinator.barriers.size, 0);
  assert.deepEqual(f.events, ['mcp-prepare', 'mcp-abort']);
});

test('UI history requests admit only the matching editor flush and reject racing runs', async () => {
  const f = fixture(context => {
    if (context.event !== 'mcp-ui-request') return;
    assert.throws(() => context.coordinator.register('board'), error => error.status === 423);
    assert.throws(() => context.coordinator.beginWriter('board'), error => error.status === 423);
    assert.throws(() => context.coordinator.beginWriter('board', context.id), error => error.status === 423);
    const done = context.coordinator.beginWriter('board', context.id, null, context.payload.id); done();
    context.coordinator.uiResult(context.id, { id: context.payload.id, changed: true, saved: true });
  });
  const writer = f.coordinator.beginWriter('board', f.id);
  await expectStatus(f.coordinator.requestUI('undo'), 423);
  writer();
  assert.deepEqual(await f.coordinator.requestUI('undo'), { changed: true, saved: true });
});

test('screenshot returns only validated PNG bytes from the active editor', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const f = fixture(context => {
    if (context.event === 'mcp-ui-request') context.coordinator.uiResult(context.id, { id: context.payload.id, mimeType: 'image/png', data: png.toString('base64') });
  });
  assert.deepEqual(await f.coordinator.requestUI('screenshot'), png);
});

test('reload resumes only a disconnected same-board editor with a fresh ID; late close cannot close it', async () => {
  const f = fixture();
  assert.throws(() => f.coordinator.register('board', f.id), error => error.status === 423);
  f.coordinator.detach(f.editor, f.stream);
  await expectStatus(f.coordinator.execute('board', 0, async () => ({})), 423);
  const replacement = f.coordinator.register('board', f.id);
  assert.notEqual(replacement, f.id);
  assert.throws(() => f.coordinator.close(f.id), error => error.status === 403);
  const stream = { write() {} };
  const editor = f.coordinator.attach(replacement, 'board', stream);
  f.coordinator.ready(replacement, 0);
  assert.equal(editor.ready, true);
});

test('a dropped SSE without an explicit pagehide/resume does not remove the old editor', async () => {
  const f = fixture();
  f.coordinator.detach(f.editor, f.stream);
  const other = f.coordinator.register('board');
  const stream = { write() {} };
  f.coordinator.attach(other, 'board', stream);
  f.coordinator.ready(other, 0);
  await expectStatus(f.coordinator.execute('board', 0, async () => ({})), 423);
});

test('select-board ACK waits for the new editor and reports an applied selection if preferences fail', async () => {
  async function scenario(failPreferences) {
    const boards = new Map(['a', 'b'].map(id => [id, { id, graph: { revision: 0, runs: [] } }]));
    const c = new McpCoordinator({ board: id => boards.get(id), timeout: 100 });
    const first = c.register('a');
    const stream = { write(message) {
      const payload = JSON.parse(/^data: (.+)$/m.exec(message)[1]);
      queueMicrotask(() => {
        c.close(first);
        const second = c.register('b');
        c.attach(second, 'b', { write() {} }); c.ready(second, 0);
        c.uiResult(second, { id: payload.id, ...(failPreferences ? { error: 'The board is open, but the selection could not be saved. Do not repeat.' } : { boardId: 'b' }) });
      });
    } };
    c.attach(first, 'a', stream); c.ready(first, 0);
    return c.requestUI('select_board', 'b');
  }
  assert.deepEqual(await scenario(false), { boardId: 'b', selected: true });
  await assert.rejects(scenario(true), error => error.status === 423 && /board is open/.test(error.message));
});
