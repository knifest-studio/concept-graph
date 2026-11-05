import React, { useEffect, useRef, useState } from 'react';
import { plural, t } from './i18n.mjs';
import { rich } from './i18n-rich.jsx';

const Person = ({ user }) => <span className="cloud-person" style={{ '--person-color': user.color }} title={user.name}>{user.name}</span>;

// For people without a ready Codex: ask a teammate on this board, wait, then generate through theirs.
export function TeammateCodex({ view, onRequest, onWithdraw }) {
  const { outgoing, teammates } = view;
  return <section className="codex-teammates" aria-label={t('Use a teammate’s Codex')}>
    <strong>{t('No Codex? Use a teammate’s')}</strong>
    {outgoing ? <>
      <p>{!outgoing.granted ? rich('Waiting for {name} to allow access…', { name: <b>{outgoing.user.name}</b> }) : outgoing.available ? rich('You generate with {name}’s Codex. Images are credited to you.', { name: <b>{outgoing.user.name}</b> }) : rich('{name}’s Codex is not ready right now. Your access stays until they revoke it or leave.', { name: <b>{outgoing.user.name}</b> })}</p>
      <button type="button" className="codex-link" onClick={onWithdraw}>{outgoing.granted ? t('Stop using their Codex') : t('Cancel request')}</button>
    </> : teammates.length ? <>
      <p>{t('Ask someone on this board to share theirs. You keep access until they revoke it or leave.')}</p>
      <ul>{teammates.map(peer => <li key={peer.id}><Person user={peer.user}/><button type="button" className="codex-link" onClick={() => onRequest(peer.id)}>{t('Ask to use')}</button></li>)}</ul>
    </> : <p>{t('Nobody on this board has Codex connected right now.')}</p>}
  </section>;
}

export function CodexShareMenu({ view, onRequest, onWithdraw, onAllow, onDecline }) {
  const [open, setOpen] = useState(false), container = useRef(null), trigger = useRef(null), panel = useRef(null);
  const { outgoing, incoming, shared } = view, discover = !view.ready && !outgoing && view.teammates.length > 0;
  const visible = incoming.length > 0 || shared.length > 0 || !!outgoing || discover;
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = event => { if (!container.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  if (!visible) return null;
  const label = shared.length ? t('Codex shared · {who}', { who: shared.length === 1 ? shared[0].user.name : plural(shared.length, '{count} person', '{count} people') }) : incoming.length ? incoming.length > 1 ? t('Codex requests · {count}', { count: incoming.length }) : t('Codex request')
    : outgoing ? outgoing.granted ? t('{name}’s Codex', { name: outgoing.user.name }) : t('Asked {name}', { name: outgoing.user.name }) : t('Teammate’s Codex');
  return <div className="codex-share" ref={container} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    event.stopPropagation();
  }}>
    <button ref={trigger} type="button" className={`connection codex-share-button ${shared.length || (outgoing?.granted && outgoing.available) ? 'connected' : ''} ${incoming.length ? 'asking' : ''}`} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? 'codex-share-panel' : undefined} onClick={() => setOpen(value => !value)} data-tooltip={t('Share or borrow Codex on this board')}><span/>{label}</button>
    {open && <div ref={panel} id="codex-share-panel" className="helper-connection-panel codex-share-panel" role="dialog" aria-label={t('Codex sharing')} tabIndex={-1}>
      {incoming.length > 0 && <section><strong>{t('Asking to use your Codex')}</strong>{incoming.map(item => <div className="codex-share-row" key={item.id}><Person user={item.user}/><span><button type="button" className="codex-link" onClick={() => onAllow(item.id)}>{t('Allow')}</button><button type="button" className="codex-link muted" onClick={() => onDecline(item.id)}>{t('Decline')}</button></span></div>)}</section>}
      {shared.length > 0 && <section><strong>{t('Your Codex is shared')}</strong><p>{t('Their generations use your Codex subscription and are credited to them. Access ends when you leave this board.')}</p>
        {shared.map(item => <div className="codex-share-row" key={item.id}><Person user={item.user}/><span>{item.active > 0 && <small>{t('{count} running', { count: item.active })}</small>}<button type="button" className="codex-link muted" onClick={() => onDecline(item.id)}>{t('Revoke')}</button></span></div>)}</section>}
      {(outgoing || discover) && <TeammateCodex view={view} onRequest={onRequest} onWithdraw={onWithdraw}/>}
    </div>}
  </div>;
}

// Non-blocking prompts for the Codex owner; hidden prompts stay answerable from the toolbar menu.
export function CodexRequests({ requests, onAllow, onDecline }) {
  const [hidden, setHidden] = useState(() => new Set());
  const shown = requests.filter(item => !hidden.has(item.id));
  if (!shown.length) return null;
  return <div className="codex-requests" role="region" aria-label={t('Codex access requests')}>{shown.map(item => <div className="codex-request" key={item.id} role="status">
    <p>{rich('{name} wants to use your Codex on this board.', { name: <b>{item.user.name}</b> })}</p>
    <small>{t('Their generations will use your Codex subscription until you revoke access or leave the board.')}</small>
    <div><button type="button" className="primary-button" onClick={() => onAllow(item.id)}>{t('Allow')}</button><button type="button" className="cloud-nav" onClick={() => onDecline(item.id)}>{t('Decline')}</button><button type="button" className="cloud-nav" onClick={() => setHidden(current => new Set([...current, item.id]))}>{t('Not now')}</button></div>
  </div>)}</div>;
}
