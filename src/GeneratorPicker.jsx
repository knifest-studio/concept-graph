import React from 'react';
import { generators, maxVariants } from '../graph.mjs';
import { t } from './i18n.mjs';
import './generator-picker.css';

// Cloud prompts choose a personal Codex or a site API key. Status lines explain setup, access and the shared allowance.
// A describe node offers the same two: Codex, or Gemini on the same site key (a text model, not Nano Banana itself).
export function GeneratorPicker({ id, generator, nano, gpt, choose, describe = false }) {
  const line = status => `${status.note}${status.budget ? ` · ${status.budget}` : ''}`, shared = !describe && line(nano) === line(gpt);
  const nanoChosen = generator === generators.nanoBanana, gptChosen = !describe && generator === generators.gptImage, siteModel = describe ? 'Gemini' : 'Nano Banana';
  return <label className={`generator-picker nodrag nopan${nanoChosen || gptChosen ? ' nano' : ''}`} data-tooltip={gptChosen ? `GPT Image · ${gpt.note}` : nanoChosen ? `${siteModel} · ${nano.note}` : describe ? t('Describe with Codex or Gemini') : t('Generate with Codex, Nano Banana or GPT Image')}>
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    <select aria-label={t('Image generator')} value={nanoChosen || gptChosen ? generator : ''} onChange={event => choose(id, event.target.value || null)}>
      <option value="">Codex</option>
      <option value={generators.nanoBanana} disabled={!nano.selectable && !nanoChosen}>{siteModel}</option>
      {!describe && <option value={generators.gptImage} disabled={!gpt.selectable && !gptChosen}>GPT Image</option>}
      {/* Both share access and limits, so one line says it when their status matches (e.g. "50 of 50 left today"). */}
      {shared ? <option value="note" disabled>{line(nano)}</option> : <>
        <option value="note" disabled>{siteModel} · {line(nano)}</option>
        {!describe && <option value="gpt-note" disabled>GPT Image · {line(gpt)}</option>}
      </>}
    </select>
  </label>;
}

// With a site API key one Generate can start up to four images at once; they arrive as one slideshow. The row sits
// under the prompt, where there is room for one-click choices; a light card keeps an empty row of the same height.
export function VariantRow({ id, variants = 1, choose, disabled }) {
  return <div className="variant-row nodrag" role="group" aria-label={t('Number of variants')} data-tooltip={t('Variants: separate images generated at the same time')}>
    <span>{t('Variants')}</span>{Array.from({ length: maxVariants }, (_, index) => index + 1).map(count => <button type="button" key={count} aria-pressed={variants === count} disabled={disabled} onClick={() => choose(id, count)}>{count}</button>)}
  </div>;
}
