import React, { useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { useCanvasValue, useDetail } from './canvas-context.jsx';
import { readSoundPreference, writeSoundPreference } from './sounds.mjs';
import { t } from './i18n.mjs';

export function useWaitingVideos(viewer) {
  const key = `concept-graph-waiting-videos:${viewer}`;
  const read = () => { try { return readSoundPreference(localStorage, key); } catch { return true; } };
  const [videos, setVideos] = useState(read), [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    setVideos(read());
    const media = window.matchMedia('(prefers-reduced-motion: reduce)'), change = () => setReducedMotion(media.matches);
    change(); media.addEventListener('change', change);
    const storage = event => { if (event.key === key || event.key === null) setVideos(read()); };
    window.addEventListener('storage', storage);
    return () => { media.removeEventListener('change', change); window.removeEventListener('storage', storage); };
  }, [key]);
  return { enabled: videos && !reducedMotion, reducedMotion, toggle: () => setVideos(current => {
    const next = !current; try { writeSoundPreference(localStorage, key, next); } catch {} return next;
  }) };
}

function WaitingVideo({ src }) {
  const [playing, setPlaying] = useState(false), [failed, setFailed] = useState(false);
  return !failed && <video src={src} muted loop autoPlay playsInline preload="auto" aria-hidden="true" className={playing ? 'playing' : ''}
    onPlaying={() => setPlaying(true)} onWaiting={() => setPlaying(false)} onPause={() => setPlaying(false)} onError={() => setFailed(true)}/>;
}

export function PendingNode({ id, data }) {
  const full = useDetail(id) === 'full', videos = useCanvasValue(state => state.waitingVideos);
  return <article className={`node-card pending-node${data.describe ? ' pending-text' : ''}${full ? '' : ' pending-light'}`} style={{ width: '100%', height: '100%' }}>
    <div className="pending-shimmer" aria-hidden="true"/>
    {full && videos && !data.describe && data.clip && <WaitingVideo key={data.clip} src={data.clip}/>}
    {full && <span className="pending-status" role="status">{t(data.status)}</span>}
    <Handle type="target" position={Position.Left} isConnectable={false}/>
  </article>;
}
