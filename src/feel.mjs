export const presets = Object.freeze({
  generate: { intensity: 'significant', sound: 'start' },
  create: { intensity: 'frequent', sound: 'create' },
  connect: { intensity: 'frequent', sound: 'connect' },
  pickup: { intensity: 'frequent' }, drop: { intensity: 'frequent', sound: 'drop' },
  remove: { intensity: 'frequent', sound: 'remove' },
  arrival: { intensity: 'significant', sound: 'arrival' },
  error: { intensity: 'significant', sound: 'error' },
  step: { intensity: 'significant', sound: 'step' },
  helper: { intensity: 'significant', sound: 'success' },
  'dictation-start': { intensity: 'frequent', sound: 'tick-up' },
  'dictation-stop': { intensity: 'frequent', sound: 'tick-down' },
  dictated: { intensity: 'frequent' }, 'sound-on': { intensity: 'frequent', sound: 'tick-up' },
  'first-image': { intensity: 'rare', sound: 'celebrate' },
  onboarding: { intensity: 'rare', sound: 'celebrate' },
});
const celebrationFallback = new Set();
export const dragTilt = (dx, milliseconds) => Number.isFinite(dx) && Number.isFinite(milliseconds) && milliseconds > 0 ? Math.max(-3, Math.min(3, dx / milliseconds * 2)) : 0;
export function claimCelebration(storage, viewer, kind, fallback = celebrationFallback) {
  const key = `concept-graph-feel:${viewer}:${kind}`;
  if (fallback.has(key)) return false;
  fallback.add(key);
  try { if (storage?.getItem(key) === 'done') return false; storage?.setItem(key, 'done'); } catch {}
  return true;
}

let overlay;
const animations = new Set(), frames = new Set(), active = new WeakMap(), flashes = new WeakMap();
const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export const nodeElement = id => typeof document === 'undefined' || !id ? null : document.querySelector(`[data-feel-node="${CSS.escape(id)}"]`);
export function mountFeelOverlay() {
  const layer = document.createElement('div');
  layer.className = 'feel-overlay'; layer.setAttribute('aria-hidden', 'true'); document.body.appendChild(layer); overlay = layer;
  const clear = () => { for (const frame of frames) cancelAnimationFrame(frame); frames.clear(); for (const animation of [...animations]) animation.cancel(); layer.replaceChildren(); };
  const hidden = () => { if (document.hidden) clear(); };
  const media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  media?.addEventListener('change', clear); document.addEventListener('visibilitychange', hidden);
  return () => { clear(); layer.remove(); if (overlay === layer) overlay = null; media?.removeEventListener('change', clear); document.removeEventListener('visibilitychange', hidden); };
}
function animate(element, frames, duration, channel = 'motion', finish, easing = 'cubic-bezier(.2,.8,.2,1)') {
  if (!element?.animate) { finish?.(); return; }
  let channels = active.get(element); if (!channels) active.set(element, channels = new Map());
  channels.get(channel)?.cancel();
  const animation = element.animate(frames, { duration, easing });
  channels.set(channel, animation); animations.add(animation);
  const clean = () => { animations.delete(animation); if (channels.get(channel) === animation) channels.delete(channel); };
  animation.onfinish = () => { clean(); finish?.(); };
  animation.oncancel = () => { clean(); if (element.parentElement === overlay) element.remove(); };
}
function piece(rect, className, color) {
  if (!overlay) return null;
  const element = document.createElement('i'); element.className = className;
  Object.assign(element.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, color });
  overlay.appendChild(element); return element;
}
function flash(element, color, duration = 400, fill = false) {
  if (!element || performance.now() - (flashes.get(element) ?? -Infinity) < 350) return;
  flashes.set(element, performance.now());
  const ring = piece(element.getBoundingClientRect(), 'feel-flash', color);
  if (ring && fill) ring.style.background = 'color-mix(in srgb,var(--blue) 18%,transparent)';
  if (ring) animate(ring, [{ opacity: .9 }, { opacity: .6, offset: .35 }, { opacity: 0 }], duration, 'flash', () => ring.remove(), 'linear');
}
function particles(rect, count, confetti = false, dust = false) {
  if (reduced() || !rect) return;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2, distance = (confetti ? 100 : dust ? 20 : 55) + Math.random() * (confetti ? 160 : dust ? 50 : 95), size = (dust ? 3 : 5) + Math.random() * (dust ? 4 : 7);
    const dot = piece({ left: rect.left + rect.width / 2, top: rect.top + rect.height / 2, width: size, height: confetti ? size * 1.8 : size }, `feel-particle${dust ? ' feel-dust' : !confetti && i % 2 ? ' feel-star' : ''}`, dust ? 'var(--muted)' : confetti ? ['var(--purple)', 'var(--blue)', 'var(--success)'][i % 3] : ['var(--purple)', '#a78bfa', 'var(--blue)', '#f5b83d'][i % 4]);
    if (!dot) return;
    const x = Math.cos(angle) * distance, y = Math.sin(angle) * distance;
    animate(dot, [{ transform: 'translate(-50%,-50%) scale(.3)', opacity: 0, easing: 'cubic-bezier(.2,.8,.4,1)' }, { transform: `translate(${x * .3}px,${y * .3}px) rotate(50deg)`, opacity: 1, offset: .15, easing: 'cubic-bezier(.2,.8,.4,1)' }, { transform: `translate(${x * .85}px,${y * .85 + (confetti ? 90 : 8)}px) rotate(${60 + Math.random() * 160}deg) scale(.8)`, opacity: .9, offset: .7 }, { transform: `translate(${x}px,${y + (confetti ? 140 : 15)}px) rotate(${90 + Math.random() * 240}deg) scale(.2)`, opacity: 0 }], confetti ? 1100 : dust ? 260 : 900, 'particle', () => dot.remove(), 'linear');
  }
}
function flight(source) {
  const destination = () => document.querySelector('.generation-tray header>span,.canvas-tagline');
  const target = destination(); if (!source || !target || reduced()) return;
  const a = source.getBoundingClientRect(), b = target.getBoundingClientRect(), x = b.left + b.width / 2 - a.left - a.width / 2, y = b.top + b.height / 2 - a.top - a.height / 2;
  const dot = piece({ left: a.left + a.width / 2, top: a.top + a.height / 2, width: 10, height: 10 }, 'feel-flight', 'var(--blue)');
  if (dot) animate(dot, [{ transform: 'translate(-50%,-50%)', opacity: 1, easing: 'cubic-bezier(.3,0,.6,1)' }, { transform: `translate(${x * .5}px,${y * .5 - 65}px) scale(1.5)`, opacity: 1, offset: .5, easing: 'cubic-bezier(.4,0,.7,1)' }, { transform: `translate(${x}px,${y}px) scale(.6)`, opacity: .5 }], 620, 'flight', () => {
    dot.remove(); const landed = destination();
    if (landed && !document.hidden) { if (reduced()) flash(landed, 'var(--blue)'); else animate(landed, [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], 260); }
  }, 'linear');
}
export function fireFeel(name, { element, nodeId, source, point, rects = [] } = {}) {
  if (!presets[name] || typeof document === 'undefined' || document.hidden) return;
  element ||= nodeElement(nodeId);
  const inner = element?.querySelector(':scope > .feel-inner') || element;
  const motion = (frames, duration) => reduced() ? flash(element, name === 'error' ? 'var(--error)' : name === 'arrival' ? 'var(--purple)' : 'var(--success)') : animate(inner, frames, duration);
  if (name === 'generate') {
    source ||= element?.querySelector('.run-button') || element;
    if (source) {
      const box = source.getBoundingClientRect(), ripple = piece(box, 'feel-ripple-clip', 'var(--blue)');
      if (ripple) {
        const circle = document.createElement('b'); const diameter = Math.hypot(box.width, box.height) * 2;
        Object.assign(circle.style, { width: `${diameter}px`, height: `${diameter}px`, left: `${(point?.x ?? box.left + box.width / 2) - box.left}px`, top: `${(point?.y ?? box.top + box.height / 2) - box.top}px` }); ripple.appendChild(circle);
        animate(ripple, [{ opacity: 1 }, { opacity: 0 }], 400, 'clip', () => ripple.remove());
        animate(circle, reduced() ? [{ opacity: .2 }, { opacity: 0 }] : [{ transform: 'translate(-50%,-50%) scale(0)', opacity: .35 }, { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 }], 400, 'ripple', () => ripple.remove());
      }
      if (!reduced()) {
        animate(source.closest('.generate-slot') || source, [{ transform: 'scale(.94)' }, { transform: 'scale(1.035)' }, { transform: 'scale(1)' }], 220, 'release');
        const frame = requestAnimationFrame(() => { frames.delete(frame); if (!document.hidden) flight(source); }); frames.add(frame);
      }
    }
    motion([{ transform: 'translateY(0)' }, { transform: 'translateY(2px)' }, { transform: 'translateY(0)' }], 220);
  } else if (name === 'pickup') {
    motion([{ transform: 'scale(1)' }, { transform: 'scale(1.02) rotate(1deg)' }, { transform: 'scale(1)' }], 220);
  } else if (name === 'connect' || name === 'drop') {
    motion([{ transform: `scale(${name === 'drop' ? 1.02 : 1})` }, { transform: `scale(${name === 'drop' ? .99 : 1.03})` }, { transform: 'scale(1)' }], name === 'drop' ? 220 : 200);
    if (name === 'connect') flash(element?.querySelector('.react-flow__handle-left') || element, 'var(--success)', 250);
  } else if (name === 'error') {
    motion([0, -6, 6, -6, 6, -6, 6, 0].map(x => ({ transform: `translateX(${x}px)` })), 320); flash(element, 'var(--error)', 450);
  } else if (name === 'remove') {
    for (const rect of rects) {
      const ghost = piece(rect, 'feel-ghost', 'var(--muted)');
      if (ghost) animate(ghost, reduced() ? [{ opacity: .25 }, { opacity: 0 }] : [{ transform: 'scale(1)', opacity: .3 }, { transform: 'scale(.8)', opacity: 0 }], 200, 'ghost', () => ghost.remove());
      particles(rect, 6, false, true);
    }
  } else if (['arrival', 'first-image', 'onboarding'].includes(name)) {
    if (element) { flash(element, name === 'onboarding' ? 'var(--success)' : 'var(--purple)', 900); particles(element.getBoundingClientRect(), name === 'arrival' ? 16 : 36, name !== 'arrival'); }
  } else if (name === 'dictated') flash(element, 'var(--blue)', 600, true);
  else if (name === 'dictation-start') flash(element, 'var(--blue)', 300);
  else if (name === 'step' || name === 'helper' || name === 'sound-on') flash(element, 'var(--success)');
  else if (name === 'create') motion([{ transform: 'scale(.82)', opacity: 0 }, { transform: 'scale(1.04)', opacity: 1 }, { transform: 'scale(1)', opacity: 1 }], 260);
}
