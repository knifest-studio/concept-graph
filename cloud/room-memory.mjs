const mb = 1024 * 1024;
export const roomMemoryBudget = 64 * mb;
// One 32 MiB multipart buffer plus stream chunks and the small URL request.
export const videoMemoryBytes = 40 * mb;
export const base64Bytes = bytes => Math.ceil(bytes / 3) * 4;
// Count UTF-8 without allocating another request-sized buffer.
export function requestBytes(text) {
  let bytes = text.length;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 128) continue;
    if (code < 2048) bytes++;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 2; i++; }
    else bytes += 2;
  }
  return bytes;
}
export const expectedOutputBytes = ({ gpt = false, imageSize = '1K', describe = false } = {}) => describe ? mb
  : ((gpt ? { '1K': 4, '2K': 10, '4K': 24 } : { '1K': 1, '2K': 2.5, '4K': 6 })[imageSize] || (gpt ? 4 : 1)) * mb;
// An answer is held as its raw bytes (4/3 of the image as base64) and the decoded image, so three times the image covers
// what the isolate counts. Measured as RSS of a local wrangler dev (Nov 17 2026), reading a 10 MB image costs +45 MB with
// readImageResponse against +79 MB with response.json(); RSS also counts runtime buffers and allocator slack, which the
// half of the 128 MB the budget leaves free absorbs.
export const answerMemoryFactor = 3;
export const callMemoryBytes = (requestBytes, outputBytes) => Math.ceil(requestBytes + answerMemoryFactor * outputBytes);
export const upscaleOutputBytes = ({ nano = false, scale, source } = {}) => nano ? expectedOutputBytes({ imageSize: scale === 4 ? '4K' : '2K' })
  : source ? source.width * source.height * Math.min(scale, 8192 / Math.max(source.width, source.height)) ** 2 * 3 : 8192 ** 2 * 3;
export const model3dMemoryBytes = imageBytes => 4 * Math.min(imageBytes, 8 * mb) + 12 * mb;
export const queueWaitTimeout = runLimit => Math.max(60 * 1000, 14 * 60 * 1000 - runLimit);
export const roomBusy = 'The board is busy with other generations. Run the prompt again in a minute.';

// A primary lease includes one call, so a run can always finish even when FIFO waiters block its extra lanes.
export class MemoryBudget {
  used = 0;
  queue = [];
  constructor(limit = roomMemoryBudget) { this.limit = limit; }

  acquire(bytes, signal) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const entry = { bytes, resolve, signal, abort: () => {
        this.queue.splice(this.queue.indexOf(entry), 1);
        reject(signal.reason);
        this.drain();
      } };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }

  drain() {
    while (this.queue.length) {
      const entry = this.queue[0];
      // An oversized call still runs, but only when it is alone.
      if (this.used && this.used + entry.bytes > this.limit) break;
      this.queue.shift();
      entry.signal?.removeEventListener('abort', entry.abort);
      this.used += entry.bytes;
      let bytes = entry.bytes, released = false;
      entry.resolve({
        // Preparation reserves the temporary copies; once built, retain only the resident body and one call.
        resize: size => { if (!released) { this.used += size - bytes; bytes = size; this.drain(); } },
        release: () => { if (!released) { released = true; this.used -= bytes; this.drain(); } },
      });
    }
  }
}
