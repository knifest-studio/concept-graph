import { NanoError } from './nano-banana.mjs';

export const falHost = 'https://queue.fal.run';
// Waiting holds one status stream open instead of polling: a Worker on the free plan may make only 50 outbound requests
// per invocation (https://developers.cloudflare.com/workers/platform/limits/, read 2026-11-14), and a 3D model takes
// minutes; polling every 1.5 s hit "Too many subrequests" on the first real Hunyuan run. `<status_url>/stream` sends the
// same status objects as server-sent events and stays open until COMPLETED (https://fal.ai/docs/documentation/model-apis/inference/queue,
// read 2026-11-14). A dropped stream costs one status check and a reopen, at most `streamTries` times (≤ 2 + 2×12 requests a job).
const poll = 1500, streamTries = 12;
// The first COMPLETED status in an event stream, or null if the stream ends before one.
async function completedFrom(body, signal) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) return null;
      text += value;
      let end;
      while ((end = text.search(/\r?\n\r?\n/)) >= 0) {
        const event = text.slice(0, end), data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        text = text.slice(end).replace(/^\r?\n\r?\n/, '');
        let status = null;
        try { status = data ? JSON.parse(data) : null; } catch {}
        if (status?.status === 'COMPLETED') return status;
      }
      if (text.length > 1024 * 1024) text = '';
    }
  } finally { reader.cancel().catch(() => {}); }
}
const localEndpoint = value => {
  try { const url = new URL(value); return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol) ? url.origin : null; }
  catch { return null; }
};
// The key is only sent to the queue host or an explicit loopback fake, including when callers pass an override.
export const safeFalEndpoint = value => localEndpoint(value) || falHost;
export const falResultUrl = (value, endpoint = falHost, inline = false) => {
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === 'https:' || (inline && /^data:image\//.test(value)) || (endpoint !== falHost && url.origin === endpoint)); }
  catch { return false; }
};

const falError = (status, detail, name = 'upscaler') => {
  if ([401, 403].includes(status)) return new NanoError('config', 'fal.ai rejected the site’s key. Ask the site owner to check FAL_KEY.');
  if (status === 402) return new NanoError('config', 'The site’s fal.ai account is out of credit. Ask the site owner to top it up.');
  if (status === 422 || status === 400) return new NanoError('bad_request', `The ${name} could not use this image${detail ? `: ${String(detail).replace(/\s+/g, ' ').slice(0, 200)}` : '.'}`);
  if (status === 429 || status >= 500) return new NanoError('busy', `The ${name} is busy right now. Try again in a minute.`);
  return new NanoError('upstream', `The ${name} failed${status ? ` (${status})` : ''}. Try again.`);
};
const detailOf = body => typeof body?.detail === 'string' ? body.detail : Array.isArray(body?.detail) ? body.detail.map(item => item?.msg).filter(Boolean).join('; ') : body?.error;
const json = async response => response.json().catch(() => null);
const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(done, milliseconds);
  const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
});

// Queue API read 2026-11-14: https://fal.ai/docs/documentation/model-apis/inference/queue.
// onQueued marks the point where a call may be billed; cancellation also cancels the accepted job.
export async function falQueue({ key, endpoint = falHost, model, input, signal, onQueued = () => {}, fetcher = fetch, name = 'upscaler' }) {
  endpoint = safeFalEndpoint(endpoint);
  const error = (status, detail) => falError(status, detail, name);
  const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  const submitted = await fetcher(`${endpoint}/${model}`, { method: 'POST', headers, redirect: 'manual', body: JSON.stringify(input), signal });
  const queued = await json(submitted);
  if (!submitted.ok) throw error(submitted.status, detailOf(queued));
  const own = url => typeof url === 'string' && url.startsWith(`${endpoint}/`) ? url : null;
  const statusUrl = own(queued?.status_url), responseUrl = own(queued?.response_url), cancelUrl = own(queued?.cancel_url);
  if (!statusUrl || !responseUrl) throw new NanoError('upstream', `The ${name} returned an unreadable response. Try again.`);
  onQueued();
  const cancel = () => { if (cancelUrl) fetcher(cancelUrl, { method: 'PUT', headers, redirect: 'manual' }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) { signal.removeEventListener('abort', cancel); cancel(); throw signal.reason || new DOMException('Aborted', 'AbortError'); }
  try {
    let done = null;
    for (let attempt = 0; !done; attempt++) {
      if (attempt === streamTries) throw new NanoError('busy', `The ${name} is taking too long. Try again.`);
      const stream = await fetcher(`${statusUrl}/stream`, { headers, signal, redirect: 'manual' });
      if (stream.ok && stream.body) done = await completedFrom(stream.body, signal);
      else await stream.body?.cancel();
      if (done) break;
      // The stream ended (or isn't offered) before COMPLETED: one plain check decides, then it is opened again.
      const response = await fetcher(statusUrl, { headers, signal, redirect: 'manual' }), status = await json(response);
      if (!response.ok) throw error(response.status, detailOf(status));
      if (status?.status === 'COMPLETED') done = status;
      else await wait(poll, signal);
    }
    if (done.error) throw error(422, done.error);
    const response = await fetcher(responseUrl, { headers, signal, redirect: 'manual' }), result = await json(response);
    if (!response.ok) throw error(response.status, detailOf(result));
    return result;
  } finally { signal?.removeEventListener('abort', cancel); }
}
