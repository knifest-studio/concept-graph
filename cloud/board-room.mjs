import { YServer } from 'y-partyserver';
import { applyUpdate, Doc, encodeStateAsUpdate, encodeStateVector, getState } from 'yjs';
import { boardStats } from './board-stats.mjs';
import { assetPattern, imageFormat, imageTypes } from './assets.mjs';
import { base64, describeCost, describeEstimate, describeModel, describeResult, NanoError, nanoCost, nanoEstimate, nanoModel, nanoPrompt, nanoRequest, nanoResult, nanoSettings, nanoTimeout, staleSettingsError, variantLanes, variantLanesFor, variantRunTimeout } from './nano-banana.mjs';
import { gptImageCost, gptImageEstimate, gptImageModel, gptImagePrompt, gptImageRequest, gptImageResult, gptImageSettings } from './gpt-image.mjs';
import { generators, imageSize, isSiteGenerator, isUpscale, isModel3d, model3dModels, promptVariants, resolveGeneration, runInputRecord, runSettings, upscalerOf, upscalers } from '../graph.mjs';
import { applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';
import { boardAuthor } from '../src/annotations.mjs';
import { placeRunOutput, placeRunText, runSummary, terminalRun } from '../src/run-outputs.mjs';
import { copyLibrary, deleteBoardTemplate, importBoardTemplates, libraryCopied, readBoardTemplates, saveBoardTemplate } from '../src/board-templates.mjs';
import { boardRole, canEdit } from './access.mjs';
import { BoardChat } from './chat.mjs';
import { voiceHasSpace, voiceSignal } from './voice.mjs';
import { revisionOf, runBoardTool, toolByName } from './mcp-tools.mjs';
import { reframePng } from './png-frame.mjs';
import { couldNotReduce, derivedKey, fallbackSides, fitsLimits, headerBytes, inspectImage, planReferences, referenceLimits, referenceProblem, sendsAsIs, sniffFormat, stillTooLarge } from './reference-prep.mjs';
import { falModel3d, model3dFile, model3dInput, model3dPoster, model3dPrices, model3dRequest, storeModelGlb } from './model3d.mjs';
import { falInput, falUpscale, nanoContent, nanoFrame, nanoUpscaleFormat, nanoUpscalePrompt, upscaleCost, upscaleEstimate, upscaleFactor, upscaleModels, upscaleRequest, upscaleSettings } from './upscale.mjs';
import { backupKey, expiredVersions, keyOf, listAll, pack, removedMany, restoreDocument, shownVersion, unpack, versionEvery, versionKey, versionMetadata, versionPrefixes } from './versions.mjs';

const chunkSize = 512 * 1024, maxAgentDeletes = 200;
// One call every 4 seconds per tab, and one to everyone every 15 seconds; answers are accepted for two minutes.
const callGap = 4000, everyoneGap = 15000, callLife = 2 * 60 * 1000;
// y-partyserver keeps the presence IDs each connection controls in its state under this key.
const presenceIds = connection => connection.state?.__ypsAwarenessIds || [];
const coordinate = value => Number.isFinite(value) && Math.abs(value) <= 1e7;
const origin = 'nano-banana', mcpOrigin = 'mcp', restoreOrigin = 'restore', timestamp = () => new Date().toISOString();
const active = run => ['running', 'queued'].includes(run?.status);
// A prompt's image run: its calls are variants of one request (not images to upscale or turn into 3D, nor a description).
const variantRun = request => !request.upscale && !request.model3d && !request.describe;
// A run of variants sends only a few of its reserved calls at a time. Its reservations, and how many calls it has sent,
// stay in the room's storage until they are settled, so a room that stops mid-run can refund the calls it never sent.
const variantsKey = 'variants:reserved';
// Which size rules a run's references follow (cloud/reference-prep.mjs).
const referencePurpose = (request, gpt) => request.model3d ? 'model3d' : request.upscale ? 'upscale' : request.describe ? 'describe' : gpt ? 'gptImage' : 'nanoBanana';
// Inputs a mask made (GPT Image's base and mask, Nano Banana's marked copy) and the masked image itself carry `maskOf`,
// so a size message names that image and says to remove the mask before Resize.
const referenceInputs = request => {
  if (request.model3d) return request.images;
  const masked = request.images.find(image => image.mask), maskOf = masked && (masked.label || '');
  const tagged = request.images.map(image => masked && (image.mask || (masked.nodeId && image.nodeId === masked.nodeId)) ? { ...image, maskOf } : image);
  return [...tagged, ...(request.mask ? [{ asset: request.mask, ...(masked ? { maskOf } : {}) }] : [])];
};

export class BoardRoom extends YServer {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 1000, debounceMaxWait: 5000 };
  nanoJobs = new Map(); nanoStarting = new Set(); agentAsks = new Map(); calls = new Map(); callTimes = new Map();
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
    // Edits from here on reach connected people. A paid call is never repeated blindly: a site-provider run that this
    // instance is not running was cut off when the room stopped.
    for (const run of [...this.document.getMap('runs').values()]) {
      if (isSiteGenerator(run?.provider) && active(run) && !this.nanoJobs.has(run.id)) this.writeRun(run.id, { status: 'failed', error: 'Generation was interrupted. Run the prompt again.', count: run.outputIds?.length || 0 });
    }
    // Found from storage rather than the board, which may have been saved before the run began.
    for (const id of Object.keys(kv.get(variantsKey) || {})) if (!this.nanoJobs.has(id)) this.ctx.waitUntil(this.releaseUnsent(id));
    // A board made before custom nodes belonged to boards copies the old team library the first time it opens.
    if (!libraryCopied(this.document)) {
      try { copyLibrary(this.document, await this.directory().libraryFor(this.name), 'library'); }
      catch (cause) { console.error('Could not copy the custom node library:', cause); }
    }
    const sizing = this.recordSizes();
    if (sizing) this.ctx.waitUntil(sizing.catch(cause => console.error('Could not read image sizes:', cause)));
  }

  // The Worker admitted this person and set their role. A viewer's document updates are ignored; their presence still syncs.
  onConnect(connection, ctx) {
    const role = ctx.request.headers.get('x-concept-graph-role');
    let name = null;
    try { name = decodeURIComponent(ctx.request.headers.get('x-concept-graph-name') || '') || null; } catch {}
    connection.setState(state => ({ ...state, role: ['owner', 'edit', 'view'].includes(role) ? role : 'view', email: ctx.request.headers.get('x-concept-graph-email'), name, color: ctx.request.headers.get('x-concept-graph-color') }));
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

  // Images placed before sizes were recorded (and uploads from older tabs) learn their pixel size from the start of their
  // file, so large ones show their 2K, 4K or 8K badge. Files whose size cannot be read are not tried again.
  // Returns null when every image already has its size, so nothing keeps the room awake.
  recordSizes() {
    const kv = this.ctx.storage.kv, skipped = new Set(kv.get('pixels:skipped') || []), nodes = this.document.getMap('nodes'), missing = [];
    for (const [id, node] of nodes) {
      const data = node?.get?.('type') === 'image' && node.get('data'), asset = data?.get?.('asset');
      if (data?.get && !data.get('pixels') && typeof asset === 'string' && assetPattern.test(asset) && !skipped.has(asset)) missing.push([id, asset]);
    }
    return missing.length ? this.readSizes(missing, skipped) : null;
  }

  async readSizes(missing, skipped) {
    const kv = this.ctx.storage.kv, nodes = this.document.getMap('nodes'), sizes = new Map(), assets = [...new Set(missing.map(([, asset]) => asset))];
    for (let index = 0; index < assets.length; index += 20) {
      await Promise.all(assets.slice(index, index + 20).map(async asset => {
        try {
          const object = await this.env.FILES.get(`assets/${asset}`, { range: { offset: 0, length: 256 * 1024 } });
          const size = object && imageSize(new Uint8Array(await object.arrayBuffer()));
          sizes.set(asset, size?.width > 0 && size?.height > 0 ? { width: size.width, height: size.height } : null);
        } catch { sizes.set(asset, null); }
      }));
    }
    this.document.transact(() => {
      for (const [id, asset] of missing) {
        const data = nodes.get(id)?.get?.('data');
        if (sizes.get(asset) && data?.get && !data.get('pixels')) data.set('pixels', sizes.get(asset));
      }
    }, 'pixels');
    const failed = assets.filter(asset => !sizes.get(asset));
    if (failed.length) kv.put('pixels:skipped', [...skipped, ...failed].slice(-2000));
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

  // Cloudflare Images through the IMAGES binding (5,000 transformations a month on the free plan).
  async transformImage(bytes, transform, format) {
    const result = await this.env.IMAGES.input(new Blob([bytes]).stream()).transform(transform).output({ format, ...(format === 'image/jpeg' ? { quality: 95 } : {}) });
    return new Uint8Array(await result.response().arrayBuffer());
  }

  // The part of a padded Nano Banana answer that holds the original. If it cannot be cut, the whole answer is kept:
  // nothing of the original is lost, only the padding stays.
  async cutBack(image, plan, source) {
    const size = imageSize(image.bytes), content = size && nanoContent(plan, source, size);
    if (!content) return image;
    try {
      const bytes = image.format === 'png' ? await reframePng(image.bytes, content)
        : await this.transformImage(image.bytes, { trim: { top: content.top, left: content.left, bottom: size.height - content.top - content.height, right: size.width - content.left - content.width } }, 'image/jpeg');
      if (!bytes) return image;
      const format = imageFormat(bytes);
      return { bytes, format, contentType: imageTypes[format] };
    } catch (cause) { console.error('Could not cut an upscale back to its shape:', cause); return image; }
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
    // After hibernation the room may have no awareness state to remove; tell peers this voice socket is gone anyway.
    if (Number.isSafeInteger(connection.state?.voiceId)) this.broadcastCustomMessage(JSON.stringify({ type: 'voice-left', from: connection.state.voiceId }));
    super.onClose(connection, code, reason, wasClean);
    for (const ask of [...this.agentAsks.values()]) if (ask.connection === connection.id) ask.done({ error: 'The board in your browser was closed before it answered.' });
    if (this.deleted) return;
    // y-partyserver 2.2 debounces saves but does not flush them on close.
    if (![...this.getConnections()].some(item => item.id !== connection.id)) await this.onSave();
  }

  directory() { return this.env.Directory.get(this.env.Directory.idFromName('boards')); }

  // Records a run of variants' reservations and how many of its calls have been sent; null forgets the run.
  trackVariants(id, fields) {
    const kv = this.ctx.storage.kv, open = { ...kv.get(variantsKey) };
    if (fields) open[id] = { ...open[id], ...fields }; else delete open[id];
    if (Object.keys(open).length) kv.put(variantsKey, open); else kv.delete(variantsKey);
  }

  // For a run of variants this room no longer runs: calls it never sent settle at nothing; sent calls keep their estimate,
  // since the provider may have billed them.
  async releaseUnsent(id) {
    const tracked = this.ctx.storage.kv.get(variantsKey)?.[id];
    if (!tracked) return;
    try {
      const unsent = tracked.reservations.slice(tracked.started || 0);
      if (unsent.length) await this.directory().settleNanoMany(unsent.map(reservation => ({ id: reservation, images: 0, usd: 0 })));
      this.trackVariants(id, null);
    } catch (cause) { console.error('Could not refund the variants an interrupted run never sent:', cause); }
  }

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
  // the paid call continues in the background (waitUntil keeps the room alive for up to 15 minutes). `settings` says the
  // request comes from a page that shows generation settings (agents always do); `languages` is its Accept-Language.
  async startNano({ nodeId, client, clock, requester, settings: knowsSettings = false, languages }) {
    if (!await this.caughtUp(client, clock)) return { error: 'Your latest edits have not reached the board yet. Try again in a moment.', status: 409 };
    const graph = readCloudGraph(this.document), node = graph.nodes.find(item => item.id === nodeId);
    const gpt = !isUpscale(node) && !isModel3d(node) && node?.data.generator === generators.gptImage, name = isModel3d(node) ? '3D generation' : gpt ? 'GPT Image' : 'Nano Banana';
    const settings = gpt ? gptImageSettings(this.env) : nanoSettings(this.env);
    // The room chooses the provider from its authoritative prompt, after the client's edits arrive.
    const model3d = isModel3d(node), fal = model3d || (isUpscale(node) && upscalerOf(node) !== upscalers.nanoBanana);
    if (fal ? !upscaleSettings(this.env).fal : !settings.configured) return { error: model3d ? '3D generation isn’t set up on this site. Ask the site owner to add a fal.ai key.' : fal ? 'Topaz and SeedVR2 aren’t set up on this site yet. Choose Nano Banana, or ask the site owner to add a fal.ai key.' : `${name} isn’t set up on this site.`, status: 503 };
    if (model3d ? !await this.directory().model3dAllowed(requester.email) : !await this.directory().nanoAllowed(requester.email)) return { error: model3d ? '3D generation isn’t available for your account. Ask a site admin for access.' : `${name} is not available for your account. Ask a site admin for access.`, status: 403 };
    const busy = () => this.nanoStarting.has(nodeId) || [...this.document.getMap('runs').values()].some(run => run?.nodeId === nodeId && active(run));
    if (busy()) return { error: 'This prompt is already generating.', status: 409 };
    // `inputs` lists the images the run is given, for its results' details; it is read before anything is reserved.
    let request, inputs;
    try { request = model3d ? model3dRequest(graph, nodeId) : isUpscale(node) ? upscaleRequest(graph, nodeId) : gpt ? gptImagePrompt(graph, nodeId) : nanoPrompt(graph, nodeId); inputs = runInputRecord(graph, nodeId); }
    catch (cause) { return { error: cause.message, status: 400 }; }
    // A describe node gets one written description; it costs the team's budget but no daily images. An upscale makes one
    // image per connected image, each reserved at the largest size it could come out.
    const describe = !!request.describe, variants = variantRun(request);
    // A prompt's settings, as this provider uses them. A page opened before settings existed would start a run it cannot
    // show (a 4K or 16:9 one, say), so a request that does not know them is refused once any of them applies.
    const generation = variants ? resolveGeneration(request.target, gpt ? generators.gptImage : generators.nanoBanana, { mask: !!request.mask }) : null;
    if (generation && Object.keys(generation.applied).length && !knowsSettings) return { error: staleSettingsError(languages), status: 409 };
    const lanes = variants ? variantLanesFor({ gpt, imageSize: generation?.applied.imageSize }) : variantLanes;
    const measure = { promptLength: request.prompt?.length || 0, references: request.images.length + (request.mask ? 1 : 0),
      ...(generation ? gpt ? { quality: generation.gpt.quality, megapixels: generation.gpt.megapixels } : { imageSize: generation.applied.imageSize, thinking: generation.applied.nanoThinking } : {}) };
    const sources = request.upscale ? await this.imageSizes(request.images) : [];
    const calls = request.upscale || model3d ? request.images.length : describe ? 1 : promptVariants(request.target);
    const estimates = Array.from({ length: calls }, (_, index) => model3d ? model3dPrices[request.modeler] : request.upscale ? upscaleEstimate(request.upscaler, request.scale, sources[index]) : describe ? describeEstimate(measure) : gpt ? gptImageEstimate(measure) : nanoEstimate(measure));
    this.nanoStarting.add(nodeId);
    const reservations = [], release = async () => {
      if (variants) await this.directory().settleNanoMany(reservations.map(id => ({ id, images: 0, usd: 0 })));
      else for (const id of reservations) await this.directory().settleNano(id, { images: 0, usd: 0 });
    };
    try {
      // Images that are missing, or too large to send and to reduce, fail here, before anything is reserved or run.
      const problem = await this.referencesProblem(request, gpt, name);
      if (problem) return { error: problem, status: 400 };
      // Each variant (or image to upscale) is its own call, so each takes its own share of the person's day and the team's month.
      // Variants are reserved together, all or none, in one call to the directory however many there are.
      if (variants) {
        const reserved = await this.directory().reserveNanoMany(requester.email, { dailyImages: settings.dailyImages, monthlyUsd: settings.monthlyUsd, estimates });
        if (reserved.error) return { error: reserved.fit ? `${reserved.error} Only ${reserved.fit} of ${calls} variants fit; choose fewer.` : reserved.error, status: reserved.status };
        reservations.push(...reserved.reservations);
      } else for (let index = 0; index < calls; index++) {
        const reserved = await this.directory().reserveNano(requester.email, { dailyImages: settings.dailyImages, monthlyUsd: settings.monthlyUsd, estimateUsd: estimates[index], images: describe ? 0 : 1 });
        if (reserved.error) {
          await release();
          return index ? { ...reserved, error: `${reserved.error} Only ${index} of ${calls} images fit; connect fewer.` } : reserved;
        }
        reservations.push(reserved.reservation);
      }
      const task = model3d ? { task: 'model3d', modeler: request.modeler } : describe ? { task: 'describe' } : request.upscale ? { task: 'upscale', scale: request.scale } : {};
      const run = { id: crypto.randomUUID(), nodeId, ...runSummary(graph, request.target), inputs, provider: gpt ? generators.gptImage : generators.nanoBanana, model: model3d ? model3dModels[request.modeler] : request.upscale ? upscaleModels[request.upscaler] : describe ? describeModel : gpt ? gptImageModel : nanoModel, status: 'running', by: boardAuthor(requester) || { name: 'Teammate' }, startedAt: timestamp(), ...(calls > 1 && !request.upscale && !model3d ? { variants: calls } : {}), ...(variants && calls > lanes ? { variantsStarted: lanes } : {}),
        ...runSettings(generation), ...task };
      run.createdAt = run.startedAt;
      // The prompt may have been deleted while the quota was checked.
      if (!this.document.getMap('nodes').has(nodeId)) {
        await release();
        return { error: 'This prompt was deleted.', status: 404 };
      }
      this.document.transact(() => this.document.getMap('runs').set(run.id, run), origin);
      const job = { run, email: requester.email, reservations, estimates, estimateUsd: estimates[0], request, measure, lanes, controller: new AbortController(), next: 0 };
      this.nanoJobs.set(run.id, job);
      if (variants) this.trackVariants(run.id, { reservations, started: 0 });
      this.ctx.waitUntil(this.runNano(job));
      return { run: { id: run.id } };
    } finally { this.nanoStarting.delete(nodeId); }
  }

  listTemplates() { return readBoardTemplates(this.document); }

  async importTemplates(values, user) {
    const board = await this.directory().boardFor(this.name, user.email);
    if (!canEdit(board?.role)) return { error: 'You can only view this board.', status: 403 };
    try {
      const templates = importBoardTemplates(this.document, values, 'template-copy');
      this.edited(user.name);
      await this.onSave();
      return { templates };
    } catch (cause) { return { error: cause.message, status: 400 }; }
  }

  // Worker RPC for an agent connected over MCP; the Worker has checked the person's role. A tool reads and changes the
  // board in one turn, so no other edit lands in between, and the board is saved at once in case nobody is connected.
  async mcp({ tool: name, args, user }) {
    const tool = toolByName.get(name);
    if (!tool || tool.account) return { error: 'Unknown tool.' };
    try {
      if (name === 'list_chat') return { value: this.chat().history(args, user.email) };
      if (name === 'send_chat') {
        const { message } = this.chat().send(args, user, { agent: true, sender: `agent:${user.email}` });
        this.broadcastCustomMessage(JSON.stringify({ type: 'chat-message', message }));
        return { value: { message } };
      }
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

  // Site providers run here; Codex runs on the person's own computer, so their open board starts it as Generate would.
  async mcpStart(nodeId, user) {
    const node = readCloudGraph(this.document).nodes.find(item => item.id === nodeId);
    if (!node) return { error: `Node not found: ${nodeId}` };
    if (node.type !== 'text') return { error: 'Generate from a prompt (a text node).' };
    if (!isSiteGenerator(node.data.generator) && !isUpscale(node) && !isModel3d(node)) {
      const answer = await this.askTabs(user, { type: 'agent-generate', nodeId });
      if (answer.error) return { error: answer.error };
      return answer.runId ? { value: { runId: answer.runId, generator: 'codex', status: 'started' } } : { error: 'This prompt is already generating.' };
    }
    const result = await this.startNano({ nodeId, requester: user, settings: true });
    return result.error ? { error: result.error } : { value: { runId: result.run.id, generator: this.document.getMap('runs').get(result.run.id).provider, status: 'running' } };
  }

  async mcpCancel(runId, user) {
    const run = this.document.getMap('runs').get(runId);
    if (!run) return { error: 'Generation not found.' };
    if (isSiteGenerator(run.provider)) { const result = this.cancelNano({ runId, email: user.email }); return result.error ? { error: result.error } : { value: { cancelled: runId } }; }
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
    if (typeof value?.type === 'string' && value.type.startsWith('chat-')) return this.chatMessage(connection, value);
    if (typeof value?.type === 'string' && value.type.startsWith('voice-')) return this.voiceMessage(connection, value);
    if (value?.type === 'attention') return this.callAttention(connection, value);
    if (value?.type === 'attention-reply') return this.answerAttention(connection, value);
    const ask = value?.type === 'agent-answer' && this.agentAsks.get(value.requestId);
    if (!ask || ask.connection !== connection.id) return;
    ask.done(typeof value.error === 'string' ? { error: value.error.slice(0, 500) || 'Generation could not start.' } : { runId: typeof value.runId === 'string' && value.runId.length <= 120 ? value.runId : null });
  }

  chat() { return this.boardChat ||= new BoardChat(this.ctx.storage.sql); }

  chatMessage(connection, value) {
    if (!connection.state?.email || !connection.state?.role) return;
    const reply = value => this.sendCustomMessage(connection, JSON.stringify(value)), now = Date.now();
    try {
      if (value.type === 'chat-send') {
        const { message, duplicate } = this.chat().send(value, connection.state, { key: value.key, sender: `socket:${connection.id}` });
        if (!duplicate) this.broadcastCustomMessage(JSON.stringify({ type: 'chat-message', message }));
        reply({ type: 'chat-message', message, key: value.key });
      } else if (value.type === 'chat-history') {
        if (now - (connection.state.chatHistoryAt || 0) < 200) throw new Error('Wait a moment before loading more messages.');
        connection.setState(state => ({ ...state, chatHistoryAt: now }));
        reply({ type: 'chat-history', ...this.chat().history(value, connection.state.email), before: value.before, after: value.after ?? 0 });
      } else if (value.type === 'chat-delete') {
        if (now - (connection.state.chatDeleteAt || 0) < 300) throw new Error('Wait a moment before deleting another message.');
        connection.setState(state => ({ ...state, chatDeleteAt: now }));
        this.broadcastCustomMessage(JSON.stringify({ type: 'chat-deleted', ...this.chat().delete(value.id, connection.state) }));
      }
    } catch (cause) { reply({ type: 'chat-failed', key: typeof value.key === 'string' ? value.key.slice(0, 120) : undefined, reason: cause.message, operation: value.type }); }
  }

  // Socket attachment state survives hibernation; awareness alone cannot arbitrate simultaneous joins.
  voiceMessage(connection, value) {
    if (!connection.state?.email || !connection.state?.role) return;
    const reply = value => this.sendCustomMessage(connection, JSON.stringify(value));
    const own = connection.state.voiceId, connections = [...this.getConnections()];
    if (value.type === 'voice-join') {
      const id = value.clientId;
      const key = typeof value.key === 'string' ? value.key.slice(0, 120) : undefined;
      if (!Number.isSafeInteger(id) || !presenceIds(connection).includes(id)) return reply({ type: 'voice-failed', key, reason: 'Voice is still connecting. Try again.' });
      const occupied = connections.filter(item => item.id !== connection.id).map(item => item.state?.voiceId).filter(Number.isSafeInteger);
      if (occupied.includes(id)) return reply({ type: 'voice-failed', key, reason: 'Voice is still connecting. Try again.' });
      if (!voiceHasSpace(occupied)) return reply({ type: 'voice-failed', key, reason: 'Voice is full (8 people). Try again when someone leaves.' });
      connection.setState(state => ({ ...state, voiceId: id }));
      return reply({ type: 'voice-joined', clientId: id, key });
    }
    if (value.type === 'voice-leave') { connection.setState(state => ({ ...state, voiceId: null })); return; }
    if (value.type !== 'voice-signal' || !Number.isSafeInteger(own) || !presenceIds(connection).includes(own) || !voiceSignal(value)) return;
    const target = connections.find(item => item.id !== connection.id && item.state?.voiceId === value.to && presenceIds(item).includes(value.to));
    if (!target) return;
    const now = Date.now(), rate = connection.state.voiceRate;
    if (rate && now - rate.at < 1000 && rate.count >= 100) return;
    connection.setState(state => ({ ...state, voiceRate: !rate || now - rate.at >= 1000 ? { at: now, count: 1 } : { ...rate, count: rate.count + 1 } }));
    this.sendCustomMessage(target, JSON.stringify({ type: 'voice-signal', from: own, data: value.data }));
  }

  // Someone asks one person (every tab of theirs) or everyone else to come to them. The room names the caller from the
  // connection it admitted, so nobody can call in someone else's name, and spaces calls out so nobody can flood the board.
  callAttention(connection, value) {
    const reply = message => this.sendCustomMessage(connection, JSON.stringify(message));
    const name = connection.state?.name, own = presenceIds(connection)[0], everyone = value.to === 'all', now = Date.now();
    if (!name || !Number.isSafeInteger(own) || (!everyone && !Number.isSafeInteger(value.to))) return;
    const last = this.callTimes.get(connection.id) || { at: 0, everyone: 0 };
    if (now - last.at < callGap || (everyone && now - last.everyone < everyoneGap)) return reply({ type: 'attention-failed', reason: 'busy' });
    const others = [...this.getConnections()].filter(item => item.id !== connection.id && item.state?.email !== connection.state?.email);
    const person = !everyone && others.find(item => presenceIds(item).includes(value.to))?.state?.email;
    const targets = everyone ? others : person ? others.filter(item => item.state?.email === person) : [];
    if (!targets.length) return reply({ type: 'attention-failed', reason: everyone ? 'alone' : 'gone' });
    this.callTimes.set(connection.id, { at: now, everyone: everyone ? now : last.everyone });
    for (const [key, call] of this.calls) if (now - call.at > callLife) this.calls.delete(key);
    const id = crypto.randomUUID();
    this.calls.set(id, { at: now, caller: connection.id, waiting: new Set(targets.map(item => item.state?.email)) });
    const spot = coordinate(value.spot?.x) && coordinate(value.spot?.y) ? { x: value.spot.x, y: value.spot.y } : null;
    const page = typeof value.page === 'string' && value.page.length <= 120 ? value.page : null;
    const message = JSON.stringify({ type: 'attention', id, from: { name, clientId: own }, everyone, page, spot });
    for (const target of targets) this.sendCustomMessage(target, message);
    reply({ type: 'attention-sent', id, everyone, people: new Set(targets.map(item => item.state?.email)).size });
  }

  // Each person called answers once, from any of their tabs; the caller hears who is coming and who is busy.
  answerAttention(connection, value) {
    const call = typeof value.id === 'string' && this.calls.get(value.id);
    if (!call || !['coming', 'later'].includes(value.answer) || !call.waiting.delete(connection.state?.email)) return;
    const caller = [...this.getConnections()].find(item => item.id === call.caller);
    if (caller) this.sendCustomMessage(caller, JSON.stringify({ type: 'attention-reply', id: value.id, from: { name: connection.state?.name || 'Teammate' }, answer: value.answer }));
  }

  // Worker RPC: only the person who started a run can stop it. The call is aborted; whatever arrived before stays.
  cancelNano({ runId, email }) {
    const job = this.nanoJobs.get(runId), run = this.document.getMap('runs').get(runId);
    if (!job) {
      if (!isSiteGenerator(run?.provider)) return { error: 'Generation not found.', status: 404 };
      if (active(run)) this.writeRun(runId, { status: 'failed', error: 'Generation was interrupted. Run the prompt again.', count: run.outputIds?.length || 0 });
      this.ctx.waitUntil(this.releaseUnsent(runId));
      return { ok: true };
    }
    if (job.email !== email) return { error: 'Only the person who started this generation can cancel it.', status: 403 };
    job.cancelled = true;
    job.controller.abort();
    this.writeRun(runId, { status: 'cancelled', count: run?.outputIds?.length || 0 });
    return { ok: true };
  }

  // The start of each stored image and its size, or null where it is missing. A ranged read still reports the size of the
  // whole object (R2Object.size).
  async inspectReferences(images) {
    return Promise.all(images.map(async image => {
      const object = await this.env.FILES.get(`assets/${image.asset}`, { range: { offset: 0, length: headerBytes } });
      return object ? inspectImage(new Uint8Array(await object.arrayBuffer()), object.size) : null;
    }));
  }

  // Checked before a run starts; what was read is kept on the request for the run itself. A 3D run sends each image on
  // its own, so each is checked on its own.
  async referencesProblem(request, gpt, name) {
    const images = referenceInputs(request), purpose = referencePurpose(request, gpt), limits = referenceLimits[purpose];
    // Storage trouble here leaves the check to the run, which reads the images again.
    try { request.inspected = await this.inspectReferences(images); }
    catch (cause) { console.error('Could not read reference images before a run:', cause); return null; }
    const infos = request.inspected, options = { binding: !!this.env.IMAGES, name, upscale: purpose === 'upscale', model3d: purpose === 'model3d' };
    // A missing image still fails as a run, the way it always has.
    if (infos.some(info => !info)) return null;
    if (purpose !== 'model3d') return referenceProblem(infos, images, limits, options);
    for (const [index, image] of images.entries()) { const problem = referenceProblem([infos[index]], [image], limits, options); if (problem) return problem; }
    return null;
  }

  // References as they are sent. Each original stays on the board untouched; one too large for the provider is sent as
  // a smaller copy that Cloudflare Images makes once and R2 keeps under derived/. A set still too large is reduced
  // further before it fails. `pair` holds the GPT Image mask and the image it edits, which must stay the same size.
  async prepareReferences(images, purpose, { name = 'Nano Banana', pair = [], keepBytes = false, infos } = {}) {
    const limits = referenceLimits[purpose], upscale = purpose === 'upscale', model3d = purpose === 'model3d', binding = !!this.env.IMAGES;
    infos ||= await this.inspectReferences(images);
    const problem = referenceProblem(infos, images, limits, { binding, name, upscale, model3d });
    if (problem) throw new NanoError('bad_request', problem);
    // Without Cloudflare Images every original goes as it is, as before copies existed; referenceProblem found that they
    // fit. A copy that cannot be made falls back to its original where the provider takes that (sendsAsIs), and a mask
    // and its image fall back together so they stay the same size.
    const original = index => ({ key: `assets/${images[index].asset}`, bytes: infos[index].bytes }), asIs = new Set();
    let sources = null, refusal = null;
    for (const side of binding && !limits.untouched ? [undefined, ...fallbackSides] : [undefined]) {
      const plan = binding ? planReferences(infos, limits, { side, pair }) : infos.map(() => ({ prep: false })), found = new Array(plan.length);
      // A few copies at a time, so the room never holds many large images at once.
      for (let start = 0; start < plan.length; start += 3) await Promise.all(plan.slice(start, start + 3).map(async (step, offset) => {
        const index = start + offset;
        if (!step.prep || asIs.has(index)) { found[index] = original(index); return; }
        try { found[index] = await this.reducedCopy(images[index], step); }
        catch (error) { if (!sendsAsIs(infos[index], limits)) throw error; refusal ||= error; asIs.add(index); found[index] = original(index); }
      }));
      if (pair.some(index => asIs.has(index))) for (const index of pair) {
        if (!sendsAsIs(infos[index], limits)) throw refusal;
        asIs.add(index); found[index] = original(index);
      }
      if (fitsLimits(found.map(source => source.bytes), limits)) { sources = found; break; }
    }
    // When an original that could not be reduced is what keeps the set too large, that image is named.
    if (!sources) throw refusal || new NanoError('bad_request', stillTooLarge(name, limits));
    // One image in memory at a time; only its base64 text is kept.
    const prepared = [];
    for (const [index, source] of sources.entries()) {
      let bytes = source.data;
      if (!bytes) {
        const object = await this.env.FILES.get(source.key);
        if (!object) throw new NanoError('bad_request', referenceProblem([null], [], limits, { upscale, model3d }));
        bytes = new Uint8Array(await object.arrayBuffer());
      }
      const image = images[index];
      prepared.push({ mimeType: imageTypes[sniffFormat(bytes)] || imageTypes[image.asset.split('.').pop()], data: base64(bytes), size: imageSize(bytes), byteLength: bytes.length, ...(keepBytes ? { bytes } : {}),
        ...(upscale || model3d ? {} : { label: image.label, nodeId: image.nodeId, asset: image.asset, uploaded: image.uploaded }) });
    }
    return prepared;
  }

  // A reduced copy of one image, stored once beside the original. Cloudflare Images reads the original as a stream.
  async reducedCopy(image, step) {
    const key = derivedKey(image.asset, step), stored = await this.env.FILES.head(key);
    if (stored) return { key, bytes: stored.size };
    const original = await this.env.FILES.get(`assets/${image.asset}`);
    if (!original) throw new NanoError('bad_request', 'A reference image is missing from storage. Reconnect it and try again.');
    let bytes;
    try {
      const result = await this.env.IMAGES.input(original.body).transform(step.transform).output({ format: step.format, ...(step.format === 'image/jpeg' ? { quality: 90 } : {}) });
      bytes = new Uint8Array(await result.response().arrayBuffer());
    } catch (cause) { console.error('Could not reduce a reference image:', image.asset, cause); throw new NanoError('bad_request', couldNotReduce(image)); }
    // Cloudflare Images returns large animations untransformed; only the copy that was asked for is sent.
    const size = imageSize(bytes);
    if (!size || Math.max(size.width, size.height) > step.side || imageTypes[sniffFormat(bytes)] !== step.format) throw new NanoError('bad_request', couldNotReduce(image));
    try { await this.env.FILES.put(key, bytes, { httpMetadata: { contentType: step.format } }); }
    catch (cause) { console.error('Could not keep a reduced reference image:', cause); return { key, bytes: bytes.length, data: bytes }; }
    return { key, bytes: bytes.length };
  }

  // Pixel sizes from the start of each file, enough to price an upscale before it runs; null where the header is unread.
  async imageSizes(images) {
    return Promise.all(images.map(async image => {
      try { const object = await this.env.FILES.get(`assets/${image.asset}`, { range: { offset: 0, length: 256 * 1024 } }); return object ? imageSize(new Uint8Array(await object.arrayBuffer())) || null : null; }
      catch { return null; }
    }));
  }

  async callModel3d(job, index, result) {
    // All 3D jobs in this room share this lane; failed/cancelled work releases it too.
    const previous = this.model3dLane || Promise.resolve();
    let release;
    this.model3dLane = new Promise(resolve => { release = resolve; });
    await previous;
    const signal = job.controller.signal;
    try {
      signal.throwIfAborted();
      // Hunyuan accepts JPG/PNG/WebP at 128–5000 px and up to 8 MB: over 6 MB or 4096 px, or a GIF (no model gets
      // animation), the image goes as a 2048 px JPEG (cloud/reference-prep.mjs).
      const image = job.request.images[index];
      let [prepared] = await this.prepareReferences([image], 'model3d', { name: '3D generation', infos: job.request.inspected && [job.request.inspected[index]] });
      const { size, mimeType } = prepared;
      if (!size) throw new NanoError('bad_request', 'Could not read the size of an image to turn into 3D.');
      if (prepared.byteLength > 8 * 1024 * 1024 || (job.request.modeler === 'hunyuan' && Math.min(size.width, size.height) < 128)) throw new NanoError('bad_request', 'Use an image at least 128 px on each side and at most 8 MB for 3D generation.');
      const settings = upscaleSettings(this.env), options = { endpoint: settings.endpoint, signal };
      const input = model3dInput(job.request.modeler, `data:${mimeType};base64,${prepared.data}`);
      prepared = null;
      const model = await falModel3d({ ...options, key: this.env.FAL_KEY, modeler: job.request.modeler, input, onQueued: () => { result.usd = job.estimates[index]; } });
      signal.throwIfAborted();
      const asset = `${crypto.randomUUID()}.glb`;
      let storedBytes;
      // A file that isn't a usable GLB says why in History instead of a bare "failed".
      try { storedBytes = await storeModelGlb(await model3dFile(model.url, options), this.env.FILES, asset, signal); }
      catch (cause) { if (signal.aborted || cause instanceof NanoError) throw cause; console.error('Could not store the 3D model:', model.url, cause); throw new NanoError('upstream', `The 3D generator returned a model the board can’t store: ${String(cause?.message || cause).slice(0, 200)}`); }
      let poster = image.asset;
      if (model.thumbnail) {
        try {
          const thumbnail = await model3dPoster(model.thumbnail, options);
          const stored = `${crypto.randomUUID()}.${thumbnail.format}`;
          await this.env.FILES.put(`assets/${stored}`, thumbnail.bytes, { httpMetadata: { contentType: imageTypes[thumbnail.format] } });
          poster = stored;
        } catch (cause) { if (signal.aborted) throw cause; console.error('Could not save the 3D poster:', cause); }
      }
      if (job.cancelled || terminalRun(this.document.getMap('runs').get(job.run.id)?.status)) return;
      if (this.placeOutput(job, index, asset, undefined, { name: `${image.label || 'Image'} 3D`, poster, modeler: job.request.modeler, source: { nodeId: image.nodeId, name: image.label || 'Image' }, bytes: storedBytes, usd: result.usd })) result.placed++;
    } finally { release(); }
  }

  // One connected image becomes one larger image, placed beside the upscale node in the order of the connections. Once
  // Google or fal.ai has taken the call it may be billed even without an answer, so the estimate stands until one arrives.
  async callUpscale(job, index, reference, result) {
    const { upscaler, scale } = job.request, source = reference.size, signal = job.controller.signal, queued = () => { result.usd = job.estimates[index]; };
    if (!source) throw new NanoError('bad_request', 'Could not read the size of an image to upscale.');
    let image;
    if (upscaler === upscalers.nanoBanana) {
      // Nano Banana draws only fixed shapes: an image of another shape goes in padded to the nearest one and the part
      // holding the original is cut back out of the answer, so nothing is cropped or stretched. A PNG is padded here,
      // repeating its edges; other formats, and the JPEG answer, go through Cloudflare Images. Without that binding the
      // image goes as it is, in the nearest shape.
      const plan = nanoFrame(source);
      let padded = null;
      if (plan.padded && this.env.IMAGES) {
        if (reference.mimeType === 'image/png') padded = await reframePng(reference.bytes, { width: plan.frame.width, height: plan.frame.height, left: -plan.left, top: -plan.top }).catch(() => null);
        padded ||= await this.transformImage(reference.bytes, { width: plan.frame.width, height: plan.frame.height, fit: 'pad', background: '#000000' }, 'image/png')
          .catch(cause => { console.error('Could not pad an image for Nano Banana:', cause); return null; });
      }
      queued();
      const { url, init } = nanoRequest(nanoUpscalePrompt, [padded ? { mimeType: 'image/png', data: base64(padded) } : reference], { key: this.env.GEMINI_API_KEY, endpoint: nanoSettings(this.env).endpoint }, nanoModel, nanoUpscaleFormat(scale, padded ? plan.frame : source));
      const response = await fetch(url, { ...init, signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) result.usd = 0;
      const { images, usage } = nanoResult(response.status, body);
      if (usage) result.usd = nanoCost(usage, { promptLength: nanoUpscalePrompt.length, references: 1, images: 1 });
      image = padded ? await this.cutBack(images[0], plan, source) : images[0];
    } else {
      const settings = upscaleSettings(this.env), input = falInput(upscaler, upscaleFactor(source, scale), `data:${reference.mimeType};base64,${reference.data}`);
      image = await falUpscale({ key: this.env.FAL_KEY, endpoint: settings.endpoint, model: upscaleModels[upscaler], input, signal, onQueued: queued });
    }
    const size = imageSize(image.bytes);
    if (upscaler !== upscalers.nanoBanana) result.usd = upscaleCost(upscaler, scale, size);
    if (job.cancelled || terminalRun(this.document.getMap('runs').get(job.run.id)?.status)) return;
    const asset = `${crypto.randomUUID()}.${image.format}`;
    await this.env.FILES.put(`assets/${asset}`, image.bytes, { httpMetadata: { contentType: image.contentType } });
    if (this.placeOutput(job, index, asset, size)) result.placed++;
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

  // Every variant sends the same request, so it is built once and shared: memory holds one copy of the reference images
  // however many variants there are. A few calls run at a time (fewer for large images, job.lanes); none starts after a
  // cancel or the run's time limit, and
  // a call that never started settles at nothing. Unstarted calls come back as failures with no reason of their own.
  async runVariants(job, references, fallback, results, mask) {
    const gpt = job.run.provider === generators.gptImage, outcomes = results.map(() => ({ status: 'rejected', reason: undefined }));
    // Settings are read from the prompt as it was when the run started; GPT Image's size also needs the edited image's shape.
    const generation = resolveGeneration(job.request.target, gpt ? generators.gptImage : generators.nanoBanana, { referenceSize: references[0]?.size, mask: !!mask });
    const call = gpt ? gptImageRequest(job.request.prompt, references, { key: this.env.OPENAI_API_KEY, endpoint: gptImageSettings(this.env).endpoint, mask, ...generation.gpt })
      : nanoRequest(job.request.prompt, references, { key: this.env.GEMINI_API_KEY, endpoint: nanoSettings(this.env).endpoint }, nanoModel, generation.nano.format, generation.nano.config);
    const runs = this.document.getMap('runs'), lanes = job.lanes || variantLanes, stopped = () => job.cancelled || job.controller.signal.aborted || terminalRun(runs.get(job.run.id)?.status);
    let next = 0;
    const lane = async () => {
      while (next < results.length && !stopped()) {
        const index = next++, run = runs.get(job.run.id);
        // Stored before the call goes out, so after a restart no call that was sent is refunded.
        this.trackVariants(job.run.id, { started: next });
        // Placeholders past the first lanes say Queued until their call starts.
        if (index >= lanes && run) this.document.transact(() => runs.set(job.run.id, { ...run, variantsStarted: index + 1 }), origin);
        try { await this.callNano(job, call, fallback, results[index]); outcomes[index] = { status: 'fulfilled' }; }
        catch (reason) { outcomes[index] = { status: 'rejected', reason }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(lanes, results.length) }, lane));
    return outcomes;
  }

  async callNano(job, { url, init }, fallback, result) {
    const gpt = job.run.provider === generators.gptImage, cost = gpt ? gptImageCost : nanoCost, parse = gpt ? gptImageResult : nanoResult;
    // Each call also has its own limit, so one slow answer cannot hold a lane until the whole run times out.
    const controller = new AbortController(), stop = () => controller.abort(), parent = job.controller.signal;
    const timer = setTimeout(() => { result.late = true; controller.abort(); }, nanoTimeout);
    parent.addEventListener('abort', stop);
    try {
      // The provider may bill even without an answer, so the estimate stands until the answer says otherwise.
      result.usd = job.estimateUsd;
      const response = await fetch(url, { ...init, signal: controller.signal });
      let body = await response.json().catch(() => null);
      controller.signal.throwIfAborted();
      result.usd = response.ok ? cost(body?.usage, { ...fallback, images: gpt ? 1 : 0 }) : 0;
      const { images, usage } = parse(response.status, body);
      // The answer's base64 text is as large as the image again; only the decoded bytes are kept while they are stored.
      body = null;
      result.usd = cost(usage, { ...fallback, images: images.length });
      for (const image of images) {
        if (job.cancelled || terminalRun(this.document.getMap('runs').get(job.run.id)?.status)) break;
        const asset = `${crypto.randomUUID()}.${image.format}`;
        await this.env.FILES.put(`assets/${asset}`, image.bytes, { httpMetadata: { contentType: image.contentType } });
        // Calls answer in any order; each image takes the next free output number.
        if (!this.placeOutput(job, job.next, asset, imageSize(image.bytes))) break;
        job.next++; result.placed++;
      }
    } catch (cause) {
      if (result.late && !parent.aborted) throw new NanoError('timeout', `${gpt ? 'GPT Image' : 'Nano Banana'} took longer than ${nanoTimeout / 60000} minutes. Try again.`);
      throw cause;
    } finally { clearTimeout(timer); parent.removeEventListener('abort', stop); }
  }

  placeOutput(job, index, asset, dimensions, model) {
    let placed = false;
    this.document.transact(() => {
      const before = readCloudGraph(this.document);
      const graph = placeRunOutput(before, { runId: job.run.id, nodeId: job.run.nodeId, run: this.document.getMap('runs').get(job.run.id), author: job.run.by, output: { index, ...(job.request.upscale ? { caption: `${job.request.images[index]?.label || 'Image'} upscaled` } : {}) }, asset, dimensions, model });
      if (graph) { applyLocalGraph(this.document, graph, before, origin); placed = true; }
    }, origin);
    return placed;
  }

  // One request per variant, a few side by side, never retried automatically: a retry could be billed twice. Images join
  // the run as each call answers; each call's usage is settled with what it cost.
  async runNano(job) {
    const { run, request, controller } = job, fallback = job.measure || { promptLength: request.prompt?.length || 0, references: request.images.length + (request.mask ? 1 : 0) };
    const name = request.model3d ? '3D generation' : request.upscale ? 'The upscale' : run.provider === generators.gptImage ? 'GPT Image' : 'Nano Banana';
    const variants = variantRun(request), limit = request.model3d ? 14 * 60 * 1000 : variants ? variantRunTimeout(job.reservations.length, job.lanes) : nanoTimeout;
    const timer = setTimeout(() => { job.timedOut = true; controller.abort(); }, limit), late = `${name} took longer than ${Math.round(limit / 60000)} minutes. Try again.`;
    const results = job.reservations.map(() => ({ placed: 0, usd: 0 }));
    let outcome = { status: 'completed' };
    try {
      const references = request.model3d ? [] : await this.prepareReferences(referenceInputs(request), referencePurpose(request, run.provider === generators.gptImage), { name, infos: request.inspected, keepBytes: !!request.upscale, pair: request.mask ? [0, request.images.length] : [] }), mask = request.mask ? references.pop() : undefined;
      if (job.cancelled) return;
      const calls = [];
      // Sequential across the room as well as within a run: model downloads never overlap.
      if (request.model3d) for (const [index, result] of results.entries()) {
        try { await this.callModel3d(job, index, result); calls.push({ status: 'fulfilled' }); }
        catch (reason) { calls.push({ status: 'rejected', reason }); }
      }
      else if (variants) calls.push(...await this.runVariants(job, references, fallback, results, mask));
      else calls.push(...await Promise.allSettled(results.map((result, index) => request.upscale ? this.callUpscale(job, index, references[index], result) : this.callDescribe(job, references, fallback, result))));
      const failures = calls.filter(call => call.status === 'rejected').map(call => call.reason);
      if (failures.length === calls.length) throw failures[0];
      // Some variants (or images) arrived: the run succeeds, and History says what the others ran into.
      if (failures.length) {
        const reason = job.timedOut ? late : failures[0] instanceof NanoError ? failures[0].message : `${name} failed.`;
        outcome = { status: 'completed', error: `${failures.length} of ${calls.length} ${request.upscale || request.model3d ? 'images' : 'variants'} failed: ${reason}` };
      }
    } catch (cause) {
      outcome = { status: 'failed', error: job.timedOut ? late : cause instanceof NanoError ? cause.message
        : cause?.name === 'TypeError' ? `Could not reach ${request.upscale ? 'the upscaler' : name}. Try again.` : `${name} failed. Try again.` };
      if (!(cause instanceof NanoError) && !job.cancelled) console.error(`${name} failed:`, cause);
    } finally {
      clearTimeout(timer);
      this.nanoJobs.delete(run.id);
      const current = this.document.getMap('runs').get(run.id);
      this.writeRun(run.id, { ...(job.cancelled ? { status: 'cancelled' } : outcome), count: current?.outputIds?.length || 0 });
      const settled = job.reservations.map((id, index) => ({ id, images: results[index].placed, usd: results[index].usd }));
      const failed = cause => console.error(`Could not record ${name} usage:`, cause);
      // If settling fails, the stored reservations let a restarted room still refund the calls that were never sent.
      if (variants) { try { await this.directory().settleNanoMany(settled); this.trackVariants(run.id, null); } catch (cause) { failed(cause); } }
      else for (const { id, ...usage } of settled) { try { await this.directory().settleNano(id, usage); } catch (cause) { failed(cause); } }
      // Paid results are saved before the room may sleep, even when nobody is connected to flush them.
      await this.onSave().catch(cause => console.error(`Could not save the board after ${name}:`, cause));
    }
  }
}
