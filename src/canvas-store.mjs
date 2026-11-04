import { boardAuthor } from './annotations.mjs';
import { sameShape } from './layers.mjs';
import { directInputCounts } from './onboarding.mjs';

// One snapshot of the editor's changing values. Node components subscribe to their own slice of it,
// so an editor render re-renders only the nodes whose slice changed.
export function createCanvasStore(initial = {}) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    // Notifies only when a field actually changed.
    update(patch) {
      for (const key of Object.keys(patch)) {
        if (Object.is(state[key], patch[key])) continue;
        state = { ...state, ...patch };
        for (const listener of [...listeners]) listener();
        return true;
      }
      return false;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

// Functions that keep their identity forever and always call the latest implementation.
export function latestCommands(latest) {
  return Object.fromEntries(Object.keys(latest.current).map(name => [name, (...args) => latest.current[name](...args)]));
}

export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && Object.is(a[key], b[key]));
}

// Built once per runs change instead of a reverse scan per node render. The latest run for a node is its last in the list.
export function runLookups(runs) {
  const latestRun = new Map(), runById = new Map();
  for (const run of runs) { latestRun.set(run.nodeId, run); runById.set(run.id, run); }
  return { latestRun, runById };
}

export const runAuthor = (data, runById) => boardAuthor(data.author) || (data.runId ? boardAuthor(runById.get(data.runId)?.by) : undefined);

// Moving or typing keeps the previous counts, so input chips do not re-render.
export function inputCounts(nodes, edges, previous) {
  if (previous && previous.edges === edges && sameShape(previous.nodes, nodes)) return { ...previous, nodes };
  return { nodes, edges, counts: directInputCounts({ nodes, edges }) };
}

// Below ~0.4 a card is too small for its controls; below the gesture limit (0.15, reachable only by fitting) a crowded
// board downloads nothing new. Each switch has some slack so a zoom resting on a threshold does not flicker.
export function detailLevel(zoom, previous = 'full') {
  if (zoom < (previous === 'tiny' ? .16 : .14)) return 'tiny';
  return zoom < (previous === 'full' ? .38 : .42) ? 'low' : 'full';
}

// A node is off screen when its box (flow coordinates) misses the visible pane.
export function outsideViewport(node, { x, y, zoom }, width, height) {
  const size = node.measured || { width: node.width || 0, height: node.height || 0 };
  const left = node.position.x * zoom + x, top = node.position.y * zoom + y;
  return left > width || top > height || left + size.width * zoom < 0 || top + size.height * zoom < 0;
}
