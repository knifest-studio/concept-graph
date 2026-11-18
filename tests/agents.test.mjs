import test from 'node:test';
import assert from 'node:assert/strict';
import { agentsRoute, noteAgentUse } from '../cloud/agents.mjs';

const user = { name: 'Ann', email: 'ann@example.test' };
function fakeEnv() {
  const seen = [], revoked = [];
  const store = { agentSeen: (email, at) => seen.push([email, at]), agentLastSeen: () => 1_800_000_000_000 };
  const oauth = {
    listUserGrants: async email => ({ items: email === user.email ? [{ id: 'g1', clientId: 'c1', createdAt: 1_700_000_000 }, { id: 'g2', clientId: 'https://claude.ai/oauth/client.json', createdAt: 1_700_000_100 }] : [] }),
    lookupClient: async id => { if (id === 'c1') return { clientName: 'Claude Code' }; throw new Error('metadata_resolution_failed'); },
    revokeGrant: async (id, email) => revoked.push([id, email])
  };
  return { env: { OAUTH_PROVIDER: oauth, Directory: { idFromName: name => name, get: () => store } }, seen, revoked };
}
const call = (env, method, path, headers = {}) => agentsRoute(new Request(`https://site.test${path}`, { method, headers }), env, user, new URL(`https://site.test${path}`));

test('a person sees their connected agents, newest first, with names and times in milliseconds', async () => {
  const { env } = fakeEnv();
  const value = await (await call(env, 'GET', '/api/agents')).json();
  assert.equal(value.available, true);
  assert.deepEqual(value.agents, [{ id: 'g2', client: 'claude.ai', connectedAt: 1_700_000_100_000 }, { id: 'g1', client: 'Claude Code', connectedAt: 1_700_000_000_000 }]);
  assert.equal(value.lastUsed, 1_800_000_000_000);
});

test('without an OAuth provider no agent can connect, and Disconnect checks the page origin', async () => {
  const { env, revoked } = fakeEnv();
  assert.deepEqual(await (await call({ ...env, OAUTH_PROVIDER: undefined }, 'GET', '/api/agents')).json(), { available: false, agents: [], lastUsed: null });
  assert.equal((await call(env, 'DELETE', '/api/agents/g1', { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await call(env, 'DELETE', '/api/agents/g1', { Origin: 'https://site.test' })).status, 200);
  assert.deepEqual(revoked, [['g1', user.email]]);
});

test('agent use is noted at most once a minute per person', async () => {
  const { env, seen } = fakeEnv(), email = `burst-${Date.now()}@example.test`;
  await noteAgentUse(env, email, 1_000_000);
  assert.equal(noteAgentUse(env, email, 1_030_000), null);
  await noteAgentUse(env, email, 1_061_000);
  assert.deepEqual(seen.map(([who, at]) => [who, at]), [[email, 1_000_000], [email, 1_061_000]]);
});
