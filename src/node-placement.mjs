// Free positions lie at the wanted coordinates or an obstacle's edge. Search columns nearest first.
export function nearestFreePosition(wanted, size, boxes, limits = {}) {
  const { minX = -Infinity, maxX = Infinity, minY = -Infinity, maxY = Infinity } = limits;
  if (minX > maxX || minY > maxY) return null;
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const xs = [...new Set([wanted.x, minX, maxX, ...boxes.flatMap(box => [box.x - size.width, box.x + box.width])]
    .filter(Number.isFinite).map(x => clamp(x, minX, maxX)))].sort((a, b) => Math.abs(a - wanted.x) - Math.abs(b - wanted.x) || b - a);
  let best = null, distance = Infinity;
  for (const x of xs) {
    const dx = x - wanted.x;
    if (dx * dx > distance) break;
    const intervals = boxes.filter(box => x < box.x + box.width && x + size.width > box.x)
      .map(box => [box.y - size.height, box.y + box.height]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const interval of intervals) {
      const last = merged.at(-1);
      if (last && interval[0] < last[1]) last[1] = Math.max(last[1], interval[1]);
      else merged.push([...interval]);
    }
    let y = clamp(wanted.y, minY, maxY);
    const blocked = merged.find(([top, bottom]) => y > top && y < bottom);
    if (blocked) {
      const options = blocked.filter(y => y >= minY && y <= maxY).sort((a, b) => Math.abs(a - wanted.y) - Math.abs(b - wanted.y) || b - a);
      if (!options.length) continue;
      y = options[0];
    }
    const score = dx * dx + (y - wanted.y) ** 2;
    if (score < distance || (score === distance && Math.abs(y - wanted.y) < Math.abs(best.y - wanted.y))) {
      best = { x, y }; distance = score;
    }
  }
  return best;
}

export function boundingBox(boxes) {
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x, height: Math.max(...boxes.map(box => box.y + box.height)) - y };
}

// Keep zoom and move only the axes that hide the new card. Include its source when both fit.
export function revealViewport(box, viewport, bounds, source) {
  const { zoom } = viewport, left = 30, right = bounds.width - 30, top = 60, bottom = bounds.height - 90;
  const visible = box => box.x * zoom + viewport.x >= left && box.y * zoom + viewport.y >= top
    && (box.x + box.width) * zoom + viewport.x <= right && (box.y + box.height) * zoom + viewport.y <= bottom;
  if (visible(box)) return null;
  if (source) {
    const together = boundingBox([box, source]);
    if (together.width * zoom <= right - left && together.height * zoom <= bottom - top) box = together;
  }
  const axis = (start, size, offset, low, high) => size * zoom > high - low ? low - start * zoom
    : Math.max(low - start * zoom, Math.min(high - (start + size) * zoom, offset));
  return { x: axis(box.x, box.width, viewport.x, left, right), y: axis(box.y, box.height, viewport.y, top, bottom), zoom };
}
