import { codexImageActive, runPlaceholders } from './run-placeholders.mjs';
import { boardPages, nodePage } from './pages.mjs';

export const pendingTiming = Object.freeze({ stagger: 150, fresh: 2500, fly: 460, impact: 440, ring: 520,
  splash: 420, fade: 90, pop: 340, pulseWait: 900, pulseFlight: 900, pulsePeriod: 1500 });
export const pendingEase = 'cubic-bezier(.645,.045,.355,1)';

// Seed loads/reconnects too: an old run must never become fresh after an edit or an undo.
export function observePendingSpawns(seen, graph, runs, { now, live = false, local = false, userName } = {}) {
  let next = seen;
  for (const run of runs) {
    const previous = next.get(run.id);
    if (previous && !(live && run.outputIds?.length && codexImageActive(run))) continue;
    const slots = new Map(previous), prompt = graph.nodes.find(node => node.id === run.nodeId);
    if (live && prompt && ['queued', 'running'].includes(run.status) && (local || (userName && run.by?.name === userName))) {
      const page = nodePage(prompt, boardPages(graph));
      runPlaceholders(graph, [run], page).nodes.forEach((node, index) => { if (!slots.has(node.id)) slots.set(node.id, now + index * pendingTiming.stagger); });
    }
    if (previous && slots.size === previous.size) continue;
    if (next === seen) next = new Map(seen);
    next.set(run.id, slots);
  }
  return next;
}

export function pendingAnimation(spawnAt, now, reducedMotion = false) {
  const spawn = !reducedMotion && Number.isFinite(spawnAt) && now - spawnAt <= pendingTiming.fresh;
  const delay = spawn ? spawnAt - now : 0, ms = value => `${value}ms`;
  return { spawn, style: { '--pending-delay': ms(delay), '--pending-impact': ms(delay + pendingTiming.impact),
    '--pending-fly': ms(pendingTiming.fly), '--pending-ring': ms(pendingTiming.ring), '--pending-splash': ms(pendingTiming.splash),
    '--pending-fade': ms(pendingTiming.fade), '--pending-pop': ms(pendingTiming.pop), '--pending-ease': pendingEase,
    '--pending-pulse-delay': ms(spawn ? delay + pendingTiming.impact + pendingTiming.pulseWait : 0), '--pending-pulse-period': ms(pendingTiming.pulsePeriod) } };
}

// A pulse rests at the end of the path between flights; derive the stops from the same clock as spawn.
const flight = pendingTiming.pulseFlight / pendingTiming.pulsePeriod * 100;
export const pendingPulseKeyframes = `@keyframes pending-pulse-flight{0%{offset-distance:0%;animation-timing-function:${pendingEase}}${flight}%,100%{offset-distance:100%}}
@keyframes pending-pulse-fade{0%,${flight}%,100%{opacity:0}${flight * .15}%,${flight * .85}%{opacity:1}}`;
