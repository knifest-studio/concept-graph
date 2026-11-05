import { getServerByName, routePartykitRequest } from 'partyserver';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { devLoginEnabled, googleCallback, googleSignIn, recordLogin, sessionCookie, sessionIdentity, sessionUser, signSession, validateName } from './auth.mjs';
import { assetPattern, imageFormat, imageTypes, readBody } from './assets.mjs';
import { privacyHtml } from './privacy.mjs';
import { nanoSettings, nanoStatus } from './nano-banana.mjs';
import { upscaleSettings } from './upscale.mjs';
import { canEdit } from './access.mjs';
import { imageSize, validateTemplate } from '../graph.mjs';
import { helperDownloadType } from '../src/helper-download.mjs';
import { mcpApi } from './mcp.mjs';
import { agentScopes, authorize } from './oauth.mjs';
import { purgeTrash } from './trash.mjs';

export { BoardRoom } from './board-room.mjs';
export { Directory } from './directory.mjs';

const boardPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const error = (message, status) => json({ error: message }, status);
const directory = env => env.Directory.get(env.Directory.idFromName('boards'));

async function body(request, limit = 64 * 1024) {
  try {
    const value = JSON.parse(new TextDecoder().decode(await readBody(request, limit)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (cause) {
    throw Object.assign(new Error(cause.status === 413 ? cause.message : 'Invalid JSON body.'), { status: cause.status || 400 });
  }
}

async function templateInput(value, env) {
  let template;
  try { template = validateTemplate(value); }
  catch (cause) { throw Object.assign(cause, { status: 400 }); }
  for (const asset of template.assets) if (!await env.FILES.head(`assets/${asset}`)) throw Object.assign(new Error('File not found.'), { status: 404 });
  return template;
}

function name(value, max = 40) {
  try { return validateName(value, max); }
  catch (cause) { throw Object.assign(cause, { status: 400 }); }
}

// The room trusts these headers to say who connected and what they may do, so no copy a client sent reaches it.
function admitted(request, role, user) {
  const next = new Request(request);
  for (const key of [...next.headers.keys()]) if (key.startsWith('x-concept-graph-') || key === 'x-partykit-props') next.headers.delete(key);
  next.headers.set('x-concept-graph-role', role); next.headers.set('x-concept-graph-email', user.email);
  // The display name, for the board's version history; headers carry ASCII only.
  next.headers.set('x-concept-graph-name', encodeURIComponent(user.name || ''));
  return next;
}

// Everyone connected to the board gets their new role at once; if this fails, they get it when they next connect.
async function refreshRoom(env, id) {
  try { await (await getServerByName(env.BoardRoom, id)).refreshAccess(); }
  catch (cause) { console.error('Could not update access on the open board:', cause); }
}

// Everyone who has signed in, most recent first, so admins can grant access without typing addresses.
async function signedIn(env) {
  try { return ((await env.DB.prepare('SELECT email, name, last_login_at AS lastLoginAt FROM users ORDER BY last_login_at DESC LIMIT 1000').all()).results || []).map(({ email, name, lastLoginAt }) => ({ email, name, lastLoginAt })); }
  catch { return []; }
}

// Site admins choose who may use the site's Gemini key; the site owner also chooses the admins.
async function teamRoute(request, env, user, url) {
  const store = directory(env), shown = async access => json({ access: { ...access, people: await signedIn(env) } });
  if (request.method === 'GET') {
    const access = await store.teamAccess(user.email);
    return access ? shown(access) : error('Only site admins can see who may use Nano Banana.', 403);
  }
  if (request.method !== 'PATCH') return error('Method not allowed.', 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return error('Invalid origin.', 403);
  const input = await body(request), result = await store.changeTeamAccess(user.email, { nano: input.nano, admin: input.admin });
  return result.error ? error(result.error, result.status) : shown(result.access);
}

// Generation runs in the board's room, which holds the board; the Worker only checks who may spend the site's key.
async function nanoRoute(request, env, user, url, boardId, runId) {
  if (request.method !== 'POST') return error('Method not allowed.', 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return error('Invalid origin.', 403);
  const board = boardPattern.test(boardId) && await directory(env).boardFor(boardId, user.email);
  if (!board) return error('Board not found.', 404);
  if (!canEdit(board.role)) return error(board.role ? 'You can only view this board.' : 'You don’t have access to this board.', 403);
  if (runId !== undefined) {
    if (!boardPattern.test(runId)) return error('Generation not found.', 404);
    const result = await (await getServerByName(env.BoardRoom, boardId)).cancelNano({ runId, email: user.email });
    return result.error ? error(result.error, result.status) : json({ ok: true });
  }
  // Upscaling with Topaz or SeedVR2 needs only the fal.ai key; the room checks which key the node needs.
  if (!nanoSettings(env).configured && !upscaleSettings(env).fal) return error('Nano Banana isn’t set up on this site.', 503);
  if (!await directory(env).nanoAllowed(user.email)) return error('Nano Banana is not available for your account. Ask a site admin for access.', 403);
  const input = await body(request), counter = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof input.nodeId !== 'string' || !input.nodeId || input.nodeId.length > 120) return error('Choose a prompt to generate.', 400);
  const result = await (await getServerByName(env.BoardRoom, boardId)).startNano({ nodeId: input.nodeId, client: counter(input.client), clock: counter(input.clock), requester: user });
  return result.error ? error(result.error, result.status) : json({ run: result.run }, 202);
}

// Anyone who may open a board sees its versions; restoring one changes the board, so it takes edit access.
async function versionRoute(request, env, user, url, boardId, versionId) {
  const board = boardPattern.test(boardId) && await directory(env).boardFor(boardId, user.email);
  if (!board) return error('Board not found.', 404);
  if (!board.role) return error('You don’t have access to this board.', 403);
  const room = await getServerByName(env.BoardRoom, boardId);
  if (versionId === undefined) return request.method === 'GET' ? json({ versions: await room.listVersions() }) : error('Method not allowed.', 405);
  if (request.method !== 'POST') return error('Method not allowed.', 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return error('Invalid origin.', 403);
  if (!canEdit(board.role)) return error('You can only view this board.', 403);
  const result = await room.restoreVersion({ id: versionId, user: { name: user.name, email: user.email } });
  return result.error ? error(result.error, result.status) : json(result);
}

async function route(request, env) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === '/concept-graph-helper-downloads.json') {
    if (!['GET', 'HEAD'].includes(method)) return error('Method not allowed.', 405);
    const object = await env.FILES[method === 'HEAD' ? 'head' : 'get']('downloads/concept-graph-helper-downloads.json');
    if (!object) {
      const response = error('Helper downloads not found.', 404);
      return method === 'HEAD' ? new Response(null, response) : response;
    }
    return new Response(method === 'HEAD' ? null : object.body, { headers: {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Content-Length': String(object.size), 'X-Content-Type-Options': 'nosniff'
    } });
  }
  if (path === '/privacy') {
    if (!['GET', 'HEAD'].includes(method)) return error('Method not allowed.', 405);
    return new Response(method === 'HEAD' ? null : privacyHtml, { headers: {
      'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff'
    } });
  }
  // Board links load the app, which signs the person in and then opens the board.
  if (/^\/b\/[^/]+\/?$/.test(path)) return ['GET', 'HEAD'].includes(method) ? env.ASSETS.fetch(new Request(new URL('/', url), { method, headers: request.headers })) : error('Method not allowed.', 405);
  if (path === '/oauth/authorize') return authorize(request, env);
  if (path === '/api/auth/google') return method === 'GET' ? googleSignIn(request, env) : error('Method not allowed.', 405);
  if (path === '/api/auth/google/callback') return method === 'GET' ? googleCallback(request, env) : error('Method not allowed.', 405);
  if (path === '/api/auth/config') return method === 'GET' ? json({ devLogin: devLoginEnabled(request, env) }) : error('Method not allowed.', 405);
  if (path === '/api/auth/dev') {
    if (!devLoginEnabled(request, env)) return error('Not found.', 404);
    if (method !== 'POST') return error('Method not allowed.', 405);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return error('Invalid origin.', 403);
    if (!env.SESSION_SECRET) return error('Cloud sign-in is not configured.', 503);
    const input = await body(request);
    let user;
    try { user = sessionIdentity(input); }
    catch (cause) { return error(cause.message, 400); }
    const cookie = sessionCookie(await signSession(user, env.SESSION_SECRET), url);
    await recordLogin(user, env);
    return json({ user, siteRole: await directory(env).siteRole(user.email) }, 200, { 'Set-Cookie': cookie });
  }
  const protectedPath = path.startsWith('/api/') || path.startsWith('/assets/') || path.startsWith('/downloads/') || path.startsWith('/parties/');
  const user = protectedPath ? await sessionUser(request, env.SESSION_SECRET) : null;
  if (protectedPath && !user) return error('Sign in required.', 401);
  if (path === '/api/cloud/logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', url) });
  if (path === '/api/cloud/me' && method === 'GET') return json({ user, siteRole: await directory(env).siteRole(user.email) });
  if (path === '/api/cloud/team') return teamRoute(request, env, user, url);
  if (path === '/api/nano') return method === 'GET' ? json({ ...await nanoStatus(user, env, directory(env)), fal: upscaleSettings(env).fal }) : error('Method not allowed.', 405);
  const nanoMatch = path.match(/^\/api\/boards\/([^/]+)\/nano(?:\/([^/]+)\/cancel)?$/);
  if (nanoMatch) return nanoRoute(request, env, user, url, nanoMatch[1], nanoMatch[2]);
  if (path === '/api/templates') {
    if (method === 'GET') return json({ templates: await directory(env).listTemplates() });
    if (method === 'POST') {
      const result = await directory(env).createTemplate(await templateInput(await body(request, 4 * 1024 * 1024), env));
      return result.error ? error(result.error, result.status) : json(result, 201);
    }
    return error('Not found.', 404);
  }
  const templateMatch = path.match(/^\/api\/templates\/([\da-f-]{36})$/);
  if (templateMatch && ['PUT', 'DELETE'].includes(method)) {
    const input = await body(request, 4 * 1024 * 1024), store = directory(env);
    const current = await store.checkTemplate(templateMatch[1], input.expected);
    if (current.error) return error(current.error, current.status);
    const result = await store.changeTemplate(templateMatch[1], input.expected, method === 'DELETE' ? null : await templateInput(input, env));
    return result.error ? error(result.error, result.status) : json(result);
  }
  if (path === '/api/cloud/boards') {
    if (method === 'GET') return json({ boards: await directory(env).boardsFor(user.email) });
    if (method === 'POST') {
      const board = await directory(env).createBoard(name((await body(request)).name, 80), user);
      return json({ board: await directory(env).boardFor(board.id, user.email) }, 201);
    }
    return error('Method not allowed.', 405);
  }
  if (path === '/api/cloud/trash') return method === 'GET' ? json({ boards: await directory(env).trashFor(user.email) }) : error('Method not allowed.', 405);
  const trashMatch = path.match(/^\/api\/cloud\/trash\/([^/]+)\/restore$/);
  if (trashMatch) {
    if (method !== 'POST') return error('Method not allowed.', 405);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return error('Invalid origin.', 403);
    if (!boardPattern.test(trashMatch[1])) return error('Board not found.', 404);
    const result = await directory(env).restoreBoard(trashMatch[1], user.email);
    return result.error ? error(result.error, result.status) : json(result);
  }
  const versionMatch = path.match(/^\/api\/cloud\/boards\/([^/]+)\/versions(?:\/([^/]+)\/restore)?$/);
  if (versionMatch) return versionRoute(request, env, user, url, versionMatch[1], versionMatch[2]);
  const boardMatch = path.match(/^\/api\/cloud\/boards\/([^/]+)(\/sharing)?$/);
  if (boardMatch) {
    const id = boardMatch[1], store = directory(env);
    if (!boardPattern.test(id)) return error('Board not found.', 404);
    if (boardMatch[2]) {
      if (method === 'GET') {
        const sharing = await store.sharing(id, user.email);
        return !sharing ? error('Board not found.', 404) : sharing.role ? json({ sharing }) : error('You don’t have access to this board.', 403);
      }
      if (method !== 'PATCH') return error('Method not allowed.', 405);
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return error('Invalid origin.', 403);
      const input = await body(request), result = await store.changeSharing(id, user.email, { access: input.access, linkRole: input.linkRole, member: input.member });
      if (result.error) return error(result.error, result.status);
      await refreshRoom(env, id);
      return json(result);
    }
    if (method === 'GET') {
      const result = await store.openBoard(id, user);
      return result.error ? json({ error: result.error, ...(result.owner ? { owner: result.owner } : {}) }, result.status) : json(result);
    }
    if (!['PATCH', 'DELETE'].includes(method)) return error('Method not allowed.', 405);
    const board = await store.boardFor(id, user.email);
    if (!board) return error('Board not found.', 404);
    if (board.role !== 'owner') return error(board.role ? `Only the board’s owner can ${method === 'DELETE' ? 'delete' : 'rename'} it.` : 'You don’t have access to this board.', 403);
    if (method === 'DELETE') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return error('Invalid origin.', 403);
      // The exact name, typed by the owner, guards against a stray or replayed request.
      if ((await body(request)).confirmName !== board.name) return error('Type the board’s name to delete it.', 400);
      await store.trashBoard(id, user.email);
      try { await (await getServerByName(env.BoardRoom, id)).trash(); }
      catch (cause) { console.error('Could not close the deleted board:', cause); }
      return json({ deleted: id });
    }
    await store.renameBoard(id, name((await body(request)).name, 80));
    return json({ board: await store.boardFor(id, user.email) });
  }
  if (path === '/api/assets') {
    if (method !== 'POST') return error('Method not allowed.', 405);
    const bytes = await readBody(request);
    let format;
    try { format = imageFormat(bytes); }
    catch (cause) { return error(cause.message, 400); }
    const asset = `${crypto.randomUUID()}.${format}`;
    await env.FILES.put(`assets/${asset}`, bytes, { httpMetadata: { contentType: imageTypes[format] } });
    return json({ asset });
  }
  // Shared previews: the first viewer of an image stores a small copy, so others never download the original just to see the canvas.
  const thumbMatch = path.match(/^\/assets\/([\da-f-]{36}\.(?:png|jpg|gif|webp))\/thumb$/);
  if (thumbMatch) {
    const key = `thumbs/${thumbMatch[1]}`;
    if (method === 'PUT') {
      const bytes = await readBody(request, 512 * 1024);
      let format;
      try { format = imageFormat(bytes); }
      catch (cause) { return error(cause.message, 400); }
      const size = imageSize(bytes);
      if (!['webp', 'jpg'].includes(format) || !size || Math.max(size.width, size.height) > 1024) return error('Thumbnails must be WebP or JPEG, at most 1024 px.', 400);
      if (!await env.FILES.head(`assets/${thumbMatch[1]}`)) return error('Asset not found.', 404);
      // The first stored preview wins and is cached as immutable.
      if (await env.FILES.head(key)) return json({ ok: true });
      await env.FILES.put(key, bytes, { httpMetadata: { contentType: imageTypes[format] } });
      return json({ ok: true }, 201);
    }
    if (!['GET', 'HEAD'].includes(method)) return error('Method not allowed.', 405);
    const object = await env.FILES.get(key);
    // "Not made yet" is the normal first answer, so it is not reported as a failed request.
    if (!object) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    const headers = { 'Content-Type': object.httpMetadata?.contentType || 'image/webp', 'Cache-Control': 'private, max-age=31536000, immutable', 'ETag': object.httpEtag, 'X-Content-Type-Options': 'nosniff' };
    if (request.headers.get('If-None-Match')?.split(',').some(tag => ['*', object.httpEtag, `W/${object.httpEtag}`].includes(tag.trim()))) return new Response(null, { status: 304, headers });
    return new Response(method === 'HEAD' ? null : object.body, { headers: { ...headers, 'Content-Length': String(object.size) } });
  }
  if (path.startsWith('/assets/')) {
    const asset = path.slice('/assets/'.length);
    if (!assetPattern.test(asset)) return error('Asset not found.', 404);
    if (!['GET', 'HEAD'].includes(method)) return error('Method not allowed.', 405);
    const object = await env.FILES.get(`assets/${asset}`);
    if (!object) return error('Asset not found.', 404);
    const headers = {
      'Content-Type': imageTypes[asset.split('.').pop()],
      'Cache-Control': 'private, max-age=31536000, immutable',
      'ETag': object.httpEtag,
      'X-Content-Type-Options': 'nosniff'
    };
    if (request.headers.get('If-None-Match')?.split(',').some(tag => ['*', object.httpEtag, `W/${object.httpEtag}`].includes(tag.trim()))) return new Response(null, { status: 304, headers });
    return new Response(method === 'HEAD' ? null : object.body, { headers: { ...headers, 'Content-Length': String(object.size) } });
  }
  if (path.startsWith('/downloads/')) {
    const file = path.slice('/downloads/'.length), contentType = helperDownloadType(file);
    if (!contentType) return error('Download not found.', 404);
    if (!['GET', 'HEAD'].includes(method)) return error('Method not allowed.', 405);
    const object = await env.FILES.get(`downloads/${file}`);
    if (!object) return error('Download not found.', 404);
    const headers = {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${file}"`,
      'Cache-Control': 'private, no-cache',
      'ETag': object.httpEtag,
      'X-Content-Type-Options': 'nosniff'
    };
    if (request.headers.get('If-None-Match')?.split(',').some(tag => ['*', object.httpEtag, `W/${object.httpEtag}`].includes(tag.trim()))) return new Response(null, { status: 304, headers });
    return new Response(method === 'HEAD' ? null : object.body, { headers: { ...headers, 'Content-Length': String(object.size) } });
  }
  if (path.startsWith('/parties/')) {
    const match = path.match(/^\/parties\/board-room\/([^/]+)$/);
    if (!match || !boardPattern.test(match[1])) return error('Board not found.', 404);
    if (method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return error('WebSocket upgrade required.', 426);
    return await routePartykitRequest(request, env, {
      prefix: 'parties',
      onBeforeConnect: async (incoming, lobby) => {
        const origin = incoming.headers.get('Origin');
        if (origin && origin !== url.origin) return error('Invalid origin.', 403);
        const board = lobby.className === 'BoardRoom' && await directory(env).boardFor(lobby.name, user.email);
        if (!board) return error('Board not found.', 404);
        if (!board.role) return error('You don’t have access to this board.', 403);
        return admitted(incoming, board.role, user);
      }
    }) || error('Board not found.', 404);
  }
  if (path.startsWith('/api/')) return error('Not found.', 404);
  return env.ASSETS.fetch(request);
}

const site = {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (cause) {
      if (cause.status >= 400 && cause.status < 500) return error(cause.message, cause.status);
      console.error('Cloud request failed:', cause);
      return error('Cloud request failed.', 500);
    }
  }
};

// Agents connect over MCP at /mcp with OAuth: the provider serves discovery, registration and tokens, and lets only
// requests with a valid token reach the MCP handler. A token names its site address, so each address gets its own
// provider; one it cannot serve (plain http off localhost) gets the site without agents.
const providers = new Map();
function providerFor(origin) {
  if (!providers.has(origin)) {
    let provider = null;
    try {
      provider = new OAuthProvider({
        apiRoute: '/mcp', apiHandler: mcpApi, defaultHandler: site,
        authorizeEndpoint: '/oauth/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
        scopesSupported: [...agentScopes, 'offline_access'], requiredScopes: agentScopes, clientIdMetadataDocumentEnabled: true,
        resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin], resource_name: 'Concept Graph' }
      });
    } catch (cause) { console.error('Agents cannot connect at this address:', origin, cause.message); }
    if (providers.size > 16) providers.clear();
    providers.set(origin, provider);
  }
  return providers.get(origin);
}

export default {
  fetch(request, env, ctx) {
    return (providerFor(new URL(request.url).origin) || site).fetch(request, env, ctx);
  },
  scheduled(controller, env, ctx) { ctx.waitUntil(purgeTrash(env)); }
};
