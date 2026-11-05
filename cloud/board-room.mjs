import { YServer } from 'y-partyserver';
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector, getState } from 'yjs';
import { boardStats } from './board-stats.mjs';
import { imageTypes } from './assets.mjs';
import { base64, describeCost, describeEstimate, describeModel, describeResult, maxReferenceBytes, NanoError, nanoCost, nanoEstimate, nanoModel, nanoPrompt, nanoRequest, nanoResult, nanoSettings, nanoTimeout } from './nano-banana.mjs';
import { generators, imageSize, promptVariants } from '../graph.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { boardAuthor } from '../src/annotations.mjs';
import { placeRunOutput, placeRunText, runSummary, terminalRun } from '../src/run-outputs.mjs';
import { copyLibrary, deleteBoardTemplate, libraryCopied, readBoardTemplates, saveBoardTemplate } from '../src/board-templates.mjs';
import { boardRole, canEdit } from './access.mjs';
import { revisionOf, runBoardTool, toolByName } from './mcp-tools.mjs';
import { backupKey, expiredVersions, keyOf, listAll, pack, removedMany, restoreDocument, shownVersion, unpack, versionEvery, versionKey, versionMetadata, versionPrefixes } from './versions.mjs';

const chunkSize = 512 * 1024, maxAgentDeletes = 200;
const origin = 'nano-banana', mcpOrigin = 'mcp', restoreOrigin = 'restore', timestamp = () => new Date().toISOString();
const active = run => ['running', 'queued'].includes(run?.status);

export class BoardRoom extends YServer {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 1000, debounceMaxWait: 5000 };
  nanoJobs = new Map(); nanoStarting = new Set(); agentAsks = new Map();
  // Who changed the board since the last save and since the last version, by display name.
  editedBy = { save: new Set(), version: new Set() };

  async onLoad() {
    const update = this.storedUpdate();
    if (update) applyUpdate(this.document, update);
  }

  // The document as last saved, or null for a new board.
  storedUpdate() {
    const kv = this.ctx.storage.kv;
    const count = kv.get('doc:count') || 0;
    if (!count) return null;
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
    return update;
  }

  async onStart(props) {
    await super.onStart(props);
    const kv = this.ctx.storage.kv;
    for (const name of kv.get('version:editors') || []) this.editedBy.version.add(name);
    // A board stored before versions began gets its first one soon after it opens.
    if (kv.get('doc:count') && !kv.get('version:at') && !await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + 5000);
    // A person's edits arrive with their connection as the origin.
    this.document.on('update', (update, from) => { if (from?.state?.name) this.edited(from.state.name); });
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
    let name = null;
    try { name = decodeURIComponent(ctx.request.headers.get('x-concept-graph-name') || '') || null; } catch {}
    connection.setState(state => ({ ...state, role: ['owner', 'edit', 'view'].includes(role) ? role : 'view', email: ctx.request.headers.get('x-concept-graph-email'), name }));
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

  edited(name) { if (typeof name === 'string' && name) { this.editedBy.save.add(name); this.editedBy.version.add(name); } }

  sendAway() {
    for (const job of this.nanoJobs.values()) job.controller?.abort?.();
    for (const connection of this.getConnections()) {
      this.sendCustomMessage(connection, JSON.stringify({ type: 'deleted' }));
      connection.close(4404, 'Board deleted');
    }
  }

  // Worker RPC after the owner deletes the board: everyone is sent away. The board stays stored, in the trash, for 30 days.
  async trash() {
    this.sendAway();
    await this.onSave();
  }

  // Worker RPC when a board leaves the trash for good: the stored document and its versions are erased. Daily backups
  // expire on their own (a bucket lifecycle rule), and nothing can remove them sooner.
  async destroy() {
    this.deleted = true;
    this.sendAway();
    await this.saving;
    await this.ctx.storage.deleteAll();
    const keys = (await listAll(this.env.FILES, versionPrefixes(this.name)[0])).map(object => object.key);
    for (let index = 0; index < keys.length; index += 1000) await this.env.FILES.delete(keys.slice(index, index + 1000));
  }

  onSave() {
    if (this.deleted) return Promise.resolve();
    const saving = (this.saving || Promise.resolve()).then(() => this.saveSnapshot());
    this.saving = saving.catch(() => {});
    return saving;
  }

  // The last version is taken once edits stop; a board opened for the first time since versions began gets its first.
  async onAlarm() { if (!this.deleted) await this.onSave(); }

  async saveSnapshot() {
    const kv = this.ctx.storage.kv, update = encodeStateAsUpdate(this.document);
    const stats = { nodes: this.document.getMap('nodes').size, ...boardStats(this.document) }, updatedAt = new Date().toISOString();
    // A large deletion keeps the board as it was a moment ago; a restore has kept it already.
    const previous = kv.get('doc:stats'), removers = [...this.editedBy.save];
    const before = !this.restoring && previous && removedMany(previous.nodes, stats.nodes) ? this.storedUpdate() : null;
    this.editedBy.save.clear();
    const count = Math.ceil(update.length / chunkSize);
    this.ctx.storage.transactionSync(() => {
      const stored = kv.get('doc:count') || 0;
      for (let i = 0; i < count; i++) kv.put(`doc:${i}`, update.slice(i * chunkSize, (i + 1) * chunkSize));
      for (let i = count; i < stored; i++) kv.delete(`doc:${i}`);
      kv.put('doc:count', count);
      kv.put('doc:stats', stats);
      kv.put('version:editors', [...this.editedBy.version]);
    });
    if (before) {
      try { await this.writeVersion(before, { reason: 'before-delete', stats: previous, editors: [...this.editedBy.version], by: removers, removed: previous.nodes - stats.nodes }); }
      catch (cause) { console.error('Could not keep the board before a large deletion:', cause); }
    }
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', update))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    try { await this.keepVersion(update, hash, stats); }
    catch (cause) { console.error('Could not keep a board version:', cause); }
    if (hash === kv.get('directory:hash')) return;
    await this.directory().updateBoardStats(this.name, { imageCount: stats.imageCount, covers: stats.covers, updatedAt });
    kv.put('directory:hash', hash);
  }

  // A version at most every ten minutes while the board changes; an alarm takes the last one after edits stop.
  async keepVersion(update, hash, stats) {
    const kv = this.ctx.storage.kv, now = Date.now();
    if (hash === kv.get('version:hash')) return;
    const due = (kv.get('version:at') || 0) + versionEvery;
    if (now < due) {
      if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(due);
      return;
    }
    const editors = [...this.editedBy.version];
    await this.writeVersion(update, { reason: 'auto', stats, editors }, now);
    for (const name of editors) this.editedBy.version.delete(name);
    kv.put('version:at', now); kv.put('version:hash', hash); kv.put('version:editors', [...this.editedBy.version]);
  }

  async writeVersion(update, meta, at = Date.now()) {
    const body = await pack(update), customMetadata = versionMetadata(meta), kv = this.ctx.storage.kv;
    const key = versionKey(this.name, at, meta.reason);
    await this.env.FILES.put(key, body, { customMetadata });
    // The day's first version is also its backup, which the bucket lock keeps from being deleted or overwritten.
    const backup = backupKey(this.name, at);
    if (kv.get('backup:last') !== backup) {
      try { await this.env.FILES.put(backup, body, { customMetadata: { ...customMetadata, copy: key.split('/').pop() } }); }
      catch (cause) { console.error('Could not write the daily backup:', cause); }
      kv.put('backup:last', backup);
    }
    if (at - (kv.get('version:pruned') || 0) >= 60 * 60 * 1000) {
      kv.put('version:pruned', at);
      try {
        const entries = (await listAll(this.env.FILES, versionPrefixes(this.name)[0])).map(object => ({ key: object.key, version: shownVersion(object) })).filter(entry => entry.version);
        const doomed = expiredVersions(entries.map(({ key, version }) => ({ key, at: Date.parse(version.at), reason: version.reason })), at);
        for (let index = 0; index < doomed.length; index += 1000) await this.env.FILES.delete(doomed.slice(index, index + 1000));
      } catch (cause) { console.error('Could not remove old board versions:', cause); }
    }
  }

  // Worker RPC: the board's versions, newest first. A daily backup shows once the version it copies is gone.
  async listVersions() {
    const objects = (await Promise.all(versionPrefixes(this.name).map(prefix => listAll(this.env.FILES, prefix)))).flat();
    const names = new Set(objects.map(object => object.key.split('/').pop()));
    return objects.filter(object => !names.has(object.customMetadata?.copy)).map(shownVersion).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at));
  }

  // Worker RPC for someone who may edit. The board as it is now is kept first, so a restore can be undone the same way.
  async restoreVersion({ id, user }) {
    const key = keyOf(this.name, id), object = key && await this.env.FILES.get(key);
    if (!object) return { error: 'Version not found.', status: 404 };
    const snapshot = new Doc();
    try {
      try { applyUpdate(snapshot, await unpack(new Uint8Array(await object.arrayBuffer()))); }
      catch (cause) { console.error('Could not read a board version:', key, cause); return { error: 'This version could not be read.', status: 500 }; }
      await this.saving;
      const stats = { nodes: this.document.getMap('nodes').size, ...boardStats(this.document) };
      try { await this.writeVersion(encodeStateAsUpdate(this.document), { reason: 'before-restore', stats, editors: [user.name], by: [user.name] }); }
      catch (cause) { console.error('Could not keep the board before a restore:', cause); return { error: 'Could not keep the current board before restoring. Try again.', status: 503 }; }
      const changed = restoreDocument(this.document, snapshot, restoreOrigin);
      this.edited(user.name);
      this.restoring = true;
      try { await this.onSave(); } finally { this.restoring = false; }
      const version = shownVersion(object);
      this.broadcastCustomMessage(JSON.stringify({ type: 'restored', by: user.name, at: version?.at }));
      return { restored: { id, at: version?.at, changed } };
    } finally { snapshot.destroy(); }
  }

  async onClose(connection, code, reason, wasClean) {
    super.onClose(connection, code, reason, wasClean);
    for (const ask of [...this.agentAsks.values()]) if (ask.connection === connection.id) ask.done({ error: 'The board in your browser was closed before it answered.' });
    if (this.deleted) return;
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
    // A describe node gets one written description; it costs the team's budget but no daily images.
    const describe = !!request.describe, measure = { promptLength: request.prompt.length, references: request.images.length };
    const estimateUsd = describe ? describeEstimate(measure) : nanoEstimate(measure), variants = describe ? 1 : promptVariants(request.target);
    this.nanoStarting.add(nodeId);
    const reservations = [], release = async () => { for (const id of reservations) await this.directory().settleNano(id, { images: 0, usd: 0 }); };
    try {
      // Each variant is its own call, so each takes its own share of the person's day and the team's month.
      for (let index = 0; index < variants; index++) {
        const reserved = await this.directory().reserveNano(requester.email, { dailyImages: settings.dailyImages, monthlyUsd: settings.monthlyUsd, estimateUsd, images: describe ? 0 : 1 });
        if (reserved.error) {
          await release();
          return index ? { ...reserved, error: `${reserved.error} Only ${index} of ${variants} variants fit; choose fewer.` } : reserved;
        }
        reservations.push(reserved.reservation);
      }
      const run = { id: crypto.randomUUID(), nodeId, ...runSummary(graph, request.target), provider: generators.nanoBanana, model: describe ? describeModel : nanoModel, status: 'running', by: boardAuthor(requester) || { name: 'Teammate' }, startedAt: timestamp(), ...(variants > 1 ? { variants } : {}), ...(describe ? { task: 'describe' } : {}) };
      run.createdAt = run.startedAt;
      // The prompt may have been deleted while the quota was checked.
      if (!this.document.getMap('nodes').has(nodeId)) {
        await release();
        return { error: 'This prompt was deleted.', status: 404 };
      }
      this.document.transact(() => this.document.getMap('runs').set(run.id, run), origin);
      const job = { run, email: requester.email, reservations, estimateUsd, request, controller: new AbortController(), next: 0 };
      this.nanoJobs.set(run.id, job);
      this.ctx.waitUntil(this.runNano(job));
      return { run: { id: run.id } };
    } finally { this.nanoStarting.delete(nodeId); }
  }

  // Worker RPC for an agent connected over MCP; the Worker has checked the person's role. A tool reads and changes the
  // board in one turn, so no other edit lands in between, and the board is saved at once in case nobody is connected.
  async mcp({ tool: name, args, user }) {
    const tool = toolByName.get(name);
    if (!tool || tool.account) return { error: 'Unknown tool.' };
    try {
      if (name === 'start_run') return await this.mcpStart(args.nodeId, user);
      if (name === 'cancel_run') return await this.mcpCancel(args.runId, user);
      if (name === 'list_versions') return { value: { versions: (await this.listVersions()).slice(0, args.limit || 50) } };
      if (name === 'restore_version') { const result = await this.restoreVersion({ id: args.versionId, user }); return result.error ? { error: result.error } : { value: result.restored }; }
      const prepared = (await tool.prepare?.(args, this.env)) || {};
      const before = readCloudGraph(this.document), revision = () => revisionOf(encodeStateVector(this.document));
      const { result, graph } = runBoardTool(tool, { graph: before, args, user, prepared, revision: revision(), templates: readBoardTemplates(this.document),
        saveTemplate: (value, existing) => saveBoardTemplate(this.document, value, existing, mcpOrigin), deleteTemplate: id => deleteBoardTemplate(this.document, id, mcpOrigin) });
      if (tool.access === 'view') return { value: result };
      if (graph) {
        // A runaway agent cannot empty a board in one call; whatever it does delete is kept in the board's versions.
        const kept = new Set(graph.nodes.map(node => node.id)), removed = before.nodes.filter(node => !kept.has(node.id)).length;
        if (removed > maxAgentDeletes) return { error: `This would delete ${removed} nodes; an agent can delete at most ${maxAgentDeletes} in one call. Ask the person to delete them on the board, or delete fewer at a time.` };
        applyLocalGraph(this.document, graph, before, mcpOrigin);
      }
      this.edited(user?.name);
      await this.onSave();
      return { value: { ...result, revision: revision() } };
    } catch (cause) {
      // The shared board checks throw plain errors meant for people; anything else is a fault.
      const shown = cause?.expected || cause?.constructor === Error;
      if (!shown) console.error('Agent tool failed:', name, cause);
      return { error: shown ? cause.message : 'The tool failed. Read the board and try again.' };
    }
  }

  // Nano Banana runs here; Codex runs on the person's own computer, so their open board starts it as Generate would.
  async mcpStart(nodeId, user) {
    const node = readCloudGraph(this.document).nodes.find(item => item.id === nodeId);
    if (!node) return { error: `Node not found: ${nodeId}` };
    if (node.type !== 'text') return { error: 'Generate from a prompt (a text node).' };
    if (node.data.generator !== generators.nanoBanana) {
      const answer = await this.askTabs(user, { type: 'agent-generate', nodeId });
      if (answer.error) return { error: answer.error };
      return answer.runId ? { value: { runId: answer.runId, generator: 'codex', status: 'started' } } : { error: 'This prompt is already generating.' };
    }
    if (nanoSettings(this.env).configured && !await this.directory().nanoAllowed(user.email)) return { error: 'Nano Banana is not available for this account. Ask a site admin for access.' };
    const result = await this.startNano({ nodeId, requester: user });
    return result.error ? { error: result.error } : { value: { runId: result.run.id, generator: generators.nanoBanana, status: 'running' } };
  }

  async mcpCancel(runId, user) {
    const run = this.document.getMap('runs').get(runId);
    if (!run) return { error: 'Generation not found.' };
    if (run.provider === generators.nanoBanana) { const result = this.cancelNano({ runId, email: user.email }); return result.error ? { error: result.error } : { value: { cancelled: runId } }; }
    if (terminalRun(run.status)) return { value: { runId, status: run.status } };
    if (run.by?.name !== boardAuthor(user)?.name) return { error: 'Only the person who started this generation can cancel it.' };
    const answer = await this.askTabs(user, { type: 'agent-cancel', runId });
    return answer.error ? { error: answer.error } : { value: { cancelled: runId } };
  }

  // A person's Codex is reached only from their own open board. The room asks that person's tabs, one at a time, to start
  // or stop it for their agent, so an agent never spends anyone else's Codex.
  async askTabs(user, message, wait = 45000) {
    const tabs = [...this.getConnections()].filter(connection => connection.state?.email === user.email && canEdit(connection.state?.role));
    if (!tabs.length) return { error: 'Codex runs on your own computer, through this board open in your browser. Open the board in Concept Graph with the helper connected, then try again.' };
    let answer;
    for (const tab of tabs) {
      answer = await new Promise(resolve => {
        const requestId = crypto.randomUUID(), done = value => { clearTimeout(timer); this.agentAsks.delete(requestId); resolve(value); };
        const timer = setTimeout(() => done({ error: 'The board open in your browser did not answer. Check that it is still open, then try again.' }), wait);
        this.agentAsks.set(requestId, { connection: tab.id, done });
        try { this.sendCustomMessage(tab, JSON.stringify({ ...message, requestId })); }
        catch { done({ error: 'Could not reach the board open in your browser.' }); }
      });
      if (!answer.error) return answer;
    }
    return answer;
  }

  // Only the tab that was asked can answer.
  onCustomMessage(connection, message) {
    let value;
    try { value = JSON.parse(message); } catch { return; }
    const ask = value?.type === 'agent-answer' && this.agentAsks.get(value.requestId);
    if (!ask || ask.connection !== connection.id) return;
    ask.done(typeof value.error === 'string' ? { error: value.error.slice(0, 500) || 'Generation could not start.' } : { runId: typeof value.runId === 'string' && value.runId.length <= 120 ? value.runId : null });
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

  // The description lands as a text prompt beside the describe node, as with Codex; it holds no images to count.
  async callDescribe(job, references, fallback, result) {
    const { url, init } = nanoRequest(job.request.prompt, references, { key: this.env.GEMINI_API_KEY, endpoint: nanoSettings(this.env).endpoint }, describeModel);
    result.usd = job.estimateUsd;
    const response = await fetch(url, { ...init, signal: job.controller.signal });
    const body = await response.json().catch(() => null);
    result.usd = response.ok ? describeCost(body?.usage, fallback) : 0;
    const { text } = describeResult(response.status, body);
    if (job.cancelled || terminalRun(this.document.getMap('runs').get(job.run.id)?.status)) return;
    this.document.transact(() => {
      const before = readCloudGraph(this.document);
      const graph = placeRunText(before, { runId: job.run.id, nodeId: job.run.nodeId, run: this.document.getMap('runs').get(job.run.id), author: job.run.by, fields: { task: 'describe' }, text });
      if (graph) applyLocalGraph(this.document, graph, before, origin);
    }, origin);
  }

  async callNano(job, references, fallback, result) {
    const { url, init } = nanoRequest(job.request.prompt, references, { key: this.env.GEMINI_API_KEY, endpoint: nanoSettings(this.env).endpoint });
    // From here Google may bill the call even if no answer arrives, so the estimate stands until the answer says otherwise.
    result.usd = job.estimateUsd;
    const response = await fetch(url, { ...init, signal: job.controller.signal });
    const body = await response.json().catch(() => null);
    result.usd = response.ok ? nanoCost(body?.usage, { ...fallback, images: 0 }) : 0;
    const { images, usage } = nanoResult(response.status, body);
    result.usd = nanoCost(usage, { ...fallback, images: images.length });
    for (const image of images) {
      if (job.cancelled || terminalRun(this.document.getMap('runs').get(job.run.id)?.status)) break;
      const asset = `${crypto.randomUUID()}.${image.format}`;
      await this.env.FILES.put(`assets/${asset}`, image.bytes, { httpMetadata: { contentType: image.contentType } });
      // Calls answer in any order; each image takes the next free output number.
      if (!this.placeOutput(job, job.next, asset, imageSize(image.bytes))) break;
      job.next++; result.placed++;
    }
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

  // One request per variant, side by side, never retried automatically: a retry could be billed twice. Images join the run
  // as each call answers; each call's usage is settled with what it cost.
  async runNano(job) {
    const { run, request, controller } = job, fallback = { promptLength: request.prompt.length, references: request.images.length };
    const timer = setTimeout(() => { job.timedOut = true; controller.abort(); }, nanoTimeout);
    const results = job.reservations.map(() => ({ placed: 0, usd: 0 }));
    let outcome = { status: 'completed' };
    try {
      const references = await this.references(request.images);
      if (job.cancelled) return;
      const calls = await Promise.allSettled(results.map(result => job.request.describe ? this.callDescribe(job, references, fallback, result) : this.callNano(job, references, fallback, result)));
      const failures = calls.filter(call => call.status === 'rejected').map(call => call.reason);
      if (failures.length === calls.length) throw failures[0];
      // Some variants arrived: the run succeeds, and History says what the others ran into.
      if (failures.length) {
        const reason = failures[0] instanceof NanoError ? failures[0].message : 'Nano Banana generation failed.';
        outcome = { status: 'completed', error: `${failures.length} of ${calls.length} variants failed: ${reason}` };
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
      for (const [index, reservation] of job.reservations.entries()) {
        try { await this.directory().settleNano(reservation, { images: results[index].placed, usd: results[index].usd }); }
        catch (cause) { console.error('Could not record Nano Banana usage:', cause); }
      }
      // Paid results are saved before the room may sleep, even when nobody is connected to flush them.
      await this.onSave().catch(cause => console.error('Could not save the board after Nano Banana:', cause));
    }
  }
}
