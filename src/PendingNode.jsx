import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { useCanvasValue, useDetail } from './canvas-context.jsx';
import { readSoundPreference, writeSoundPreference } from './sounds.mjs';
import { usePendingAnimation } from './PendingEdge.jsx';
import { t } from './i18n.mjs';
import { allWaitingVideos, clipAt, loadWaitingVideos } from './waiting-videos.mjs';
import { shownPlaceholders, prunePlaceholders } from './pending-reveals.mjs';

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

// Only the cloud site hosts clips; a desktop board has none to ask for and keeps its shimmer.
const hostsClips = import.meta.env.VITE_CONCEPT_GRAPH_CLOUD === '1';

function useWaitingClips() {
  const [clips, setClips] = useState(allWaitingVideos);
  useEffect(() => {
    if (!hostsClips) return;
    let live = true;
    loadWaitingVideos().then(list => { if (live) setClips(list); }, () => {});
    return () => { live = false; };
  }, []);
  return clips;
}

// One clip on repeat gets dull on a long run: when it ends, the next one in the list fades in. Neighbouring
// placeholders start on different clips and step together, so they keep showing different ones. A reveal passes
// the clip its placeholder was playing, so the picture arrives over the same frames rather than a fresh clip.
export function WaitingVideo({ seed = 0, src, initialTime = 0 }) {
  const clips = useWaitingClips();
  const [step, setStep] = useState(0), [playing, setPlaying] = useState(false), [errors, setErrors] = useState(0);
  const clip = step === 0 && src ? src : clipAt(seed, step, clips), next = clipAt(seed, step + 1, clips);
  // Fetch the following clip while this one plays, so the switch does not wait for the network.
  useEffect(() => { if (!next) return; const ahead = document.createElement('video'); ahead.muted = true; ahead.preload = 'auto'; ahead.src = next; return () => ahead.removeAttribute('src'); }, [next]);
  // A missing file is skipped; when none of them load the shimmer stays.
  return errors < clips.length && <video src={clip} muted loop={clips.length < 2} autoPlay playsInline preload="auto" aria-hidden="true" className={playing ? 'playing' : ''}
    onLoadedMetadata={event => { if (step === 0 && initialTime) { try { event.currentTarget.currentTime = initialTime; } catch {} } }}
    onPlaying={() => { setPlaying(true); setErrors(0); }} onWaiting={() => setPlaying(false)} onPause={() => setPlaying(false)}
    onEnded={() => setStep(step + 1)} onError={() => { setErrors(errors + 1); setStep(step + 1); }}/>;
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

export function PendingNode({ id, data, width = 310, height = 310, positionAbsoluteX, positionAbsoluteY }) {
  const media = useRef(null);
  useLayoutEffect(() => {
    prunePlaceholders(shownPlaceholders, performance.now());
    const slot = { id, runId: data.runId, describe: data.describe, seed: data.seed, width, height, x: positionAbsoluteX, y: positionAbsoluteY, media: media.current };
    shownPlaceholders.set(id, slot);
    return () => {
      const video = media.current?.querySelector('video');
      Object.assign(slot, { clip: video?.getAttribute('src') || slot.clip, time: video?.currentTime || 0, media: null, unmountedAt: performance.now() });
    };
  }, [id, data.runId, data.describe, data.seed, width, height, positionAbsoluteX, positionAbsoluteY]);
  const full = useDetail(id) === 'full', videos = useCanvasValue(state => state.waitingVideos);
  const { spawn, style } = usePendingAnimation(data.spawnAt), radius = Math.min(width, height) * .3;
  return <div className={`pending-node${data.describe ? ' pending-text' : ''}${full ? '' : ' pending-light'}${spawn ? ' pending-spawn' : ''}`} style={{ width: '100%', height: '100%', ...style }}>
    <article className="node-card pending-card">
      <div ref={media} className="pending-media"><div className="pending-shimmer" aria-hidden="true"/>
        {videos && !data.describe && data.seed !== undefined && <WaitingVideo key={data.seed} seed={data.seed}/>}
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
