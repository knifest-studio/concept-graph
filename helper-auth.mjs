import { timingSafeEqual } from 'node:crypto';

export const helperOrigins = site => site.split(',').map(origin => origin.trim()).filter(Boolean);

export function authorizeHelper(request, url, site, token) {
  const origin = request.headers.origin;
  const origins = helperOrigins(site);
  if (origin && !origins.includes(origin)) return false;
  if (request.method === 'OPTIONS') return origins.includes(origin);
  const isMedia = url.pathname.startsWith('/assets/') || /^\/api\/boards\/[\da-f-]{36}\/events$/.test(url.pathname);
  const supplied = request.headers['x-concept-graph-token'] || (isMedia && url.searchParams.get('token')) || '';
  const expectedBytes = Buffer.from(token);
  const actualBytes = Buffer.from(typeof supplied === 'string' ? supplied : '');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
