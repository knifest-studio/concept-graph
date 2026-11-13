// A stand-in for the Gemini Interactions API (POST /v1beta/interactions) for local Nano Banana tests.
// It answers in the documented response shape with a generated PNG and never contacts Google.
//
//   node fake-gemini.mjs            # listens on http://127.0.0.1:8788 (PORT=... to change)
//
// Put a word in the prompt to pick an answer:
//   [two]     two images            [text]   text only, no image (the run fails with the model's text)
//   [refuse]  HTTP 400 safety block [busy]   HTTP 429 rate limit
//   [error]   HTTP 500              [slow]   answers after 30 s (try Cancel)
// Any other model (the description model) answers with a short text.
import { createServer } from 'node:http';
import { picture, send } from './fake-image.mjs';

const port = Number(process.env.PORT) || 8788;

createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1beta/interactions') return send(response, 404, { error: { code: 'not_found', message: 'Only POST /v1beta/interactions is faked.' } });
  if (!request.headers['x-goog-api-key']) return send(response, 401, { error: { code: 'authentication', message: 'API key missing.' } });
  let body;
  try { const parts = []; for await (const part of request) parts.push(part); body = JSON.parse(Buffer.concat(parts).toString()); }
  catch { return send(response, 400, { error: { code: 'invalid_request', message: 'Body is not JSON.' } }); }
  const input = Array.isArray(body.input) ? body.input : [{ type: 'text', text: String(body.input || '') }];
  const prompt = input.filter(item => item.type === 'text').map(item => item.text).join('\n'), references = input.filter(item => item.type === 'image').length;
  const mode = ['two', 'text', 'refuse', 'busy', 'error', 'slow'].find(word => prompt.includes(`[${word}]`)) || 'one';
  console.log(`${new Date().toISOString()} ${mode} · model ${body.model} · revision ${request.headers['api-revision'] || '-'} · ${prompt.length} chars · ${references} reference image(s) · store ${body.store}`);
  if (mode === 'refuse') return send(response, 400, { error: { code: 'safety', message: 'Request blocked due to safety violations (harmful content). Please modify your input and retry.' } });
  if (mode === 'busy') return send(response, 429, { error: { code: 'rate_limit_exceeded', message: 'Resource has been exhausted.' } });
  if (mode === 'error') return send(response, 500, { error: { code: 'api_error', message: 'Internal error.' } });
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 30000));
  if (response.destroyed) return;
  // Text models (descriptions) answer in words only.
  if (body.model !== 'gemini-nano-banana-2.1') {
    const input_tokens = Math.ceil(prompt.length / 4) + references * 258, text = `A fake description of ${references} image(s): a centred subject on a soft gradient background, even light, calm mood.`;
    return send(response, 200, { id: `fake-${Date.now()}`, object: 'interaction', status: 'completed', model: body.model, created: new Date().toISOString(), updated: new Date().toISOString(),
      steps: [{ type: 'model_output', content: [{ type: 'text', text }] }], usage: { total_input_tokens: input_tokens, total_output_tokens: 40, total_thought_tokens: 120, total_tokens: input_tokens + 160 } });
  }
  const count = mode === 'two' ? 2 : mode === 'text' ? 0 : 1, input_tokens = Math.ceil(prompt.length / 4) + references * 1120;
  const images = Array.from({ length: count }, (_, index) => ({ type: 'image', mime_type: 'image/png', data: picture(`${prompt}#${index}#${Date.now()}`).toString('base64') }));
  const text = count ? 'Here is the image.' : 'I can’t create that image. Try describing it differently.';
  send(response, 200, {
    id: `fake-${Date.now()}`, object: 'interaction', status: 'completed', model: body.model, created: new Date().toISOString(), updated: new Date().toISOString(),
    steps: [{ type: 'thought', summary: [{ type: 'text', text: 'Planning the composition.' }] }, { type: 'model_output', content: [{ type: 'text', text }, ...images] }],
    usage: { total_input_tokens: input_tokens, total_output_tokens: count * 1120 + 12, total_thought_tokens: 380, total_tokens: input_tokens + count * 1120 + 12 + 380,
      input_tokens_by_modality: [{ modality: 'text', tokens: Math.ceil(prompt.length / 4) }, ...(references ? [{ modality: 'image', tokens: references * 1120 }] : [])],
      output_tokens_by_modality: [...(count ? [{ modality: 'image', tokens: count * 1120 }] : []), { modality: 'text', tokens: 12 }] },
  });
}).listen(port, '127.0.0.1', () => console.log(`Fake Gemini listening on http://127.0.0.1:${port}`));
