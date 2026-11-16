import React, { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { BaseEdge, ViewportPortal, getBezierPath, useStore } from '@xyflow/react';
import { curveOf, placeNumbers } from './edge-numbers.mjs';

// Panels drawn over the canvas hide what is under them, so a number keeps clear of them. Their boxes, relative to the
// canvas, change only when a panel appears, goes or changes size (the generation tray when Generate starts a run, the
// Getting started card), so observers measure them then; panning never measures anything.
const panels = '.canvas-top > span, .generation-tray, .canvas-bottom > *, .view-only-banner, .getting-started';
const watcher = { canvas: null, blocked: [], listeners: new Set(), stop: null, users: 0 };
function measure() {
  const { canvas } = watcher, shell = canvas?.closest('.canvas') || canvas?.parentElement, origin = canvas?.getBoundingClientRect();
  const blocked = shell && origin ? [...shell.querySelectorAll(panels)].map(element => element.getBoundingClientRect()).filter(box => box.width && box.height)
    .map(box => ({ left: box.left - origin.left, top: box.top - origin.top, right: box.right - origin.left, bottom: box.bottom - origin.top })) : [];
  if (JSON.stringify(blocked) === JSON.stringify(watcher.blocked)) return;
  watcher.blocked = blocked;
  for (const listener of watcher.listeners) listener();
}
function watch(canvas) {
  if (watcher.canvas === canvas && watcher.stop) return;
  watcher.stop?.();
  watcher.canvas = canvas;
  const shell = canvas?.closest('.canvas') || canvas?.parentElement;
  if (!shell || typeof ResizeObserver === 'undefined') { watcher.stop = null; return; }
  // After the change settles (a timer, not an animation frame, which a hidden window never runs). Observing an element
  // reports it once at once, so only a new set of panels is observed again.
  let timer = 0, observed = [];
  const later = () => { clearTimeout(timer); timer = setTimeout(() => {
    const current = [canvas, ...shell.querySelectorAll(panels)];
    if (current.length !== observed.length || current.some((element, index) => element !== observed[index])) { resized.disconnect(); current.forEach(element => resized.observe(element)); observed = current; }
    measure();
  }, 30); };
  const resized = new ResizeObserver(later), added = new MutationObserver(later);
  added.observe(shell, { childList: true });
  for (const bar of shell.querySelectorAll('.canvas-top, .canvas-bottom')) added.observe(bar, { childList: true, subtree: true });
  later();
  watcher.stop = () => { clearTimeout(timer); resized.disconnect(); added.disconnect(); watcher.stop = null; watcher.canvas = null; };
}
const subscribePanels = listener => { watcher.listeners.add(listener); return () => watcher.listeners.delete(listener); };
const blockedBoxes = () => watcher.blocked;
function usePanels(canvas) {
  useEffect(() => {
    if (!canvas) return undefined;
    watcher.users++; watch(canvas);
    return () => { if (--watcher.users === 0) watcher.stop?.(); };
  }, [canvas]);
  return useSyncExternalStore(subscribePanels, blockedBoxes, blockedBoxes);
}

// The numbered connections on screen, each with its line's curve. They are placed together (ConnectionNumbers), so
// numbers on lines that meet near their prompt never cover each other.
const lines = { byId: new Map(), list: [], listeners: new Set() };
function publish() { lines.list = [...lines.byId.values()]; for (const listener of lines.listeners) listener(); }
const subscribeLines = listener => { lines.listeners.add(listener); return () => lines.listeners.delete(listener); };
const currentLines = () => lines.list, noCards = [];

// A connection into the selected prompt. It draws as any connection; its number is drawn by ConnectionNumbers.
export function NumberedEdge(props) {
  const [path] = getBezierPath(props), label = props.data.number, color = props.style?.stroke;
  useLayoutEffect(() => {
    lines.byId.set(props.id, { id: props.id, label, curve: curveOf(path), color }); publish();
    return () => { lines.byId.delete(props.id); publish(); };
  }, [props.id, label, path, color]);
  return <BaseEdge id={props.id} path={path} style={props.style} markerStart={props.markerStart} markerEnd={props.markerEnd} interactionWidth={props.interactionWidth}/>;
}

// Each numbered connection's number on the part of its line that is in view (src/edge-numbers.mjs placeNumbers). The
// numbers keep their size at any zoom and never take a click. Rendered once, inside ReactFlow.
export function ConnectionNumbers() {
  const transform = useStore(state => state.transform), width = useStore(state => state.width), height = useStore(state => state.height), canvas = useStore(state => state.domNode);
  const numbered = useSyncExternalStore(subscribeLines, currentLines, currentLines), blocked = usePanels(numbered.length ? canvas : null);
  // Lines are drawn below cards, so a number never sits on a card its line runs under. Sections are frames behind
  // everything, not cards.
  const nodes = useStore(state => numbered.length ? state.nodes : noCards), lookup = useStore(state => state.nodeLookup);
  const cards = useMemo(() => nodes.flatMap(node => {
    const shown = lookup.get(node.id), at = shown?.internals.positionAbsolute || node.position, size = shown?.measured || node.measured;
    return node.hidden || node.type === 'section' || !size?.width || !size?.height ? [] : [{ x: at.x, y: at.y, width: size.width, height: size.height }];
  }), [nodes, lookup]);
  if (!numbered.length) return null;
  return <ViewportPortal>{placeNumbers(numbered, transform, { width, height, blocked, cards }).map(number => <div key={number.id} className={`connection-number${number.label.length > 2 ? ' wide' : ''}`} aria-hidden="true"
    style={{ transform: `translate(${number.x}px, ${number.y}px) scale(${1 / transform[2]}) translate(-50%, -50%)`, '--number-color': number.color }}>{number.label}</div>)}</ViewportPortal>;
}
