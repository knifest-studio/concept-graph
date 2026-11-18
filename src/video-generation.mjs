// All endpoint schemas and prices read 2026-11-18:
// https://fal.ai/models/minimax/h3/text-to-video/llms.txt
// https://fal.ai/models/minimax/h3/image-to-video/llms.txt
// https://fal.ai/models/minimax/h3-max/reference-to-video/llms.txt
// https://fal.ai/models/google/gemini-omni-flash/v1.2/text-to-video/llms.txt
// https://fal.ai/models/google/gemini-omni-flash/v1.2/image-to-video/llms.txt
// https://fal.ai/models/google/gemini-omni-flash/v1.2/reference-to-video/llms.txt
// https://fal.ai/models/kling/v4/text-to-video/llms.txt
// https://fal.ai/models/kling/v4/image-to-video/llms.txt
// https://fal.ai/models/kling/v4/reference-to-video/llms.txt
// https://fal.ai/models/bytedance/seedance-2.5/text-to-video/llms.txt
// https://fal.ai/models/bytedance/seedance-2.5/image-to-video/llms.txt
// https://fal.ai/models/bytedance/seedance-2.5/reference-to-video/llms.txt
export const videoTask = 'video';
export const isVideo = node => node?.type === 'text' && node.data?.task === videoTask;
export const videoRoles = Object.freeze(['start', 'end', 'middle', 'reference']);
export const videoAspects = Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']);
export const videoResolutions = Object.freeze(['360p', '480p', '720p', '768P', '1080p', '2K', '4k']);
export const videoModels = Object.freeze({
  minimax: { name: 'MiniMax H3', path: 'minimax/h3', min: 5, max: 15, rates: { '480P': .05, '768P': .06, '2K': .13 } },
  omni: { name: 'Gemini Omni Flash 1.2', path: 'google/gemini-omni-flash/v1.2', min: 3, max: 15, rates: { '360p': .0273, '720p': .0819, '1080p': .1229, '4k': .2457 } },
  kling: { name: 'Kling 4.0', path: 'kling/v4', min: 3, max: 30, rates: { '720p': .157, '1080p': .235 } },
  seedance: { name: 'Seedance 2.5', path: 'bytedance/seedance-2.5', min: 4, max: 30, rates: { '480p': .2205, '720p': .473, '1080p': 1.164 } },
});
export const videoDefaults = Object.freeze({ videoModel: 'minimax', duration: 5, videoResolution: '720p', videoAspectRatio: '16:9', videoAudio: true });
export const videoModelOf = node => Object.hasOwn(videoModels, node?.data?.videoModel) ? node.data.videoModel : 'minimax';
export const videoSettingsKeys = Object.keys(videoDefaults);
export function validateVideo(data, output = false) {
  if (data.videoModel !== undefined && !Object.hasOwn(videoModels, data.videoModel)) throw new Error('Invalid video model.');
  if (data.duration !== undefined && (!Number.isInteger(data.duration) || data.duration < 1 || data.duration > 120)) throw new Error('Invalid video duration.');
  if (data.videoResolution !== undefined && !videoResolutions.includes(data.videoResolution) && !(output && ['480P', '1080P'].includes(data.videoResolution))) throw new Error('Invalid video resolution.');
  if (data.videoAspectRatio !== undefined && !videoAspects.includes(data.videoAspectRatio) && !(output && data.videoAspectRatio === 'auto')) throw new Error('Invalid video aspect ratio.');
  if (data.videoAudio !== undefined && typeof data.videoAudio !== 'boolean') throw new Error('Invalid video audio setting.');
  if (data.videoRoles !== undefined && (!data.videoRoles || typeof data.videoRoles !== 'object' || Array.isArray(data.videoRoles) || Object.entries(data.videoRoles).some(([id, role]) => !id || id.length > 120 || !videoRoles.includes(role)) || Object.keys(data.videoRoles).length > 1000)) throw new Error('Invalid video input roles.');
}
// Missing roles are references, never inferred from numbering. Connection creation persists the first Start.
export const roleVideoInputs = (node, images) => images.map(image => ({ ...image, role: node.data.videoRoles?.[image.nodeId] || 'reference' }));
export const videoReasons = Object.freeze({
  duplicate: 'Only one Start and one End frame are allowed.', start: 'This model needs a Start frame when using frames.',
  middle: 'This model does not support Middle frames.', mixed: 'This model cannot combine frames and References.',
  minimaxMiddle: 'MiniMax Middle requires Start and End frames, at 480P or 768P.',
  manyMiddle: 'This model supports fewer Middle frames.', many: 'Too many images for this video endpoint.',
  shape: 'The aspect ratio follows the start image (or the end image for MiniMax end-only).',
  audio: 'This model has no audio toggle; its soundtrack setting cannot be changed.',
  limited: 'This setting is clamped to the selected model’s supported values.',
});
const resolutionPixels = value => ({ '2K': 1440, '4k': 2160, '768P': 768 })[value] || parseInt(value);
export function resolveVideo(node, images = []) {
  const model = videoModelOf(node), spec = videoModels[model], requested = { ...videoDefaults, ...Object.fromEntries(videoSettingsKeys.filter(key => node.data[key] !== undefined).map(key => [key, node.data[key]])) };
  const inputs = roleVideoInputs(node, images), by = role => inputs.filter(image => image.role === role), starts = by('start'), ends = by('end'), middles = by('middle'), references = by('reference');
  const mode = references.length || (model === 'minimax' && middles.length) ? 'reference' : inputs.length ? 'image' : 'text';
  const endpoint = `${model === 'minimax' && mode === 'reference' ? 'minimax/h3-max' : spec.path}/${mode}-to-video`;
  const rates = model === 'minimax' && mode === 'reference' ? { '480P': .05, '768P': .08, '1080P': .16 } : spec.rates;
  const resolutions = Object.keys(rates), wanted = resolutionPixels(requested.videoResolution);
  // Match the 720p class to MiniMax's native 768P, then clamp down to avoid upgrading a stored choice's price.
  let resolution = resolutions.find(value => value.toLowerCase() === requested.videoResolution.toLowerCase())
    || (model === 'minimax' && wanted === 720 ? '768P' : [...resolutions].reverse().find(value => resolutionPixels(value) <= wanted) || resolutions[0]);
  if (model === 'minimax' && middles.length && resolution === '1080P') resolution = '768P';
  const max = model === 'omni' && ends.length ? 10 : spec.max;
  const duration = Math.min(max, Math.max(spec.min, requested.duration));
  const followsImage = inputs.some(input => input.role !== 'reference') && (model === 'minimax' || (model === 'kling' && mode === 'image') || model === 'seedance');
  const aspects = model === 'omni' ? ['16:9', '9:16'] : videoAspects;
  const applied = { videoModel: model, duration, videoResolution: resolution, videoAspectRatio: followsImage ? 'auto' : aspects.includes(requested.videoAspectRatio) ? requested.videoAspectRatio : '16:9', ...(model === 'seedance' ? { videoAudio: requested.videoAudio } : model === 'omni' ? { videoAudio: true } : {}) };
  // Only values someone chose can be changed by a model: defaults never show up as limits.
  const unsupported = {};
  for (const key of videoSettingsKeys) if (node.data[key] !== undefined && requested[key] !== applied[key] && !(key === 'videoResolution' && model === 'minimax' && requested[key] === '720p' && applied[key] === '768P')) unsupported[key] = key === 'videoAspectRatio' && followsImage ? videoReasons.shape : key === 'videoAudio' ? videoReasons.audio : videoReasons.limited;
  const issues = [];
  const issue = (reason, list = inputs) => issues.push({ reason, nodeIds: list.map(image => image.nodeId) });
  if (starts.length > 1 || ends.length > 1) issue(videoReasons.duplicate, [...starts, ...ends]);
  if (mode === 'image' && model !== 'minimax' && !starts.length) issue(videoReasons.start, inputs);
  if (middles.length && !['minimax', 'kling'].includes(model)) issue(videoReasons.middle, middles);
  if (references.length && inputs.length !== references.length && ['omni', 'seedance'].includes(model)) issue(videoReasons.mixed);
  if (middles.length > (model === 'kling' ? 8 : 1)) issue(videoReasons.manyMiddle, middles);
  if (model === 'minimax' && middles.length && (!starts.length || !ends.length || resolution === '1080P')) issue(videoReasons.minimaxMiddle, middles);
  const limit = model === 'seedance' ? 30 : model === 'minimax' ? 12 : 10;
  if ((mode === 'reference' && (model === 'minimax' ? references.length : inputs.length) > limit) || inputs.length > 30) issue(videoReasons.many);
  // H3 Max includes 4096 conditioning tokens. Frame tokens follow the canvas; reference images are estimated at 1024 each.
  // Non-square references and Omni's small text/image token charges can vary; the displayed cost is explicitly approximate.
  const frameTokens = inputs.length - references.length, side = resolutionPixels(resolution), aspect = followsImage ? (inputs.find(image => image.role === 'start') || inputs.find(image => image.role === 'end'))?.aspect : undefined;
  const ratio = aspect ? 1 / aspect : applied.videoAspectRatio === 'auto' ? 16 / 9 : (() => { const [w, h] = applied.videoAspectRatio.split(':').map(Number); return w / h; })();
  const tokens = references.reduce((sum, image) => sum + 1024 * Math.max(image.aspect || 1, 1 / (image.aspect || 1)), 0) + frameTokens * (side === 1080 ? 768 : side) ** 2 * Math.max(ratio, 1 / ratio) / 1024;
  const surcharge = model === 'minimax' && mode === 'reference' ? Math.max(0, tokens - 4096) * .02 / 1000 : 0;
  const usd = Math.ceil((duration * rates[resolution] + surcharge) * 10000) / 10000;
  return { model, mode, endpoint, requested, applied, unsupported, inputs, issues, blocked: !!issues.length, usd, rate: rates[resolution], resolutions, aspects, followsImage };
}
export function rewriteVideoMentions(prompt, resolved) {
  const refs = resolved.inputs.filter(input => input.role === 'reference'), mids = resolved.inputs.filter(input => input.role === 'middle');
  return prompt.replace(/#(\d+)\b/g, (mention, number) => {
    const image = resolved.inputs.find(input => input.number === Number(number));
    if (!image) return mention;
    if (image.role !== 'reference') return image.role === 'middle' ? `the middle frame ${mids.indexOf(image) + 1}` : `the ${image.role} frame`;
    const index = refs.indexOf(image);
    return resolved.model === 'minimax' ? `Image ${index + 1}` : resolved.model === 'omni' ? `<IMAGE_REF_${index}>` : `@Image${index + 1}`;
  });
}
export function videoInput(resolved, prompt, urls) {
  if (resolved.blocked) throw new Error(resolved.issues[0].reason);
  const { applied: a, inputs, model, mode } = resolved, url = role => urls[inputs.findIndex(input => input.role === role)];
  const input = { prompt: rewriteVideoMentions(prompt, resolved), duration: model === 'seedance' ? String(a.duration) : a.duration, resolution: a.videoResolution };
  if (!resolved.followsImage || model === 'seedance') input.aspect_ratio = a.videoAspectRatio;
  if (model === 'seedance') { input.generate_audio = a.videoAudio; input.codec = 'H264'; }
  if (model === 'minimax' && mode === 'reference') input.prompt_expansion_mode = 'balanced';
  if (url('start')) input[model === 'kling' ? 'start_image_url' : 'image_url'] = url('start');
  if (url('end')) input.end_image_url = url('end');
  const middles = inputs.flatMap((image, index) => image.role === 'middle' ? [urls[index]] : []);
  if (middles.length && model === 'kling') input.middle_image_urls = middles;
  if (middles.length && model === 'minimax') { input.middle_image_url = middles[0]; input.middle_frame_time = a.duration / 2; }
  const refs = inputs.flatMap((image, index) => image.role === 'reference' ? [urls[index]] : []);
  if (refs.length) input[model === 'minimax' ? 'reference_image_urls' : 'image_urls'] = refs;
  return input;
}
