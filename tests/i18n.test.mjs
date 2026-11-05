import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, language, plural, setLanguage, t } from '../src/i18n.mjs';
import uk from '../src/locales/uk.mjs';

test('the interface language follows a saved choice, then the browser, then English', () => {
  assert.equal(detectLanguage('uk', ['en-US']), 'uk');
  assert.equal(detectLanguage(null, ['de-DE', 'uk-UA', 'en']), 'uk');
  assert.equal(detectLanguage('fr', ['fr-FR']), 'en');
  assert.equal(detectLanguage(undefined, []), 'en');
});

test('text falls back to English and Ukrainian plurals pick their form', () => {
  assert.equal(language(), 'en');
  assert.equal(t('Go to {name}', { name: 'Olena' }), 'Go to Olena');
  assert.equal(plural(1, '{count} image', '{count} images'), '1 image'); assert.equal(plural(3, '{count} image', '{count} images'), '3 images');
  setLanguage('uk');
  try {
    assert.equal(t('Language'), 'Мова');
    assert.equal(t('Something not translated {x}', { x: 1 }), 'Something not translated 1');
    if (Array.isArray(uk['{count} image'])) {
      assert.deepEqual([1, 3, 5, 21, 1.5].map(n => plural(n, '{count} image', '{count} images')), ['1 зображення', '3 зображення', '5 зображень', '21 зображення', '1.5 зображення']);
    }
  } finally { setLanguage('en'); }
});

test('every Ukrainian entry is text or a full list of plural forms with the same placeholders', () => {
  const holes = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join();
  for (const [english, value] of Object.entries(uk)) {
    if (Array.isArray(value)) { assert.equal(value.length, 4, english); for (const form of value) assert.equal(holes(form), holes(english), english); }
    else { assert.equal(typeof value, 'string', english); assert.equal(holes(value), holes(english), english); assert.ok(value.trim(), english); }
  }
});

test('every interface string passed to t(), rich() or plural() has a Ukrainian translation', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const folder = new URL('../src/', import.meta.url), missing = new Set();
  const literal = String.raw`'((?:[^'\\]|\\.)*)'`;
  for (const file of (await readdir(folder)).filter(name => /\.(jsx|mjs)$/.test(name))) {
    const source = await readFile(new URL(file, folder), 'utf8');
    const keys = [...source.matchAll(new RegExp(String.raw`\b(?:t|rich)\(\s*` + literal, 'g')), ...source.matchAll(new RegExp(String.raw`\bplural\([^,()]+(?:\([^()]*\))?[^,()]*,\s*` + literal, 'g'))];
    for (const [, key] of keys) if (!Object.hasOwn(uk, key.replace(/\\'/g, "'"))) missing.add(`${file}: ${key}`);
  }
  assert.deepEqual([...missing], []);
});
