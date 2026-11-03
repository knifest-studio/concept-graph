export function relativeTime(value, now = Date.now()) {
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return 'recently';
  const seconds = Math.max(0, Math.floor((now - date) / 1000));
  if (seconds < 60) return 'just now';
  for (const [unit, size] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (seconds >= size) { const count = Math.floor(seconds / size); return `${count} ${unit}${count === 1 ? '' : 's'} ago`; }
  }
}

export function coverHue(id) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return (hash >>> 0) % 360;
}
