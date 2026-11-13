import React, { createContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCanvas, useCanvasValue, useDetail } from './canvas-context.jsx';
import { matchingPlaceholder, prunePlaceholders, shownPlaceholders } from './pending-reveals.mjs';
import { WaitingVideo } from './PendingNode.jsx';

export const ImageRevealContext = createContext(null);

export function ImageReveal({ id, data, positionAbsoluteX, positionAbsoluteY, children }) {
  const canvas = useCanvas(), full = useDetail(id) === 'full';
  const reduced = useCanvasValue(state => state.reducedMotion), videos = useCanvasValue(state => state.waitingVideos);
  const [slot, setSlot] = useState(() => {
    if (reduced || document.hidden || data.collapsed) return null;
    const match = matchingPlaceholder(shownPlaceholders, data.runId, { x: positionAbsoluteX, y: positionAbsoluteY }, performance.now());
    if (!match) return null;
    const video = match.media?.querySelector('video');
    return { id: match.id, width: match.width, height: match.height, seed: match.seed, clip: video?.getAttribute('src') || match.clip, time: video?.currentTime || match.time || 0 };
  });
  const hadSlot = useRef(Boolean(slot));
  const [aspect, setAspect] = useState(null);
  useLayoutEffect(() => {
    if (slot) shownPlaceholders.delete(slot.id);
    prunePlaceholders(shownPlaceholders, performance.now());
  }, []);
  const finish = useCallback(() => { setSlot(null); canvas.outputReady(id); }, [canvas, id]);
  const ready = useCallback(image => setAspect(image.naturalHeight / image.naturalWidth), []);
  const failed = useCallback(() => { setSlot(null); canvas.outputFailed(id); }, [canvas, id]);
  useEffect(() => {
    if (!slot) return;
    if (reduced || data.collapsed) { finish(); return; }
    if (!aspect) return;
    const timer = setTimeout(finish, full ? 800 : 220);
    return () => clearTimeout(timer);
  }, [slot, aspect, reduced, data.collapsed, full, finish]);
  const reveal = useMemo(() => slot ? { ready, failed } : null, [slot, ready, failed]);
  if (!hadSlot.current) return children;
  if (!slot || reduced || data.collapsed) return <ImageRevealContext.Provider value={null}><div className="output-revealed">{children}</div></ImageRevealContext.Provider>;
  // Keep the waiting surface until decode, then hand the existing arrival effect its usual single callback.
  const height = 308 * (aspect || data.aspect || 1) + 2;
  return <ImageRevealContext.Provider value={reveal}><div className={`output-reveal${aspect ? ' output-revealing' : ''}${full ? '' : ' output-reveal-light'}`}
    style={{ '--reveal-width': `${slot.width}px`, '--reveal-height': `${slot.height}px`, '--image-height': `${height}px` }}>
    {children}
    <div className="output-reveal-cover" aria-hidden="true"><div className="pending-shimmer"/>{videos && slot.clip && <WaitingVideo seed={slot.seed} src={slot.clip} initialTime={slot.time}/>}</div>
    <i className="output-reveal-sweep" aria-hidden="true"/><i className="output-reveal-flash" aria-hidden="true"/>
  </div></ImageRevealContext.Provider>;
}
