export const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const OAUTH_MAX_AGE = 10 * 60;
const palette = ['#e63946', '#f4a261', '#d4a017', '#2a9d8f', '#238636', '#0077b6', '#6366f1', '#9b5de5', '#d63384', '#8d6e63'];
const encoder = new TextEncoder();

export function validateName(value, max = 40) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new Error(`Name must be 1–${max} characters.`);
  return value.trim();
}

export function userColor(name) {
  let hash = 0;
  for (const char of name) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value) {
  if (!/^[\w-]+$/.test(value)) throw new Error('Invalid session encoding.');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error('Invalid session encoding.');
  return bytes;
}

function signingKey(secret) {
  if (!secret || typeof secret !== 'string') throw new Error('SESSION_SECRET is not configured.');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export function sessionIdentity({ name, email }) {
  if (typeof email !== 'string') throw new Error('Invalid email.');
  email = email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('Invalid email.');
  return { name: validateName(name), email, color: userColor(email) };
}

async function signPayload(value, secret, now = Date.now()) {
  const payload = encode(encoder.encode(JSON.stringify({ ...value, iat: Math.floor(now / 1000) })));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}

async function verifyPayload(token, secret, maxAge, now = Date.now()) {
  try {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (!await crypto.subtle.verify('HMAC', await signingKey(secret), decode(signature), encoder.encode(payload))) return null;
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(payload)));
    const time = Math.floor(now / 1000);
    if (!Number.isSafeInteger(value.iat) || value.iat > time || time - value.iat >= maxAge) return null;
    return value;
  } catch {
    return null;
  }
}

export async function signSession(identity, secret, now = Date.now()) {
  return signPayload(sessionIdentity(identity), secret, now);
}

export async function verifySession(token, secret, now = Date.now()) {
  try {
    const session = await verifyPayload(token, secret, SESSION_MAX_AGE, now);
    const user = sessionIdentity(session);
    if (session.name !== user.name || session.email !== user.email || session.color !== user.color) return null;
    return user;
  } catch {
    return null;
  }
}

function cookieValue(request, name) {
  const cookie = (request.headers.get('Cookie') || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1);
}

export function sessionUser(request, secret) {
  return verifySession(cookieValue(request, 'cg_session'), secret);
}

export function sessionCookie(token, url) {
  return `cg_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token ? SESSION_MAX_AGE : 0}${new URL(url).protocol === 'https:' ? '; Secure' : ''}`;
}

function oauthCookie(token, url) {
  return `cg_google=${token}; HttpOnly; SameSite=Lax; Path=/api/auth/google; Max-Age=${token ? OAUTH_MAX_AGE : 0}${url.protocol === 'https:' ? '; Secure' : ''}`;
}

function authRedirect(location, cookies) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function googleConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET);
}

export async function recordLogin(user, env, googleSub = null) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY, google_sub TEXT, name TEXT,
      created_at TEXT, last_login_at TEXT, login_count INTEGER
    )`).run();
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO users (email, google_sub, name, created_at, last_login_at, login_count)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(email) DO UPDATE SET
        google_sub = COALESCE(excluded.google_sub, users.google_sub), name = excluded.name,
        last_login_at = excluded.last_login_at, login_count = users.login_count + 1
    `).bind(user.email, googleSub, user.name, now, now).run();
  } catch (cause) {
    console.error('Failed to record user sign-in:', cause);
  }
}

export async function googleSignIn(request, env) {
  const url = new URL(request.url);
  if (!googleConfigured(env)) return authRedirect('/?auth_error=unavailable', [oauthCookie('', url)]);
  const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
  const state = { kind: 'google', state: random(), nonce: random(), verifier: random(), origin: url.origin };
  const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(state.verifier))));
  const target = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  target.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/api/auth/google/callback`,
    response_type: 'code', scope: 'openid email profile', prompt: 'select_account',
    state: state.state, nonce: state.nonce, code_challenge: challenge, code_challenge_method: 'S256'
  }).toString();
  return authRedirect(target.href, [oauthCookie(await signPayload(state, env.SESSION_SECRET), url)]);
}

export async function googleCallback(request, env) {
  const url = new URL(request.url), cookies = [oauthCookie('', url)];
  if (!googleConfigured(env)) return authRedirect('/?auth_error=unavailable', cookies);
  try {
    const state = await verifyPayload(cookieValue(request, 'cg_google'), env.SESSION_SECRET, OAUTH_MAX_AGE);
    if (!state || state.kind !== 'google' || state.origin !== url.origin || state.state !== url.searchParams.get('state')
      || ![state.state, state.nonce, state.verifier].every(value => typeof value === 'string' && /^[\w-]{43}$/.test(value))) throw new Error('Invalid sign-in state.');
    if (url.searchParams.has('error')) console.error('Google sign-in returned an error:', String(url.searchParams.get('error')).slice(0, 64));
    if (url.searchParams.has('error')) return authRedirect(url.searchParams.get('error') === 'access_denied' ? '/?auth_error=cancelled' : '/?auth_error=failed', cookies);
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) throw new Error('Missing code.');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${url.origin}/api/auth/google/callback`, grant_type: 'authorization_code', code_verifier: state.verifier })
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(`Token exchange failed (${response.status} ${String(detail.error || '').slice(0, 64)}).`);
    }
    const { id_token: token } = await response.json();
    if (typeof token !== 'string' || token.length > 16384) throw new Error('Missing ID token.');
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[2]) throw new Error('Invalid ID token.');
    const parse = part => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(part)));
    const header = parse(parts[0]), claims = parse(parts[1]);
    // OIDC Core 3.1.3.7 permits TLS validation for tokens received directly from the token endpoint.
    if (header.alg !== 'RS256' || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)
      || claims.aud !== env.GOOGLE_CLIENT_ID || (claims.azp !== undefined && claims.azp !== env.GOOGLE_CLIENT_ID)
      || !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)
      || claims.nonce !== state.nonce || claims.email_verified !== true
      || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new Error('Invalid identity claims.');
    const email = claims.email;
    const displayName = typeof claims.name === 'string' ? claims.name.trim() : '';
    const user = sessionIdentity({ email, name: (displayName || (typeof email === 'string' ? email.split('@')[0] : '')).slice(0, 40).trim() });
    cookies.push(sessionCookie(await signSession(user, env.SESSION_SECRET), url));
    await recordLogin(user, env, claims.sub);
    return authRedirect('/', cookies);
  } catch (cause) {
    console.error('Google sign-in failed:', cause.message);
    return authRedirect('/?auth_error=failed', cookies);
  }
}

export function devLoginEnabled(request, env) {
  return env.DEV_LOGIN === '1' && ['localhost', '127.0.0.1'].includes(new URL(request.url).hostname);
}
