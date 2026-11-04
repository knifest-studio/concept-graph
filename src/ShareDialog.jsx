import React, { useEffect, useRef, useState } from 'react';
import { keepDialogFocus } from './dialog-focus.mjs';
import { accessNames, boardPath, roleNames } from './cloud-boards.mjs';

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const accessHelp = {
  private: 'Only you and the people you invite can open it.',
  link: 'Anyone signed in who has the link can open it. It isn’t listed for anyone else.',
  everyone: 'Everyone who signs in to this site can open it from Shared with you.',
};
const roleOptions = <><option value="edit">Can edit</option><option value="view">Can view</option></>;

// The owner invites people by email and chooses what the link allows; everyone else sees who has access. No email is
// sent: the owner shares the link, and an invited person sees the board after signing in with that address.
export function ShareDialog({ boardId, name, sharing: initial, services, onChange, onClose }) {
  const [sharing, setSharing] = useState(initial), [email, setEmail] = useState(''), [role, setRole] = useState('edit');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState('');
  const path = `/api/cloud/boards/${encodeURIComponent(boardId)}/sharing`, first = useRef(null), latest = useRef(onChange); latest.current = onChange;
  const show = value => { setSharing(value); latest.current(value); };
  useEffect(() => {
    first.current?.focus();
    // Access may have changed since the board was opened.
    let active = true;
    services.api(path).then(result => { if (active) show(result.sharing); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const change = async (update, done) => {
    setBusy(true); setError('');
    try { show((await services.api(path, json('PATCH', update))).sharing); done?.(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const invite = event => { event.preventDefault(); if (email.trim() && !busy) change({ member: { email: email.trim(), role } }, () => setEmail('')); };
  const copy = async () => {
    const link = new URL(boardPath(boardId), location.origin).href;
    try { await navigator.clipboard.writeText(link); setCopied('Link copied.'); }
    catch { setCopied(link); }
  };
  const manage = sharing.canManage, owner = sharing.owner, open = sharing.access !== 'private';
  // Keys, copying and pasting stay in the dialog instead of reaching the board's shortcuts.
  return <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="share-title" onKeyDown={event => { keepDialogFocus(event); event.stopPropagation(); if (event.key === 'Escape') onClose(); }} onCopy={event => event.stopPropagation()} onPaste={event => event.stopPropagation()}>
    <div className="share-card">
      <h2 id="share-title">Share “{name}”</h2>
      {manage ? <form className="share-invite" onSubmit={invite}>
        <label htmlFor="share-email">Invite by email</label>
        <div><input ref={first} id="share-email" type="email" autoComplete="off" placeholder="name@example.com" maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)}/>
          <select aria-label="Role for the invited person" value={role} disabled={busy} onChange={event => setRole(event.target.value)}>{roleOptions}</select>
          <button className="primary-button" disabled={busy || !email.trim()}>Invite</button></div>
        <small>No email is sent. Copy the link and send it; they see the board after signing in with this address.</small>
      </form> : <p className="share-note">{owner && <>Owned by <b>{owner.name || 'someone else'}</b>. </>}You can {sharing.role === 'view' ? 'view' : 'edit'} this board. {owner ? 'Only its owner can change who has access.' : 'It was made before sharing and has no owner, so nobody can change who has access.'}</p>}
      {error && <p className="cloud-error share-error" role="alert">{error}</p>}
      <h3>People with access</h3>
      <ul className="share-people">
        {owner && <li><span><b>{owner.name || 'Owner'}</b>{manage && <small>{owner.email} · you</small>}</span><span className="share-role">Owner</span></li>}
        {sharing.members.map((member, index) => manage ? <li key={member.email}><span><b>{member.name || member.email}</b><small>{member.name ? member.email : 'Hasn’t opened it yet'}</small></span>
          <span><select aria-label={`Role for ${member.email}`} value={member.role} disabled={busy} onChange={event => change({ member: { email: member.email, role: event.target.value } })}>{roleOptions}</select>
            <button type="button" className="share-remove" aria-label={`Remove ${member.email}`} disabled={busy} onClick={() => change({ member: { email: member.email, role: null } })}>Remove</button></span></li>
          : <li key={index}><span><b>{member.name}</b></span><span className="share-role">{roleNames[member.role]}</span></li>)}
        {sharing.pending > 0 && <li className="share-muted">{sharing.pending} invited {sharing.pending === 1 ? 'person hasn’t' : 'people haven’t'} opened it yet</li>}
        {manage && !sharing.members.length && <li className="share-muted">Nobody invited yet.</li>}
      </ul>
      <h3>General access</h3>
      <div className="share-access">
        {manage ? <div><select aria-label="Who can open this board" value={sharing.access} disabled={busy} onChange={event => change({ access: event.target.value })}>{Object.entries(accessNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          {open && <select aria-label="What they can do" value={sharing.linkRole} disabled={busy} onChange={event => change({ linkRole: event.target.value })}>{roleOptions}</select>}</div>
          : <strong>{accessNames[sharing.access]}{open && ` · ${roleNames[sharing.linkRole].toLowerCase()}`}</strong>}
        <small>{sharing.access === 'private' && !manage ? 'Only its owner and the people they invite can open it.' : accessHelp[sharing.access]}</small>
      </div>
      <div className="share-actions"><button ref={manage ? undefined : first} type="button" className="share-copy" onClick={copy}>Copy link</button><span role="status">{copied}</span><button className="primary-button" type="button" onClick={onClose}>Done</button></div>
    </div>
  </div>;
}
