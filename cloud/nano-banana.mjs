import { describePrompt, describeModel, isDescribe, nanoModel, promptText, runInputs, imageAttachment, imageAttachments } from '../graph.mjs';
import { imageFormat, imageTypes } from './assets.mjs';
import { generationReferences, imageTitle, maskInstruction } from '../src/image-edits.mjs';

// Nano Banana 2.1 through the Gemini Interactions API, the request the image-generation guide documents (read 2026-11-04):
// https://aistudio.google.com/docs/image-generation and, for the Interaction object (steps, usage, errors),
// https://aistudio.google.com/api-reference/interactions-api/create-interaction and https://aistudio.google.com/docs/api-errors
export { describeModel, nanoModel };
const apiRevision = '2026-05-20', googleEndpoint = 'https://generativelanguage.googleapis.com';

// Standard paid tier of gemini-nano-banana-2.1 in USD per 1M tokens, read 2026-11-04 from https://aistudio.google.com/docs/pricing.
// A 1K output image is 1120 tokens ($0.0336); thinking is billed as text output; there is no free tier for image output.
export const nanoPrices = Object.freeze({ readOn: '2026-11-04', input: 1.5, textOutput: 7.5, imageOutput: 30, imageTokens: 1120 });
// Output tokens per image by size: 1K and 2K from the image-generation guide, 4K the pricing page's higher figure ($0.113,
// where the guide says 2520) so a reserve never falls short. Thinking is a generous allowance per level (medium, the
// default, is the 4000 every estimate has always held); Google bills the thinking a call really used.
export const nanoImageTokens = Object.freeze({ '1K': 1120, '2K': 1680, '4K': 3780 });
export const nanoThinkingTokens = Object.freeze({ minimal: 1000, medium: 4000, high: 10000 });
// Standard paid tier of gemini-3.5-flash-lite, same page and day: text and image input, then text and thinking output.
export const describePrices = Object.freeze({ readOn: '2026-11-04', input: .3, output: 2.5 });
export const nanoTimeout = 5 * 60 * 1000;
// Variants go out a few at a time on one shared request body: a room may wait on only 6 connections at once and needs
// some for storage, and one body per variant would not fit its memory. Each wave of lanes adds time to the run's limit,
// which stays under the 15 minutes waitUntil keeps a room alive.
export const variantLanes = 4;
// Large images go fewer at a time: while a call's answer is read the room holds it several times over (the body, its
// base64 text, the decoded bytes), and a 4K PNG from GPT Image is 15–20 MB, so four at once could pass a room's 128 MB.
// Nano Banana's JPEGs are several times smaller at the same size.
export const variantLanesFor = ({ gpt = false, imageSize } = {}) => imageSize === '4K' ? gpt ? 1 : 2 : imageSize === '2K' && gpt ? 2 : variantLanes;
export const variantRunTimeout = (count, lanes = variantLanes) => Math.min(14 * 60 * 1000, nanoTimeout + (Math.ceil(Math.max(1, count) / lanes) - 1) * 2 * 60 * 1000);
export const maxReferenceBytes = 20 * 1024 * 1024;

// Only a page built before generation settings existed is refused for them, and its translations lack this message, so
// the room words it: in Ukrainian when the browser prefers Ukrainian to English (as such a page picks its language when
// nobody chose one), otherwise in English followed by Ukrainian, for someone who chose Ukrainian in an English browser.
export const staleSettings = Object.freeze({ en: 'Reload the page to use generation settings.', uk: 'Перезавантажте сторінку, щоб використати налаштування генерації.' });
export function staleSettingsError(acceptLanguage) {
  const preferred = String(acceptLanguage || '').split(',').map((part, index) => {
    const [tag, ...parameters] = part.trim().split(';'), q = parameters.map(value => /^\s*q=([\d.]+)\s*$/i.exec(value)?.[1]).find(Boolean);
    return { base: tag.trim().toLowerCase().split('-')[0], q: q === undefined ? 1 : Number(q), index };
  }).filter(entry => entry.q > 0).sort((a, b) => b.q - a.q || a.index - b.index).find(entry => entry.base === 'uk' || entry.base === 'en');
  return preferred?.base === 'uk' ? staleSettings.uk : `${staleSettings.en} ${staleSettings.uk}`;
}

export class NanoError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

// Entries are emails or whole domains (`@example.com`), separated by commas, semicolons or spaces, in any case.
export function nanoAllowed(email, list) {
  if (typeof email !== 'string' || typeof list !== 'string') return false;
  const address = email.trim().toLowerCase(), at = address.lastIndexOf('@'), domain = address.slice(at + 1);
  if (at < 1 || !domain) return false;
  return list.toLowerCase().split(/[\s,;]+/).some(entry => entry && (entry.startsWith('@') ? entry.slice(1) === domain : entry.includes('@') ? entry === address : entry === domain));
}

const limit = (value, fallback) => {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};
// The endpoint override exists for a local fake server only, so the key can never be sent to another host by mistake.
export const localEndpoint = value => {
  try { const url = new URL(value); return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol) ? url.origin : null; }
  catch { return null; }
};

// Production sets the same numbers in wrangler.jsonc; these apply when a variable is missing or unreadable.
export const defaultDailyImages = 300, defaultMonthlyUsd = 300;
export function nanoSettings(env) {
  return {
    configured: typeof env.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim() !== '',
    dailyImages: Math.floor(limit(env.NANO_BANANA_DAILY_IMAGES, defaultDailyImages)), monthlyUsd: limit(env.NANO_BANANA_MONTHLY_USD, defaultMonthlyUsd),
    endpoint: (env.NANO_BANANA_ENDPOINT && localEndpoint(env.NANO_BANANA_ENDPOINT)) || googleEndpoint,
  };
}

// The inputs a Codex run would get (runInputs decides which), written for an image model instead of an agent.
// The request names images by number, board name, node ID or file name; the earliest one named comes first in the text.
// Numbers are written as “image 2”, “image number 2”, “image two”, “#2”, “the second (attached) image”, “the first and
// second images” or “2nd image”, or the same in Ukrainian (“картинку 2 як 1”, “на картинці 3,”, “фотку три і”, “другу
// картинку”, “3-ю картинку”). After a picture word a number counts only before the end, a punctuation mark or a joining
// word, as “на фото 3 людини” and “на картинці два коти” are counts; so are “2 картинки”, “з 2-х фото”, “фото 3-х
// дівчат” and “з п’яти картинок”, and “2x bigger”, “#2a2a2a”, “photo 3/4 view”, “photo 2.jpg”, “3-d”, “третину
// картинки” and “a second image” (another one) are not numbers either.
const escaped = value => value.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pictureWords = 'image|img|picture|pic|photo|reference|ref|картин\\p{L}*|зображенн\\p{L}*|фот\\p{L}*|референс\\p{L}*|реф\\p{L}*';
// Ordinal stems; a cardinal sharing the stem (п’ять, п’яти, сьоми, десяти) or a fraction (третина, четвертина) is not one.
const cardinal = '(?!ь|и(?!\\p{L}))';
const ordinalWords = [, 'first|перш\\p{L}*', 'second|друг\\p{L}*', 'third|трет(?!ин)\\p{L}*', 'fourth|четверт(?!ин)\\p{L}*', `fifth|п[’'ʼ]?ят${cardinal}\\p{L}*`, 'sixth|шост\\p{L}*',
  `seventh|сьом${cardinal}\\p{L}*`, `eighth|восьм${cardinal}\\p{L}*`, `ninth|дев[’'ʼ]?ят${cardinal}\\p{L}*`, `tenth|десят${cardinal}\\p{L}*`];
const numberWords = [, 'one|один|одна|одну', 'two|два|дві', 'three|три', 'four|чотири', "five|п[’'ʼ]?ять", 'six|шість', 'seven|сім', 'eight|вісім', "nine|дев[’'ʼ]?ять", 'ten|десять'];
// Endings of ordinals after a digit (2nd, 2-гу, 3-тя, 3-ю, 2-ї), not of counts (2-х, 3-ох, 3-ма, 5-ти, 7-ми).
const ordinalEnding = '(?:st|nd|rd|th|-(?:й|ий|ій|го|ого|му|ому|ї|ої|ю|ою|ша|шу|ше|ші|га|гу|ге|гі|тя|тю|тє|ті|та|ту|те|а|у|е|я|і))(?!\\p{L})';
const anyOrdinal = [...ordinalWords.slice(1), `\\d{1,2}${ordinalEnding}`].join('|');
// Words that may stand between an ordinal and the picture word: “the second attached image”, “другу підключену картинку”.
const pictureAdjectives = "attached|connected|uploaded|input|generated|original|підключен\\p{L}*|під[’'ʼ]?єднан\\p{L}*|прикріплен\\p{L}*|вхідн\\p{L}*|згенерован\\p{L}*|оригінальн\\p{L}*";
// A number ends where no letter, digit, fraction, size, ratio, file extension or count ending continues it.
const numberEnd = '(?![\\p{L}\\p{N}]|[:/×.,]\\p{N}|\\.\\p{L}|-\\p{L})';
// What may follow a number after a picture word: the end, a punctuation mark, or a word that joins it to the request.
const joining = "and|or|like|as|with|to|into|onto|from|in|on|at|by|but|then|so|than|please|instead|using|should|must|is|looks?|і|й|та|а|або|чи|як|з|із|зі|на|в|у|до|від|під|за|але|щоб|ніж|теж|також|зроби\\p{L}*|має|мають|буде|стал\\p{L}*|бул\\p{L}*";
const asReference = `(?=\\s*(?:$|[^\\p{L}\\p{N}\\s]|(?:${joining})(?!\\p{L})))`;
const numberPatterns = new Map();
const numberPattern = number => {
  if (!numberPatterns.has(number)) {
    const ordinal = [ordinalWords[number], `${number}${ordinalEnding}`].filter(Boolean).join('|'), written = [number, numberWords[number]].filter(Boolean).join('|');
    numberPatterns.set(number, new RegExp(`(?<![\\p{L}\\p{N}])(?:(?:${pictureWords})\\s*(?:(?:№|#|no\\.?|number|номер)\\s*)?(?:${written})${numberEnd}${asReference}|[#№]\\s*${number}${numberEnd}`
      + `|(?<ordinal>${ordinal})(?:\\s*(?:,|and|or|і|й|та|чи)\\s*(?:${anyOrdinal})){0,9}\\s+(?:(?:${pictureAdjectives})\\s+)?(?:${pictureWords}))`, 'gu'));
  }
  return numberPatterns.get(number);
};
// “A second image” asks for another one, and an image named as the source (“the style of image 2”, “like the first
// photo”, “з картинки 2”) is a reference rather than the one to edit; both are checked on the few characters before a
// mention, never scanned for.
const another = /(?:^|[^\p{L}])(?:an?|another|one more|ще одн\p{L}*)\s+$/u;
const source = /(?:^|[^\p{L}])(?:like|as in|style of|styled after|from|як|як на|як у|як в|з|із|зі|від|стиль|стилі|стилем)\s+(?:the\s+|that\s+)?$/u;
const before = (text, index) => text.slice(Math.max(0, index - 24), index);
// The first place the request names this number for editing, or Infinity.
const numberAt = (text, number) => {
  for (const match of text.matchAll(numberPattern(number))) {
    const ahead = before(text, match.index);
    if ((!match.groups.ordinal || !another.test(ahead)) && !source.test(ahead)) return match.index;
  }
  return Infinity;
};
const word = name => new RegExp(`(?<![\\p{L}\\p{N}])${escaped(name)}(?![\\p{L}\\p{N}])`, 'gu');
const firstEdit = (text, pattern) => { for (const match of text.matchAll(pattern)) if (!source.test(before(text, match.index))) return match.index; return Infinity; };
// A board name made of a picture word (“Image”, “photo”) names no image in particular, and one with a number (“Image 2”,
// “Photo 2”) reads as that number while the prompt has it, so it counts as a name only in quotes.
const pictureName = new RegExp(`^(?:${pictureWords})(?: ?(\\d+))?$`, 'iu');
// Where the request first names an image to edit, doubled, with a number winning a tie with a name at the same place.
const named = (text, image, count) => {
  const lower = text.toLowerCase(), label = image.label?.trim(), generic = label && pictureName.exec(label);
  const byLabel = !label || (generic && !generic[1]) ? Infinity : generic && Number(generic[1]) <= count ? firstEdit(lower, new RegExp(`[“"«']${escaped(label)}[”"»']`, 'gu')) : firstEdit(lower, word(label));
  const byName = Math.min(byLabel, ...[image.nodeId, image.asset, image.uploaded].filter(Boolean).map(name => firstEdit(lower, word(name))));
  return Math.min(byName * 2 + 1, image.number ? numberAt(lower, image.number) * 2 : Infinity);
};
// GPT Image edits the first input image and uses the rest as references (OpenAI image generation guide), so the image
// the request names first leads, unless a mask already fixes which image is edited.
export function editedFirst(images, text) {
  if (images.some(image => image.mask) || images.length < 2) return images;
  const count = images.reduce((most, image) => Math.max(most, image.number || 0), 0);
  const first = images.map(image => named(text, image, count)).reduce((best, at, i, all) => at < all[best] ? i : best, 0);
  return [images[first], ...images.filter((_, i) => i !== first)];
}

export function nanoPrompt(graph, nodeId, { maskInput = false, leadEdited = false } = {}) {
  const run = runInputs(graph, nodeId), { target, context } = run;
  const inputs = leadEdited && !run.mainImage ? editedFirst(run.images, promptText(target)) : run.images, images = generationReferences(inputs, maskInput);
  // A describe node asks for the same written description Codex would give, from a text model.
  if (isDescribe(target)) return { prompt: describePrompt(target, images, context), images, target, describe: true };
  const prompt = [
    context.length ? 'Create an image for the request at the end. The earlier text is context for it, not separate requests.' : '',
    ...context.map((node, i) => `Context ${i + 1}:\n${promptText(node)}`),
    imageAttachments(images),
    leadEdited && run.mainImage ? `Edit ${imageTitle(run.mainImage)}, sent as attachment 1. The other attachments are references for the request.` : '',
    `${context.length || images.length ? 'Request:\n' : ''}${promptText(target)}`,
    maskInstruction(inputs, maskInput),
  ].filter(Boolean).join('\n\n');
  if (prompt.length > 150000) throw new Error('Connected text is too long. Disconnect some context.');
  return { prompt, images, target, ...(maskInput && inputs.some(image => image.mask) ? { mask: inputs.find(image => image.mask).mask.asset } : {}) };
}

// Usage figures are shown only to people who may use the site's API keys.
export async function nanoStatus(user, env, directory, settings = nanoSettings(env)) {
  const allowed = await directory.nanoAllowed(user.email);
  if (!settings.configured || !allowed) return { configured: settings.configured, allowed };
  const { usedToday, teamSpentUsd } = await directory.nanoUsage(user.email);
  return { configured: true, allowed: true, dailyImages: settings.dailyImages, usedToday, monthlyUsd: settings.monthlyUsd, teamSpentUsd: Math.round(teamSpentUsd * 100) / 100 };
}

export function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}

// One request per Generate. `references` are { mimeType, data (base64), label? } in prompt order.
// `format` is a response_format, such as the 2K or 4K size an upscale asks for, and `config` a generation_config (the
// thinking level); a prompt without settings sends neither, so Google's defaults apply as before.
export function nanoRequest(prompt, references, { key, endpoint }, model = nanoModel, format, config) {
  return { url: `${endpoint}/v1beta/interactions`, init: {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, 'Api-Revision': apiRevision },
    // Nothing needs a follow-up turn, so the interaction is not kept in Google's interaction history.
    body: JSON.stringify({ model, input: [{ type: 'text', text: prompt }, ...references.flatMap((image, index) => [...(image.label ? [{ type: 'text', text: imageAttachment(image, index) }] : []), { type: 'image', mime_type: image.mimeType, data: image.data }])], ...(format ? { response_format: format } : {}), ...(config ? { generation_config: config } : {}), store: false }),
  } };
}

const blocked = new Set(['safety', 'recitation', 'language', 'prohibited_content', 'spii', 'blocklist', 'content_blocked', 'jailbreak', 'image_safety', 'image_prohibited_content', 'image_recitation', 'image_other']);
// Codes are snake_case, URIs in Interaction.errors, or gRPC names in older error bodies.
const errorCode = value => typeof value === 'string' ? value.split(/[/#]/).pop().toLowerCase() : '';
const clean = (value, length = 200) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, length) : '';

export function nanoError(status, code, message) {
  const busy = 'Nano Banana is busy right now. Try again in a minute.';
  if (blocked.has(code)) return new NanoError('refused', 'Nano Banana declined this prompt or its references (Google’s safety filters). Change them and try again.');
  if (code === 'quota_exceeded') return new NanoError('busy', 'The site’s Gemini quota is used up for now. Try again later, or ask the site owner to raise it.');
  if (status === 429 || [503, 504].includes(status) || ['rate_limit_exceeded', 'too_many_requests', 'resource_exhausted', 'service_unavailable', 'unavailable', 'deadline_exceeded'].includes(code)) return new NanoError('busy', busy);
  if ([401, 403].includes(status) || ['authentication', 'unauthenticated', 'permission_denied'].includes(code)) return new NanoError('config', 'Google rejected the site’s Gemini API key. Ask the site owner to check it.');
  if (status === 402 || code === 'payment_required') return new NanoError('config', 'The site’s Gemini account needs billing set up. Ask the site owner.');
  if (status === 404 || code === 'model_not_found') return new NanoError('config', 'Nano Banana 2.1 is not available to the site’s Gemini key.');
  if (status === 400 || ['invalid_request', 'invalid_argument', 'parameter_unknown', 'failed_precondition', 'out_of_range'].includes(code)) {
    const detail = clean(message);
    return new NanoError('bad_request', `Nano Banana could not use this request${detail ? `: ${detail}` : '.'}`);
  }
  return new NanoError('upstream', `Nano Banana failed${status ? ` (${status})` : ''}. Try again.`);
}

const imageSpans = new WeakMap(), textDecoder = new TextDecoder();
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', base64Values = new Int16Array(256).fill(-1);
for (let i = 0; i < alphabet.length; i++) base64Values[alphabet.charCodeAt(i)] = i;

function base64Length(bytes) {
  const length = bytes.length, padding = bytes[length - 1] === 61 ? bytes[length - 2] === 61 ? 2 : 1 : 0;
  if (length % 4 === 1 || (padding && length % 4)) throw new Error('Invalid base64');
  for (let i = 0; i < length - padding; i++) if (base64Values[bytes[i]] < 0) throw new Error('Invalid base64');
  return Math.floor(length * 3 / 4) - padding;
}

function decodeBase64Bytes(data) {
  const bytes = new Uint8Array(base64Length(data));
  let bits = 0, value = 0, offset = 0;
  for (let i = 0; offset < bytes.length; i++) {
    value = (value << 6) | base64Values[data[i]]; bits += 6;
    if (bits >= 8) { bits -= 8; bytes[offset++] = (value >> bits) & 255; }
  }
  return bytes;
}

// Keep large image strings as byte spans, so JSON.parse never makes another base64-sized string. Decode lazily: thought
// steps may contain draft images, which must never become outputs or consume decoded-image memory.
export async function readImageResponse(response) {
  const raw = new Uint8Array(await response.arrayBuffer());
  const plain = () => { try { return JSON.parse(textDecoder.decode(raw)); } catch { return null; } };
  try {
    const spans = [], parts = [];
    let last = 0;
    const space = byte => [32, 9, 10, 13].includes(byte);
    const endOfString = start => {
      let end = start;
      while (end < raw.length && raw[end] !== 34) { if (raw[end] === 92) end++; end++; }
      if (end === raw.length) throw new Error('Unterminated string');
      return end;
    };
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== 34) continue;
      const start = i + 1, end = endOfString(start);
      i = end;
      if (end - start !== 4 && end - start !== 8) continue;
      const key = textDecoder.decode(raw.subarray(start, end));
      if (key !== 'data' && key !== 'b64_json') continue;
      let value = end + 1;
      while (space(raw[value])) value++;
      if (raw[value++] !== 58) continue;
      while (space(raw[value])) value++;
      if (raw[value] !== 34) continue;
      const from = value + 1, to = endOfString(from);
      i = to;
      if (to - from <= 4096) continue;
      const span = raw.subarray(from, to);
      base64Length(span); // Escapes, whitespace and non-base64 bytes take the ordinary JSON path.
      parts.push(textDecoder.decode(raw.subarray(last, from)), `#${spans.length}`);
      spans.push(span); last = to;
    }
    if (!spans.length) return plain();
    parts.push(textDecoder.decode(raw.subarray(last)));
    const body = JSON.parse(parts.join(''));
    imageSpans.set(body, spans);
    return body;
  } catch { return plain(); }
}

export function decodeImage(data, name = 'Nano Banana', body) {
  let bytes, format;
  try {
    const span = typeof data === 'string' && /^#\d+$/.test(data) && imageSpans.get(body)?.[Number(data.slice(1))];
    if (span) bytes = decodeBase64Bytes(span);
    else if (Uint8Array.fromBase64) bytes = Uint8Array.fromBase64(data);
    else { const binary = atob(data); bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i); }
  }
  catch { throw new NanoError('upstream', `${name} returned an unreadable image. Try again.`); }
  try { format = imageFormat(bytes); }
  catch { throw new NanoError('upstream', `${name} returned an image format the board cannot show.`); }
  return { bytes, format, contentType: imageTypes[format] };
}

// Every final image in the response, in order; thought steps can carry draft images, so only model output counts.
export function nanoResult(status, body) {
  if (status < 200 || status > 299) {
    const error = body?.error;
    throw nanoError(status, errorCode(typeof error?.code === 'string' ? error.code : error?.status), error?.message);
  }
  if (!body || typeof body !== 'object') throw new NanoError('upstream', 'Nano Banana returned an unreadable response. Try again.');
  const blocks = [...(Array.isArray(body.steps) ? body.steps : []).filter(step => step?.type === 'model_output').flatMap(step => Array.isArray(step.content) ? step.content : []),
    ...(Array.isArray(body.outputs) ? body.outputs : [])];
  const images = blocks.filter(block => block?.type === 'image' && typeof block.data === 'string' && block.data).map(block => decodeImage(block.data, 'Nano Banana', body));
  if (!images.length) {
    const failure = Array.isArray(body.errors) ? body.errors[0] : undefined;
    if (failure || ['failed', 'cancelled'].includes(body.status)) throw nanoError(0, errorCode(failure?.code), failure?.message);
    const text = clean(blocks.filter(block => block?.type === 'text').map(block => block.text).join(' '));
    throw new NanoError('no_image', text ? `Nano Banana returned no image: “${text}”` : 'Nano Banana returned no image. Try rephrasing the prompt.');
  }
  return { images, usage: body.usage };
}

const tokens = value => Number.isFinite(value) && value > 0 ? value : 0;
// A deliberately high guess, used to reserve budget before the call and when Google reports no usage: the prompt at about
// 3 characters per token, each reference at full resolution, the chosen size's image and a generous thinking allowance.
const outputTokens = imageSize => nanoImageTokens[imageSize] || nanoPrices.imageTokens;
export function nanoEstimate({ promptLength = 0, references = 0, images = 1, imageSize, thinking } = {}) {
  const input = Math.ceil(promptLength / 3) + references * nanoPrices.imageTokens;
  return (input * nanoPrices.input + images * outputTokens(imageSize) * nanoPrices.imageOutput + (nanoThinkingTokens[thinking] || nanoThinkingTokens.medium) * nanoPrices.textOutput) / 1e6;
}

// A description's reserve: the prompt, each reference as a full tile set, and a generous answer with thinking.
export function describeEstimate({ promptLength = 0, references = 0 } = {}) {
  return ((Math.ceil(promptLength / 3) + references * 1500) * describePrices.input + 6000 * describePrices.output) / 1e6;
}
export function describeCost(usage, fallback) {
  if (!usage || typeof usage !== 'object' || !(Number.isFinite(usage.total_input_tokens) || Number.isFinite(usage.total_output_tokens))) return describeEstimate(fallback);
  return (tokens(usage.total_input_tokens) * describePrices.input + (tokens(usage.total_output_tokens) + tokens(usage.total_thought_tokens)) * describePrices.output) / 1e6;
}

// The written answer of a describe call; errors read like those of image calls.
export function describeResult(status, body) {
  if (status < 200 || status > 299) {
    const error = body?.error;
    throw nanoError(status, errorCode(typeof error?.code === 'string' ? error.code : error?.status), error?.message);
  }
  if (!body || typeof body !== 'object') throw new NanoError('upstream', 'Gemini returned an unreadable response. Try again.');
  const blocks = [...(Array.isArray(body.steps) ? body.steps : []).filter(step => step?.type === 'model_output').flatMap(step => Array.isArray(step.content) ? step.content : []),
    ...(Array.isArray(body.outputs) ? body.outputs : [])];
  const text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n\n').trim();
  if (!text) {
    const failure = Array.isArray(body.errors) ? body.errors[0] : undefined;
    if (failure || ['failed', 'cancelled'].includes(body.status)) throw nanoError(0, errorCode(failure?.code), failure?.message);
    throw new NanoError('no_text', 'Gemini returned no description. Try again.');
  }
  return { text, usage: body.usage };
}

// What the call cost, from the usage Google returned with it.
export function nanoCost(usage, fallback) {
  if (!usage || typeof usage !== 'object' || !(Number.isFinite(usage.total_input_tokens) || Number.isFinite(usage.total_output_tokens))) return nanoEstimate(fallback);
  const image = (Array.isArray(usage.output_tokens_by_modality) ? usage.output_tokens_by_modality : []).find(entry => String(entry?.modality).toLowerCase() === 'image');
  const imageTokens = image ? tokens(image.tokens) : (fallback?.images ?? 1) * outputTokens(fallback?.imageSize), text = Math.max(0, tokens(usage.total_output_tokens) - imageTokens);
  return (tokens(usage.total_input_tokens) * nanoPrices.input + imageTokens * nanoPrices.imageOutput + (text + tokens(usage.total_thought_tokens)) * nanoPrices.textOutput) / 1e6;
}
