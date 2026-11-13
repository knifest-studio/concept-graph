import React, { useEffect, useRef, useState } from 'react';
import { authorInitials, contrastColor } from './annotations.mjs';
import { t } from './i18n.mjs';

const fallback = '#6b6e89';
export const Avatar = ({ user, className = 'presence-avatar' }) => {
  const color = user.color || fallback;
  return <span data-analytics-private className={className} aria-hidden="true" style={{ background: color, color: contrastColor(color) }}>{authorInitials({ name: user.name || '?' })}</span>;
};

export function VoiceMark({ voice }) {
  if (!voice) return null;
  const label = t(voice.muted ? 'Microphone muted' : voice.speaking ? 'Speaking' : 'In voice');
  return <span className={`voice-mark ${voice.speaking ? 'speaking' : ''} ${voice.muted ? 'muted' : ''}`} role="img" aria-label={label} title={label}>
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>{voice.muted && <path d="m2 2 20 20"/>}</svg>
  </span>;
}

const Bell = ({ size = 14 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>;
const Arrow = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>;

// Who else is on the board, as in FigJam: overlapping avatars, the rest behind +N, which lists everyone with the page
// they are on. A person's avatar offers going to them or calling them over; the bell calls everyone. A person with two
// tabs open is shown once.
export function BoardPresence({ peers, pages, onFollow, onCall }) {
  // Which menu is open: false, 'more' for everyone, or a person's ID; `left` places a person's menu under their avatar.
  const [open, setOpen] = useState(false), [left, setLeft] = useState(0), [narrow, setNarrow] = useState(() => matchMedia('(max-width: 900px)').matches);
  const container = useRef(null), opener = useRef(null), panel = useRef(null);
  useEffect(() => {
    const query = matchMedia('(max-width: 900px)'), change = () => setNarrow(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const seen = new Set(), people = [...peers].sort((a, b) => Number(!!b.voice) - Number(!!a.voice)).filter(peer => { const key = `${peer.user.name}\u0000${peer.user.color}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const limit = narrow ? 3 : 5, shown = people.length > limit ? people.slice(0, limit - 1) : people, hidden = people.length - shown.length;
  useEffect(() => { if (open === 'more' ? !hidden : open && !people.some(peer => peer.id === open)) setOpen(false); }, [hidden, open, people.map(peer => peer.id).join()]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector('[role="menuitem"]')?.focus();
    const outside = event => { if (!container.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const pageName = id => pages.length > 1 ? pages.find(page => page.id === (id ?? pages[0].id))?.name || pages[0].name : '';
  const follow = peer => { setOpen(false); onFollow(peer.id); };
  const call = to => { setOpen(false); onCall(to); };
  const menu = (event, id) => { opener.current = event.currentTarget; setLeft(event.currentTarget.offsetLeft); setOpen(current => current === id ? false : id); };
  const keys = event => {
    if (!open) return;
    const items = [...(panel.current?.querySelectorAll('[role="menuitem"]') || [])], index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); opener.current?.focus(); }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key) && items.length) { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
    event.stopPropagation();
  };
  if (!people.length) return null;
  return <div className="cloud-presence" ref={container} aria-label={t('People on this board')} onKeyDown={keys} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    {shown.map(peer => <button type="button" key={peer.id} className="presence-person" aria-haspopup="menu" aria-expanded={open === peer.id} data-tooltip={open === peer.id ? undefined : peer.user.name} aria-label={peer.user.name} onClick={event => menu(event, peer.id)}><Avatar user={peer.user}/><VoiceMark voice={peer.voice}/></button>)}
    {hidden > 0 && <button type="button" className="presence-more" aria-haspopup="menu" aria-expanded={open === 'more'} aria-label={t('Everyone on this board')} data-tooltip={open ? undefined : t('Everyone on this board')} onClick={event => menu(event, 'more')}>+{hidden}</button>}
    {people.length > 0 && <button type="button" className="presence-call-all" aria-label={t('Call everyone here')} data-tooltip={t('Call everyone here')} onClick={() => call('all')}><Bell/></button>}
    {open && open !== 'more' && people.find(peer => peer.id === open) && (peer => <div ref={panel} className="presence-panel presence-person-menu" role="menu" aria-label={peer.user.name} style={{ left }}>
      <div className="presence-who"><Avatar user={peer.user}/><span><b>{peer.user.name}</b>{pageName(peer.page) && <small>{pageName(peer.page)}</small>}</span></div>
      <button type="button" role="menuitem" onClick={() => follow(peer)}><Arrow/><span>{t('Go to {name}', { name: peer.user.name })}</span></button>
      <button type="button" role="menuitem" onClick={() => call(peer.id)}><Bell/><span>{t('Call {name} here', { name: peer.user.name })}</span></button>
    </div>)(people.find(peer => peer.id === open))}
    {open === 'more' && <div ref={panel} className="presence-panel" role="menu" aria-label={t('Everyone on this board')}>
      <strong>{t('Everyone on this board')} · {people.length}</strong>
      <button type="button" role="menuitem" className="presence-call-row" onClick={() => call('all')}><Bell/><span>{t('Call everyone here')}</span></button>
      {people.map(peer => <div className="presence-row" key={peer.id}><button type="button" role="menuitem" onClick={() => follow(peer)}><span className="presence-voice-avatar"><Avatar user={peer.user}/><VoiceMark voice={peer.voice}/></span><span><b>{peer.user.name}</b>{pageName(peer.page) && <small>{pageName(peer.page)}</small>}</span></button>
        <button type="button" role="menuitem" className="presence-call" aria-label={t('Call {name} here', { name: peer.user.name })} data-tooltip={t('Call {name} here', { name: peer.user.name })} onClick={() => call(peer.id)}><Bell/></button></div>)}
    </div>}
  </div>;
}
