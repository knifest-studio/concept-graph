import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { keepDialogFocus, restoreDialogFocus } from './dialog-focus.mjs';
import { keyboardShortcuts, isHelpShortcut, isMacPlatform, shortcutLabel } from './shortcuts.mjs';
import { hasUnseenWhatsNew, markWhatsNewSeen, readWhatsNewSeen, whatsNewEntries, whatsNewSeenKey } from './whats-new.mjs';
import { t } from './i18n.mjs';

function HelpDialog({ item, onClose, returnFocus }) {
  const title = item === 'shortcuts' ? 'Keyboard shortcuts' : "What's new", heading = useRef(null), id = useId();
  const mac = isMacPlatform(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
  useEffect(() => { const previous = returnFocus.current; heading.current?.focus(); return () => restoreDialogFocus(previous); }, []);
  return createPortal(<div className="board-modal" role="dialog" aria-modal="true" aria-labelledby={id} onKeyDown={event => { keepDialogFocus(event); event.stopPropagation(); if (event.key === 'Escape') onClose(); }} onCopy={event => event.stopPropagation()} onPaste={event => event.stopPropagation()}>
    <div className="help-card"><header><h2 id={id} ref={heading} tabIndex={-1}>{t(title)}</h2><button type="button" aria-label={t('Close')} onClick={onClose}>×</button></header>
      {item === 'shortcuts' ? <><p>{t('Canvas shortcuts work outside text fields. Editing requires edit access.')}</p>{[...new Set(keyboardShortcuts.map(row => row.group))].map(group => <section key={group}><h3>{t(group)}</h3><dl>{keyboardShortcuts.filter(row => row.group === group).map(row => <div key={row.keys}><dt>{t(row.label)}</dt><dd><kbd>{shortcutLabel(row.keys, mac)}</kbd></dd></div>)}</dl></section>)}</> : <ul className="whats-new-list">{whatsNewEntries.map(entry => <li key={entry.id}><h3>{t(entry.title)}</h3><p>{t(entry.benefit)}</p></li>)}</ul>}
      <div className="preferences-actions"><button type="button" className="primary-button" onClick={onClose}>{t('Done')}</button></div>
    </div>
  </div>, document.body);
}

export function HelpMenu({ item, onOpen, onClose, returnFocus, readOnly, steps }) {
  const root = useRef(null), trigger = useRef(null), panel = useRef(null), id = useId();
  const [seen, setSeen] = useState(() => readWhatsNewSeen(localStorage));
  const open = item === 'menu', unseen = hasUnseenWhatsNew(seen), done = steps.filter(step => step.done).length;
  useEffect(() => {
    const receive = event => { if (event.key === whatsNewSeenKey || event.key === null) setSeen(readWhatsNewSeen(localStorage)); };
    window.addEventListener('storage', receive); return () => window.removeEventListener('storage', receive);
  }, []);
  useEffect(() => { if (item === 'whats_new') setSeen(markWhatsNewSeen(localStorage)); }, [item]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector('button:not(:disabled)')?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) onClose(); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const close = () => { onClose(); restoreDialogFocus(trigger.current); };
  const choose = value => { restoreDialogFocus(trigger.current); onOpen(value); };
  return <><div className="help-menu" ref={root} onBlur={event => { if (open && !event.currentTarget.contains(event.relatedTarget)) onClose(); }} onKeyDown={event => {
    event.stopPropagation();
    if (isHelpShortcut(event)) { event.preventDefault(); restoreDialogFocus(trigger.current); onOpen('shortcuts', 'key'); return; }
    if (event.key === 'Escape' && open) { event.preventDefault(); close(); }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!open) { onOpen('menu'); return; }
    const items = [...panel.current.querySelectorAll('button:not(:disabled)')], current = items.indexOf(document.activeElement);
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  }}>
    <button ref={trigger} className="getting-started-help" type="button" aria-label={unseen ? t('Help · new updates') : t('Help')} data-tooltip={t('Help')} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => open ? close() : onOpen('menu')}>?{unseen && <span className="help-unread-dot" aria-hidden="true"/>}</button>
    {open && <div ref={panel} id={id} className="board-menu-panel help-menu-panel" role="menu" aria-label={t('Help')}>
      <button type="button" role="menuitem" disabled={readOnly} onClick={() => choose('getting_started')} data-tooltip={readOnly ? t('Getting started requires edit access') : undefined}>{t('Getting started')}{!readOnly && done < steps.length && <small>{t('{done} of {total}', { done, total: steps.length })}</small>}</button>
      <button type="button" role="menuitem" onClick={() => choose('shortcuts')}>{t('Keyboard shortcuts')}<kbd>?</kbd></button>
      <button type="button" role="menuitem" onClick={() => choose('whats_new')}>{t("What's new")}{unseen && <span className="help-unread-dot" aria-hidden="true"/>}</button>
    </div>}
  </div>{item && item !== 'menu' && <HelpDialog item={item} onClose={onClose} returnFocus={returnFocus}/>}</>;
}
