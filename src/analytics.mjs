import { privateTextSelector, stripUserContent, errorMessage } from './analytics-privacy.mjs';
import { controlName, shortcut, shortcutControl, rageDetector, splitEvents, sanitizeEvent } from './analytics-core.mjs';

export const analyticsPreferenceKey = 'concept-graph-analytics';
export const analyticsEnabled = () => { if (preferenceOverride !== null) return preferenceOverride; try { return localStorage.getItem(analyticsPreferenceKey) !== 'off'; } catch { return true; } };
let preferenceOverride = null, lastAction = { via: 'toolbar', time: 0 };
export const analyticsVia = fallback => Date.now() - lastAction.time < 3000 ? lastAction.via : fallback;
let tabSession = null;
let current = null, account = null, ready = false, context = { route: 'boards', board: '', page: '' }, zoom = () => 1;
const listeners = new Set();
export const subscribeAnalytics = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export function setAnalyticsEnabled(enabled) {
  preferenceOverride = !!enabled;
  try { localStorage.setItem(analyticsPreferenceKey, enabled ? 'on' : 'off'); } catch {}
  if (!enabled) { current?.stop(); current = null; }
  else if (account && !current) current = createSession();
  listeners.forEach(listener => listener());
}
export function track(name, data = {}, kind = 'app', area = '') { current?.event(kind, name, data, area); }
export function analyticsView(route, board = '', page = '') {
  if (context.route === route && context.board === board && context.page === page) return;
  const previous = context; context = { route, board, page }; if (route !== 'board') zoom = () => 1;
  track(previous.board === board && previous.page !== page ? 'page_view' : 'route_view', {}, 'view');
}
export function analyticsViewport(read) { zoom = read || (() => 1); }
export function analyticsReady() { ready = true; current?.record(); }
export function startAnalytics(user) {
  if (account !== user) { current?.stop(); current = null; account = user; }
  if (account && tabSession?.account !== account) tabSession = { account, id: crypto.randomUUID(), started: Date.now(), eventSeq: 0, replaySeq: 0, replayBytes: 0, firstGeneration: false, active: 0 };
  if (account && analyticsEnabled() && !current) current = createSession();
  const changed = e => { if (e.key !== analyticsPreferenceKey) return; preferenceOverride = null; if (!analyticsEnabled()) { current?.stop(); current = null; } else if (account && !current) current = createSession(); listeners.forEach(listener => listener()); };
  window.addEventListener('storage', changed);
  return () => { window.removeEventListener('storage', changed); current?.stop(); current = null; account = null; ready = false; };
}
export function elementName(element) {
  const hidden = !!element.closest(privateTextSelector), label = !hidden && element.labels?.[0];
  return element.dataset?.analyticsName ? stripUserContent(element.dataset.analyticsName).slice(0, 60) : controlName({ private: hidden, ariaLabel: element.getAttribute('aria-label'), tooltip: element.dataset?.tooltip,
    text: ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName) ? label?.textContent : element.textContent,
    tag: element.tagName?.toLowerCase(), role: element.getAttribute('role'), type: element.getAttribute('type'), id: element.id });
}
export function elementArea(element) {
  if (!element?.closest) return 'editor';
  const dialog = element.closest('[role="dialog"]'), explicit = element.closest('[data-analytics-area]');
  if (explicit && (!dialog || dialog.contains(explicit))) return explicit.dataset.analyticsArea;
  if (dialog) return `dialog:${controlName({ ariaLabel: dialog.getAttribute('aria-label'), text: document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent, private: !!dialog.closest(privateTextSelector), tag: 'dialog' })}`;
  const node = element.closest('.react-flow__node');
  if (node) return `node:${[...node.classList].find(name => name.startsWith('react-flow__node-'))?.slice(17) || 'unknown'}:${element.closest('header') ? 'header' : 'body'}`;
  return explicit?.dataset.analyticsArea || 'editor';
}
function createSession() {
  const state = tabSession, session = state.id, started = state.started, abort = new AbortController(), rage = rageDetector();
  let queue = [], inflight = [], sending = false, stopped = false, recorder = null, recording = false, active = state.active, activeSince = document.hidden ? 0 : Date.now(), lastInteraction = Date.now();
  const on = (target, type, callback, options = {}) => target.addEventListener(type, callback, { ...options, signal: abort.signal });
  const elapsed = () => { const now = Date.now(); return { duration: now - started, active: active + (activeSince ? Math.max(0, Math.min(now, lastInteraction + 60000) - activeSince) : 0) }; };
  const interact = () => {
    const now = Date.now();
    if (activeSince && now > lastInteraction + 60000) { active += Math.max(0, lastInteraction + 60000 - activeSince); activeSince = now; }
    if (!document.hidden && !activeSince) activeSince = now;
    lastInteraction = now;
  };
  function event(kind, name, data, area = '') {
    if (stopped) return;
    if (name === 'generation_started' && !state.firstGeneration) { state.firstGeneration = true; event('app', 'time_to_first_generation', { duration: Date.now() - started }); }
    const clean = sanitizeEvent({ seq: state.eventSeq++, time: Date.now(), kind, name, area: area || 'editor', board: context.board, details: { ...context, ...data } });
    if (!clean) return;
    queue.push(clean);
    if (queue.length > 2000) queue.splice(0, queue.length - 2000);
    if (queue.length >= 200) void flush();
  }
  async function flush(unload = false) {
    if (stopped || !queue.length && !(unload && inflight.length) || sending && !unload) return;
    const pending = unload ? [...inflight.flat(), ...queue] : queue; queue = [];
    const batches = splitEvents(session, pending);
    if (unload) {
      for (const events of batches) {
        const body = new Blob([JSON.stringify({ session, events })], { type: 'application/json' });
        if (!navigator.sendBeacon?.('/api/analytics/events', body)) fetch('/api/analytics/events', { method: 'POST', body, credentials: 'same-origin', keepalive: true }).catch(() => {});
      }
      return;
    }
    sending = true; inflight = batches.slice();
    try {
      for (let i = 0; i < batches.length; i++) {
        if (stopped) break;
        try {
          const response = await fetch('/api/analytics/events', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session, events: batches[i] }), signal: abort.signal });
          if (!response.ok && (response.status === 429 || response.status >= 500)) throw new Error();
          inflight.shift();
        } catch { if (!stopped) queue = [...batches.slice(i).flat(), ...queue].slice(-2000); break; }
      }
    } finally { sending = false; inflight = []; }
  }
  let lastPoint = { x: 0, y: 0, pointer: 'keyboard' };
  const controls = 'button,a,[role="button"],[role="menuitem"],[role="tab"],[role="option"],select,input[type="checkbox"],input[type="radio"],summary';
  const point = event => ({ x: event.clientX / Math.max(1, innerWidth), y: event.clientY / Math.max(1, innerHeight), width: innerWidth, height: innerHeight, zoom: zoom(), pointer: event.pointerType || (event.detail === 0 ? 'keyboard' : lastPoint.pointer || 'mouse'), meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey });
  on(document, 'click', e => {
    const target = e.target?.closest?.('*'); if (!target) return;
    const control = target.closest(controls), node = target.closest('.react-flow__node'), pane = target.closest('.react-flow__pane');
    const name = control ? elementName(control) : node ? 'node' : pane ? 'canvas' : '';
    if (!name) return;
    const area = elementArea(target), nodeType = node ? [...node.classList].find(name => name.startsWith('react-flow__node-'))?.slice(17) : undefined;
    lastAction = { via: 'toolbar', time: Date.now() };
    const data = { ...point(e), nodeType }; event('click', name, data, area);
    if (target.closest('[data-analytics-area="context-menu"]')) event('context', 'context_menu_chosen', { target: name }, area);
    if (e.detail !== 0 && rage({ x: e.clientX, y: e.clientY, time: Date.now() })) event('rage', name, data, area);
  }, { capture: true, passive: true });
  on(document, 'change', e => { const target = e.target; if (target?.matches?.('select,input[type="checkbox"],input[type="radio"]')) event('change', elementName(target), { ...lastPoint, width: innerWidth, height: innerHeight, zoom: zoom(), checked: target.checked }, elementArea(target)); }, { capture: true });
  on(document, 'keydown', e => {
    const combo = shortcut(e, !!e.target?.closest?.('input,textarea,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'));
    if (combo) lastAction = { via: 'shortcut', time: Date.now() };
    if (combo) event('shortcut', shortcutControl(combo), { combo, zoom: zoom() }, elementArea(e.target));
    lastPoint = { pointer: 'keyboard' }; interact();
  }, { capture: true });
  on(document, 'paste', () => { lastAction = { via: 'paste', time: Date.now() }; }, { capture: true });
  on(document, 'drop', () => { lastAction = { via: 'drop', time: Date.now() }; }, { capture: true });
  on(document, 'pointerdown', e => { lastPoint = point(e); interact(); }, { capture: true, passive: true });
  on(document, 'pointermove', interact, { passive: true });
  on(document, 'scroll', interact, { capture: true, passive: true });

  on(window, 'error', e => event('error', 'window_error', { message: String(e.message || 'Resource failed to load') }));
  on(window, 'unhandledrejection', e => event('error', 'unhandledrejection', { message: String(e.reason?.message || e.reason || 'Unknown rejection') }));
  const seenDialogs = new WeakSet(), seenErrors = new WeakMap();
  function inspect(root) {
    if (root.nodeType !== 1) return;
    const elements = [...(root.matches('[role="dialog"],[role="alert"],[data-analytics-panel]') ? [root] : []), ...root.querySelectorAll('[role="dialog"],[role="alert"],[data-analytics-panel]')];
    for (const element of elements) {
      if (element.matches('[role="dialog"],[data-analytics-panel]') && !seenDialogs.has(element)) {
        seenDialogs.add(element); event('view', 'dialog_opened', { target: element.dataset.analyticsPanel || elementArea(element) }, elementArea(element));
      }
      if (element.getAttribute('role') === 'alert') {
        const message = errorMessage(element.textContent);
        if (message && seenErrors.get(element) !== message) { seenErrors.set(element, message); event('error', 'notify', { message }, elementArea(element)); }
      }
    }
  }
  // Inspect only inserted subtrees and changed alerts, never rescan the board on every canvas mutation.
  const observer = new MutationObserver(records => { for (const record of records) { for (const node of record.addedNodes) inspect(node); const alert = record.target.parentElement?.closest('[role="alert"]'); if (alert) inspect(alert); } });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true }); inspect(document.body);
  on(document, 'visibilitychange', () => {
    const now = Date.now();
    if (document.hidden && activeSince) { active += Math.max(0, Math.min(now, lastInteraction + 60000) - activeSince); activeSince = 0; }
    if (!document.hidden) { activeSince = now; lastInteraction = now; }
    event('session', 'visibility', { ...elapsed(), visible: !document.hidden });
    void flush(document.hidden); recorder?.flush(document.hidden);
  });
  on(window, 'pagehide', () => { event('session', 'session_end', elapsed()); void flush(true); recorder?.flush(true); });
  const timer = setInterval(() => { event('session', 'heartbeat', elapsed()); void flush(); }, 10000);
  const nav = performance.getEntriesByType('navigation')[0];
  event('session', 'session_start', { width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height, dpr: devicePixelRatio,
    platform: navigator.userAgentData?.platform || navigator.platform, userAgent: navigator.userAgent, language: navigator.language, uiLanguage: document.documentElement.lang, theme: document.documentElement.dataset.theme || 'light',
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, touch: navigator.maxTouchPoints > 0, pointer: matchMedia('(pointer: coarse)').matches ? 'coarse' : 'fine',
    referrer: document.referrer, version: document.querySelector('meta[name="concept-graph-version"]')?.content, navigation: nav?.responseEnd, domReady: nav?.domContentLoadedEventEnd, load: nav?.loadEventEnd });
  event('view', 'route_view', {});
  async function record() {
    if (!ready || stopped || recording) return;
    recording = true;
    const idle = window.requestIdleCallback || (callback => setTimeout(callback, 1));
    idle(async () => {
      if (stopped) return;
      try { const module = await import('./analytics-replay.mjs'); if (!stopped) recorder = await module.recordSession(session, () => !stopped, state); }
      catch { /* Analytics must never break the editor. */ }
    }, { timeout: 3000 });
  }
  if (ready) void record();
  return { event, record, stop() { state.active = elapsed().active; stopped = true; queue = []; inflight = []; recorder?.stop(); abort.abort(); observer.disconnect(); clearInterval(timer); } };
}
