import { YServer } from 'y-partyserver';
import { applyUpdate, encodeStateAsUpdate, getState } from 'yjs';
import { boardStats } from './board-stats.mjs';
import { imageTypes } from './assets.mjs';
import { base64, maxReferenceBytes, NanoError, nanoCost, nanoEstimate, nanoModel, nanoPrompt, nanoRequest, nanoResult, nanoSettings, nanoTimeout } from './nano-banana.mjs';
import { generators, imageSize } from '../graph.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { boardAuthor } from '../src/annotations.mjs';
import { placeRunOutput, runSummary, terminalRun } from '../src/run-outputs.mjs';
import { copyLibrary, libraryCopied } from '../src/board-templates.mjs';
import { boardRole, canEdit } from './access.mjs';

const chunkSize = 512 * 1024;
const origin = 'nano-banana', timestamp = () => new Date().toISOString();
const active = run => ['running', 'queued'].includes(run?.status);

export class BoardRoom extends YServer {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 1000, debounceMaxWait: 5000 };
  nanoJobs = new Map(); nanoStarting = new Set();

  async onLoad() {
    const kv = this.ctx.storage.kv;
    const count = kv.get('doc:count') || 0;
    if (!count) return;
    const chunks = [];
    let size = 0;
    for (let i = 0; i < count; i++) {
      const chunk = kv.get(`doc:${i}`);
      if (!(chunk instanceof Uint8Array)) throw new Error('Incomplete board snapshot.');
      chunks.push(chunk);
      size += chunk.length;
    }
    const update = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { update.set(chunk, offset); offset += chunk.length; }
    applyUpdate(this.document, update);
  }

  async onStart(props) {
    await super.onStart(props);
    // Edits from here on reach connected people. A paid call is never repeated blindly: a Nano Banana run that this
    // instance is not running was cut off when the room stopped.
    for (const run of [...this.document.getMap('runs').values()]) {
      if (run?.provider === generators.nanoBanana && active(run) && !this.nanoJobs.has(run.id)) this.writeRun(run.id, { status: 'failed', error: 'Generation was interrupted. Run the prompt again.', count: run.outputIds?.length || 0 });
    }
    // A board made before custom nodes belonged to boards copies the old team library the first time it opens.
    if (!libraryCopied(this.document)) {
      try { copyLibrary(this.document, await this.directory().libraryFor(this.name), 'library'); }
      catch (cause) { console.error('Could not copy the custom node library:', cause); }
    }
  }

  // The Worker admitted this person and set their role. A viewer's document updates are ignored; their presence still syncs.
  onConnect(connection, ctx) {
    const role = ctx.request.headers.get('x-concept-graph-role');
    connection.setState(state => ({ ...state, role: ['owner', 'edit', 'view'].includes(role) ? role : 'view', email: ctx.request.headers.get('x-concept-graph-email') }));
    super.onConnect(connection, ctx);
    this.sendCustomMessage(connection, JSON.stringify({ type: 'access', role: connection.state.role }));
  }

  isReadOnly(connection) { return !canEdit(connection.state?.role); }

  // Worker RPC after the owner changes sharing: everyone connected gets their new role at once, and people who lost
  // access are disconnected.
  async refreshAccess() {
    const access = await this.directory().roomAccess(this.name), members = new Map(access?.members || []);
    for (const connection of this.getConnections()) {
      const { email, role } = connection.state || {}, next = boardRole(access, email, members.get(email));
      if (next === role) continue;
      this.sendCustomMessage(connection, JSON.stringify({ type: 'access', role: next }));
      if (next) connection.setState(state => ({ ...state, role: next }));
      else connection.close(4403, 'Access removed');
    }
  }

  onSave() {
    const saving = (this.saving || Promise.resolve()).then(() => this.saveSnapshot());
    this.saving = saving.catch(() => {});
    return saving;
  }

  async saveSnapshot() {
    const update = encodeStateAsUpdate(this.document);
    const stats = boardStats(this.document), updatedAt = new Date().toISOString();
    const count = Math.ceil(update.length / chunkSize), kv = this.ctx.storage.kv;
    this.ctx.storage.transactionSync(() => {
      const previous = kv.get('doc:count') || 0;
      for (let i = 0; i < count; i++) kv.put(`doc:${i}`, update.slice(i * chunkSize, (i + 1) * chunkSize));
      for (let i = count; i < previous; i++) kv.delete(`doc:${i}`);
      kv.put('doc:count', count);
    });
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', update))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash === kv.get('directory:hash')) return;
    await this.directory().updateBoardStats(this.name, { ...stats, updatedAt });
    kv.put('directory:hash', hash);
  }

  async onClose(connection, code, reason, wasClean) {
    super.onClose(connection, code, reason, wasClean);
    // y-partyserver 2.2 debounces saves but does not flush them on close.
    if (![...this.getConnections()].some(item => item.id !== connection.id)) await this.onSave();
  }

  directory() { return this.env.Directory.get(this.env.Directory.idFromName('boards')); }

  // Only an active run changes, so a cancellation or failure written by someone else is never undone.
  writeRun(id, fields) {
    const runs = this.document.getMap('runs'), run = runs.get(id);
    if (run && !terminalRun(run.status)) this.document.transact(() => runs.set(id, { ...run, finishedAt: timestamp(), ...fields }), origin);
  }

  // The person's latest edits travel over their socket and can arrive after this request; wait briefly for them.
  caughtUp(client, clock, wait = 5000) {
    const ready = () => !Number.isSafeInteger(client) || getState(this.document.store, client) >= clock;
    if (ready()) return true;
    return new Promise(resolve => {
      const check = () => { if (ready()) done(true); };
      const done = value => { clearTimeout(timer); this.document.off('update', check); resolve(value); };
      const timer = setTimeout(() => done(ready()), wait);
      this.document.on('update', check);
    });
  }

  // Worker RPC for a signed-in person on the allowed list. Reserves their quota, puts the run on the board and returns;
  // the paid call continues in the background (waitUntil keeps the room alive for up to 15 minutes).
  async startNano({ nodeId, client, clock, requester }) {
    const settings = nanoSettings(this.env);
    if (!settings.configured) return { error: 'Nano Banana isn’t set up on this site.', status: 503 };
    if (!await this.caughtUp(client, clock)) return { error: 'Your latest edits have not reached the board yet. Try again in a moment.', status: 409 };
    const busy = () => this.nanoStarting.has(nodeId) || [...this.document.getMap('runs').values()].some(run => run?.nodeId === nodeId && active(run));
    if (busy()) return { error: 'This prompt is already generating.', status: 409 };
    const graph = readCloudGraph(this.document);
    let request;
    try { request = nanoPrompt(graph, nodeId); }
    catch (cause) { return { error: cause.message, status: 400 }; }
    const estimateUsd = nanoEstimate({ promptLength: request.prompt.length, references: request.images.length });
    this.nanoStarting.add(nodeId);
    try {
      const reserved = await this.directory().reserveNano(requester.email, { dailyImages: settings.dailyImages, monthlyUsd: settings.monthlyUsd, estimateUsd });
      if (reserved.error) return reserved;
      const run = { id: crypto.randomUUID(), nodeId, ...runSummary(graph, request.target), provider: generators.nanoBanana, model: nanoModel, status: 'running', by: boardAuthor(requester) || { name: 'Teammate' }, startedAt: timestamp() };
      run.createdAt = run.startedAt;
      // The prompt may have been deleted while the quota was checked.
      if (!this.document.getMap('nodes').has(nodeId)) {
        await this.directory().settleNano(reserved.reservation, { images: 0, usd: 0 });
        return { error: 'This prompt was deleted.', status: 404 };
      }
      this.document.transact(() => this.document.getMap('runs').set(run.id, run), origin);
      const job = { run, email: requester.email, reservation: reserved.reservation, estimateUsd, request, controller: new AbortController() };
      this.nanoJobs.set(run.id, job);
      this.ctx.waitUntil(this.runNano(job));
      return { run: { id: run.id } };
    } finally { this.nanoStarting.delete(nodeId); }
  }

  // Worker RPC: only the person who started a run can stop it. The call is aborted; whatever arrived before stays.
  cancelNano({ runId, email }) {
    const job = this.nanoJobs.get(runId), run = this.document.getMap('runs').get(runId);
    if (!job) {
      if (run?.provider !== generators.nanoBanana) return { error: 'Generation not found.', status: 404 };
      if (active(run)) this.writeRun(runId, { status: 'failed', error: 'Generation was interrupted. Run the prompt again.', count: run.outputIds?.length || 0 });
      return { ok: true };
    }
    if (job.email !== email) return { error: 'Only the person who started this generation can cancel it.', status: 403 };
    job.cancelled = true;
    job.controller.abort();
    this.writeRun(runId, { status: 'cancelled', count: run?.outputIds?.length || 0 });
    return { ok: true };
  }

  async references(images) {
    const objects = await Promise.all(images.map(image => this.env.FILES.get(`assets/${image.asset}`)));
    if (objects.some(object => !object)) throw new NanoError('bad_request', 'A reference image is missing from storage. Reconnect it and try again.');
    if (objects.reduce((total, object) => total + object.size, 0) > maxReferenceBytes) throw new NanoError('bad_request', 'Reference images are too large for Nano Banana (20 MB in total). Use fewer or smaller images.');
    return Promise.all(objects.map(async (object, index) => ({ mimeType: imageTypes[images[index].asset.split('.').pop()], data: base64(new Uint8Array(await object.arrayBuffer())) })));
  }

  placeOutput(job, index, asset, dimensions) {
    let placed = false;
    this.document.transact(() => {
      const before = readCloudGraph(this.document);
      const graph = placeRunOutput(before, { runId: job.run.id, nodeId: job.run.nodeId, run: this.document.getMap('runs').get(job.run.id), author: job.run.by, output: { index }, asset, dimensions });
      if (graph) { applyLocalGraph(this.document, graph, before, origin); placed = true; }
    }, origin);
    return placed;
  }

  // One request, never retried automatically: a retry could be billed twice. Usage is settled with what the call cost.
  async runNano(job) {
    const { run, request, controller } = job, fallback = { promptLength: request.prompt.length, references: request.images.length };
    const timer = setTimeout(() => { job.timedOut = true; controller.abort(); }, nanoTimeout);
    let placed = 0, usd = 0, outcome = { status: 'completed' };
    try {
      const references = await this.references(request.images);
      if (job.cancelled) return;
      const { url, init } = nanoRequest(request.prompt, references, { key: this.env.GEMINI_API_KEY, endpoint: nanoSettings(this.env).endpoint });
      // From here Google may bill the call even if no answer arrives, so the estimate stands until the answer says otherwise.
      usd = job.estimateUsd;
      const response = await fetch(url, { ...init, signal: controller.signal });
      const body = await response.json().catch(() => null);
      usd = response.ok ? nanoCost(body?.usage, { ...fallback, images: 0 }) : 0;
      const { images, usage } = nanoResult(response.status, body);
      usd = nanoCost(usage, { ...fallback, images: images.length });
      for (const [index, image] of images.entries()) {
        if (job.cancelled || terminalRun(this.document.getMap('runs').get(run.id)?.status)) break;
        const asset = `${crypto.randomUUID()}.${image.format}`;
        await this.env.FILES.put(`assets/${asset}`, image.bytes, { httpMetadata: { contentType: image.contentType } });
        if (!this.placeOutput(job, index, asset, imageSize(image.bytes))) break;
        placed++;
      }
    } catch (cause) {
      outcome = { status: 'failed', error: job.timedOut ? 'Nano Banana took longer than 5 minutes. Try again.' : cause instanceof NanoError ? cause.message
        : cause?.name === 'TypeError' ? 'Could not reach Nano Banana. Try again.' : 'Nano Banana generation failed. Try again.' };
      if (!(cause instanceof NanoError) && !job.cancelled) console.error('Nano Banana generation failed:', cause);
    } finally {
      clearTimeout(timer);
      this.nanoJobs.delete(run.id);
      const current = this.document.getMap('runs').get(run.id);
      this.writeRun(run.id, { ...(job.cancelled ? { status: 'cancelled' } : outcome), count: current?.outputIds?.length || 0 });
      try { await this.directory().settleNano(job.reservation, { images: placed, usd }); }
      catch (cause) { console.error('Could not record Nano Banana usage:', cause); }
      // Paid results are saved before the room may sleep, even when nobody is connected to flush them.
      await this.onSave().catch(cause => console.error('Could not save the board after Nano Banana:', cause));
    }
  }
}
