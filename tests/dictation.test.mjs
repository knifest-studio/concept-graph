import test from 'node:test';
import { dictationPreferenceKey, readDictationPreference } from '../src/dictation.mjs';
import assert from 'node:assert/strict';
import { dictationError, dictationLanguage, dictationResults, insertDictation, layoutLanguage, typedLanguage } from '../src/dictation.mjs';

const layout = values => new Map(Object.entries(values));
const english = layout({ KeyQ: 'q', KeyS: 's', Quote: "'", BracketRight: ']' });

test('keyboard maps identify Ukrainian, Russian and Latin layouts', () => {
  for (const letter of 'іїєґІЇЄҐ') assert.equal(layoutLanguage(layout({ KeyS: letter })), 'uk-UA');
  for (const letter of 'ыэъёЫЭЪЁ') assert.equal(layoutLanguage(layout({ Quote: letter })), 'ru-RU');
  assert.equal(layoutLanguage(english), 'en-US');
  assert.equal(layoutLanguage(layout({ KeyQ: 'a' })), 'en-US');
  assert.equal(layoutLanguage(layout({ KeyQ: 'й' })), '');
  assert.equal(layoutLanguage(new Map()), '');
  assert.equal(layoutLanguage(), '');
});

test('typed fallback follows the last language-specific letters, including uppercase and composition text', () => {
  assert.equal(typedLanguage('Привіт!'), 'uk-UA');
  assert.equal(typedLanguage('МЫ'), 'ru-RU');
  assert.equal(typedLanguage('Їжа then english'), 'en-US');
  assert.equal(typedLanguage('hello, ёж'), 'ru-RU');
  assert.equal(typedLanguage('Ї', 'ru-RU'), 'uk-UA');
  assert.equal(typedLanguage('кран', 'uk-UA'), 'uk-UA');
  assert.equal(typedLanguage('кран', 'ru-RU'), 'ru-RU');
  assert.equal(typedLanguage('кран', 'en-US', 'uk-UA'), 'uk-UA');
  assert.equal(typedLanguage('кран', 'en-US', 'ru-RU'), 'ru-RU');
  assert.equal(typedLanguage('кран', 'en-US', 'en-US'), '');
  assert.equal(typedLanguage(' 123!?🙂', 'uk-UA'), 'uk-UA');
  assert.equal(typedLanguage(null, 'ru-RU'), 'ru-RU');
});

test('language selection avoids ASCII maps overriding recently typed Cyrillic', () => {
  assert.equal(dictationLanguage(english, 'uk-UA', 'en-US'), 'uk-UA');
  assert.equal(dictationLanguage(english, 'ru-RU', 'en-US'), 'ru-RU');
  assert.equal(dictationLanguage(layout({ KeyS: 'і' }), 'ru-RU'), 'uk-UA');
  assert.equal(dictationLanguage(layout({ KeyS: 'ы' }), 'uk-UA'), 'ru-RU');
  assert.equal(dictationLanguage(english), 'en-US');
  assert.equal(dictationLanguage(null, 'ru-RU', 'uk-UA'), 'ru-RU');
  for (const [locale, expected] of [['UK', 'uk-UA'], ['ru-RU', 'ru-RU'], ['en-GB', 'en-US'], ['de-DE', 'en-US'], ['', 'en-US']]) {
    assert.equal(dictationLanguage(null, '', locale), expected);
  }
});

test('dictation inserts at the caret or replaces a selection without losing surrounding text', () => {
  assert.deepEqual(insertDictation('', ' hello '), { text: 'hello', caret: 5 });
  assert.deepEqual(insertDictation('A bird', 'blue', 2), { text: 'A blue bird', caret: 7 });
  assert.deepEqual(insertDictation('A red bird', 'blue', 2, 5), { text: 'A blue bird', caret: 6 });
  assert.deepEqual(insertDictation('A bird', 'in the sky'), { text: 'A bird in the sky', caret: 17 });
  assert.deepEqual(insertDictation('Hello!', 'world', 5), { text: 'Hello world!', caret: 11 });
  assert.deepEqual(insertDictation('Hello', ',', 5), { text: 'Hello,', caret: 6 });
  assert.deepEqual(insertDictation('(bird)', 'blue', 1), { text: '(blue bird)', caret: 6 });
  assert.deepEqual(insertDictation('Keep\n', 'this'), { text: 'Keep\nthis', caret: 9 });
  assert.deepEqual(insertDictation('Привіт', 'світе'), { text: 'Привіт світе', caret: 12 });
  assert.deepEqual(insertDictation('abc', '', 0, 3), { text: 'abc', caret: 0 });
  assert.deepEqual(insertDictation('abc', 'z', 100, 200), { text: 'abc z', caret: 5 });
});

const result = (text, isFinal = false) => Object.assign([{ transcript: text }], { isFinal });
test('interim revisions stay separate and cumulative final results are committed once', () => {
  assert.deepEqual(dictationResults([result('blue')]), { final: '', interim: 'blue', committed: 0 });
  assert.deepEqual(dictationResults([result('blue bird')]), { final: '', interim: 'blue bird', committed: 0 });
  assert.deepEqual(dictationResults([result('blue bird', true), result('in the')]), { final: 'blue bird', interim: 'in the', committed: 1 });
  assert.deepEqual(dictationResults([result('blue bird', true), result('in the sky', true)], 1), { final: 'in the sky', interim: '', committed: 2 });
  assert.deepEqual(dictationResults([result('blue bird', true), result('in the sky', true)], 2), { final: '', interim: '', committed: 2 });
  assert.deepEqual(dictationResults([result('blue', true), result('bird', true)]), { final: 'blue bird', interim: '', committed: 2 });
  assert.deepEqual(dictationResults([], 0), { final: '', interim: '', committed: 0 });
  assert.deepEqual(dictationResults([result(' ', true)]), { final: '', interim: '', committed: 1 });
});

test('microphone and service errors have concise messages; cancellation is silent', () => {
  for (const code of ['not-allowed', 'service-not-allowed', 'audio-capture', 'no-speech', 'network', 'language-not-supported', 'unknown']) assert.ok(dictationError(code));
  assert.equal(dictationError('aborted'), '');
});

test('the prompt language beats an ASCII keyboard map, and the language tag cycles UK → EN → RU', async () => {
  const { dictationLanguage, nextDictationLanguage } = await import('../src/dictation.mjs');
  const ascii = new Map([['KeyQ', 'q'], ['KeyS', 's']]);
  assert.equal(dictationLanguage(ascii, '', 'en-US', 'зроби його в стилі майнкрафт'), 'uk-UA');
  assert.equal(dictationLanguage(ascii, 'uk-UA', 'en-US', 'make it blue'), 'en-US');
  assert.equal(dictationLanguage(ascii, 'ru-RU', 'en-US', ''), 'ru-RU');
  assert.equal(dictationLanguage(new Map([['KeyS', 'ы']]), '', 'en-US', 'стилі'), 'ru-RU');
  assert.deepEqual(['uk-UA', 'en-US', 'ru-RU'].map(nextDictationLanguage), ['en-US', 'ru-RU', 'uk-UA']);
});

test('a saved dictation choice overrides detection and automatic mode preserves existing detection', () => {
  for (const preferred of ['uk-UA', 'en-US', 'ru-RU']) {
    const storage = { getItem: key => key === dictationPreferenceKey ? preferred : null };
    assert.equal(readDictationPreference(storage), preferred);
    assert.equal(dictationLanguage(null, 'uk-UA', 'en-US', 'English prompt', preferred), preferred);
  }
  assert.equal(readDictationPreference({ getItem: () => 'invalid' }), '');
  assert.equal(readDictationPreference({ getItem() { throw Error('Denied'); } }), '');
  assert.equal(dictationLanguage(null, 'uk-UA', 'en-US', 'English prompt', ''), 'en-US');
});
