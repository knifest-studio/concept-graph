import { YServer } from 'y-partyserver';
import { applyUpdate, encodeStateAsUpdate } from 'yjs';
import { boardStats } from './board-stats.mjs';

const chunkSize = 512 * 1024;

export class BoardRoom extends YServer {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 1000, debounceMaxWait: 5000 };

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
    await this.env.Directory.get(this.env.Directory.idFromName('boards')).updateBoardStats(this.name, { ...stats, updatedAt });
    kv.put('directory:hash', hash);
  }

  async onClose(connection, code, reason, wasClean) {
    super.onClose(connection, code, reason, wasClean);
    // y-partyserver 2.2 debounces saves but does not flush them on close.
    if (![...this.getConnections()].some(item => item.id !== connection.id)) await this.onSave();
  }
}
