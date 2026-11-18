import { maxVideoBytes, validateMp4Header } from './video-assets.mjs';
import { t } from './i18n.mjs';

export const videoFile = file => /\.mp4$/i.test(file?.name || '') || file?.type === 'video/mp4';
export async function checkVideoFile(file) {
  if (!videoFile(file)) throw new Error(t('Choose an MP4 video.'));
  if (!file.size || file.size > maxVideoBytes) throw new Error(t('Videos can be at most 128 MB.'));
  validateMp4Header(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
}
// Only metadata and one poster frame are decoded; the original File is streamed by the upload request.
export async function videoMetadata(file, { document = globalThis.document, makeURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL } = {}) {
  await checkVideoFile(file);
  const video = document.createElement('video'), url = makeURL(file);
  video.preload = 'auto'; video.muted = true; video.playsInline = true;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { video.onloadeddata = video.onerror = null; reject(new Error(t('Could not read this video’s metadata.'))); }, 15000);
      video.onloadeddata = () => { clearTimeout(timer); video.onloadeddata = video.onerror = null; resolve(); };
      video.onerror = () => { clearTimeout(timer); video.onloadeddata = video.onerror = null; reject(new Error(t('Could not read this video’s metadata.'))); };
      video.src = url;
    });
    const { duration, videoWidth: width, videoHeight: height } = video;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400 || !width || !height) throw new Error(t('Could not read this video’s metadata.'));
    let poster;
    try {
      const canvas = document.createElement('canvas'), scale = Math.min(1, 1024 / Math.max(width, height));
      canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      poster = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    } catch { /* Metadata remains useful when a poster cannot be captured. */ }
    return { duration, width, height, aspect: height / width, ...(poster ? { poster } : {}) };
  } finally { video.removeAttribute('src'); video.load(); revokeURL(url); }
}
