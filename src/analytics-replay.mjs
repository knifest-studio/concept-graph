import { privateTextSelector, blockedMediaSelector, privateReplayEvent } from './analytics-privacy.mjs';
import { record } from '@rrweb/record';
import { sessionReplayBytes } from './analytics-core.mjs';

export async function recordSession(session, enabled, state) {
  const encoder = new TextEncoder(), abort = new AbortController();
  let buffer = [], size = 0, queued = [], stopped = false, sending = false, preparing = Promise.resolve();
  // Byte fragments keep even a multi-megabyte initial DOM snapshot below the request cap.
  const prepare = () => {
    if (!buffer.length) return;
    const raw = encoder.encode(buffer.join('')); buffer = []; size = 0;
    for (let offset = 0; offset < raw.length; offset += 48 * 1024) {
      const body = raw.slice(offset, offset + 48 * 1024);
      if (state.replayBytes + body.length > sessionReplayBytes || queued.length >= 1024) { stop(); return; }
      state.replayBytes += body.length;
      const chunk = { seq: state.replaySeq++, body, encoding: 'identity' }; queued.push(chunk);
      preparing = preparing.then(async () => {
        if (stopped || !enabled() || chunk.sending) return;
        if (typeof CompressionStream === 'function') {
          try {
            const compressed = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
            if (!chunk.sending && compressed.length < body.length) { chunk.body = compressed; chunk.encoding = 'gzip'; }
          } catch {}
        }
      });
    }
    preparing = preparing.then(() => send()).catch(() => { stop(); });
  };
  const send = async (unload = false) => {
    if (stopped || !enabled()) return;
    if (unload) {
      // sendBeacon cannot set Content-Encoding, so put it in the URL for this authenticated route.
      for (const chunk of queued) {
        chunk.sending = true;
        const url = `/api/analytics/replay/${session}/${chunk.seq}?encoding=${chunk.encoding}`;
        if (!navigator.sendBeacon?.(url, new Blob([chunk.body], { type: 'application/octet-stream' }))) fetch(url, { method: 'POST', body: chunk.body, credentials: 'same-origin', keepalive: true }).catch(() => {});
      }
      return;
    }
    if (sending) return;
    sending = true;
    try {
      while (queued.length && !stopped && enabled()) {
        const chunk = queued[0]; chunk.sending = true;
        try {
          const response = await fetch(`/api/analytics/replay/${session}/${chunk.seq}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': chunk.encoding }, body: chunk.body, signal: abort.signal });
          if (!response.ok) { if ([401, 403, 413].includes(response.status)) stop(); break; }
          queued.shift();
        } catch { break; }
      }
    } finally { sending = false; }
  };
  let stopRecord;
  const stop = () => { stopped = true; stopRecord?.(); abort.abort(); clearInterval(timer); buffer = []; queued = []; };
  const timer = setInterval(() => { prepare(); void send(); }, 15000);
  stopRecord = record({
    emit(event) { if (stopped || !enabled()) return; const line = JSON.stringify(privateReplayEvent(event)) + '\n'; buffer.push(line); size += line.length; if (size >= 192 * 1024) prepare(); },
    maskAllInputs: true, maskInputOptions: { password: true }, blockSelector: blockedMediaSelector, maskTextSelector: privateTextSelector, recordCanvas: false, inlineImages: false,
    sampling: { mousemove: 50, scroll: 150, input: 'last' }, collectFonts: false, errorHandler: () => true
  });
  if (stopped || !stopRecord) stop();
  return { stop, flush(unload = false) {
    if (!unload) { prepare(); void send(); return; }
    // Synchronous tail preparation is essential: pagehide cannot await gzip or a dynamic import.
    if (buffer.length) {
      const raw = encoder.encode(buffer.join('')); buffer = []; size = 0;
      for (let offset = 0; offset < raw.length; offset += 48 * 1024) {
        const body = raw.slice(offset, offset + 48 * 1024);
        if (state.replayBytes + body.length > sessionReplayBytes) break;
        state.replayBytes += body.length; queued.push({ seq: state.replaySeq++, body, encoding: 'identity' });
      }
    }
    void send(true);
  } };
}
