import { useSyncExternalStore } from 'react';

// Per viewer, not per board: video cards play muted on a loop unless this viewer turned it off in Settings.
// Without a saved choice it follows the system's reduced-motion setting.
export const videoAutoplayKey = 'concept-graph-video-autoplay';
export function readVideoAutoplay(storage, reducedMotion = false) {
  let saved = null;
  try { saved = storage?.getItem(videoAutoplayKey) ?? null; } catch { /* Blocked storage keeps the default. */ }
  return saved === null ? !reducedMotion : saved === 'on';
}

const listeners = new Set();
const local = () => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };
const reduced = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let current, watching = false;
const read = () => current ??= readVideoAutoplay(local(), reduced());
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = listener => {
  listeners.add(listener);
  // One listener for every card: another tab of this browser changed the setting.
  if (!watching && typeof window !== 'undefined') {
    watching = true;
    window.addEventListener('storage', event => { if (event.key === videoAutoplayKey || event.key === null) { current = undefined; notify(); } });
  }
  return () => listeners.delete(listener);
};
export function setVideoAutoplay(on) {
  current = !!on;
  try { local()?.setItem(videoAutoplayKey, on ? 'on' : 'off'); } catch { /* Still applies to this tab. */ }
  notify();
}
export const useVideoAutoplay = () => useSyncExternalStore(subscribe, read, () => false);
