import { collectInputs, isDescribe } from '../graph.mjs';
import { groupBounds } from './canvas.mjs';
import { plural, t } from './i18n.mjs';

export const gettingStartedKey = viewer => `concept-graph-getting-started:${viewer}`;
export const emptyChecklist = () => ({ done: { helper: false, prompt: false, generate: false, variation: false }, ownRuns: [], dismissed: false });

export function readChecklist(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key)), state = emptyChecklist();
    for (const step of Object.keys(state.done)) state.done[step] = value?.done?.[step] === true;
    state.ownRuns = Array.isArray(value?.ownRuns) ? value.ownRuns.filter(id => typeof id === 'string' && id.length <= 120).slice(-100) : [];
    state.dismissed = value?.dismissed === true;
    return state;
  } catch { return emptyChecklist(); }
}

export function writeChecklist(storage, key, state) {
  try { storage.setItem(key, JSON.stringify(state)); } catch {}
}

export function checklistEvent(state, event) {
  if (event.own === false) return state;
  if (event.type === 'dismiss' || event.type === 'reopen') return { ...state, dismissed: event.type === 'dismiss' };
  if (event.type === 'run-started') return state.ownRuns.includes(event.id) ? state : { ...state, ownRuns: [...state.ownRuns, event.id].slice(-100) };
  const step = event.type === 'run-finished' ? event.run.status === 'completed' && (event.run.outputIds?.length || event.run.count) > 0 && state.ownRuns.includes(event.run.id) ? 'generate' : null : event.type;
  if (!Object.hasOwn(state.done, step) || state.done[step]) return state;
  return { ...state, done: { ...state.done, [step]: true } };
}

export function checklistSteps(state, helperNeeded, ready) {
  return ['helper', 'prompt', 'generate', 'variation'].filter(step => step !== 'helper' || (helperNeeded && !ready)).map(id => ({ id, done: state.done[id] }));
}

// A granted teammate's Codex stands in only while this person's own Codex is not ready; `own` keeps what to fix.
export function generationReadiness({ teammate, ...options }) {
  const own = ownReadiness(options);
  if (own.key === 'ready' || !teammate) return own;
  return { key: 'ready', label: t('Using {name}’s Codex', { name: teammate.user.name }), delegate: teammate.to, own };
}

function ownReadiness({ required, paired, online = true, status }) {
  if (!required) return { key: 'ready', label: t('Ready to generate') };
  if (!paired || !online) return { key: 'helper', label: t('Helper not connected · Connect'), action: t('Connect helper to generate') };
  if (status.codexMissing && status.codexInstall?.supported) return { key: 'install', label: t('Codex not installed · Install'), action: t('Install Codex') };
  if (!status.connected) return { key: 'codex', label: t('Codex not ready · Check connection'), action: t('Check Codex connection') };
  if (!status.signedIn) return { key: 'signin', label: t('Codex sign-in needed'), action: t('Sign in to generate') };
  if (!status.imageGeneration) return { key: 'codex', label: t('Image generation unavailable'), action: t('Check Codex connection') };
  return { key: 'ready', label: t('Ready to generate') };
}

export function directInputCounts(graph) {
  // A describe node feeds nothing into the prompts it connects to, so it is not counted.
  const types = new Map(graph.nodes.filter(node => !isDescribe(node)).map(node => [node.id, node.type])), counts = new Map(graph.nodes.map(node => [node.id, { images: 0, text: 0 }])), seen = new Map();
  for (const edge of graph.edges) {
    if (!types.has(edge.source) || !counts.has(edge.target)) continue;
    const sources = seen.get(edge.target) || new Set();
    if (sources.has(edge.source)) continue;
    sources.add(edge.source); seen.set(edge.target, sources);
    counts.get(edge.target)[types.get(edge.source) === 'image' ? 'images' : 'text']++;
  }
  return counts;
}

export const directInputs = (graph, nodeId) => directInputCounts(graph).get(nodeId) || { images: 0, text: 0 };

export function inputLabel({ images, text }) {
  return [images ? plural(images, '{count} image', '{count} images') : '', text ? t('{count} text', { count: text }) : ''].filter(Boolean).join(' · ');
}

export function generationIntent(graph, boardId, nodeId) {
  const { prompt, images, snapshot, target } = collectInputs(graph, nodeId);
  const ids = new Set(snapshot.map(node => node.id));
  const fields = node => ({ id: node.id, type: node.type, text: node.data.text, template: node.data.template, asset: node.data.asset, label: node.data.label, caption: node.data.caption });
  return { boardId, nodeId, signature: JSON.stringify({ prompt, images, target: fields(target), inputs: snapshot.map(fields), edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)).map(({ source, target }) => [source, target]).sort() }) };
}

export function intentUnchanged(intent, graph, boardId) {
  try { return intent?.boardId === boardId && generationIntent(graph, boardId, intent.nodeId).signature === intent.signature; }
  catch { return false; }
}

const nodeSize = node => node.data.collapsed ? { width: 72, height: 72 } : { width: node.measured?.width || 310, height: node.measured?.height || (node.type === 'image' ? 310 : 150) };

export function freePromptPosition(graph, sourceId) {
  const source = graph.nodes.find(node => node.id === sourceId);
  if (!source) throw new Error(t('Reference node no longer exists.'));
  return freeSpot(graph, { x: source.position.x + nodeSize(source).width + 90, y: source.position.y });
}

// Moves a new prompt down from the wanted spot until it overlaps no node or group.
export function freeSpot(graph, wanted) {
  const position = { ...wanted }, width = 310, height = 150, gap = 30;
  const boxes = [...graph.nodes.map(node => ({ ...node.position, ...nodeSize(node) })), ...(graph.groups || []).map(group => groupBounds(group, graph.nodes))];
  for (const box of boxes.filter(box => box.x < position.x + width + gap && box.x + box.width + gap > position.x).sort((a, b) => a.y - b.y)) {
    if (position.y < box.y + box.height + gap && position.y + height + gap > box.y) position.y = box.y + box.height + gap;
  }
  return position;
}

export function focusViewport(node, viewport, bounds) {
  const { width, height } = nodeSize(node), left = node.position.x * viewport.zoom + viewport.x, top = node.position.y * viewport.zoom + viewport.y;
  const box = bounds.occlusion, occluded = box && left < box.x + box.width && left + width * viewport.zoom > box.x && top < box.y + box.height && top + height * viewport.zoom > box.y;
  if (!occluded && viewport.zoom >= .8 && viewport.zoom <= 1.3 && left >= 30 && top >= 60 && left + width * viewport.zoom <= bounds.width - 30 && top + height * viewport.zoom <= bounds.height - 90) return null;
  const zoom = Math.min(1.1, Math.max(.85, viewport.zoom));
  const centerY = box ? Math.max(60 + height * zoom / 2, Math.min(bounds.height / 2, box.y - 30 - height * zoom / 2)) : bounds.height / 2;
  return { x: node.position.x + width / 2, y: node.position.y + height / 2 + Math.max(0, bounds.height / 2 - centerY) / zoom, zoom };
}
