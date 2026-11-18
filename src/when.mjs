import { language, t } from './i18n.mjs';

const dayStart = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

// A short "when" for lists that span days (generation history, board chat): today's time alone, yesterday's as
// "Yesterday, 23:38", older ones with the date, and the year once it is not this year. The date is in the app's
// language; the time keeps the browser's clock format, as the rest of the app shows times.
export function shortWhen(value, now = new Date(), locale = language() === 'uk' ? 'uk-UA' : undefined) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), days = Math.round((dayStart(now) - dayStart(date)) / 86400000);
  if (days === 0) return time;
  if (days === 1) return t('Yesterday, {time}', { time });
  const day = date.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return `${day}, ${time}`;
}
