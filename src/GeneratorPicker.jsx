import React from 'react';
import { generators, maxVariants } from '../graph.mjs';
import { t } from './i18n.mjs';
import './generator-picker.css';

// The arrow beside Generate chooses who generates a cloud prompt: the person's own Codex (the default) or Nano Banana
// on the site's Gemini key. A native list keeps it compact and accessible; its last, disabled line says what Nano Banana
// can do now (quota left, or why it is unavailable).
// A describe node offers the same two: Codex, or Gemini on the same site key (a text model, not Nano Banana itself).
export function GeneratorPicker({ id, generator, nano, choose, describe = false }) {
  const nanoChosen = generator === generators.nanoBanana, siteModel = describe ? 'Gemini' : 'Nano Banana';
  return <label className={`generator-picker nodrag nopan${nanoChosen ? ' nano' : ''}`} data-tooltip={nanoChosen ? `${siteModel} · ${nano.note}` : describe ? t('Describe with Codex or Gemini') : t('Generate with Codex or Nano Banana')}>
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    <select aria-label={t('Image generator')} value={nanoChosen ? generator : ''} onChange={event => choose(id, event.target.value || null)}>
      <option value="">Codex</option>
      <option value={generators.nanoBanana} disabled={!nano.selectable && !nanoChosen}>{siteModel}</option>
      <option value="note" disabled>{nano.note}{nano.budget ? ` · ${nano.budget}` : ''}</option>
    </select>
  </label>;
}

// With Nano Banana one Generate can start up to four separate images at once; they arrive as one slideshow. The row sits
// under the prompt, where there is room for one-click choices; a light card keeps an empty row of the same height.
export function VariantRow({ id, variants = 1, choose, disabled }) {
  return <div className="variant-row nodrag" role="group" aria-label={t('Number of variants')} data-tooltip={t('Variants: separate images generated at the same time')}>
    <span>{t('Variants')}</span>{Array.from({ length: maxVariants }, (_, index) => index + 1).map(count => <button type="button" key={count} aria-pressed={variants === count} disabled={disabled} onClick={() => choose(id, count)}>{count}</button>)}
  </div>;
}
