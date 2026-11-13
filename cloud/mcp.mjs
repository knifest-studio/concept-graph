// The cloud MCP endpoint: Streamable HTTP answered with plain JSON, without sessions or event streams. OAuthProvider has
// checked the agent's token before a request gets here; ctx.props is the person who connected the agent.
import { getServerByName } from 'partyserver';
import { sessionIdentity, validateName } from './auth.mjs';
import { imageFormat, imageTypes, readBody } from './assets.mjs';
import { base64, nanoStatus } from './nano-banana.mjs';
import { gptImageStatus } from './gpt-image.mjs';
import { canEdit } from './access.mjs';
import { checkArgs, fail, listedTools, toolByName } from './mcp-tools.mjs';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const maxRequest = 30 * 1024 * 1024, maxUpload = 20 * 1024 * 1024, maxShown = 4.5 * 1024 * 1024;
const instructions = 'Concept Graph team boards: prompts, images and notes on a shared canvas. Start with list_boards, then get_board; look at images with get_image. '
  + 'Every change appears at once for everyone on the board, made in the name of the person who connected you, so ask before deleting boards, pages or much content. '
  + 'list_chat reads persistent board chat (50 per page); send_chat posts as this person, marked via agent, with an optional nodeId link. Viewers can use both. Chat is separate from canvas versions. '
  + 'start_run generates like the Generate button: Nano Banana or GPT Image on the team API keys with shared access and limits, Codex on this person\'s own computer through their open board.';
const directory = env => env.Directory.get(env.Directory.idFromName('boards'));
const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function decode(data) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail('data must be base64.');
  const binary = atob(data), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function boardAccess(env, user, id, needs) {
  const board = await directory(env).boardFor(id, user.email);
  if (!board) fail('Board not found. Use list_boards.');
  if (!board.role) fail('You don’t have access to this board.');
  if (needs === 'edit' && !canEdit(board.role)) fail('You can only view this board.');
  return board;
}
const brief = ({ covers, ...board }) => board;
const boardName = value => { try { return validateName(value, 80); } catch (cause) { fail(cause.message); } };

// Account tools: what the Worker answers without opening a board.
const account = {
  whoami: async (env, user) => ({ user: { name: user.name, email: user.email }, nanoBanana: await nanoStatus(user, env, directory(env)), gptImage: await gptImageStatus(user, env, directory(env)) }),
  list_boards: async (env, user) => ({ boards: (await directory(env).boardsFor(user.email)).map(brief) }),
  create_board: async (env, user, args) => {
    const store = directory(env), board = await store.createBoard(boardName(args.name), user);
    return { board: brief(await store.boardFor(board.id, user.email)) };
  },
  rename_board: async (env, user, args) => {
    const board = await boardAccess(env, user, args.boardId);
    if (board.role !== 'owner') fail('Only the board’s owner can rename it.');
    await directory(env).renameBoard(board.id, boardName(args.name));
    return { board: brief(await directory(env).boardFor(board.id, user.email)) };
  },
  delete_board: async (env, user, args) => {
    const board = await boardAccess(env, user, args.boardId);
    if (board.role !== 'owner') fail('Only the board’s owner can delete it.');
    if (args.confirmName !== board.name) fail('confirmName must be the board’s exact current name.');
    await directory(env).trashBoard(board.id, user.email);
    try { await (await getServerByName(env.BoardRoom, board.id)).trash(); }
    catch (cause) { console.error('Could not close the deleted board:', cause); }
    return { deleted: board.id, restorableUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() };
  },
  upload_image: async (env, user, args) => {
    const bytes = decode(args.data);
    if (bytes.length > maxUpload) fail('Images can be at most 20 MB.');
    let format;
    try { format = imageFormat(bytes); } catch (cause) { fail(cause.message); }
    const asset = `${crypto.randomUUID()}.${format}`;
    await env.FILES.put(`assets/${asset}`, bytes, { httpMetadata: { contentType: imageTypes[format] } });
    return { asset };
  },
  // As on the board, the shared preview stands in for the original when there is one.
  get_image: async (env, user, args) => {
    const content = [];
    for (const asset of args.assets) {
      const object = (!args.original && await env.FILES.get(`thumbs/${asset}`)) || await env.FILES.get(`assets/${asset}`);
      if (!object) { content.push({ type: 'text', text: `${asset}: not found.` }); continue; }
      if (object.size > maxShown) { content.push({ type: 'text', text: `${asset}: ${Math.round(object.size / 1048576)} MB is too large to show; leave out original to see its preview.` }); continue; }
      const type = object.httpMetadata?.contentType || imageTypes[asset.split('.').pop()];
      content.push({ type: 'text', text: asset }, { type: 'image', data: base64(new Uint8Array(await object.arrayBuffer())), mimeType: type });
    }
    return { content };
  },
};

async function call(env, user, name, args) {
  const tool = toolByName.get(name);
  if (!tool) return null;
  checkArgs(args, tool.inputSchema);
  if (tool.account) return account[name](env, user, args);
  const board = await boardAccess(env, user, args.boardId, tool.access);
  const answer = await (await getServerByName(env.BoardRoom, board.id)).mcp({ tool: name, args, user });
  if (answer.error) fail(answer.error);
  return name === 'get_board' ? { board: { id: board.id, name: board.name, role: board.role, access: board.access, ownerName: board.ownerName }, ...answer.value } : answer.value;
}

async function answer(message, env, user) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    // Responses to requests this server never sends need no answer.
    return message && typeof message === 'object' && !('method' in message) && ('result' in message || 'error' in message) ? null : rpcError(message?.id ?? null, -32600, 'Invalid request.');
  }
  const { id, method, params } = message;
  if (id === undefined) return null;
  if (method === 'initialize') return rpc(id, { protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions[0],
    capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'concept-graph-cloud', title: 'Concept Graph', version: '1.0.0' }, instructions });
  if (method === 'ping') return rpc(id, {});
  if (method === 'tools/list') return rpc(id, { tools: listedTools });
  if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found.');
  if (typeof params?.name !== 'string') return rpcError(id, -32602, 'Tool name is required.');
  try {
    const value = await call(env, user, params.name, params.arguments ?? {});
    return value === null ? rpcError(id, -32602, `Unknown tool: ${params.name}`) : rpc(id, value?.content ? value : json(value));
  } catch (cause) {
    if (!cause?.expected) console.error('MCP tool failed:', params.name, cause);
    return rpc(id, { isError: true, content: [{ type: 'text', text: cause?.expected ? cause.message : 'The tool failed. Try again.' }] });
  }
}

export const mcpApi = {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    let user;
    try { user = sessionIdentity(ctx.props || {}); }
    catch { return Response.json({ error: 'Reconnect the agent to Concept Graph.' }, { status: 401 }); }
    let messages;
    try { messages = JSON.parse(new TextDecoder().decode(await readBody(request, maxRequest))); }
    catch (cause) { return Response.json(rpcError(null, cause.status === 413 ? -32600 : -32700, cause.status === 413 ? 'Request is too large.' : 'Invalid JSON.'), { status: cause.status === 413 ? 413 : 400 }); }
    const batch = Array.isArray(messages);
    const answers = (await Promise.all((batch ? messages : [messages]).map(message => answer(message, env, user)))).filter(Boolean);
    if (!answers.length) return new Response(null, { status: 202 });
    return Response.json(batch ? answers : answers[0], { headers: { 'Cache-Control': 'no-store' } });
  }
};
