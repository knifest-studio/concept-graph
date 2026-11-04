import { DurableObject } from 'cloudflare:workers';
import { nextTemplateColor } from '../graph.mjs';
import { accessModes, boardRole, shareRoles } from './access.mjs';
import { normalizeEmail } from './auth.mjs';

const nanoReservationTtl = 15 * 60 * 1000, maxInvited = 200;
const boardFields = 'b.id, b.name, b.createdAt, COALESCE(b.updatedAt, b.createdAt) AS updatedAt, b.imageCount, b.covers, b.owner, b.ownerName, b.access, b.linkRole';
// A board as one person sees it: their role, never the owner's email.
const shown = ({ owner, invited, covers, ...board }, role) => ({ ...board, covers: JSON.parse(covers), role });
const email = value => { try { return normalizeEmail(value); } catch { return null; } };

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL)');
    const columns = new Set(ctx.storage.sql.exec('PRAGMA table_info(boards)').toArray().map(column => column.name));
    // Boards made before sharing have no owner and stay open to everyone who signs in, with editing, until their owner
    // changes that; they also copy the old team library of custom nodes once (sharedLibrary). New boards set all of these.
    for (const [column, type] of [['updatedAt', 'TEXT'], ['imageCount', 'INTEGER'], ['covers', "TEXT NOT NULL DEFAULT '[]'"], ['owner', 'TEXT'], ['ownerName', 'TEXT'],
      ['access', "TEXT NOT NULL DEFAULT 'everyone'"], ['linkRole', "TEXT NOT NULL DEFAULT 'edit'"], ['sharedLibrary', 'INTEGER NOT NULL DEFAULT 1']]) {
      if (!columns.has(column)) ctx.storage.sql.exec(`ALTER TABLE boards ADD COLUMN ${column} ${type}`);
    }
    // One row per person and board: an invitation (role) and the last visit (openedAt), so a board opened from its link stays in their list.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS board_people (board TEXT NOT NULL, email TEXT NOT NULL, role TEXT, name TEXT, openedAt TEXT, PRIMARY KEY (board, email))');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS board_people_email ON board_people (email)');
    // The site owner, whose address is a Worker secret and never in the repository, owns the boards that have none.
    const siteOwner = email(env?.SITE_OWNER_EMAIL);
    if (siteOwner) ctx.storage.sql.exec('UPDATE boards SET owner = ? WHERE owner IS NULL', siteOwner);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // Nano Banana usage: one row per Generate, open (a reservation) until the room settles it with what the call returned.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS nano_usage (id TEXT PRIMARY KEY, email TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL, images INTEGER NOT NULL, usd REAL NOT NULL, open INTEGER NOT NULL, createdAt INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS nano_usage_month ON nano_usage (month, email, day)');
  }

  // Days and months are UTC. A reservation that was never settled (its room stopped mid-call) stops counting against
  // the person's images after 15 minutes, but its estimate stays in the team's month: Google may have billed the call.
  nanoUsage(email, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    const row = this.ctx.storage.sql.exec(`SELECT COALESCE(SUM(CASE WHEN email = ? AND day = ? AND (open = 0 OR createdAt > ?) THEN images END), 0) AS usedToday,
      COALESCE(SUM(usd), 0) AS teamSpentUsd FROM nano_usage WHERE month = ?`, email, day, now - nanoReservationTtl, day.slice(0, 7)).toArray()[0];
    return { usedToday: row.usedToday, teamSpentUsd: row.teamSpentUsd };
  }

  // Checks and reserves in one step, so two Generates at once cannot both pass a nearly used limit.
  reserveNano(email, { dailyImages, monthlyUsd, estimateUsd }, now = Date.now()) {
    const { usedToday, teamSpentUsd } = this.nanoUsage(email, now);
    if (usedToday + 1 > dailyImages) return { error: `Daily limit reached (${Math.min(usedToday, dailyImages)}/${dailyImages}).`, status: 429 };
    if (teamSpentUsd + estimateUsd > monthlyUsd) return { error: 'Team budget for this month is used up.', status: 429 };
    const id = crypto.randomUUID(), day = new Date(now).toISOString().slice(0, 10);
    this.ctx.storage.sql.exec('INSERT INTO nano_usage (id, email, day, month, images, usd, open, createdAt) VALUES (?, ?, ?, ?, 1, ?, 1, ?)', id, email, day, day.slice(0, 7), estimateUsd, now);
    return { reservation: id };
  }

  // Records what a reserved call produced and cost; a failed call settles to zero, which refunds the reservation.
  settleNano(id, { images, usd }) {
    this.ctx.storage.sql.exec('UPDATE nano_usage SET images = ?, usd = ?, open = 0 WHERE id = ?', Math.max(0, Math.floor(images) || 0), Math.max(0, Number(usd) || 0), id);
  }

  listBoards() {
    return this.ctx.storage.sql.exec('SELECT id, name, createdAt, COALESCE(updatedAt, createdAt) AS updatedAt, imageCount, covers FROM boards ORDER BY COALESCE(updatedAt, createdAt) DESC, rowid DESC').toArray().map(board => ({ ...board, covers: JSON.parse(board.covers) }));
  }

  getBoard(id) {
    const board = this.ctx.storage.sql.exec('SELECT id, name, createdAt, COALESCE(updatedAt, createdAt) AS updatedAt, imageCount, covers FROM boards WHERE id = ?', id).toArray()[0];
    return board ? { ...board, covers: JSON.parse(board.covers) } : null;
  }

  // The boards a person can open, newest first: their own, those they were invited to, those open to everyone, and link boards they opened.
  boardsFor(person) {
    return this.ctx.storage.sql.exec(`SELECT ${boardFields}, p.role AS invited FROM boards b LEFT JOIN board_people p ON p.board = b.id AND p.email = ?
      WHERE b.owner = ? OR p.role IS NOT NULL OR b.access = 'everyone' OR (b.access = 'link' AND p.openedAt IS NOT NULL)
      ORDER BY COALESCE(b.updatedAt, b.createdAt) DESC, b.rowid DESC`, person, person).toArray().map(row => shown(row, boardRole(row, person, row.invited))).filter(board => board.role);
  }

  // One board with this person's role (null when they may not open it); null when there is no such board.
  boardFor(id, person) {
    const row = this.ctx.storage.sql.exec(`SELECT ${boardFields}, p.role AS invited FROM boards b LEFT JOIN board_people p ON p.board = b.id AND p.email = ? WHERE b.id = ?`, person ?? null, id).toArray()[0];
    return row ? shown(row, boardRole(row, person, row.invited)) : null;
  }

  // A new board is private to the person who made it and has no custom nodes yet. Without an owner (as boards made before
  // sharing) it is open to everyone who signs in.
  createBoard(name, owner) {
    const board = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() };
    this.ctx.storage.sql.exec('INSERT INTO boards (id, name, createdAt, updatedAt, imageCount, owner, ownerName, access, linkRole, sharedLibrary) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 0)',
      board.id, board.name, board.createdAt, board.createdAt, owner?.email ?? null, owner?.name ?? null, owner ? 'private' : 'everyone', owner ? 'view' : 'edit');
    return this.getBoard(board.id);
  }

  // Opening records the visit and keeps the names others see current.
  openBoard(id, user) {
    const board = this.boardFor(id, user.email);
    if (!board) return { error: 'Board not found.', status: 404 };
    if (!board.role) return { error: 'You don’t have access to this board.', status: 403, owner: { name: board.ownerName } };
    if (board.role === 'owner') this.ctx.storage.sql.exec('UPDATE boards SET ownerName = ? WHERE id = ? AND ownerName IS NOT ?', user.name, id, user.name);
    else this.ctx.storage.sql.exec('INSERT INTO board_people (board, email, name, openedAt) VALUES (?, ?, ?, ?) ON CONFLICT (board, email) DO UPDATE SET name = excluded.name, openedAt = excluded.openedAt', id, user.email, user.name, new Date().toISOString());
    return { board: { ...board, ownerName: board.role === 'owner' ? user.name : board.ownerName }, sharing: this.sharing(id, user.email) };
  }

  // Who has access, as this person may see it: the owner sees invited people's emails; others see the names of those who opened the board.
  sharing(id, person) {
    const board = this.ctx.storage.sql.exec('SELECT owner, ownerName, access, linkRole FROM boards WHERE id = ?', id).toArray()[0];
    if (!board) return null;
    const people = this.ctx.storage.sql.exec('SELECT email, role, name FROM board_people WHERE board = ? AND role IS NOT NULL ORDER BY rowid', id).toArray();
    const role = boardRole(board, person, people.find(item => item.email === person)?.role), owner = role === 'owner';
    return { role, canManage: owner, owner: board.owner ? { name: board.ownerName, ...(owner ? { email: board.owner } : {}) } : null, access: board.access, linkRole: board.linkRole,
      members: owner ? people.map(item => ({ email: item.email, role: item.role, name: item.name })) : people.filter(item => item.name).map(item => ({ name: item.name, role: item.role })),
      pending: owner ? 0 : people.filter(item => !item.name).length };
  }

  // Owner only. `member` invites someone or changes their role; a null role removes the invitation (a visit from the link stays).
  changeSharing(id, person, { access, linkRole, member } = {}) {
    const board = this.ctx.storage.sql.exec('SELECT owner FROM boards WHERE id = ?', id).toArray()[0];
    if (!board) return { error: 'Board not found.', status: 404 };
    if (!board.owner || board.owner !== person) return { error: board.owner ? 'Only the board’s owner can change who has access.' : 'This board has no owner, so nobody can change who has access.', status: 403 };
    if (access !== undefined && !accessModes.includes(access)) return { error: 'Choose who can open this board.', status: 400 };
    if (linkRole !== undefined && !shareRoles.includes(linkRole)) return { error: 'Choose “Can view” or “Can edit”.', status: 400 };
    let invite;
    if (member !== undefined) {
      if (!member || typeof member !== 'object' || (member.role !== null && !shareRoles.includes(member.role))) return { error: 'Choose “Can view” or “Can edit”.', status: 400 };
      invite = { email: email(member.email), role: member.role };
      if (!invite.email) return { error: 'Enter a valid email address.', status: 400 };
      if (invite.email === board.owner) return { error: 'You already own this board.', status: 400 };
      const invited = this.ctx.storage.sql.exec('SELECT email FROM board_people WHERE board = ? AND role IS NOT NULL', id).toArray();
      if (invite.role && invited.length >= maxInvited && !invited.some(item => item.email === invite.email)) return { error: `A board can have at most ${maxInvited} invited people.`, status: 400 };
    }
    if (access !== undefined || linkRole !== undefined) this.ctx.storage.sql.exec('UPDATE boards SET access = COALESCE(?, access), linkRole = COALESCE(?, linkRole) WHERE id = ?', access ?? null, linkRole ?? null, id);
    if (invite?.role) this.ctx.storage.sql.exec('INSERT INTO board_people (board, email, role) VALUES (?, ?, ?) ON CONFLICT (board, email) DO UPDATE SET role = excluded.role', id, invite.email, invite.role);
    else if (invite) this.ctx.storage.sql.exec('UPDATE board_people SET role = NULL WHERE board = ? AND email = ?', id, invite.email);
    return { sharing: this.sharing(id, person) };
  }

  // For the board's room, which re-checks everyone connected after a sharing change.
  roomAccess(id) {
    const board = this.ctx.storage.sql.exec('SELECT owner, access, linkRole FROM boards WHERE id = ?', id).toArray()[0];
    return board ? { ...board, members: this.ctx.storage.sql.exec('SELECT email, role FROM board_people WHERE board = ? AND role IS NOT NULL', id).toArray().map(item => [item.email, item.role]) } : null;
  }

  // A board made before custom nodes belonged to boards starts with a copy of the old team library, which stays as it was.
  libraryFor(id) {
    return this.ctx.storage.sql.exec('SELECT sharedLibrary FROM boards WHERE id = ?', id).toArray()[0]?.sharedLibrary ? this.listTemplates() : [];
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
