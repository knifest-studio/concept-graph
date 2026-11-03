import { runElapsed } from '../timing.mjs';

const active = run => ['running', 'queued'].includes(run.status);
const failed = run => ['error', 'failed'].includes(run.status);

export function formatElapsed(milliseconds) {
  const seconds = Number.isFinite(milliseconds) ? Math.max(0, Math.floor(milliseconds / 1000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function generationRows(runs, previous = [], now = Date.now(), dismissed = new Set()) {
  const before = new Map(previous.map(row => [row.run.id, row]));
  return runs.flatMap(run => {
    if (dismissed.has(run.id)) return [];
    const old = before.get(run.id), running = active(run), error = failed(run);
    if (!running && !error && !['completed', 'cancelled'].includes(run.status)) return [];
    const settledAt = running ? null : old?.settledAt ?? (old ? now : Date.parse(run.finishedAt));
    if (!running && (!Number.isFinite(settledAt) || (!old && now - settledAt >= 4000) || (!error && now - settledAt >= 4000))) return [];
    const count = run.count ?? run.outputIds?.length ?? 0;
    const status = running ? run.status === 'queued' ? 'Queued' : 'Generating' : error ? `Failed · ${(run.error || 'Generation failed').split(/\r?\n/)[0]}` : run.status === 'cancelled' ? 'Cancelled' : `Done · ${count} image${count === 1 ? '' : 's'}`;
    return [{ run, active: running, error, settledAt, fading: !running && !error && now - settledAt >= 3500,
      label: (run.label || run.target?.data.text || run.target?.data.template?.name || 'Generation').trim().split(/\r?\n/)[0],
      status, elapsed: formatElapsed(runElapsed(run, now)) }];
  }).sort((a, b) => Number(b.active) - Number(a.active) || (Date.parse(a.run.createdAt || a.run.startedAt) || 0) - (Date.parse(b.run.createdAt || b.run.startedAt) || 0) || a.run.id.localeCompare(b.run.id));
}

export function generationFocusNodes(run, nodes, groups) {
  const ids = new Set([run.nodeId, ...(run.outputIds || [])]);
  for (const group of groups) if (group.collapsed && group.nodeIds.some(id => ids.has(id))) ids.add(group.id);
  return nodes.filter(node => !node.hidden && ids.has(node.id)).map(node => ({ id: node.id }));
}
