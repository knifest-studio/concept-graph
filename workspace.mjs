import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateGraph } from './graph.mjs';

export const emptyGraph = () => ({ revision: 0, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, runs: [] });
export function boardName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('Board names must contain 1–80 characters.');
  return value.trim();
}
export function createBoard(name, graph = emptyGraph()) {
  return { id: randomUUID(), name: boardName(name), createdAt: new Date().toISOString(), graph };
}
export async function loadWorkspace(directory) {
  const file = path.join(directory, 'workspace.json');
  let workspace;
  try { workspace = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Saved boards could not be read; no data was overwritten. ' + error.message);
    let graph;
    try { graph = JSON.parse(await readFile(path.join(directory, 'canvas.json'), 'utf8')); }
    catch (legacyError) { if (legacyError.code !== 'ENOENT') throw legacyError; }
    if (graph !== undefined) validateGraph(graph);
    const board = createBoard(graph ? 'My concepts' : 'Untitled board', graph || emptyGraph());
    workspace = { version: 1, defaultBoardId: board.id, boards: [board] };
  }
  if (workspace.version !== 1 || !Array.isArray(workspace.boards) || !workspace.boards.length) throw new Error('Invalid board storage; no data was overwritten.');
  const ids = new Set();
  for (const board of workspace.boards) {
    if (!/^[\da-f-]{36}$/.test(board.id) || ids.has(board.id)) throw new Error('Invalid board ID.');
    ids.add(board.id); boardName(board.name); validateGraph(board.graph);
    if (!Array.isArray(board.graph.runs) || !Number.isSafeInteger(board.graph.revision)) throw new Error('Invalid board history.');
  }
  if (!ids.has(workspace.defaultBoardId)) throw new Error('Default board is missing.');
  return workspace;
}
export async function writeWorkspace(directory, workspace) {
  const file = path.join(directory, 'workspace.json');
  await writeFile(file + '.tmp', JSON.stringify(workspace, null, 2));
  await rename(file + '.tmp', file);
}
