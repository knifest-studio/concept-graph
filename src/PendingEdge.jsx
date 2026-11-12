import React, { useState } from 'react';
import { BaseEdge, getBezierPath } from '@xyflow/react';
import { useCanvasValue } from './canvas-context.jsx';
import { pendingAnimation } from './pending-animation.mjs';

export function usePendingAnimation(spawnAt) {
  const reduced = useCanvasValue(state => state.reducedMotion);
  // Freeze delays at mount; geometry and timer renders must not rewind a flight.
  const [animation] = useState(() => pendingAnimation(spawnAt, performance.now(), reduced));
  return animation;
}

function PendingTail({ spawnAt, motion }) {
  const { spawn, style } = usePendingAnimation(spawnAt);
  if (!spawn) return null;
  return <g style={style}>{Array.from({ length: 7 }, (_, index) => <circle key={index} className="pending-flight" r={5.2 - index * 3.8 / 6} fillOpacity={.66 - index * .54 / 6}
    style={{ ...motion, '--pending-back': `${(index + 1) * 2.2}%` }}/>)}</g>;
}

function PendingPulse({ spawnAt, motion }) {
  const { style } = usePendingAnimation(spawnAt);
  return <circle className="pending-pulse" r="3" style={{ ...style, ...motion }} aria-hidden="true"/>;
}

export function PendingEdge(props) {
  const [path] = getBezierPath(props), { spawn, style } = usePendingAnimation(props.data?.spawnAt);
  const full = useCanvasValue(state => state.detail === 'full'), reduced = useCanvasValue(state => state.reducedMotion);
  const motion = { offsetPath: `path('${path}')` };
  return <g className={spawn ? 'pending-spawn' : ''} style={style}>
    <BaseEdge id={props.id} path={path} pathLength="1" className="pending-line" style={props.style} markerStart={props.markerStart} markerEnd={props.markerEnd}/>
    {spawn && <g className="pending-comet" aria-hidden="true">
      {full && <PendingTail spawnAt={props.data?.spawnAt} motion={motion}/>}
      <circle className="pending-flight" r="5.5" style={motion}/>
    </g>}
    {full && !reduced && <PendingPulse spawnAt={props.data?.spawnAt} motion={motion}/>}
  </g>;
}
