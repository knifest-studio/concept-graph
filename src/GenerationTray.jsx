import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { advanceTray, readTrayPreference, retireRows, sameRows, trayPreferenceKey, traySummary, traySummaryText, trayTone, writeTrayPreference } from './generation-tray.mjs';
import { t } from './i18n.mjs';
import './generation-tray.css';

const storage = () => { try { return window.localStorage; } catch { return null; } };
const narrow = () => { try { return window.matchMedia('(max-width: 650px)').matches; } catch { return false; } };
const visibleNow = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
// Keyboard focus holds the rows like the pointer does; focus a mouse click leaves on a button does not, or a clicked row
// would keep every result on screen until the person happened to click elsewhere.
const keyboardInside = element => { try { const focused = document.activeElement; return !!element && element.contains(focused) && focused.matches(':focus-visible'); } catch { return false; } };
// With no saved choice the tray starts open on a desktop and folded on a phone-sized window, where it spans the board.
export const trayCollapsedFor = viewer => readTrayPreference(storage(), trayPreferenceKey(viewer), narrow());

const svg = { 'aria-hidden': true, width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
const icons = {
  collapse: <svg {...svg}><path d="m6 15 6-6 6 6"/></svg>,
  history: <svg {...svg}><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>,
  active: <svg {...svg} className="generation-tray-spinner"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>,
  done: <svg {...svg}><path d="m5 12 5 5 9-10"/></svg>,
  alert: <svg {...svg}><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5m0 3.5v.01"/></svg>
};
const toneIcon = tone => tone === 'active' ? icons.active : tone === 'done' ? icons.done : tone === 'idle' ? icons.history : icons.alert;

export function GenerationTray({ runs, launching, user, viewer = 'local', onFocus, onCancel, onHistory }) {
  const key = trayPreferenceKey(viewer), listId = useId();
  const section = useRef(null), toggle = useRef(null), chip = useRef(null), refocus = useRef(false);
  const runsRef = useRef(runs); runsRef.current = runs;
  const me = useRef(user?.name); me.current = user?.name;
  // Signs that this person is at the screen. They stay on this device: nothing about what someone has seen reaches the board.
  const lastInput = useRef(-Infinity), pointerInside = useRef(false), released = useRef(-Infinity), viewed = useRef(new Map());
  const context = () => ({ me: me.current, visible: visibleNow(), lastInputAt: lastInput.current, hovered: pointerInside.current || keyboardInside(section.current), releasedAt: released.current, viewed: viewed.current });
  const [state, setState] = useState(() => advanceTray(runs, undefined, Date.now(), context()));
  const update = useCallback(() => setState(current => {
    const next = advanceTray(runsRef.current, current, Date.now(), context());
    return next.retired === current.retired && sameRows(current.rows, next.rows) ? current : next;
  }), []);
  const [visible, setVisible] = useState(visibleNow);
  const rows = state.rows, awaiting = useRef(false); awaiting.current = rows.some(row => row.awaiting);
  useEffect(update, [runs, user?.name, update]);
  useEffect(() => {
    let queued = false;
    // A finished row waits for the person; the first touch after it settles starts its clock (once per frame at most).
    const input = () => { lastInput.current = Date.now(); if (awaiting.current && !queued) { queued = true; requestAnimationFrame(() => { queued = false; update(); }); } };
    const shown = () => { const now = visibleNow(); setVisible(now); if (now) released.current = Date.now(); update(); };
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel'];
    for (const name of events) window.addEventListener(name, input, { capture: true, passive: true });
    document.addEventListener('visibilitychange', shown);
    return () => { for (const name of events) window.removeEventListener(name, input, { capture: true }); document.removeEventListener('visibilitychange', shown); };
  }, [update]);
  // Ticks only while a clock runs and the tab is shown; a hidden tab holds every row and is brought up to date when shown.
  const ticking = visible && rows.some(row => row.active || Number.isFinite(row.expiresAt));
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [ticking, update]);

  const [collapsed, setCollapsed] = useState(() => readTrayPreference(storage(), key, narrow()));
  useEffect(() => {
    const read = () => setCollapsed(readTrayPreference(storage(), key, narrow()));
    read();
    // Another tab of this person changed it; until they choose, it follows the window's width.
    const synced = event => { if (event.key === key || event.key === null) read(); };
    let media = null;
    try { media = window.matchMedia('(max-width: 650px)'); media.addEventListener('change', read); } catch {}
    window.addEventListener('storage', synced);
    return () => { window.removeEventListener('storage', synced); try { media?.removeEventListener('change', read); } catch {} };
  }, [key]);
  const fold = value => { refocus.current = section.current?.contains(document.activeElement); setCollapsed(value); writeTrayPreference(storage(), key, value); };
  useEffect(() => { if (refocus.current) { refocus.current = false; (collapsed ? chip : toggle).current?.focus(); } }, [collapsed]);

  // A newly finished run is announced, and pulses a folded tray once; the tray never opens by itself.
  const newest = rows.reduce((latest, row) => Math.max(latest, row.settledAt ?? -Infinity), -Infinity);
  const announced = useRef(newest), [pulse, setPulse] = useState(0), [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!(newest > announced.current)) return;
    announced.current = newest;
    const row = rows.find(item => item.settledAt === newest);
    if (row) setAnnouncement(`${row.label}: ${row.status}`);
    if (collapsed) setPulse(count => count + 1);
  }, [newest]);

  const dismiss = ids => {
    const inside = section.current?.contains(document.activeElement);
    setState(current => retireRows(current, ids));
    if (inside) requestAnimationFrame(() => { if (!section.current?.contains(document.activeElement)) (toggle.current || chip.current)?.focus(); });
  };
  const show = run => { viewed.current.set(run.id, Date.now()); onFocus(run); update(); };
  // The tray goes away under the pointer when its last row is dismissed, and no pointerleave follows.
  const attach = useCallback(element => { section.current = element; if (!element && pointerInside.current) { pointerInside.current = false; released.current = Date.now(); } }, []);
  const hold = {
    onPointerEnter: () => { pointerInside.current = true; update(); },
    onPointerLeave: () => { pointerInside.current = false; released.current = Date.now(); update(); },
    onFocus: update,
    // Moving focus between the tray's own buttons is not leaving it.
    onBlur: event => { if (section.current?.contains(event.relatedTarget)) return; released.current = Date.now(); requestAnimationFrame(update); }
  };

  const summary = traySummary(rows), running = summary.active || (launching ? 1 : 0), failures = rows.filter(row => row.kind === 'failed');
  const chipSummary = { ...summary, active: running }, tone = trayTone(chipSummary), text = traySummaryText(chipSummary);
  const live = <span className="sr-only" role="status" data-analytics-private="">{[announcement, running ? t('{count} in progress', { count: running }) : ''].filter(Boolean).map(text => text.replace(/[.…!?]+$/, '')).join('. ')}</span>;
  if (!rows.length && !launching) return <><span className="canvas-tagline">{t('A little room to think bigger')}</span>{live}</>;
  return <><section ref={attach} className={`generation-tray${collapsed ? ` collapsed tone-${tone}` : ''}`} aria-label={t('Board generations')} {...hold}>
    {collapsed
      ? <button ref={chip} type="button" className="generation-tray-chip" aria-expanded="false" aria-controls={listId} aria-label={text ? `${text}. ${t('Show generations')}` : t('Show generations')} data-tooltip={t('Show generations')} onClick={() => fold(false)}>
        {toneIcon(tone)}<span>{text || t('Generations')}</span>{pulse > 0 && <i key={pulse} className="generation-tray-chip-pulse" aria-hidden="true"/>}
      </button>
      : <header><strong>{t('Generations')}</strong><span>{t('{count} in progress', { count: running })}</span>
        <div className="generation-tray-tools">
          {failures.length >= 2 && <button type="button" className="generation-tray-dismiss-all" data-analytics-name="Dismiss all" onClick={() => dismiss(failures.map(row => row.run.id))}>{t('Dismiss all')}</button>}
          {onHistory && <button type="button" className="generation-tray-icon" aria-label={t('Open History')} data-tooltip={t('Open History')} onClick={onHistory}>{icons.history}</button>}
          <button ref={toggle} type="button" className="generation-tray-icon" aria-expanded="true" aria-controls={listId} aria-label={t('Collapse generations')} data-tooltip={t('Collapse generations')} onClick={() => fold(true)}>{icons.collapse}</button>
        </div>
      </header>}
    <div id={listId} className="generation-tray-list" hidden={collapsed}>{launching && !rows.some(row => row.active) && <div className="generation-tray-row"><span>{t('Starting generation…')}</span></div>}{rows.map(row => <div key={row.run.id} className={`generation-tray-row ${row.kind}${row.fading ? ' fading' : ''}`}>
      <button type="button" className="generation-tray-focus" onClick={() => show(row.run)} aria-label={t('Show prompt: {label}', { label: row.label })}>
        <strong title={row.label}>{row.label}</strong>
        <span className="generation-tray-status"><span title={row.run.error ? t(row.run.error) : row.status}>{row.kind === 'done' && <svg className="feel-check" aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path pathLength="1" d="m3 8 3 3 7-7"/></svg>}{row.kind === 'partial' && icons.alert}{row.status}</span><time aria-label={t('Elapsed time')}>{row.elapsed}</time></span>
        {row.reason && <span className="generation-tray-reason" title={row.reason}>{row.reason}</span>}
        {user && row.run.by && <span className="generation-tray-person"><i style={{ background: row.run.by.color }}/>{row.run.by.name}</span>}
      </button>
      {row.active && (!user || row.run.by?.name === user.name) && <button type="button" className="generation-tray-action" aria-label={t('Cancel {label}', { label: row.label })} onClick={() => onCancel(row.run.id)}>{t('Cancel')}</button>}
      {row.error && <button type="button" className="generation-tray-action" aria-label={t('Dismiss error for {label}', { label: row.label })} onClick={() => dismiss([row.run.id])}>{t('Dismiss')}</button>}
    </div>)}</div>
  </section>{live}</>;
}
