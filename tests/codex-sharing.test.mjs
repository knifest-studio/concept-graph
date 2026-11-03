import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { CodexSharing, codexGranted, delegateAction, delegateLimit, sharingGrace, sharingMessage } from '../src/codex-sharing.mjs';
import { CloudGeneration } from '../src/cloud-generation.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { generationReadiness } from '../src/onboarding.mjs';

const asset = '12345678-1234-1234-1234-123456789abc.png', output = '12345678-1234-1234-1234-123456789def.png';
const owner = { name: 'Olena', color: '#448bfa' }, requester = { name: 'Bohdan', color: '#e0567a' };
const startedAt = '2026-11-03T10:00:00.000Z';

// One shared presence map, as every replica sees it once updates have arrived.
class Room {
  constructor() { this.states = new Map(); this.members = new Set(); }
}
class Presence {
  constructor(room, clientID) { Object.assign(this, { room, clientID, listeners: new Set() }); room.members.add(this); }
  getStates() { return this.room.states; }
  getLocalState() { return this.room.states.get(this.clientID) ?? null; }
  setLocalState(state) {
    const had = this.room.states.has(this.clientID);
    if (state === null) this.room.states.delete(this.clientID); else this.room.states.set(this.clientID, state);
    const change = { added: !had && state ? [this.clientID] : [], updated: had && state ? [this.clientID] : [], removed: had && !state ? [this.clientID] : [] };
    for (const member of this.room.members) for (const listener of member.listeners) listener(change, this);
  }
  on(_, listener) { this.listeners.add(listener); }
  off(_, listener) { this.listeners.delete(listener); }
}

function people() {
  const room = new Room(), clock = { now: 1000 };
  const join = (id, user) => { const presence = new Presence(room, id), sharing = new CodexSharing(presence, () => clock.now); presence.setLocalState({ user }); sharing.live(true); return sharing; };
  return { room, clock, join, settle: () => { clock.now += sharingGrace.join; } };
}

test('access is requested, granted, declined and revoked through presence only', () => {
  const { join, settle } = people(), alice = join(1, owner), bob = join(2, requester);
  settle();
  alice.setReady(true);
  assert.deepEqual(bob.view().teammates, [{ id: 1, user: owner }]);
  bob.request(1);
  assert.deepEqual(alice.view().incoming.map(item => item.user.name), ['Bohdan']);
  assert.equal(bob.view().outgoing.granted, false); assert.equal(bob.using(), null);
  const { id } = alice.view().incoming[0];
  alice.allow(id);
  assert.deepEqual(bob.maintain().map(event => event.type), ['granted']); assert.deepEqual(bob.maintain(), []);
  assert.equal(bob.using().to, 1); assert.equal(alice.view().incoming.length, 0); assert.equal(alice.view().shared[0].user.name, 'Bohdan');
  assert.equal(codexGranted(alice.states(), 1, 2), true); assert.equal(codexGranted(alice.states(), 2, 1), false);
  alice.setReady(false);
  assert.equal(bob.using(), null); assert.equal(bob.view().outgoing.granted, true);
  alice.decline(id);
  assert.deepEqual(bob.maintain().map(event => event.type), ['revoked']);
  assert.equal(bob.view().outgoing, null);
  alice.maintain(); assert.deepEqual(alice.local().codexDeclines, []); assert.deepEqual(alice.local().codexGrants, []);
  bob.request(1);
  alice.decline(alice.view().incoming[0].id);
  const [declined] = bob.maintain();
  assert.equal(declined.type, 'declined'); assert.match(sharingMessage(declined), /Olena declined/);
});

test('a brief drop keeps access, leaving ends it, and a fresh connection waits before judging absence', () => {
  const { clock, join, settle } = people(), alice = join(1, owner), bob = join(2, requester);
  settle(); alice.setReady(true); bob.request(1); alice.allow(alice.view().incoming[0].id); bob.maintain();
  const state = alice.local();
  alice.awareness.setLocalState(null);
  clock.now += sharingGrace.leave - 1;
  assert.deepEqual(bob.maintain(), []); assert.equal(bob.using().to, 1);
  alice.awareness.setLocalState(state);
  clock.now += sharingGrace.leave;
  assert.deepEqual(bob.maintain(), []); assert.equal(bob.using().to, 1);
  alice.awareness.setLocalState(null);
  clock.now += sharingGrace.leave;
  const [left] = bob.maintain();
  assert.equal(left.type, 'left'); assert.equal(left.user.name, 'Olena'); assert.equal(bob.view().outgoing, null);
  // A reconnecting owner keeps grants until presence has had time to arrive, then drops the ones nobody holds.
  alice.awareness.setLocalState({ ...state, codexGrants: ['stale-request-id'] });
  alice.live(false); alice.live(true);
  alice.maintain(); assert.deepEqual(alice.local().codexGrants, ['stale-request-id']);
  settle(); alice.maintain(); assert.deepEqual(alice.local().codexGrants, []);
});

test('queued teammate runs are served only by their owner while the grant holds', () => {
  const states = new Map([[1, { user: owner, codex: true, codexGrants: ['request-1'] }], [2, { user: requester, codexRequest: { to: 1, id: 'request-1' } }]]);
  const run = { id: 'run', status: 'queued', delegate: { owner: 1, requester: 2 } }, gone = () => true;
  assert.equal(delegateAction(run, { me: 1, states, serving: true, writer: 2 }), 'serve');
  assert.equal(delegateAction(run, { me: 1, states, serving: false }), 'wait');
  assert.equal(delegateAction(run, { me: 1, states, serving: true, active: delegateLimit }), 'wait');
  assert.equal(delegateAction(run, { me: 1, states, serving: true, writer: 3 }), 'revoked');
  assert.equal(delegateAction(run, { me: 1, states: new Map([...states, [1, { user: owner, codex: true }]]), serving: true }), 'revoked');
  assert.equal(delegateAction(run, { me: 1, states: new Map([[1, states.get(1)]]), serving: true }), 'wait');
  assert.equal(delegateAction(run, { me: 1, states: new Map([[1, states.get(1)]]), gone, serving: true }), 'revoked');
  assert.equal(delegateAction(run, { me: 2, states }), 'wait');
  assert.equal(delegateAction(run, { me: 3, states: new Map([[2, states.get(2)]]), gone }), 'orphaned');
  assert.equal(delegateAction({ ...run, delegate: { ...run.delegate, started: true } }, { me: 3, states, gone }), null);
  assert.equal(delegateAction({ ...run, status: 'running' }, { me: 3, states, gone }), null);
  assert.equal(delegateAction({ ...run, delegate: undefined }, { me: 3, states, gone }), null);
});

test('readiness borrows a granted teammate Codex only when the person has none ready', () => {
  const status = { connected: true, signedIn: true, imageGeneration: true }, teammate = { to: 7, user: owner };
  const borrowed = generationReadiness({ required: true, paired: false, status: {}, teammate });
  assert.equal(borrowed.key, 'ready'); assert.equal(borrowed.delegate, 7); assert.equal(borrowed.own.key, 'helper'); assert.match(borrowed.label, /Olena’s Codex/);
  assert.equal(generationReadiness({ required: true, paired: true, status, teammate }).delegate, undefined);
  assert.equal(generationReadiness({ required: true, paired: false, status: {} }).key, 'helper');
});

function board() {
  const ownerDoc = new Y.Doc(), requesterDoc = new Y.Doc();
  const relay = (from, to) => from.on('update', (update, origin) => { if (origin !== 'relay') Y.applyUpdate(to, update, 'relay'); });
  relay(ownerDoc, requesterDoc); relay(requesterDoc, ownerDoc);
  applyLocalGraph(requesterDoc, { nodes: [{ id: 'p', type: 'text', position: { x: 80, y: 40 }, data: { text: 'A courier robot', labelOutputs: false } }, { id: 'i', type: 'image', position: { x: -310, y: 0 }, data: { asset, caption: 'Reference' } }], edges: [{ id: 'reference', source: 'i', target: 'p' }], groups: [], runs: [] }, { nodes: [], edges: [], groups: [], runs: [] }, {});
  const { room, clock, settle } = people();
  const alice = new CodexSharing(new Presence(room, ownerDoc.clientID), () => clock.now), bob = new CodexSharing(new Presence(room, requesterDoc.clientID), () => clock.now);
  alice.awareness.setLocalState({ user: owner }); bob.awareness.setLocalState({ user: requester }); alice.live(true); bob.live(true); settle();
  const helper = { jobs: [], calls: [] };
  const ownerJobs = new CloudGeneration({ doc: ownerDoc, boardId: 'board', user: owner, sharing: alice, ready: () => true, onError: () => {},
    request: async () => new Response(new Uint8Array([1, 2, 3])), api: async () => ({ asset: output }),
    helperRequest: async () => new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/png' } }),
    helperApi: async (url, options = {}) => {
      helper.calls.push([url, options.method || 'GET', options.body && JSON.parse(options.body)]);
      if (options.method === 'POST' && url === '/api/cloud-jobs') { const input = JSON.parse(options.body); helper.jobs.push({ id: input.jobId, boardId: input.boardId, nodeId: input.nodeId, startedAt, status: 'queued', outputs: [] }); return {}; }
      if (url.endsWith('/cancel')) { helper.jobs.find(job => url.includes(job.id)).status = 'cancelled'; return {}; }
      if (options.method === 'DELETE') { helper.jobs = helper.jobs.filter(job => !url.endsWith(job.id)); return {}; }
      return { jobs: structuredClone(helper.jobs) };
    } });
  ownerJobs.active = true;
  const requesterJobs = new CloudGeneration({ doc: requesterDoc, boardId: 'board', user: requester, sharing: bob, ready: () => true, onError: () => {},
    helperApi: async () => { throw new Error('The requester has no helper.'); } });
  const grant = () => { alice.setReady(true); bob.request(ownerDoc.clientID); alice.allow(alice.view().incoming[0].id); bob.maintain(); };
  const settled = () => new Promise(resolve => setTimeout(resolve, 0));
  return { ownerDoc, requesterDoc, alice, bob, clock, helper, ownerJobs, requesterJobs, grant, settled };
}

test('a teammate generates through the owner helper and the images are credited only to them', async () => {
  const { ownerDoc, requesterDoc, alice, helper, ownerJobs, requesterJobs, grant, settled } = board();
  await assert.rejects(requesterJobs.start('p', ownerDoc.clientID), /no longer available/);
  grant();
  await requesterJobs.start('p', ownerDoc.clientID);
  const [queued] = readCloudGraph(ownerDoc).runs;
  assert.deepEqual(queued.delegate, { owner: ownerDoc.clientID, requester: requesterDoc.clientID }); assert.deepEqual(queued.by, requester); assert.equal(queued.status, 'queued');
  assert.equal(alice.view([queued]).shared[0].active, 1);
  await ownerJobs.tick(); await settled();
  const posted = helper.calls.find(call => call[1] === 'POST' && call[0] === '/api/cloud-jobs')[2];
  assert.equal(posted.jobId, queued.id); assert.match(posted.prompt, /A courier robot/); assert.deepEqual(posted.images, [{ asset, data: 'AQID' }]);
  assert.equal(readCloudGraph(requesterDoc).runs[0].delegate.started, true);
  await ownerJobs.tick(); await settled();
  assert.equal(helper.calls.filter(call => call[1] === 'POST' && call[0] === '/api/cloud-jobs').length, 1);
  helper.jobs[0] = { ...helper.jobs[0], status: 'completed', finishedAt: startedAt, outputs: [{ index: 0, format: 'png' }] };
  await ownerJobs.tick();
  const graph = readCloudGraph(requesterDoc), run = graph.runs[0], image = graph.nodes.find(node => node.id === run.outputIds[0]);
  assert.equal(run.status, 'completed'); assert.deepEqual(run.by, requester); assert.deepEqual(image.data.author, requester);
  assert.equal(JSON.stringify(graph).includes(owner.name), false);
  assert.equal(helper.jobs.length, 0);
  ownerDoc.destroy(); requesterDoc.destroy();
});

test('the requester cancels on the board and the owner helper stops the job', async () => {
  const { ownerDoc, requesterDoc, helper, ownerJobs, requesterJobs, grant, settled } = board();
  grant(); await requesterJobs.start('p', ownerDoc.clientID);
  await ownerJobs.tick(); await settled();
  const id = readCloudGraph(requesterDoc).runs[0].id;
  assert.equal(requesterJobs.delegated(id), true);
  await requesterJobs.cancel(id);
  assert.equal(readCloudGraph(ownerDoc).runs[0].status, 'cancelled');
  await ownerJobs.tick();
  assert.ok(helper.calls.some(call => call[0] === `/api/cloud-jobs/${id}/cancel`)); assert.equal(helper.jobs[0].status, 'cancelled');
  await ownerJobs.tick();
  assert.equal(helper.jobs.length, 0); assert.equal(readCloudGraph(ownerDoc).runs[0].status, 'cancelled'); assert.equal(readCloudGraph(ownerDoc).nodes.length, 2);
  ownerDoc.destroy(); requesterDoc.destroy();
});

test('revoked access and a departed owner fail runs that had not started', async () => {
  const revoked = board();
  revoked.grant(); await revoked.requesterJobs.start('p', revoked.ownerDoc.clientID);
  revoked.alice.decline(revoked.alice.local().codexGrants[0]);
  revoked.ownerJobs.maintain();
  const [run] = readCloudGraph(revoked.requesterDoc).runs;
  assert.equal(run.status, 'failed'); assert.match(run.error, /Access to the teammate’s Codex ended/);
  await revoked.ownerJobs.tick(); assert.equal(revoked.helper.calls.some(call => call[1] === 'POST' && call[0] === '/api/cloud-jobs'), false);
  revoked.ownerDoc.destroy(); revoked.requesterDoc.destroy();

  const left = board();
  left.grant(); await left.requesterJobs.start('p', left.ownerDoc.clientID);
  left.alice.awareness.setLocalState(null);
  left.requesterJobs.maintain(); assert.equal(readCloudGraph(left.requesterDoc).runs[0].status, 'queued');
  left.clock.now += sharingGrace.leave;
  left.requesterJobs.maintain();
  assert.match(readCloudGraph(left.requesterDoc).runs[0].error, /left the board before this generation started/);
  assert.deepEqual(left.bob.maintain().map(event => event.type), ['left']);
  left.ownerDoc.destroy(); left.requesterDoc.destroy();
});

test('an owner serves at most a few teammate runs at once and ignores runs written by someone else', async () => {
  const { ownerDoc, requesterDoc, helper, ownerJobs, grant, settled } = board();
  grant();
  const runs = Array.from({ length: delegateLimit + 1 }, (_, index) => ({ id: `0000000${index}-0000-4000-8000-000000000000`, nodeId: 'p', status: 'queued', by: requester, startedAt, createdAt: `2026-11-03T10:00:0${index}.000Z`, delegate: { owner: ownerDoc.clientID, requester: requesterDoc.clientID } }));
  requesterDoc.transact(() => runs.forEach(run => requesterDoc.getMap('runs').set(run.id, run)));
  await ownerJobs.tick(); await settled();
  assert.equal(helper.jobs.length, delegateLimit);
  const forged = { ...runs[0], id: '99999999-0000-4000-8000-000000000000', createdAt: startedAt };
  ownerDoc.getMap('runs').set(forged.id, forged);
  ownerJobs.maintain();
  assert.equal(ownerDoc.getMap('runs').get(forged.id).status, 'failed');
  ownerDoc.destroy(); requesterDoc.destroy();
});
