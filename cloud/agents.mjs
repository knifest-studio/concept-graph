// Which AI agents a person connected over MCP, and when one last worked for them. A connection is an OAuth grant the
// provider keeps in OAUTH_KV; activity is noted at most once a minute per person and isolate, so a busy agent writes one
// Directory row a minute. Listing grants is a KV list (1,000 a day on the free plan), so the page asks only when someone
// opens the agent dialogs, never on a timer.
const directory = env => env.Directory.get(env.Directory.idFromName('boards'));
const noted = new Map();
export const agentNoteMs = 60000;

export function noteAgentUse(env, email, now = Date.now()) {
  if (!email || now - (noted.get(email) || 0) < agentNoteMs) return null;
  if (noted.size > 1000) noted.clear();
  noted.set(email, now);
  return Promise.resolve(directory(env).agentSeen(email, now)).catch(cause => console.error('Could not note agent use:', cause?.message));
}

// Grant times come in seconds; anything already in milliseconds passes through.
const millis = value => Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : null;
// A client that names itself by a metadata document URL (CIMD) is shown by its site when the document cannot be read.
const fallbackName = clientId => { try { return new URL(clientId).hostname; } catch { return ''; } };

export async function agentsRoute(request, env, user, url) {
  const method = request.method, oauth = env.OAUTH_PROVIDER;
  const reply = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  if (url.pathname === '/api/agents') {
    if (method !== 'GET') return reply({ error: 'Method not allowed.' }, 405);
    // Plain http off localhost has no OAuth provider, so no agent can connect there.
    if (!oauth) return reply({ available: false, agents: [], lastUsed: null });
    const { items = [] } = await oauth.listUserGrants(user.email, { limit: 50 });
    const agents = await Promise.all(items.map(async grant => {
      const client = await oauth.lookupClient(grant.clientId).catch(() => null);
      return { id: grant.id, client: client?.clientName || fallbackName(grant.clientId) || '', connectedAt: millis(grant.createdAt) };
    }));
    agents.sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
    return reply({ available: true, agents, lastUsed: await directory(env).agentLastSeen(user.email) });
  }
  const one = url.pathname.match(/^\/api\/agents\/([\w.:-]{1,200})$/);
  if (!one) return reply({ error: 'Not found.' }, 404);
  if (method !== 'DELETE') return reply({ error: 'Method not allowed.' }, 405);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return reply({ error: 'Invalid origin.' }, 403);
  if (!oauth) return reply({ error: 'Agents cannot connect at this address.' }, 400);
  // revokeGrant checks that the grant belongs to this person, so nobody can disconnect someone else's agent.
  await oauth.revokeGrant(one[1], user.email);
  return reply({ ok: true });
}
