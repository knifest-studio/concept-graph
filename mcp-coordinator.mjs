import { randomUUID } from 'node:crypto';

const error = (status, message) => Object.assign(new Error(message), { status });

// A desktop editor registers before reading its board and remains registered until it closes.
export class McpCoordinator {
  constructor({ board, timeout = 8000 }) {
    this.board = board;
    this.timeout = timeout;
    this.editors = new Map();
    this.barriers = new Map();
    this.writers = new Map();
    this.uiRequest = null;
  }
  register(boardId, previousEditorId) {
    this.board(boardId);
    if (this.barriers.has(boardId)) throw error(423, 'The board is being updated by an agent. Try again.');
    if (this.uiRequest && this.uiRequest.action !== 'screenshot' && !(this.uiRequest.action === 'select_board' && this.uiRequest.boardId === boardId)) throw error(423, 'The editor is handling an agent request. Try again.');
    if (previousEditorId) {
      const previous = this.editors.get(previousEditorId);
      if (previous && previous.boardId !== boardId) throw error(403, 'Editor session belongs to another board.');
      if (previous?.stream) throw error(423, 'The previous editor is still closing.');
      if (previous) this.editors.delete(previousEditorId);
    }
    const editor = { id: randomUUID(), boardId, ready: false, stream: null };
    this.editors.set(editor.id, editor);
    return editor.id;
  }
  editor(id, boardId) {
    const editor = this.editors.get(id);
    if (!editor || (boardId && editor.boardId !== boardId)) throw error(403, 'Unknown editor session.');
    return editor;
  }
  attach(id, boardId, stream) {
    const editor = this.editor(id, boardId);
    if (this.barriers.has(boardId)) throw error(423, 'The board is being updated by an agent.');
    if (editor.stream) throw error(409, 'Editor session is already connected.');
    editor.stream = stream; editor.ready = false;
    return editor;
  }
  detach(editor, stream) {
    if (editor.stream !== stream) return;
    editor.stream = null; editor.ready = false;
    const barrier = this.barriers.get(editor.boardId);
    if (barrier?.editor === editor && barrier.waiting) barrier.waiting.reject(error(503, 'The editor disconnected.'));
    if (this.uiRequest?.editor === editor && this.uiRequest.action !== 'select_board') {
      const message = this.uiRequest.action === 'screenshot' ? 'The editor disconnected.' : 'The editor disconnected; the operation may have completed. Check the board before retrying.';
      this.uiRequest.reject(error(503, message));
    }
  }
  close(id) {
    const editor = this.editor(id);
    this.detach(editor, editor.stream);
    this.editors.delete(id);
  }
  ready(id, revision) {
    const editor = this.editor(id);
    if (!editor.stream || this.barriers.has(editor.boardId)) throw error(423, 'Editor is not ready.');
    if (this.board(editor.boardId).graph.revision !== revision) throw error(409, 'Board changed while opening.');
    editor.ready = true;
  }
  ack(editorId, { id, phase, revision, message }) {
    const editor = this.editor(editorId), barrier = this.barriers.get(editor.boardId);
    if (!barrier || barrier.id !== id || barrier.editor !== editor || !barrier.waiting || barrier.waiting.phase !== phase) throw error(409, 'No matching editor request.');
    if (message) barrier.waiting.reject(error(423, String(message).slice(0, 500)));
    else barrier.waiting.resolve(revision);
  }
  beginWriter(boardId, editorId, barrierId, uiRequestId) {
    const barrier = this.barriers.get(boardId);
    if (barrier && !(barrier.phase === 'preparing' && barrier.editor?.id === editorId && barrier.id === barrierId)) throw error(423, 'The board is being updated by an agent.');
    const ui = this.uiRequest;
    if (ui && ui.action !== 'screenshot' && ui.editor.boardId === boardId && !(ui.editor.id === editorId && ui.id === uiRequestId)) throw error(423, 'The editor is handling an agent request.');
    const registered = [...this.editors.values()].filter(item => item.boardId === boardId);
    if (registered.length && !registered.some(item => item.id === editorId && item.stream)) throw error(423, 'The board is open in another editor.');
    this.writers.set(boardId, (this.writers.get(boardId) || 0) + 1);
    return () => {
      const count = (this.writers.get(boardId) || 1) - 1;
      if (count) this.writers.set(boardId, count); else this.writers.delete(boardId);
    };
  }
  async exchange(barrier, phase, event, payload) {
    const editor = barrier.editor;
    if (!editor?.stream || !editor.ready) throw error(503, 'The editor is not connected.');
    const waiting = {};
    const promise = new Promise((resolve, reject) => { waiting.resolve = resolve; waiting.reject = reject; });
    waiting.phase = phase;
    barrier.waiting = waiting;
    const timer = setTimeout(() => waiting.reject(error(503, 'The editor did not respond.')), this.timeout);
    try {
      editor.stream.write(`event: ${event}\ndata: ${JSON.stringify({ id: barrier.id, ...payload })}\n\n`);
      return await promise;
    } finally { clearTimeout(timer); if (barrier.waiting === waiting) barrier.waiting = null; }
  }
  async execute(boardId, revision, action) {
    const board = this.board(boardId);
    if (this.uiRequest || this.barriers.has(boardId) || this.writers.has(boardId)) throw error(423, 'The board is busy. Try again.');
    if (board.graph.runs.some(run => ['queued', 'running'].includes(run.status))) throw error(423, 'Wait for generation to finish before changing this board.');
    const editors = [...this.editors.values()].filter(item => item.boardId === boardId);
    if (editors.length > 1 || editors.some(item => !item.ready || !item.stream)) throw error(423, 'The board is open in multiple or disconnected editors.');
    const barrier = { id: randomUUID(), editor: editors[0], phase: 'preparing', waiting: null };
    this.barriers.set(boardId, barrier);
    let applied = false;
    try {
      if (barrier.editor) {
        const preparedRevision = await this.exchange(barrier, 'prepared', 'mcp-prepare', {});
        if (preparedRevision !== board.graph.revision) throw error(409, 'The editor and board are out of sync.');
      }
      if (this.writers.has(boardId)) throw error(423, 'The board is still saving. Try again.');
      if (board.graph.revision !== revision) throw error(409, 'Board changed while saving. Read it again and retry.');
      if (board.graph.runs.some(run => ['queued', 'running'].includes(run.status))) throw error(423, 'Wait for generation to finish.');
      if (barrier.editor && (!barrier.editor.stream || !barrier.editor.ready)) throw error(503, 'The editor disconnected.');
      barrier.phase = 'committing';
      const ensureConnected = () => {
        if (barrier.editor && (!barrier.editor.stream || !barrier.editor.ready)) throw error(503, 'The editor disconnected.');
      };
      const result = await action(board, ensureConnected);
      applied = true;
      let uiSynchronized = !barrier.editor;
      if (barrier.editor) {
        try {
          const appliedRevision = await this.exchange(barrier, 'applied', 'mcp-commit', { graph: structuredClone(board.graph) });
          if (appliedRevision !== board.graph.revision) throw error(409, 'The editor applied a different revision.');
          uiSynchronized = true;
        }
        catch { barrier.editor.ready = false; }
      }
      if (barrier.editor?.stream && uiSynchronized) {
        try { barrier.editor.stream.write(`event: mcp-release\ndata: ${JSON.stringify({ id: barrier.id })}\n\n`); }
        catch { barrier.editor.ready = false; uiSynchronized = false; }
      }
      return { ...result, applied: true, uiSynchronized };
    } finally {
      try { if (!applied && barrier.editor?.stream) barrier.editor.stream.write(`event: mcp-abort\ndata: ${JSON.stringify({ id: barrier.id })}\n\n`); }
      catch {} finally { this.barriers.delete(boardId); }
    }
  }
  async requestUI(action, boardId) {
    if (this.uiRequest || this.barriers.size) throw error(423, 'The editor is busy. Try again.');
    const editors = [...this.editors.values()];
    if (editors.length !== 1 || !editors[0].stream || !editors[0].ready) throw error(423, 'Exactly one connected desktop editor is required.');
    const editor = editors[0];
    if (action !== 'screenshot' && this.writers.has(editor.boardId)) throw error(423, 'The board is still saving. Try again.');
    if (action === 'select_board') {
      this.board(boardId);
      if (editor.boardId === boardId) return { boardId, selected: true };
    } else if (action === 'undo' || action === 'redo') {
      if (this.board(editor.boardId).graph.runs.some(run => ['queued', 'running'].includes(run.status))) throw error(423, 'Wait for generation to finish.');
    } else if (action !== 'screenshot') throw error(400, 'Unsupported editor request.');
    const pending = { id: randomUUID(), action, boardId, editor };
    const result = new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; });
    this.uiRequest = pending;
    const timer = setTimeout(() => pending.reject(error(503, 'The editor did not confirm the request; it may have completed.')), 30000);
    try {
      editor.stream.write(`event: mcp-ui-request\ndata: ${JSON.stringify({ id: pending.id, action, ...(boardId ? { boardId } : {}) })}\n\n`);
      return await result;
    } finally { clearTimeout(timer); if (this.uiRequest === pending) this.uiRequest = null; }
  }
  uiResult(editorId, value) {
    const pending = this.uiRequest, editor = this.editor(editorId);
    if (!pending || value.id !== pending.id) throw error(409, 'No matching editor request.');
    if (value.error) {
      if (editor !== pending.editor && !(pending.action === 'select_board' && editor.boardId === pending.boardId)) throw error(403, 'Unexpected editor session.');
      pending.reject(error(423, String(value.error).slice(0, 500))); return;
    }
    if (!editor.ready || !editor.stream) throw error(423, 'Editor is not ready.');
    if (pending.action === 'select_board') {
      if (editor.boardId !== pending.boardId || value.boardId !== pending.boardId) throw error(409, 'The requested board is not active.');
      pending.resolve({ boardId: editor.boardId, selected: true }); return;
    }
    if (pending.action === 'undo' || pending.action === 'redo') {
      if (editor !== pending.editor || typeof value.changed !== 'boolean' || typeof value.saved !== 'boolean') throw error(400, 'Invalid history result.');
      pending.resolve({ changed: value.changed, saved: value.saved, ...(value.warning ? { warning: String(value.warning).slice(0, 500) } : {}) }); return;
    }
    if (editor !== pending.editor || value.mimeType !== 'image/png' || typeof value.data !== 'string' || value.data.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw error(400, 'Invalid screenshot.');
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.length > 8 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw error(400, 'Invalid screenshot.');
    pending.resolve(bytes);
  }
}
