import React, { useEffect, useRef, useState } from 'react';
import { authorInitials, contrastColor } from './annotations.mjs';
import { t } from './i18n.mjs';

// The signed-in person's own menu, at the right end of the header as on most sites: who they are, Team access for site
// admins, and Sign out, which is about the account rather than the board.
export function AccountMenu({ user, siteRole, onTeam, onSignOut }) {
  const [open, setOpen] = useState(false), container = useRef(null), trigger = useRef(null), panel = useRef(null);
  const color = user.color || '#6b6e89', initials = authorInitials({ name: user.name || '?' });
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector('[role="menuitem"]')?.focus();
    const outside = event => { if (!container.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const choose = action => { setOpen(false); action(); };
  // Arrow keys move between the items; Escape closes and returns to the button.
  const keys = event => {
    if (!open) return;
    const items = [...(panel.current?.querySelectorAll('[role="menuitem"]') || [])], index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key) && items.length) { event.preventDefault(); items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
    event.stopPropagation();
  };
  return <div className="account-menu" ref={container} onKeyDown={keys} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="account-button" aria-haspopup="menu" aria-expanded={open} aria-label={t('Account: {name}', { name: user.name })} data-tooltip={user.name}
      style={{ background: color, color: contrastColor(color) }} onClick={() => setOpen(value => !value)}>{initials}</button>
    {open && <div ref={panel} className="account-panel" role="menu" aria-label={t('Account')}>
      <div className="account-who"><span className="account-avatar" aria-hidden="true" style={{ background: color, color: contrastColor(color) }}>{initials}</span><span><b>{user.name}</b>{user.email && <small>{user.email}</small>}</span></div>
      {siteRole && <button type="button" role="menuitem" onClick={() => choose(onTeam)}>{t('Team access')}</button>}
      <button type="button" role="menuitem" onClick={() => choose(onSignOut)}>{t('Sign out')}</button>
    </div>}
  </div>;
}
