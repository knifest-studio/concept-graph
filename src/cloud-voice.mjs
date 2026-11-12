import { VoiceMesh } from './voice-mesh.mjs';

export const voiceReconnectWindow = 20000;
const disconnected = 'Voice disconnected. Join again when the board reconnects.';

export function cloudVoice({ provider, id, api, boardId, view, sound, browser = {} }) {
  let online = false, fetching = false, recovering = false, resuming = false, dropTimer = null;
  let error = '', pending = null, epoch = 0, previous = new Set(), lastKey = '', lastStreams = [];
  const later = browser.timeout || ((run, ms) => setTimeout(run, ms));
  const cancel = browser.clearTimeout || (timer => clearTimeout(timer));
  const streams = new Map(), departures = new Map(), signals = [];
  const wire = value => { if (provider.wsconnected) provider.sendMessage(JSON.stringify(value)); };

  function refresh() {
    const states = provider.awareness.getStates();
    const people = [...states].filter(([, state]) => state.user && state.voice).map(([id, state]) => ({ id, user: state.user, voice: state.voice }));
    const ids = new Set(people.map(person => person.id).filter(peer => peer !== id));
    // The provider removes remote awareness before emitting its disconnected status. Audio can still be connected.
    if (online && provider.wsconnected && !recovering) {
      if (mesh.joined) {
        if ([...ids].some(peer => !previous.has(peer))) sound('voice-join');
        if ([...previous].some(peer => !ids.has(peer))) sound('voice-leave');
      }
      previous = ids;
      const members = new Set(ids);
      for (const peer of mesh.peers.keys()) {
        if (ids.has(peer) || states.has(peer)) {
          cancel(departures.get(peer));
          departures.delete(peer);
        } else {
          // A missing socket may return with the same presence ID. An explicit voice:null leaves immediately.
          if (!departures.has(peer)) departures.set(peer, later(() => {
            departures.delete(peer);
            mesh.remove(peer);
            refresh();
          }, voiceReconnectWindow));
          members.add(peer);
        }
      }
      // Active admitted participants take priority over a departed peer's grace period.
      for (const peer of departures.keys()) {
        if (members.size <= 7) break;
        cancel(departures.get(peer));
        departures.delete(peer);
        members.delete(peer);
      }
      if (members.size !== mesh.members.size || [...members].some(peer => !mesh.members.has(peer))) mesh.updateMembers([...members]);
    }
    const state = { online, busy: fetching || mesh.joining || recovering, reconnecting: recovering, joined: mesh.joined, muted: mesh.muted, speaking: mesh.speaking, people, error };
    const key = JSON.stringify(state), audio = [...streams];
    if (key === lastKey && audio.length === lastStreams.length && audio.every(([id, stream], index) => lastStreams[index][0] === id && lastStreams[index][1] === stream)) return;
    lastKey = key;
    lastStreams = audio;
    view({ ...state, streams: audio });
  }

  function admit() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomUUID();
      const timer = later(() => { pending = null; reject(new Error('Voice is still connecting. Try again.')); }, 8000);
      pending = {
        key,
        resolve: () => { cancel(timer); pending = null; resolve(); },
        reject: reason => { cancel(timer); pending = null; reject(new Error(reason)); },
      };
      wire({ type: 'voice-join', clientId: id, key });
    });
  }

  const mesh = new VoiceMesh({ ...browser, id, admit,
    send: data => {
      if (online && provider.wsconnected && !recovering) wire({ type: 'voice-signal', ...data });
      else if (signals.length < 256) signals.push(data);
    },
    release: () => { pending?.reject('Voice join cancelled.'); wire({ type: 'voice-leave' }); },
    publish: voice => { if (provider.awareness.getLocalState()) provider.awareness.setLocalStateField('voice', voice); },
    changed: refresh,
    remote: (id, stream) => { if (stream) streams.set(id, stream); else streams.delete(id); refresh(); },
    error: reason => { error = reason; refresh(); },
  });

  function leave() {
    epoch++;
    fetching = recovering = resuming = false;
    error = '';
    cancel(dropTimer);
    dropTimer = null;
    for (const timer of departures.values()) cancel(timer);
    departures.clear();
    signals.length = 0;
    mesh.leave();
  }
  function giveUp() { leave(); error = disconnected; refresh(); }
  async function resume() {
    if (resuming) return;
    const request = epoch;
    resuming = true;
    try {
      await admit();
      if (request !== epoch || !online) return;
      recovering = false;
      error = '';
      cancel(dropTimer);
      dropTimer = null;
      for (const data of signals.splice(0)) if (mesh.peers.has(data.to)) wire({ type: 'voice-signal', ...data });
      mesh.publishVoice();
      for (const { pc } of mesh.peers.values()) if (['failed', 'disconnected'].includes(pc.connectionState)) pc.restartIce();
    } catch {
      if (request === epoch && online) giveUp();
    } finally {
      if (request === epoch) { resuming = false; refresh(); }
    }
  }

  return {
    mesh, refresh, leave,
    async join() {
      if (!online || fetching || mesh.joined || mesh.joining) return;
      const request = ++epoch;
      fetching = true;
      error = '';
      refresh();
      try {
        const { iceServers } = await api(`/api/boards/${boardId}/voice/ice`, { method: 'POST' });
        if (request !== epoch) return;
        fetching = false;
        await mesh.join(iceServers, [...previous]);
      } catch (cause) { if (request === epoch) error = cause.message; }
      finally { if (request === epoch) { fetching = false; refresh(); } }
    },
    connected(value) {
      online = value;
      if (!value && mesh.joined) {
        epoch++;
        recovering = true;
        resuming = false;
        pending?.reject('Voice join cancelled.');
        if (dropTimer === null) dropTimer = later(giveUp, voiceReconnectWindow);
      } else if (!value && (mesh.joining || fetching)) giveUp();
      refresh();
      if (value && recovering && mesh.joined) return resume();
    },
    receive(value) {
      if (value.type === 'voice-joined' && value.clientId === id && value.key === pending?.key) pending?.resolve();
      else if (value.type === 'voice-failed' && value.key === pending?.key) pending?.reject(value.reason);
      else if (value.type === 'voice-signal') mesh.receive(value);
    },
  };
}
