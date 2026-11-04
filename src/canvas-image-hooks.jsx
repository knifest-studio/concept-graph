import { useEffect, useRef, useState } from 'react';
import { useStore } from '@xyflow/react';
import { canvasThumbnailCache, thumbnailWidth } from './canvas-thumbnails.mjs';

// Only the image currently under the pointer or keyboard focus needs exact zoom.
export function useImageButtonZoom(active) {
  return useStore(state => active ? state.transform[2] : 1);
}

// A card shows a light placeholder until its thumbnail exists, never the full original. `small` picks the zoomed-out size;
// without `create` only thumbnails that already exist are shown, so a far zoom-out over a huge board downloads nothing.
export function useCanvasImage(source, { small = false, create = true } = {}) {
  const width = thumbnailWidth(small), [, refresh] = useState(0), held = useRef(null);
  useEffect(() => {
    let mounted = true;
    const release = canvasThumbnailCache.hold(source), handle = create ? canvasThumbnailCache.acquire(source, width) : null;
    // The size shown until now is let go only after the new one is held, so switching sizes never evicts what is on screen.
    const previous = held.current;
    held.current = () => { release(); handle?.release(); };
    previous?.();
    if (handle && !canvasThumbnailCache.peek(source, width)) handle.ready.then(() => { if (mounted) refresh(value => value + 1); });
    return () => { mounted = false; };
  }, [source, width, create]);
  useEffect(() => () => held.current?.(), []);
  const shown = canvasThumbnailCache.shown(source, width);
  return { src: shown?.src || null, aspectRatio: canvasThumbnailCache.aspect(source) || shown?.aspectRatio };
}
