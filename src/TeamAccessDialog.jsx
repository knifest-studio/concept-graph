import React, { useEffect, useMemo, useRef, useState } from 'react';
import { keepDialogFocus } from './dialog-focus.mjs';
import { plural, t } from './i18n.mjs';

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const domainOf = address => `@${address.split('@').pop()}`;

// Site admins choose who may generate with the team's Gemini and OpenAI keys; the site owner also chooses the admins.
// People are listed once they have signed in; anyone else can be added by email, and a whole domain as @example.com.
export function TeamAccessDialog({ services, onClose }) {
  const [access, setAccess] = useState(null), [entry, setEntry] = useState(''), [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const first = useRef(null), list = useRef(null), [more, setMore] = useState(false);
  useEffect(() => {
    first.current?.focus();
    let active = true;
    services.api('/api/cloud/team').then(result => { if (active) setAccess(result.access); }).catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, []);
  const change = async (update, done) => {
    setBusy(true); setError('');
    try { setAccess((await services.api('/api/cloud/team', json('PATCH', update))).access); done?.(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const add = event => { event.preventDefault(); if (entry.trim() && !busy) change({ nano: { entry: entry.trim(), allowed: true } }, () => setEntry('')); };
  // Everyone who signed in, most recent first, plus people given access or made admins before signing in. Only the owner
  // moves to the top, so a row never jumps away under the pointer when it is toggled.
  const { domains, people } = useMemo(() => {
    if (!access) return { domains: [], people: [] };
    const entries = new Set(access.nano.map(item => item.entry)), admins = new Set(access.admins.map(item => item.email)), byEmail = new Map(access.people.map(person => [person.email, person]));
    for (const address of [access.owner, ...admins, ...access.nano.map(item => item.entry).filter(item => !item.startsWith('@'))]) if (address && !byEmail.has(address)) byEmail.set(address, { email: address, waiting: true });
    return { domains: access.nano.filter(item => item.entry.startsWith('@')).map(item => item.entry),
      people: [...byEmail.values()].map(person => ({ ...person, direct: entries.has(person.email), domain: entries.has(domainOf(person.email)) ? domainOf(person.email) : null,
        admin: admins.has(person.email), owner: person.email === access.owner, used: access.usedToday[person.email] || 0 })).sort((a, b) => b.owner - a.owner) };
  }, [access]);
  // A fade at the bottom of the list while more people sit below the visible rows, so it is clear the list scrolls.
  const checkMore = () => { const node = list.current; setMore(!!node && node.scrollTop + node.clientHeight < node.scrollHeight - 2); };
  useEffect(() => {
    const node = list.current; if (!node) return;
    checkMore();
    const observer = new ResizeObserver(checkMore); observer.observe(node);
    return () => observer.disconnect();
  }, [access, filter]);
  const owner = access?.role === 'owner', query = filter.trim().toLowerCase(), shown = people.filter(person => !query || person.email.includes(query) || person.name?.toLowerCase().includes(query));
  return <div className="board-modal" data-analytics-area="dialog:Team access" role="dialog" aria-modal="true" aria-labelledby="team-title" onKeyDown={event => { keepDialogFocus(event); event.stopPropagation(); if (event.key === 'Escape') onClose(); }}>
    <div className="share-card team-card">
      <h2 id="team-title">{t('Team access')}</h2>
      <p className="share-note">{owner ? t('Choose who can generate with Nano Banana and GPT Image on the team’s API keys, and who else can manage this.') : t('Choose who can generate with Nano Banana and GPT Image on the team’s API keys.')}</p>
      <form className="share-invite team-add" onSubmit={add}>
        <label htmlFor="team-entry">{t('Give Nano Banana and GPT Image access')}</label>
        <div><input ref={first} id="team-entry" autoComplete="off" placeholder="name@example.com, @example.com" maxLength={254} value={entry} disabled={busy} onChange={event => setEntry(event.target.value)}/>
          <button className="primary-button" disabled={busy || !entry.trim()}>{t('Add')}</button></div>
        <small>{t('People appear below once they sign in. A domain such as @example.com gives everyone with that address access.')}</small>
      </form>
      {error && <p className="cloud-error share-error" role="alert">{error}</p>}
      {!access && !error && <p className="share-note" role="status">{t('Loading…')}</p>}
      {domains.length > 0 && <><h3>{t('Domains')}</h3><ul className="share-people">{domains.map(domain => <li key={domain}><span><b>{t('Everyone at {domain}', { domain })}</b></span>
        <span><button type="button" className="share-remove" aria-label={t('Remove {email}', { email: domain })} disabled={busy} onClick={() => change({ nano: { entry: domain, allowed: false } })}>{t('Remove')}</button></span></li>)}</ul></>}
      {access && <><div className="team-people-heading"><h3>{t('People')}</h3>{people.length > 8 && <input type="search" aria-label={t('Find a person')} placeholder={t('Find a person')} value={filter} onChange={event => setFilter(event.target.value)}/>}</div>
        <div className={`team-people-wrap${more ? ' has-more' : ''}`}><ul ref={list} className="share-people team-people" onScroll={checkMore}>
          {shown.map(person => <li key={person.email}>
            <span><b>{person.name || person.email}</b><small>{[person.name && person.email, person.waiting && t('Hasn’t signed in yet'), person.used > 0 && plural(person.used, '{count} image today', '{count} images today')].filter(Boolean).join(' · ')}</small></span>
            <span>
              <label className="team-toggle" title={!person.direct && person.domain ? t('Through {domain}', { domain: person.domain }) : undefined}><input type="checkbox" aria-label={t('Nano Banana and GPT Image for {name}', { name: person.name || person.email })} checked={person.direct || !!person.domain} disabled={busy || (!person.direct && !!person.domain)}
                onChange={event => change({ nano: { entry: person.email, allowed: event.target.checked } })}/>Nano Banana / GPT Image</label>
              {person.owner ? <span className="share-role">{t('Owner')}</span> : owner ? <label className="team-toggle"><input type="checkbox" aria-label={t('Admin rights for {name}', { name: person.name || person.email })} checked={person.admin} disabled={busy}
                onChange={event => change({ admin: { email: person.email, admin: event.target.checked } })}/>{t('Admin')}</label> : person.admin && <span className="share-role">{t('Admin')}</span>}
            </span></li>)}
          {!shown.length && <li className="share-muted">{query ? t('Nobody matches.') : t('Nobody has signed in yet.')}</li>}
        </ul></div></>}
      {owner && access.imported?.entries > 0 && <p className="share-note team-imported">{t('This list started as a copy of NANO_BANANA_ALLOWED. The site no longer reads that variable, so you can delete it in Cloudflare.')}</p>}
      <div className="share-actions"><span/><button className="primary-button" type="button" onClick={onClose}>{t('Done')}</button></div>
    </div>
  </div>;
}
