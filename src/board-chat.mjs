export const chatReadKey = (board, email) => `concept-graph-chat-read:${board}:${email}`;
export function chatLinks(text) {
  return String(text).split(/(https?:\/\/[^\s<>]+)/g).filter(Boolean).map(text => ({ text, url: /^https?:\/\//.test(text) ? text : null }));
}

// The socket owns delivery; localStorage holds only this person's read cursor, never conversation text.
export class ChatClient {
  constructor({ boardId, email, send, storage, hidden = () => false, sound = () => {}, changed = () => {} }) {
    Object.assign(this, { email, sendWire: send, storage, hidden, sound, changed });
    this.key = chatReadKey(boardId, email); this.lastRead = 0;
    try { const id = Number(storage.getItem(this.key)); if (Number.isSafeInteger(id) && id >= 0) this.lastRead = id; } catch {}
    this.messages = new Map(); this.deleted = new Set(); this.live = new Set(); this.pending = new Map();
    this.latest = this.lastRead; this.snapshot = 0; this.baseUnread = 0; this.open = false; this.bottom = true; this.online = false; this.more = false; this.loading = false; this.error = '';
    this.publish();
  }
  publish() {
    this.state = { messages: [...this.messages.values()].sort((a, b) => a.id - b.id), pending: [...this.pending.values()], unread: this.baseUnread + this.live.size,
      more: this.more, loading: this.loading, error: this.error, online: this.online };
    this.changed(this.state);
  }
  request(before) {
    if (!this.online || this.loading) return;
    this.loading = true; this.error = ''; this.publish();
    this.sendWire({ type: 'chat-history', ...(before ? { before } : {}), after: this.lastRead });
  }
  connected(online) {
    clearTimeout(this.refreshTimer);
    this.online = online; this.loading = false;
    if (online) { this.request(); for (const item of this.pending.values()) if (!item.error) this.sendWire({ type: 'chat-send', ...item }); }
    else { for (const item of this.pending.values()) item.error = 'Connection lost. Retry your message.'; this.publish(); }
  }
  read() {
    if (!this.open || !this.bottom || this.hidden()) return;
    this.lastRead = Math.max(this.lastRead, this.latest); this.baseUnread = 0; this.live.clear();
    try { this.storage.setItem(this.key, String(this.lastRead)); } catch {}
  }
  visible(open, bottom = this.bottom) {
    const before = this.lastRead, unread = this.state.unread;
    this.open = open; this.bottom = bottom; this.read();
    if (before !== this.lastRead || unread !== this.baseUnread + this.live.size) this.publish();
  }
  post(text, nodeId, key = crypto.randomUUID()) {
    const item = { key, text: text.trim(), ...(nodeId ? { nodeId } : {}) };
    this.pending.set(key, item); this.error = ''; this.publish();
    if (this.online) this.sendWire({ type: 'chat-send', ...item });
    else { item.error = 'Connection lost. Retry your message.'; this.publish(); }
    return key;
  }
  retry(key) { const item = this.pending.get(key); if (item) this.post(item.text, item.nodeId, key); }
  receive(value) {
    if (value.type === 'chat-message') {
      const message = value.message, fresh = !this.messages.has(message.id);
      this.messages.set(message.id, this.deleted.has(message.id) ? { ...message, text: '', nodeId: undefined, deleted: true } : message);
      this.latest = Math.max(this.latest, message.id);
      if (value.key) this.pending.delete(value.key);
      if (fresh && !message.deleted && message.author.email !== this.email && message.id > this.lastRead && message.id > this.snapshot) {
        this.live.add(message.id);
        if (!this.open || this.hidden()) this.sound();
      }
      this.read();
    } else if (value.type === 'chat-history') {
      this.loading = false; this.more = value.more; this.latest = Math.max(this.latest, value.latest);
      // A reconnect starts at the newest page, avoiding gaps between old cached and newly fetched history.
      if (!value.before) this.messages = new Map([...this.messages].filter(([id]) => id > value.latest));
      for (const message of value.messages) {
        if (message.deleted) this.deleted.add(message.id);
        this.messages.set(message.id, this.deleted.has(message.id) ? { ...message, text: '', nodeId: undefined, deleted: true } : message);
      }
      if (!value.before) {
        // Reading while a history request is in flight invalidates its unread count; re-count from the new cursor.
        const outdated = value.after !== this.lastRead && value.latest > this.lastRead && !(this.open && this.bottom && !this.hidden());
        if (outdated) { clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => this.request(), 250); }
        else {
          this.snapshot = value.latest; this.baseUnread = value.latest <= this.lastRead ? 0 : value.unread;
          this.live = new Set([...this.live].filter(id => id > this.snapshot && id > this.lastRead));
        }
      }
      this.read();
    } else if (value.type === 'chat-deleted') {
      const message = this.messages.get(value.id), first = !this.deleted.has(value.id);
      this.deleted.add(value.id);
      if (message) this.messages.set(value.id, { ...message, text: '', nodeId: undefined, deleted: true });
      this.live.delete(value.id);
      if (first && value.id > this.lastRead && value.id <= this.snapshot && value.author?.email !== this.email) this.baseUnread = Math.max(0, this.baseUnread - 1);
    } else if (value.type === 'chat-failed') {
      if (value.key && this.pending.has(value.key)) this.pending.get(value.key).error = value.reason;
      else this.error = value.reason;
      if (value.operation === 'chat-history') this.loading = false;
    } else return;
    this.publish();
  }
  destroy() { clearTimeout(this.refreshTimer); this.online = false; this.changed = () => {}; }
}
