import React, { useEffect, useState } from 'react';
import { language, plural, t } from './i18n.mjs';
import './analytics.css';

const locale = () => language() === 'uk' ? 'uk-UA' : 'en-US';
const money = value => `$${(Math.round(value * 100) / 100).toFixed(2)}`;
const day = value => value ? new Date(value).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
// "5 minutes ago", "yesterday": the browser words it in the page's language.
function ago(time, now) {
  const seconds = Math.round((time - now) / 1000), format = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, 'minute');
}

// Site admins' panel (/admin): who is online now and on which board, when each person was last here, their boards,
// team-key generations and AI agent; the owner also sees spending. It re-reads itself while visible, like the boards list.
export default function AdminPanel({ services }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [query, setQuery] = useState('');
  useEffect(() => {
    let active = true;
    const load = () => { if (!document.hidden) services.api('/api/cloud/admin').then(value => { if (active) { setData(value.admin); setError(''); } }).catch(cause => { if (active) setError(cause.message); }); };
    load();
    const timer = setInterval(load, 30000);
    document.addEventListener('visibilitychange', load);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [services]);
  const people = data?.people || [], owner = data?.role === 'owner', words = query.trim().toLowerCase();
  const shown = words ? people.filter(person => `${person.name || ''} ${person.email}`.toLowerCase().includes(words)) : people;
  const totals = data && [
    [people.filter(person => person.online).length, 'Online now'],
    [people.filter(person => person.lastSeen && data.now - person.lastSeen < 86400000).length, 'Here in the last 24 hours'],
    [people.length, 'People'],
    [data.boards, 'Boards'],
    [people.reduce((sum, person) => sum + person.todayMade, 0), 'Generations today'],
  ];
  return <main className="analytics-admin admin-panel" data-analytics-area="admin-panel">
    <header><a href="/">{t('All boards')}</a><h1>{t('Admin panel')}</h1><a href="/admin/analytics">{t('Product analytics')}</a></header>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p>{t('Loading…')}</p>}
    {data && <>
      <section><div className="analytics-totals admin-totals">{totals.map(([value, label]) => <div key={label}><strong>{value}</strong><span>{t(label)}</span></div>)}</div></section>
      <section>
        <div className="admin-people-head"><h2>{t('People')}</h2><input type="search" aria-label={t('Find a person')} placeholder={t('Find a person')} value={query} onChange={event => setQuery(event.target.value)}/></div>
        <p>{t('Online means the site is open in a visible tab right now (checked every 30–60 seconds). Visits are recorded from the day this panel was added, so earlier ones show as —.')}{!data.signIns && ` ${t('The sign-in list cannot be read right now, so names and sign-in dates may be missing.')}`}</p>
        <div className="analytics-table admin-table"><table>
          <thead><tr>{['Person', 'Status', 'Own boards', 'Invited to', 'Generations', ...(owner ? ['Spent in the month'] : []), 'AI agent', 'First sign-in', 'Last sign-in'].map(title => <th key={title} scope="col">{t(title)}</th>)}</tr></thead>
          <tbody>{shown.map(person => <tr key={person.email}>
            <td><b>{person.name || person.email}</b>{person.role && <span className="admin-role">{t(person.role === 'owner' ? 'Owner' : 'Admin')}</span>}{person.name && <small>{person.email}</small>}</td>
            <td>{person.online ? <><span className="admin-status">{t('Online')}</span>{person.online.board ? <small>{t('on board')} <a href={`/b/${person.online.board.id}`}>{person.online.board.name}</a></small> : <small>{t('on the boards list')}</small>}</>
              : person.lastSeen ? <span title={new Date(person.lastSeen).toLocaleString(locale())}>{ago(person.lastSeen, data.now)}</span> : '—'}</td>
            <td>{person.ownBoards}{person.ownImages > 0 && <small>{plural(person.ownImages, '{count} image', '{count} images')}</small>}</td>
            <td>{person.sharedBoards}</td>
            <td>{person.monthMade ? <>{t('{count} today', { count: person.todayMade })}<small>{t('{count} this month', { count: person.monthMade })}</small></> : '—'}</td>
            {owner && <td>{person.monthUsd ? money(person.monthUsd) : '—'}</td>}
            <td>{person.agentSeen ? <span title={new Date(person.agentSeen).toLocaleString(locale())}>{ago(person.agentSeen, data.now)}</span> : '—'}</td>
            <td>{day(person.joinedAt)}</td>
            <td>{day(person.lastLoginAt)}</td>
          </tr>)}</tbody>
        </table>{!shown.length && <p>{t('Nobody matches.')}</p>}</div>
      </section>
    </>}
  </main>;
}
