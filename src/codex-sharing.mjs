import { boardAuthor } from './annotations.mjs';

// Teammate Codex access lives only in board presence: it ends when either person leaves the board.
export const delegateLimit = 3;
// A brief reconnect keeps access; a newly connected client waits for presence before judging absence.
export const sharingGrace = { join: 10000, leave: 10000 };

const validRequest = value => typeof value === 'string' && /^[\w-]{8,64}$/.test(value);
const validClient = value => Number.isSafeInteger(value) && value >= 0;
const requestIds = value => Array.isArray(value) ? value.filter(validRequest).slice(0, 50) : [];
const active = run => ['queued', 'running'].includes(run?.status);

export function codexRequest(state) {
  const request = state?.codexRequest;
  return request && validClient(request.to) && validRequest(request.id) ? { to: request.to, id: request.id } : null;
}
export const codexGrants = state => requestIds(state?.codexGrants);
export const codexDeclines = state => requestIds(state?.codexDeclines);

// The owner's presence must list the requester's current request; a stale or changed request grants nothing.
export function codexGranted(states, owner, requester) {
  const request = codexRequest(states.get(requester));
  return owner !== requester && request?.to === owner && codexGrants(states.get(owner)).includes(request.id);
}

export function sharingView(states, me, runs = []) {
  const local = states.get(me) || {}, person = id => boardAuthor(states.get(id)?.user) || { name: 'Teammate' };
  const peers = [...states].filter(([id, state]) => id !== me && boardAuthor(state?.user));
  const grants = codexGrants(local), declines = codexDeclines(local), names = new Set();
  const asking = peers.flatMap(([client, state]) => { const request = codexRequest(state); return request?.to === me ? [{ id: request.id, client, user: person(client) }] : []; });
  const request = codexRequest(local), owner = request && states.get(request.to);
  return {
    ready: local.codex === true,
    // One entry per person, even when they have the board open twice.
    teammates: peers.filter(([id, state]) => state.codex === true && !names.has(person(id).name) && names.add(person(id).name)).map(([id]) => ({ id, user: person(id) })),
    outgoing: request && { ...request, user: person(request.to), granted: codexGranted(states, request.to, me), available: owner?.codex === true },
    incoming: asking.filter(item => !grants.includes(item.id) && !declines.includes(item.id)),
    shared: asking.filter(item => grants.includes(item.id)).map(item => ({ ...item, active: runs.filter(run => active(run) && run.delegate?.owner === me && run.delegate.requester === item.client).length })),
  };
}

// What this client does with a queued teammate-Codex run: only the owner serves it; anyone settles it once it can never start.
export function delegateAction(run, { me, states, gone = () => false, active = 0, serving = false, writer }) {
  const route = run?.delegate;
  if (!route || run.status !== 'queued' || route.started) return null;
  if (route.owner !== me) return gone(route.owner) ? 'orphaned' : 'wait';
  if (!states.has(route.requester)) return gone(route.requester) ? 'revoked' : 'wait';
  // The last writer of an unstarted run is its requester, so nobody else can spend the owner's Codex.
  if (!codexGranted(states, me, route.requester) || (writer !== undefined && writer !== route.requester)) return 'revoked';
  return serving && active < delegateLimit ? 'serve' : 'wait';
}

export class CodexSharing {
  constructor(awareness, now = () => Date.now()) {
    Object.assign(this, { awareness, now, me: awareness.clientID, known: new Map(), liveSince: null, granted: new Set() });
    this.observe = ({ added = [], updated = [], removed = [] }) => {
      const time = this.now(), states = awareness.getStates();
      for (const id of [...added, ...updated]) if (states.get(id)) this.known.set(id, { state: states.get(id), left: null });
      for (const id of removed) { const entry = this.known.get(id); if (entry && entry.left === null) entry.left = time; }
    };
    this.observe({ added: [...awareness.getStates().keys()] });
    awareness.on('change', this.observe);
  }
  destroy() { this.awareness.off('change', this.observe); }
  live(value) { this.liveSince = value ? this.liveSince ?? this.now() : null; }
  settled() { return this.liveSince !== null && this.now() - this.liveSince >= sharingGrace.join; }
  // People present now, plus those who dropped moments ago while this client stayed connected.
  states() {
    const time = this.now(), states = new Map(this.awareness.getStates());
    for (const [id, { state, left }] of this.known) {
      if (states.has(id) || left === null) continue;
      if (this.liveSince !== null && left >= this.liveSince && time - left < sharingGrace.leave) states.set(id, state);
      else if (time - left > 10 * 60 * 1000) this.known.delete(id);
    }
    return states;
  }
  gone(id) { return this.settled() && !this.states().has(id); }
  local() { return this.awareness.getLocalState() || {}; }
  set(fields) {
    const local = this.awareness.getLocalState();
    if (!local || Object.entries(fields).every(([key, value]) => JSON.stringify(local[key] ?? null) === JSON.stringify(value ?? null))) return;
    this.awareness.setLocalState({ ...local, ...fields });
  }
  setReady(ready) { this.set({ codex: !!ready }); }
  request(owner) { if (validClient(owner) && owner !== this.me) this.set({ codexRequest: { to: owner, id: crypto.randomUUID() } }); }
  withdraw() { this.set({ codexRequest: null }); }
  allow(id) { const local = this.local(); this.set({ codexGrants: [...codexGrants(local).filter(item => item !== id), id], codexDeclines: codexDeclines(local).filter(item => item !== id) }); }
  // Declining a pending request and revoking a grant are the same signal; the requester knows which it was.
  decline(id) { const local = this.local(); this.set({ codexGrants: codexGrants(local).filter(item => item !== id), codexDeclines: [...codexDeclines(local).filter(item => item !== id), id] }); }
  view(runs) { return sharingView(this.states(), this.me, runs); }
  // The owner this client may generate through right now, if any.
  using() {
    const outgoing = this.view().outgoing;
    return outgoing?.granted && outgoing.available ? outgoing : null;
  }
  // Prunes stale grants and reports what changed for this person; call on presence changes and periodically.
  maintain() {
    if (this.liveSince === null) return [];
    const states = this.states(), events = [];
    if (this.settled()) {
      const asked = new Set([...states].flatMap(([id, state]) => { const request = codexRequest(state); return id !== this.me && request?.to === this.me ? [request.id] : []; }));
      const grants = codexGrants(this.local()), declines = codexDeclines(this.local()), keptGrants = grants.filter(id => asked.has(id)), keptDeclines = declines.filter(id => asked.has(id));
      if (keptGrants.length !== grants.length || keptDeclines.length !== declines.length) this.set({ codexGrants: keptGrants, codexDeclines: keptDeclines });
    }
    const request = codexRequest(this.local());
    if (!request) return events;
    const owner = states.get(request.to), user = boardAuthor((owner || this.known.get(request.to)?.state)?.user) || { name: 'Your teammate' };
    if (codexDeclines(owner).includes(request.id)) { events.push({ type: this.granted.has(request.id) ? 'revoked' : 'declined', user }); this.withdraw(); }
    else if (!owner && this.gone(request.to)) { events.push({ type: 'left', user }); this.withdraw(); }
    else if (codexGrants(owner).includes(request.id) && !this.granted.has(request.id)) { this.granted.add(request.id); events.push({ type: 'granted', user }); }
    return events;
  }
}

export function sharingMessage({ type, user }) {
  const name = user?.name || 'Your teammate';
  return { granted: `${name} allowed you to generate with their Codex on this board.`, declined: `${name} declined your request to use their Codex.`,
    revoked: `${name} stopped sharing their Codex with you.`, left: `${name} left the board, so their Codex is no longer available.` }[type];
}
