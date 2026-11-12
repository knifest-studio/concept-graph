import { boardAuthor } from '../src/annotations.mjs';

export const chatLimit = 5000, chatPage = 50, chatBurst = 8, chatWindow = 10000;
export function chatInput(value) {
  const text = typeof value?.text === 'string' ? value.text.trim() : '';
  if (!text || text.length > 2000) throw new Error('Use 1–2000 characters for a message.');
  if (value.nodeId !== undefined && (typeof value.nodeId !== 'string' || !value.nodeId || value.nodeId.length > 120)) throw new Error('Invalid node link.');
  return { text, ...(value.nodeId ? { nodeId: value.nodeId } : {}) };
}
export function chatCursor(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid chat cursor.');
  return value;
}
export const canDeleteChat = (message, user) => !!user?.email && (message.author.email === user.email || user.role === 'owner');
const shown = row => ({ id: row.id, time: row.time, author: { name: row.name, color: row.color, email: row.email }, text: row.text,
  ...(row.node_id ? { nodeId: row.node_id } : {}), ...(row.agent ? { agent: true } : {}), deleted: !!row.deleted });

// Separate from Yjs: conversation never changes canvas revisions, exports or version snapshots.
export class BoardChat {
  constructor(sql) {
    this.sql = sql;
    sql.exec('CREATE TABLE IF NOT EXISTS board_chat (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, email TEXT NOT NULL, text TEXT NOT NULL, node_id TEXT, agent INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, client_key TEXT, UNIQUE(email, client_key))');
    sql.exec('CREATE TABLE IF NOT EXISTS chat_limits (sender TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    if (!sql.exec('PRAGMA table_info(chat_limits)').toArray().some(column => column.name === 'times')) sql.exec("ALTER TABLE chat_limits ADD COLUMN times TEXT NOT NULL DEFAULT '[]'");
  }
  history({ before, after = 0 } = {}, email) {
    chatCursor(before); chatCursor(after);
    const rows = this.sql.exec('SELECT * FROM board_chat WHERE id < ? ORDER BY id DESC LIMIT ?', before ?? Number.MAX_SAFE_INTEGER, chatPage + 1).toArray();
    const latest = this.sql.exec('SELECT MAX(id) AS id FROM board_chat').toArray()[0].id || 0;
    const unread = this.sql.exec('SELECT COUNT(*) AS count FROM board_chat WHERE id > ? AND email != ? AND deleted = 0', after, email || '').toArray()[0].count;
    return { messages: rows.slice(0, chatPage).map(shown), more: rows.length > chatPage, latest, unread };
  }
  send(value, user, { key, sender = user?.email, agent = false, now = Date.now() } = {}) {
    const input = chatInput(value), author = boardAuthor(user);
    if (!author || !user.email) throw new Error('Sign in required.');
    if (key !== undefined && (typeof key !== 'string' || !key || key.length > 120)) throw new Error('Invalid message key.');
    // Retried optimistic sends keep one durable copy, even after reconnect or hibernation.
    const previous = key && this.sql.exec('SELECT * FROM board_chat WHERE email = ? AND client_key = ?', user.email, key).toArray()[0];
    if (previous) return { message: shown(previous), duplicate: true };
    const last = this.sql.exec('SELECT at, times FROM chat_limits WHERE sender = ?', sender).toArray()[0];
    // Keep the sliding window in SQLite so a room waking from hibernation cannot grant another burst.
    const stored = last ? JSON.parse(last.times) : [], times = (stored.length ? stored : last ? [last.at] : []).filter(at => at > now - chatWindow);
    if (times.length >= chatBurst) throw new Error('Wait a moment before sending another message.');
    this.sql.exec('INSERT OR REPLACE INTO chat_limits (sender, at, times) VALUES (?, ?, ?)', sender, now, JSON.stringify([...times, now]));
    this.sql.exec('DELETE FROM chat_limits WHERE at < ?', now - 60000);
    const row = this.sql.exec('INSERT INTO board_chat (time, name, color, email, text, node_id, agent, client_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
      new Date(now).toISOString(), author.name, author.color || '#6b6e89', user.email, input.text, input.nodeId || null, agent ? 1 : 0, key || null).toArray()[0];
    this.sql.exec('DELETE FROM board_chat WHERE id NOT IN (SELECT id FROM board_chat ORDER BY id DESC LIMIT ?)', chatLimit);
    return { message: shown(row), duplicate: false };
  }
  delete(id, user) {
    chatCursor(id);
    const row = this.sql.exec('SELECT * FROM board_chat WHERE id = ?', id ?? 0).toArray()[0];
    if (!row) throw new Error('Message not found.');
    if (!canDeleteChat(shown(row), user)) throw new Error('You can only delete your own messages.');
    this.sql.exec("UPDATE board_chat SET text = '', node_id = NULL, deleted = 1 WHERE id = ?", id);
    return { id, author: shown(row).author };
  }
}
