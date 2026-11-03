import { DurableObject } from 'cloudflare:workers';
import { nextTemplateColor } from '../graph.mjs';

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL)');
    const columns = new Set(ctx.storage.sql.exec('PRAGMA table_info(boards)').toArray().map(column => column.name));
    for (const [column, type] of [['updatedAt', 'TEXT'], ['imageCount', 'INTEGER'], ['covers', "TEXT NOT NULL DEFAULT '[]'"]]) {
      if (!columns.has(column)) ctx.storage.sql.exec(`ALTER TABLE boards ADD COLUMN ${column} ${type}`);
    }
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  listBoards() {
    return this.ctx.storage.sql.exec('SELECT id, name, createdAt, COALESCE(updatedAt, createdAt) AS updatedAt, imageCount, covers FROM boards ORDER BY COALESCE(updatedAt, createdAt) DESC, rowid DESC').toArray().map(board => ({ ...board, covers: JSON.parse(board.covers) }));
  }

  getBoard(id) {
    const board = this.ctx.storage.sql.exec('SELECT id, name, createdAt, COALESCE(updatedAt, createdAt) AS updatedAt, imageCount, covers FROM boards WHERE id = ?', id).toArray()[0];
    return board ? { ...board, covers: JSON.parse(board.covers) } : null;
  }

  createBoard(name) {
    const board = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
    this.ctx.storage.sql.exec('INSERT INTO boards (id, name, createdAt, updatedAt, imageCount) VALUES (?, ?, ?, ?, 0)', board.id, board.name, board.createdAt, board.createdAt);
    return this.getBoard(board.id);
  }

  renameBoard(id, name) {
    this.ctx.storage.sql.exec('UPDATE boards SET name = ? WHERE id = ?', name, id);
    return this.getBoard(id);
  }

  updateBoardStats(id, { updatedAt, imageCount, covers }) {
    this.ctx.storage.sql.exec('UPDATE boards SET updatedAt = MAX(COALESCE(updatedAt, createdAt), ?), imageCount = ?, covers = ? WHERE id = ?', updatedAt, imageCount, JSON.stringify(covers), id);
  }

  listTemplates() {
    return this.ctx.storage.sql.exec('SELECT value FROM templates ORDER BY rowid').toArray().map(row => JSON.parse(row.value));
  }

  createTemplate(value) {
    if (this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM templates').toArray()[0].count >= 500) return { error: 'You can save at most 500 custom nodes.', status: 400 };
    const template = { id: crypto.randomUUID(), ...value, color: value.color || nextTemplateColor(this.listTemplates()), createdAt: new Date().toISOString() };
    this.ctx.storage.sql.exec('INSERT INTO templates (id, value) VALUES (?, ?)', template.id, JSON.stringify(template));
    return { template };
  }

  checkTemplate(id, expected) {
    const row = this.ctx.storage.sql.exec('SELECT value FROM templates WHERE id = ?', id).toArray()[0];
    if (!row) return { error: 'Custom node not found.', status: 404 };
    const template = JSON.parse(row.value);
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).length !== Object.keys(template).length
      || !Object.keys(template).every(key => Object.hasOwn(expected, key) && JSON.stringify(expected[key]) === JSON.stringify(template[key]))) {
      return { error: 'Custom node changed. Reopen it to edit the latest version.', status: 409 };
    }
    return { template };
  }

  changeTemplate(id, expected, value) {
    const current = this.checkTemplate(id, expected);
    if (current.error) return current;
    if (value === null) {
      this.ctx.storage.sql.exec('DELETE FROM templates WHERE id = ?', id);
      return { ok: true };
    }
    const template = { id, ...value, createdAt: current.template.createdAt };
    this.ctx.storage.sql.exec('UPDATE templates SET value = ? WHERE id = ?', JSON.stringify(template), id);
    return { template };
  }
}
