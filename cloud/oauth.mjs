// Connecting an agent: the person signs in to the site as usual, sees which app asks and where its access goes, and
// allows it. OAuthProvider (cloud/worker.mjs) registers apps and issues, stores and checks their tokens in OAUTH_KV.
import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider';
import { devLoginEnabled, sessionUser } from './auth.mjs';

export const agentScopes = ['boards'];
const escape = value => String(value).replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const style = `:root{color-scheme:light dark;--bg:#f6f5fb;--card:#fff;--text:#25243d;--muted:#6b6e89;--line:#e3e1ee;--accent:#6d4aff;--warn:#9a3412}
@media (prefers-color-scheme:dark){:root{--bg:#15141f;--card:#211f2e;--text:#eceaf6;--muted:#a9a7bd;--line:#353247;--accent:#9b85ff;--warn:#fdba74}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{box-sizing:border-box;width:min(440px,calc(100vw - 32px));background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:13px}.warn{color:var(--warn)}
.actions{display:flex;gap:10px;margin-top:20px}button,.button{font:inherit;border-radius:8px;padding:9px 16px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer;text-decoration:none}
.primary{background:var(--accent);border-color:var(--accent);color:#fff}input{font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;width:100%;box-sizing:border-box;margin-bottom:8px}`;

function page(title, body, status = 200, headers = new Headers()) {
  headers.set('Content-Type', 'text/html; charset=utf-8'); headers.set('Cache-Control', 'no-store'); headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY'); headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escape(title)} · Concept Graph</title><link rel="icon" href="/favicon.svg"><style>${style}</style></head><body><main>${body}</main></body></html>`, { status, headers });
}

// The pending connection survives sign-in: Google returns the person to this same address.
function signIn(url, devLogin) {
  const next = url.pathname + url.search.replace(/([?&])auth_error=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return `<h1>Sign in to connect your agent</h1>
<p>An agent asks to use your Concept Graph boards. Sign in first; you’ll see what it asks for before anything is shared.</p>
${url.searchParams.has('auth_error') ? '<p class="warn">Sign-in didn’t finish. Try again.</p>' : ''}
<div class="actions"><a class="button primary" href="/api/auth/google?next=${escape(encodeURIComponent(next))}">Sign in with Google</a></div>
${devLogin ? `<form id="dev" style="margin-top:20px"><p class="muted">Local test sign-in</p><input name="name" placeholder="Name" required><input name="email" type="email" placeholder="Email" required><button>Sign in</button></form>
<script>document.getElementById('dev').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);const r=await fetch('/api/auth/dev',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.get('name'),email:f.get('email')})});if(r.ok)location.reload();}</script>` : ''}`;
}

function consent(details, handle, user) {
  const origin = details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : 'The app named itself; that name is not verified.';
  return `<h1>Allow ${escape(details.clientName)} to use your boards?</h1>
<p>${origin} Access goes to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting it.</p>' : ''}
<p>It will act as <strong>${escape(user.name)}</strong> (${escape(user.email)}): see every board you can open, and change, generate on, rename or delete them as your role on each allows. Changes appear for everyone on the board.</p>
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<div class="actions"><button class="primary" name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></div></form>
<p class="muted" style="margin-top:16px">The connection lasts up to 30 days. Not you? <a href="/">Switch account</a> on the site, then connect again.</p>`;
}

export async function authorize(request, env) {
  const oauth = env.OAUTH_PROVIDER, url = new URL(request.url);
  if (!oauth) return new Response('Not found.', { status: 404 });
  try {
    if (request.method === 'GET') {
      const auth = await oauth.parseAuthRequest(request);
      const user = await sessionUser(request, env.SESSION_SECRET);
      if (!user) return page('Sign in', signIn(url, devLoginEnabled(request, env)));
      const details = await oauth.describeConsent(auth), started = await oauth.beginConsent(auth);
      return page('Connect agent', consent(details, started.handle, user), 200, started.headers);
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
    const user = await sessionUser(request, env.SESSION_SECRET);
    if (!user) return page('Sign in', '<h1>Your sign-in ended</h1><p>Start connecting again from your agent.</p>', 401);
    const form = await request.formData(), handle = String(form.get('handle') || '');
    if (form.get('decision') !== 'approve') return new Response(null, { status: 302, headers: (await oauth.denyConsent(request, handle)).headers });
    const approved = await oauth.approveConsent(request, handle, { scope: agentScopes });
    const { redirectTo } = await oauth.completeAuthorization({ request: approved.request, userId: user.email, metadata: { name: user.name }, scope: approved.request.scope, props: user });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      return page('Can’t connect', `<h1>This agent can’t connect</h1><p>${escape(error instanceof AuthorizationError ? error.description || 'The request is invalid or expired.' : 'The app could not be verified.')}</p><p class="muted">Start connecting again from your agent.</p>`, 400);
    }
    throw error;
  }
}
