export function popoverPosition(anchor, size, viewport, margin = 12) {
  return {
    left: Math.max(margin, Math.min(anchor.left, viewport.width - size.width - margin)),
    top: Math.max(margin, Math.min(anchor.bottom + 8, viewport.height - size.height - margin)),
  };
}
