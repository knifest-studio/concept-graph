import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudVoice, voiceReconnectWindow } from '../src/cloud-voice.mjs';

function setup({ api, media, admission = 'joined' } = {}) {
  let client, state;
  const sent = [], sounds = [], tracks = [], peers = [], states = new Map([[1, { user: { name: 'Me' } }]]);
  const provider = { wsconnected: true,
    awareness: { getStates: () => states, getLocalState: () => states.get(1), setLocalStateField: (key, value) => { states.get(1)[key] = value; client.refresh(); } },
    sendMessage(message) {
      const value = JSON.parse(message); sent.push(value);
      if (value.type === 'voice-join' && admission !== 'silent') queueMicrotask(() => client.receive(admission === 'joined' ? { type: 'voice-joined', clientId: 1, key: value.key } : { type: 'voice-failed', key: value.key, reason: 'Voice is full (8 people). Try again when someone leaves.' }));
    },
  };
  client = cloudVoice({ provider, id: 1, boardId: 'board', api: api || (async () => ({ iceServers: [] })), view: value => { state = value; }, sound: kind => sounds.push(kind),
    browser: { media: media || (async () => { const track = { enabled: true, stop() { this.stopped = true; } }; tracks.push(track); return { getTracks: () => [track], getAudioTracks: () => [track] }; }),
      peer: () => { const peer = { connectionState: 'connected', restarts: 0, restartIce() { this.restarts++; }, addTrack() {}, close() { this.closed = true; } }; peers.push(peer); return peer; }, audio: () => { throw new Error('No meter'); } } });
  return { client, provider, sent, sounds, tracks, peers, states, state: () => state, admission: value => { admission = value; } };
}
const teammate = () => ({ user: { name: 'Other' }, voice: { muted: false, speaking: false } });

test('short websocket drops retain the mic, mute state and peers and automatically re-admit before signalling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = setup(), { client, provider, states } = env;
  client.connected(true); await client.join();
  states.set(2, teammate()); client.refresh();
  const pc = env.peers[0], stream = { audio: true };
  pc.ontrack({ streams: [stream] }); client.mesh.mute();
  provider.wsconnected = false;
  states.delete(2); client.refresh(); // YProvider removes awareness before its status event.
  client.connected(false);
  assert.equal(env.tracks[0].stopped, undefined); assert.equal(pc.closed, undefined); assert.equal(env.state().joined, true);
  assert.equal(env.state().streams[0][1], stream); assert.equal(env.state().reconnecting, true); assert.equal(states.get(1).voice.muted, true);
  const before = env.sent.length;
  client.mesh.send({ to: 2, data: { candidate: 'gathered while offline' } });
  assert.equal(env.sent.length, before);
  t.mock.timers.tick(5000); provider.wsconnected = true;
  await client.connected(true);
  const resumed = env.sent.slice(before);
  assert.equal(resumed[0].type, 'voice-join'); assert.equal(resumed[1].type, 'voice-signal');
  assert.equal(env.tracks.length, 1); assert.equal(env.peers[0], pc); assert.equal(pc.closed, undefined);
  assert.equal(env.state().reconnecting, false); assert.equal(env.state().muted, true);
  states.set(2, teammate()); client.refresh();
  t.mock.timers.tick(voiceReconnectWindow); assert.equal(pc.closed, undefined); assert.equal(env.state().joined, true);
  client.leave(); assert.equal(env.tracks[0].stopped, true); assert.equal(pc.closed, true);
});

test('remote socket departure has a grace period while an explicit voice leave closes its peer immediately', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = setup(); env.client.connected(true); await env.client.join();
  env.states.set(2, teammate()); env.client.refresh();
  const first = env.peers[0]; env.states.delete(2); env.client.refresh();
  t.mock.timers.tick(19000); assert.equal(first.closed, undefined);
  env.states.set(2, teammate()); env.client.refresh();
  t.mock.timers.tick(2000); assert.equal(first.closed, undefined);
  env.states.get(2).voice = null; env.client.refresh(); assert.equal(first.closed, true);
  env.states.set(2, teammate()); env.client.refresh();
  const second = env.peers[1]; env.states.delete(2); env.client.refresh();
  t.mock.timers.tick(voiceReconnectWindow); assert.equal(second.closed, true);
  env.client.leave();
});

test('a prolonged drop releases media after twenty seconds without resetting the deadline on retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = setup(); env.client.connected(true); await env.client.join();
  env.provider.wsconnected = false; env.client.connected(false);
  t.mock.timers.tick(19000); env.client.connected(false);
  assert.equal(env.tracks[0].stopped, undefined);
  t.mock.timers.tick(1000); assert.equal(env.tracks[0].stopped, true); assert.equal(env.state().joined, false); assert.match(env.state().error, /Voice disconnected/);
  env.provider.wsconnected = true; await env.client.connected(true); assert.equal(env.state().joined, false);
});

test('failed re-admission gives up with the existing disconnect message and releases media', async () => {
  const env = setup(); env.client.connected(true); await env.client.join();
  env.provider.wsconnected = false; env.client.connected(false); env.admission('full');
  env.provider.wsconnected = true; await env.client.connected(true);
  assert.equal(env.tracks[0].stopped, true); assert.equal(env.state().joined, false); assert.match(env.state().error, /Voice disconnected/);
});

test('recovery restarts failed ICE on the existing peer after admission succeeds', async () => {
  const env = setup(); env.client.connected(true); await env.client.join();
  env.states.set(2, teammate()); env.client.refresh(); const pc = env.peers[0];
  env.provider.wsconnected = false; env.client.connected(false); pc.connectionState = 'failed';
  env.provider.wsconnected = true; await env.client.connected(true);
  assert.equal(pc.restarts, 1); assert.equal(pc.closed, undefined); assert.equal(env.tracks.length, 1);
  env.client.leave();
});

test('a second drop during admission ignores the cancelled request and retries on the next connection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = setup(); env.client.connected(true); await env.client.join();
  env.provider.wsconnected = false; env.client.connected(false); env.admission('silent');
  env.provider.wsconnected = true; const first = env.client.connected(true), old = env.sent.at(-1);
  env.provider.wsconnected = false; env.client.connected(false); await first;
  env.provider.wsconnected = true; const second = env.client.connected(true), current = env.sent.at(-1);
  env.client.receive({ type: 'voice-joined', clientId: 1, key: old.key });
  assert.equal(env.state().reconnecting, true); assert.equal(env.tracks[0].stopped, undefined);
  env.client.receive({ type: 'voice-joined', clientId: 1, key: current.key }); await second;
  assert.equal(env.state().reconnecting, false); assert.equal(env.state().joined, true);
  env.client.leave();
});

test('re-admission timeout and explicit leave cancel recovery without resurrecting media on a late ack', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = setup(); env.client.connected(true); await env.client.join();
  env.provider.wsconnected = false; env.client.connected(false); env.admission('silent');
  env.provider.wsconnected = true; const resuming = env.client.connected(true);
  t.mock.timers.tick(8000); await resuming;
  assert.equal(env.tracks[0].stopped, true); assert.match(env.state().error, /Voice disconnected/);
  env.admission('joined'); await env.client.join();
  env.provider.wsconnected = false; env.client.connected(false); env.admission('silent');
  env.provider.wsconnected = true; const cancelled = env.client.connected(true), request = env.sent.at(-1);
  env.client.leave(); env.client.receive({ type: 'voice-joined', clientId: 1, key: request.key }); await cancelled;
  assert.equal(env.state().joined, false); assert.equal(env.tracks[1].stopped, true); assert.equal(env.state().error, '');
});

test('a room refusal releases the acquired microphone and shows the reason', async () => {
  const env = setup({ admission: 'full' }); env.client.connected(true); await env.client.join();
  assert.equal(env.state().joined, false); assert.equal(env.tracks[0].stopped, true); assert.match(env.state().error, /full/);
});

test('leaving during a credential request prevents late microphone acquisition', async () => {
  let finish; const env = setup({ api: () => new Promise(resolve => { finish = resolve; }) });
  env.client.connected(true); const joining = env.client.join(); env.client.leave(); finish({ iceServers: [] }); await joining;
  assert.equal(env.tracks.length, 0); assert.equal(env.state().busy, false); assert.equal(env.state().joined, false);
});
