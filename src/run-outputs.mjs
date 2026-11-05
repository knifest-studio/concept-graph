import { imageNode, descriptionNode, isDescribe, isUpscale, positionRunOutput, groupRunOutputs } from '../graph.mjs';
import { boardAuthor } from './annotations.mjs';
import { boardPages, nodePage, pageField, samePage } from './pages.mjs';

export const terminalRun = status => ['completed', 'failed', 'cancelled'].includes(status);
export const runOutputId = (runId, index) => `${runId}-output-${index}`;
// What history shows for a run of this prompt: its page, a short label and the custom node it used.
export const runSummary = (graph, target) => ({ ...pageField(nodePage(target, boardPages(graph))), label: (target.data.text.trim() || target.data.template?.name || (isDescribe(target) ? 'Describe image' : isUpscale(target) ? 'Upscale image' : 'Generation')).slice(0, 120), ...(target.data.template?.name ? { template: target.data.template.name } : {}) });

/**
 * One generated image joins a board the same way for every generator: a node beside its prompt (or below the run's
 * earlier images), a connection from the prompt, captions once there are several, and the run's group.
 * `before` is the board as read from the shared document; returns the next graph to apply against it, or null when
 * the run has finished or already shows this output. `fields` are written over the stored run (Codex reports settings).
 */
export function placeRunOutput(before, { runId, nodeId, run: current, author, fields = {}, output, asset, dimensions }) {
  const id = runOutputId(runId, output.index);
  if (terminalRun(current?.status) || current?.outputIds?.includes(id)) return null;
  // Copies only what this step changes; untouched nodes stay shared, so the diff skips them.
  const graph = { ...before, nodes: [...before.nodes], edges: [...before.edges], groups: before.groups.map(group => ({ ...group, nodeIds: [...group.nodeIds] })), runs: [...before.runs] };
  const target = graph.nodes.find(node => node.id === nodeId) || { position: { x: 0, y: 0 } };
  const run = { ...(current || { id: runId, nodeId, label: 'Recovered generation', ...pageField(nodePage(target, boardPages(graph))) }), by: boardAuthor(current?.by || author), ...fields, status: 'running', outputIds: [...(current?.outputIds || [])] };
  let node = graph.nodes.find(node => node.id === id);
  if (!node) {
    node = imageNode({ id: runId, target, by: run.by }, asset, output.index, dimensions);
    node.id = id;
    if (output.caption || output.index > 0) node.data.caption = output.caption || `Image ${output.index + 1}`;
    positionRunOutput(node, graph, run);
    graph.nodes.push(node);
  }
  run.outputIds.push(id); run.count = run.outputIds.length;
  if (run.outputIds.length === 2) {
    const index = graph.nodes.findIndex(node => node.id === run.outputIds[0]), first = graph.nodes[index];
    if (first && !Object.hasOwn(first.data, 'caption')) graph.nodes[index] = { ...first, data: { ...first.data, caption: 'Image 1' } };
  }
  if (samePage(graph, graph.nodes.find(item => item.id === nodeId), node) && !graph.edges.some(edge => edge.id === `${id}-edge`)) graph.edges.push({ id: `${id}-edge`, source: nodeId, target: id });
  const previousGroup = run.autoGroupId;
  groupRunOutputs(graph, run, id);
  // Every replica names the run's group the same way, so concurrent placements cannot create two.
  if (!previousGroup && run.autoGroupId) {
    graph.groups.find(group => group.id === run.autoGroupId).id = `${runId}-group`;
    run.autoGroupId = `${runId}-group`;
  }
  graph.runs = [...graph.runs.filter(item => item.id !== runId), run];
  return graph;
}

/**
 * A finished description joins the board as one text node beside its describe node, connected from it. Every replica
 * names it the same way, so concurrent placements cannot create two. Returns null when the run already shows it.
 */
export function placeRunText(before, { runId, nodeId, run: current, author, fields = {}, text }) {
  const id = runOutputId(runId, 0);
  if (terminalRun(current?.status) || current?.outputIds?.includes(id) || before.nodes.some(node => node.id === id)) return null;
  const graph = { ...before, nodes: [...before.nodes], edges: [...before.edges], runs: [...before.runs] };
  const target = graph.nodes.find(node => node.id === nodeId) || { position: { x: 0, y: 0 } };
  const run = { ...(current || { id: runId, nodeId, label: 'Recovered description', ...pageField(nodePage(target, boardPages(graph))) }), by: boardAuthor(current?.by || author), ...fields, status: 'running', outputIds: [] };
  const node = descriptionNode({ id: runId, target, by: run.by }, text);
  node.id = id;
  positionRunOutput(node, graph, run);
  graph.nodes.push(node);
  run.outputIds.push(id); run.count = 1;
  if (samePage(graph, graph.nodes.find(item => item.id === nodeId), node)) graph.edges.push({ id: `${id}-edge`, source: nodeId, target: id });
  graph.runs = [...graph.runs.filter(item => item.id !== runId), run];
  return graph;
}
