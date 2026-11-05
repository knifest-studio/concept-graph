import React, { useEffect, useRef, useState } from 'react';
import { authorInitials, contrastColor } from './annotations.mjs';
import { t } from './i18n.mjs';

const fallback = '#6b6e89';
const Avatar = ({ user, className = 'presence-avatar' }) => {
  const color = user.color || fallback;
  return <span className={className} aria-hidden="true" style={{ background: color, color: contrastColor(color) }}>{authorInitials({ name: user.name || '?' })}</span>;
};

// Who else is on the board, as in FigJam: overlapping avatars, the rest behind +N, which lists everyone with the page
// they are on. Choosing a person moves the canvas to them. A person with two tabs open is shown once.
export function BoardPresence({ peers, pages, onFollow }) {
  const [open, setOpen] = useState(false), [narrow, setNarrow] = useState(() => matchMedia('(max-width: 900px)').matches);
  const container = useRef(null), trigger = useRef(null), panel = useRef(null);
  useEffect(() => {
    const query = matchMedia('(max-width: 900px)'), change = () => setNarrow(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const seen = new Set(), people = peers.filter(peer => { const key = `${peer.user.name}\u0000${peer.user.color}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const limit = narrow ? 3 : 5, shown = people.length > limit ? people.slice(0, limit - 1) : people, hidden = people.length - shown.length;
  useEffect(() => { if (!hidden) setOpen(false); }, [hidden]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector('[role="menuitem"]')?.focus();
    const outside = event => { if (!container.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const pageName = id => pages.length > 1 ? pages.find(page => page.id === (id ?? pages[0].id))?.name || pages[0].name : '';
  const follow = peer => { setOpen(false); onFollow(peer.id); };
  const keys = event => {
    if (!open) return;
    const items = [...(panel.current?.querySelectorAll('[role="menuitem"]') || [])], index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key) && items.length) { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
    event.stopPropagation();
  };
  if (!people.length) return null;
  return <div className="cloud-presence" ref={container} aria-label={t('People on this board')} onKeyDown={keys} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    {shown.map(peer => <button type="button" key={peer.id} className="presence-person" data-tooltip={t('Go to {name}', { name: peer.user.name })} aria-label={t('Go to {name}', { name: peer.user.name })} onClick={() => follow(peer)}><Avatar user={peer.user}/></button>)}
    {hidden > 0 && <button ref={trigger} type="button" className="presence-more" aria-haspopup="menu" aria-expanded={open} aria-label={t('Everyone on this board')} data-tooltip={open ? undefined : t('Everyone on this board')} onClick={() => setOpen(value => !value)}>+{hidden}</button>}
    {open && <div ref={panel} className="presence-panel" role="menu" aria-label={t('Everyone on this board')}>
      <strong>{t('Everyone on this board')} · {people.length}</strong>
      {people.map(peer => <button type="button" role="menuitem" key={peer.id} onClick={() => follow(peer)}><Avatar user={peer.user}/><span><b>{peer.user.name}</b>{pageName(peer.page) && <small>{pageName(peer.page)}</small>}</span></button>)}
    </div>}
  </div>;
}
