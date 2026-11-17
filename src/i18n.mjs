import uk from './locales/uk.mjs';

// Interface languages. English is the source text and the key: a translation is looked up by the English it replaces,
// so anything not translated yet shows in English.
export const languages = Object.freeze({ en: 'English', uk: 'Українська' });
export const languageKey = 'concept-graph-language';
const dictionaries = { uk };

// A saved choice first, then the browser's preferred languages, then English, as most web apps decide.
export function detectLanguage(saved, preferred = []) {
  if (Object.hasOwn(languages, saved)) return saved;
  for (const tag of preferred) {
    const base = String(tag || '').toLowerCase().split('-')[0];
    if (Object.hasOwn(languages, base)) return base;
  }
  return 'en';
}

let current = 'en';
export const language = () => current;
export function setLanguage(value) {
  current = Object.hasOwn(languages, value) ? value : 'en';
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}

const fill = (text, values) => values ? text.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match) : text;
// t('Go to {name}', { name }): the current language's text with the values filled in.
export function t(text, values) {
  if (!values && typeof text === 'string' && text.startsWith('The mask on “')) {
    const match = /^The mask on “(.*)” no longer matches the image\. Paint it again\.$/s.exec(text);
    if (match) return t('The mask on “{name}” no longer matches the image. Paint it again.', { name: match[1] });
  }
  if (!values && typeof text === 'string') {
    let match = /^The 3D generator could not use this image: (.*)$/s.exec(text);
    if (match) return t('The 3D generator could not use this image: {error}', { error: match[1] });
    match = /^The 3D generator failed \((\d+)\)\. Try again\.$/.exec(text);
    if (match) return t('The 3D generator failed ({status}). Try again.', { status: match[1] });
    match = /^(\d+) of (\d+) images failed: (.*)$/s.exec(text);
    if (match) return t('{count} of {total} images failed: {error}', { count: match[1], total: match[2], error: t(match[3]) });
    // Site generator errors with counts; the cheap checks keep the patterns off every other label.
    if (text.includes(' variants failed: ') && (match = /^(\d+) of (\d+) variants failed: (.*)$/s.exec(text))) return t('{count} of {total} variants failed: {error}', { count: match[1], total: match[2], error: t(match[3]) });
    if (text.endsWith(' fewer.')) {
      if ((match = /^(.*) Only (\d+) of (\d+) variants fit; choose fewer\.$/s.exec(text))) return t('{reason} Only {count} of {total} variants fit; choose fewer.', { reason: t(match[1]), count: match[2], total: match[3] });
      if ((match = /^(.*) Only (\d+) of (\d+) images fit; connect fewer\.$/s.exec(text))) return t('{reason} Only {count} of {total} images fit; connect fewer.', { reason: t(match[1]), count: match[2], total: match[3] });
    }
    if (text.startsWith('Daily limit reached (') && (match = /^Daily limit reached \((\d+)\/(\d+)\)\.$/.exec(text))) return t('Daily limit reached ({used}/{limit}).', { used: match[1], limit: match[2] });
    if (text.includes(' took longer than ') && (match = /^(Nano Banana|GPT Image|Gemini|GPT) took longer than (\d+) minutes\. Try again\.$/.exec(text))) return t('{name} took longer than {minutes} minutes. Try again.', { name: match[1], minutes: match[2] });
    if ((match = /^GPT failed \((\d+)\)\. Try again\.$/.exec(text))) return t('GPT failed ({status}). Try again.', { status: match[1] });
    // Reference size errors from the board room (cloud/reference-prep.mjs) name the image and the provider.
    match = /^Reference images are (still )?too large for (.+?) (after reducing them )?\(([\d.]+) MB in total\)\. (Use fewer or smaller images|Use fewer images)\.$/.exec(text);
    if (match) return t(match[1] ? 'Reference images are still too large for {name} after reducing them ({size} MB in total). Use fewer images.' : 'Reference images are too large for {name} ({size} MB in total). Use fewer or smaller images.', { name: t(match[2]), size: match[4] });
    // A masked image cannot be resized until its mask is removed, so its messages say that instead.
    match = /^“(.*)” is too large to reduce automatically \(([\d.]+) MB; the limit is 20 MB\)\. (Right-click it, choose Resize…, then try again|Remove its mask, choose Resize…, then paint the mask again)\.$/s.exec(text);
    if (match) return t(match[3].startsWith('Remove') ? '“{name}” is too large to reduce automatically ({size} MB; the limit is 20 MB). Remove its mask, choose Resize…, then paint the mask again.' : '“{name}” is too large to reduce automatically ({size} MB; the limit is 20 MB). Right-click it, choose Resize…, then try again.', { name: match[1], size: match[2] });
    match = /^Could not reduce “(.*)” to send it\. (Right-click it, choose Resize…, then try again|Remove its mask, choose Resize…, then paint the mask again)\.$/s.exec(text);
    if (match) return t(match[2].startsWith('Remove') ? 'Could not reduce “{name}” to send it. Remove its mask, choose Resize…, then paint the mask again.' : 'Could not reduce “{name}” to send it. Right-click it, choose Resize…, then try again.', { name: match[1] });
  }
  const translated = dictionaries[current]?.[text];
  return fill(typeof translated === 'string' ? translated : text, values);
}
// plural(n, '{count} image', '{count} images'): a translation lists its forms for Intl's one, few, many (and other)
// under the English singular, e.g. ['{count} зображення', '{count} зображення', '{count} зображень', '{count} зображення'].
const rules = new Map();
export function plural(count, one, other, values = {}) {
  const forms = dictionaries[current]?.[one], all = { count, ...values };
  if (!Array.isArray(forms)) return fill(count === 1 ? one : other, all);
  if (!rules.has(current)) rules.set(current, new Intl.PluralRules(current));
  const index = { one: 0, few: 1, many: 2, other: 3 }[rules.get(current).select(count)];
  return fill(forms[index] ?? forms.at(-1), all);
}

// Chosen once per page load; switching saves the choice and reloads, so every label is drawn in the new language.
export function saveLanguage(value) {
  try { localStorage.setItem(languageKey, value); } catch {}
}
if (typeof window !== 'undefined') {
  let saved;
  try { saved = localStorage.getItem(languageKey); } catch {}
  setLanguage(detectLanguage(saved, navigator.languages?.length ? navigator.languages : [navigator.language]));
}
