import { captionHeight, isSiteGenerator, maxDescription, model3dTask, nodeSize, ratioAspect, runOutputPage, textNodeSize } from '../graph.mjs';
import { canAttachStamp } from './annotations.mjs';
import { frameBox, groupBounds } from './canvas.mjs';
import { nextLayer } from './layers.mjs';
import { nearestFreePosition } from './node-placement.mjs';
import { boardPages, defaultPageId, pageContent, pageResolver } from './pages.mjs';

// Where generated results land: right beside their prompt, top-aligned with it, a run's results one above another in
// one column. Every generator, the local server, the cloud room, the Codex relay and the placeholders shown while a
// run works all place through here, so a placeholder is where its result will appear.

// Results start 80px right of the prompt (where those of a 310px prompt always began); a run's cards are 30px apart, and
// everything keeps 24px clear of what is already there. A run's group frame adds 24px at the sides and bottom, 48 on top.
const outputGap = 80, pad = 24, stackGap = 30, frameSide = 24, frameHeader = 48;
// A run looks for room level with its prompt this many columns further right (each the run's width) before going below,
// and goes at most as far down under the prompt's earlier results before looking elsewhere in the prompt's row.
const reachColumns = 3;

// Diagnostics already reach local/hosted clients; progress text can outlive the tool call.
export const codexImageActive = run => run.diagnostics?.events?.findLast(event => ['image_started', 'image_completed', 'image_failed', 'turn_completed', 'error'].includes(event.type))?.type === 'image_started';
const knownAspect = node => {
  const aspect = node?.data?.aspect || node?.data?.pixels?.height / node?.data?.pixels?.width;
  return Number.isFinite(aspect) && aspect >= .1 && aspect <= 10 ? aspect : undefined;
};
const active = run => ['running', 'queued'].includes(run?.status);
// Earliest first; equal times by ID, so every replica orders runs the same way.
const runKey = run => String(run.createdAt || run.startedAt || '');
const runOrder = (a, b) => runKey(a) < runKey(b) ? -1 : runKey(a) > runKey(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Every result a run will make, in order: a site generator makes its variants, an upscale or 3D node one image or model
 * per connected image, a describe node one text, Codex its chosen count (or one image at a time without one). Each slot
 * carries the shape it is expected to have.
 */
export function expectedOutputs(graph, run, prompt = graph.nodes.find(node => node.id === run.nodeId)) {
  const task = run.task || prompt?.data?.task, describe = task === 'describe', model3d = task === model3dTask, upscale = task === 'upscale' || model3d, outputIds = run.outputIds || [];
  let connected;
  const sources = () => connected ||= [...new Set(graph.edges.filter(edge => edge.target === run.nodeId).map(edge => edge.source))]
    .map(id => graph.nodes.find(node => node.id === id)).filter(node => node?.type === 'image');
  const count = describe ? 1 : upscale ? run.images?.length || run.snapshot?.filter(node => node.type === 'image').length || sources().length || 1
    : isSiteGenerator(run.provider) ? run.variants || 1 : Math.max(run.variants || 1, codexImageActive(run) ? outputIds.length + 1 : 1);
  const target = run.target || prompt, inputs = run.snapshot ? run.snapshot.filter(node => node.type === 'image') : sources();
  // A shape the run asked for and its generator uses (run.settings, written when it started) is the shape it will have.
  const chosen = ratioAspect(run.settings?.applied?.aspectRatio);
  return Array.from({ length: count }, (_, slot) => ({ type: describe ? 'text' : model3d ? 'model' : 'image',
    aspect: model3d ? 1 : upscale ? knownAspect(inputs[slot]) || 1 : chosen || knownAspect(target) || knownAspect(inputs.length === 1 ? inputs[0] : null) || 1 }));
}

// A prompt's text and Inputs row are estimated as the canvas draws them, so a server without browser measurements agrees.
const sizer = edges => {
  const fed = new Set(edges.map(edge => edge.target));
  return node => node.type === 'text' && !node.data?.collapsed ? textNodeSize(node, fed.has(node.id) || !!node.data?.template?.assets?.length) : nodeSize(node);
};
const cardBox = (node, measure) => { const caption = captionHeight(node), { width, height } = measure(node); return { x: node.position.x, y: node.position.y - caption, width, height: height + caption }; };
const cardSize = (node, measure) => ({ ...measure(node), caption: captionHeight(node) });
// A description fills its card to the text cap, so it is expected at that size, fed by its describe node.
const descriptionSize = textNodeSize({ type: 'text', data: { text: 'x'.repeat(maxDescription) } }, true);
const slotSize = (spec, measure) => spec.type === 'text' ? { ...descriptionSize, caption: 0 } : cardSize({ type: spec.type, position: { x: 0, y: 0 }, data: { aspect: spec.aspect } }, measure);
const padded = box => ({ x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad });
const unpadded = box => ({ ...box, x: box.x + pad, y: box.y + pad, width: box.width - 2 * pad, height: box.height - 2 * pad });
const hits = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
// A prompt someone wrote, not a run's result: results never jump past one, which would make them look like its own.
const writtenPrompt = node => node?.type === 'text' && !node.data?.runId;

/**
 * What results must keep clear of on one page: what is drawn there, 24px around. Arrows may be covered, and stamps
 * attached to a card move with it; a folded group is its card, its hidden members nothing; an expanded group its frame.
 * `prompts` are the written prompts as drawn (a folded group holding one is its card), which mark where rows begin.
 */
function placementBoard(graph, page) {
  const scoped = pageContent(graph, page), nodes = scoped.nodes.filter(node => node.type !== 'pending'), byId = new Map(nodes.map(node => [node.id, node]));
  const measure = sizer(scoped.edges), grouped = new Set(), hidden = new Map(), obstacles = [], prompts = [];
  for (const group of scoped.groups) for (const id of group.nodeIds) { grouped.add(id); if (group.collapsed) hidden.set(id, group); }
  for (const node of nodes) {
    if (writtenPrompt(node) && !hidden.has(node.id)) prompts.push({ ...padded(cardBox(node, measure)), ids: [node.id] });
    if (grouped.has(node.id) || node.type === 'arrow' || (node.type === 'stamp' && canAttachStamp(byId.get(node.data?.attachedTo)))) continue;
    obstacles.push({ ...padded(cardBox(node, measure)), ids: [node.id], walls: writtenPrompt(node) ? [node.id] : [] });
  }
  for (const group of scoped.groups) {
    const members = group.nodeIds.filter(id => byId.has(id));
    if (!members.length) continue;
    const box = padded((group.collapsed ? frameBox : groupBounds)(group, nodes, byId, measure)), walls = members.filter(id => writtenPrompt(byId.get(id)));
    obstacles.push({ ...box, ids: members, walls });
    if (group.collapsed && walls.length) prompts.push({ ...box, ids: walls });
  }
  return { nodes, byId, measure, hidden, obstacles, prompts };
}

// Right of the prompt as it is drawn now (folded, or as the card of a folded group holding it), at its top. A prompt
// that is gone leaves where a local run saw it at submission, or the results of its earlier runs.
function runAnchor(board, graph, run, runs, page) {
  const beside = box => ({ x: box.x + box.width + outputGap, y: box.y, left: box.x }), prompt = board.byId.get(run.nodeId);
  if (prompt) {
    const group = board.hidden.get(prompt.id);
    return beside(group ? frameBox(group, board.nodes, board.byId, board.measure) : cardBox(prompt, board.measure));
  }
  if (run.target?.position && pageResolver(boardPages(graph))(run.target.page) === page) return beside(cardBox(run.target, board.measure));
  const earlier = runs.filter(other => other.nodeId === run.nodeId && other.id !== run.id).flatMap(other => other.outputIds || []).map(id => board.byId.get(id)).filter(Boolean);
  if (earlier.length) { const { x, y } = earlier.reduce((a, b) => b.position.x < a.position.x || (b.position.x === a.position.x && b.position.y < a.position.y) ? b : a).position; return { x, y, left: x }; }
}

/**
 * The first result of a run, with room kept for the whole run (and the frame its group gets once it has two): level
 * with the prompt as near as possible to the right, past anything but another prompt and within three columns; else
 * under what is beside it, as far down as three columns reach and above the next prompt written below; else the
 * nearest free spot in the prompt's row; a run too tall for its row stays level further right; failing all that, the
 * nearest free spot. Never left of the anchor or above it.
 * `under`: the prompt already has results from runs started before this one (several model buttons, or Generate again),
 * so this run goes in the column beside the prompt, under them, as far down as it takes, instead of along the row
 * where each new run would land further away.
 */
// The part of the board the person who started a run could see then (`run.view`, written by their page), or undefined
// when the run has none (an agent's, or one from an older page) or it is not a sensible rectangle.
export function startView(value) {
  const ok = number => Number.isFinite(number) && Math.abs(number) <= 1e7;
  if (!value || typeof value !== 'object' || ![value.x, value.y, value.width, value.height].every(ok) || value.width < 50 || value.height < 50) return undefined;
  return { x: Math.round(value.x), y: Math.round(value.y), width: Math.round(value.width), height: Math.round(value.height) };
}

function placeBlock(anchor, slots, lists, promptId, prompts = [], under = false, view, fresh = () => false) {
  const framed = slots.length > 1, side = framed ? frameSide : 0, top = slots[0].caption + (framed ? frameHeader : 0);
  const stack = slots.reduce((sum, slot, index) => sum + slot.height + (index ? stackGap + slot.caption : 0), 0);
  const block = { x: -side, y: -top, width: Math.max(...slots.map(slot => slot.width)) + 2 * side, height: top + stack + (framed ? frameSide : 0) };
  const at = (x, y) => ({ x: x + block.x, y: y + block.y, width: block.width, height: block.height }), start = at(anchor.x, anchor.y);
  // Started from the canvas, the first result stays where its starter could see it: right beside the prompt when that is
  // free and on screen; else the nearest free spot (any side) where it is wholly on screen; else the nearest spot that
  // covers only earlier results, never a prompt (its buttons stay clickable), another run's waiting slot or a card that
  // arrived after this run started (a slot this run's placeholder kept clear of, then filled), with at least
  // `peek` of it on screen; failing even that, beside the prompt as far onto the screen as it goes. The person drags it
  // where they want. Later results of the run follow under it.
  if (view) {
    // Only the first result needs the free spot: the rest of a big run hangs under it until the run folds into its card.
    // Never left of the prompt or above it, so a result reads as coming out of it: to its right, or under it.
    const first = top + slots[0].height, clamp = (value, low, high) => Math.max(low, Math.min(high, value)), peek = 120;
    const card = { x: block.x, y: block.y, width: block.width, height: first + (framed ? frameSide : 0) }, own = { x: start.x, y: start.y, width: card.width, height: card.height };
    const left = Math.max(view.x, anchor.left ?? start.x), high = Math.max(view.y, anchor.y + block.y);
    const limits = { minX: left, maxX: Math.max(left, view.x + view.width - card.width), minY: high, maxY: Math.max(high, view.y + view.height - first) };
    const partly = { minX: anchor.left ?? start.x, maxX: Math.max(anchor.left ?? start.x, view.x + view.width - Math.min(peek, card.width)), minY: high, maxY: Math.max(high, view.y + view.height - Math.min(peek, first)) };
    const near = box => box.x < view.x + view.width + card.width && box.x + box.width > view.x - card.width && box.y < view.y + view.height + card.height && box.y + box.height > view.y - card.height;
    const [obstacles, reserved = []] = lists, boxes = lists.flat().filter(near);
    if (own.x >= limits.minX && own.x <= limits.maxX && own.y >= limits.minY && own.y <= limits.maxY && !boxes.some(box => hits(own, box))) return { x: anchor.x, y: anchor.y };
    const spot = nearestFreePosition(own, card, boxes, limits) || leastCovered();
    return spot ? { x: spot.x - block.x, y: spot.y - block.y } : { x: clamp(start.x, limits.minX, limits.maxX) - block.x, y: clamp(start.y, limits.minY, limits.maxY) - block.y };
    // No free spot on screen: the spot to the prompt's right or below it that covers the least of the earlier cards and
    // keeps the most of itself on screen, so the result sits in the emptiest part of the view instead of exactly on an old
    // one. Prompts, other runs' waiting slots and the results that have since filled them are never covered; those count at
    // their own size, so a second model still fits beside the first and lands where its placeholder showed.
    function leastCovered() {
      const hard = [...obstacles.filter(box => box.walls.length), ...[...obstacles.filter(box => !box.walls.length && fresh(box)), ...reserved].map(unpadded)].filter(near);
      const soft = obstacles.filter(box => !box.walls.length && !fresh(box)).map(unpadded).filter(near);
      const area = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      // About 60 steps a side whatever the zoom, so a zoomed-out screen costs no more to search than a close one.
      const stepX = Math.max(16, (partly.maxX - partly.minX) / 60), stepY = Math.max(16, (partly.maxY - partly.minY) / 60);
      let best = null;
      for (let x = partly.minX; x <= partly.maxX; x += stepX) for (let y = partly.minY; y <= partly.maxY; y += stepY) {
        const rect = { x, y, width: card.width, height: card.height };
        if (hard.some(box => hits(rect, box))) continue;
        const score = soft.reduce((sum, box) => sum + area(rect, box), 0) + card.width * card.height - area(rect, view), distance = Math.hypot(x - own.x, y - own.y);
        if (!best || score < best.score - 1 || (score <= best.score + 1 && distance < best.distance)) best = { x, y, score, distance };
      }
      return best && { x: Math.round(best.x), y: Math.round(best.y) };
    }
  }
  const reach = reachColumns * (block.width + 2 * pad);
  // Boards can hold thousands of cards; only those right of and below the anchor can be in the way.
  const near = lists.flatMap(list => list.filter(box => box.x + box.width > start.x && box.y + box.height > start.y));
  const wall = box => box.walls.some(id => id !== promptId);
  const band = near.filter(box => box.y < start.y + start.height && box.y + box.height > start.y);
  const stop = Math.min(...band.filter(wall).map(box => box.x + box.width));
  const xs = [...new Set([anchor.x, ...band.map(box => box.x + box.width - block.x)])].filter(x => x >= anchor.x && x + block.x < stop).sort((a, b) => a - b);
  const level = list => { for (const x of list) { const rect = at(x, anchor.y); if (!band.some(box => hits(rect, box))) return { x, y: anchor.y }; } };
  const beside = level(xs.filter(x => x <= anchor.x + (under ? 0 : reach)));
  if (beside) return beside;
  // A prompt written below this one, between it and its results, starts the next row: results that go under their
  // prompt's earlier ones stay above it, or they would look like that prompt's.
  const left = anchor.left ?? start.x;
  const floor = Math.min(...prompts.filter(box => !box.ids.includes(promptId) && box.y + pad > anchor.y && box.x < start.x + start.width && box.x + box.width > left).map(box => box.y));
  const column = near.filter(box => box.x < start.x + start.width && box.x + box.width > start.x);
  for (let y = anchor.y; under || y - anchor.y <= reach;) {
    const rect = at(anchor.x, y);
    if (rect.y + rect.height > floor) break;
    const blocking = column.filter(box => hits(rect, box));
    if (!blocking.length) return { x: anchor.x, y };
    if (blocking.some(wall)) break;
    y = Math.max(...blocking.map(box => box.y + box.height)) - block.y;
  }
  const free = limits => { const spot = nearestFreePosition(start, block, near, { minX: start.x, minY: start.y, ...limits }); return spot && { x: spot.x - block.x, y: spot.y - block.y }; };
  return free(Number.isFinite(floor) ? { maxY: floor - block.height } : {}) || level(xs.filter(x => x > anchor.x + reach)) || free({}) || { x: anchor.x, y: anchor.y };
}

// A later result goes under the run's earlier ones in their column, and under anything that has come in the way since.
// A run started from the screen keeps its column whole instead (`together`): its images stay one group, over whatever is
// below, until the run ends and folds them into one card.
function placeNext(previous, slot, lists, own, together = false) {
  const x = previous[0].x, block = { x: -frameSide, y: -slot.caption, width: slot.width + 2 * frameSide, height: slot.caption + slot.height + frameSide };
  let y = Math.max(...previous.map(item => item.bottom)) + stackGap + slot.caption;
  if (together) return { x, y };
  const left = x + block.x, column = lists.flatMap(list => list.filter(box => !box.ids.every(id => own.has(id)) && box.x < left + block.width && box.x + box.width > left && box.y + box.height > y + block.y));
  for (;;) {
    const rect = { x: left, y: y + block.y, width: block.width, height: block.height }, blocking = column.filter(box => hits(rect, box));
    if (!blocking.length) return { x, y };
    y = Math.max(...blocking.map(box => box.y + box.height)) - block.y;
  }
}

const placedCard = (position, size) => ({ x: position.x, y: position.y, top: position.y - size.caption, bottom: position.y + size.height, right: position.x + size.width });
const outputCards = (board, ids) => [...ids].map(id => board.byId.get(id)).filter(Boolean).map(node => placedCard(node.position, cardSize(node, board.measure)));

/**
 * Runs still working on a page hold the rest of their slots, the earliest run first, so runs started together never
 * interleave and every replica agrees. Plans each such run before `until` (all of them without it): its remaining
 * slots, and the room they keep from later runs.
 */
// Whether a run of this prompt started earlier has results here or is still making them: then this run stacks under
// them. Only earlier runs count, so a slot shown for a run never moves when a later one lands.
// Cards that arrived after `run` started: placement never covers them, so a slot shown for the run while another was still
// working stays where it was once that other run's results land.
const arrivedSince = (board, run) => {
  const since = run.createdAt || run.startedAt;
  return box => typeof since === 'string' && box.ids.some(id => String(board.byId.get(id)?.data?.createdAt || '') >= since);
};
// The board's own run records count too: a caller may pass only the runs still working.
const stacked = (board, run, runs, graph) => [...new Map([...(graph.runs || []), ...runs].map(other => [other.id, other])).values()]
  .some(other => other.nodeId === run.nodeId && other.id !== run.id && runOrder(other, run) < 0 && (active(other) || (other.outputIds || []).some(id => board.byId.has(id))));

function planRuns(graph, board, runs, page, until) {
  const reserved = [], plans = new Map();
  const order = runs.filter(run => active(run) && run.id !== until?.id && board.byId.has(run.nodeId) && runOutputPage(graph, run) === page && (!until || runOrder(run, until) < 0)).sort(runOrder);
  for (const run of order) {
    const expected = expectedOutputs(graph, run, board.byId.get(run.nodeId)), sizes = expected.map(spec => slotSize(spec, board.measure));
    const own = new Set(run.outputIds || []), cards = outputCards(board, own), slots = [], lists = [board.obstacles, reserved];
    for (let slot = run.outputIds?.length || 0; slot < expected.length; slot++) {
      const position = cards.length ? placeNext(cards, sizes[slot], lists, own, !!startView(run.view)) : placeBlock(runAnchor(board, graph, run, runs, page), sizes.slice(slot), lists, run.nodeId, board.prompts, stacked(board, run, runs, graph), startView(run.view), arrivedSince(board, run));
      const id = `${run.id}-pending-${slot}`;
      slots.push({ id, position, size: { width: sizes[slot].width, height: sizes[slot].height }, ...expected[slot] });
      cards.push(placedCard(position, sizes[slot])); own.add(id);
    }
    plans.set(run.id, slots);
    if (!slots.length) continue;
    const x = Math.min(...cards.map(card => card.x)), y = Math.min(...cards.map(card => card.top)), right = Math.max(...cards.map(card => card.right)), bottom = Math.max(...cards.map(card => card.bottom));
    const room = cards.length > 1 ? { x: x - frameSide, y: y - frameHeader, width: right - x + 2 * frameSide, height: bottom - y + frameHeader + frameSide } : { x, y, width: right - x, height: bottom - y };
    reserved.push({ ...padded(room), ids: [...own], walls: [] });
  }
  return { reserved, plans };
}

// Where each working run's remaining results will appear on `page`, by run ID: slot ID, position, size, type and aspect.
export function plannedOutputs(graph, runs, page) {
  if (!runs.some(active)) return new Map();
  return planRuns(graph, placementBoard(graph, page), runs, page).plans;
}

/**
 * Places one new result of `run` on the run's page, above everything else there. `runs` are the board's runs: those
 * started earlier and still working keep their slots.
 */
export function positionRunOutput(node, graph, run, runs = graph.runs || []) {
  const page = runOutputPage(graph, run);
  if (page === defaultPageId) delete node.page; else node.page = page;
  // Each new result appears above everything already on the board.
  node.z = nextLayer(graph.nodes);
  const board = placementBoard(graph, page), { reserved } = planRuns(graph, board, runs, page, run), lists = [board.obstacles, reserved];
  const own = new Set(run.outputIds || []), cards = outputCards(board, own), size = cardSize(node, board.measure);
  if (cards.length) { node.position = placeNext(cards, size, lists, own, !!startView(run.view)); return; }
  const [expected, ...rest] = expectedOutputs(graph, run).slice(run.outputIds?.length || 0).map(spec => slotSize(spec, board.measure));
  // A description keeps the room its placeholder showed, so it lands there however long it turns out.
  const first = node.type === 'text' && expected?.height > size.height ? { ...size, height: expected.height } : size;
  node.position = placeBlock(runAnchor(board, graph, run, runs, page) || node.position, [first, ...rest], lists, run.nodeId, board.prompts, stacked(board, run, runs, graph), startView(run.view), arrivedSince(board, run));
}
