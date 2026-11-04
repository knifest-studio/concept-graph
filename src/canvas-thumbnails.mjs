// Thumbnails are an in-memory rendering cache. Originals remain the source of truth.
// Small ones serve zoomed-out cards (a 310px card is under 125px on screen there); large ones serve normal zoom.
export const thumbnailWidths = Object.freeze({ small: 256, large: 1024 });
export const thumbnailWidth = small => small ? thumbnailWidths.small : thumbnailWidths.large;
// Cloud boards keep each image's small thumbnail next to the original: the first viewer stores it, and everyone else
// zooming out over the board downloads that instead of the original.
export const sharedPreviews = { enabled: false };
const previewUrl = source => /^\/assets\/[\da-f-]{36}\.(?:png|jpg|webp)$/.test(source) ? `${source}/thumb` : null;

export async function createCanvasThumbnail(source, options = {}) {
  if (/\.gif(?:[?#]|$)/i.test(source)) return { src: source };
  const fetchImage = options.fetchImage || globalThis.fetch;
  const decode = options.decode || globalThis.createImageBitmap;
  const document = options.document || globalThis.document;
  const makeURL = options.makeURL || (blob => URL.createObjectURL(blob));
  if (!fetchImage || !decode || !document) return { src: source };

  let bitmap;
  const maximumWidth = options.maximumWidth || thumbnailWidths.large;
  const preview = (options.shared ?? sharedPreviews.enabled) && maximumWidth <= thumbnailWidths.small && previewUrl(source);
  try {
    if (preview) {
      const stored = await fetchImage(preview).catch(() => null);
      if (stored?.status === 200) {
        const blob = await stored.blob();
        bitmap = await decode(blob, { imageOrientation: 'from-image' });
        return { src: makeURL(blob), aspectRatio: `${bitmap.width} / ${bitmap.height}`, generated: true };
      }
    }
    // A small thumbnail is made from a cached large one when there is one, without downloading the original again.
    const input = options.from || source;
    const helper = /^http:\/\/127\.0\.0\.1:43170\//.test(input);
    const response = await fetchImage(input, helper
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
    // Stored for teammates without waiting; the server keeps only the first and ignores formats it does not take.
    if (preview) fetchImage(preview, { method: 'PUT', headers: { 'Content-Type': thumbnail.type }, body: thumbnail }).catch(() => {});
    return { src: makeURL(thumbnail), aspectRatio, generated: true };
  } catch {
    return { src: source };
  } finally {
    bitmap?.close?.();
  }
}

const otherWidth = width => width === thumbnailWidths.small ? thumbnailWidths.large : thumbnailWidths.small;

export class CanvasThumbnailCache {
  // `maxEntries` bounds the finished, unused thumbnails kept per size; a number applies to every size.
  constructor({ create = createCanvasThumbnail, revoke = value => URL.revokeObjectURL(value), concurrency = 3, maxEntries = { [thumbnailWidths.small]: 1500, [thumbnailWidths.large]: 160 } } = {}) {
    this.create = create;
    this.revoke = revoke;
    this.concurrency = concurrency;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.counts = new Map();
    this.aspects = new Map();
    this.queue = [];
    this.running = 0;
  }

  key(source, width) { return width === thumbnailWidths.large ? source : `${width} ${source}`; }
  limit(width) { return typeof this.maxEntries === 'number' ? this.maxEntries : this.maxEntries[width] ?? 256; }

  // A finished thumbnail, read synchronously so a card that scrolls back into view shows it in its first frame.
  peek(source, width = thumbnailWidths.large) {
    const entry = this.entries.get(this.key(source, width));
    return entry?.done ? entry.result : undefined;
  }

  // The requested size, or the other size while it is being made.
  shown(source, width = thumbnailWidths.large) { return this.peek(source, width) || this.peek(source, otherWidth(width)); }
  aspect(source) { return this.aspects.get(source); }

  // Keeps every finished size of `source` from eviction while a card may display it.
  hold(source) {
    const entries = [thumbnailWidths.small, thumbnailWidths.large].map(width => this.entries.get(this.key(source, width))).filter(entry => entry?.done);
    entries.forEach(entry => entry.references++);
    let released = false;
    return () => { if (released) return; released = true; entries.forEach(entry => entry.references--); this.evict(); };
  }

  acquire(source, width = thumbnailWidths.large) {
    const key = this.key(source, width);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, source, width, references: 0, done: false };
      entry.ready = new Promise(resolve => { entry.resolve = resolve; });
      this.entries.set(key, entry);
      this.counts.set(width, (this.counts.get(width) || 0) + 1);
      this.queue.push(entry);
    } else {
      this.entries.delete(key);
      this.entries.set(key, entry);
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

  remove(entry) {
    this.entries.delete(entry.key);
    this.counts.set(entry.width, this.counts.get(entry.width) - 1);
  }

  pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const entry = this.queue.shift();
      if (!entry.references) {
        this.remove(entry);
        entry.resolve({ src: entry.source });
        continue;
      }
      this.running++;
      // Hold the larger thumbnail a small one is drawn from, so it cannot be revoked mid-read.
      const larger = entry.width < thumbnailWidths.large && this.entries.get(this.key(entry.source, thumbnailWidths.large));
      const from = larger?.done && larger.result.generated ? larger : null;
      if (from) from.references++;
      Promise.resolve().then(() => this.create(entry.source, { maximumWidth: entry.width, ...(from ? { from: from.result.src } : {}) })).catch(() => ({ src: entry.source })).then(result => {
        if (from) from.references--;
        entry.result = result;
        entry.done = true;
        if (result.aspectRatio && !this.aspects.has(entry.source)) this.aspects.set(entry.source, result.aspectRatio);
        this.running--;
        entry.resolve(result);
        this.evict();
        this.pump();
      });
    }
  }

  // Oldest unused thumbnails go first (acquire moves an entry to the end).
  evict() {
    if (![...this.counts].some(([width, count]) => count > this.limit(width))) return;
    for (const entry of this.entries.values()) {
      if (this.counts.get(entry.width) <= this.limit(entry.width) || !entry.done || entry.references) continue;
      this.remove(entry);
      if (entry.result.generated) this.revoke(entry.result.src);
    }
  }
}

// A card that swaps between its full and zoomed-out form can still be loading an evicted URL, so revoke it a little later.
export const canvasThumbnailCache = new CanvasThumbnailCache({ revoke: value => setTimeout(() => URL.revokeObjectURL(value), 10000) });
