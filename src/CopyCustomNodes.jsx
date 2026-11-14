import React, { useEffect, useRef, useState } from 'react';
import { keepDialogFocus, restoreDialogFocus } from './dialog-focus.mjs';
import { plural, t } from './i18n.mjs';

export function CopyCustomNodes({ api, boardId, onClose, onCopied }) {
  const [boards, setBoards] = useState(null), [chosen, setChosen] = useState([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const returnFocus = useRef(document.activeElement), mounted = useRef(true);
  const path = `/api/boards/${boardId}/template-copy`;
  const load = () => { setError(''); api(path).then(result => { if (mounted.current) setBoards(result.boards); }).catch(cause => { if (mounted.current) setError(cause.message); }); };
  useEffect(() => { mounted.current = true; load(); return () => { mounted.current = false; restoreDialogFocus(returnFocus.current); }; }, []);
  const copy = async () => {
    setBusy(true); setError('');
    try { const result = await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selections: chosen }) }); if (mounted.current) { onCopied(result.templates); onClose(); } }
    catch (cause) { if (mounted.current) { setError(cause.message); setBusy(false); } }
  };
  return <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="copy-custom-title" onKeyDown={event => { keepDialogFocus(event); if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
    <form className="template-editor copy-custom-dialog" onSubmit={event => { event.preventDefault(); if (!busy && chosen.length && chosen.length <= 500) copy(); }}><h2 id="copy-custom-title">{t('Copy from another board…')}</h2><p className="template-hint">{t('Choose custom nodes to copy. Each copy can be edited independently on this board.')}</p>
      {boards === null && !error && <p role="status">{t('Loading custom nodes…')}</p>}
      {boards?.length === 0 && <p>{t('No custom nodes on your other boards.')}</p>}
      <div className="copy-custom-list">{boards?.map(board => <fieldset key={board.id} disabled={busy}><legend>{board.name}</legend>{board.templates.map(template => {
        const checked = chosen.some(item => item.boardId === board.id && item.id === template.id);
        return <label key={template.id} className="copy-custom-row"><input type="checkbox" checked={checked} onChange={() => setChosen(current => checked ? current.filter(item => item.boardId !== board.id || item.id !== template.id) : [...current, { boardId: board.id, id: template.id }])}/><span className="custom-node-glyph" style={{ '--template-color': template.color }}>T</span><span><strong>{template.name}</strong><small>{template.preview || t('No additional instructions')}</small><small>{t('{count} reference images', { count: template.imageCount })}</small></span></label>;
      })}</fieldset>)}</div>
      {error && <p className="template-error" role="alert">{t(error)} {boards === null && <button type="button" onClick={load}>{t('Retry')}</button>}</p>}
      <div className="template-editor-actions"><button type="button" autoFocus disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="primary-button" type="submit" disabled={busy || !chosen.length || chosen.length > 500}>{busy ? t('Working…') : plural(chosen.length, 'Copy {count} custom node', 'Copy {count} custom nodes')}</button></div>
    </form>
  </div>;
}
