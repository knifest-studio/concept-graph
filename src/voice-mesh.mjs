import { voiceHasSpace } from '../cloud/voice.mjs';

export const micError = error => error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'Microphone access was denied. Allow it in your browser and try again.'
  : error?.name === 'NotFoundError' ? 'No microphone found. Connect one and try again.' : 'Could not open the microphone. Check that it is available.';

// MDN perfect negotiation: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation
// Browser objects are created only on join, and injectable for port-free tests.
export class VoiceMesh {
  constructor({ id, send, admit, release, publish, changed = () => {}, remote = () => {}, error = () => {},
    media = constraints => navigator.mediaDevices.getUserMedia(constraints), peer = config => new RTCPeerConnection(config),
    audio = () => new (globalThis.AudioContext || globalThis.webkitAudioContext)(), clock = () => Date.now(),
    // Wrapped: these are called as methods of the mesh, and the browser's own timers refuse any other `this`.
    interval = (run, ms) => setInterval(run, ms), clearInterval: clear = id => clearInterval(id), timeout = (run, ms) => setTimeout(run, ms), clearTimeout: cancel = id => clearTimeout(id) }) {
    Object.assign(this, { id, send, admit, release, publish, changed, remote, error, media, createPeer: peer, audio, clock, interval, clear, timeout, cancel });
    this.peers = new Map(); this.members = new Set(); this.epoch = 0; this.joined = false; this.joining = false; this.muted = false; this.speaking = false;
  }
  async join(iceServers, ids = []) {
    if (this.joined || this.joining) return;
    if (!voiceHasSpace(ids, this.id)) throw new Error('Voice is full (8 people). Try again when someone leaves.');
    const epoch = ++this.epoch;
    this.joining = true; this.changed();
    try {
      let stream;
      try { stream = await this.media({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
      catch (cause) { throw new Error(micError(cause)); }
      if (epoch !== this.epoch) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      await this.admit();
      if (epoch !== this.epoch) return;
      this.iceServers = iceServers; this.joined = true; this.muted = false; this.speaking = false;
      for (const track of this.stream.getTracks()) track.onended = () => { this.leave(); this.error('The microphone disconnected. Join voice again.'); };
      this.updateMembers(ids); this.publishVoice(); this.detect();
    } catch (cause) { if (epoch === this.epoch) this.leave(); throw cause; }
    finally { if (epoch === this.epoch) { this.joining = false; this.changed(); } }
  }
  publishVoice() { this.publish(this.joined ? { muted: this.muted, speaking: this.speaking } : null); this.changed(); }
  mute() { this.muted = !this.muted; this.speaking = false; this.stream?.getAudioTracks().forEach(track => { track.enabled = !this.muted; }); this.publishVoice(); }
  detect() {
    try {
      this.context = this.audio(); Promise.resolve(this.context.resume()).catch(() => {});
      this.source = this.context.createMediaStreamSource(this.stream); this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 512; this.source.connect(this.analyser);
      const samples = new Float32Array(this.analyser.fftSize); let loudAt = -Infinity;
      this.meter = this.interval(() => {
        this.analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length), now = this.clock();
        if (!this.muted && rms > .025) loudAt = now;
        const speaking = !this.muted && now - loudAt < 350;
        if (speaking !== this.speaking) { this.speaking = speaking; this.publishVoice(); }
      }, 100);
    } catch { /* Voice works without a level meter on browsers that lack Web Audio. */ }
  }
  updateMembers(ids) {
    this.members = new Set(ids.filter(id => id !== this.id));
    if (!this.joined) return;
    // All clients use the same admission limit; a malformed awareness state cannot create an unbounded mesh.
    for (const id of this.peers.keys()) if (!this.members.has(id)) this.remove(id);
    for (const id of [...this.members].sort((a, b) => a - b).slice(0, 7)) this.ensure(id);
  }
  ensure(id) {
    if (this.peers.has(id)) return this.peers.get(id);
    const pc = this.createPeer({ iceServers: this.iceServers }), state = { pc, makingOffer: false, ignoreOffer: false, answering: false, candidates: [], queue: Promise.resolve(), restarts: 0, timer: 0, wait: 0, offers: this.id < id };
    this.peers.set(id, state);
    const live = () => this.joined && this.peers.get(id) === state;
    const send = data => { if (live()) this.send({ to: id, data }); };
    pc.onicecandidate = ({ candidate }) => { if (candidate) send({ candidate: candidate.toJSON?.() || candidate }); };
    // Both sides add their microphone at once, so both would offer. Chrome gathers no ICE candidates after rolling its own
    // offer back, which left about half of all calls silent: the side with the lower ID makes the first offer and the other
    // waits for it, offering itself only if none arrives. Later renegotiation (an ICE restart) is perfect negotiation.
    pc.onnegotiationneeded = async () => {
      if (!live() || (!state.offers && !pc.remoteDescription)) return;
      try { state.makingOffer = true; await pc.setLocalDescription(); send({ description: pc.localDescription }); }
      catch { if (live()) this.error('Could not connect voice to a teammate.'); }
      finally { state.makingOffer = false; }
    };
    pc.ontrack = ({ streams }) => { if (live() && streams[0]) this.remote(id, streams[0]); };
    const restart = () => {
      if (!live()) return;
      if (state.restarts++ < 3) pc.restartIce();
      else this.error('Voice connection failed. Leave and join again.');
    };
    pc.onconnectionstatechange = () => {
      this.cancel(state.timer);
      if (pc.connectionState === 'failed') restart();
      else if (pc.connectionState === 'disconnected') state.timer = this.timeout(restart, 4000);
      else if (pc.connectionState === 'connected') state.restarts = 0;
    };
    for (const track of this.stream.getAudioTracks()) pc.addTrack(track, this.stream);
    if (!state.offers) state.wait = this.timeout(() => { if (live() && !pc.remoteDescription) { state.offers = true; pc.onnegotiationneeded(); } }, 5000);
    return state;
  }
  receive({ from, data }) {
    if (!this.joined || from === this.id || !Number.isSafeInteger(from) || !data) return Promise.resolve();
    // The room relays only admitted participants; a signal may beat their awareness update.
    if (!this.peers.has(from) && this.peers.size >= 7) return Promise.resolve();
    const state = this.ensure(from), pc = state.pc;
    state.queue = state.queue.then(async () => {
      if (this.peers.get(from) !== state) return;
      const { description, candidate } = data;
      if (description) {
        if (!['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string') return;
        const ready = !state.makingOffer && (pc.signalingState === 'stable' || state.answering);
        state.ignoreOffer = this.id < from && description.type === 'offer' && !ready;
        if (state.ignoreOffer) { state.candidates = []; return; }
        state.answering = description.type === 'answer';
        try { await pc.setRemoteDescription(description); } finally { state.answering = false; }
        for (const ice of state.candidates.splice(0)) await pc.addIceCandidate(ice);
        if (description.type === 'offer') { await pc.setLocalDescription(); if (this.peers.get(from) === state) this.send({ to: from, data: { description: pc.localDescription } }); }
      } else if (candidate && !state.ignoreOffer) {
        if (!pc.remoteDescription) { if (state.candidates.length < 100) state.candidates.push(candidate); }
        else await pc.addIceCandidate(candidate);
      }
    }).catch(() => { if (this.peers.get(from) === state) this.error('Could not connect voice to a teammate.'); });
    return state.queue;
  }
  remove(id) {
    const state = this.peers.get(id); if (!state) return;
    this.peers.delete(id); this.cancel(state.timer); this.cancel(state.wait);
    state.pc.onicecandidate = state.pc.onnegotiationneeded = state.pc.onconnectionstatechange = state.pc.ontrack = null;
    state.pc.close(); this.remote(id, null);
  }
  leave() {
    this.epoch++; this.joining = false; this.joined = false; this.muted = false; this.speaking = false;
    this.clear(this.meter); this.source?.disconnect(); this.analyser?.disconnect(); Promise.resolve(this.context?.close()).catch(() => {});
    this.source = this.analyser = this.context = null;
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); this.stream = null;
    for (const id of this.peers.keys()) this.remove(id);
    this.release(); this.publishVoice();
  }
}
