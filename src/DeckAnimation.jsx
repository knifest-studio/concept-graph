import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { Position, ViewportPortal, getBezierPath, useStoreApi, useUpdateNodeInternals } from '@xyflow/react';
import { nodeSize } from '../graph.mjs';
import { frameHandles, nodeHandles } from './canvas.mjs';
import './deck-animation.css';

// Folding a slideshow closes it like an accordion: its images slide up under the shown one while the group's own card
// shrinks from the open frame to the folded card around it, the dashed line closing into a solid one. Unfolding is the same
// motion backwards. Nothing fades: the copies end exactly where the real images and card are drawn, then swap in the same
// frame. The images' links travel with them. It runs for every change of a group's fold on this page (a click, a teammate,
// a finished run), never on load, a page switch, or with reduced motion.
const maxCards = 24, duration = 420, stagger = 14, header = 40, settleFrames = 12;
const ease = 'cubic-bezier(.32, .72, 0, 1)';
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const boxOf = node => node && { x: node.position.x, y: node.position.y, ...(node.type === 'group' ? { width: node.width, height: node.height } : node.measured || nodeSize(node)) };
const place = box => ({ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
// Where a link meets a handle, as React Flow draws it: the middle of the handle's outer side.
const handlePoint = (handle, at) => ({ x: at.x + handle.x + (handle.position === Position.Right ? handle.width : 0), y: at.y + handle.y + handle.height / 2 });
const handleOf = (handles, type, id) => { const list = (handles || []).filter(handle => !type || handle.type === type); return (id == null ? list[0] : list.find(handle => handle.id === id)) || null; };
const edgeSelector = id => `.react-flow__edge[data-id="${CSS.escape(id)}"]`;

// During the motion the board only knows where the links end once it is over, so it would draw them to the folded card
// (or the open images) at once, or not at all until it has measured them. Instead the real links of the moving images wait
// hidden while copies keep their far end where the board draws it and carry their near end from where the real link meets
// the image (or the folded card) to where it will meet the card (or the image), at the pace of that image. Links between two
// images of the slideshow just wait hidden: folded, they are not drawn at all.
function linksOf({ fold, card, members, ids }, edges, views, copies, lookup, byId) {
  const ghosts = new Map(members.map((member, index) => [member.id, index])), cardHandles = frameHandles(card), links = [], waiting = [];
  for (const edge of edges) {
    const target = ids.has(edge.target), source = ids.has(edge.source);
    if (target && source) { waiting.push(edge.id); continue; }
    const side = target ? 'target' : source ? 'source' : null, ghost = side ? ghosts.get(edge[side]) : undefined;
    if (ghost === undefined) continue;
    const view = views.get(edge.id), far = side === 'target' ? 'source' : 'target', other = view && lookup.get(view[far]);
    const farHandle = other && handleOf(other.internals.handleBounds?.[far], null, view[`${far}Handle`]);
    const node = byId.get(edge[side]), box = members[ghost].box, own = node && handleOf(nodeHandles(node, box), side, edge[`${side}Handle`]), folded = handleOf(cardHandles, side, null);
    if (!farHandle || !own || !folded) continue;
    const open = handlePoint(own, box), shut = handlePoint(folded, card);
    links.push({ id: edge.id, ghost, side, far: { ...handlePoint(farHandle, other.internals.positionAbsolute), position: farHandle.position }, near: own.position,
      from: fold ? open : shut, to: fold ? shut : open, style: { fill: 'none', ...view.style },
      // Where its card will lie on another card, the copy is drawn over that card too, as the real link will be.
      over: (copies.get(edge.id) || []).map(copy => ({ z: copy.zIndex, clip: copy.data.clip })) });
    waiting.push(edge.id);
  }
  return { links, waiting };
}
function linkPath(link, progress) {
  const x = link.from.x + (link.to.x - link.from.x) * progress, y = link.from.y + (link.to.y - link.from.y) * progress;
  return getBezierPath(link.side === 'target'
    ? { sourceX: link.far.x, sourceY: link.far.y, sourcePosition: link.far.position, targetX: x, targetY: y, targetPosition: link.near }
    : { sourceX: x, sourceY: y, sourcePosition: link.near, targetX: link.far.x, targetY: link.far.y, targetPosition: link.far.position })[0];
}
// The real link has taken over once the board draws it where the copy ends.
function landed(link) {
  const d = document.querySelector(`${edgeSelector(link.id)} .react-flow__edge-path`)?.getAttribute('d'), numbers = d?.match(/-?\d*\.?\d+(?:e-?\d+)?/g)?.map(Number);
  if (!numbers || numbers.length < 4) return false;
  const [x, y] = link.side === 'target' ? numbers.slice(-2) : numbers;
  return Math.abs(x - link.to.x) < 1 && Math.abs(y - link.to.y) < 1;
}

export function DeckAnimation({ page, groups, nodes, edges, links, copies, src }) {
  const previous = useRef(null), [flights, setFlights] = useState([]), updateNodeInternals = useUpdateNodeInternals(), store = useStoreApi();
  const byId = new Map(nodes.map(node => [node.id, node]));
  const snapshot = new Map(groups.filter(group => group.slideshow).map(group => {
    const members = group.nodeIds.map(id => byId.get(id)).filter(node => node?.type === 'image' && node.data?.asset);
    return [group.id, { collapsed: !!group.collapsed, slide: byId.get(group.id)?.data?.slide?.id, frame: boxOf(byId.get(group.id)), ids: group.nodeIds,
      members: members.map(node => ({ id: node.id, asset: node.data.asset, box: node.hidden ? null : boxOf(node) })) }];
  }));
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { page, snapshot };
    if (!before || before.page !== page || reduced()) return;
    const started = [];
    for (const [id, now] of snapshot) {
      const was = before.snapshot.get(id);
      if (!was || was.collapsed === now.collapsed || !was.frame || !now.frame) continue;
      const fold = now.collapsed, card = fold ? now.frame : was.frame, open = fold ? was.frame : now.frame;
      // The shown image is the top of the stack: it ends (or starts) as the folded card's picture.
      const members = (fold ? was.members : now.members).filter(member => member.box).slice(0, maxCards);
      const shown = members.findIndex(member => member.id === (fold ? now : was).slide), order = shown > 0 ? [members[shown], ...members.filter((_, index) => index !== shown)] : members;
      if (!order.length) continue;
      const item = { key: `${id}:${performance.now()}`, group: id, fold, card, open, members: order, at: now.frame };
      const over = new Map();
      for (const copy of copies) over.set(copy.data.edge, [...(over.get(copy.data.edge) || []), copy]);
      started.push({ ...item, ...linksOf({ ...item, ids: new Set(now.ids) }, edges, new Map(links.map(link => [link.id, link])), over, store.getState().nodeLookup, byId) });
    }
    if (started.length) setFlights(current => [...current, ...started]);
  });
  // The board measures where a card's connection points are while the card is still being resized by the motion, and a
  // node whose own box keeps its size is never measured again; so once the motion ends its points are measured afresh,
  // or the links of a folded slideshow would keep pointing at the middle of the open column.
  const remeasure = item => updateNodeInternals([item.group, ...item.members.map(member => member.id)]);
  const finish = item => setFlights(current => current.filter(other => other !== item));
  return flights.length ? <ViewportPortal>{flights.map(item => <Flight key={item.key} item={item} src={src} remeasure={() => remeasure(item)} done={() => finish(item)}/>)}</ViewportPortal> : null;
}

function Flight({ item, src, remeasure, done }) {
  const ref = useRef(null), lines = useRef([]), clip = `deck-clip${useId().replace(/[^\w-]/g, '')}`;
  // Every drawn copy of a link (the one under the cards and those over covered cards) gets the same curve each frame.
  const keep = (index, slot) => element => { (lines.current[index] ||= [])[slot] = element; };
  const { fold, card, open, members, at, group, links, waiting } = item;
  // Where the folded card shows its picture: under its 40px header, inside its 1px border.
  const stage = { x: card.x + 1, y: card.y + header, width: card.width - 2, height: card.height - header - 1 };
  // Each copy sits where it ends and moves there by transform alone, which the browser animates off the main thread, so
  // the work of showing a group's images (mounting and measuring them as it unfolds) cannot make it stutter.
  const ends = members.map(member => fold ? stage : member.box), starts = members.map(member => fold ? member.box : stage);
  const offset = (from, to) => `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  useLayoutEffect(() => {
    const animations = [], count = members.length, last = (count - 1) * stagger + duration, cards = [...ref.current.children];
    const run = (element, keyframes, options) => { if (element) animations.push(element.animate(keyframes, { easing: ease, fill: 'both', ...options })); };
    cards.forEach((element, index) => {
      // Lower images start first and slide up under the ones above; unfolding mirrors it in time, top image first.
      const delay = (count - 1 - index) * stagger;
      run(element, [{ transform: offset(starts[index], ends[index]) }, { transform: 'none' }], { duration, delay: fold ? delay : last - delay - duration });
    });
    // The group's own card (or open frame) changes size between the two, so the real chrome moves with the images: folding,
    // it closes as the last image lands; unfolding, it opens over the whole spread so its edge keeps pace with the images.
    const frame = document.querySelector(`.react-flow__node[data-id="${CSS.escape(group)}"] .group-frame`);
    let chrome = null;
    if (frame) {
      const style = getComputedStyle(frame), shape = box => ({ translate: `${box.x - at.x}px ${box.y - at.y}px`, width: `${box.width}px`, height: `${box.height}px` });
      const closed = { ...shape(card), borderStyle: 'solid', backgroundColor: fold ? style.backgroundColor : 'var(--panel)', boxShadow: fold ? style.boxShadow : 'none' };
      const wide = { ...shape(open), borderStyle: 'dashed', backgroundColor: fold ? 'color-mix(in srgb, var(--panel) 40%, transparent)' : style.backgroundColor, boxShadow: fold ? 'none' : style.boxShadow };
      run(frame, fold ? [wide, closed] : [closed, wide], fold ? { duration, delay: last - duration } : { duration: last });
      chrome = animations.at(-1);
    }
    // A link follows its image: how far the copy has come is read back from its transform, along the side that moves most.
    const reach = members.map((_, index) => {
      const from = starts[index], to = ends[index], deltas = [from.x - to.x, from.y - to.y, from.width - to.width, from.height - to.height];
      const axis = deltas.reduce((best, value, index) => Math.abs(value) > Math.abs(deltas[best]) ? index : best, 0);
      return { axis, delta: deltas[axis] };
    });
    const progress = index => {
      const { axis, delta } = reach[index], end = ends[index];
      if (Math.abs(delta) < .5) return 1;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(cards[index]).transform), now = [matrix.e, matrix.f, (matrix.a - 1) * end.width, (matrix.d - 1) * end.height][axis];
      return Math.min(1, Math.max(0, 1 - now / delta));
    };
    const draw = () => { const seen = new Map(); links.forEach((link, index) => {
      if (!seen.has(link.ghost)) seen.set(link.ghost, progress(link.ghost));
      const d = linkPath(link, seen.get(link.ghost));
      for (const line of lines.current[index] || []) line?.setAttribute('d', d);
    }); };
    let live = true, frameId = 0, drawId = 0;
    if (links.length) drawId = requestAnimationFrame(function tick() { draw(); drawId = requestAnimationFrame(tick); });
    // Held at their first frame until the board has drawn the change once (two frames), then played together.
    animations.forEach(animation => animation.pause());
    frameId = requestAnimationFrame(() => { frameId = requestAnimationFrame(() => { if (live) animations.forEach(animation => animation.play()); }); });
    // Once still, the copies stay put until the board has measured the card again and draws the real links where the
    // copies end (a few frames at most), so handing over cannot make a link jump or blink.
    // The card's own motion is let go first: its last frame is how the card looks anyway, but while it holds, its translate
    // makes the card the box its connection points are placed in, one border width off from where they really sit.
    Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (!live) return;
      draw(); cancelAnimationFrame(drawId); chrome?.cancel();
      remeasure();
      let frames = 0;
      const check = () => { if (!live) return; if (++frames >= settleFrames || links.every(landed)) done(); else frameId = requestAnimationFrame(check); };
      frameId = requestAnimationFrame(check);
    });
    return () => { live = false; cancelAnimationFrame(frameId); cancelAnimationFrame(drawId); animations.forEach(animation => animation.cancel()); };
  }, []);
  // While the copies move, the real picture (folding) or the real images (unfolding) and their links wait hidden; they show
  // in the same frame the copies are removed, at the very place the copies end.
  const hidden = [...(fold ? [`.react-flow__node[data-id="${CSS.escape(group)}"] .slideshow-stage`] : members.map(member => `.react-flow__node[data-id="${CSS.escape(member.id)}"]`)), ...waiting.map(edgeSelector), ...waiting.map(id => `.react-flow__edge[data-id^="${CSS.escape(`${id}~over~`)}"]`)];
  return <>
    <style>{`${hidden.join(',')}{visibility:hidden!important}`}</style>
    {links.length ? <svg className="deck-links" style={{ zIndex: 0 }} aria-hidden="true">{links.map((link, index) => <path key={link.id} data-link={link.id} ref={keep(index, 0)} d={linkPath(link, 0)} style={link.style}/>)}</svg> : null}
    {[...new Set(links.flatMap(link => link.over.map(over => over.z)))].map(z => <svg key={z} className="deck-links" style={{ zIndex: z }} aria-hidden="true">
      {links.flatMap((link, index) => link.over.map((over, copy) => over.z !== z ? null : <React.Fragment key={`${link.id}:${copy}`}>
        <clipPath id={`${clip}-${index}-${copy}`}><rect x={over.clip.x} y={over.clip.y} width={over.clip.width} height={over.clip.height} rx="10"/></clipPath>
        <path ref={keep(index, copy + 1)} d={linkPath(link, 0)} style={link.style} clipPath={`url(#${clip}-${index}-${copy})`}/>
      </React.Fragment>))}
    </svg>)}
    <div ref={ref} className="deck-flight" aria-hidden="true">
      {members.map((member, index) => <div key={member.id} className="deck-card" style={{ zIndex: members.length - index, ...place(ends[index]), transform: offset(starts[index], ends[index]) }}><img src={src(member.asset)} alt="" draggable="false" referrerPolicy="no-referrer"/></div>)}
    </div>
  </>;
}
