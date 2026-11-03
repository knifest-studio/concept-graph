import { useEffect, useState } from 'react';
import { useStore } from '@xyflow/react';
import { canvasThumbnailCache } from './canvas-thumbnails.mjs';

// Only the image currently under the pointer or keyboard focus needs exact zoom.
export function useImageButtonZoom(active) {
  return useStore(state => active ? state.transform[2] : 1);
}

export function useCanvasImage(source) {
  const [thumbnail, setThumbnail] = useState(null);
  useEffect(() => {
    const handle = canvasThumbnailCache.acquire(source);
    let mounted = true;
    handle.ready.then(result => { if (mounted) setThumbnail({ source, ...result }); });
    return () => { mounted = false; handle.release(); };
  }, [source]);
  const current = thumbnail?.source === source ? thumbnail : null;
  // Keep the original visible until the thumbnail is ready, so node geometry stays stable.
  return { src: current?.src || source, aspectRatio: current?.aspectRatio };
}
