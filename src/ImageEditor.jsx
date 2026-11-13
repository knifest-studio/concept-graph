import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dragCrop, fullRect } from './image-edits.mjs';
import { loadEditImage, loadSelection, saveCrop, saveMask } from './image-edit-canvas.mjs';
import { keepDialogFocus, restoreDialogFocus } from './dialog-focus.mjs';
import { t } from './i18n.mjs';
import './image-editor.css';

const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const handleNames = { nw: 'Top left', n: 'Top', ne: 'Top right', e: 'Right', se: 'Bottom right', s: 'Bottom', sw: 'Bottom left', w: 'Left' };
const paint = (canvas, stroke, from = 0) => {
  const ctx = canvas.getContext('2d'); ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
  ctx.strokeStyle = ctx.fillStyle = '#e628b4'; ctx.lineWidth = stroke.size; ctx.lineCap = ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(...stroke.points[from]);
  if (stroke.points.length === 1) { ctx.arc(...stroke.points[0], stroke.size / 2, 0, Math.PI * 2); ctx.fill(); }
  else { for (const point of stroke.points.slice(from + 1)) ctx.lineTo(...point); ctx.stroke(); }
  ctx.globalCompositeOperation = 'source-over';
};

export function ImageEditor({ node, mode, assetUrl, upload, onApply, onClose, returnFocus }) {
  const crop = mode === 'crop', dialog = useRef(null), area = useRef(null), brushCanvas = useRef(null), gesture = useRef(null), initial = useRef(null);
  const history = useRef([]), historyAt = useRef(0), current = useRef({});
  const [image, setImage] = useState(null), [rect, setRect] = useState(null), [room, setRoom] = useState({ width: 1, height: 1 });
  const [brush, setBrush] = useState(40), [eraser, setEraser] = useState(false), [undo, setUndo] = useState(0), [redo, setRedo] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  current.current = { busy, image, rect };
  useLayoutEffect(() => { dialog.current?.focus(); return () => restoreDialogFocus(returnFocus); }, []);
  useEffect(() => {
    let active = true;
    (async () => {
      const loaded = await loadEditImage(assetUrl(crop ? node.data.uncropped?.asset || node.data.asset : node.data.asset));
      const pixels = { width: loaded.naturalWidth, height: loaded.naturalHeight };
      let selection;
      if (!crop) {
        selection = node.data.mask?.source === node.data.asset ? await loadSelection(node.data.mask, pixels, assetUrl) : null;
      }
      if (!active) return;
      initial.current = selection; setImage(loaded); setRect(crop ? node.data.uncropped?.rect || fullRect(pixels) : fullRect(pixels));
    })().catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  useLayoutEffect(() => {
    const element = area.current, observer = new ResizeObserver(([entry]) => setRoom({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (crop || !image || !brushCanvas.current) return;
    const canvas = brushCanvas.current; canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; if (initial.current) canvas.getContext('2d').drawImage(initial.current, 0, 0);
  }, [image]);
  const refreshHistory = () => { setUndo(historyAt.current); setRedo(history.current.length - historyAt.current); };
  const replay = at => {
    if (busy || gesture.current) return;
    const canvas = brushCanvas.current, ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); if (initial.current) ctx.drawImage(initial.current, 0, 0);
    for (const stroke of history.current.slice(0, at)) { if (stroke.clear) ctx.clearRect(0, 0, canvas.width, canvas.height); else paint(canvas, stroke); }
    historyAt.current = at; refreshHistory();
  };
  const push = stroke => { history.current = [...history.current.slice(0, historyAt.current), stroke]; historyAt.current++; refreshHistory(); };
  const apply = async (reset = false) => {
    if (current.current.busy || !current.current.image || gesture.current) return;
    current.current.busy = true; setBusy(true); setError('');
    try {
      const data = crop ? await saveCrop(node.data, image, reset ? fullRect({ width: image.naturalWidth, height: image.naturalHeight }) : rect, { assetUrl, upload, reset })
        : { ...node.data, mask: await saveMask(image, brushCanvas.current, node.data.asset, upload) };
      if (!data.mask) delete data.mask;
      await onApply(data, !crop && !!data.mask); onClose();
    } catch (error) { setError(error.message); }
    finally { current.current.busy = false; setBusy(false); }
  };
  const keyDown = event => {
    keepDialogFocus(event); event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); }
    else if (!crop && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); replay(event.shiftKey ? Math.min(history.current.length, historyAt.current + 1) : Math.max(0, historyAt.current - 1)); }
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing && (event.target.matches('.crop-handle') || !event.target.closest('button,input'))) { event.preventDefault(); apply(); }
  };
  const scale = image ? Math.min(Math.max(1, room.width - 24) / image.naturalWidth, Math.max(1, room.height - 24) / image.naturalHeight) : 1;
  const point = event => {
    const box = event.currentTarget.getBoundingClientRect();
    return [Math.max(0, Math.min(image.naturalWidth, (event.clientX - box.left) / scale)), Math.max(0, Math.min(image.naturalHeight, (event.clientY - box.top) / scale))];
  };
  const down = event => {
    if (!image || busy || event.button !== 0 || gesture.current) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const start = point(event);
    if (crop) gesture.current = { pointer: event.pointerId, handle: event.target.dataset.handle || 'move', rect, start };
    else { const stroke = { erase: eraser, size: brush / scale, points: [start] }; gesture.current = { pointer: event.pointerId, stroke }; paint(brushCanvas.current, stroke); }
  };
  const move = event => {
    const drag = gesture.current;
    if (!drag || drag.pointer !== event.pointerId) return;
    const next = point(event);
    if (crop) setRect(dragCrop(drag.rect, drag.handle, next[0] - drag.start[0], next[1] - drag.start[1], { width: image.naturalWidth, height: image.naturalHeight }, event.shiftKey));
    else { const from = drag.stroke.points.length - 1; drag.stroke.points.push(next); paint(brushCanvas.current, drag.stroke, from); }
  };
  const up = event => {
    const drag = gesture.current; if (!drag || drag.pointer !== event.pointerId) return;
    if (!crop) push(drag.stroke);
    gesture.current = null;
  };
  return createPortal(<div className="image-editor" role="dialog" aria-modal="true" aria-labelledby="image-editor-title" tabIndex={-1} ref={dialog} onKeyDown={keyDown}>
    <header className="image-editor-toolbar"><h2 id="image-editor-title">{crop ? t('Crop') : t('Edit mask')}</h2>
      {!crop && <div className="image-editor-tools" role="group" aria-label={t('Mask tools')}>
        <button type="button" aria-pressed={!eraser} disabled={busy} onClick={() => setEraser(false)}>{t('Brush')}</button><button type="button" aria-pressed={eraser} disabled={busy} onClick={() => setEraser(true)}>{t('Eraser')}</button>
        <label>{t('Brush size')}<input type="range" min="4" max="160" value={brush} disabled={busy} onChange={event => setBrush(Number(event.target.value))}/></label>
        <button type="button" disabled={busy || !image} onClick={() => { if (gesture.current) return; push({ clear: true }); replay(historyAt.current); }}>{t('Clear mask')}</button>
        <button type="button" disabled={busy || !undo} onClick={() => replay(historyAt.current - 1)}>{t('Undo')}</button><button type="button" disabled={busy || !redo} onClick={() => replay(historyAt.current + 1)}>{t('Redo')}</button>
      </div>}
      <div className="image-editor-actions">{crop && node.data.uncropped && <button type="button" disabled={busy || !image} onClick={() => apply(true)}>{t('Reset crop')}</button>}<button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button type="button" className="primary-button" disabled={busy || !image} onClick={() => apply()}>{busy ? t('Saving…') : t('Apply')}</button></div>
    </header>
    <div className="image-editor-area" ref={area}>{image && rect ? <div className={`image-editor-stage ${crop ? 'crop-stage' : 'mask-stage'}`} style={{ width: image.naturalWidth * scale, height: image.naturalHeight * scale }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up}>
      <img src={image.src} alt={node.data.caption || node.data.label || t('Image')} draggable="false"/>
      {crop ? <div className="crop-rectangle" data-handle="move" tabIndex={0} role="group" aria-label={t('Crop rectangle')} style={{ left: rect.x * scale, top: rect.y * scale, width: rect.width * scale, height: rect.height * scale }} onKeyDown={event => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta || busy) return; event.preventDefault(); const step = event.shiftKey ? 10 : 1; setRect(dragCrop(rect, 'move', delta[0] * step, delta[1] * step, { width: image.naturalWidth, height: image.naturalHeight }));
      }}>{handles.map(handle => <button key={handle} type="button" data-handle={handle} className={`crop-handle crop-${handle}`} aria-label={t('Resize crop: {edge}', { edge: t(handleNames[handle]) })} disabled={busy} onKeyDown={event => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta) return; event.preventDefault(); event.stopPropagation(); setRect(dragCrop(rect, handle, ...delta, { width: image.naturalWidth, height: image.naturalHeight }, event.shiftKey));
      }}/>)}</div> : <canvas ref={brushCanvas} className="mask-paint"/>}
    </div> : <p role="status">{error ? '' : t('Loading…')}</p>}</div>
    <footer className="image-editor-footer"><span>{crop ? t('Drag the edges to crop · Shift keeps ratio · Enter applies · Esc cancels') : t('Paint the area to regenerate · Everything else stays · Enter applies · Esc cancels')}</span>{crop && rect && <span>{rect.width} × {rect.height}</span>}{error && <p role="alert">{error}</p>}</footer>
  </div>, document.body);
}
