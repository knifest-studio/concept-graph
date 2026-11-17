import React from 'react';
import { clampVariants, generators, maxVariants, variantPresets } from '../graph.mjs';
import { t } from './i18n.mjs';
import './generator-picker.css';

// Each model owns its run, timer and cancel control; changing the prompt's default cannot hide a sibling run.
export function GeneratorButtons({ id, models, runs = {}, canRun, readOnly, userName, cloud, describe = false, run, cancel, connect, request, nano, gpt, fix, buttonRef, highlight }) {
  const line = status => `${status?.note || ''}${status?.budget ? ` · ${status.budget}` : ''}`;
  return <div className="generator-buttons nodrag nopan" role="group" aria-label={t('Generators')}>
    {models.map(({ generator, name, disabled, note }, index) => {
      const view = runs[generator] || {}, pending = view.active || view.starting, canCancel = !cloud || view.byName === userName;
      const label = describe ? t('Describe with {name}', { name }) : t('Generate with {name}', { name });
      const status = view.starting && !view.active ? t('Starting…') : canCancel ? view.timer : `(${view.byName || t('Teammate')})`;
      const tip = !canRun ? describe ? t('Connect an image first') : t('Write a prompt first') : `${label}${pending ? ` · ${status}` : ''}${note ? ` · ${note}` : ''}`;
      return <div key={generator} className={`generator-slot${pending ? ' pending' : ''}`}>
        <button ref={index === 0 ? buttonRef : undefined} type="button" className={`model-generate${generator === generators.nanoBanana ? ' nano' : ''}${highlight ? ' onboarding-highlight' : ''}`}
          data-analytics-name={label} aria-label={label} aria-busy={!!pending} data-tooltip={tip} disabled={readOnly || pending || disabled || !canRun} onClick={event => run(id, null, event, generator)}>
          {/* Running, a button also holds its spinner and timer, so it shows the name's first word (Nano, GPT); the tooltip and label keep it whole. */}
          {pending ? <><i className="model-progress" aria-hidden="true"/><i className="model-spinner" aria-hidden="true"/><span>{name.split(' ')[0]}</span><span className={`model-time${canCancel ? '' : ' model-owner'}`} role="status">{status}</span></> : <><span aria-hidden="true">▶</span><span>{name}</span></>}
        </button>
        {view.active && canCancel && !readOnly && <button type="button" className="model-cancel" aria-label={t('Cancel {name}', { name })} data-tooltip={t('Cancel {name}', { name })} onClick={() => cancel(view.runId)}>×</button>}
      </div>;
    })}
    {cloud && <details className="generator-more"><summary aria-label={t('Generator options')} data-tooltip={t('Generator options')}>⋯</summary><div className="generator-menu">
      {connect && <button type="button" disabled={readOnly} onClick={event => { event.currentTarget.closest('details').removeAttribute('open'); fix(); }}>{t('Connect Codex')}</button>}
      {nano?.requestable && request && <button type="button" disabled={readOnly} onClick={event => { event.currentTarget.closest('details').removeAttribute('open'); request(); }}>{t('Request access…')}</button>}
      <small>{line(nano)}</small>{line(gpt) !== line(nano) && <small>GPT Image · {line(gpt)}</small>}
    </div></details>}
  </div>;
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
