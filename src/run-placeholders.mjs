import { generators, nodeSize, positionRunOutput, runOutputPage } from '../graph.mjs';
import { boardPages, nodePage } from './pages.mjs';
import { waitingVideos } from './waiting-videos.mjs';

export function waitingVideo(id, clips = waitingVideos) {
  let hash = 0;
  for (const letter of id) hash = (hash * 31 + letter.codePointAt(0)) >>> 0;
  return clips[hash % clips.length];
}

export function runPlaceholders(graph, runs, page) {
  const nodes = [], edges = [], pages = boardPages(graph), byId = new Map(graph.nodes.map(node => [node.id, node]));
  for (const run of runs) {
    if (!['running', 'queued'].includes(run.status)) continue;
    const prompt = byId.get(run.nodeId);
    if (!prompt || nodePage(prompt, pages) !== page || runOutputPage(graph, run) !== page) continue;
    const task = run.task || prompt.data.task, describe = task === 'describe', upscale = task === 'upscale', outputIds = run.outputIds || [];
    const expected = describe ? 1 : upscale ? (run.images?.length || run.snapshot?.filter(node => node.type === 'image').length
      || new Set(graph.edges.filter(edge => edge.target === run.nodeId && byId.get(edge.source)?.type === 'image').map(edge => edge.source)).size || 1)
      : run.provider === generators.nanoBanana ? run.variants || 1 : outputIds.length + 1;
    const target = run.target || prompt, aspect = Number.isFinite(target.data?.aspect) && target.data.aspect >= .1 && target.data.aspect <= 10 ? target.data.aspect : 1;
    // Browser measurements are not stored; predict with the same bounds the server and shared document receive.
    const scratch = { ...graph, nodes: graph.nodes.map(({ measured, ...node }) => node) }, placement = { ...run, outputIds: [...outputIds] };
    for (let slot = outputIds.length; slot < expected; slot++) {
      const id = `${run.id}-pending-${slot}`, output = { id, type: describe ? 'text' : 'image',
        position: { x: target.position.x + 390, y: target.position.y + (describe ? 0 : slot * 340) }, data: { aspect, runId: run.id } };
      positionRunOutput(output, scratch, placement);
      const size = nodeSize(output);
      nodes.push({ ...output, type: 'pending', selectable: false, draggable: false, connectable: false, deletable: false, focusable: false,
        measured: size, style: size, data: { ...output.data, describe, status: run.status === 'queued' ? 'Queued' : describe ? 'Describing' : upscale ? 'Upscaling' : 'Generating', clip: describe ? undefined : waitingVideo(id) } });
      edges.push({ id: `${id}-edge`, source: run.nodeId, target: id, className: 'pending-edge', selectable: false, deletable: false, focusable: false });
      scratch.nodes.push(output); placement.outputIds.push(id);
    }
  }
  return { nodes, edges };
}
