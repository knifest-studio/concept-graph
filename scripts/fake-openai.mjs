// Local Images and Responses API stand-in; no requests leave this machine.
// node scripts/fake-openai.mjs (port 8789; PORT overrides).
// Prompt markers: [text], [refuse], [busy], [credit], [key], [verify], [error], [slow], [empty] (Responses only).
import { createServer } from 'node:http';
import { picture, send } from './fake-image.mjs';

const port = Number(process.env.PORT) || 8789;
createServer(async (request, response) => {
  const error = (status, code, message) => send(response, status, { error: { message, type: 'invalid_request_error', code } });
  if (request.method !== 'POST' || !['/v1/images/generations', '/v1/images/edits', '/v1/responses'].includes(request.url)) return error(404, 'not_found', 'Only POST /v1/images/generations, /v1/images/edits and /v1/responses are faked.');
  if (!request.headers.authorization?.startsWith('Bearer ')) return error(401, 'invalid_api_key', 'API key missing.');
  let body;
  try { const parts = []; for await (const part of request) parts.push(part); body = JSON.parse(Buffer.concat(parts).toString()); }
  catch { return error(400, 'invalid_request', 'Body is not JSON.'); }
  const describe = request.url === '/v1/responses', content = body?.input?.[0]?.content;
  const prompt = describe ? (Array.isArray(content) ? content.filter(block => block.type === 'input_text').map(block => block.text).join('\n') : '') : typeof body?.prompt === 'string' ? body.prompt : '';
  const references = describe ? (Array.isArray(content) ? content.filter(block => block.type === 'input_image').length : 0) : Array.isArray(body?.images) ? body.images.length : 0;
  if (describe && (!prompt || !references || body.model !== 'gpt-6.1-terra' || body.store !== false || body.max_output_tokens !== 8000 || body.reasoning?.effort !== 'low' || body.input.length !== 1 || body.input[0].role !== 'user'
    || !content.every(block => block.type === 'input_text' ? typeof block.text === 'string' : block.type === 'input_image' && block.detail === 'high' && /^data:image\/[\w.+-]+;base64,/.test(block.image_url)))) return error(400, 'invalid_request', 'Unexpected Responses API request.');
  // Sizes follow the documented limits the app sends from generation settings (gptSizeLimits in graph.mjs, kept in step
  // here because tests load this file without its imports), not only the presets.
  const fits = value => { const [w, h] = /^(\d+)x(\d+)$/.exec(value || '')?.slice(1).map(Number) || [], step = 16, maxRatio = 3, maxEdge = 3840, minPixels = 655360, maxPixels = 8294400;
    return w > 0 && h > 0 && !(w % step) && !(h % step) && Math.max(w, h) <= maxEdge && Math.max(w / h, h / w) <= maxRatio && w * h >= minPixels && w * h <= maxPixels; };
  const n = body?.n ?? 1, size = fits(body?.size) ? body.size : null;
  if (!describe && (!prompt || body.model !== 'gpt-image-2.5-flare' || !size || !Number.isInteger(n) || n < 1 || n > 4
    || !['low', 'medium', 'high'].includes(body.quality) || (body.background !== undefined && body.background !== 'transparent') || body.output_format !== 'png' || body.moderation !== 'auto'
    || (body.mask !== undefined && !/^data:image\/png;base64,/.test(body.mask?.image_url))
    || (request.url.endsWith('/edits') && (!references || references > 16 || !body.images.every(image => /^data:image\/[\w.+-]+;base64,/.test(image?.image_url)))))) return error(400, 'invalid_request', 'Unexpected Images API request.');
  const mode = ['text', 'refuse', 'busy', 'credit', 'key', 'verify', 'error', 'slow', 'empty'].find(word => prompt.includes(`[${word}]`)) || 'image';
  console.log(`${new Date().toISOString()} ${mode} · ${body.model} · ${prompt.length} chars · ${references} reference(s)${body.mask ? ' + mask' : ''} · ${n} image(s) · ${size}`);
  if (mode === 'refuse' && describe) return send(response, 200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Declined.' }] }] });
  if (mode === 'refuse') return error(400, 'moderation_blocked', 'Content policy blocked this request.');
  if (mode === 'busy') return error(429, 'rate_limit_exceeded', 'Rate limit exceeded.');
  if (mode === 'credit') return error(429, 'insufficient_quota', 'Check your billing.');
  if (mode === 'key') return error(401, 'invalid_api_key', 'Invalid API key.');
  if (mode === 'verify') return error(403, 'permission_denied', 'Your organization must be verified.');
  if (mode === 'error') return error(500, 'api_error', 'Internal error.');
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 30000));
  // FAKE_DELAY_MS makes every answer take that long, so progress and parallel runs can be watched.
  if (Number(process.env.FAKE_DELAY_MS) > 0) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_DELAY_MS)));
  if (response.destroyed) return;
  if (describe) return send(response, 200, { status: mode === 'empty' ? 'incomplete' : 'completed', ...(mode === 'empty' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    output: mode === 'empty' ? [] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A small grey square on a plain background.' }] }],
    usage: { input_tokens: Math.ceil(prompt.length / 3) + references * 3000, output_tokens: 100, output_tokens_details: { reasoning_tokens: 20 } } });
  const [width, height] = size.split('x').map(Number), text_tokens = Math.ceil(prompt.length / 4), image_tokens = references * 1120, output_tokens = mode === 'text' ? 0 : n * 2200;
  send(response, 200, { created: Math.floor(Date.now() / 1000), data: mode === 'text' ? [] : Array.from({ length: n }, (_, index) => ({ b64_json: picture(`${prompt}#${index}#${Date.now()}`, width, height).toString('base64') })),
    output_format: 'png', quality: body.quality, size, usage: { input_tokens: text_tokens + image_tokens, input_tokens_details: { image_tokens, text_tokens }, output_tokens,
      output_tokens_details: { image_tokens: output_tokens, text_tokens: 0 }, total_tokens: text_tokens + image_tokens + output_tokens } });
}).listen(port, '127.0.0.1', () => console.log(`Fake OpenAI listening on http://127.0.0.1:${port}`));
