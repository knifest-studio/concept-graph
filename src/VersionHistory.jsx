import React, { useEffect, useRef, useState } from 'react';
import { keepDialogFocus } from './dialog-focus.mjs';
import { plural, t } from './i18n.mjs';

const names = list => list.join(', ');
function describe(version) {
  if (version.reason === 'before-delete') return version.by?.length ? plural(version.removed || 0, 'Before {names} deleted {count} item', 'Before {names} deleted {count} items', { names: names(version.by) }) : plural(version.removed || 0, 'Before {count} item was deleted', 'Before {count} items were deleted');
  if (version.reason === 'before-restore') return version.by?.length ? t('Before {names} restored an earlier version', { names: names(version.by) }) : t('Before an earlier version was restored');
  if (version.reason === 'daily') return t('Daily backup');
  return t('Autosave');
}

// The board's saved versions. Restoring puts the whole board back for everyone; the board as it is now is saved first,
// so a restore can be undone the same way.
export function VersionHistory({ boardId, services, editable, ago, onRestored, onClose }) {
  const [versions, setVersions] = useState(null), [error, setError] = useState(''), [confirm, setConfirm] = useState(null), [busy, setBusy] = useState(false);
  const path = `/api/cloud/boards/${encodeURIComponent(boardId)}/versions`, closeButton = useRef(null);
  useEffect(() => {
    closeButton.current?.focus();
    let active = true;
    services.api(path).then(result => { if (active) setVersions(result.versions); }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, []);
  const restore = async version => {
    setBusy(true); setError('');
    try { await services.api(`${path}/${encodeURIComponent(version.id)}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); onRestored(version); }
    catch (failure) { setError(failure.message); setBusy(false); }
  };
  return <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="history-title" onKeyDown={event => { keepDialogFocus(event); event.stopPropagation(); if (event.key === 'Escape') onClose(); }}>
    <div className="share-card version-card">
      <h2 id="history-title">{t('Version history')}</h2>
      <p className="share-note">{t('A copy of the board is saved every 10 minutes while it changes, and right before any large deletion or restore. Copies are kept for 90 days.')}</p>
      {error && <p className="cloud-error share-error" role="alert">{error}</p>}
      {versions === null && !error ? <p className="share-muted version-status" role="status">{t('Loading versions…')}</p>
        : versions?.length === 0 ? <p className="share-muted version-status">{t('No versions yet. The first is saved soon after the next change.')}</p>
        : versions && <ul className="share-people version-list">{versions.map(version => <li key={version.id} className={version.reason === 'before-delete' ? 'version-deletion' : undefined}>
          {version.covers.length > 0 && <span className="version-covers" aria-hidden="true">{version.covers.slice(0, 2).map(asset => <img key={asset} src={`/assets/${encodeURIComponent(asset)}/thumb`} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true; }}/>)}</span>}
          <span className="version-text"><b><time dateTime={version.at} title={new Date(version.at).toLocaleString()}>{new Date(version.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</time> · {ago(version.at)}</b>
            <small>{describe(version)} · {plural(version.nodes, '{count} item', '{count} items')} · {plural(version.images, '{count} image', '{count} images')}</small>
            {version.editors.length > 0 && <small>{t('Edited by {names}', { names: names(version.editors) })}</small>}</span>
          {editable && (confirm === version.id ? <span className="version-confirm"><button type="button" className="primary-button" disabled={busy} autoFocus onClick={() => restore(version)}>{busy ? t('Restoring…') : t('Restore for everyone')}</button><button type="button" className="share-remove" disabled={busy} onClick={() => setConfirm(null)}>{t('Cancel')}</button></span>
            : <button type="button" className="share-copy" disabled={busy} aria-label={t('Restore the version from {time}', { time: new Date(version.at).toLocaleString() })} onClick={() => setConfirm(version.id)}>{t('Restore')}</button>)}
        </li>)}</ul>}
      {editable && confirm && <p className="share-note version-warning">{t('The whole board goes back to this version for everyone. The board as it is now is saved first, so you can undo this from here.')}</p>}
      <div className="share-actions"><span/><button ref={closeButton} className="primary-button" type="button" onClick={onClose}>{t('Done')}</button></div>
    </div>
  </div>;
}
