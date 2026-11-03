// Thumbnails are an in-memory rendering cache. Originals remain the source of truth.
export async function createCanvasThumbnail(source, options = {}) {
  if (/\.gif(?:[?#]|$)/i.test(source)) return { src: source };
  const fetchImage = options.fetchImage || globalThis.fetch;
  const decode = options.decode || globalThis.createImageBitmap;
  const document = options.document || globalThis.document;
  const makeURL = options.makeURL || (blob => URL.createObjectURL(blob));
  if (!fetchImage || !decode || !document) return { src: source };

  let bitmap;
  try {
    const helper = /^http:\/\/127\.0\.0\.1:43170\//.test(source);
    const response = await fetchImage(source, helper
      ? { targetAddressSpace: 'loopback', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }
      : undefined);
    if (!response.ok) return { src: source };
    const blob = await response.blob();
    // Leave GIFs untouched even if the URL does not expose the extension.
    if (blob.type === 'image/gif') return { src: source };
    bitmap = await decode(blob, { imageOrientation: 'from-image' });
    const width = bitmap.width, height = bitmap.height;
    if (!(width > 0 && height > 0)) return { src: source };
    const aspectRatio = `${width} / ${height}`;
    const maximumWidth = options.maximumWidth || 1024;
    if (width <= maximumWidth) return { src: source, aspectRatio };
    const canvas = document.createElement('canvas');
    canvas.width = maximumWidth;
    canvas.height = Math.max(1, Math.round(height * maximumWidth / width));
    const context = canvas.getContext('2d');
    if (!context || !canvas.toBlob) return { src: source, aspectRatio };
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const format = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    const thumbnail = await new Promise(resolve => canvas.toBlob(resolve, format, 0.84));
    if (!thumbnail) return { src: source, aspectRatio };
    return { src: makeURL(thumbnail), aspectRatio, generated: true };
  } catch {
    return { src: source };
  } finally {
    bitmap?.close?.();
  }
}

export class CanvasThumbnailCache {
  constructor({ create = createCanvasThumbnail, revoke = value => URL.revokeObjectURL(value), concurrency = 2, maxEntries = 256 } = {}) {
    this.create = create;
    this.revoke = revoke;
    this.concurrency = concurrency;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.queue = [];
    this.running = 0;
  }

  acquire(source) {
    let entry = this.entries.get(source);
    if (!entry) {
      entry = { source, references: 0, done: false };
      entry.ready = new Promise(resolve => { entry.resolve = resolve; });
      this.entries.set(source, entry);
      this.queue.push(entry);
    } else {
      this.entries.delete(source);
      this.entries.set(source, entry);
    }
    entry.references++;
    this.pump();
    let released = false;
    return { ready: entry.ready, release: () => {
      if (released) return;
      released = true;
      entry.references--;
      this.evict();
    } };
  }

  pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const entry = this.queue.shift();
      if (!entry.references) {
        this.entries.delete(entry.source);
        entry.resolve({ src: entry.source });
        continue;
      }
      this.running++;
      Promise.resolve().then(() => this.create(entry.source)).catch(() => ({ src: entry.source })).then(result => {
        entry.result = result;
        entry.done = true;
        this.running--;
        entry.resolve(result);
        this.evict();
        this.pump();
      });
    }
  }

  evict() {
    for (const [source, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (!entry.done || entry.references) continue;
      this.entries.delete(source);
      if (entry.result.generated) this.revoke(entry.result.src);
    }
  }
}

export const canvasThumbnailCache = new CanvasThumbnailCache();
