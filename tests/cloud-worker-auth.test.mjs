import test from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_MAX_AGE, sessionIdentity, sessionCookie, sessionUser, signSession, userColor, validateName, verifySession } from '../cloud/auth.mjs';
import { MAX_IMAGE_BYTES, assetPattern, imageFormat, readBody } from '../cloud/assets.mjs';
import { imageFormat as localImageFormat } from '../graph.mjs';

const secret = 'test-only-session-secret', now = Date.UTC(2026, 10, 3);
const identity = { name: 'Artist', email: 'artist@example.com' };

async function signed(value) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${payload}.${Buffer.from(signature).toString('base64url')}`;
}

test('session signs Unicode names and reads only the session cookie', async () => {
  const token = await signSession({ name: '  Художник 🎨  ', email: ' Artist@Example.COM ' }, secret, now);
  const user = { name: 'Художник 🎨', email: identity.email, color: userColor(identity.email) };
  assert.deepEqual(await verifySession(token, secret, now), user);
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
  assert.deepEqual(payload, { ...user, iat: now / 1000 });
  const current = await signSession(identity, secret);
  assert.deepEqual(await sessionUser(new Request('http://localhost/', { headers: { Cookie: `other=1; cg_session=${current}; last=2` } }), secret), sessionIdentity(identity));
  assert.equal(await sessionUser(new Request('http://localhost/?cg_session=' + current), secret), null);
});

test('session rejects tampering, wrong secrets, malformed tokens and missing secrets', async () => {
  const token = await signSession(identity, secret, now);
  const [payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ name: 'Other', color: userColor('Other'), iat: now / 1000 })).toString('base64url');
  for (const value of [undefined, '', 'a', `${token}.extra`, `!.${signature}`, `${forged}.${signature}`, `${payload}.${signature.slice(0, -2)}aa`, 'a'.repeat(2049)]) {
    assert.equal(await verifySession(value, secret, now), null);
  }
  assert.equal(await verifySession(token, 'wrong-secret', now), null);
  assert.equal(await verifySession(token, '', now), null);
  await assert.rejects(signSession(identity, ''), /not configured/);
});

test('session expires exactly after 30 days and rejects future issuance', async () => {
  const token = await signSession(identity, secret, now);
  assert.ok(await verifySession(token, secret, now + (SESSION_MAX_AGE - 1) * 1000));
  assert.equal(await verifySession(token, secret, now + SESSION_MAX_AGE * 1000), null);
  assert.equal(await verifySession(token, secret, now - 1000), null);
});

test('signed sessions reject old cookies and invalid identity or issuance fields', async () => {
  const user = sessionIdentity(identity), valid = { ...user, iat: now / 1000 };
  for (const value of [null, {},
    { name: 'Artist', color: userColor('Artist'), iat: now / 1000 },
    { ...valid, name: ' Artist ' }, { ...valid, name: '' }, { ...valid, name: 'x'.repeat(41) },
    { ...valid, color: '#ffffff' }, { ...valid, email: 'Artist@example.com' },
    { ...valid, email: '' }, { ...valid, email: 'invalid' },
    { ...valid, iat: String(now / 1000) }, { ...valid, iat: null }
  ]) assert.equal(await verifySession(await signed(value), secret, now), null);
});

test('identity normalizes email and derives colour from email independently of name', () => {
  const user = sessionIdentity({ name: ' Artist ', email: ' ARTIST@Example.COM ' });
  assert.deepEqual(user, { ...identity, color: userColor(identity.email) });
  assert.equal(sessionIdentity({ ...identity, name: 'Renamed' }).color, user.color);
  assert.notEqual(sessionIdentity({ ...identity, email: 'other@example.com' }).color, user.color);
  for (const email of [undefined, 42, '', 'no-at', 'a@@b', 'a @b', 'x'.repeat(255) + '@example.com', 'İ'.repeat(130) + '@example.com']) {
    assert.throws(() => sessionIdentity({ ...identity, email }), /Invalid email/);
  }
});

test('cookie has the required flags and clears on logout', () => {
  assert.equal(sessionCookie('token', 'http://localhost:8787'), `cg_session=token; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`);
  assert.match(sessionCookie('token', 'https://example.com'), /; Secure$/);
  assert.equal(sessionCookie('', 'https://example.com'), 'cg_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure');
});

test('name limits apply after trimming for people and boards', () => {
  assert.equal(validateName('  Artist  '), 'Artist');
  assert.equal(validateName('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(validateName('b'.repeat(80), 80), 'b'.repeat(80));
  for (const value of ['', ' \n ', null, 42, {}, 'a'.repeat(41)]) assert.throws(() => validateName(value), /Name must/);
  assert.throws(() => validateName('a'.repeat(81), 80), /Name must/);
  assert.equal(userColor('Artist'), userColor('Artist'));
  assert.match(userColor('Художник 🎨'), /^#[\da-f]{6}$/);
  assert.ok(new Set(Array.from({ length: 100 }, (_, i) => userColor(`Artist ${i}`))).size >= 10);
});

test('image detection matches graph.mjs for PNG, JPEG, GIF and WebP', () => {
  const samples = [
    [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'png'],
    [Buffer.from([255, 216, 255]), 'jpg'],
    [Buffer.from('GIF87a'), 'gif'], [Buffer.from('GIF89a'), 'gif'],
    [Buffer.from('RIFFxxxxWEBP'), 'webp']
  ];
  for (const [bytes, format] of samples) {
    assert.equal(imageFormat(new Uint8Array(bytes)), format);
    assert.equal(imageFormat(bytes), localImageFormat(bytes));
    for (let length = 0; length < bytes.length; length++) assert.throws(() => imageFormat(bytes.subarray(0, length)), /Use a PNG/);
  }
  for (const bytes of [Buffer.from('GIF88a'), Buffer.from('RIFFxxxxWAVE'), Buffer.from('<svg></svg>'), Buffer.from('random')]) {
    assert.throws(() => imageFormat(bytes), /Use a PNG/);
    assert.throws(() => localImageFormat(bytes), /Use a PNG/);
  }
  assert.ok(assetPattern.test('00000000-0000-0000-0000-000000000000.png'));
  for (const asset of ['../image.png', '00000000-0000-0000-0000-000000000000.svg', '00000000-0000-0000-0000-000000000000.png/extra']) assert.equal(assetPattern.test(asset), false);
});

test('body limit checks actual streamed bytes as well as Content-Length', async () => {
  assert.equal(MAX_IMAGE_BYTES, 30 * 1024 * 1024);
  assert.deepEqual(await readBody(new Request('http://localhost/')), new Uint8Array());
  const request = bytes => new Request('http://localhost/', { method: 'POST', body: bytes });
  assert.deepEqual(await readBody(request(new Uint8Array([1, 2, 3])), 3), new Uint8Array([1, 2, 3]));
  await assert.rejects(readBody(request(new Uint8Array(4)), 3), { status: 413 });
  await assert.rejects(readBody(new Request('http://localhost/', { method: 'POST', headers: { 'Content-Length': '4' }, body: 'a' }), 3), { status: 413 });
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(2)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBody(new Request('http://localhost/', { method: 'POST', body: stream, duplex: 'half' }), 3), { status: 413 });
  assert.equal(cancelled, true);
});
