import { canEdit } from './access.mjs';
import { maxBoardTemplates } from '../src/board-templates.mjs';

const fail = (message, status) => { throw Object.assign(new Error(message), { status }); };

// Assets are global, immutable IDs; deleting a board deliberately keeps them for other boards.
export async function templateCopy(request, { boardId, user, store, room, input }) {
  const destination = await store.boardFor(boardId, user.email);
  if (!destination) fail('Board not found.', 404);
  if (!canEdit(destination.role)) fail('You can only view this board.', 403);
  if (request.method === 'GET') {
    const boards = [];
    for (const board of await store.boardsFor(user.email)) {
      if (board.id === boardId || !board.role) continue;
      const templates = await (await room(board.id)).listTemplates();
      if (templates.length) boards.push({ id: board.id, name: board.name, templates: templates.map(({ id, name, color, instructions, assets }) => ({ id, name, color, preview: instructions.slice(0, 160), imageCount: assets.length })) });
    }
    return { boards };
  }
  if (request.method !== 'POST') fail('Method not allowed.', 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) fail('Invalid origin.', 403);
  const { selections } = await input();
  if (!Array.isArray(selections) || !selections.length || selections.length > maxBoardTemplates
    || selections.some(item => typeof item?.boardId !== 'string' || typeof item.id !== 'string')
    || new Set(selections.map(item => `${item.boardId}:${item.id}`)).size !== selections.length) fail('Choose up to 500 custom nodes.', 400);
  const values = [];
  for (const sourceId of new Set(selections.map(item => item.boardId))) {
    if (sourceId === boardId) fail('Choose another board.', 400);
    const source = await store.boardFor(sourceId, user.email);
    if (!source?.role) fail('Source board not found or inaccessible.', 403);
    const templates = await (await room(sourceId)).listTemplates();
    for (const item of selections.filter(item => item.boardId === sourceId)) {
      const template = templates.find(value => value.id === item.id);
      if (!template) fail('Custom node no longer exists.', 404);
      values.push(template);
    }
  }
  return (await room(boardId)).importTemplates(values, user);
}
