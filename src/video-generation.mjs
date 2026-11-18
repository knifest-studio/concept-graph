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
import { maxVideoBytes } from './video-assets.mjs';

export const videoTask = 'video';
export const isVideo = node => node?.type === 'text' && node.data?.task === videoTask;
export const videoRoles = Object.freeze(['start', 'end', 'middle', 'reference']);
export const clipRoles = Object.freeze(['reference', 'edit', 'extend']);
export const rolesForVideoInput = input => input.kind === 'video' ? clipRoles : videoRoles;
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
  if (data.duration !== undefined && (output ? (!Number.isFinite(data.duration) || data.duration <= 0 || data.duration > 86400) : (!Number.isInteger(data.duration) || data.duration < 1 || data.duration > 120))) throw new Error('Invalid video duration.');
  if (data.videoResolution !== undefined && !videoResolutions.includes(data.videoResolution) && !['480P', '1080P'].includes(data.videoResolution)) throw new Error('Invalid video resolution.');
  if (data.videoAspectRatio !== undefined && !videoAspects.includes(data.videoAspectRatio) && !(output && data.videoAspectRatio === 'auto')) throw new Error('Invalid video aspect ratio.');
  if (data.videoAudio !== undefined && typeof data.videoAudio !== 'boolean') throw new Error('Invalid video audio setting.');
  if (data.videoRoles !== undefined && (!data.videoRoles || typeof data.videoRoles !== 'object' || Array.isArray(data.videoRoles) || Object.entries(data.videoRoles).some(([id, role]) => !id || id.length > 120 || ![...videoRoles, ...clipRoles].includes(role)) || Object.keys(data.videoRoles).length > 1000)) throw new Error('Invalid video input roles.');
}
// Missing roles are references, never inferred from numbering. Connection creation persists the first Start.
export const roleVideoInputs = (node, images) => images.map(image => ({ ...image, role: node.data.videoRoles?.[image.nodeId] || 'reference' }));
export const videoReasons = Object.freeze({
  kind: 'This role does not match the input kind.',
  editing: 'Only Seedance supports Edit or Extend video roles.',
  oneEdit: 'Choose only one video to Edit or Extend.',
  videoDuration: 'A video input needs a known, positive duration. Open it to load its metadata.',
  videoLength: 'A video input exceeds this model’s duration limit.',
  videoTotal: 'The combined input videos exceed this model’s duration limit.',
  videoCount: 'Too many video inputs for this model.',
  files: 'Too many input files for this model.',
  videoSize: 'A video input exceeds the board’s 128 MiB limit.',
  seedanceSize: 'Seedance videos need 300–6000 px per side and an aspect ratio from 0.4 to 2.5.',
  seedanceFps: 'Seedance videos need 24–60 fps.',
  autoEdit: 'Editing follows the input video’s length and format.',
  autoExtend: 'Extension follows the input video’s format.',
  duplicate: 'Only one Start and one End frame are allowed.', start: 'This model needs a Start frame when using frames.',
  middle: 'This model does not support Middle frames.', mixed: 'This model cannot combine frames and References.',
  minimaxMiddle: 'MiniMax Middle requires Start and End frames, at 480P or 768P.',
  manyMiddle: 'This model supports fewer Middle frames.', many: 'Too many images for this video endpoint.',
  shape: 'The aspect ratio follows the start image (or the end image for MiniMax end-only).',
  audio: 'This model has no audio toggle; its soundtrack setting cannot be changed.',
  limited: 'This setting is clamped to the selected model’s supported values.',
});
const resolutionPixels = value => ({ '2K': 1440, '4k': 2160, '768P': 768 })[value] || parseInt(value);
// Video-reference schemas/pricing re-read 2026-11-18 at the four reference-to-video llms.txt URLs above.
// MiniMax's page adds 24 fps examples: https://fal.ai/models/minimax/h3-max/reference-to-video#reference-videos
// Interpolate its token table, scaled by known FPS/aspect; otherwise assume 24 fps and 16:9. These are estimates.
function minimaxClipTokens(clip, seconds, resolution) {
  const rows = resolution === '480P' ? [[0, 0], [2, 4680], [5, 12480], [10, 26130], [15, 39780]] : [[0, 0], [2, 12096], [5, 32256], [10, 67536], [15, 102816]];
  const time = Math.min(clip.duration, seconds) * (clip.fps || 24) / 24;
  const high = rows.findIndex(([at]) => at >= time), index = high <= 0 ? rows.length - 1 : high;
  const [a, b] = [rows[index - 1], rows[index]], aspect = clip.width && clip.height ? clip.width / clip.height : 16 / 9;
  return (a[1] + (b[1] - a[1]) * (time - a[0]) / (b[0] - a[0])) * Math.max(aspect, 1 / aspect) / (16 / 9);
}
export function resolveVideo(node, images = []) {
  const model = videoModelOf(node), spec = videoModels[model], requested = { ...videoDefaults, ...Object.fromEntries(videoSettingsKeys.filter(key => node.data[key] !== undefined).map(key => [key, node.data[key]])) };
  const inputs = roleVideoInputs(node, images), pictures = inputs.filter(input => input.kind !== 'video');
  // An edit/extend source is the first video sent, without changing board numbers or any stored role.
  const videos = inputs.filter(input => input.kind === 'video').sort((a, b) => Number(b.role !== 'reference') - Number(a.role !== 'reference'));
  const by = role => pictures.filter(image => image.role === role), starts = by('start'), ends = by('end'), middles = by('middle'), references = by('reference');
  const edits = videos.filter(input => ['edit', 'extend'].includes(input.role)), task = edits[0]?.role === 'edit' ? 'editing' : edits[0]?.role === 'extend' ? 'extension' : 'reference';
  const mode = videos.length || references.length || (model === 'minimax' && middles.length) ? 'reference' : inputs.length ? 'image' : 'text';
  const endpoint = `${model === 'minimax' && mode === 'reference' ? 'minimax/h3-max' : spec.path}/${mode}-to-video`;
  const rates = model === 'minimax' && mode === 'reference' ? { '480P': .05, '768P': .08, '1080P': .16 } : model === 'kling' && videos.length ? { '720p': .094, '1080p': .141 } : spec.rates;
  const resolutions = Object.keys(rates), wanted = resolutionPixels(requested.videoResolution);
  let resolution = resolutions.find(value => value.toLowerCase() === requested.videoResolution.toLowerCase())
    || (model === 'minimax' && wanted === 720 ? '768P' : [...resolutions].reverse().find(value => resolutionPixels(value) <= wanted) || resolutions[0]);
  if (model === 'minimax' && middles.length && resolution === '1080P') resolution = '768P';
  const max = model === 'omni' && ends.length ? 10 : spec.max;
  const duration = Math.min(max, Math.max(spec.min, requested.duration));
  const followsImage = pictures.some(input => input.role !== 'reference') && (model === 'minimax' || (model === 'kling' && mode === 'image') || model === 'seedance');
  const autoLength = model === 'seedance' && task === 'editing', followsVideo = model === 'seedance' && task !== 'reference';
  const aspects = model === 'omni' ? ['16:9', '9:16'] : videoAspects;
  const applied = { videoModel: model, duration: autoLength ? 'auto' : duration, videoResolution: resolution, videoAspectRatio: followsImage || followsVideo ? 'auto' : aspects.includes(requested.videoAspectRatio) ? requested.videoAspectRatio : '16:9', ...(model === 'seedance' ? { videoAudio: requested.videoAudio } : model === 'omni' ? { videoAudio: true } : {}) };
  const unsupported = {};
  for (const key of videoSettingsKeys) if (node.data[key] !== undefined && requested[key] !== applied[key] && !(key === 'videoResolution' && model === 'minimax' && requested[key] === '720p' && applied[key] === '768P')) unsupported[key] = followsVideo && ['duration', 'videoAspectRatio'].includes(key) ? task === 'editing' ? videoReasons.autoEdit : videoReasons.autoExtend : key === 'videoAspectRatio' && followsImage ? videoReasons.shape : key === 'videoAudio' ? videoReasons.audio : videoReasons.limited;
  const issues = [], issue = (reason, list = inputs) => issues.push({ reason, nodeIds: list.map(image => image.nodeId) });
  for (const input of inputs) if (!rolesForVideoInput(input).includes(input.role)) issue(videoReasons.kind, [input]);
  if (edits.length && model !== 'seedance') issue(videoReasons.editing, edits);
  if (edits.length > 1) issue(videoReasons.oneEdit, edits);
  if (starts.length > 1 || ends.length > 1) issue(videoReasons.duplicate, [...starts, ...ends]);
  if (mode === 'image' && model !== 'minimax' && !starts.length) issue(videoReasons.start, inputs);
  if (middles.length && !['minimax', 'kling'].includes(model)) issue(videoReasons.middle, middles);
  if ((references.length || videos.length) && pictures.some(input => input.role !== 'reference') && ['omni', 'seedance'].includes(model)) issue(videoReasons.mixed);
  if (middles.length > (model === 'kling' ? 8 : 1)) issue(videoReasons.manyMiddle, middles);
  if (model === 'minimax' && middles.length && (!starts.length || !ends.length || resolution === '1080P')) issue(videoReasons.minimaxMiddle, middles);
  const limit = model === 'seedance' ? 30 : model === 'minimax' ? 12 : 10;
  if (mode === 'reference' && (model === 'minimax' ? references.length : pictures.length) > limit) issue(videoReasons.many, pictures);
  if (pictures.length > 30 || inputs.length > 50 || (model === 'minimax' && references.length + videos.length > 12)) issue(videoReasons.files);
  const limits = { minimax: { min: 2, max: 15, total: 15, count: 12 }, omni: { min: 0, max: 15, total: Infinity, count: 3 }, kling: { min: 3, max: 30, total: 30, count: 5 }, seedance: { min: 1.8, max: 30.2, total: 30.2, count: 10 } }[model];
  let inputSeconds = 0;
  for (const clip of videos) {
    if (!Number.isFinite(clip.duration) || clip.duration <= 0) issue(videoReasons.videoDuration, [clip]);
    else { inputSeconds += clip.duration; if (clip.duration < limits.min || clip.duration > limits.max) issue(videoReasons.videoLength, [clip]); }
    if (clip.bytes > maxVideoBytes) issue(videoReasons.videoSize, [clip]);
    if (model === 'seedance' && clip.width && clip.height && (Math.min(clip.width, clip.height) < 300 || Math.max(clip.width, clip.height) > 6000 || clip.width / clip.height < .4 || clip.width / clip.height > 2.5)) issue(videoReasons.seedanceSize, [clip]);
    if (model === 'seedance' && clip.fps !== undefined && (clip.fps < 24 || clip.fps > 60)) issue(videoReasons.seedanceFps, [clip]);
  }
  if (videos.length > limits.count) issue(videoReasons.videoCount, videos);
  if (inputSeconds > limits.total + 1e-6) issue(videoReasons.videoTotal, videos);
  const outputSeconds = autoLength && Number.isFinite(edits[0]?.duration) ? edits[0].duration : duration;
  const frameTokens = pictures.length - references.length, side = resolutionPixels(resolution), aspect = followsImage ? (starts[0] || ends[0])?.aspect : undefined;
  const ratio = aspect ? 1 / aspect : applied.videoAspectRatio === 'auto' ? 16 / 9 : (() => { const [w, h] = applied.videoAspectRatio.split(':').map(Number); return w / h; })();
  const tokens = references.reduce((sum, image) => sum + 1024 * Math.max(image.aspect || 1, 1 / (image.aspect || 1)), 0) + frameTokens * (side === 1080 ? 768 : side) ** 2 * Math.max(ratio, 1 / ratio) / 1024;
  const videoTokens = model === 'minimax' ? videos.reduce((sum, clip) => sum + (clip.duration > 0 ? minimaxClipTokens(clip, outputSeconds, resolution) : 0), 0) : 0;
  const surcharge = model === 'minimax' && mode === 'reference' ? Math.max(0, tokens + videoTokens - 4096) * .02 / 1000 : 0;
  // Omni publishes $1.50/M input tokens, but no video token/second conversion. Estimate 1024 tokens/s, labelled in the UI.
  const omniInputUsd = model === 'omni' ? inputSeconds * 1024 * 1.5 / 1e6 : 0;
  const billedSeconds = videos.length && model === 'kling' ? Math.max(inputSeconds + outputSeconds, 2 * outputSeconds) : videos.length && model === 'seedance' ? inputSeconds + outputSeconds : outputSeconds;
  const rate = rates[resolution] * (videos.length && model === 'seedance' ? .6 : 1);
  const usd = Math.ceil((billedSeconds * rate + surcharge + omniInputUsd) * 10000) / 10000;
  return { model, mode, task, endpoint, requested, applied, unsupported, inputs, videos, issues, blocked: !!issues.length, usd, rate, billedSeconds, inputSeconds, outputSeconds, resolutions, aspects, followsImage, followsVideo, autoLength };
}
export function rewriteVideoMentions(prompt, resolved) {
  const refs = resolved.inputs.filter(input => input.kind !== 'video' && input.role === 'reference'), mids = resolved.inputs.filter(input => input.role === 'middle');
  return prompt.replace(/#(\d+)\b/g, (mention, number) => {
    const image = resolved.inputs.find(input => input.number === Number(number));
    if (!image) return mention;
    if (image.kind === 'video') { const index = resolved.videos.indexOf(image); return resolved.model === 'minimax' ? `Video ${index + 1}` : resolved.model === 'omni' ? `<VIDEO_REF_${index}>` : `@Video${index + 1}`; }
    if (image.role !== 'reference') return image.role === 'middle' ? `the middle frame ${mids.indexOf(image) + 1}` : `the ${image.role} frame`;
    const index = refs.indexOf(image);
    return resolved.model === 'minimax' ? `Image ${index + 1}` : resolved.model === 'omni' ? `<IMAGE_REF_${index}>` : `@Image${index + 1}`;
  });
}
export function videoInput(resolved, prompt, urls) {
  if (resolved.blocked) throw new Error(resolved.issues[0].reason);
  const { applied: a, inputs, model, mode } = resolved, url = role => urls[inputs.findIndex(input => input.kind !== 'video' && input.role === role)];
  const input = { prompt: rewriteVideoMentions(prompt, resolved), duration: model === 'seedance' ? String(a.duration) : a.duration, resolution: a.videoResolution };
  if (!resolved.followsImage || model === 'seedance') input.aspect_ratio = a.videoAspectRatio;
  if (model === 'seedance') { input.generate_audio = a.videoAudio; input.codec = 'H264'; if (resolved.videos.length) input.task = resolved.task; }
  if (model === 'minimax' && mode === 'reference') input.prompt_expansion_mode = 'balanced';
  if (url('start')) input[model === 'kling' ? 'start_image_url' : 'image_url'] = url('start');
  if (url('end')) input.end_image_url = url('end');
  const middles = inputs.flatMap((image, index) => image.kind !== 'video' && image.role === 'middle' ? [urls[index]] : []);
  if (middles.length && model === 'kling') input.middle_image_urls = middles;
  if (middles.length && model === 'minimax') { input.middle_image_url = middles[0]; input.middle_frame_time = a.duration / 2; }
  const refs = inputs.flatMap((image, index) => image.kind !== 'video' && image.role === 'reference' ? [urls[index]] : []);
  if (refs.length) input[model === 'minimax' ? 'reference_image_urls' : 'image_urls'] = refs;
  if (resolved.videos.length) input[['minimax', 'omni'].includes(model) ? 'reference_video_urls' : 'video_urls'] = resolved.videos.map(video => urls[inputs.indexOf(video)]);
  return input;
}
