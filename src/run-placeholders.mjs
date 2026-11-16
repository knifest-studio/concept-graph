import { nextLayer } from './layers.mjs';
import { plannedOutputs } from './output-placement.mjs';
import { defaultPageId } from './pages.mjs';
// Which waiting clip a placeholder opens on is decided from its id alone, because the clips themselves are listed
// by the site and are not known here: the browser turns this seed into a clip once it has the list.
export function waitingSeed(id) {
  let hash = 0;
  for (const letter of id) hash = (hash * 31 + letter.codePointAt(0)) >>> 0;
  return hash;
}

export { codexImageActive } from './output-placement.mjs';

export function runPlaceholders(graph, runs, page, spawns) {
  const nodes = [], edges = [];
  if (!runs.some(run => ['running', 'queued'].includes(run.status))) return { nodes, edges };
  // Browser measurements are not stored; predict with the same bounds the server and shared document receive.
  const plans = plannedOutputs({ ...graph, nodes: graph.nodes.map(({ measured, ...node }) => node) }, runs, page);
  const z = nextLayer(graph.nodes), pageFields = page === defaultPageId ? {} : { page };
  for (const run of runs) {
    const slots = plans.get(run.id) || [], task = slots.length && (run.task || graph.nodes.find(node => node.id === run.nodeId)?.data.task);
    // A run of many variants starts a few calls at a time and counts them in variantsStarted; the slots after them are queued.
    const first = run.outputIds?.length || 0, started = run.variantsStarted ?? Infinity;
    for (const [index, { id, position, size, type, aspect }] of slots.entries()) {
      const slot = first + index, describe = type === 'text', spawnAt = spawns?.get(run.id)?.get(id), animation = Number.isFinite(spawnAt) ? { spawnAt } : {};
      const status = run.status === 'queued' || slot >= started ? 'Queued' : describe ? 'Describing' : task === 'model3d' ? 'Generating 3D' : task === 'upscale' ? 'Upscaling' : 'Generating';
      nodes.push({ id, type: 'pending', position, ...pageFields, z: z + index, selectable: false, draggable: false, connectable: false, deletable: false, focusable: false,
        measured: size, style: size, data: { aspect, runId: run.id, ...animation, describe, slot, status, seed: describe ? undefined : waitingSeed(id) } });
      edges.push({ id: `${id}-edge`, source: run.nodeId, target: id, type: 'pending', data: animation, className: 'pending-edge', selectable: false, deletable: false, focusable: false });
    }
  }
  return { nodes, edges };
}
