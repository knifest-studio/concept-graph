import { stripUserContent, privateControlLabel, errorMessage, referrerOrigin, ownScript, validErrorType } from './analytics-privacy.mjs';
import { isTextEntry, matchShortcut } from './shortcuts.mjs';

// Shared rules for the browser and Worker, with no package dependencies. No client identity is accepted.
export const eventBytes = 64 * 1024, replayBytes = 2 * 1024 * 1024, sessionReplayBytes = 50 * 1024 * 1024;
export const sessionPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
export const kinds = new Set(['session', 'view', 'click', 'change', 'shortcut', 'context', 'rage', 'app', 'error']);
const text = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
export const clamp = (value, min, max, fallback = min) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export const byteLength = value => new TextEncoder().encode(value).length;
const strings = { route: 160, page: 120, platform: 120, userAgent: 500, language: 40, uiLanguage: 40, theme: 20, pointer: 20, referrer: 500, version: 80, nodeType: 30, via: 40, generator: 80, model: 128, errorKind: 80, message: 1000, target: 60, combo: 80, status: 40, task: 30, run: 120, context: 60 };
const numbers = { x: [0, 1], y: [0, 1], zoom: [.001, 100], width: [0, 16384], height: [0, 16384], screenWidth: [0, 32768], screenHeight: [0, 32768], dpr: [.1, 16], duration: [0, 604800000], active: [0, 604800000], variants: [0, 100], references: [0, 1000], count: [0, 10000], navigation: [0, 3600000], domReady: [0, 3600000], load: [0, 3600000] };
const booleans = ['masked', 'reducedMotion', 'touch', 'meta', 'ctrl', 'alt', 'shift', 'visible', 'checked'];
const uiValues = {
  to: ['light', 'dark', 'system'],
  source: ['settings', 'system', 'sidebar', 'node_toolbar', 'context_menu', 'tip', 'invite', 'copy', 'sidebar_click', 'sidebar_drag', 'node_type'],
  item: ['menu', 'getting_started', 'shortcuts', 'whats_new'],
  tip: ['duplicate_to_custom_node', 'custom_nodes_invite', 'first_prompt'],
  action: ['shown', 'accepted', 'dismissed'],
  noise: ['resize_observer', 'cross_origin', 'extension']
};
export function details(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, max] of Object.entries(strings)) if (typeof value[key] === 'string') result[key] = text(key === 'message' ? errorMessage(value[key]) : key === 'referrer' ? referrerOrigin(value[key]) : stripUserContent(value[key]), max);
  for (const [key, [min, max]] of Object.entries(numbers)) if (typeof value[key] === 'number' && Number.isFinite(value[key])) result[key] = clamp(value[key], min, max);
  for (const key of booleans) if (typeof value[key] === 'boolean') result[key] = value[key];
  for (const [key, allowed] of Object.entries(uiValues)) if (allowed.includes(value[key])) result[key] = value[key];
  // Error facts are checked by shape here too, so no client can put text in them.
  if (validErrorType(value.errorType)) result.errorType = value.errorType;
  if (typeof value.location === 'string' && (ownScript.test(value.location) || ['external', 'extension', 'inline'].includes(value.location))) result.location = value.location;
  if (result.page && !sessionPattern.test(result.page) && result.page !== 'page-1') delete result.page;
  if (result.run && !sessionPattern.test(result.run)) delete result.run;
  if (result.route && !['board', 'boards', 'admin'].includes(result.route)) delete result.route;
  return result;
}
export function sanitizeEvent(value, now = Date.now()) {
  if (!value || !kinds.has(value.kind) || !Number.isSafeInteger(value.seq) || value.seq < 0 || value.seq > 1e9) return null;
  const name = text(stripUserContent(value.name), value.kind === 'error' ? 1000 : 80);
  if (!name) return null;
  return { seq: value.seq, time: Math.round(clamp(value.time, now - 86400000, now + 300000, now)), kind: value.kind, name,
    area: text(stripUserContent(value.area), 120), board: sessionPattern.test(value.board) ? value.board : '', details: details(value.details) };
}
export function validateBatch(value, now = Date.now()) {
  if (!value || !sessionPattern.test(value.session) || !Array.isArray(value.events) || !value.events.length || value.events.length > 200) throw Object.assign(new Error('Invalid analytics batch.'), { status: 400 });
  const events = value.events.map(event => sanitizeEvent(event, now));
  if (events.some(event => !event)) throw Object.assign(new Error('Invalid analytics event.'), { status: 400 });
  return { session: value.session, events };
}
export function replaySequence(value) { return /^(0|[1-9]\d{0,5})$/.test(String(value)) ? Number(value) : null; }
export function replayKey(day, session, seq) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !sessionPattern.test(session) || replaySequence(seq) === null) throw new Error('Invalid replay key.');
  return `analytics/replays/${day}/${session}/${String(seq).padStart(6, '0')}`;
}
export function retentionCutoffs(now = Date.now()) { return { replays: now - 30 * 86400000, events: now - 180 * 86400000 }; }
export function controlName({ ariaLabel, tooltip, text: label, tag = 'control', role, type, id, private: hidden = false } = {}) {
  const labelName = hidden ? privateControlLabel : stripUserContent;
  return text(labelName(ariaLabel), 60) || text(labelName(tooltip), 60) || (!hidden && text(stripUserContent(label), 60)) || text(`${tag}${role ? `[role=${role}]` : type ? `[type=${type}]` : !hidden && id ? `#${id}` : ''}`, 60);
}
// Only presses that trigger one of the app's actions are logged, by the action's ID: never the typed characters, so text
// typed with AltGr or macOS Option is not collected either. In a text field only the actions that work there count.
export function shortcut(event, { editing = isTextEntry(event.target), ...ctx } = {}) {
  if (event.repeat) return '';
  return matchShortcut(event, { scopes: editing ? ['canvas', 'prompt', 'global'] : ['canvas', 'global'], editing, ...ctx }) || '';
}
// Undo, Redo and Generate are counted with their buttons of the same name.
export const shortcutControl = action => ({ 'edit.undo': 'Undo', 'edit.redo': 'Redo', 'prompt.generate': 'Generate' })[action] || action;
export function rageDetector() {
  let recent = [], last = -Infinity;
  return ({ x, y, time, repeat = false }) => {
    // Step controls invite repeated presses; they also break a burst on a nearby control.
    if (repeat) { recent = []; return false; }
    recent = recent.filter(point => time - point.time <= 1000 && Math.hypot(x - point.x, y - point.y) <= 30);
    recent.push({ x, y, time });
    if (recent.length < 3 || time - last < 1000) return false;
    last = time; recent = []; return true;
  };
}
export function splitEvents(session, events, limit = eventBytes) {
  const batches = []; let batch = [], size = byteLength(JSON.stringify({ session, events: [] }));
  for (const event of events) {
    const bytes = byteLength(JSON.stringify(event)) + 1;
    if (batch.length && (batch.length === 200 || size + bytes > limit)) { batches.push(batch); batch = []; size = byteLength(JSON.stringify({ session, events: [] })); }
    if (size + bytes <= limit) { batch.push(event); size += bytes; }
  }
  if (batch.length) batches.push(batch);
  return batches;
}
