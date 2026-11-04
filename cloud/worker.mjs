import { routePartykitRequest } from 'partyserver';
import { devLoginEnabled, googleCallback, googleSignIn, recordLogin, sessionCookie, sessionIdentity, sessionUser, signSession, validateName } from './auth.mjs';
import { assetPattern, imageFormat, imageTypes, readBody } from './assets.mjs';
import { privacyHtml } from './privacy.mjs';
import { imageSize, validateTemplate } from '../graph.mjs';
import { helperDownloadType } from '../src/helper-download.mjs';

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
    return json({ user }, 200, { 'Set-Cookie': cookie });
  }
  const protectedPath = path.startsWith('/api/') || path.startsWith('/assets/') || path.startsWith('/downloads/') || path.startsWith('/parties/');
  const user = protectedPath ? await sessionUser(request, env.SESSION_SECRET) : null;
  if (protectedPath && !user) return error('Sign in required.', 401);
  if (path === '/api/cloud/logout' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', url) });
  if (path === '/api/cloud/me' && method === 'GET') return json({ user });
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
    if (method === 'GET') return json({ boards: await directory(env).listBoards() });
    if (method === 'POST') return json({ board: await directory(env).createBoard(name((await body(request)).name, 80)) }, 201);
    return error('Method not allowed.', 405);
  }
  const boardMatch = path.match(/^\/api\/cloud\/boards\/([^/]+)$/);
  if (boardMatch) {
    if (!boardPattern.test(boardMatch[1])) return error('Board not found.', 404);
    if (method !== 'PATCH') return error('Method not allowed.', 405);
    const board = await directory(env).renameBoard(boardMatch[1], name((await body(request)).name, 80));
    return board ? json({ board }) : error('Board not found.', 404);
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
        if (lobby.className !== 'BoardRoom' || !await directory(env).getBoard(lobby.name)) return error('Board not found.', 404);
      }
    }) || error('Board not found.', 404);
  }
  if (path.startsWith('/api/')) return error('Not found.', 404);
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch (cause) {
      if (cause.status >= 400 && cause.status < 500) return error(cause.message, cause.status);
      console.error('Cloud request failed:', cause);
      return error('Cloud request failed.', 500);
    }
  }
};
