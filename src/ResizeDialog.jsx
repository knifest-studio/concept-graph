import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { restoreSizeData } from './image-edits.mjs';
import { defaultResizeSide, estimatedBytes, halfSide, loadResizeImage, longerSide, saveResizedImage, resizePresets, resizeTarget, sizeText } from './image-resize.mjs';
import { megabytes } from '../cloud/reference-prep.mjs';
import { keepDialogFocus, restoreDialogFocus } from './dialog-focus.mjs';
import { t } from './i18n.mjs';
import './resize-dialog.css';

// Resize makes a smaller copy of an image node's file and keeps the one before it, so Restore original size brings it
// back. It never enlarges: sizes at or above the image's own are unavailable.
export function ResizeDialog({ node, assetUrl, upload, onApply, onClose, returnFocus }) {
  const dialog = useRef(null), busyRef = useRef(false);
  const [image, setImage] = useState(null), [bytes, setBytes] = useState(0), [choice, setChoice] = useState(null), [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useLayoutEffect(() => () => restoreDialogFocus(returnFocus), []);
  useLayoutEffect(() => { dialog.current?.querySelector('[aria-pressed="true"], button:not([disabled])')?.focus(); }, [image]);
  useEffect(() => {
    let active = true;
    loadResizeImage(node.data.asset, assetUrl).then(({ image, bytes }) => {
      if (!active) return;
      setImage(image); setBytes(bytes);
      const pixels = { width: image.naturalWidth, height: image.naturalHeight };
      const side = defaultResizeSide(pixels);
      setChoice(resizePresets.some(([, value]) => value === side) ? side : resizeTarget(pixels, side) ? 'half' : 'custom');
    }).catch(cause => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, []);
  const pixels = image && { width: image.naturalWidth, height: image.naturalHeight };
  const side = choice === 'half' ? pixels && halfSide(pixels) : choice === 'custom' ? Number(custom) : choice;
  const target = pixels && resizeTarget(pixels, side);
  const apply = async () => {
    if (busyRef.current || !target) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      await onApply(await saveResizedImage(node.data, image, target, upload)); onClose();
    } catch (cause) { setError(cause.message); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const restore = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await onApply(restoreSizeData(node.data)); onClose(); }
    catch (cause) { setError(cause.message); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const keyDown = event => {
    keepDialogFocus(event); event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); if (!busyRef.current) onClose(); }
  };
  const option = (value, label, hint) => {
    const available = !!pixels && (value === 'custom' || !!resizeTarget(pixels, value === 'half' ? halfSide(pixels) : value));
    return <button type="button" key={value} aria-label={hint} aria-pressed={choice === value} disabled={busy || !available} data-tooltip={available ? hint : t('The image is already this size or smaller.')} onClick={() => setChoice(value)}>{label}</button>;
  };
  return createPortal(<div className="board-modal" data-analytics-area="dialog:Resize image" role="dialog" aria-modal="true" aria-labelledby="resize-image-title" ref={dialog} onKeyDown={keyDown}>
    <form className="resize-dialog" onSubmit={event => { event.preventDefault(); apply(); }}>
      <h2 id="resize-image-title">{t('Resize image')}</h2>
      <p className="resize-intro">{t('Makes a smaller copy for faster boards and generation. The image before resizing is kept, so you can restore it.')}</p>
      <div className="resize-presets" role="group" aria-label={t('Longer side')}>
        {resizePresets.map(([label, value]) => option(value, label, t('{size} px on the longer side', { size: value })))}
        {option('half', t('Half'), t('Half the current size'))}
        {option('custom', t('Custom'), t('Choose the longer side in pixels'))}
      </div>
      {choice === 'custom' && <label className="resize-custom">{t('Longer side, px')}<input type="number" inputMode="numeric" min="1" max={pixels ? longerSide(pixels) - 1 : undefined} step="1" autoFocus value={custom} disabled={busy} onChange={event => setCustom(event.target.value)}/></label>}
      <dl className="resize-sizes" aria-live="polite">
        <div><dt>{t('Current size')}</dt><dd>{pixels ? sizeText(pixels, bytes) : t('Loading…')}</dd></div>
        <div><dt>{t('New size')}</dt><dd>{target ? <>{sizeText(target)}{bytes > 0 && <small>{t('about {size} MB', { size: megabytes(estimatedBytes(bytes, pixels, target)) })}</small>}</> : pixels ? t('Choose a size smaller than the image.') : '—'}</dd></div>
      </dl>
      {error && <p className="resize-error" role="alert">{t(error)}</p>}
      <div className="resize-actions">
        {node.data.unresized && <button type="button" className="resize-restore" disabled={busy} aria-label={t('Restore original size')} onClick={restore}>{t('Restore original size')}</button>}
        <button type="button" disabled={busy} aria-label={t('Cancel')} onClick={onClose}>{t('Cancel')}</button>
        <button type="submit" aria-label={t('Resize')} className="primary-button" disabled={busy || !target}>{busy ? t('Saving…') : t('Resize')}</button>
      </div>
    </form>
  </div>, document.body);
}
