import { generators } from '../graph.mjs';

export const usesNano = data => data?.generator === generators.nanoBanana;
const dollars = value => `$${value.toFixed(2).replace(/\.00$/, '')}`;

// What Nano Banana can do for this person, from GET /api/nano. Until that answers, Generate is left to the server.
export function nanoState(status) {
  if (!status) return { selectable: true, ready: true, note: 'Uses the site’s Gemini key', budget: '' };
  if (!status.configured) return { selectable: false, ready: false, note: 'Nano Banana isn’t set up on this site', budget: '' };
  if (!status.allowed) return { selectable: false, ready: false, note: 'Not available for your account', budget: '' };
  const left = Math.max(0, status.dailyImages - status.usedToday), budget = `Team: ${dollars(status.teamSpentUsd)} of ${dollars(status.monthlyUsd)} this month`;
  if (!left) return { selectable: true, ready: false, note: `Daily limit reached (${Math.min(status.usedToday, status.dailyImages)}/${status.dailyImages})`, budget };
  if (status.teamSpentUsd >= status.monthlyUsd) return { selectable: true, ready: false, note: 'Team budget for this month is used up', budget };
  return { selectable: true, ready: true, note: `${left} of ${status.dailyImages} left today`, budget };
}
