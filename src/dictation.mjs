import { t } from './i18n.mjs';

const languages = { uk: 'uk-UA', ru: 'ru-RU', en: 'en-US' };
const browserLanguage = locale => languages[locale?.toLowerCase().split('-')[0]] || 'en-US';
export const dictationPreferenceKey = 'concept-graph-dictation-preference';
export function readDictationPreference(storage) {
  try { const value = storage.getItem(dictationPreferenceKey); return Object.values(languages).includes(value) ? value : ''; } catch { return ''; }
}

export function typedLanguage(text, previous = '', locale = '') {
  for (const letter of text || '') {
    if (/[іїєґ]/i.test(letter)) previous = 'uk-UA';
    else if (/[ыэъё]/i.test(letter)) previous = 'ru-RU';
    else if (/[a-z]/i.test(letter)) previous = 'en-US';
    else if (/[а-я]/i.test(letter) && !['uk-UA', 'ru-RU'].includes(previous)) {
      previous = ['uk-UA', 'ru-RU'].includes(browserLanguage(locale)) ? browserLanguage(locale) : '';
    }
  }
  return previous;
}

export function layoutLanguage(layout) {
  const letters = [...layout?.values() || []].join('');
  if (/[іїєґ]/i.test(letters)) return 'uk-UA';
  if (/[ыэъё]/i.test(letters)) return 'ru-RU';
  if (/^[a-z]$/i.test(layout?.get('KeyQ') || '')) return 'en-US';
  return '';
}

export function dictationLanguage(layout, typed = '', locale = '', text = '', preferred = '') {
  if (Object.values(languages).includes(preferred)) return preferred;
  const mapped = layoutLanguage(layout);
  // Chrome's Keyboard Map usually reports the ASCII layout even while Cyrillic is active,
  // so trust it only for Cyrillic; then the prompt's own language, then the last language used.
  return (mapped !== 'en-US' && mapped) || typedLanguage(text, '', locale) || typed || mapped || browserLanguage(locale);
}

export const dictationLanguages = ['uk-UA', 'en-US', 'ru-RU'];
export const nextDictationLanguage = lang => dictationLanguages[(dictationLanguages.indexOf(lang) + 1) % dictationLanguages.length];

export function insertDictation(text, speech, start = text.length, end = start) {
  speech = speech.trim();
  start = Math.max(0, Math.min(start, text.length));
  end = Math.max(start, Math.min(end, text.length));
  if (!speech) return { text, caret: start };
  const before = text.slice(0, start), after = text.slice(end);
  const left = before && !/[\s([{]$/.test(before) && !/^[,.;:!?)}\]]/.test(speech) ? ' ' : '';
  const right = after && !/^\s|^[,.;:!?)}\]]/.test(after) && !/[([{]$/.test(speech) ? ' ' : '';
  return { text: before + left + speech + right + after, caret: before.length + left.length + speech.length + right.length };
}

export function dictationResults(results, committed = 0) {
  const final = [], interim = [];
  for (let i = committed; i < results.length; i++) {
    const result = results[i], text = result[0]?.transcript?.trim();
    if (text) (result.isFinal ? final : interim).push(text);
    if (result.isFinal) committed = i + 1;
  }
  return { final: final.join(' '), interim: interim.join(' '), committed };
}

export function dictationError(code) {
  return t(({ 'not-allowed': 'Microphone permission denied. Allow it in browser settings.', 'service-not-allowed': 'Speech recognition is blocked by your browser.', 'audio-capture': 'No microphone available.', 'no-speech': 'No speech heard. Try again.', network: 'Speech service unavailable. Check your connection.', 'language-not-supported': 'This speech language is unavailable in your browser.', aborted: '' })[code] ?? 'Could not start dictation. Try again.');
}
