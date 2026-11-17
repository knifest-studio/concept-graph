export const newerVersion = (page, value, dismissed = '') => typeof page === 'string' && !!page && typeof value?.version === 'string' && !!value.version.trim() && value.version !== page && value.version !== dismissed ? value.version : '';

// A missing file (including the SPA fallback), an offline tab or a dev page needs no notice.
export function watchVersion({ page, document, window, fetch, updated }) {
  if (!page) return () => {};
  let stopped = false, pending = false;
  const check = async () => {
    if (pending) return;
    pending = true;
    try {
      const response = await fetch('/version.json', { cache: 'no-store' });
      if (response.ok) { const version = newerVersion(page, await response.json()); if (!stopped && version) updated(version); }
    } catch {} finally { pending = false; }
  };
  const visible = () => { if (!document.hidden) void check(); };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('concept-graph-reconnected', check);
  const timer = window.setInterval(visible, 10 * 60000);
  visible();
  return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('concept-graph-reconnected', check); };
}
