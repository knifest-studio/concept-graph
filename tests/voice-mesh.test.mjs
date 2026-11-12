import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceMesh, micError } from '../src/voice-mesh.mjs';
import { browserIceServers, maxSignalBytes, voiceHasSpace, voiceIce, voiceSignal } from '../cloud/voice.mjs';

class Peer {
  signalingState = 'stable'; connectionState = 'new'; descriptions = []; candidates = []; tracks = []; restarts = 0;
  async setLocalDescription() { this.localDescription = { type: this.signalingState === 'have-remote-offer' ? 'answer' : 'offer', sdp: 'local' }; this.signalingState = this.localDescription.type === 'offer' ? 'have-local-offer' : 'stable'; }
  async setRemoteDescription(description) { this.descriptions.push(description); this.remoteDescription = description; this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'; }
  async addIceCandidate(candidate) { this.candidates.push(candidate); }
  addTrack(track) { this.tracks.push(track); }
  restartIce() { this.restarts++; }
  close() { this.closed = true; }
}
function setup(id = 1, extra = {}) {
  const track = { enabled: true, stop() { this.stopped = true; } }, stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const sent = [], published = [], remotes = [], errors = [], peers = [], timers = [], intervals = []; let released = 0;
  const analyser = { fftSize: 512, loud: false, getFloatTimeDomainData(samples) { samples.fill(this.loud ? .1 : 0); }, disconnect() {} };
  const context = { resume: async () => {}, createMediaStreamSource: () => ({ connect() {}, disconnect() {} }), createAnalyser: () => analyser, close: async () => { context.closed = true; } };
  const mesh = new VoiceMesh({ id, send: value => sent.push(value), admit: async () => {}, release: () => released++, publish: value => published.push(value), remote: (...value) => remotes.push(value), error: value => errors.push(value),
    media: async constraints => { assert.equal(constraints.audio.echoCancellation, true); return stream; }, peer: () => { const pc = new Peer(); peers.push(pc); return pc; }, audio: () => context,
    interval: callback => { intervals.push(callback); return callback; }, clearInterval() {}, timeout: (callback, ms) => { callback.delay = ms; timers.push(callback); return callback; }, clearTimeout() {}, ...extra });
  return { mesh, track, stream, sent, published, remotes, errors, peers, analyser, context, timers, intervals, released: () => released };
}
test('join limits, mic permissions, mute and leave own the complete media lifecycle', async () => {
  const env = setup(), { mesh, track, context } = env;
  await assert.rejects(mesh.join([], [2, 3, 4, 5, 6, 7, 8, 9]), /full/);
  await mesh.join([], [2]); assert.equal(mesh.joined, true); assert.equal(env.peers.length, 1);
  mesh.mute(); assert.equal(track.enabled, false); assert.equal(env.published.at(-1).muted, true);
  mesh.mute(); assert.equal(track.enabled, true);
  mesh.leave(); assert.equal(track.stopped, true); assert.equal(context.closed, true); assert.equal(mesh.peers.size, 0); assert.equal(env.published.at(-1), null); assert.equal(env.peers[0].closed, true);
  const denied = setup(1, { media: async () => { throw { name: 'NotAllowedError' }; } });
  await assert.rejects(denied.mesh.join([]), /denied/); assert.equal(denied.mesh.joined, false);
  assert.match(micError({ name: 'NotFoundError' }), /No microphone/);
});
test('cancelled permission requests stop their own late stream without stopping a newer join', async () => {
  let resolve;
  const env = setup(1, { media: () => new Promise(done => { resolve = done; }) }), { mesh } = env;
  const old = mesh.join([]); mesh.leave();
  mesh.media = async () => env.stream; await mesh.join([]);
  let stopped = false; resolve({ getTracks: () => [{ stop: () => { stopped = true; } }] }); await old;
  assert.equal(stopped, true); assert.equal(env.track.stopped, undefined); assert.equal(mesh.joined, true); mesh.leave();
});
test('perfect negotiation still handles glare during renegotiation after the initial connection', async () => {
  for (const id of [1, 3]) {
    const env = setup(id); await env.mesh.join([], [2]); const pc = env.peers[0];
    pc.remoteDescription = { type: 'answer', sdp: 'previous connection' };
    await pc.onnegotiationneeded(); assert.equal(pc.localDescription.type, 'offer');
    await env.mesh.receive({ from: 2, data: { description: { type: 'offer', sdp: 'collision' } } });
    assert.equal(pc.descriptions.length, id === 1 ? 0 : 1);
    if (id === 3) assert.equal(env.sent.at(-1).data.description.type, 'answer');
    await env.mesh.receive({ from: 2, data: { candidate: { candidate: 'ice' } } });
    assert.equal(pc.candidates.length, id === 1 ? 0 : 1); env.mesh.leave();
  }
});

test('the higher-ID side waits for an offer and answers with its microphone track', async () => {
  const env = setup(3); await env.mesh.join([], [2]); const pc = env.peers[0];
  assert.equal(env.mesh.peers.get(2).offers, false);
  await pc.onnegotiationneeded();
  assert.equal(pc.localDescription, undefined); assert.equal(env.sent.length, 0);
  assert.deepEqual(pc.tracks, [env.track]);
  await env.mesh.receive({ from: 2, data: { description: { type: 'offer', sdp: 'first offer' } } });
  assert.equal(env.sent.at(-1).data.description.type, 'answer');
  assert.deepEqual(pc.tracks, [env.track]);
  const sent = env.sent.length;
  env.timers.find(timer => timer.delay === 5000)(); await Promise.resolve();
  assert.equal(env.sent.length, sent);
  env.mesh.leave();
});

test('the higher-ID side offers after the five-second fallback if no offer arrived', async () => {
  const env = setup(3); await env.mesh.join([], [2]); const pc = env.peers[0];
  await pc.onnegotiationneeded(); assert.equal(env.sent.length, 0);
  const fallback = env.timers.find(timer => timer.delay === 5000); assert.ok(fallback);
  fallback(); await Promise.resolve();
  assert.equal(env.mesh.peers.get(2).offers, true);
  assert.equal(env.sent.at(-1).data.description.type, 'offer');
  env.mesh.leave();
});

test('default timer wrappers accept mesh method calls on receiver-sensitive browser APIs', async t => {
  const originals = {}, calls = [];
  for (const name of ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']) {
    originals[name] = globalThis[name];
    globalThis[name] = function (...args) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      calls.push({ name, args });
      return calls.length;
    };
  }
  t.after(() => Object.assign(globalThis, originals));
  const defaults = { interval: undefined, clearInterval: undefined, timeout: undefined, clearTimeout: undefined };
  const env = setup(3, defaults); await env.mesh.join([], [2]);
  const pc = env.peers[0]; pc.connectionState = 'disconnected'; pc.onconnectionstatechange(); env.mesh.leave();
  for (const name of Object.keys(originals)) assert.ok(calls.some(call => call.name === name), name);
  const denied = setup(1, { ...defaults, media: async () => { throw { name: 'NotAllowedError' }; } });
  await assert.rejects(denied.mesh.join([]), /Microphone access was denied/);
});
test('early candidates queue, peers leave cleanly, failures restart ICE, no signal after leave', async () => {
  const env = setup(); await env.mesh.join([], [2]); const pc = env.peers[0];
  await env.mesh.receive({ from: 2, data: { candidate: { candidate: 'early' } } }); assert.equal(pc.candidates.length, 0);
  await env.mesh.receive({ from: 2, data: { description: { type: 'offer', sdp: 'remote' } } }); assert.equal(pc.candidates.length, 1);
  pc.connectionState = 'failed'; pc.onconnectionstatechange(); assert.equal(pc.restarts, 1);
  pc.connectionState = 'disconnected'; pc.onconnectionstatechange(); env.timers.at(-1)(); assert.equal(pc.restarts, 2);
  pc.ontrack({ streams: [env.stream] }); assert.equal(env.remotes.at(-1)[1], env.stream);
  env.mesh.updateMembers([]); assert.equal(pc.closed, true); assert.equal(env.remotes.at(-1)[1], null);
  env.mesh.leave(); const count = env.sent.length; await env.mesh.receive({ from: 2, data: { description: { type: 'offer', sdp: 'late' } } }); assert.equal(env.sent.length, count);
});
test('speaking flips only with threshold and hold time, never on each sample', async () => {
  let now = 0; const env = setup(1, { clock: () => now }); await env.mesh.join([]);
  const meter = env.intervals[0], count = env.published.length;
  env.analyser.loud = true; meter(); meter(); assert.equal(env.published.length, count + 1); assert.equal(env.published.at(-1).speaking, true);
  env.analyser.loud = false; now = 300; meter(); assert.equal(env.published.at(-1).speaking, true);
  now = 400; meter(); assert.equal(env.published.at(-1).speaking, false); env.mesh.leave();
});
test('voice admission and signalling caps and TURN credentials are bounded', async () => {
  assert.equal(voiceHasSpace([1, 2, 3, 4, 5, 6, 7, 8], 1), true); assert.equal(voiceHasSpace([1, 2, 3, 4, 5, 6, 7, 8], 9), false);
  assert.equal(voiceSignal({ to: 1, data: { candidate: 'ok' } }), true); assert.equal(voiceSignal({ to: '1', data: {} }), false);
  assert.equal(voiceSignal({ to: 1, data: { sdp: 'x'.repeat(maxSignalBytes) } }), false);
  assert.deepEqual(browserIceServers([{ urls: ['turn:x:53?transport=udp', 'turns:x:443?transport=tcp'], username: 'u', credential: 'c' }, { urls: 'turn:x:53' }]), [{ urls: ['turns:x:443?transport=tcp'], username: 'u', credential: 'c' }]);
  assert.deepEqual((await voiceIce({})).iceServers, [{ urls: 'stun:stun.cloudflare.com:3478' }]);
  const result = await voiceIce({ TURN_KEY_ID: 'key', TURN_KEY_API_TOKEN: 'secret' }, async (url, init) => {
    assert.match(url, /keys\/key\/credentials\/generate-ice-servers$/); assert.equal(init.headers.Authorization, 'Bearer secret'); assert.deepEqual(JSON.parse(init.body), { ttl: 86400 });
    return Response.json({ iceServers: [{ urls: ['turn:x:53', 'turn:x:3478'], username: 'u', credential: 'c' }] }, { status: 201 });
  });
  assert.deepEqual(result.iceServers[0].urls, ['turn:x:3478']);
  await assert.rejects(voiceIce({ TURN_KEY_ID: 'key', TURN_KEY_API_TOKEN: 'secret' }, async () => new Response('', { status: 500 })), /unavailable/);
});
