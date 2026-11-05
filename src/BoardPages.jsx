import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { authorInitials, boardAuthor, contrastColor, validColor } from './annotations.mjs';
import { maxPages, peersOnPage } from './pages.mjs';
import { plural, t } from './i18n.mjs';
import './node-context-menu.css';
import './pages.css';

function PageMenu({ menu, canDelete, onRename, onDelete, onClose }) {
  const element = useRef(null);
  useLayoutEffect(() => {
    const node = element.current;
    node.style.left = `${Math.max(8, Math.min(menu.x, innerWidth - node.offsetWidth - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(menu.y, innerHeight - node.offsetHeight - 8))}px`;
    node.querySelector('button:not(:disabled)')?.focus();
  }, [menu]);
  useEffect(() => {
    const outside = event => { if (!element.current?.contains(event.target)) onClose(false); };
    const close = () => onClose(false);
    document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', close); window.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', close); window.removeEventListener('scroll', close, true); };
  }, []);
  const key = event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(true); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...element.current.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
    buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };
  return createPortal(<div ref={element} className="node-context-menu" role="menu" aria-label={t('{name} options', { name: menu.page.name })} onContextMenu={event => event.preventDefault()} onKeyDown={key}>
    <button type="button" role="menuitem" onClick={onRename}>{t('Rename')}</button>
    <button type="button" role="menuitem" disabled={!canDelete} title={canDelete ? undefined : t('A board needs at least one page')} onClick={onDelete}>{t('Delete page')}</button>
  </div>, document.body);
}

function PagePeople({ peers }) {
  if (!peers.length) return null;
  const shown = peers.slice(0, 3);
  return <span className="board-page-people" aria-label={plural(peers.length, '{count} person here: {names}', '{count} people here: {names}', { names: peers.map(peer => peer.user.name).join(', ') })}>
    {shown.map(peer => { const author = boardAuthor(peer.user) || { name: '?' }, color = validColor(peer.user.color) ? peer.user.color : '#787891';
      return <span key={peer.id} className="board-page-person" title={author.name} style={{ background: color, color: contrastColor(color) }}>{authorInitials(author)}</span>; })}
    {peers.length > shown.length && <span className="board-page-person more">+{peers.length - shown.length}</span>}
  </span>;
}

// Figma-like page list: click to open, double-click to rename, right-click for page actions. A viewer can only switch pages.
export function BoardPages({ pages, active, peers = [], disabled, readOnly = false, onSelect, onAdd, onRename, onDelete }) {
  const [editing, setEditing] = useState(null), [draft, setDraft] = useState(''), [menu, setMenu] = useState(null);
  const cancelled = useRef(false), list = useRef(null);
  const startEdit = page => { if (disabled || readOnly) return; cancelled.current = false; setDraft(page.name); setEditing(page.id); };
  const finishEdit = () => {
    const id = editing;
    setEditing(null);
    if (!cancelled.current && draft.trim()) onRename(id, draft);
    requestAnimationFrame(() => list.current?.querySelector(`[data-page-id="${CSS.escape(id)}"]`)?.focus());
  };
  const add = () => { const page = onAdd(); if (page) startEdit(page); };
  const closeMenu = restore => { const id = menu?.page.id; setMenu(null); if (restore && id) list.current?.querySelector(`[data-page-id="${CSS.escape(id)}"]`)?.focus(); };
  return <section className="board-pages" aria-label={t('Pages')}>
    <div className="board-pages-heading"><span className="eyebrow">{t('PAGES')}</span>{!readOnly && <button type="button" className="icon-button" aria-label={t('Add page')} data-tooltip={t('Add page')} disabled={disabled || pages.length >= maxPages} onClick={add}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>}</div>
    <ul ref={list} className="board-pages-list">{pages.map(page => <li key={page.id}>
      {editing === page.id ? <input className="board-page-input" autoFocus aria-label={t('Page name')} maxLength={80} value={draft} onFocus={event => event.target.select()} onChange={event => setDraft(event.target.value)} onBlur={finishEdit}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelled.current = true; event.currentTarget.blur(); } }}/>
        : <button type="button" data-page-id={page.id} className={`board-page${page.id === active ? ' active' : ''}`} aria-current={page.id === active ? 'page' : undefined} disabled={disabled} title={page.name}
          onClick={() => onSelect(page.id)} onDoubleClick={() => startEdit(page)} onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); startEdit(page); } }}
          onContextMenu={event => { event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); if (!disabled && !readOnly) setMenu({ page, x: event.clientX || box.left + 12, y: event.clientY || box.bottom }); }}>
          <svg className="board-page-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/></svg>
          <span className="board-page-name">{page.name}</span><PagePeople peers={peersOnPage(peers, pages, page.id)}/>
        </button>}
    </li>)}</ul>
    {menu && <PageMenu menu={menu} canDelete={pages.length > 1} onClose={closeMenu} onRename={() => { const page = menu.page; setMenu(null); startEdit(page); }} onDelete={() => { const page = menu.page; setMenu(null); onDelete(page.id); }}/>}
  </section>;
}
