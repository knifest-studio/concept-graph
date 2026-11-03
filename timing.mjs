export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${seconds}s`;
}

export function runElapsed(run, now = Date.now()) {
  const start = Date.parse(run?.startedAt || run?.createdAt);
  const end = ['running', 'queued'].includes(run?.status) ? now : Date.parse(run?.finishedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

export function runTiming(run, runs, now = Date.now()) {
  if (!run) return { label: '0s', comparison: '' };
  const label = formatDuration(runElapsed(run, now));
  // Compare whole requests, including queue time; image count and complexity can vary.
  const durations = runs.filter(previous => previous.id !== run.id && previous.status === 'completed')
    .map(previous => Date.parse(previous.finishedAt) - Date.parse(previous.createdAt))
    .filter(duration => Number.isFinite(duration) && duration > 0).slice(-5);
  const low = durations.length ? formatDuration(Math.min(...durations)) : null;
  const high = durations.length ? formatDuration(Math.max(...durations)) : null;
  return { label, comparison: low ? `Recent requests: ${low === high ? low : `${low}–${high}`} total` : '' };
}
