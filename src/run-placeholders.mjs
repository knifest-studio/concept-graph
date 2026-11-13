import { isSiteGenerator, nodeSize, positionRunOutput, runOutputPage } from '../graph.mjs';
import { boardPages, nodePage } from './pages.mjs';
import { waitingVideos } from './waiting-videos.mjs';

export function waitingVideo(id, clips = waitingVideos) {
  let hash = 0;
  for (const letter of id) hash = (hash * 31 + letter.codePointAt(0)) >>> 0;
  return clips[hash % clips.length];
}

// Diagnostics already reach local/hosted clients; progress text can outlive the tool call.
export const codexImageActive = run => run.diagnostics?.events?.findLast(event => ['image_started', 'image_completed', 'image_failed', 'turn_completed', 'error'].includes(event.type))?.type === 'image_started';
const knownAspect = node => {
  const aspect = node?.data?.aspect || node?.data?.pixels?.height / node?.data?.pixels?.width;
  return Number.isFinite(aspect) && aspect >= .1 && aspect <= 10 ? aspect : undefined;
};

export function runPlaceholders(graph, runs, page, spawns) {
  const nodes = [], edges = [], pages = boardPages(graph), byId = new Map(graph.nodes.map(node => [node.id, node]));
  for (const run of runs) {
    if (!['running', 'queued'].includes(run.status)) continue;
    const prompt = byId.get(run.nodeId);
    if (!prompt || nodePage(prompt, pages) !== page || runOutputPage(graph, run) !== page) continue;
    const task = run.task || prompt.data.task, describe = task === 'describe', upscale = task === 'upscale', outputIds = run.outputIds || [];
    const expected = describe ? 1 : upscale ? (run.images?.length || run.snapshot?.filter(node => node.type === 'image').length
      || new Set(graph.edges.filter(edge => edge.target === run.nodeId && byId.get(edge.source)?.type === 'image').map(edge => edge.source)).size || 1)
      : isSiteGenerator(run.provider) ? run.variants || 1 : codexImageActive(run) ? outputIds.length + 1 : 1;
    const target = run.target || prompt;
    const inputs = run.snapshot ? run.snapshot.filter(node => node.type === 'image')
      : [...new Set(graph.edges.filter(edge => edge.target === run.nodeId).map(edge => edge.source))].map(id => byId.get(id)).filter(node => node?.type === 'image');
    // Browser measurements are not stored; predict with the same bounds the server and shared document receive.
    const scratch = { ...graph, nodes: graph.nodes.map(({ measured, ...node }) => node) }, placement = { ...run, outputIds: [...outputIds] };
    for (let slot = outputIds.length; slot < expected; slot++) {
      const aspect = upscale ? knownAspect(inputs[slot]) || 1 : knownAspect(target) || knownAspect(inputs.length === 1 ? inputs[0] : null) || 1;
      const id = `${run.id}-pending-${slot}`, output = { id, type: describe ? 'text' : 'image',
        position: { x: target.position.x + 390, y: target.position.y + (describe ? 0 : slot * 340) }, data: { aspect, runId: run.id } };
      positionRunOutput(output, scratch, placement);
      const size = nodeSize(output), spawnAt = spawns?.get(run.id)?.get(id), animation = Number.isFinite(spawnAt) ? { spawnAt } : {};
      nodes.push({ ...output, type: 'pending', selectable: false, draggable: false, connectable: false, deletable: false, focusable: false,
        measured: size, style: size, data: { ...output.data, ...animation, describe, status: run.status === 'queued' ? 'Queued' : describe ? 'Describing' : upscale ? 'Upscaling' : 'Generating', clip: describe ? undefined : waitingVideo(id) } });
      edges.push({ id: `${id}-edge`, source: run.nodeId, target: id, type: 'pending', data: animation, className: 'pending-edge', selectable: false, deletable: false, focusable: false });
      scratch.nodes.push(output); placement.outputIds.push(id);
    }
  }
  return { nodes, edges };
}
