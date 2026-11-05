import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from './i18n.mjs';

const maxScale = 16, step = 1.25;
const clampScale = (scale, fit) => Math.min(Math.max(maxScale, fit), Math.max(fit, scale));

// The original image in the fullscreen viewer, to look at closely: the wheel or a pinch zooms where the pointer is, dragging
// moves it, a double-click switches between the whole image and its real pixels, and + − 0 1 and the arrows do the same
// from the keyboard. Past 300% pixels are drawn square, so detail is not blurred. Scale 1 means one image pixel per screen pixel.
export function ZoomableImage({ src, alt, crossOrigin, onLoad }) {
  const stage = useRef(null), pointers = useRef(new Map()), pinch = useRef(null);
  const [natural, setNatural] = useState(null), [view, setShown] = useState(null), [moving, setMoving] = useState(false);
  // The view is kept here as well, so wheel steps and keys that arrive before the next render build on each other.
  const latest = useRef({ natural: null, view: null });
  const setView = useCallback(next => { latest.current.view = next; setShown(next); }, []);
  const fitScale = useCallback(size => {
    const box = stage.current?.getBoundingClientRect();
    return box && size ? Math.min(box.width / size.width, box.height / size.height) : 1;
  }, []);
  // Smaller than the stage, the image stays centred; larger, it never leaves a gap at an edge.
  const place = useCallback((next, size = latest.current.natural) => {
    const box = stage.current.getBoundingClientRect(), width = size.width * next.scale, height = size.height * next.scale;
    const x = width <= box.width ? (box.width - width) / 2 : Math.min(0, Math.max(box.width - width, next.x));
    const y = height <= box.height ? (box.height - height) / 2 : Math.min(0, Math.max(box.height - height, next.y));
    return { scale: next.scale, x, y, fit: !!next.fit };
  }, []);
  const fit = useCallback((size = latest.current.natural) => size && setView(place({ scale: fitScale(size), x: 0, y: 0, fit: true }, size)), [fitScale, place, setView]);
  // Zooms by `factor` (or to `scale`) keeping the image point under (px, py) in place; without a point, around the middle.
  const zoom = useCallback((factor, px, py, scale) => {
    const { natural: size, view: current } = latest.current;
    if (!size || !current) return;
    const box = stage.current.getBoundingClientRect(), x = px ?? box.width / 2, y = py ?? box.height / 2;
    const next = clampScale(scale ?? current.scale * factor, fitScale(size)), ratio = next / current.scale;
    setView(place({ scale: next, x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio, fit: Math.abs(next - fitScale(size)) < 1e-6 }));
  }, [fitScale, place, setView]);
  const pan = useCallback((dx, dy) => { const current = latest.current.view; if (current) setView(place({ ...current, x: current.x + dx, y: current.y + dy, fit: false })); }, [place, setView]);

  useLayoutEffect(() => {
    if (!stage.current) return;
    // A resized window keeps a fitted image fitted and a zoomed one in bounds.
    const observer = new ResizeObserver(() => { const { natural: size, view: current } = latest.current; if (size && current) setView(current.fit ? place({ scale: fitScale(size), x: 0, y: 0, fit: true }, size) : place(current, size)); });
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [fitScale, place]);
  useEffect(() => {
    const element = stage.current;
    // Wheel events must be cancellable, which React's listener is not.
    const wheel = event => {
      event.preventDefault();
      const box = element.getBoundingClientRect(), delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoom(Math.exp(-delta * (event.ctrlKey ? .01 : .002)), event.clientX - box.left, event.clientY - box.top);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [zoom]);
  useEffect(() => {
    const key = event => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.target.closest?.('textarea,input,select,[contenteditable="true"]')) return;
      const moves = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] };
      if (['+', '='].includes(event.key)) zoom(step);
      else if (['-', '_'].includes(event.key)) zoom(1 / step);
      else if (event.key === '0') fit();
      else if (event.key === '1') zoom(1, undefined, undefined, 1);
      else if (moves[event.key]) pan(...moves[event.key]);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [zoom, fit, pan]);

  const point = event => { const box = stage.current.getBoundingClientRect(); return { x: event.clientX - box.left, y: event.clientY - box.top }; };
  const down = event => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, point(event));
    if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y) }; }
    setMoving(true);
  };
  const move = event => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const now = point(event);
    pointers.current.set(event.pointerId, now);
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()], distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current.distance) zoom(distance / pinch.current.distance, (a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch.current.distance = distance;
    } else if (pointers.current.size === 1) pan(now.x - previous.x, now.y - previous.y);
  };
  const up = event => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (!pointers.current.size) setMoving(false);
  };
  const toggle = event => {
    const { natural: size, view: current } = latest.current, { x, y } = point(event);
    if (!size || !current) return;
    if (current.fit) zoom(1, x, y, Math.max(1, fitScale(size) * 2)); else fit();
  };

  const scale = view?.scale ?? 1, larger = natural && view && (natural.width * scale > stage.current?.clientWidth + 1 || natural.height * scale > stage.current?.clientHeight + 1);
  return <div className="lightbox-image zoom-stage" ref={stage} data-moving={moving || undefined} data-pannable={larger || undefined} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={toggle}>
    <img src={src} alt={alt} crossOrigin={crossOrigin} referrerPolicy="no-referrer" draggable="false"
      className={scale >= 3 ? 'pixelated' : undefined}
      style={natural && view ? { width: natural.width, height: natural.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` } : { visibility: 'hidden' }}
      onLoad={event => { const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }; latest.current.natural = size; setNatural(size); fit(size); onLoad?.(size); }}/>
    {natural && view && <div className="zoom-tools" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <button type="button" aria-label={t('Zoom out')} data-tooltip={t('Zoom out · −')} disabled={view.fit} onClick={() => zoom(1 / step)}>−</button>
      <button type="button" className="zoom-level" aria-label={t('Fit the whole image')} data-tooltip={t('Fit the whole image · 0')} onClick={() => fit()}>{Math.round(scale * 100)}%</button>
      <button type="button" aria-label={t('Zoom in')} data-tooltip={t('Zoom in · +')} disabled={scale >= maxScale} onClick={() => zoom(step)}>+</button>
      <i/>
      <button type="button" className="zoom-text" aria-pressed={view.fit} data-tooltip={t('Fit the whole image · 0')} onClick={() => fit()}>{t('Fit')}</button>
      <button type="button" className="zoom-text" aria-pressed={Math.abs(scale - 1) < 1e-6} data-tooltip={t('Real pixels, one to one · 1')} onClick={() => zoom(1, undefined, undefined, 1)}>1:1</button>
    </div>}
    {natural && view?.fit && <span className="zoom-hint" aria-hidden="true">{t('Scroll or pinch to zoom · drag to move · double-click for detail')}</span>}
  </div>;
}
