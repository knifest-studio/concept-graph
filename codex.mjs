import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, statSync, accessSync, constants, lstatSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';

const loginHosts = new Set(['auth.openai.com', 'chatgpt.com']);
const loginIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const loginTimeoutMs = 10 * 60 * 1000;

// Only expose rate-limit windows: account credentials and other response fields stay private.
export function normalizeRateLimits(result) {
  const window = value => {
    if (!value || typeof value !== 'object') return null;
    const number = (n, min, max = Infinity) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? n : null;
    const usedPercent = number(value.usedPercent, 0, 100);
    const windowDurationMins = number(value.windowDurationMins, 1);
    const resetsAt = number(value.resetsAt, 1);
    return usedPercent === null && windowDurationMins === null && resetsAt === null ? null : { usedPercent, windowDurationMins, resetsAt };
  };
  const byId = result?.rateLimitsByLimitId;
  const values = byId && typeof byId === 'object' && !Array.isArray(byId) ? Object.entries(byId) : [];
  if (!values.length && result?.rateLimits) values.push([result.rateLimits.limitId || 'codex', result.rateLimits]);
  const buckets = values.flatMap(([key, value]) => {
    if (!value || typeof value !== 'object') return [];
    const primary = window(value.primary), secondary = window(value.secondary);
    if (!primary && !secondary) return [];
    const id = typeof value.limitId === 'string' ? value.limitId : key;
    return [{ id: id.slice(0, 128), name: typeof value.limitName === 'string' ? value.limitName.slice(0, 128) : null, primary, secondary }];
  });
  return { available: buckets.length > 0, buckets };
}

function validateChatGPTLogin(result) {
  if (result?.type !== 'chatgpt' || typeof result.loginId !== 'string' || !loginIdPattern.test(result.loginId)
      || typeof result.authUrl !== 'string' || result.authUrl.length > 8192) throw new Error('Codex returned an invalid sign-in request.');
  let url;
  try { url = new URL(result.authUrl); } catch { throw new Error('Codex returned an invalid sign-in request.'); }
  if (url.protocol !== 'https:' || !loginHosts.has(url.hostname) || url.port || url.username || url.password) throw new Error('Codex returned an invalid sign-in request.');
  return { loginId: result.loginId, authUrl: url.href };
}

// The image tool returns its own prompt with each item, so captions stay tied to
// that image even when multiple tool calls finish in a different order.
export function generatedImageCaption(revisedPrompt) {
  if (typeof revisedPrompt !== 'string') return '';
  const markers = [...revisedPrompt.matchAll(/\[\[CG_CAPTION:([^\[\]\r\n]*)\]\]/gu)];
  if (markers.length !== 1 || (revisedPrompt.match(/\[\[CG_CAPTION:/gu) || []).length !== 1) return '';
  const caption = markers[0][1].trim();
  if (!caption || caption.length > 120 || /\p{C}/u.test(caption)) return '';
  return caption;
}

// Windows npm shims require a separate Node installation; launch Codex's own native binary instead.
export function findWindowsCodex(env = process.env, arch = process.arch, exists = existsSync) {
  // Resolve before spawn changes cwd to the helper's data directory.
  const requested = /[\\/]/.test(env.CODEX_BIN || '') ? path.win32.resolve(env.CODEX_BIN) : env.CODEX_BIN;
  const isShim = /\.(?:cmd|bat|ps1)$/i.test(requested || '');
  if (requested && !/^codex$/i.test(requested) && !isShim) return requested;
  const win = path.win32;
  const explicitShim = isShim && /[\\/]/.test(requested) ? requested : null;
  const value = name => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] || '';
  const pathValue = value('PATH');
  const dirs = explicitShim ? [win.dirname(explicitShim)] : pathValue.split(';').map(p => p.replace(/^"|"$/g, '')).filter(Boolean);
  if (!explicitShim && value('APPDATA')) dirs.push(win.join(value('APPDATA'), 'npm'));
  if (!explicitShim && value('USERPROFILE')) dirs.push(win.join(value('USERPROFILE'), '.local', 'bin'));
  if (!explicitShim && value('LOCALAPPDATA')) dirs.push(win.join(value('LOCALAPPDATA'), 'Programs', 'OpenAI', 'Codex', 'bin'));
  const triple = arch === 'x64' ? 'x86_64-pc-windows-msvc' : arch === 'arm64' ? 'aarch64-pc-windows-msvc' : '';
  for (const dir of dirs) {
    const native = win.join(dir, 'codex.exe');
    if (!explicitShim && exists(native)) return native;
    const shims = explicitShim ? [explicitShim] : isShim ? [win.join(dir, requested)] : ['codex.cmd', 'codex.ps1'].map(name => win.join(dir, name));
    if (!triple || !shims.some(exists)) continue;
    if (explicitShim && exists(native)) return native;
    const modules = win.basename(dir).toLowerCase() === '.bin' ? win.dirname(dir) : win.join(dir, 'node_modules');
    for (const root of [
      win.join(modules, '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${arch}`),
      win.join(modules, '@openai', `codex-win32-${arch}`),
      win.join(modules, '@openai', 'codex'),
    ]) for (const folder of ['bin', 'codex']) {
      const executable = win.join(root, 'vendor', triple, folder, 'codex.exe');
      if (exists(executable)) return executable;
    }
  }
  const managed = codexInstallOptions(env, 'win32', arch).executable;
  if (!explicitShim && exists(managed)) return managed;
  if (isShim) throw new Error('Could not find the native Codex executable behind CODEX_BIN. Point CODEX_BIN to codex.exe.');
  return 'codex.exe';
}

export function resolveCodex(env = process.env, platform = process.platform, arch = process.arch, exists = file => {
  try { accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return statSync(file).isFile(); } catch { return false; }
}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const managed = codexInstallOptions(env, platform, arch).executable;
  if (platform === 'win32') {
    let candidate;
    try { candidate = findWindowsCodex(env, arch, exists); }
    catch (error) {
      if (exists(managed)) return managed;
      throw Object.assign(error, { codexMissing: true });
    }
    if (candidate !== 'codex.exe' && (exists(candidate) || !/[\\/]/.test(candidate))) return candidate;
  } else {
    const requested = env.CODEX_BIN || 'codex';
    if (/[\\/]/.test(requested) && exists(paths.resolve(requested))) return paths.resolve(requested);
    if (!/[\\/]/.test(requested)) {
      for (const dir of (env.PATH || '').split(paths.delimiter).filter(Boolean)) {
        const candidate = paths.resolve(dir, requested);
        if (exists(candidate)) return candidate;
      }
    }
  }
  if (exists(managed)) return managed;
  throw Object.assign(new Error('Codex CLI was not found. Install Codex and sign in with ChatGPT.'), { codexMissing: true });
}

export class Codex extends EventEmitter {
  constructor(cwd) {
    super();
    this.cwd = cwd;
    this.nextId = 0;
    this.pending = new Map();
  }

  async connect() {
    if (this.connection) return this.connection;
    this.connection = this.open().catch(error => { this.connection = null; throw error; });
    return this.connection;
  }

  async open() {
    const executable = resolveCodex();
    const child = spawn(executable, ['app-server', '--stdio'], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderr = '';
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    child.on('error', error => this.disconnected(error.code === 'ENOENT' ? Object.assign(new Error('Codex CLI was not found. Install Codex and sign in with ChatGPT.'), { codexMissing: true }) : error));
    child.on('exit', () => this.disconnected(new Error('Codex stopped. Restart the app or check your Codex installation.')));
    createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else if (message.id !== undefined) {
        // No hidden approvals: image jobs cannot execute arbitrary external tools.
        if (message.method.endsWith('/requestApproval')) {
          this.send({ id: message.id, result: { decision: 'decline' } });
        } else {
          this.send({ id: message.id, error: { code: -32601, message: 'Interactive requests are unavailable in Concept Graph.' } });
        }
      } else {
        if (message.method === 'account/login/completed' && message.params?.loginId === this.loginId && this.loginId) {
          this.finishChatGPTLogin(message.params.success === true ? 'completed' : this.cancellingLoginId === this.loginId ? 'cancelled' : 'failed');
        }
        if (message.method === 'account/updated') this.emit('account-updated');
        if (message.method === 'account/rateLimits/updated') this.emit('limits-changed');
        this.emit('notification', message);
      }
    });
    await this.request('initialize', {
      clientInfo: { name: 'concept_graph', title: 'Concept Graph', version: '0.1.1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.send({ method: 'initialized' });
    return this.status();
  }

  disconnected(error) {
    this.connection = null;
    if (this.loginId) this.finishChatGPTLogin('disconnected');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('disconnected', error);
  }

  send(value) {
    if (!this.child?.stdin.writable) throw new Error('Codex is not connected.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }

  request(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not respond to ${method}.`));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async status() {
    const [capabilities, { account }] = await Promise.all([
      this.request('modelProvider/capabilities/read'), this.request('account/read', { refreshToken: false }),
    ]);
    return {
      connected: true, signedIn: account?.type === 'chatgpt',
      imageGeneration: capabilities.imageGeneration, authType: account?.type || null,
    };
  }

  async rateLimits() {
    return normalizeRateLimits(await this.request('account/rateLimits/read'));
  }

  async models() {
    await this.connect();
    const models = [], cursors = new Set();
    let cursor;
    do {
      const result = await this.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data)) throw new Error('Codex returned an invalid model list.');
      for (const item of result.data) {
        const id = item?.model || item?.id;
        if (item?.hidden || typeof id !== 'string' || !/^[\w.\/:+-]{1,128}$/.test(id)) continue;
        const supportedReasoningEfforts = (Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [])
          .filter(option => typeof option?.reasoningEffort === 'string' && /^[a-z0-9_-]{1,32}$/.test(option.reasoningEffort))
          .map(option => ({ reasoningEffort: option.reasoningEffort, description: typeof option.description === 'string' ? option.description.slice(0, 500) : '' }));
        models.push({ id, displayName: typeof item.displayName === 'string' ? item.displayName.slice(0, 160) : id,
          supportedReasoningEfforts, defaultReasoningEffort: typeof item.defaultReasoningEffort === 'string' ? item.defaultReasoningEffort : null, isDefault: item.isDefault === true });
      }
      cursor = result.nextCursor;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 100)) throw new Error('Codex returned invalid model pagination.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { models };
  }

  async imageWorkerConfig() {
    const result = await this.request('config/read', { cwd: this.cwd, includeLayers: false });
    const config = result?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Could not isolate image generation: Codex returned an invalid configuration.');
    const servers = config.mcp_servers ?? {};
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Could not isolate image generation: Codex returned invalid MCP settings.');
    // Overrides are local to this thread; keep the user's provider and sign-in unchanged.
    return {
      'features.multi_agent': false, 'features.memories': false, 'features.apps': false,
      'features.shell_tool': false, 'features.plugins': false,
      'features.multi_agent_v2': false, 'features.collab': false, 'features.memory_tool': false,
      'features.browser_use': false, 'features.computer_use': false, 'features.js_repl': false,
      'features.code_mode': false, 'features.code_mode_only': false,
      'features.model_catalog_in_context': false,
      'features.skip_host_skill_discovery': true, 'features.skill_search': false,
      'skills.include_instructions': false, 'skills.bundled.enabled': false,
      'cloud.skills.enabled': false, 'orchestrator.mcp.enabled': false,
      'project_doc_max_bytes': 0, 'include_apps_instructions': false,
      'include_collaboration_mode_instructions': false, 'include_environment_context': false,
      'web_search': 'disabled', 'tools.update_plan.enabled': false,
      mcp_servers: Object.fromEntries(Object.keys(servers).map(name => [name, { enabled: false }])),
    };
  }

  async startChatGPTLogin() {
    if (this.loginStarting || this.loginId) throw new Error('A Codex sign-in is already in progress.');
    this.loginStarting = true;
    try {
      await this.connect();
      const result = await this.request('account/login/start', { type: 'chatgpt' });
      let login;
      try { login = validateChatGPTLogin(result); }
      catch (error) {
        if (typeof result?.loginId === 'string' && loginIdPattern.test(result.loginId)) await this.request('account/login/cancel', { loginId: result.loginId }).catch(() => {});
        throw error;
      }
      this.loginId = login.loginId;
      this.loginTimer = setTimeout(() => {
        if (this.loginId !== login.loginId) return;
        this.finishChatGPTLogin('expired');
        this.request('account/login/cancel', { loginId: login.loginId }).catch(() => {});
      }, loginTimeoutMs);
      this.loginTimer.unref();
      return login;
    } finally { this.loginStarting = false; }
  }

  async cancelChatGPTLogin(loginId) {
    if (!this.loginId || loginId !== this.loginId) throw new Error('No matching Codex sign-in is in progress.');
    if (this.cancellingLoginId) throw new Error('Codex sign-in cancellation is already in progress.');
    this.cancellingLoginId = loginId;
    try {
      await this.request('account/login/cancel', { loginId });
      if (this.loginId === loginId) this.finishChatGPTLogin('cancelled');
    } finally { this.cancellingLoginId = null; }
  }

  finishChatGPTLogin(reason) {
    clearTimeout(this.loginTimer);
    this.loginTimer = null;
    this.loginId = null;
    this.emit('login-completed', { success: reason === 'completed', reason });
  }

  async generate({ prompt, images, model, effort, onProgress, onImage, onDiagnostic, signal }) {
    await this.connect();
    const status = await this.status();
    if (!status.signedIn) throw new Error('Sign in to Codex with ChatGPT first: run codex login in Terminal. API-key billing is not used by this app.');
    if (!status.imageGeneration) throw new Error('Your Codex provider does not expose built-in image generation.');
    if (signal?.aborted) throw new Error('Cancelled.');
    if (model && effort) {
      const selected = (await this.models()).models.find(item => item.id === model);
      if (!selected || !selected.supportedReasoningEfforts.some(option => option.reasoningEffort === effort)) throw new Error('The selected model and reasoning effort are not supported by this Codex installation.');
    }
    const workerConfig = await this.imageWorkerConfig();
    const { thread, model: resolvedModel, reasoningEffort } = await this.request('thread/start', {
      cwd: this.cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'workspace-write',
      ...(model ? { model } : {}),
      // A global effort such as "ultra" otherwise overrides the turn effort (it ran at "max").
      config: { ...workerConfig, ...(effort ? { model_reasoning_effort: effort } : {}) }, developerInstructions: '',
      baseInstructions: 'Generate actual images for Concept Graph with the native image tool, using only the supplied text and images. The final request takes priority. Use separate tool calls for separate images; make a collage only if requested. Do not use other tools, API keys, external services, SVG, code or placeholders; do not inspect unrelated files or spawn agents. If generation fails, briefly report the available reason. For multiple images or when useful, add exactly one line [[CG_CAPTION:Front view]] to each image tool prompt, replacing Front view with a specific caption in the final request language (at most 120 characters). This is app metadata: do not render the marker or caption in the image unless the user requests that text.',
    });
    onDiagnostic?.({ type: 'thread', model: resolvedModel, effort: reasoningEffort });
    onDiagnostic?.({ type: 'worker_context', text: 'Skills, plugins, project instructions and configured MCP servers are disabled for this worker. Required Codex and host instructions may remain.' });
    if (!model && effort && resolvedModel) {
      try {
        const selected = (await this.models()).models.find(item => item.id === resolvedModel);
        if (!selected || !selected.supportedReasoningEfforts.some(option => option.reasoningEffort === effort)) throw new Error('The selected reasoning effort is not supported by the current Codex model.');
      } catch (error) {
        this.request('thread/unsubscribe', { threadId: thread.id }).catch(() => {});
        throw error;
      }
    }
    let turnId;
    let text = '';
    let imageIssue = '';
    let work = Promise.resolve();
    const seen = new Set();
    const agentDeltas = new Set();
    const diagnosticError = (error, retry = false) => {
      const info = error?.codexErrorInfo;
      const code = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : '';
      const message = typeof error?.message === 'string' ? error.message
        .replace(/https?:\/\/\S+/gi, '[URL]')
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\b(?:sk|sess|api)[-_][a-z0-9_-]{8,}/gi, '[redacted]')
        .replace(/(?:\/[\w.-]+){2,}/g, '[path]').slice(0, 1000) : 'Codex reported an error.';
      return `${code && /^[a-zA-Z0-9_-]{1,80}$/.test(code) ? `${code}: ` : ''}${message}${retry ? ' (retrying)' : ''}`;
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        this.off('notification', receive);
        this.off('disconnected', disconnected);
        signal?.removeEventListener('abort', cancel);
        this.request('thread/unsubscribe', { threadId: thread.id }).catch(() => {});
      };
      const finish = async error => {
        if (settled) return;
        settled = true;
        cleanup();
        try { await work; } catch (failure) { error ||= failure; }
        if (error) reject(error);
        else if (!seen.size) reject(new Error(imageIssue ? imageIssue + (text.trim() ? ` Codex replied: ${text.trim().slice(0, 300)}` : '') : text.trim() || 'Codex completed without returning an image. Try a more explicit generation prompt.'));
        else resolve({ text, count: seen.size });
      };
      const cancel = () => {
        if (turnId) this.request('turn/interrupt', { threadId: thread.id, turnId }).catch(() => {});
        finish(new Error('Cancelled.'));
      };
      const disconnected = error => finish(error);
      const timeout = setTimeout(() => {
        if (turnId) this.request('turn/interrupt', { threadId: thread.id, turnId }).catch(() => {});
        finish(new Error('Generation timed out after 20 minutes.'));
      }, 20 * 60 * 1000);
      const receive = ({ method, params = {} }) => {
        if (params.threadId !== thread.id) return;
        if (method === 'item/agentMessage/delta') {
          text = (text + (params.delta || '')).slice(0, 4000);
          if (params.delta) agentDeltas.add(params.itemId);
          onDiagnostic?.({ type: 'agent_delta', itemId: params.itemId, text: params.delta });
        }
        if (method === 'item/reasoning/summaryTextDelta') onDiagnostic?.({ type: 'summary_delta', itemId: params.itemId, text: params.delta });
        if (method === 'model/rerouted') onDiagnostic?.({ type: 'model_rerouted', from: params.fromModel, to: params.toModel });
        if (method === 'thread/tokenUsage/updated') onDiagnostic?.({ type: 'usage', usage: params.tokenUsage?.total });
        if (method === 'item/started') {
          onProgress?.(params.item?.type === 'imageGeneration' ? 'Generating image…' : 'Preparing your image…');
          if (params.item?.type === 'imageGeneration') onDiagnostic?.({ type: 'image_started' });
        }
        if (method === 'item/completed' && params.item?.type === 'agentMessage') {
          if (!agentDeltas.has(params.item.id) && typeof params.item.text === 'string') text = (text + params.item.text).slice(0, 4000);
          onDiagnostic?.({ type: 'agent_completed', itemId: params.item.id, text: params.item.text });
        }
        if (method === 'item/completed' && params.item?.type === 'imageGeneration') {
          const item = params.item;
          const output = {
            status: typeof item.status === 'string' && /^[a-zA-Z_-]{1,32}$/.test(item.status) ? item.status : 'unknown',
            hasInlineResult: typeof item.result === 'string' && item.result.length > 0,
            hasSavedPath: typeof item.savedPath === 'string' && item.savedPath.length > 0,
            hasFileId: typeof item.fileId === 'string' && item.fileId.length > 0,
          };
          const outputSummary = `status=${output.status}; inline=${output.hasInlineResult}; saved=${output.hasSavedPath}; fileId=${output.hasFileId}`;
          if (item.failure) {
            const failure = typeof item.failure.type === 'string' && /^[a-zA-Z_-]{1,80}$/.test(item.failure.type) ? item.failure.type : 'Unknown failure';
            onDiagnostic?.({ type: 'image_failed', text: `${failure}; ${outputSummary}`, ...output });
            imageIssue = item.failure.type === 'usageLimitExceeded' ? 'Your Codex image usage limit has been reached. Try again after it resets.' : `The image tool reported a failure (${failure}).`;
            if (item.failure.type === 'usageLimitExceeded') finish(new Error(imageIssue));
            return;
          }
          if (output.status === 'failed') {
            // Codex gives no reason here; in practice this is almost always a content-policy refusal.
            imageIssue = 'The image generator refused this request. This usually means it was blocked by OpenAI content rules (for example, sexual or violent content). Try rephrasing it.';
            onDiagnostic?.({ type: 'image_failed', text: `${imageIssue} ${outputSummary}`, ...output });
            return;
          }
          if (!output.hasSavedPath && !output.hasInlineResult) {
            imageIssue = output.hasFileId
              ? 'Codex returned a file ID without image bytes or a local file. This image output format is not supported by this app yet.'
              : 'The image tool finished without returning image bytes, a local file, or a file ID. Codex did not report a failure reason.';
            onDiagnostic?.({ type: 'image_completed', text: `${imageIssue} ${outputSummary}`, ...output });
            return;
          }
          onDiagnostic?.({ type: 'image_completed', text: outputSummary, ...output });
          if (!seen.has(item.id)) {
            seen.add(item.id);
            work = work.then(() => onImage(item));
            work.catch(error => finish(error));
          }
        }
        if (method === 'turn/completed') {
          const turn = params.turn;
          onDiagnostic?.({ type: 'turn_completed', text: typeof turn.status === 'string' ? turn.status : 'unknown' });
          if (turn.error) onDiagnostic?.({ type: 'error', text: diagnosticError(turn.error) });
          finish(turn.status === 'completed' ? null : new Error(turn.error?.message || (turn.status === 'interrupted' ? 'Cancelled.' : 'Generation failed.')));
        }
        if (method === 'error') {
          onDiagnostic?.({ type: 'error', text: diagnosticError(params.error, params.willRetry) });
          if (!params.willRetry) finish(new Error(params.error?.message || 'Codex generation failed.'));
        }
      };
      this.on('notification', receive);
      this.on('disconnected', disconnected);
      signal?.addEventListener('abort', cancel, { once: true });
      onDiagnostic?.({ type: 'turn_started' });
      this.request('turn/start', {
        threadId: thread.id,
        ...(model ? { model } : {}), ...(effort ? { effort } : {}),
        input: [
          { type: 'text', text: prompt, text_elements: [] },
          ...images.map(path => ({ type: 'localImage', path })),
        ],
      }).then(({ turn }) => { turnId = turn.id; if (signal?.aborted) cancel(); }).catch(finish);
    });
  }

  close() { this.child?.kill(); }
}

const version = '0.163.0';
const pins = {
  'darwin-arm64': ['aarch64-apple-darwin', 'b0344fc2e41f15e0071147e5869008047b8ff4bf2c4a8897975d3bae3f103b34'],
  'darwin-x64': ['x86_64-apple-darwin', '0c182d6194da7003943678dc87866b54b3dee719edaf8d092f304affbc6b57d1'],
  'win32-x64': ['x86_64-pc-windows-msvc', '901028b285614a9974f431f9d9f6534b3e5ed8d62eba4ba64f4762c00f040522'],
};
const hosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const maxBytes = 256 * 1024 * 1024;
const run = promisify(execFile);
const envValue = (env, name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

export function codexInstallOptions(env = process.env, platform = process.platform, arch = process.arch) {
  const win = platform === 'win32', paths = win ? path.win32 : path.posix;
  const pin = pins[`${platform}-${win && ['x64', 'arm64'].includes(arch) ? 'x64' : arch}`];
  const home = win ? envValue(env, 'USERPROFILE') || homedir() : env.HOME || homedir();
  const root = paths.resolve(env.CONCEPT_GRAPH_CODEX_INSTALL_DIR || (win
    ? paths.join(envValue(env, 'LOCALAPPDATA') || paths.join(home, 'AppData', 'Local'), 'Concept Graph', 'codex')
    : paths.join(paths.dirname(env.CONCEPT_GRAPH_DESKTOP_SETTINGS || paths.join(home, 'Library/Application Support/Concept Graph Settings/storage.json')), 'codex-cli')));
  const directory = paths.join(root, version + (win ? '-win-x64' : ''));
  return { supported: !!pin, root, directory, executable: paths.join(directory, 'bin', win ? 'codex.exe' : 'codex'),
    platform, sha256: pin?.[1], url: pin ? `https://github.com/openai/codex/releases/download/rust-v${version}/codex-package-${pin[0]}.tar.gz` : null,
    tar: win ? paths.join(envValue(env, 'SYSTEMROOT') || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar' };
}

function usableCodex(file, platform = process.platform) {
  try {
    if (!lstatSync(file).isFile()) return false;
    accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

export class CodexInstaller {
  constructor({ options = codexInstallOptions(), fetch: fetchArchive = globalThis.fetch, onInstalled = () => {} } = {}) {
    this.options = options;
    this.fetch = fetchArchive;
    this.onInstalled = onInstalled;
    this.progress = { supported: options.supported, state: 'idle', received: 0, total: null, error: null };
  }

  status() { return { ...this.progress }; }

  start() {
    if (this.completion || this.progress.state === 'done') return this.status();
    this.progress = { supported: this.options.supported, state: 'downloading', received: 0, total: null, error: null };
    this.completion = this.install().then(() => { this.progress.state = 'done'; }, error => {
      this.progress.state = 'error'; this.progress.error = error.message;
    }).finally(() => { this.completion = null; });
    return this.status();
  }

  async install() {
    const { supported, root, directory, executable, platform, sha256, tar } = this.options;
    if (!supported) throw new Error('Automatic Codex installation is not supported on this computer.');
    await mkdir(root, { recursive: true });
    if (!(await lstat(root)).isDirectory()) throw new Error('The Codex installation folder must be a regular directory.');
    const existing = await lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing) {
      if (!existing.isDirectory() || !usableCodex(executable, platform) || !(await lstat(path.join(directory, 'bin'))).isDirectory()) {
        throw new Error('An incomplete app-managed Codex installation already exists. It was not overwritten.');
      }
      await this.onInstalled();
      return;
    }
    const temporary = await mkdtemp(path.join(root, '.install-'));
    let reserved = false;
    try {
      const archive = path.join(temporary, 'codex.tar.gz');
      let url = new URL(this.options.url), response;
      const signal = AbortSignal.timeout(10 * 60 * 1000);
      for (let redirects = 0; ; redirects++) {
        if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) throw new Error('The Codex download host is not allowed.');
        response = await this.fetch(url.href, { redirect: 'manual', signal });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        if (redirects >= 5 || !response.headers.get('location')) throw new Error('Too many or invalid Codex download redirects.');
        url = new URL(response.headers.get('location'), url);
      }
      try {
        if (!response.ok || !response.body) throw new Error(`Codex download failed (${response.status}).`);
        const length = response.headers.get('content-length');
        const total = length === null ? null : Number(length);
        if (total !== null && (!Number.isSafeInteger(total) || total <= 0 || total > maxBytes)) throw new Error('The Codex download has an unexpected size.');
        this.progress.total = total;
        const hash = createHash('sha256'), file = await open(archive, 'wx', 0o600);
        try {
          for await (const chunk of response.body) {
            this.progress.received += chunk.length;
            if (this.progress.received > maxBytes || (total !== null && this.progress.received > total)) throw new Error('The Codex download has an unexpected size.');
            hash.update(chunk);
            await file.writeFile(chunk);
          }
        } finally { await file.close(); }
        if (!this.progress.received || (total !== null && this.progress.received !== total)) throw new Error('The Codex download is incomplete.');
        if (hash.digest('hex') !== sha256) throw new Error('The Codex download failed its checksum security check. Nothing was installed.');
      } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => {}); }
      this.progress.state = 'installing';
      const stage = path.join(temporary, 'package');
      await mkdir(stage);
      await run(tar, ['-xzf', archive, '-C', stage], { windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 });
      if (!(await lstat(path.join(stage, 'bin'))).isDirectory() || !usableCodex(path.join(stage, 'bin', path.basename(executable)), platform)) throw new Error('The Codex package is incomplete.');
      // Reserve the destination so even an existing empty installation is never replaced.
      if (platform !== 'win32') {
        await mkdir(directory);
        reserved = true;
      }
      await rename(stage, directory);
      reserved = false;
      await this.onInstalled();
    } finally {
      if (reserved) await rm(directory, { recursive: true, force: true });
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
