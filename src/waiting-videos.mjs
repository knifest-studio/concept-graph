// The clips a placeholder plays while a run works are not ours to redistribute, so the app bundles none of them:
// the site hosts them, lists them at /clips/index.json, and scripts/upload-waiting-clips.mjs puts them there. They
// stay out of the repository and the release packages, and anywhere the list is empty a placeholder shimmers alone.
export const clipPattern = /^[a-z\d][a-z\d-]{0,39}\.mp4$/;
export const clipIndex = '/clips/index.json';

export function siteClipUrls(index) {
  if (!Array.isArray(index)) return [];
  return [...new Set(index)].filter(name => typeof name === 'string' && clipPattern.test(name)).map(name => `/clips/${name}`);
}

// Resolved once per page: a board that never reaches the index keeps shimmering and never retries.
let loading;
export let allWaitingVideos = [];

export function loadWaitingVideos(fetcher = globalThis.fetch?.bind(globalThis)) {
  loading ??= (async () => {
    try {
      const response = await fetcher(clipIndex, { cache: 'no-cache' });
      if (response.ok) allWaitingVideos = siteClipUrls(await response.json());
    } catch {}
    return allWaitingVideos;
  })();
  return loading;
}

export function resetWaitingVideos() { loading = undefined; allWaitingVideos = []; }

// Which clip a placeholder shows at a given step. The seed comes from the node id, so a placeholder keeps its own
// clip while it re-renders, neighbouring placeholders start on different ones, and they step together from there.
export function clipAt(seed, step, clips = allWaitingVideos) {
  if (!clips.length) return undefined;
  return clips[(seed + step) % clips.length];
}
