import { promptText, runInputs } from '../graph.mjs';
import { resolveVideo } from '../src/video-generation.mjs';
import { maxVideoBytes, validateMp4Header } from '../src/video-assets.mjs';
import { falHost, falQueue, falResultUrl, safeFalEndpoint } from './fal-queue.mjs';
import { NanoError, nanoSettings } from './nano-banana.mjs';
import { upscaleSettings } from './upscale.mjs';

export async function videoStatus(user, env, directory) {
  const configured = upscaleSettings(env).fal, allowed = await directory.videoAllowed(user.email);
  if (!configured || !allowed) return { configured, allowed };
  const { dailyImages, monthlyUsd } = nanoSettings(env), { usedToday, teamSpentUsd } = await directory.nanoUsage(user.email);
  return { configured, allowed, dailyImages, usedToday, monthlyUsd, teamSpentUsd: Math.round(teamSpentUsd * 100) / 100 };
}
export function videoRequest(graph, nodeId) {
  const { target, images, context } = runInputs(graph, nodeId), generation = resolveVideo(target, images);
  if (generation.blocked) throw new NanoError('bad_request', generation.issues[0].reason);
  const prompt = [...context.map(promptText), promptText(target)].filter(Boolean).join('\n\n');
  if (prompt.length > 150000) throw new NanoError('bad_request', 'Connected text is too long. Disconnect some context.');
  return { video: true, target, images, generation, prompt };
}
export async function falVideo({ model, images = 30, ...options }) {
  const result = await falQueue({ ...options, maxStreams: videoStreams(images), model, name: 'video generator' }), url = result?.video?.url;
  if (!falResultUrl(url, safeFalEndpoint(options.endpoint))) throw new NanoError('upstream', 'The video generator returned an unreadable video URL.');
  return { url };
}
export async function videoFile(url, { endpoint = falHost, signal, fetcher = fetch } = {}) {
  if (!falResultUrl(url, safeFalEndpoint(endpoint))) throw new NanoError('upstream', 'The video generator returned an unsafe file URL.');
  const file = await fetcher(url, { signal });
  if (!file.ok) throw new NanoError('upstream', 'Could not download the video. Try again.');
  return file;
}
// FixedLengthStream makes a validated stream acceptable to R2.put without buffering its body:
// https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#bucket-method-definitions
// read 2026-11-18. Unknown lengths use 32 MiB parts: at the 128 MiB cap, create + 4 parts + complete = 6 R2 calls.
// Video queue waiting with two streams (one reopen) is at most 6 calls; with download, storage uses at most 13 calls,
// leaving room under 50 for up to 30 input checks, quota RPCs and board persistence. Each further reopen costs 2 calls
// (a status check and a new stream), so a run with fewer input images may wait through more dropped streams: a long
// video can take several minutes, and a run that gives up after fal accepted it is still billed.
export const videoStreams = images => Math.min(12, 2 + Math.floor(Math.max(0, 30 - images) / 2));
export const videoPartBytes = 32 * 1024 * 1024;

async function storeKnownVideo(file, files, asset, declared, signal, metadata) {
  const fixed = new FixedLengthStream(declared), controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', stop, { once: true });
  let total = 0, filled = 0;
  const header = new Uint8Array(12), check = new TransformStream({
    transform(chunk, output) {
      total += chunk.byteLength;
      if (total > declared) throw new Error('The MP4 is empty or its length does not match the file.');
      if (filled < header.length) {
        const count = Math.min(header.length - filled, chunk.byteLength);
        header.set(chunk.subarray(0, count), filled); filled += count;
        if (filled === header.length) validateMp4Header(header);
      }
      output.enqueue(chunk);
    },
    flush() { if (filled < header.length || total !== declared) throw new Error('The MP4 is empty or its length does not match the file.'); },
  });
  let writing;
  try {
    signal?.throwIfAborted();
    writing = file.body.pipeThrough(check).pipeTo(fixed.writable, { signal: controller.signal });
    await Promise.all([writing, files.put(`assets/${asset}`, fixed.readable, metadata)]);
    return total;
  } catch (cause) {
    controller.abort(cause);
    await fixed.readable.cancel(cause).catch(() => {});
    if (writing) await writing.catch(() => {});
    else await file.body.cancel(cause).catch(() => {});
    throw cause;
  } finally { signal?.removeEventListener('abort', stop); }
}

export async function storeVideoMp4(file, files, asset, signal) {
  const length = file.headers.get('Content-Length'), declared = length === null ? undefined : Number(length);
  if (declared !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(declared) || declared < 12)) { await file.body?.cancel(); throw new Error('The MP4 is empty or its length does not match the file.'); }
  if (declared > maxVideoBytes) { await file.body?.cancel(); throw new Error('Videos can be at most 128 MB.'); }
  if (!file.body) throw new Error('The video is empty.');
  const metadata = { httpMetadata: { contentType: 'video/mp4' } };
  if (declared !== undefined) return storeKnownVideo(file, files, asset, declared, signal, metadata);
  const reader = file.body.getReader(), partSize = videoPartBytes;
  let buffer = new Uint8Array(partSize), filled = 0, total = 0, checked = false, upload;
  const parts = [];
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxVideoBytes) throw new Error('Videos can be at most 128 MB.');
      let offset = 0;
      while (offset < value.byteLength) {
        const count = Math.min(partSize - filled, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + count), filled); filled += count; offset += count;
        if (!checked && filled >= 12) { validateMp4Header(buffer.subarray(0, filled)); checked = true; }
        if (filled === partSize) {
          upload ||= await files.createMultipartUpload(`assets/${asset}`, metadata);
          parts.push(await upload.uploadPart(parts.length + 1, buffer));
          filled = 0;
        }
      }
    }
    signal?.throwIfAborted();
    if (!checked || (declared && declared !== total)) throw new Error('The MP4 is empty or its length does not match the file.');
    if (upload) { if (filled) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, filled))); await upload.complete(parts); }
    else await files.put(`assets/${asset}`, buffer.subarray(0, filled), metadata);
    return total;
  } catch (cause) {
    await reader.cancel().catch(() => {});
    if (upload) await upload.abort().catch(() => {});
    throw cause;
  } finally { reader.releaseLock(); }
}
