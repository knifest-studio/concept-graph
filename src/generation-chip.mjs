import { t } from './i18n.mjs';

export const usageRemaining = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? Number((100 - value).toFixed(1)) : null;

export function generationChip({ readiness, status, helperNeeded, outdated, remaining = null, desktopMode }) {
  const ready = helperNeeded ? readiness.key === 'ready' : status.connected && status.signedIn && status.imageGeneration;
  if (outdated) return { label: t('Update helper'), tone: 'attention' };
  if (!ready) return { label: helperNeeded ? readiness.label : desktopMode && status.connected && !status.signedIn ? t('Sign in with ChatGPT') : t('Check Codex'), tone: 'attention' };
  const delegated = readiness.delegate != null;
  return { label: delegated ? readiness.label : remaining !== null ? t('Codex · {percent}% left', { percent: remaining }) : t('Codex · Ready'), tone: remaining !== null && remaining <= 10 && !delegated ? 'low' : 'neutral' };
}
