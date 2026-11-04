import { getState } from 'yjs';
import { collectInputs, generationSettings, generators, imageSize } from '../graph.mjs';
import { applyLocalGraph, CloudGraphReader } from './cloud-sync.mjs';
import { boardAuthor } from './annotations.mjs';
import { delegateAction } from './codex-sharing.mjs';
import { placeRunOutput, runOutputId, runSummary, terminalRun as terminal } from './run-outputs.mjs';

const timestamp = () => new Date().toISOString();
// The helper reports the settings it used; older helpers do not, so the submitted defaults stay.
const jobSettings = job => ({ ...(typeof job.model === 'string' && /^[\w.\/:+-]{1,128}$/.test(job.model) ? { model: job.model } : {}),
  ...(typeof job.effort === 'string' && /^[a-z0-9_-]{1,32}$/.test(job.effort) ? { effort: job.effort } : {}) });

async function base64(response) {
  if (!response.ok) throw new Error('Could not load a reference image.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 30 * 1024 * 1024) throw new Error('Reference images must be at most 30 MB.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

export class CloudGeneration {
  constructor({ doc, boardId, user, helperApi, helperRequest, api, request, ready, onError, onStart, sharing, read }) {
    Object.assign(this, { doc, boardId, user: boardAuthor(user) || { name: 'Teammate' }, helperApi, helperRequest, api, request, ready, onError, onStart, sharing });
    // The editor's incremental reader when there is one; it returns shared objects, which this class never mutates.
    this.read = read || (() => (this.reader ||= new CloudGraphReader(doc)).read());
    this.origin = {}; this.active = false; this.polling = false; this.submitting = new Set(); this.uncertain = new Set(); this.uploaded = new Map(); this.cancelling = new Set();
  }
  setRun(run) { this.doc.transact(() => this.doc.getMap('runs').set(run.id, run), this.origin); }
  // Only an active run changes, so a cancellation or failure written by someone else is never undone.
  settle(id, fields) {
    const run = this.doc.getMap('runs').get(id);
    if (run && !terminal(run.status)) this.setRun({ ...run, finishedAt: timestamp(), ...fields });
  }
  delegated(id) { return !!this.doc.getMap('runs').get(id)?.delegate; }
  async inputs(images) { return Promise.all(images.map(async asset => ({ asset, data: await base64(await this.request(`/assets/${asset}`)) }))); }
  startPolling() {
    this.active = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), 1500);
  }
  stop() { this.active = false; clearInterval(this.timer); }
  // With an owner, the run is queued for that teammate's helper; their client submits it and places the images.
  async start(nodeId, owner) {
    if (!this.ready()) throw new Error('Wait for a live board connection before generating.');
    const graph = this.read();
    if (graph.runs.some(run => run.nodeId === nodeId && ['running', 'queued'].includes(run.status))) return;
    const { prompt, images, target } = collectInputs(graph, nodeId);
    const run = { id: crypto.randomUUID(), nodeId, ...runSummary(graph, target), ...generationSettings, status: 'queued', by: this.user, startedAt: timestamp() };
    run.createdAt = run.startedAt;
    if (owner !== undefined) {
      if (this.sharing?.using()?.to !== owner) throw new Error('Your teammate’s Codex is no longer available. Ask for access again.');
      this.setRun({ ...run, delegate: { owner, requester: this.doc.clientID } });
      this.onStart?.(run);
      return;
    }
    const inputs = await this.inputs(images);
    if (!this.active || !this.ready()) throw new Error('Board disconnected. Try generating when it is live.');
    run.startedAt = run.createdAt = timestamp();
    this.setRun(run); this.submitting.add(run.id);
    this.onStart?.(run);
    try {
      await this.helperApi('/api/cloud-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        jobId: run.id, boardId: this.boardId, nodeId, prompt, labelOutputs: target.data.labelOutputs, images: inputs,
      }) });
    } catch (error) {
      // A lost response may hide an accepted job; discovery will recover it without resubmitting.
      if (this.active && error.status) this.setRun({ ...run, status: 'failed', finishedAt: timestamp(), error: error.message });
      else this.uncertain.add(run.id);
      throw error;
    } finally { this.submitting.delete(run.id); }
    this.tick();
  }
  // Nano Banana runs in the board's room on the server, which writes the run and places its images; no helper is involved.
  // The room first waits for this client's own latest edits (its clock), so it reads the prompt as it is shown here.
  async startNano(nodeId) {
    if (!this.ready()) throw new Error('Wait for a live board connection before generating.');
    if ([...this.doc.getMap('runs').values()].some(run => run.nodeId === nodeId && ['running', 'queued'].includes(run.status))) return;
    const { run } = await this.api(`/api/boards/${this.boardId}/nano`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId, client: this.doc.clientID, clock: getState(this.doc.store, this.doc.clientID) }) });
    this.onStart?.(run);
  }
  // Runs that need no local helper to start or cancel.
  remote(id) { const run = this.doc.getMap('runs').get(id); return !!run?.delegate || run?.provider === generators.nanoBanana; }
  async cancel(id) {
    const run = this.doc.getMap('runs').get(id);
    if (!run || run.by?.name !== this.user.name || terminal(run.status)) return;
    if (run.provider === generators.nanoBanana) return void await this.api(`/api/boards/${this.boardId}/nano/${id}/cancel`, { method: 'POST' });
    // The board is the only channel to a teammate's helper; their client stops the job when it sees this.
    if (run.delegate) {
      if (!this.ready()) throw new Error('Wait for a live board connection before cancelling.');
      return this.settle(id, { status: 'cancelled', count: run.outputIds?.length || 0 });
    }
    await this.helperApi(`/api/cloud-jobs/${id}/cancel`, { method: 'POST' });
    if (this.active) await this.tick();
  }
  async complete(job) {
    const map = this.doc.getMap('runs');
    if (terminal(map.get(job.id)?.status)) return true;
    for (const output of job.outputs || []) {
      if (!this.active || !this.ready()) return false;
      const id = runOutputId(job.id, output.index);
      if (map.get(job.id)?.outputIds?.includes(id)) continue;
      const key = `${job.id}:${output.index}`;
      let uploaded = this.uploaded.get(key);
      if (!uploaded && !this.doc.getMap('nodes').has(id)) {
        const response = await this.helperRequest(`/api/cloud-jobs/${job.id}/outputs/${output.index}`);
        if (!response.ok) throw new Error('Could not collect a generated image. The helper will retain it for retry.');
        const blob = await response.blob(), dimensions = imageSize(new Uint8Array(await blob.arrayBuffer()));
        if (!this.active || !this.ready()) return false;
        const { asset } = await this.api('/api/assets', { method: 'POST', headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' }, body: blob });
        uploaded = { asset, dimensions }; this.uploaded.set(key, uploaded);
      }
      if (!this.active || !this.ready()) return false;
      this.doc.transact(() => {
        const current = map.get(job.id);
        if (terminal(current?.status) || current?.outputIds?.includes(id)) return;
        const before = this.read(), graph = placeRunOutput(before, { runId: job.id, nodeId: job.nodeId, run: current, author: this.user, fields: { ...jobSettings(job), startedAt: job.startedAt || current?.startedAt }, output, ...uploaded });
        if (graph) applyLocalGraph(this.doc, graph, before, this.origin);
      }, this.origin);
    }
    if (!this.active || !this.ready()) return false;
    const current = map.get(job.id);
    if (!terminal(current?.status)) {
      const run = { ...(current || { id: job.id, nodeId: job.nodeId, label: 'Recovered generation' }), by: boardAuthor(current?.by || this.user), ...jobSettings(job), createdAt: current?.createdAt || current?.startedAt || job.startedAt, startedAt: job.startedAt || current?.startedAt, status: job.status,
        ...(terminal(job.status) ? { finishedAt: job.finishedAt || timestamp(), count: current?.outputIds?.length || 0 } : {}), ...(job.error ? { error: job.error } : {}) };
      if (JSON.stringify(run) !== JSON.stringify(current)) this.setRun(run);
    }
    return true;
  }
  async tick() {
    if (!this.active || !this.ready() || this.polling) return;
    this.polling = true;
    try {
      const uncertain = [...this.uncertain];
      const { jobs } = await this.helperApi('/api/cloud-jobs');
      if (!this.active || !this.ready()) return;
      for (const id of uncertain) {
        if (!jobs.some(job => job.id === id)) {
          const run = this.doc.getMap('runs').get(id);
          if (['running', 'queued'].includes(run?.status)) this.setRun({ ...run, status: 'failed', finishedAt: timestamp(), error: 'The helper did not accept this job. Run the prompt again.' });
        }
        this.uncertain.delete(id);
      }
      for (const job of jobs.filter(job => job.boardId === this.boardId)) {
        if (!this.active || !this.ready()) break;
        if (this.submitting.has(job.id)) continue;
        const run = this.doc.getMap('runs').get(job.id);
        if (run?.delegate && terminal(run.status) && !terminal(job.status)) {
          if (!this.cancelling.has(job.id)) { await this.helperApi(`/api/cloud-jobs/${job.id}/cancel`, { method: 'POST' }); this.cancelling.add(job.id); }
          continue;
        }
        if (!await this.complete(job)) continue;
        if (terminal(job.status) && this.active && this.ready()) {
          await this.helperApi(`/api/cloud-jobs/${job.id}`, { method: 'DELETE' });
          this.cancelling.delete(job.id);
          for (const key of this.uploaded.keys()) if (key.startsWith(`${job.id}:`)) this.uploaded.delete(key);
        }
      }
      if (this.active && this.ready()) this.serve(jobs.filter(job => job.boardId === this.boardId));
    } catch (error) { if (this.active) this.onError(error.message || 'Local helper unavailable. Collection will retry.', error); }
    finally { this.polling = false; }
  }
  writer(id) { return this.doc.getMap('runs')._map?.get(id)?.id?.client; }
  waiting() { return [...this.doc.getMap('runs').values()].filter(run => run.delegate && run.status === 'queued' && !run.delegate.started); }
  // Owner side: submit teammates' queued runs to this helper, a few at a time, while the grant holds.
  serve(jobs) {
    if (!this.sharing) return;
    const map = this.doc.getMap('runs'), states = this.sharing.states(), serving = this.sharing.local().codex === true;
    const running = new Set([...jobs.filter(job => !terminal(job.status)).map(job => job.id), ...this.submitting].filter(id => map.get(id)?.delegate));
    let active = running.size;
    for (const run of this.waiting().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      if (delegateAction(run, { me: this.doc.clientID, states, gone: id => this.sharing.gone(id), active, serving, writer: this.writer(run.id) }) !== 'serve') continue;
      active++;
      this.submitDelegated(run).catch(error => this.onError(error.message || 'Could not start a teammate’s generation.', error));
    }
  }
  async submitDelegated(run) {
    // Claim the run first so a reconnecting requester or a second tick never submits it twice.
    this.submitting.add(run.id);
    this.setRun({ ...run, delegate: { ...run.delegate, started: true } });
    try {
      let body;
      try {
        // Inputs are read now, from the board as it is when this helper takes the run.
        const { prompt, images, target } = collectInputs(this.read(), run.nodeId);
        body = { jobId: run.id, boardId: this.boardId, nodeId: run.nodeId, prompt, labelOutputs: target.data.labelOutputs, images: await this.inputs(images) };
      } catch (error) { if (this.ready()) this.settle(run.id, { status: 'failed', error: error.message || 'Could not prepare this generation.' }); return; }
      if (terminal(this.doc.getMap('runs').get(run.id)?.status)) return;
      if (!this.active || !this.ready()) { this.settle(run.id, { status: 'failed', error: 'The Codex owner disconnected before this generation started. Run the prompt again.' }); return; }
      try { await this.helperApi('/api/cloud-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
      catch (error) {
        if (this.active && error.status) this.settle(run.id, { status: 'failed', error: error.message });
        else this.uncertain.add(run.id);
        throw error;
      }
    } finally { this.submitting.delete(run.id); }
    this.tick();
  }
  // Every client settles teammate-Codex runs that can no longer start, so they never block their prompt.
  maintain() {
    if (!this.sharing || !this.ready()) return;
    const states = this.sharing.states();
    for (const run of this.waiting()) {
      const action = delegateAction(run, { me: this.doc.clientID, states, gone: id => this.sharing.gone(id), writer: this.writer(run.id) });
      if (action === 'revoked') this.settle(run.id, { status: 'failed', error: 'Access to the teammate’s Codex ended before this generation started. Ask for access and run the prompt again.' });
      if (action === 'orphaned') this.settle(run.id, { status: 'failed', error: 'The teammate whose Codex was chosen left the board before this generation started. Run the prompt again.' });
    }
  }
}
