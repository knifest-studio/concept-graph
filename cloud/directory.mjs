import { DurableObject } from 'cloudflare:workers';
import { nextTemplateColor } from '../graph.mjs';
import { accessModes, boardRole, canEdit, shareRoles } from './access.mjs';
import { normalizeEmail } from './auth.mjs';
import { nanoAllowed } from './nano-banana.mjs';

const nanoReservationTtl = 15 * 60 * 1000, maxInvited = 200, maxNanoEntries = 1000, maxAccessRequests = 500, maxBoardRequests = 100, maxModel3dEntries = 1000, maxVideoEntries = 1000, trashDays = 30, dayMs = 24 * 60 * 60 * 1000;
const boardFields = 'b.id, b.name, b.createdAt, COALESCE(b.updatedAt, b.createdAt) AS updatedAt, b.imageCount, b.covers, b.owner, b.ownerName, b.access, b.linkRole';
// A board as one person sees it: their role, never the owner's email.
const shown = ({ owner, invited, covers, requestCount, ...board }, role) => ({ ...board, covers: JSON.parse(covers), role, ...(role === 'owner' && requestCount ? { requests: requestCount } : {}) });
const email = value => { try { return normalizeEmail(value); } catch { return null; } };
// What a paid call made, as the Spending window groups it; anything else is stored as unknown.
export const spendKinds = ['nano', 'gpt', 'describe', 'upscale', 'model3d', 'video'];
const spendKind = kind => spendKinds.includes(kind) ? kind : null;
// An allowed entry: one email, or a whole domain written @example.com (a bare domain is read as one).
const accessEntry = value => {
  if (typeof value !== 'string') return null;
  const entry = value.trim().toLowerCase(), domain = entry.startsWith('@') ? entry.slice(1) : entry.includes('@') ? null : entry;
  if (domain === null) return email(entry);
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ? `@${domain}` : null;
};

export class Directory extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL)');
    const columns = new Set(ctx.storage.sql.exec('PRAGMA table_info(boards)').toArray().map(column => column.name));
    // Boards made before sharing have no owner and stay open to everyone who signs in, with editing, until their owner
    // changes that; they also copy the old team library of custom nodes once (sharedLibrary). New boards set all of these.
    for (const [column, type] of [['updatedAt', 'TEXT'], ['imageCount', 'INTEGER'], ['covers', "TEXT NOT NULL DEFAULT '[]'"], ['owner', 'TEXT'], ['ownerName', 'TEXT'],
      ['access', "TEXT NOT NULL DEFAULT 'everyone'"], ['linkRole', "TEXT NOT NULL DEFAULT 'edit'"], ['sharedLibrary', 'INTEGER NOT NULL DEFAULT 1'], ['deletedAt', 'TEXT'], ['deletedBy', 'TEXT']]) {
      if (!columns.has(column)) ctx.storage.sql.exec(`ALTER TABLE boards ADD COLUMN ${column} ${type}`);
    }
    // One row per person and board: an invitation (role) and the last visit (openedAt), so a board opened from its link stays in their list.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS board_people (board TEXT NOT NULL, email TEXT NOT NULL, role TEXT, name TEXT, openedAt TEXT, PRIMARY KEY (board, email))');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS board_people_email ON board_people (email)');
    // People who asked the owner for more: to come in (role NULL) when the board is closed to them, or to edit ('edit') when
    // they may only view it. A request waits until the owner chooses their role, dismisses it, or opens the link so far it is granted.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS board_requests (board TEXT NOT NULL, email TEXT NOT NULL, name TEXT, requestedAt TEXT NOT NULL, PRIMARY KEY (board, email))');
    if (!ctx.storage.sql.exec('PRAGMA table_info(board_requests)').toArray().some(column => column.name === 'role')) ctx.storage.sql.exec('ALTER TABLE board_requests ADD COLUMN role TEXT');
    // The site owner, whose address is a Worker secret and never in the repository, owns the boards that have none.
    const siteOwner = email(env?.SITE_OWNER_EMAIL);
    if (siteOwner) ctx.storage.sql.exec('UPDATE boards SET owner = ? WHERE owner IS NULL', siteOwner);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // Shared site-provider usage: one row per paid call, open until the room settles it. Keep existing rows and limits.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS nano_usage (id TEXT PRIMARY KEY, email TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL, images INTEGER NOT NULL, usd REAL NOT NULL, open INTEGER NOT NULL, createdAt INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS nano_usage_month ON nano_usage (month, email, day)');
    // What each call made (see spendKinds), for the owner's Spending window; rows from before it was recorded have none.
    if (!ctx.storage.sql.exec('PRAGMA table_info(nano_usage)').toArray().some(column => column.name === 'kind')) ctx.storage.sql.exec('ALTER TABLE nano_usage ADD COLUMN kind TEXT');
    // Who may use the site's Gemini and OpenAI keys (emails and @domains), and the admins who decide it. The list used to be the
    // NANO_BANANA_ALLOWED variable: it is copied in once, and from then on admins keep it on the site.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS nano_access (entry TEXT PRIMARY KEY, addedBy TEXT, addedAt TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS video_access (email TEXT PRIMARY KEY, addedBy TEXT, addedAt TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS model3d_access (email TEXT PRIMARY KEY, addedBy TEXT, addedAt TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS site_admins (email TEXT PRIMARY KEY, addedBy TEXT, addedAt TEXT NOT NULL)');
    // People without image access who asked for it, shown to admins in Team access until access is given or the request dismissed.
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS access_requests (email TEXT PRIMARY KEY, name TEXT, requestedAt TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // Only the owner keeps 3D on deploy; record the seed so a later revocation survives room restarts.
    if (!ctx.storage.sql.exec("SELECT 1 FROM site_settings WHERE key = 'model3dImported'").toArray().length) {
      const now = new Date().toISOString();
      if (siteOwner) ctx.storage.sql.exec('INSERT OR IGNORE INTO model3d_access (email, addedBy, addedAt) VALUES (?, NULL, ?)', siteOwner, now);
      ctx.storage.sql.exec("INSERT INTO site_settings (key, value) VALUES ('model3dImported', ?)", JSON.stringify({ at: now }));
    }
    if (!ctx.storage.sql.exec("SELECT 1 FROM site_settings WHERE key = 'videoImported'").toArray().length) {
      const now = new Date().toISOString();
      if (siteOwner) ctx.storage.sql.exec('INSERT OR IGNORE INTO video_access (email, addedBy, addedAt) VALUES (?, NULL, ?)', siteOwner, now);
      ctx.storage.sql.exec("INSERT INTO site_settings (key, value) VALUES ('videoImported', ?)", JSON.stringify({ at: now }));
    }
    // Anyone with a Google account can sign in, so the boards made before sharing, open to everyone who signs in, move once
    // to "anyone with the link": people who opened them keep them, editing included, and strangers no longer see them.
    if (!ctx.storage.sql.exec("SELECT 1 FROM site_settings WHERE key = 'legacyLinkAccess'").toArray().length) {
      const moved = ctx.storage.sql.exec("UPDATE boards SET access = 'link' WHERE access = 'everyone' AND sharedLibrary = 1 RETURNING id").toArray().length;
      ctx.storage.sql.exec("INSERT INTO site_settings (key, value) VALUES ('legacyLinkAccess', ?)", JSON.stringify({ at: new Date().toISOString(), boards: moved }));
    }
    if (!ctx.storage.sql.exec("SELECT 1 FROM site_settings WHERE key = 'nanoImported'").toArray().length) {
      const now = new Date().toISOString(), entries = String(env?.NANO_BANANA_ALLOWED || '').split(/[\s,;]+/).map(accessEntry).filter(Boolean);
      for (const entry of entries) ctx.storage.sql.exec('INSERT OR IGNORE INTO nano_access (entry, addedBy, addedAt) VALUES (?, NULL, ?)', entry, now);
      ctx.storage.sql.exec("INSERT INTO site_settings (key, value) VALUES ('nanoImported', ?)", JSON.stringify({ at: now, entries: entries.length }));
    }
  }

  // The site owner, named by the SITE_OWNER_EMAIL secret, is always an admin and the only one who appoints others.
  siteRole(person) {
    const address = email(person);
    if (!address) return null;
    if (address === email(this.env?.SITE_OWNER_EMAIL)) return 'owner';
    return this.ctx.storage.sql.exec('SELECT 1 FROM site_admins WHERE email = ?', address).toArray().length ? 'admin' : null;
  }

  nanoEntries() { return this.ctx.storage.sql.exec('SELECT entry, addedBy, addedAt FROM nano_access ORDER BY entry').toArray().map(row => ({ ...row })); }
  nanoAllowed(person) { return nanoAllowed(person, this.nanoEntries().map(row => row.entry).join(',')); }
  model3dEntries() { return this.ctx.storage.sql.exec('SELECT email, addedBy, addedAt FROM model3d_access ORDER BY email').toArray().map(row => ({ ...row })); }
  model3dAllowed(person) { const address = email(person); return !!address && !!this.ctx.storage.sql.exec('SELECT 1 FROM model3d_access WHERE email = ?', address).toArray().length; }
  videoEntries() { return this.ctx.storage.sql.exec('SELECT email, addedBy, addedAt FROM video_access ORDER BY email').toArray().map(row => ({ ...row })); }
  videoAllowed(person) { const address = email(person); return !!address && !!this.ctx.storage.sql.exec('SELECT 1 FROM video_access WHERE email = ?', address).toArray().length; }

  // Display names of the people who give generation access (the owner first, then admins by seniority), shown to people
  // who lack it so they know whom to ask. Names only, as boards show them; never emails.
  adminNames() {
    const owner = email(this.env?.SITE_OWNER_EMAIL), admins = this.ctx.storage.sql.exec('SELECT email FROM site_admins ORDER BY addedAt').toArray().map(row => row.email);
    // A board's owner keeps their name on the board itself; everyone else's visits record it in board_people.
    const name = address => this.ctx.storage.sql.exec('SELECT name FROM board_people WHERE email = ? AND name IS NOT NULL ORDER BY openedAt DESC LIMIT 1', address).toArray()[0]?.name
      || this.ctx.storage.sql.exec('SELECT ownerName AS name FROM boards WHERE owner = ? AND ownerName IS NOT NULL ORDER BY updatedAt DESC LIMIT 1', address).toArray()[0]?.name;
    return [...new Set([owner, ...admins].filter(Boolean))].map(name).filter(Boolean).slice(0, 3);
  }

  // What someone without access is told: whom to ask, and whether they already asked.
  accessHelp(person) {
    const address = email(person);
    return { admins: this.adminNames(), requested: !!address && !!this.ctx.storage.sql.exec('SELECT 1 FROM access_requests WHERE email = ?', address).toArray().length };
  }

  // Access stays manual (the owner's choice, Nov 17 2026): asking only puts the person in front of the admins. Asking again
  // keeps the first request; anyone already allowed, by email or domain, has nothing to ask.
  requestAccess(user) {
    const address = email(user?.email);
    if (!address) return { error: 'Sign in to ask for access.', status: 401 };
    if (this.nanoAllowed(address)) return { allowed: true };
    const known = this.ctx.storage.sql.exec('SELECT 1 FROM access_requests WHERE email = ?', address).toArray().length;
    if (!known && this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM access_requests').toArray()[0].count >= maxAccessRequests) return { error: 'Too many open access requests. Ask a site admin directly.', status: 429 };
    const name = typeof user.name === 'string' ? user.name.trim().slice(0, 80) || null : null;
    this.ctx.storage.sql.exec('INSERT INTO access_requests (email, name, requestedAt) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name', address, name, new Date().toISOString());
    return { requested: true };
  }

  // Open requests, oldest first; a request from someone who has since been given access no longer counts.
  accessRequests() {
    const list = this.nanoEntries().map(row => row.entry).join(',');
    return this.ctx.storage.sql.exec('SELECT email, name, requestedAt FROM access_requests ORDER BY requestedAt').toArray().map(row => ({ ...row })).filter(row => !nanoAllowed(row.email, list));
  }
  accessRequestCount(person) { return this.siteRole(person) ? this.accessRequests().length : 0; }

  // What admins see: separate image and 3D access, who the admins are, and each person's shared usage today.
  teamAccess(person, now = Date.now()) {
    const role = this.siteRole(person);
    if (!role) return null;
    const day = new Date(now).toISOString().slice(0, 10), imported = JSON.parse(this.ctx.storage.sql.exec("SELECT value FROM site_settings WHERE key = 'nanoImported'").toArray()[0]?.value || '{}');
    const usage = this.ctx.storage.sql.exec('SELECT email, SUM(images) AS images FROM nano_usage WHERE day = ? AND (open = 0 OR createdAt > ?) GROUP BY email', day, now - nanoReservationTtl).toArray();
    return { role, owner: email(this.env?.SITE_OWNER_EMAIL), admins: this.ctx.storage.sql.exec('SELECT email, addedBy, addedAt FROM site_admins ORDER BY email').toArray().map(row => ({ ...row })),
      nano: this.nanoEntries(), model3d: this.model3dEntries(), video: this.videoEntries(), usedToday: Object.fromEntries(usage.map(row => [row.email, row.images])), imported, requests: this.accessRequests() };
  }

  // Admins grant and revoke image and 3D access; only the owner appoints and removes admins.
  changeTeamAccess(person, { nano, model3d, video, admin, request } = {}) {
    const role = this.siteRole(person), now = new Date().toISOString();
    if (!role) return { error: 'Only site admins can change generation access.', status: 403 };
    if (nano !== undefined) {
      const entry = accessEntry(nano?.entry);
      if (!entry || typeof nano.allowed !== 'boolean') return { error: 'Enter an email address or a domain such as @example.com.', status: 400 };
      if (nano.allowed && this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM nano_access').toArray()[0].count >= maxNanoEntries) return { error: `At most ${maxNanoEntries} people and domains can use Nano Banana.`, status: 400 };
      if (nano.allowed) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO nano_access (entry, addedBy, addedAt) VALUES (?, ?, ?)', entry, email(person), now);
      else this.ctx.storage.sql.exec('DELETE FROM nano_access WHERE entry = ?', entry);
      // Access given answers the requests it covers.
      if (nano.allowed) for (const row of this.ctx.storage.sql.exec('SELECT email FROM access_requests').toArray()) if (nanoAllowed(row.email, entry)) this.ctx.storage.sql.exec('DELETE FROM access_requests WHERE email = ?', row.email);
    }
    if (model3d !== undefined) {
      const address = email(model3d?.email);
      if (!address || typeof model3d.allowed !== 'boolean') return { error: 'Enter a valid email address.', status: 400 };
      if (model3d.allowed && !this.model3dAllowed(address) && this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM model3d_access').toArray()[0].count >= maxModel3dEntries) return { error: `At most ${maxModel3dEntries} people can use 3D generation.`, status: 400 };
      if (model3d.allowed) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO model3d_access (email, addedBy, addedAt) VALUES (?, ?, ?)', address, email(person), now);
      else this.ctx.storage.sql.exec('DELETE FROM model3d_access WHERE email = ?', address);
    }
    if (video !== undefined) {
      const address = email(video?.email);
      if (!address || typeof video.allowed !== 'boolean') return { error: 'Enter a valid email address.', status: 400 };
      if (video.allowed && !this.videoAllowed(address) && this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM video_access').toArray()[0].count >= maxVideoEntries) return { error: `At most ${maxVideoEntries} people can use video generation.`, status: 400 };
      if (video.allowed) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO video_access (email, addedBy, addedAt) VALUES (?, ?, ?)', address, email(person), now);
      else this.ctx.storage.sql.exec('DELETE FROM video_access WHERE email = ?', address);
    }
    if (request !== undefined) {
      const address = email(request?.email);
      if (!address || request.dismiss !== true) return { error: 'Choose a request to dismiss.', status: 400 };
      this.ctx.storage.sql.exec('DELETE FROM access_requests WHERE email = ?', address);
    }
    if (admin !== undefined) {
      const address = email(admin?.email);
      if (role !== 'owner') return { error: 'Only the site owner can choose admins.', status: 403 };
      if (!address || typeof admin.admin !== 'boolean') return { error: 'Enter the admin’s email address.', status: 400 };
      if (address === email(this.env?.SITE_OWNER_EMAIL)) return { error: 'The site owner is always an admin.', status: 400 };
      if (admin.admin) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO site_admins (email, addedBy, addedAt) VALUES (?, ?, ?)', address, email(person), now);
      else this.ctx.storage.sql.exec('DELETE FROM site_admins WHERE email = ?', address);
    }
    return { access: this.teamAccess(person) };
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
  // `images` is 0 for a description: it counts against the team's month, not the person's daily images.
  reserveNano(email, { dailyImages, monthlyUsd, estimateUsd, images = 1, kind = null }, now = Date.now()) {
    const { usedToday, teamSpentUsd } = this.nanoUsage(email, now);
    if (images && usedToday + images > dailyImages) return { error: `Daily limit reached (${Math.min(usedToday, dailyImages)}/${dailyImages}).`, status: 429 };
    if (teamSpentUsd + estimateUsd > monthlyUsd) return { error: 'Team budget for this month is used up.', status: 429 };
    const id = crypto.randomUUID(), day = new Date(now).toISOString().slice(0, 10);
    this.ctx.storage.sql.exec('INSERT INTO nano_usage (id, email, day, month, images, usd, open, createdAt, kind) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)', id, email, day, day.slice(0, 7), images ? 1 : 0, estimateUsd, now, spendKind(kind));
    return { reservation: id };
  }

  // Records what a reserved call produced and cost; a failed call settles to zero, which refunds the reservation.
  settleNano(id, { images, usd }) {
    this.ctx.storage.sql.exec('UPDATE nano_usage SET images = ?, usd = ?, open = 0 WHERE id = ?', Math.max(0, Math.floor(images) || 0), Math.max(0, Number(usd) || 0), id);
  }

  // Every call of a run of variants is reserved in one step, or none is, so a run never starts with only part of what was
  // asked; `fit` says how many would have fitted. The rows arrive as one JSON value because a Durable Object query
  // takes at most 100 bound values, and the room makes one call here instead of one per variant.
  reserveNanoMany(email, { dailyImages, monthlyUsd, estimates, images = 1, kind = null }, now = Date.now()) {
    const { usedToday, teamSpentUsd } = this.nanoUsage(email, now);
    let fit = 0, spent = teamSpentUsd;
    for (const estimateUsd of estimates) {
      // The same words reserveNano would answer with after reserving the calls that fit.
      if (images && usedToday + fit + images > dailyImages) return { error: `Daily limit reached (${Math.min(usedToday + fit, dailyImages)}/${dailyImages}).`, status: 429, fit };
      if (spent + estimateUsd > monthlyUsd) return { error: 'Team budget for this month is used up.', status: 429, fit };
      spent += estimateUsd; fit++;
    }
    const day = new Date(now).toISOString().slice(0, 10), rows = estimates.map(usd => ({ id: crypto.randomUUID(), usd }));
    this.ctx.storage.sql.exec(`INSERT INTO nano_usage (id, email, day, month, images, usd, open, createdAt, kind)
      SELECT json_extract(value, '$.id'), ?, ?, ?, ?, json_extract(value, '$.usd'), 1, ?, ? FROM json_each(?)`, email, day, day.slice(0, 7), images ? 1 : 0, now, spendKind(kind), JSON.stringify(rows));
    return { reservations: rows.map(row => row.id) };
  }

  // Settles a run's reservations, each with what its call produced and cost, in one call from the room.
  settleNanoMany(entries) {
    for (const { id, ...usage } of entries) this.settleNano(id, usage);
  }

  // The owner's Spending window: each person's share of the team's month (UTC), split by what they made. Money counts every
  // call the team's budget counts; a call that failed settled to nothing and is left out. Null for anyone but the owner.
  spending(person, month, now = Date.now()) {
    if (this.siteRole(person) !== 'owner') return null;
    const today = new Date(now).toISOString().slice(0, 10), current = today.slice(0, 7), live = now - nanoReservationTtl;
    const chosen = /^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') && month <= current ? month : current;
    const months = this.ctx.storage.sql.exec('SELECT DISTINCT month FROM nano_usage ORDER BY month DESC').toArray().map(row => row.month);
    const rows = this.ctx.storage.sql.exec(`SELECT email, kind, SUM(CASE WHEN images > 0 OR usd > 0 THEN 1 ELSE 0 END) AS made, COALESCE(SUM(usd), 0) AS usd,
      SUM(CASE WHEN day = ? AND (open = 0 OR createdAt > ?) THEN images ELSE 0 END) AS todayImages, SUM(CASE WHEN day = ? THEN usd ELSE 0 END) AS todayUsd
      FROM nano_usage WHERE month = ? GROUP BY email, kind`, today, live, today, chosen).toArray();
    const people = new Map();
    for (const row of rows) {
      const entry = people.get(row.email) || { email: row.email, made: 0, usd: 0, todayImages: 0, todayUsd: 0, kinds: [] };
      entry.made += row.made; entry.usd += row.usd; entry.todayImages += row.todayImages; entry.todayUsd += row.todayUsd;
      if (row.made || row.usd) entry.kinds.push({ kind: row.kind || 'earlier', made: row.made, usd: row.usd });
      people.set(row.email, entry);
    }
    const list = [...people.values()].filter(entry => entry.made || entry.usd).map(entry => ({ ...entry, kinds: entry.kinds.sort((a, b) => b.usd - a.usd) })).sort((a, b) => b.usd - a.usd || b.made - a.made);
    return { month: chosen, months: [...new Set([current, ...months])].sort().reverse(), today, people: list,
      team: { usd: list.reduce((sum, entry) => sum + entry.usd, 0), todayUsd: list.reduce((sum, entry) => sum + entry.todayUsd, 0), made: list.reduce((sum, entry) => sum + entry.made, 0) } };
  }

  listBoards() {
    return this.ctx.storage.sql.exec('SELECT id, name, createdAt, COALESCE(updatedAt, createdAt) AS updatedAt, imageCount, covers FROM boards WHERE deletedAt IS NULL ORDER BY COALESCE(updatedAt, createdAt) DESC, rowid DESC').toArray().map(board => ({ ...board, covers: JSON.parse(board.covers) }));
  }

  getBoard(id) {
    const board = this.ctx.storage.sql.exec('SELECT id, name, createdAt, COALESCE(updatedAt, createdAt) AS updatedAt, imageCount, covers FROM boards WHERE id = ? AND deletedAt IS NULL', id).toArray()[0];
    return board ? { ...board, covers: JSON.parse(board.covers) } : null;
  }

  // The boards a person can open, newest first: their own, those they were invited to, those open to everyone, and link boards they opened.
  boardsFor(person) {
    return this.ctx.storage.sql.exec(`SELECT ${boardFields}, p.role AS invited, (SELECT COUNT(*) FROM board_requests r WHERE r.board = b.id) AS requestCount
      FROM boards b LEFT JOIN board_people p ON p.board = b.id AND p.email = ?
      WHERE b.deletedAt IS NULL AND (b.owner = ? OR p.role IS NOT NULL OR b.access = 'everyone' OR (b.access = 'link' AND p.openedAt IS NOT NULL))
      ORDER BY COALESCE(b.updatedAt, b.createdAt) DESC, b.rowid DESC`, person, person).toArray().map(row => shown(row, boardRole(row, person, row.invited))).filter(board => board.role);
  }

  // One board with this person's role (null when they may not open it); null when there is no such board.
  boardFor(id, person) {
    const row = this.ctx.storage.sql.exec(`SELECT ${boardFields}, p.role AS invited FROM boards b LEFT JOIN board_people p ON p.board = b.id AND p.email = ? WHERE b.id = ? AND b.deletedAt IS NULL`, person ?? null, id).toArray()[0];
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
    if (!board.role) return { error: 'You don’t have access to this board.', status: 403, owner: { name: board.ownerName }, requested: this.requested(id, user.email) };
    if (board.role === 'owner') this.ctx.storage.sql.exec('UPDATE boards SET ownerName = ? WHERE id = ? AND ownerName IS NOT ?', user.name, id, user.name);
    else this.ctx.storage.sql.exec('INSERT INTO board_people (board, email, name, openedAt) VALUES (?, ?, ?, ?) ON CONFLICT (board, email) DO UPDATE SET name = excluded.name, openedAt = excluded.openedAt', id, user.email, user.name, new Date().toISOString());
    return { board: { ...board, ownerName: board.role === 'owner' ? user.name : board.ownerName }, sharing: this.sharing(id, user.email) };
  }

  // Someone the board is closed to asks its owner to let them in, and a viewer asks to edit. The request waits in the owner's
  // Share dialog until they choose the person's role, dismiss it or open the link that far; asking again keeps the first request.
  requestBoardAccess(id, user) {
    const address = email(user?.email);
    if (!address) return { error: 'Sign in to ask for access.', status: 401 };
    const board = this.boardFor(id, address);
    if (!board) return { error: 'Board not found.', status: 404 };
    if (canEdit(board.role)) return { allowed: true };
    const role = board.role === 'view' ? 'edit' : null, known = this.request(id, address);
    if (!known && this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM board_requests WHERE board = ?', id).toArray()[0].count >= maxBoardRequests) return { error: 'This board has too many open access requests. Ask its owner directly.', status: 429 };
    const name = typeof user.name === 'string' ? user.name.trim().slice(0, 80) || null : null;
    this.ctx.storage.sql.exec('INSERT INTO board_requests (board, email, name, requestedAt, role) VALUES (?, ?, ?, ?, ?) ON CONFLICT (board, email) DO UPDATE SET name = excluded.name, role = excluded.role, requestedAt = CASE WHEN role IS excluded.role THEN requestedAt ELSE excluded.requestedAt END',
      id, address, name, new Date().toISOString(), role);
    return { requested: true, created: !known || known.role !== role, name, email: address, ...(role ? { role } : {}) };
  }
  request(id, person) { return person ? this.ctx.storage.sql.exec('SELECT role FROM board_requests WHERE board = ? AND email = ?', id, person).toArray()[0] : undefined; }
  requested(id, person) { return !!this.request(id, person); }
  // Requests the board now grants by itself, once the owner opened its link or everyone setting far enough, are answered.
  answerRequests(id) {
    const board = this.ctx.storage.sql.exec('SELECT owner, access, linkRole FROM boards WHERE id = ?', id).toArray()[0];
    const open = this.ctx.storage.sql.exec('SELECT r.email, r.role AS wanted, p.role AS invited FROM board_requests r LEFT JOIN board_people p ON p.board = r.board AND p.email = r.email WHERE r.board = ?', id).toArray();
    for (const item of open) {
      const role = boardRole(board, item.email, item.invited);
      if (item.wanted === 'edit' ? canEdit(role) : role) this.ctx.storage.sql.exec('DELETE FROM board_requests WHERE board = ? AND email = ?', id, item.email);
    }
  }

  // Who has access, as this person may see it: the owner sees invited people's emails; others see the names of those who opened the board.
  sharing(id, person) {
    const board = this.ctx.storage.sql.exec('SELECT owner, ownerName, access, linkRole FROM boards WHERE id = ? AND deletedAt IS NULL', id).toArray()[0];
    if (!board) return null;
    const people = this.ctx.storage.sql.exec('SELECT email, role, name FROM board_people WHERE board = ? AND role IS NOT NULL ORDER BY rowid', id).toArray();
    const role = boardRole(board, person, people.find(item => item.email === person)?.role), owner = role === 'owner';
    return { role, canManage: owner, owner: board.owner ? { name: board.ownerName, ...(owner ? { email: board.owner } : {}) } : null, access: board.access, linkRole: board.linkRole,
      members: owner ? people.map(item => ({ email: item.email, role: item.role, name: item.name })) : people.filter(item => item.name).map(item => ({ name: item.name, role: item.role })),
      pending: owner ? 0 : people.filter(item => !item.name).length,
      ...(owner ? { requests: this.ctx.storage.sql.exec('SELECT email, name, requestedAt, role FROM board_requests WHERE board = ? ORDER BY requestedAt', id).toArray().map(item => ({ email: item.email, name: item.name, requestedAt: item.requestedAt, ...(item.role ? { role: item.role } : {}) })) }
        : role === 'view' && this.request(id, person)?.role === 'edit' ? { editRequested: true } : {}) };
  }

  // Owner only. `member` invites someone or changes their role; a null role removes the invitation (a visit from the link stays).
  // Choosing someone's role answers their request, `dismiss` declines one, and opening the link answers those it now grants.
  changeSharing(id, person, { access, linkRole, member, dismiss } = {}) {
    const board = this.ctx.storage.sql.exec('SELECT owner FROM boards WHERE id = ? AND deletedAt IS NULL', id).toArray()[0];
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
    if (dismiss !== undefined && !email(dismiss)) return { error: 'Enter a valid email address.', status: 400 };
    if (access !== undefined || linkRole !== undefined) this.ctx.storage.sql.exec('UPDATE boards SET access = COALESCE(?, access), linkRole = COALESCE(?, linkRole) WHERE id = ?', access ?? null, linkRole ?? null, id);
    if (invite?.role || dismiss !== undefined) this.ctx.storage.sql.exec('DELETE FROM board_requests WHERE board = ? AND email = ?', id, invite?.role ? invite.email : email(dismiss));
    if (invite?.role) this.ctx.storage.sql.exec('INSERT INTO board_people (board, email, role) VALUES (?, ?, ?) ON CONFLICT (board, email) DO UPDATE SET role = excluded.role', id, invite.email, invite.role);
    else if (invite) this.ctx.storage.sql.exec('UPDATE board_people SET role = NULL WHERE board = ? AND email = ?', id, invite.email);
    if (access !== undefined || linkRole !== undefined) this.answerRequests(id);
    return { sharing: this.sharing(id, person) };
  }

  // For the board's room, which re-checks everyone connected after a sharing change.
  roomAccess(id) {
    const board = this.ctx.storage.sql.exec('SELECT owner, access, linkRole FROM boards WHERE id = ? AND deletedAt IS NULL', id).toArray()[0];
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
  // Deleting moves a board to the trash: it leaves every list and admits nobody, and for 30 days its owner or a site
  // admin can bring it back as it was, sharing included.
  trashBoard(id, person) {
    this.ctx.storage.sql.exec('UPDATE boards SET deletedAt = ?, deletedBy = ? WHERE id = ? AND deletedAt IS NULL', new Date().toISOString(), email(person), id);
  }

  // The trash as this person may restore it: their own boards, or every board for a site admin.
  trashFor(person, now = Date.now()) {
    const admin = this.siteRole(person) ? 1 : 0, cutoff = new Date(now - trashDays * dayMs).toISOString();
    return this.ctx.storage.sql.exec('SELECT id, name, deletedAt, imageCount, covers, owner, ownerName FROM boards WHERE deletedAt IS NOT NULL AND deletedAt > ? AND (owner = ? OR ?) ORDER BY deletedAt DESC', cutoff, person, admin)
      .toArray().map(({ owner, covers, ...board }) => ({ ...board, covers: JSON.parse(covers), own: owner === person, erasesAt: new Date(Date.parse(board.deletedAt) + trashDays * dayMs).toISOString() }));
  }

  restoreBoard(id, person, now = Date.now()) {
    const row = this.ctx.storage.sql.exec('SELECT owner, deletedAt FROM boards WHERE id = ?', id).toArray()[0];
    if (!row?.deletedAt || Date.parse(row.deletedAt) <= now - trashDays * dayMs) return { error: 'This board is no longer in Recently deleted.', status: 404 };
    if (row.owner !== person && !this.siteRole(person)) return { error: 'Only the board’s owner or a site admin can restore it.', status: 403 };
    this.ctx.storage.sql.exec('UPDATE boards SET deletedAt = NULL, deletedBy = NULL WHERE id = ?', id);
    return { board: this.boardFor(id, person) };
  }

  // Boards whose 30 days in the trash are over. The Worker erases each room, then the board is forgotten here.
  expiredBoards(now = Date.now()) {
    return this.ctx.storage.sql.exec('SELECT id FROM boards WHERE deletedAt IS NOT NULL AND deletedAt <= ?', new Date(now - trashDays * dayMs).toISOString()).toArray().map(row => row.id);
  }

  // Images stay, as other boards may use them.
  forgetBoard(id) {
    this.ctx.storage.sql.exec('DELETE FROM boards WHERE id = ?', id);
    this.ctx.storage.sql.exec('DELETE FROM board_people WHERE board = ?', id);
    this.ctx.storage.sql.exec('DELETE FROM board_requests WHERE board = ?', id);
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
