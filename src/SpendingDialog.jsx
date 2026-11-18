import React, { useEffect, useRef, useState } from 'react';
import { keepDialogFocus } from './dialog-focus.mjs';
import { language, plural, t } from './i18n.mjs';

// Cents always show, so small amounts such as $0.04 do not read as nothing.
const money = value => `$${(Math.round(value * 100) / 100).toFixed(2)}`;
const locale = () => language() === 'uk' ? 'uk-UA' : 'en-US';
const monthName = month => new Date(`${month}-01T12:00:00Z`).toLocaleDateString(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayName = day => new Date(`${day}T12:00:00Z`).toLocaleDateString(locale(), { day: 'numeric', month: 'long', timeZone: 'UTC' });
// What a person's calls of one kind made this month (cloud/directory.mjs spendKinds), counted in what came out: images,
// videos, models. Descriptions make no image, so they count calls, as does `earlier`: calls from before the site
// recorded what each one was, which mix every kind.
const kindLabel = (item, splitSince) => {
  const count = item.outputs;
  if (item.kind === 'nano') return plural(count, 'Nano Banana: {count} image', 'Nano Banana: {count} images');
  if (item.kind === 'gpt') return plural(count, 'GPT Image: {count} image', 'GPT Image: {count} images');
  if (item.kind === 'describe') return plural(item.made, '{count} description', '{count} descriptions');
  if (item.kind === 'upscale') return plural(count, '{count} upscale', '{count} upscales');
  if (item.kind === 'model3d') return plural(count, '{count} 3D model', '{count} 3D models');
  if (item.kind === 'video') return plural(count, '{count} video', '{count} videos');
  if (item.kind === 'earlier') return splitSince ? plural(item.made, '{count} generation before {date}', '{count} generations before {date}', { date: dayName(splitSince) })
    : plural(item.made, '{count} generation, not split by type', '{count} generations, not split by type');
  return item.kind;
};
const percent = share => `${share > 0 && share < 0.01 ? '<1' : Math.round(share * 100)}%`;

// Only the site owner sees this: each person's share of the team's spending on the shared API keys, month by month (UTC).
export function SpendingDialog({ services, onClose }) {
  const [month, setMonth] = useState(''), [data, setData] = useState(null), [error, setError] = useState('');
  const done = useRef(null);
  useEffect(() => { done.current?.focus(); }, []);
  useEffect(() => {
    let active = true;
    setError('');
    services.api(`/api/cloud/spending${month ? `?month=${encodeURIComponent(month)}` : ''}`).then(result => { if (active) setData(result.spending); }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [month]);
  const current = data && data.month === data.today.slice(0, 7);
  return <div className="board-modal" data-analytics-area="dialog:Spending" role="dialog" aria-modal="true" aria-labelledby="spending-title" onKeyDown={event => { keepDialogFocus(event); event.stopPropagation(); if (event.key === 'Escape') onClose(); }}>
    <div className="share-card team-card spending-card">
      <div className="spending-head">
        <h2 id="spending-title">{t('Spending')}</h2>
        {data && <select aria-label={t('Month')} value={data.month} onChange={event => setMonth(event.target.value)}>{data.months.map(item => <option key={item} value={item}>{monthName(item)}</option>)}</select>}
      </div>
      <p className="share-note">{t('Who spent what on the team’s API keys. Amounts are estimates from the providers’ prices; the actual bill is in Google, OpenAI and fal.ai.')}</p>
      {error && <p className="cloud-error share-error" role="alert">{error}</p>}
      {!data && !error && <p className="share-note" role="status">{t('Loading…')}</p>}
      {data && <>
        <div className="spending-team">
          <span><b>{money(data.team.usd)}</b><small>{current ? t('of {limit} this month', { limit: money(data.monthlyUsd) }) : t('of {limit} a month', { limit: money(data.monthlyUsd) })}</small></span>
          {current && <span><b>{money(data.team.todayUsd)}</b><small>{t('today')}</small></span>}
          <div className="spending-meter" role="meter" aria-label={t('Team budget used')} aria-valuemin={0} aria-valuemax={data.monthlyUsd} aria-valuenow={Math.round(data.team.usd * 100) / 100}><i style={{ width: `${Math.min(100, data.monthlyUsd ? data.team.usd / data.monthlyUsd * 100 : 0)}%` }}/></div>
        </div>
        <h3>{t('People')}</h3>
        <ul className="share-people spending-people">
          {data.people.map(person => {
            const share = data.team.usd ? person.usd / data.team.usd : 0;
            return <li key={person.email}>
              <div className="spending-person">
                <span><b>{person.name || person.email}</b>{person.name && <small>{person.email}</small>}</span>
                <span className="spending-amount"><b>{money(person.usd)}</b><small>{t('{percent} of the team', { percent: percent(share) })}</small></span>
              </div>
              <div className="spending-share" aria-hidden="true"><i style={{ width: `${share * 100}%` }}/></div>
              <div className="spending-kinds">{person.kinds.map(item => <span key={item.kind} title={item.kind === 'earlier' ? t('Made before the site recorded what each generation was.') : undefined}>{kindLabel(item, data.splitSince)}<em>{money(item.usd)}</em></span>)}</div>
              {current && (person.todayImages > 0 || person.todayUsd > 0) && <small className="spending-today">{t('Today: {images} of {limit} images, {spent}', { images: person.todayImages, limit: data.dailyImages, spent: money(person.todayUsd) })}</small>}
            </li>;
          })}
          {!data.people.length && <li className="share-muted">{t('No spending in this month.')}</li>}
        </ul>
      </>}
      <div className="share-actions"><span/><button ref={done} className="primary-button" type="button" aria-label={t('Done')} onClick={onClose}>{t('Done')}</button></div>
    </div>
  </div>;
}
