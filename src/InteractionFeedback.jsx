import React, { useEffect, useRef, useState } from 'react';
import { eventOnce, soundPreferenceKey, readSoundPreference, writeSoundPreference, unlockSounds, playSound } from './sounds.mjs';
import { claimCelebration, dragTilt, fireFeel, mountFeelOverlay, nodeElement, presets } from './feel.mjs';
import { newOutputIds } from './feedback.mjs';
import { useUpdateNodeInternals } from '@xyflow/react';
import { useCanvasValue } from './canvas-context.jsx';

export function useInteractionFeedback(viewer) {
  const key = soundPreferenceKey(viewer);
  const [sounds, setSounds] = useState(() => { try { return readSoundPreference(localStorage, key); } catch { return true; } });
  const enabled = useRef(sounds), seen = useRef(new Set()), own = useRef(new Set()), events = useRef(new Set());
  const readyRuns = useRef(new Map()), failures = useRef(new Map()), runNodes = useRef(new Map()), celebrations = useRef(new Set()), drag = useRef(null);
  const pending = useRef(new Map()), timers = useRef(new Map()), attempt = useRef(null), alive = useRef(true), lastCreate = useRef(0);
  const [nodes, setNodes] = useState(new Map()), [edges, setEdges] = useState(new Set());
  useEffect(() => {
    alive.current = true;
    const unmountOverlay = mountFeelOverlay();
    const unlock = () => { if (enabled.current) unlockSounds(); };
    const hidden = () => {
      if (!document.hidden) return;
      for (const { runId } of pending.current.values()) eventOnce(events.current, `arrival:${runId}`);
      for (const [runId, ready] of readyRuns.current) { eventOnce(events.current, `reward:${runId}`); for (const id of ready.ids) eventOnce(events.current, `output-reward:${id}`); }
      pending.current.clear(); setNodes(new Map()); setEdges(new Set());
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pointerdown', unlock, true); window.addEventListener('keydown', unlock, true);
    return () => {
      unmountOverlay();
      alive.current = false; for (const timer of timers.current.values()) clearTimeout(timer);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true);
    };
  }, []);
  const sound = (kind, id, options) => { if (eventOnce(events.current, `${kind}:${id}`) && enabled.current) playSound(kind, () => enabled.current && alive.current, options); };
  const fire = (name, options = {}, eventId = crypto.randomUUID()) => {
    if (!presets[name] || !alive.current || document.hidden) return;
    fireFeel(name, options);
    if (presets[name].sound) sound(presets[name].sound, eventId, options);
  };
  const once = kind => { let storage; try { storage = localStorage; } catch {} return claimCelebration(storage, viewer, kind, celebrations.current); };
  const arrival = runId => {
    const ready = readyRuns.current.get(runId); if (!ready || document.hidden) return;
    for (const id of ready.ids) {
      if (!eventOnce(events.current, `output-reward:${id}`)) continue;
      if (eventOnce(events.current, `reward:${runId}`)) fire(once('first-image') ? 'first-image' : 'arrival', { nodeId: id }, runId);
      else fireFeel('arrival', { nodeId: id });
    }
    if (eventOnce(events.current, `settle:${runId}`)) animate(ready.promptId || runNodes.current.get(runId), 'settled');
  };
  const error = (runId, nodeId) => {
    if (eventOnce(events.current, `failure:${runId}`)) fire('error', { nodeId }, runId);
  };
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const debug = { presets, fire: (name, options = {}) => {
      const element = options.element || nodeElement(options.nodeId) || document.querySelector('.node-feedback,.getting-started');
      // Visual/audio preview only: never claim celebrations or change a board.
      if (['arrival', 'first-image'].includes(name) && element?.dataset.feelNode) animate(element.dataset.feelNode, 'output');
      fire(name, { ...options, element, rects: options.rects || (element ? [element.getBoundingClientRect()] : []) });
    } };
    window.__feel = debug;
    return () => { if (window.__feel === debug) delete window.__feel; };
  });
  const animate = (id, kind, color) => {
    if (!id || !alive.current || document.hidden) return;
    setNodes(current => new Map(current).set(id, { kind, color }));
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      if (alive.current) setNodes(current => { const next = new Map(current); next.delete(id); return next; });
    }, kind === 'created' ? 300 : 1300));
  };
  const observeRun = (run, live) => {
    runNodes.current.set(run.id, run.nodeId);
    if (!['error', 'failed'].includes(run.status)) return;
    failures.current.set(run.id, { live, nodeId: run.nodeId });
    if (!live) { eventOnce(events.current, `error:${run.id}`); eventOnce(events.current, `failure:${run.id}`); }
    else if (own.current.has(run.id)) error(run.id, run.nodeId);
  };
  return {
    sounds, nodes, edges, pending: pending.current, fire, once,
    toggleSounds: event => {
      const next = !enabled.current; enabled.current = next; setSounds(next);
      try { writeSoundPreference(localStorage, key, next); } catch {}
      if (next) { unlockSounds(); fire('sound-on', { element: event?.currentTarget }); }
    },
    start: (nodeId, event) => { const id = crypto.randomUUID(); attempt.current = { id, nodeId }; if (enabled.current) unlockSounds(); fire('generate', { nodeId, source: event?.currentTarget, point: event?.detail ? { x: event.clientX, y: event.clientY } : undefined }, id); },
    ownRun: id => {
      own.current.add(id); if (attempt.current) { attempt.current.runId = id; runNodes.current.set(id, attempt.current.nodeId); }
      if (readyRuns.current.has(id)) arrival(id);
      const failure = failures.current.get(id); if (failure?.live) error(id, failure.nodeId);
    },
    failedStart: () => { if (attempt.current) error(attempt.current.runId || attempt.current.id, attempt.current.nodeId); },
    remove: ids => {
      const rects = ids.map(id => nodeElement(id)?.getBoundingClientRect()).filter(Boolean);
      if (rects.length) fire('remove', { rects });
    },
    dragStart: (event, node) => { drag.current = { id: node.id, x: event.clientX ?? event.touches?.[0]?.clientX ?? 0, time: performance.now(), tilt: 0 }; },
    dragMove: (event, node) => {
      const previous = drag.current;
      if (!previous) return;
      // Found once per drag: a document-wide attribute lookup on every pointer move is costly on a full board.
      if (previous.element === undefined || (previous.element && !previous.element.isConnected)) previous.element = nodeElement(node.id)?.querySelector('.feel-inner') || document.querySelector(`.react-flow__node[data-id="${CSS.escape(node.id)}"] .group-frame`);
      const element = previous.element;
      if (!element) return;
      const time = performance.now(), x = event.clientX ?? event.touches?.[0]?.clientX ?? previous.x, tilt = previous.tilt * .6 + dragTilt(x - previous.x, time - previous.time) * .4;
      element.style.setProperty('--drag-tilt', `${tilt}deg`); drag.current = { id: node.id, x, time, tilt, element };
    },
    dragStop: (_, node) => {
      drag.current = null; const element = nodeElement(node.id) || document.querySelector(`.react-flow__node[data-id="${CSS.escape(node.id)}"] .group-frame`);
      element?.querySelector('.feel-inner')?.style.removeProperty('--drag-tilt');
      element?.style.removeProperty('--drag-tilt'); fire('drop', { element });
    },
    createNodes: ids => {
      for (const id of ids) { seen.current.add(id); animate(id, 'created'); }
      if (ids.length) { lastCreate.current = Date.now(); sound(presets.create.sound, ids[0]); }
    },
    createEdges: (ids, targets = []) => {
      if (document.hidden) return;
      // A prompt created together with its link gets one sound, not two.
      if (ids.length && Date.now() - lastCreate.current > 200) sound(presets.connect.sound, ids[0]);
      for (const target of new Set(targets)) fireFeel('connect', { nodeId: target });
      setEdges(current => new Set([...current, ...ids]));
      const timerKey = Symbol();
      timers.current.set(timerKey, setTimeout(() => {
        timers.current.delete(timerKey);
        if (alive.current) setEdges(current => new Set([...current].filter(id => !ids.includes(id))));
      }, 300));
    },
    observeRun,
    observeGraph: (graph, { live = false, peer } = {}) => {
      const freshNodes = peer && live ? graph.nodes.filter(node => !seen.current.has(node.id)) : [];
      const outputs = newOutputIds(seen.current, graph.nodes, graph.runs, live);
      for (const run of graph.runs) observeRun(run, live);
      for (const id of outputs) {
        const runId = graph.nodes.find(node => node.id === id).data.runId;
        if (!document.hidden) pending.current.set(id, { runId, color: peer?.color, promptId: graph.runs.find(run => run.id === runId)?.nodeId });
        else eventOnce(events.current, `arrival:${runId}`);
      }
      for (const node of freshNodes) if (!outputs.includes(node.id)) animate(node.id, 'peer', peer.color);
      if (!live) {
        for (const { runId } of pending.current.values()) eventOnce(events.current, `arrival:${runId}`);
        pending.current.clear();
      }
    },
    outputFailed: id => { if (pending.current.delete(id) && alive.current) setNodes(current => new Map(current)); },
    outputReady: id => {
      if (!pending.current.has(id)) return;
      const { runId, color, promptId } = pending.current.get(id); pending.current.delete(id);
      if (!alive.current) return;
      animate(id, 'output', color);
      const ready = readyRuns.current.get(runId) || { ids: new Set(), promptId }; ready.ids.add(id); readyRuns.current.set(runId, ready);
      if (document.hidden) eventOnce(events.current, `arrival:${runId}`);
      if (own.current.has(runId)) arrival(runId);
    },
    forgetPending: () => { readyRuns.current.clear(); pending.current.clear(); if (alive.current) { setNodes(new Map()); setEdges(new Set()); } },
  };
}

// Reads only this node's effect from the canvas store, so another node's animation does not re-render it.
export function NodeFeedback({ id, working, children, ...props }) {
  const effect = useCanvasValue(state => state.effectNodes.get(id)), waiting = useCanvasValue(state => state.pending.has(id)), updateNodeInternals = useUpdateNodeInternals();
  return <div {...props} data-feel-node={id} onAnimationEnd={event => { if (event.target === event.currentTarget && ['node-created', 'image-arrived'].includes(event.animationName)) updateNodeInternals(id); }} className={`node-feedback${working ? ' feedback-working' : ''}${waiting ? ' feedback-waiting' : ''}${effect ? ` feedback-${effect.kind}` : ''}`} style={effect?.color ? { '--presence-color': effect.color } : undefined}><div className="feel-inner">{children}</div></div>;
}
