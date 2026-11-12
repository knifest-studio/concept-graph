// Mounted cards only. This registry never enters the graph or any persistence path.
export const shownPlaceholders = new Map();
export function matchingPlaceholder(slots, runId, position, now) {
  return [...slots.values()].find(slot => !slot.describe && slot.runId === runId
    && slot.x === position.x && slot.y === position.y && (slot.unmountedAt === undefined || now - slot.unmountedAt < 1000));
}
export function prunePlaceholders(slots, now) {
  for (const [id, slot] of slots) if (slot.unmountedAt !== undefined && now - slot.unmountedAt >= 1000) slots.delete(id);
}
