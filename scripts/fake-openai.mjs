// Local Images API stand-in; no requests leave this machine.
// node scripts/fake-openai.mjs (port 8789; PORT overrides).
// Prompt markers: [text], [refuse], [busy], [credit], [key], [verify], [error], [slow].
import { createServer } from 'node:http';
import { picture, send } from './fake-image.mjs';

const port = Number(process.env.PORT) || 8789;
createServer(async (request, response) => {
  const error = (status, code, message) => send(response, status, { error: { message, type: 'invalid_request_error', code } });
  if (request.method !== 'POST' || !['/v1/images/generations', '/v1/images/edits'].includes(request.url)) return error(404, 'not_found', 'Only POST /v1/images/generations and /v1/images/edits are faked.');
  if (!request.headers.authorization?.startsWith('Bearer ')) return error(401, 'invalid_api_key', 'API key missing.');
  let body;
  try { const parts = []; for await (const part of request) parts.push(part); body = JSON.parse(Buffer.concat(parts).toString()); }
  catch { return error(400, 'invalid_request', 'Body is not JSON.'); }
  const prompt = typeof body?.prompt === 'string' ? body.prompt : '', references = Array.isArray(body?.images) ? body.images.length : 0;
  const n = body?.n ?? 1, size = ['1024x1024', '1536x1024', '1024x1536'].includes(body?.size) ? body.size : null;
  if (!prompt || body.model !== 'gpt-image-2.5-flare' || !size || !Number.isInteger(n) || n < 1 || n > 4
    || body.quality !== 'medium' || body.output_format !== 'png' || body.moderation !== 'auto'
    || (body.mask !== undefined && !/^data:image\/png;base64,/.test(body.mask?.image_url))
    || (request.url.endsWith('/edits') && (!references || references > 16 || !body.images.every(image => /^data:image\/[\w.+-]+;base64,/.test(image?.image_url))))) return error(400, 'invalid_request', 'Unexpected Images API request.');
  const mode = ['text', 'refuse', 'busy', 'credit', 'key', 'verify', 'error', 'slow'].find(word => prompt.includes(`[${word}]`)) || 'image';
  console.log(`${new Date().toISOString()} ${mode} · ${body.model} · ${prompt.length} chars · ${references} reference(s)${body.mask ? ' + mask' : ''} · ${n} image(s) · ${size}`);
  if (mode === 'refuse') return error(400, 'moderation_blocked', 'Content policy blocked this request.');
  if (mode === 'busy') return error(429, 'rate_limit_exceeded', 'Rate limit exceeded.');
  if (mode === 'credit') return error(429, 'insufficient_quota', 'Check your billing.');
  if (mode === 'key') return error(401, 'invalid_api_key', 'Invalid API key.');
  if (mode === 'verify') return error(403, 'permission_denied', 'Your organization must be verified.');
  if (mode === 'error') return error(500, 'api_error', 'Internal error.');
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 30000));
  if (response.destroyed) return;
  const [width, height] = size.split('x').map(Number), text_tokens = Math.ceil(prompt.length / 4), image_tokens = references * 1120, output_tokens = mode === 'text' ? 0 : n * 2200;
  send(response, 200, { created: Math.floor(Date.now() / 1000), data: mode === 'text' ? [] : Array.from({ length: n }, (_, index) => ({ b64_json: picture(`${prompt}#${index}#${Date.now()}`, width, height).toString('base64') })),
    output_format: 'png', quality: 'medium', size, usage: { input_tokens: text_tokens + image_tokens, input_tokens_details: { image_tokens, text_tokens }, output_tokens,
      output_tokens_details: { image_tokens: output_tokens, text_tokens: 0 }, total_tokens: text_tokens + image_tokens + output_tokens } });
}).listen(port, '127.0.0.1', () => console.log(`Fake OpenAI listening on http://127.0.0.1:${port}`));
