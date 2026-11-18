import { maxVideoBytes, validateMp4Header } from './video-assets.mjs';
import { t } from './i18n.mjs';

export const videoFile = file => /\.mp4$/i.test(file?.name || '') || file?.type === 'video/mp4';
export async function checkVideoFile(file) {
  if (!videoFile(file)) throw new Error(t('Choose an MP4 video.'));
  if (!file.size || file.size > maxVideoBytes) throw new Error(t('Videos can be at most 128 MB.'));
  validateMp4Header(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
}
const offscreenVideo = document => { const video = document.createElement('video'); video.preload = 'auto'; video.muted = true; video.playsInline = true; return video; };
const firstFrame = (video, src, message, wait = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { video.onloadeddata = video.onerror = null; reject(new Error(message)); }, wait);
  video.onloadeddata = () => { clearTimeout(timer); video.onloadeddata = video.onerror = null; resolve(); };
  video.onerror = () => { clearTimeout(timer); video.onloadeddata = video.onerror = null; reject(new Error(message)); };
  video.src = src;
});
// The loaded frame as a PNG at most `size` px on its long side, or undefined when the browser cannot draw it.
async function drawFrame(video, size, document) {
  const { videoWidth: width, videoHeight: height } = video;
  if (!width || !height) return undefined;
  try {
    const canvas = document.createElement('canvas'), scale = Math.min(1, size / Math.max(width, height));
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/png')) || undefined;
  } catch { return undefined; }
}
// Only metadata and one poster frame are decoded; the original File is streamed by the upload request.
export async function videoMetadata(file, { document = globalThis.document, makeURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL } = {}) {
  await checkVideoFile(file);
  const video = offscreenVideo(document), url = makeURL(file);
  try {
    await firstFrame(video, url, t('Could not read this video’s metadata.'));
    const { duration, videoWidth: width, videoHeight: height } = video;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400 || !width || !height) throw new Error(t('Could not read this video’s metadata.'));
    const poster = await drawFrame(video, 1024, document); // Metadata remains useful when a poster cannot be captured.
    return { duration, width, height, aspect: height / width, ...(poster ? { poster } : {}) };
  } finally { video.removeAttribute('src'); video.load(); revokeURL(url); }
}
// A stored video's first frame, for generated videos that had no start image to use as their poster.
export async function videoPoster(src, { document = globalThis.document } = {}) {
  const video = offscreenVideo(document);
  try {
    await firstFrame(video, src, 'Could not load the video for its poster.', 30000);
    return await drawFrame(video, 768, document);
  } finally { video.removeAttribute('src'); video.load(); }
}
