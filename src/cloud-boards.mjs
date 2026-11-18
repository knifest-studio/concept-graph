// `words` lets the interface word it in its own language; this module is also bundled into the worker, so it stays plain.
const englishTime = { recently: 'recently', now: 'just now', ago: (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'} ago` };
export function relativeTime(value, now = Date.now(), words = englishTime) {
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return words.recently;
  const seconds = Math.max(0, Math.floor((now - date) / 1000));
  if (seconds < 60) return words.now;
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (seconds >= size) return words.ago(Math.floor(seconds / size), unit);
  }
}

// The interface's own words for relativeTime: catalog keys, translated where they are used.
export const agoForms = { year: ['{count} year ago', '{count} years ago'], month: ['{count} month ago', '{count} months ago'], day: ['{count} day ago', '{count} days ago'], hour: ['{count} hour ago', '{count} hours ago'], minute: ['{count} minute ago', '{count} minutes ago'] };

export function coverHue(id) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (hash >>> 0) % 360;
}

// Board links are /b/<board ID>: the app opens that board after sign-in, and Back returns to the boards home.
export const boardPath = id => `/b/${encodeURIComponent(id)}`;
export function boardFromPath(pathname) {
  const match = /^\/b\/([^/]+)\/?$/.exec(pathname);
  try { return match ? decodeURIComponent(match[1]) : null; } catch { return null; }
}
export const nodePath = (boardId, nodeId) => `${boardPath(boardId)}#node=${encodeURIComponent(nodeId)}`;
export function nodeFromHash(hash) {
  if (typeof hash !== 'string' || hash.length > 1500 || hash.trim() !== hash || !/^#node=(?:[\w.!~*'()-]|%[\da-f]{2})+$/i.test(hash)) return null;
  try { const id = decodeURIComponent(hash.slice(6)); return id.length <= 120 ? id : null; } catch { return null; }
}
// Sign-in may return only to a board link on this site, or to an agent's connection waiting for it.
export const signInReturn = value => typeof value === 'string' && !/[\s\\]/.test(value) && (/^\/b\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(value.split('#')[0]) && (!value.includes('#') || nodeFromHash(value.slice(value.indexOf('#'))) !== null)
  || (value.length <= 2000 && /^\/oauth\/authorize\?[^#\s\\]*$/.test(value))) ? value : '/';

export const accessNames = { private: 'Only invited people', link: 'Anyone with the link', everyone: 'Everyone who signs in' };
export const accessBadges = { private: 'Private', link: 'Link', everyone: 'Everyone' };
export const roleNames = { owner: 'Owner', edit: 'Can edit', view: 'Can view' };
