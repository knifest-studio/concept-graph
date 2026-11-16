import { byConnection, imageNumbers } from '../graph.mjs';

// While a prompt is selected, each connection from one of its images shows that image's number (graph.mjs imageNumbers),
// the number its prompt text gives generators. A mass selection shows none: it is for moving things, not reading.
export const maxNumberedPrompts = 24;

// 1, 2, 3, 5 → “1–3, 5”.
export function numberList(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b), parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let end = i;
    while (sorted[end + 1] === sorted[end] + 1) end++;
    parts.push(end - i >= 2 ? `${sorted[i]}–${sorted[end]}` : end > i ? `${sorted[i]}, ${sorted[end]}` : `${sorted[i]}`);
    i = end;
  }
  return parts.join(', ');
}

// Connection ID → its label, for the connections into the given prompts. `lineOf` says which drawn line a connection is
// (null when it is not drawn): a folded group draws its images' connections as one line per port, which then lists all
// of their numbers.
export function connectionNumbers(edges, promptIds, isImage, lineOf = edge => edge.source) {
  const labels = new Map(), wanted = new Set(promptIds);
  if (!wanted.size || wanted.size > maxNumberedPrompts) return labels;
  const into = new Map();
  for (const edge of edges) if (wanted.has(edge.target)) { if (!into.has(edge.target)) into.set(edge.target, []); into.get(edge.target).push(edge); }
  for (const [prompt, list] of into) {
    const numbers = imageNumbers(list, prompt, isImage), lines = new Map();
    if (!numbers.size) continue;
    for (const edge of list.sort(byConnection)) {
      const number = numbers.get(edge.source), line = number && lineOf(edge);
      if (!number || line == null) continue;
      if (!lines.has(line)) lines.set(line, { id: edge.id, numbers: [] });
      lines.get(line).numbers.push(number);
    }
    for (const { id, numbers: list } of lines.values()) labels.set(id, numberList(list));
  }
  return labels;
}

// The cubic Bézier React Flow draws for a default connection (getBezierPath: “M x,y C x,y x,y x,y”), from its path.
export function curveOf(path) {
  const values = String(path).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number);
  return values?.length === 8 && values.every(Number.isFinite) ? values : null;
}
export function curvePoint([x0, y0, x1, y1, x2, y2, x3, y3], t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * x0 + b * x1 + c * x2 + d * x3, y: a * y0 + b * y1 + c * y2 + d * y3 };
}

const margin = 18, steps = 96, choices = 48;
// Samples crowd towards both ends, where a line whose image is far off screen is in view: in t, 1 − cos spacing.
const samples = Array.from({ length: steps + 1 }, (_, i) => (1 - Math.cos(Math.PI * i / steps)) / 2);
// Whether a point of a line is in view, at screen position (left, top): inside the canvas, clear of the panels over it
// and of the cards its line runs under (lines are drawn below cards), and away from its two ends, where it meets a card.
function clear(left, top, { width, height, blocked = [], cards = [] }, ends) {
  return left >= margin && left <= width - margin && top >= margin && top <= height - margin
    && !blocked.some(box => left >= box.left - margin && left <= box.right + margin && top >= box.top - margin && top <= box.bottom + margin)
    && !cards.some(box => left >= box.left - 6 && left <= box.right + 6 && top >= box.top - 6 && top <= box.bottom + 6)
    && ends.every(end => Math.hypot(end.left - left, end.top - top) >= 20);
}
// The longest stretch of the line that is in view, as [from, to] in t, or null. `transform` is React Flow's [x, y, zoom];
// `area` holds the canvas size and, in canvas pixels, the panels' and cards' boxes.
function visibleStretch(curve, [x, y, zoom], area) {
  const screen = t => { const point = curvePoint(curve, t); return { left: point.x * zoom + x, top: point.y * zoom + y }; };
  const ends = [screen(0), screen(1)], shown = t => { const point = screen(t); return clear(point.left, point.top, area, ends); };
  let best = null, start = null;
  for (let i = 0; i <= steps + 1; i++) {
    if (i <= steps && shown(samples[i])) { if (start === null) start = i; continue; }
    if (start !== null && (!best || samples[i - 1] - samples[start] > samples[best[1]] - samples[best[0]])) best = [start, i - 1];
    start = null;
  }
  if (!best) return null;
  // The stretch reaches past its outer samples, up to the point where the line leaves the view.
  const [first, last] = best, edge = (inside, outside) => { for (let k = 0; k < 10; k++) { const middle = (inside + outside) / 2; if (shown(middle)) inside = middle; else outside = middle; } return inside; };
  return [first > 0 ? edge(samples[first], samples[first - 1]) : 0, last < steps ? edge(samples[last], samples[last + 1]) : 1];
}
// Where a connection's number goes, in flow coordinates: the middle of its line's visible stretch, so the number stays
// in view while its image is far off screen.
export function labelPoint(curve, transform, area) {
  const stretch = visibleStretch(curve, transform, area);
  return stretch && curvePoint(curve, (stretch[0] + stretch[1]) / 2);
}
// A number's badge on screen: 22 px high, wider for “1–3, 5” (src/style.css .connection-number).
const badgeWidth = label => Math.max(22, 12 + label.length * 7.5);
// Every number at once, so none covers another. Each number keeps to its own line's visible stretch, as near the image's
// end of it as it can while clear of the numbers placed before it (lower numbers first). `lines` are { id, label, curve, color };
// `area.cards` are the cards' boxes in flow coordinates.
export function placeNumbers(lines, transform, { cards = [], ...area }) {
  const [x, y, zoom] = transform, placed = [], first = label => parseInt(label, 10) || 0;
  const onScreen = cards.map(box => ({ left: box.x * zoom + x, top: box.y * zoom + y, right: (box.x + box.width) * zoom + x, bottom: (box.y + box.height) * zoom + y }))
    .filter(box => box.right >= 0 && box.left <= area.width && box.bottom >= 0 && box.top <= area.height);
  for (const line of [...lines].sort((a, b) => first(a.label) - first(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const stretch = line.curve && visibleStretch(line.curve, transform, { ...area, cards: onScreen });
    if (!stretch) continue;
    const width = badgeWidth(line.label), at = index => {
      const point = curvePoint(line.curve, stretch[0] + (stretch[1] - stretch[0]) * index / choices);
      return { ...point, left: point.x * zoom + x, top: point.y * zoom + y };
    };
    // At the image's end of what is in view: beside the image, or where its line comes in at the canvas edge when the image
    // is off screen. Lines into one prompt fan out there and meet at the prompt.
    const start = 3;
    let chosen = null;
    for (let offset = 0; !chosen && offset <= choices; offset++) {
      for (const index of offset ? [start - offset, start + offset] : [start]) {
        if (index < 0 || index > choices) continue;
        const point = at(index);
        if (placed.every(other => Math.abs(other.left - point.left) >= (other.width + width) / 2 + 4 || Math.abs(other.top - point.top) >= 26)) { chosen = point; break; }
      }
    }
    // With no free place on its line, the number still shows at the middle rather than not at all.
    chosen ||= at(start);
    placed.push({ id: line.id, label: line.label, color: line.color, x: chosen.x, y: chosen.y, left: chosen.left, top: chosen.top, width });
  }
  return placed.map(({ id, label, color, x: px, y: py }) => ({ id, label, color, x: px, y: py }));
}
