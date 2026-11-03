import React, { useEffect, useRef, useState } from 'react';

const Person = ({ user }) => <span className="cloud-person" style={{ '--person-color': user.color }} title={user.name}>{user.name}</span>;

// For people without a ready Codex: ask a teammate on this board, wait, then generate through theirs.
export function TeammateCodex({ view, onRequest, onWithdraw }) {
  const { outgoing, teammates } = view;
  return <section className="codex-teammates" aria-label="Use a teammate’s Codex">
    <strong>No Codex? Use a teammate’s</strong>
    {outgoing ? <>
      <p>{!outgoing.granted ? <>Waiting for <b>{outgoing.user.name}</b> to allow access…</> : outgoing.available ? <>You generate with <b>{outgoing.user.name}</b>’s Codex. Images are credited to you.</> : <><b>{outgoing.user.name}</b>’s Codex is not ready right now. Your access stays until they revoke it or leave.</>}</p>
      <button type="button" className="codex-link" onClick={onWithdraw}>{outgoing.granted ? 'Stop using their Codex' : 'Cancel request'}</button>
    </> : teammates.length ? <>
      <p>Ask someone on this board to let you generate with their Codex. Access lasts until they revoke it or leave the board.</p>
      <ul>{teammates.map(peer => <li key={peer.id}><Person user={peer.user}/><button type="button" className="codex-link" onClick={() => onRequest(peer.id)}>Ask to use</button></li>)}</ul>
    </> : <p>Nobody on this board has Codex connected right now.</p>}
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
  const label = shared.length ? `Codex shared · ${shared.length === 1 ? shared[0].user.name : `${shared.length} people`}` : incoming.length ? `Codex request${incoming.length > 1 ? `s · ${incoming.length}` : ''}`
    : outgoing ? outgoing.granted ? `${outgoing.user.name}’s Codex` : `Asked ${outgoing.user.name}` : 'Teammate’s Codex';
  return <div className="codex-share" ref={container} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    event.stopPropagation();
  }}>
    <button ref={trigger} type="button" className={`connection codex-share-button ${shared.length || (outgoing?.granted && outgoing.available) ? 'connected' : ''} ${incoming.length ? 'asking' : ''}`} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? 'codex-share-panel' : undefined} onClick={() => setOpen(value => !value)} data-tooltip="Share or borrow Codex on this board"><span/>{label}</button>
    {open && <div ref={panel} id="codex-share-panel" className="helper-connection-panel codex-share-panel" role="dialog" aria-label="Codex sharing" tabIndex={-1}>
      {incoming.length > 0 && <section><strong>Asking to use your Codex</strong>{incoming.map(item => <div className="codex-share-row" key={item.id}><Person user={item.user}/><span><button type="button" className="codex-link" onClick={() => onAllow(item.id)}>Allow</button><button type="button" className="codex-link muted" onClick={() => onDecline(item.id)}>Decline</button></span></div>)}</section>}
      {shared.length > 0 && <section><strong>Your Codex is shared</strong><p>Their generations use your Codex subscription and are credited to them. Access ends when you leave this board.</p>
        {shared.map(item => <div className="codex-share-row" key={item.id}><Person user={item.user}/><span>{item.active > 0 && <small>{item.active} running</small>}<button type="button" className="codex-link muted" onClick={() => onDecline(item.id)}>Revoke</button></span></div>)}</section>}
      {(outgoing || discover) && <TeammateCodex view={view} onRequest={onRequest} onWithdraw={onWithdraw}/>}
    </div>}
  </div>;
}

// Non-blocking prompts for the Codex owner; hidden prompts stay answerable from the toolbar menu.
export function CodexRequests({ requests, onAllow, onDecline }) {
  const [hidden, setHidden] = useState(() => new Set());
  const shown = requests.filter(item => !hidden.has(item.id));
  if (!shown.length) return null;
  return <div className="codex-requests" role="region" aria-label="Codex access requests">{shown.map(item => <div className="codex-request" key={item.id} role="status">
    <p><b>{item.user.name}</b> wants to use your Codex on this board.</p>
    <small>Their generations will use your Codex subscription until you revoke access or leave the board.</small>
    <div><button type="button" className="primary-button" onClick={() => onAllow(item.id)}>Allow</button><button type="button" className="cloud-nav" onClick={() => onDecline(item.id)}>Decline</button><button type="button" className="cloud-nav" onClick={() => setHidden(current => new Set([...current, item.id]))}>Not now</button></div>
  </div>)}</div>;
}
