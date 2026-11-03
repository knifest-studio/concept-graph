import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeHelper } from '../helper-auth.mjs';

test('helper allows only its paired site with the per-run token', () => {
  const site = 'https://concept-graph-local.knifest.chatgpt.site';
  const secret = '0123456789abcdef';
  const request = (method, pathname, origin, token, header = 'x-concept-graph-token') => authorizeHelper({ method, headers: { ...(origin ? { origin } : {}), ...(token ? { [header]: token } : {}) } }, new URL(pathname, 'http://127.0.0.1:4317'), site, secret);
  assert.equal(request('GET', '/api/workspace', site, secret), true);
  assert.equal(request('GET', '/api/workspace', site, ''), false);
  assert.equal(request('GET', '/api/workspace', 'https://attacker.example', secret), false);
  assert.equal(request('GET', '/api/workspace?token=' + secret, site, ''), false);
  assert.equal(request('GET', '/assets/uuid.png?token=' + secret, undefined, ''), true);
  assert.equal(request('GET', '/api/boards/00000000-0000-0000-0000-000000000000/events?token=' + secret, site, ''), true);
  assert.equal(request('GET', '/assets/uuid.png?token=' + secret, 'https://attacker.example', ''), false);
  assert.equal(request('OPTIONS', '/api/workspace', site, ''), true);
  assert.equal(request('OPTIONS', '/api/workspace', 'https://attacker.example', ''), false);
});
