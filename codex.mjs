import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

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
    const child = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--stdio'], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderr = '';
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    child.on('error', error => this.disconnected(error));
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

  async generate({ prompt, images, onProgress, onImage, signal }) {
    await this.connect();
    const status = await this.status();
    if (!status.signedIn) throw new Error('Sign in to Codex with ChatGPT first: run codex login in Terminal. API-key billing is not used by this app.');
    if (!status.imageGeneration) throw new Error('Your Codex provider does not expose built-in image generation.');
    if (signal?.aborted) throw new Error('Cancelled.');
    const { thread } = await this.request('thread/start', {
      cwd: this.cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'workspace-write',
      config: { 'features.multi_agent': false, 'features.memories': false, 'features.apps': false, 'features.shell_tool': false },
      baseInstructions: 'You are the image-generation worker for Concept Graph. Fulfill the final image request using the native image generation tool. Use the supplied text and attached images as context. For multiple requested images, generate separate images with separate tool calls, never a collage unless requested. Return actual generated images. Never substitute SVG, code, web search, external APIs, or placeholder images. Do not use API keys. Do not inspect unrelated files or spawn agents. Use only the provided images. If you cannot generate, explain the error briefly.',
    });
    let turnId;
    let text = '';
    let work = Promise.resolve();
    const seen = new Set();
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
        else if (!seen.size) reject(new Error(text.trim() || 'Codex completed without returning an image. Try a more explicit generation prompt.'));
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
        if (method === 'item/agentMessage/delta') text += params.delta || '';
        if (method === 'item/started') {
          onProgress?.(params.item?.type === 'imageGeneration' ? 'Generating image…' : 'Preparing your image…');
        }
        if (method === 'item/completed' && params.item?.type === 'imageGeneration') {
          const item = params.item;
          if (item.failure) {
            finish(new Error(item.failure.type === 'usageLimitExceeded' ? 'Your Codex image usage limit has been reached. Try again after it resets.' : 'Image generation failed.'));
            return;
          }
          if ((item.savedPath || item.result) && !seen.has(item.id)) {
            seen.add(item.id);
            work = work.then(() => onImage(item));
            work.catch(error => finish(error));
          }
        }
        if (method === 'turn/completed') {
          const turn = params.turn;
          finish(turn.status === 'completed' ? null : new Error(turn.error?.message || (turn.status === 'interrupted' ? 'Cancelled.' : 'Generation failed.')));
        }
        if (method === 'error' && !params.willRetry) finish(new Error(params.error?.message || 'Codex generation failed.'));
      };
      this.on('notification', receive);
      this.on('disconnected', disconnected);
      signal?.addEventListener('abort', cancel, { once: true });
      this.request('turn/start', {
        threadId: thread.id,
        input: [
          { type: 'text', text: prompt, text_elements: [] },
          ...images.map(path => ({ type: 'localImage', path })),
        ],
      }).then(({ turn }) => { turnId = turn.id; if (signal?.aborted) cancel(); }).catch(finish);
    });
  }

  close() { this.child?.kill(); }
}
