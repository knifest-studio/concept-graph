import { imageAuthor } from './annotations.mjs';
import { modelNames } from '../graph.mjs';

const settingId = value => typeof value === 'string' && /^[\w.\/:+-]{1,128}$/.test(value) ? value : undefined;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const pixels = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const total = Math.round(ms / 1000), hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  if (!total) return 'under 1 s';
  if (hours) return `${hours} h${minutes ? ` ${minutes} min` : ''}`;
  return minutes ? `${minutes} min${seconds ? ` ${seconds} s` : ''}` : `${seconds} s`;
}

// Facts for the full-screen view. Unknown values are left out instead of guessed.
export function imageInfo(node, runs = [], { width, height, formatDate = value => new Date(value).toLocaleString() } = {}) {
  const data = node?.data || {}, run = data.runId ? runs.find(item => item.id === data.runId) : undefined;
  const generated = !!(run || data.runId), diagnostics = run?.diagnostics, author = imageAuthor(data, runs), caption = text(data.caption);
  // Codex's reported thread values win over the recorded request; older local runs only have diagnostics.
  const model = settingId(diagnostics?.model) || settingId(run?.model) || settingId(diagnostics?.requestedModel);
  const effort = settingId(diagnostics?.effort) || settingId(run?.effort) || settingId(diagnostics?.requestedEffort);
  const started = time(run?.startedAt), finished = time(run?.finishedAt);
  const duration = started && finished ? formatDuration(Date.parse(finished) - Date.parse(started)) : undefined;
  const outputs = Math.max(run?.outputIds?.length || 0, Number.isSafeInteger(run?.count) ? run.count : 0);
  // Local runs keep a snapshot that lists every custom node with its instructions separately.
  const template = run && !run.snapshot ? text(run.target?.data?.template?.name) || text(run.template) : undefined;
  let prompt = run ? text(run.target?.data?.text) || text(run.label) : undefined;
  if (prompt === template) prompt = undefined;
  const createdAt = time(data.createdAt) || time(run?.finishedAt) || time(run?.createdAt);
  const size = pixels(width) && pixels(height) ? `${width} × ${height} px` : undefined;
  const rows = [
    !generated && !caption && text(data.label) && { key: 'name', label: 'File', value: text(data.label) },
    template && { key: 'template', label: 'Custom node', value: template },
    model && { key: 'model', label: 'Model', value: Object.hasOwn(modelNames, model) ? modelNames[model] : model },
    effort && { key: 'effort', label: 'Reasoning effort', value: effort[0].toUpperCase() + effort.slice(1) },
    duration && { key: 'duration', label: 'Generation time', value: duration, ...(outputs > 1 ? { note: `Whole run, ${outputs} images` } : {}) },
    createdAt && { key: 'created', label: generated ? 'Created' : 'Added', value: formatDate(createdAt) },
    size && { key: 'size', label: 'Size', value: size },
  ].filter(Boolean);
  return { kind: generated ? 'generated' : 'reference', ...(author ? { author } : {}), ...(caption ? { caption } : {}), ...(prompt ? { prompt } : {}), rows };
}
