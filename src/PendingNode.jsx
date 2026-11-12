import React, { useEffect, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { useCanvasValue, useDetail } from './canvas-context.jsx';
import { readSoundPreference, writeSoundPreference } from './sounds.mjs';
import { usePendingAnimation } from './PendingEdge.jsx';
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

function PendingSplash({ spawnAt, height }) {
  const { spawn, style } = usePendingAnimation(spawnAt);
  if (!spawn) return null;
  return <g transform={`translate(0 ${height / 2})`} style={style}>{Array.from({ length: 9 }, (_, index) => {
    const angle = Math.PI * (.55 + index * .9 / 8);
    return <circle key={index} className="pending-splash" r="2.6" fill={index % 2 ? '#FAC775' : '#EF9F27'}
      style={{ '--pending-splash-x': `${Math.cos(angle) * 46}px`, '--pending-splash-y': `${Math.sin(angle) * 46}px` }}/>;
  })}</g>;
}

export function PendingNode({ id, data, width = 310, height = 310 }) {
  const full = useDetail(id) === 'full', videos = useCanvasValue(state => state.waitingVideos);
  const { spawn, style } = usePendingAnimation(data.spawnAt), radius = Math.min(width, height) * .3;
  return <div className={`pending-node${data.describe ? ' pending-text' : ''}${full ? '' : ' pending-light'}${spawn ? ' pending-spawn' : ''}`} style={{ width: '100%', height: '100%', ...style }}>
    <article className="node-card pending-card">
      <div className="pending-media"><div className="pending-shimmer" aria-hidden="true"/>
        {full && videos && !data.describe && data.clip && <WaitingVideo key={data.clip} src={data.clip}/>}
      </div>
      {full && <span className="pending-status" role="status">{t(data.status)}</span>}
    </article>
    {spawn && <svg className="pending-impact" width={width} height={height} aria-hidden="true">
      <circle className="pending-ring" cx={width / 2} cy={height / 2} r={radius} style={{ '--pending-radius': `${radius}px`, '--pending-radius-end': `${radius + 58}px` }}/>
      {full && <PendingSplash spawnAt={data.spawnAt} height={height}/>}
    </svg>}
    <Handle type="target" position={Position.Left} isConnectable={false}/>
  </div>;
}
