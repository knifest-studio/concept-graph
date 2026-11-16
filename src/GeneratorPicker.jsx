import React from 'react';
import { clampVariants, generators, maxVariants, variantPresets } from '../graph.mjs';
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

// With a site API key one Generate starts several images at once; they arrive as one slideshow. The row sits under the
// prompt, where there is room for one-click counts plus a small field for any other count up to maxVariants; a light
// card keeps an empty row of the same height. A typed count is saved on Enter or when the field is left, so teammates
// and undo never see a half-typed number; Escape, an empty field or 0 keeps the count as it was.
export const typedVariants = text => /^\d+$/.test(text) && Number(text) >= 1 ? clampVariants(Number(text)) : null;
export function VariantRow({ id, variants = 1, choose, disabled }) {
  const custom = variantPresets.includes(variants) ? '' : String(variants), [draft, setDraft] = React.useState(null), cancelled = React.useRef(false);
  const commit = () => {
    const count = cancelled.current || draft === null ? null : typedVariants(draft);
    cancelled.current = false; setDraft(null);
    if (count !== null && count !== variants) choose(id, count);
  };
  return <div className="variant-row nodrag" role="group" aria-label={t('Number of variants')} data-tooltip={t('Variants: separate images generated at the same time. Type any number up to {max}.', { max: maxVariants })}>
    <span>{t('Variants')}</span>{variantPresets.map(count => <button type="button" key={count} aria-pressed={variants === count} disabled={disabled} onClick={() => choose(id, count)}>{count}</button>)}
    <input className={`variant-custom${custom ? ' chosen' : ''}`} type="text" inputMode="numeric" maxLength={2} placeholder="…" aria-label={t('Custom number of variants, 1–{max}', { max: maxVariants })} disabled={disabled}
      value={draft ?? custom} onFocus={event => { setDraft(custom); event.currentTarget.select(); }} onChange={event => setDraft(event.target.value.replace(/\D/g, ''))} onBlur={commit}
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === 'Escape') { cancelled.current = true; event.currentTarget.blur(); } }}/>
  </div>;
}
