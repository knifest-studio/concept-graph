import { privateTextSelector, blockedMediaSelector, privateReplayEvent } from './analytics-privacy.mjs';
import { record } from '@rrweb/record';
import { sessionReplayBytes } from './analytics-core.mjs';

// Every upload costs about 7 D1 row writes, so a chunk carries up to 1 MiB of raw events as its own gzip stream, well
// under the server's 2 MiB body and decompressed bounds. Leaving the page can only beacon, and all keepalive bodies in
// flight share 64 KiB (https://fetch.spec.whatwg.org/#http-network-or-cache-fetch), so those pieces stay small and raw.
export const chunkBytes = 1024 * 1024, beaconBytes = 48 * 1024, keepaliveBytes = 64 * 1024;
// A visible tab uploads at most every 2 minutes, about 210 rows per tab-hour, half of a 1-minute timer. That still fits
// what leaving the page can beacon: on Nov 16 a quiet visible tab gathered 4 KB in 2 minutes at the median and 30 KB at
// p90, under one 48 KB piece, while 5 minutes reached 110 KB at p90 and would lose the tail of a closed tab. A busy tab
// uploads at every MiB anyway, so the timer skips a period in which a chunk filled up.
export const flushMs = 2 * 60000;
const gzip = async bytes => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());

export async function recordSession(session, enabled, state) {
  const encoder = new TextEncoder(), abort = new AbortController(), path = seq => `/api/analytics/replay/${session}/${seq}`;
  // raw: encoded events without a seq yet; due: how much of it the last flush asked for; compressing: the batch being
  // gzipped; queued: final bodies in seq order, beaconed ones too, kept until an upload confirms them; full: the session
  // quota is reached, so only queued chunks still go up; busy: a chunk filled up since the last timer tick.
  let raw = [], rawBytes = 0, dueBytes = 0, compressing = null, queued = [], stopped = false, full = false, busy = false, pumping = false;
  state.replayRawBytes ??= 0;
  const take = limit => {
    const bytes = new Uint8Array(Math.min(limit, rawBytes));
    for (let filled = 0; filled < bytes.length;) {
      const part = raw[0].subarray(0, bytes.length - filled);
      bytes.set(part, filled); filled += part.length;
      if (part.length === raw[0].length) raw.shift(); else raw[0] = raw[0].subarray(part.length);
    }
    rawBytes -= bytes.length; dueBytes = Math.max(0, dueBytes - bytes.length);
    return bytes;
  };
  const untake = bytes => { raw.unshift(bytes); rawBytes += bytes.length; };
  // A seq is given only to a final body. The session quota counts body bytes, as the server does, and raw bytes too, as
  // before compression: the admin player parses a whole recording into memory, and gzip would let it grow 8-10 times.
  // At the quota the recording ends, but chunks that already have a seq still go up.
  const over = (sent, bytes) => {
    if (state.replayBytes + sent <= sessionReplayBytes && state.replayRawBytes + bytes <= sessionReplayBytes) return false;
    full = true; stopRecord?.(); stopRecord = null; raw = []; rawBytes = dueBytes = 0;
    return true;
  };
  const next = (sent, bytes) => { state.replayBytes += sent; state.replayRawBytes += bytes; return state.replaySeq++; };
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (!stopped && enabled()) {
        // Gzip finishes before a chunk is queued, so no upload can take one that was meant to be compressed.
        if (rawBytes >= chunkBytes || dueBytes) {
          const bytes = compressing = take(chunkBytes);
          let body = bytes, encoding = 'identity';
          if (typeof CompressionStream === 'function') { try { body = await gzip(bytes); encoding = 'gzip'; } catch {} }
          if (compressing !== bytes) continue; // Meanwhile the unload path took these bytes, or recording stopped.
          compressing = null;
          if (over(body.length, bytes.length)) continue;
          queued.push({ seq: next(body.length, bytes.length), body, encoding });
          continue;
        }
        if (!queued.length) break;
        const chunk = queued[0];
        try {
          const response = await fetch(path(chunk.seq), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': chunk.encoding }, body: chunk.body, signal: abort.signal });
          if (!response.ok) { if ([401, 403, 413].includes(response.status)) stop(); break; }
          if (queued[0] === chunk) queued.shift();
        } catch { break; }
      }
    } finally { pumping = false; }
  };
  const flush = () => { dueBytes = rawBytes; void pump(); };
  let stopRecord;
  const stop = () => { stopped = true; stopRecord?.(); abort.abort(); clearInterval(timer); raw = []; rawBytes = dueBytes = 0; compressing = null; queued = []; };
  // Only a visible tab uploads on the timer; analytics.mjs flushes a hidden one once, soon after it is hidden.
  const timer = setInterval(() => { if (!busy && !globalThis.document?.hidden) flush(); busy = false; }, flushMs);
  stopRecord = record({
    emit(event) {
      if (stopped || full || !enabled()) return;
      const bytes = encoder.encode(JSON.stringify(privateReplayEvent(event)) + '\n');
      raw.push(bytes); rawBytes += bytes.length;
      if (rawBytes >= chunkBytes) { busy = true; void pump(); }
      // The full snapshot goes up at once: without it nothing plays, and a tab closed before the first timer tick could
      // only beacon its first 48 KB.
      else if (event.type === 2) flush();
    },
    maskAllInputs: true, maskInputOptions: { password: true }, blockSelector: blockedMediaSelector, maskTextSelector: privateTextSelector, recordCanvas: false, inlineImages: false,
    sampling: { mousemove: 50, scroll: 150, input: 'last' }, collectFonts: false, errorHandler: () => true
  });
  if (stopped || !stopRecord) stop();
  else if (full) stopRecord(); // The quota ran out during the first snapshot, before record() returned.
  return { stop, flush(unload = false) {
    if (!unload) { flush(); return; }
    if (stopped || !enabled()) return;
    // Pagehide only, synchronous: it cannot await gzip or a dynamic import. sendBeacon cannot set Content-Encoding, so it
    // goes in the URL for this authenticated route. A piece the browser refuses gets no seq and stays buffered for the next
    // upload, so a refusal never leaves a gap that would cut the recording short in the player. With nothing recorded since
    // the last upload, nothing is sent.
    let sent = 0;
    const beacon = (seq, body, encoding) => {
      if (sent + body.length > keepaliveBytes) return false;
      const url = `${path(seq)}?encoding=${encoding}`;
      if (navigator.sendBeacon) { if (!navigator.sendBeacon(url, new Blob([body], { type: 'application/octet-stream' }))) return false; }
      else fetch(url, { method: 'POST', body, credentials: 'same-origin', keepalive: true }).catch(() => {});
      sent += body.length;
      return true;
    };
    // Queued chunks come first, once each. Every beaconed body stays queued, since a beacon only says the browser accepted
    // it: if the page survives (back/forward cache), the next upload sends it again, and the server answers a repeat of the
    // same seq, bytes and encoding with 204, writing only its rate-limit row.
    for (const chunk of queued) if (!chunk.beaconed) { if (!beacon(chunk.seq, chunk.body, chunk.encoding)) return; chunk.beaconed = true; }
    if (compressing) { untake(compressing); compressing = null; }
    dueBytes = 0;
    while (rawBytes) {
      const body = take(beaconBytes);
      if (over(body.length, body.length)) return;
      if (!beacon(state.replaySeq, body, 'identity')) { untake(body); return; }
      queued.push({ seq: next(body.length, body.length), body, encoding: 'identity', beaconed: true });
    }
  } };
}
