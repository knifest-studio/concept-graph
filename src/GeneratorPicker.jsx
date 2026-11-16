import React from 'react';
import { clampVariants, generators, maxVariants, variantPresets } from '../graph.mjs';
import { t } from './i18n.mjs';
import './generator-picker.css';

// Cloud prompts choose a personal Codex or a site API key. Status lines explain setup, access and the shared allowance.
// A describe node offers the same two: Codex, or Gemini on the same site key (a text model, not Nano Banana itself).
export function GeneratorPicker({ id, generator, nano, gpt, choose, request, describe = false }) {
  // Without access the reason and who gives it is the picker's tip, so it reads before the menu is opened.
  const locked = !nano.selectable && nano.note;
  const line = status => `${status.note}${status.budget ? ` · ${status.budget}` : ''}`, shared = !describe && line(nano) === line(gpt);
  const nanoChosen = generator === generators.nanoBanana, gptChosen = !describe && generator === generators.gptImage, siteModel = describe ? 'Gemini' : 'Nano Banana';
  return <label className={`generator-picker nodrag nopan${nanoChosen || gptChosen ? ' nano' : ''}`} data-tooltip={gptChosen ? `GPT Image · ${gpt.note}` : nanoChosen ? `${siteModel} · ${nano.note}` : locked ? `${siteModel}${describe ? '' : ' / GPT Image'} · ${nano.note}` : describe ? t('Describe with Codex or Gemini') : t('Generate with Codex, Nano Banana or GPT Image')}>
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    <select aria-label={t('Image generator')} value={nanoChosen || gptChosen ? generator : ''} onChange={event => event.target.value === 'request' ? request?.() : choose(id, event.target.value || null)}>
      <option value="">Codex</option>
      {/* One this person can't use stays clickable and says why when chosen (setGenerator), instead of ignoring the click. */}
      <option value={generators.nanoBanana}>{siteModel}{!nano.selectable && !nanoChosen && nano.short ? ` · ${nano.short}` : ''}</option>
      {!describe && <option value={generators.gptImage}>GPT Image{!gpt.selectable && !gptChosen && gpt.short ? ` · ${gpt.short}` : ''}</option>}
      {/* Access stays manual: someone without it can ask, and the request waits for admins in Team access. */}
      {nano.requestable && request && <option value="request">{t('Request access…')}</option>}
      {/* Both share access and limits, so one line says it when their status matches (e.g. "50 of 50 left today"). */}
      {shared ? <option value="note" disabled>{line(nano)}</option> : <>
        <option value="note" disabled>{siteModel} · {line(nano)}</option>
        {!describe && <option value="gpt-note" disabled>GPT Image · {line(gpt)}</option>}
      </>}
    </select>
  </label>;
}

// With a site API key one Generate starts several images at once; they arrive as one slideshow. The counts sit under the
// prompt, in the row that ends with the generation settings chip: one-click counts plus a small field for any other count
// up to maxVariants. With the chip beside them there is no room for the field, so it waits as a narrow … button (or the
// typed count) that turns into the field when clicked. A typed count is saved on Enter or when the field is left, so
// teammates and undo never see a half-typed number; Escape, an empty field or 0 keeps the count as it was.
export const typedVariants = text => /^\d+$/.test(text) && Number(text) >= 1 ? clampVariants(Number(text)) : null;
export function VariantRow({ id, variants = 1, choose, disabled, compact = false }) {
  const custom = variantPresets.includes(variants) ? '' : String(variants), [draft, setDraft] = React.useState(null), [editing, setEditing] = React.useState(false), cancelled = React.useRef(false), refocus = React.useRef(false);
  const commit = () => {
    const count = cancelled.current || draft === null ? null : typedVariants(draft);
    cancelled.current = false; setDraft(null); setEditing(false);
    if (count !== null && count !== variants) choose(id, count);
  };
  const label = t('Custom number of variants, 1–{max}', { max: maxVariants });
  return <div className={`variant-group${compact ? ' compact' : ''}`} role="group" aria-label={t('Number of variants')} data-tooltip={t('Variants: separate images from one Generate. Type any number up to {max}.', { max: maxVariants })}>
    <span>{t('Variants')}</span>{variantPresets.map(count => <button type="button" key={count} data-analytics-name={`Variants: ${count}`} aria-pressed={variants === count} disabled={disabled} onClick={() => choose(id, count)}>{count}</button>)}
    {/* Enter or Escape in the field hands focus back to the button that replaces it, so the keyboard does not lose its place. */}
    {compact && !editing ? <button ref={element => { if (element && refocus.current) { refocus.current = false; element.focus({ preventScroll: true }); } }} type="button" className={`variant-custom${custom ? ' chosen' : ''}`} aria-label={label} aria-pressed={!!custom} disabled={disabled} onClick={() => setEditing(true)}>{custom || '…'}</button>
      : <input className={`variant-custom${custom ? ' chosen' : ''}`} type="text" inputMode="numeric" maxLength={2} placeholder="…" aria-label={label} disabled={disabled} autoFocus={compact}
        value={draft ?? custom} onFocus={event => { setDraft(custom); event.currentTarget.select(); }} onChange={event => setDraft(event.target.value.replace(/\D/g, ''))} onBlur={commit}
        onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); refocus.current = compact; event.currentTarget.blur(); } else if (event.key === 'Escape') { cancelled.current = true; refocus.current = compact; event.currentTarget.blur(); } }}/>}
  </div>;
}
