import { modelNames } from '../graph.mjs';
import { runElapsed } from '../timing.mjs';
import { plural, t } from './i18n.mjs';

const active = run => ['running', 'queued'].includes(run.status);
const failed = run => ['error', 'failed'].includes(run.status);
const created = run => Date.parse(run.createdAt || run.startedAt);

// How long each kind of finished row stays once the person has been at the screen after it settled. A result clears soon
// after it is seen, a partial one gives time to read why some images failed, and History keeps every run for later.
export const trayTimings = Object.freeze({ done: 6000, partial: 15000, teammateFailed: 8000, cancelled: 2000, viewed: 2000, grace: 2000, fade: 500, firstSeen: 4000 });

export function formatElapsed(milliseconds) {
  const seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// The cloud marks a run that placed some of its images as completed and says what the others ran into, e.g.
// "4 of 16 variants failed: A reference image is too large".
export function partialFailure(error) {
  const match = /^(\d+) of (\d+) (?:variants|images) failed: ([\s\S]*)$/.exec(String(error || '').trim());
  return match ? { failed: Number(match[1]), total: Number(match[2]), reason: match[3].trim() } : null;
}

function rowKind(run) {
  if (active(run)) return 'active';
  if (failed(run)) return 'failed';
  if (run.status === 'cancelled') return 'cancelled';
  if (run.status === 'completed') return run.error ? 'partial' : 'done';
  return null;
}

function rowStatus(run, kind, count) {
  const describe = run.task === 'describe';
  if (kind === 'active') return { status: run.status === 'queued' ? t('Queued') : describe ? t('Describing') : run.task === 'model3d' ? t('Generating 3D') : run.task === 'upscale' ? t('Upscaling') : t('Generating') };
  if (kind === 'failed') return { status: t('Failed · {error}', { error: t(run.error || 'Generation failed').split(/\r?\n/)[0] }) };
  if (kind === 'cancelled') return { status: t('Cancelled') };
  const done = describe ? t('Done · description') : run.task === 'model3d' ? plural(count, 'Done · {count} model', 'Done · {count} models') : plural(count, 'Done · {count} image', 'Done · {count} images');
  if (kind === 'done') return { status: done };
  const partial = partialFailure(run.error);
  if (!partial) return { status: done, reason: t(run.error).split(/\r?\n/)[0] };
  return { status: plural(partial.total, 'Done · {done} of {count} image · {failed} failed', 'Done · {done} of {count} images · {failed} failed', { done: Math.max(0, partial.total - partial.failed), failed: partial.failed }), reason: t(partial.reason).split(/\r?\n/)[0] };
}

// Rows for the generations tray, one per run. `previous` is the last result (so a row remembers when it settled and when
// it was seen); `dismissed` holds runs the person closed or the tray already cleared. `ctx` describes this viewer only,
// and nothing here is written to the board:
// - me: the person's name; runs by someone else are teammates' (no name in local mode, where everything is mine)
// - visible / lastInputAt: a finished row counts as seen once the tab is visible and the person touched the page after it
//   settled, so a result that lands while they are away or in another tab waits for them
// - hovered: the pointer or keyboard focus is in the tray, which holds every row; releasedAt starts a short grace after it
//   leaves (or after the tab is shown again)
// - viewed: run id -> when the person clicked the row to go to its result
export function generationRows(runs, previous = [], now = Date.now(), dismissed = new Set(), ctx = {}) {
  const { me, visible = true, lastInputAt = -Infinity, hovered = false, releasedAt = -Infinity, viewed = new Map() } = ctx;
  const before = new Map(previous.map(row => [row.run.id, row]));
  const latest = new Map();
  for (const run of runs) if (run.nodeId) latest.set(run.nodeId, Math.max(latest.get(run.nodeId) ?? -Infinity, created(run) || 0));
  const held = hovered || !visible;
  return runs.flatMap(run => {
    if (dismissed.has(run.id)) return [];
    const kind = rowKind(run);
    if (!kind) return [];
    const old = before.get(run.id), running = kind === 'active', mine = !me || run.by?.name === me;
    // A run first seen already finished (a reload, another board) belongs to History. One that settled moments ago still
    // shows; the server's finish time is clamped to this clock so a clock running behind cannot keep it alive.
    const settledAt = running ? null : old?.settledAt ?? (old ? now : Math.min(Date.parse(run.finishedAt), now));
    if (!running && (!Number.isFinite(settledAt) || (!old && now - settledAt >= trayTimings.firstSeen))) return [];
    // A newer run of the same prompt answers an older failure.
    if (kind === 'failed' && (created(run) || 0) < (latest.get(run.nodeId) ?? -Infinity)) return [];
    const clicked = viewed.get(run.id), viewedAt = Number.isFinite(clicked) && clicked >= settledAt ? clicked : null;
    const seenAt = running ? null : old?.seenAt ?? viewedAt ?? (visible && lastInputAt >= settledAt ? now : null);
    const persistent = running || (kind === 'failed' && mine);
    const hold = kind === 'partial' ? trayTimings.partial : kind === 'failed' ? trayTimings.teammateFailed : trayTimings.done;
    const deadline = persistent ? Infinity : kind === 'cancelled' ? settledAt + trayTimings.cancelled
      : Math.min(seenAt == null ? Infinity : seenAt + hold, viewedAt == null ? Infinity : viewedAt + trayTimings.viewed);
    const expiresAt = persistent || held || !Number.isFinite(deadline) ? Infinity : Math.max(deadline, releasedAt + trayTimings.grace);
    if (now >= expiresAt) return [];
    const count = run.count ?? run.outputIds?.length ?? 0;
    return [{ run, kind, mine, active: running, error: kind === 'failed', settledAt, seenAt, expiresAt, awaiting: !running && !persistent && kind !== 'cancelled' && seenAt == null,
      fading: now >= expiresAt - trayTimings.fade,
      label: (run.task === 'model3d' && modelNames[run.model] ? `${modelNames[run.model]} · ` : '') + (run.label || run.target?.data.text || run.target?.data.template?.name || t('Generation')).trim().split(/\r?\n/)[0],
      ...rowStatus(run, kind, count), elapsed: formatElapsed(runElapsed(run, now)) }];
  }).sort((a, b) => Number(b.active) - Number(a.active) || (created(a.run) || 0) - (created(b.run) || 0) || a.run.id.localeCompare(b.run.id));
}

// One step of the tray: the new rows, plus the runs it has let go of, so a cleared row is not shown again as "first seen".
export function advanceTray(runs, state = { rows: [], retired: new Set() }, now = Date.now(), ctx = {}) {
  const rows = generationRows(runs, state.rows, now, state.retired, ctx), shown = new Set(rows.map(row => row.run.id)), byId = new Map(runs.map(run => [run.id, run]));
  const gone = state.rows.filter(row => !shown.has(row.run.id) && byId.has(row.run.id) && !active(byId.get(row.run.id))).map(row => row.run.id);
  return { rows, retired: gone.length ? new Set([...state.retired, ...gone]) : state.retired };
}

export function retireRows(state, ids) {
  const list = [...ids];
  return { rows: state.rows.filter(row => !list.includes(row.run.id)), retired: new Set([...state.retired, ...list]) };
}

// Nothing a person can see changed: keeps the previous state so a tick does not redraw the tray.
export function sameRows(a, b) {
  return a.length === b.length && a.every((row, index) => { const other = b[index]; return row.run === other.run && row.status === other.status && row.reason === other.reason && row.elapsed === other.elapsed && row.fading === other.fading && row.mine === other.mine && row.expiresAt === other.expiresAt && row.seenAt === other.seenAt; });
}

export function traySummary(rows) {
  const summary = { active: 0, done: 0, partial: 0, failed: 0, cancelled: 0 };
  for (const row of rows) summary[row.kind]++;
  return summary;
}

// The worst state decides the collapsed chip's colour: a failure, then a partial result, then running work.
export const trayTone = summary => summary.failed ? 'failed' : summary.partial ? 'partial' : summary.active ? 'active' : summary.done ? 'done' : 'idle';

export function traySummaryText(summary) {
  const finished = summary.done + summary.partial;
  return [summary.active && t('{count} generating', { count: summary.active }), finished && t('{count} done', { count: finished }), summary.failed && t('{count} failed', { count: summary.failed })].filter(Boolean).join(' · ');
}

// Whether the tray is collapsed is this person's choice on this device, like the sound and page preferences.
export const trayPreferenceKey = viewer => `concept-graph-generation-tray:${viewer}`;
export function readTrayPreference(storage, key, fallback = false) {
  try {
    const value = storage?.getItem(key);
    return value === '1' ? true : value === '0' ? false : fallback;
  } catch { return fallback; }
}
export function writeTrayPreference(storage, key, collapsed) {
  try { storage.setItem(key, collapsed ? '1' : '0'); return true; } catch { return false; }
}

export function generationFocusNodes(run, nodes, groups) {
  const ids = new Set([run.nodeId, ...(run.outputIds || [])]);
  for (const group of groups) if (group.collapsed && group.nodeIds.some(id => ids.has(id))) ids.add(group.id);
  return nodes.filter(node => !node.hidden && (ids.has(node.id) || (node.type === 'pending' && node.data.runId === run.id))).map(node => ({ id: node.id }));
}
