import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, loopbackBlocked } from '../src/platform-detection.mjs';

const hinted = (platform, architecture, bitness, extra = {}) => ({
  userAgentData: { platform, mobile: false, async getHighEntropyValues() { return { architecture, bitness }; } }, ...extra,
});

test('recommends matching supported builds from explicit architecture hints', async () => {
  assert.deepEqual(await detectPlatform(hinted('macOS', 'arm', '64')), { platform: 'macos', architecture: 'arm64', packageId: 'macos-arm64' });
  assert.deepEqual(await detectPlatform(hinted('macOS', 'x86', '64')), { platform: 'macos', architecture: 'x64', packageId: 'macos-x64' });
  assert.deepEqual(await detectPlatform(hinted('Windows', 'x86', '64')), { platform: 'windows', architecture: 'x64', packageId: 'windows-x64' });
  assert.deepEqual(await detectPlatform(hinted('Windows', 'arm', '64')), { platform: 'windows', architecture: 'arm64', packageId: null });
  assert.deepEqual(await detectPlatform(hinted('Windows', 'x86', '32')), { platform: 'windows', architecture: 'x86', packageId: null });
});

test('does not mistake frozen desktop browser strings for an architecture', async () => {
  const safari = { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15' };
  const chrome = { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0' };
  assert.deepEqual(await detectPlatform(safari), { platform: 'macos', architecture: 'unknown', packageId: null });
  assert.deepEqual(await detectPlatform(chrome), { platform: 'windows', architecture: 'unknown', packageId: null });
  const denied = { userAgentData: { platform: 'macOS', async getHighEntropyValues() { throw new Error('Not allowed'); } } };
  assert.deepEqual(await detectPlatform(denied), { platform: 'macos', architecture: 'unknown', packageId: null });
  assert.deepEqual(await detectPlatform(hinted('Windows', 'x86', '')), { platform: 'windows', architecture: 'unknown', packageId: null });
});

test('recognizes unsupported Linux and mobile devices without recommending a desktop build', async () => {
  assert.deepEqual(await detectPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), { platform: 'linux', architecture: 'unknown', packageId: null });
  assert.deepEqual(await detectPlatform({ platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile' }), { platform: 'mobile', architecture: 'unknown', packageId: null });
  assert.deepEqual(await detectPlatform({ platform: 'MacIntel', maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)' }), { platform: 'mobile', architecture: 'unknown', packageId: null });
  assert.deepEqual(await detectPlatform({ userAgentData: { platform: 'Android', mobile: false } }), { platform: 'mobile', architecture: 'unknown', packageId: null });
});

test('names the browsers that cannot reach the helper on 127.0.0.1 from the https site', () => {
  const safari = { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' };
  const telegram = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Telegram-Mac/11.0' };
  assert.equal(loopbackBlocked(safari), true);
  assert.equal(loopbackBlocked(telegram), true);
  assert.equal(loopbackBlocked(hinted('macOS', 'arm', '64')), false);
  assert.equal(loopbackBlocked({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }), false);
  assert.equal(loopbackBlocked({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0' }), false);
  assert.equal(loopbackBlocked({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148' }), false);
  assert.equal(loopbackBlocked(undefined), false);
});
