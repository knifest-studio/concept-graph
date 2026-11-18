import React, { useEffect, useRef, useState } from 'react';
import { keepDialogFocus } from './dialog-focus.mjs';
import { language, plural, t } from './i18n.mjs';

// Cents always show, so small amounts such as $0.04 do not read as nothing.
const money = value => `$${(Math.round(value * 100) / 100).toFixed(2)}`;
// What a paid call made, in the order the server records (cloud/directory.mjs spendKinds); `earlier` is usage from before
// the site recorded what each call made.
const kindLabels = {
  nano: count => plural(count, 'Nano Banana: {count} image', 'Nano Banana: {count} images'),
  gpt: count => plural(count, 'GPT Image: {count} image', 'GPT Image: {count} images'),
  describe: count => plural(count, '{count} description', '{count} descriptions'),
  upscale: count => plural(count, '{count} upscale', '{count} upscales'),
  model3d: count => plural(count, '{count} 3D model', '{count} 3D models'),
  video: count => plural(count, '{count} video', '{count} videos'),
  earlier: count => plural(count, '{count} earlier, not split', '{count} earlier, not split'),
};
const monthName = month => new Date(`${month}-01T12:00:00Z`).toLocaleDateString(language() === 'uk' ? 'uk-UA' : 'en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

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
  const current = data && data.month === data.today.slice(0, 7), top = data?.people[0]?.usd || 0;
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
          {data.people.map(person => <li key={person.email}>
            <div className="spending-person">
              {(() => {
                const details = [person.name && person.email, current && (person.todayImages > 0 || person.todayUsd > 0) && t('today {images} of {limit} images, {spent}', { images: person.todayImages, limit: data.dailyImages, spent: money(person.todayUsd) })].filter(Boolean).join(' · ');
                return <span><b>{person.name || person.email}</b>{details && <small>{details}</small>}</span>;
              })()}
              <b className="spending-amount">{money(person.usd)}</b>
            </div>
            <div className="spending-share" aria-hidden="true"><i style={{ width: `${top ? person.usd / top * 100 : 0}%` }}/></div>
            <div className="spending-kinds">{person.kinds.map(item => <span key={item.kind} title={item.kind === 'earlier' ? t('Made before the site recorded what each generation was.') : undefined}>{kindLabels[item.kind]?.(item.made) || item.kind}<em>{money(item.usd)}</em></span>)}</div>
          </li>)}
          {!data.people.length && <li className="share-muted">{t('No spending in this month.')}</li>}
        </ul>
      </>}
      <div className="share-actions"><span/><button ref={done} className="primary-button" type="button" aria-label={t('Done')} onClick={onClose}>{t('Done')}</button></div>
    </div>
  </div>;
}
