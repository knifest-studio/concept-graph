import { model3dModels, modelerOf, runInputs } from '../graph.mjs';
import { glbLength, maxModelBytes } from '../src/model-assets.mjs';
import { falHost, falQueue, falResultUrl, safeFalEndpoint } from './fal-queue.mjs';
import { imageFormat, readBody } from './assets.mjs';
import { upscaleSettings } from './upscale.mjs';
import { NanoError, nanoSettings } from './nano-banana.mjs';

// fal model schemas and prices read 2026-11-14:
// https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d/api (Normal, no PBR/extra views/custom face count)
// https://fal.ai/models/fal-ai/trellis-2/api (1024) and https://fal.ai/models/fal-ai/hyper3d/rodin/v2.5/api (High, PBR GLB).
export async function model3dStatus(user, env, directory) {
  const configured = upscaleSettings(env).fal, allowed = await directory.model3dAllowed(user.email);
  if (!configured || !allowed) return { configured, allowed };
  const { dailyImages, monthlyUsd } = nanoSettings(env), { usedToday, teamSpentUsd } = await directory.nanoUsage(user.email);
  return { configured, allowed, dailyImages, usedToday, monthlyUsd, teamSpentUsd: Math.round(teamSpentUsd * 100) / 100 };
}
export const model3dPrices = Object.freeze({ hunyuan: .375, trellis: .30, rodin: .40 });
export function model3dRequest(graph, nodeId) {
  const { target, images } = runInputs(graph, nodeId);
  return { model3d: true, target, images, modeler: modelerOf(target) };
}
export function model3dInput(modeler, image) {
  if (modeler === 'trellis') return { image_url: image, resolution: 1024 };
  if (modeler === 'rodin') return { image_urls: [image], geometry_file_format: 'glb', material: 'PBR' };
  return { input_image_url: image, generate_type: 'Normal', enable_pbr: false };
}
export async function falModel3d({ modeler, ...options }) {
  const result = await falQueue({ ...options, model: model3dModels[modeler], name: '3D generator' }), endpoint = safeFalEndpoint(options.endpoint);
  const url = (modeler === 'rodin' ? result?.model_mesh : result?.model_glb)?.url, thumbnail = result?.thumbnail?.url;
  if (!falResultUrl(url, endpoint) || (thumbnail !== undefined && !falResultUrl(thumbnail, endpoint))) throw new NanoError('upstream', 'The 3D generator returned an unreadable model or poster. Try again.');
  return { url, ...(thumbnail ? { thumbnail } : {}) };
}
// Result downloads carry no key, so they may follow a CDN redirect; the Worker's strictly-public fetch keeps them off
// private hosts. (Workers reject `redirect: 'error'`, read 2026-11-14 from a local run.)
export async function model3dFile(url, { endpoint = falHost, signal, fetcher = fetch } = {}) {
  if (!falResultUrl(url, safeFalEndpoint(endpoint))) throw new NanoError('upstream', 'The 3D generator returned an unsafe file URL.');
  const file = await fetcher(url, { signal });
  if (!file.ok) throw new NanoError('upstream', 'Could not download the 3D model or poster. Try again.');
  return file;
}
export async function model3dPoster(url, options) {
  const bytes = await readBody(await model3dFile(url, options), 6 * 1024 * 1024), format = imageFormat(bytes);
  if (!['png', 'jpg', 'webp'].includes(format)) throw new Error('The 3D poster must be PNG, JPEG or WebP.');
  return { bytes, format };
}

// R2 multipart uploads keep only a 5 MiB part in the room, never an 80 MB file or two models at once. No object becomes
// visible until its header and final byte count pass. On failure even uncommitted parts are removed.
export async function storeModelGlb(file, files, asset, signal) {
  if (Number(file.headers.get('Content-Length')) > maxModelBytes) { await file.body?.cancel(); throw new Error('3D models can be at most 80 MB.'); }
  if (!file.body) throw new Error('The 3D model is empty.');
  const reader = file.body.getReader(), partSize = 5 * 1024 * 1024, metadata = { httpMetadata: { contentType: 'model/gltf-binary' } };
  let buffer = new Uint8Array(partSize), filled = 0, total = 0, expected, upload;
  const parts = [];
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxModelBytes || (expected && total > expected)) throw new Error('GLB length does not match the file or exceeds 80 MB.');
      let offset = 0;
      while (offset < value.byteLength) {
        const count = Math.min(partSize - filled, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + count), filled); filled += count; offset += count;
        if (!expected && filled >= 12) expected = glbLength(buffer.subarray(0, filled));
        if (filled === partSize) {
          upload ||= await files.createMultipartUpload(`assets/${asset}`, metadata);
          parts.push(await upload.uploadPart(parts.length + 1, buffer));
          buffer = new Uint8Array(partSize); filled = 0;
        }
      }
    }
    signal?.throwIfAborted();
    if (!expected || total !== expected) throw new Error('GLB length does not match the file.');
    if (upload) {
      if (filled) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, filled)));
      await upload.complete(parts);
    } else await files.put(`assets/${asset}`, buffer.subarray(0, filled), metadata);
    return total;
  } catch (cause) {
    await reader.cancel().catch(() => {});
    if (upload) await upload.abort().catch(() => {});
    throw cause;
  } finally { reader.releaseLock(); }
}
