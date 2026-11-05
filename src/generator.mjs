import { generators } from '../graph.mjs';
import { t } from './i18n.mjs';

export const usesNano = data => data?.generator === generators.nanoBanana;
const dollars = value => `$${value.toFixed(2).replace(/\.00$/, '')}`;

// What Nano Banana can do for this person, from GET /api/nano. Until that answers, Generate is left to the server.
export function nanoState(status) {
  if (!status) return { selectable: true, ready: true, note: t('Uses the site’s Gemini key'), budget: '' };
  if (!status.configured) return { selectable: false, ready: false, note: t('Nano Banana isn’t set up on this site'), budget: '' };
  if (!status.allowed) return { selectable: false, ready: false, note: t('Not available for your account. Ask a site admin for access.'), budget: '' };
  const left = Math.max(0, status.dailyImages - status.usedToday), budget = t('Team: {spent} of {limit} this month', { spent: dollars(status.teamSpentUsd), limit: dollars(status.monthlyUsd) });
  if (!left) return { selectable: true, ready: false, note: t('Daily limit reached ({used}/{limit})', { used: Math.min(status.usedToday, status.dailyImages), limit: status.dailyImages }), budget };
  if (status.teamSpentUsd >= status.monthlyUsd) return { selectable: true, ready: false, note: t('Team budget for this month is used up'), budget };
  return { selectable: true, ready: true, note: t('{left} of {limit} left today', { left, limit: status.dailyImages }), budget };
}
