import { generators, isSiteGenerator, upscaleTask } from '../graph.mjs';
import { t } from './i18n.mjs';

// Upscaling always runs on the site, whatever the node's generator says.
export const usesSiteGenerator = data => isSiteGenerator(data?.generator) || data?.task === upscaleTask;
const dollars = value => `$${value.toFixed(2).replace(/\.00$/, '')}`;

// What a site provider can do for this person, from GET /api/nano. Until it answers, Generate is left to the server.
export function nanoState(status, generator = generators.nanoBanana) {
  const fal = status?.fal !== false, gpt = generator === generators.gptImage;
  if (!status) return { selectable: true, ready: true, note: gpt ? t('Uses the site’s OpenAI key') : t('Uses the site’s Gemini key'), budget: '', fal };
  if (!status.configured) return { selectable: false, ready: false, note: gpt ? t('GPT Image isn’t set up on this site') : t('Nano Banana isn’t set up on this site'), budget: '', fal };
  if (!status.allowed) return { selectable: false, ready: false, note: t('Not available for your account. Ask a site admin for access.'), budget: '', fal };
  const left = Math.max(0, status.dailyImages - status.usedToday), budget = t('Team: {spent} of {limit} this month', { spent: dollars(status.teamSpentUsd), limit: dollars(status.monthlyUsd) });
  if (!left) return { selectable: true, ready: false, note: t('Daily limit reached ({used}/{limit})', { used: Math.min(status.usedToday, status.dailyImages), limit: status.dailyImages }), budget, fal };
  if (status.teamSpentUsd >= status.monthlyUsd) return { selectable: true, ready: false, note: t('Team budget for this month is used up'), budget, fal };
  return { selectable: true, ready: true, note: t('{left} of {limit} left today', { left, limit: status.dailyImages }), budget, fal };
}
