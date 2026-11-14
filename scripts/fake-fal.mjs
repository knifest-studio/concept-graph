// Local fal queue fake; never contacts fal.ai. FAL_KEY may be any nonempty value, FAL_ENDPOINT=http://127.0.0.1:8790.
// node scripts/fake-fal.mjs (PORT changes the port). Each job stays pending briefly so the board shows its waiting state.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { cubeGlb } from '../tests/fixtures/cube-glb.mjs';
import { picture, send } from './fake-image.mjs';
import { model3dModels, topazModel, seedvrModel } from '../graph.mjs';

export function fakeFalHandler({ delay = 2000 } = {}) {
  const jobs = new Map(), endpoints = new Set([topazModel, seedvrModel, ...Object.values(model3dModels)]);
  return async (request, response) => {
    const origin = `http://${request.headers.host}`, path = new URL(request.url, origin).pathname;
    if (request.method === 'GET' && ['/cube.glb', '/thumbnail.png', '/upscaled.png'].includes(path)) {
      const glb = path === '/cube.glb', bytes = glb ? cubeGlb() : picture('Concept Graph fal queue fake');
      response.writeHead(200, { 'Content-Type': glb ? 'model/gltf-binary' : 'image/png', 'Content-Length': bytes.length }); return response.end(bytes);
    }
    if (!request.headers.authorization?.startsWith('Key ')) return send(response, 401, { detail: 'API key missing.' });
    if (request.method === 'POST' && endpoints.has(path.slice(1))) {
      let input;
      try { const parts = []; let size = 0; for await (const part of request) { size += part.length; if (size > 32 * 1024 * 1024) return send(response, 413, { detail: 'Input too large.' }); parts.push(part); } input = JSON.parse(Buffer.concat(parts)); }
      catch { return send(response, 400, { detail: 'Body is not JSON.' }); }
      const model = path.slice(1), image = input.input_image_url || input.image_url || input.image_urls?.[0];
      if (typeof image !== 'string' || !image.startsWith('data:image/')) return send(response, 422, { detail: 'Expected an image data URI.' });
      const id = randomUUID(), url = `${origin}/requests/${id}`;
      jobs.set(id, { model, at: Date.now(), cancelled: false });
      console.log(`${new Date().toISOString()} queued ${model} ${id}`);
      return send(response, 200, { request_id: id, status_url: `${url}/status`, response_url: url, cancel_url: `${url}/cancel` });
    }
    const match = path.match(/^\/requests\/([\da-f-]+)(?:\/(status\/stream|status|cancel))?$/), job = match && jobs.get(match[1]);
    if (!job) return send(response, 404, { detail: 'Job not found.' });
    if (request.method === 'PUT' && match[2] === 'cancel') { job.cancelled = true; return send(response, 200, { status: 'CANCELLATION_REQUESTED' }); }
    if (request.method !== 'GET') return send(response, 405, { detail: 'Use GET or PUT cancel.' });
    if (job.cancelled) return send(response, 422, { detail: 'Cancelled.' });
    const complete = Date.now() - job.at >= delay;
    if (match[2] === 'status') return send(response, 200, { status: complete ? 'COMPLETED' : 'IN_PROGRESS' });
    // Server-sent status events until COMPLETED, as fal's `status/stream` does.
    if (match[2] === 'status/stream') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const tick = () => {
        if (job.cancelled || response.destroyed) return response.end();
        const finished = Date.now() - job.at >= delay;
        response.write(`data: ${JSON.stringify({ status: finished ? 'COMPLETED' : 'IN_PROGRESS' })}\n\n`);
        if (finished) return response.end();
        setTimeout(tick, Math.min(250, delay));
      };
      return tick();
    }
    if (!complete) return send(response, 400, { detail: 'Still running.' });
    if ([topazModel, seedvrModel].includes(job.model)) return send(response, 200, { image: { url: `${origin}/upscaled.png` } });
    const file = { url: `${origin}/cube.glb` };
    return send(response, 200, job.model === model3dModels.rodin ? { model_mesh: file } : { model_glb: file, ...(job.model === model3dModels.hunyuan ? { thumbnail: { url: `${origin}/thumbnail.png` } } : {}) });
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 8790;
  createServer(fakeFalHandler()).listen(port, '127.0.0.1', () => console.log(`Fake fal listening on http://127.0.0.1:${port}`));
}
