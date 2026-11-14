import React, { useEffect, useId, useRef, useState } from 'react';
import { t } from './i18n.mjs';

export function BoardMenu({ board, boards, disabled, canManage, onSelect, onHome, onCreate, onRename, onDelete, onHistory, onExport, onImport, buttonRef }) {
  const [open, setOpen] = useState(false), root = useRef(null), trigger = useRef(null), panel = useRef(null), id = useId();
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector('button')?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const item = (label, action, className) => <button role="menuitem" type="button" className={className} onClick={() => { close(); action(); }}>{label}</button>;
  const recent = boards.filter(item => item.id !== board?.id).sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt)).slice(0, 8);
  return <div className="board-menu" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' && open) { event.preventDefault(); close(); }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (!open) { setOpen(true); return; }
    const items = [...panel.current.querySelectorAll('[role="menuitem"]')], current = items.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index]?.focus();
  }}>
    <button ref={element => { trigger.current = element; if (buttonRef) buttonRef.current = element; }} type="button" className="board-menu-trigger" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={t('Board menu: {name}', { name: board?.name || '' })} data-tooltip={t('Board menu')} onClick={() => setOpen(value => !value)}>
      <span data-analytics-private>{board?.name || t('Board')}</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    {open && <div ref={panel} id={id} className="board-menu-panel" role="menu" aria-label={t('Board menu')}>
      {recent.map(other => <button key={other.id} role="menuitem" type="button" data-tooltip={t('Switch board')} onClick={() => { close(); onSelect(other.id); }}><span data-analytics-private>{other.name}</span></button>)}
      {recent.length > 0 && <hr/>}
      {onHome && item(t('All boards'), onHome)}
      {item(t('New board…'), onCreate)}
      {canManage && item(t('Rename…'), onRename)}
      {onHistory && item(t('Version history'), onHistory)}
      {onExport && item(t('Export…'), onExport)}
      {onImport && item(t('Import…'), onImport)}
      {canManage && <><hr/>{item(t('Delete board'), onDelete, 'board-delete')}</>}
    </div>}
  </div>;
}
