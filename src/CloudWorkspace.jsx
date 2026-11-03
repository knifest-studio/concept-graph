import React, { useEffect, useRef, useState } from 'react';
import { ReactFlowProvider, ViewportPortal } from '@xyflow/react';
import * as Y from 'yjs';
import YProvider from 'y-partyserver/provider';
import { applyLocalGraph, readCloudGraph } from './cloud-sync.mjs';
import { CloudGeneration } from './cloud-generation.mjs';
import { boardAuthor } from './annotations.mjs';
import { cloudFeedback } from './feedback.mjs';
import { keepDialogFocus } from './dialog-focus.mjs';
import { coverHue, relativeTime } from './cloud-boards.mjs';
import { fireFeel, mountFeelOverlay, presets } from './feel.mjs';
import { soundPreferenceKey, readSoundPreference, unlockSounds, playSound } from './sounds.mjs';
import './cloud.css';

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function BoardCover({ board }) {
  const [failed, setFailed] = useState([]);
  const covers = (board.covers || []).slice(0, 4).filter(asset => !failed.includes(asset));
  return <div className={`cloud-board-cover covers-${covers.length}`} style={{ '--cover-hue': coverHue(board.id) }} aria-hidden="true">
    {covers.length ? covers.map(asset => <img key={asset} src={`/assets/${encodeURIComponent(asset)}`} alt="" loading="lazy" decoding="async" onError={() => setFailed(current => [...current, asset])}/>) : <span>{Array.from(board.name.trim())[0]?.toLocaleUpperCase() || 'C'}</span>}
  </div>;
}

function BoardsHome({ user, boards, setBoards, services, onOpen, onLogout, theme, toggleTheme, error }) {
  const [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false), [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(false), [name, setName] = useState(''), [busy, setBusy] = useState(false), [createError, setCreateError] = useState('');
  const [now, setNow] = useState(Date.now);
  const input = useRef(null), trigger = useRef(null), createButton = useRef(null), creating = useRef(false), refresh = useRef(null), alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const unmount = mountFeelOverlay();
    let active = true, pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      setNow(Date.now());
      pending = true;
      try {
        const result = await services.api('/api/cloud/boards');
        if (active) { if (!creating.current) setBoards(result.boards); setLoaded(true); setLoadError(''); }
      } catch (failure) { if (active) setLoadError(failure.message); }
      finally { pending = false; if (active) setLoading(false); }
    };
    refresh.current = load;
    load();
    const timer = setInterval(load, 30000);
    window.addEventListener('focus', load); document.addEventListener('visibilitychange', load);
    return () => { active = false; alive.current = false; clearInterval(timer); window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', load); unmount(); };
  }, [services, setBoards]);
  useEffect(() => { if (editing && !busy) input.current?.focus(); }, [editing, busy]);
  const start = event => { trigger.current = event.currentTarget; setEditing(true); setCreateError(''); input.current?.focus(); };
  const cancel = (restore = true) => { if (creating.current) return; setEditing(false); setName(''); setCreateError(''); if (restore) (trigger.current?.isConnected ? trigger.current : createButton.current)?.focus(); };
  const create = async event => {
    event.preventDefault();
    if (creating.current) return;
    creating.current = true; setBusy(true); setCreateError('');
    const element = event.currentTarget, soundKey = soundPreferenceKey(`cloud:${user.name}`);
    const sounds = () => readSoundPreference(localStorage, soundKey);
    if (sounds()) unlockSounds();
    try {
      const { board } = await services.api('/api/cloud/boards', json('POST', { name: name.trim() || 'Untitled board' }));
      if (!alive.current) return;
      setBoards(current => [board, ...current.filter(item => item.id !== board.id)]);
      fireFeel('create', { element });
      if (sounds()) playSound(presets.create.sound, sounds);
      onOpen(board.id);
    } catch (failure) { if (alive.current) { setCreateError(failure.message); input.current?.focus(); } }
    finally { creating.current = false; if (alive.current) setBusy(false); }
  };
  const newBoard = <>{editing ? <form className="cloud-new-editor" onSubmit={create} aria-busy={busy} onBlur={event => { if (!name.trim() && !event.currentTarget.contains(event.relatedTarget)) cancel(false); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } }}>
    <span className="cloud-new-plus" aria-hidden="true">+</span><label htmlFor="new-cloud-board">New board</label>
    <input ref={input} id="new-cloud-board" placeholder="Board name" maxLength={80} value={name} disabled={busy} aria-describedby={createError ? 'cloud-create-error' : 'cloud-create-hint'} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}/>
    <small id="cloud-create-hint">Enter to create · Esc to cancel</small>
    {createError && <p id="cloud-create-error" className="cloud-error" role="alert">{createError}</p>}
    <div><button type="button" className="cloud-nav" disabled={busy} onClick={cancel}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? 'Creating…' : 'Create board'}</button></div>
  </form> : <button type="button" className="cloud-new-tile" onClick={start}><span className="cloud-new-plus" aria-hidden="true">+</span><strong>New board</strong><small>Start a new direction</small></button>}</>;
  return <div className="cloud-home">
    <header className="app-header cloud-home-header"><div className="brand"><img src="/favicon.svg" alt=""/><strong>Concept Graph</strong></div><div className="header-right">
      <span className="cloud-person cloud-home-user" style={{ '--person-color': user.color }} title={`Signed in as ${user.name}`}>{user.name}</span>
      <button className="theme-button" type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={toggleTheme}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{theme === 'dark' ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></> : <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>}</svg></button>
      <button type="button" className="cloud-home-signout" onClick={onLogout}>Sign out</button>
    </div></header>
    <main className="cloud-home-main"><div className="cloud-home-heading"><div><h1>Team boards</h1><p>Shared with everyone who signs in.</p></div><button ref={createButton} type="button" className="primary-button" onClick={start}><span aria-hidden="true">+</span> New board</button></div>
      {(error || loadError) && <p role="alert" className="cloud-error cloud-home-error">{error || loadError}{loadError && <button type="button" onClick={() => refresh.current?.()}>Try again</button>}</p>}
      {loading && !boards.length && !editing ? <p role="status" className="cloud-home-status">Loading boards…</p> : <>
        {loaded && !boards.length && !editing && <section className="cloud-boards-empty"><div className="empty-glyph" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="7" height="7" rx="2"/><rect x="14" y="13" width="7" height="7" rx="2"/><path d="M10 7.5h4a3 3 0 0 1 3 3V13M7 15v6m-3-3h6"/></svg></div><h2>No boards yet</h2><p>Create the first board for your team.</p><button type="button" className="primary-button" onClick={start}>+ New board</button></section>}
        {(loaded || boards.length > 0 || editing) && <div className="cloud-board-grid" aria-label="Team boards">{newBoard}{[...boards].sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt)).map((board, index) => {
          const updated = board.updatedAt || board.createdAt;
          return <div className="cloud-board-entry" key={board.id} style={{ '--card-delay': `${Math.min(index, 7) * 40}ms` }}><button type="button" className="cloud-board-tile" aria-label={`Open board ${board.name}`} onClick={() => onOpen(board.id)}><BoardCover board={board}/><div className="cloud-board-info"><strong>{board.name}</strong><small>{Number.isInteger(board.imageCount) && `${board.imageCount} image${board.imageCount === 1 ? '' : 's'} · `}updated <time dateTime={updated} title={new Date(updated).toLocaleString()}>{relativeTime(updated, now)}</time></small><span className="cloud-board-open" aria-hidden="true">Open board <span>↗</span></span></div></button></div>;
        })}</div>}
      </>}
    </main>
  </div>;
}

function Cursors({ peers }) {
  return <ViewportPortal>{peers.filter(peer => Number.isFinite(peer.cursor?.x) && Number.isFinite(peer.cursor?.y)).map(peer => <div className="cloud-cursor" key={peer.id} style={{ transform: `translate(${peer.cursor.x}px, ${peer.cursor.y}px)`, color: peer.user.color }}>
    <svg width="18" height="23" viewBox="0 0 18 23" fill="currentColor" aria-hidden="true"><path d="M1 1 16 13l-7 1-3 7Z" stroke="white" strokeWidth="1.5"/></svg><span style={{ background: peer.user.color }}>{peer.user.name}</span>
  </div>)}</ViewportPortal>;
}

function CloudBoard({ boardId, user: account, paired, pairing, pairCancel, helperStatus, openPair, unpair, onBack, onLogout, services, Editor, ...editorProps }) {
  const user = boardAuthor(account) || { name: 'Teammate' };
  const [session, setSession] = useState(null), [connection, setConnection] = useState('connecting'), [peers, setPeers] = useState([]), [error, setError] = useState('');
  useEffect(() => {
    const doc = new Y.Doc(), origin = {};
    const provider = new YProvider(location.host, boardId, doc, { party: 'board-room', disableBc: true, protocol: location.protocol === 'https:' ? 'wss' : 'ws' });
    const undo = new Y.UndoManager([doc.getMap('nodes'), doc.getMap('edges'), doc.getMap('groups'), doc.getMap('pages')], { trackedOrigins: new Set([origin]) });
    const next = {
      doc, provider, undo, origin, user, paired, openPair, unpair,
      read: local => readCloudGraph(doc, local),
      apply: (graph, before) => applyLocalGraph(doc, graph, before, origin),
      subscribe: callback => {
        const listener = transaction => {
          if (!transaction.changed.size || transaction.origin === origin) return;
          callback(cloudFeedback(transaction, provider, doc.clientID, next.feedbackLive));
        };
        doc.on('afterTransaction', listener);
        return () => doc.off('afterTransaction', listener);
      },
    };
    next.jobs = new CloudGeneration({ doc, boardId, user, ...services, ready: () => provider.synced && provider.wsconnected, onStart: run => next.onOwnRun?.(run.id), onError: (message, failure) => { setError(message); if (failure?.status === 403) unpair(); } });
    let lastPointer = 0, lastSelection = '';
    next.pointer = position => {
      if (document.hidden) position = null;
      if (position && Date.now() - lastPointer < 110) return;
      lastPointer = Date.now(); provider.awareness.setLocalStateField('cursor', position);
    };
    next.page = page => { if (provider.awareness.getLocalState()?.page !== page) provider.awareness.setLocalStateField('page', page); };
    next.selection = selection => {
      const value = JSON.stringify(selection);
      if (value !== lastSelection) { lastSelection = value; provider.awareness.setLocalStateField('selection', selection); }
    };
    // The room forgets presence when it hibernates, so greet each newcomer with our state again.
    const greet = ({ added }) => { const local = provider.awareness.getLocalState(); if (local && added.some(id => id !== doc.clientID)) provider.awareness.setLocalState({ ...local }); };
    const presence = () => setPeers([...provider.awareness.getStates()].filter(([id, state]) => id !== doc.clientID && state.user).map(([id, state]) => ({ id, ...state })));
    const status = ({ status }) => { if (status !== 'connected') next.feedbackLive = false; setConnection(status === 'connected' ? (provider.synced ? 'live' : 'connecting') : status === 'connecting' ? 'connecting' : 'offline'); };
    const sync = synced => { next.feedbackLive = synced; if (synced) { next.loaded = true; setConnection('live'); } };
    const hidden = () => { if (document.hidden) next.pointer(null); };
    provider.awareness.setLocalState({ user, cursor: null });
    provider.awareness.on('change', presence); provider.awareness.on('change', greet); provider.on('status', status); provider.on('sync', sync);
    document.addEventListener('visibilitychange', hidden);
    setSession(next);
    return () => {
      next.flush?.(); next.closed = true;
      next.jobs.stop(); provider.awareness.setLocalState(null);
      document.removeEventListener('visibilitychange', hidden);
      provider.awareness.off('change', presence); provider.awareness.off('change', greet); provider.off('status', status); provider.off('sync', sync);
      undo.destroy(); provider.destroy(); doc.destroy();
    };
  }, [boardId, user.name, user.color]);
  useEffect(() => {
    if (!session || !paired) return;
    session.jobs.startPolling();
    return () => session.jobs.stop();
  }, [session, paired]);
  if (!session) return <div className="startup">Connecting to board…</div>;
  Object.assign(session, { paired, pairing, pairCancel, helperStatus, connection, peers, error });
  session.cursors = visible => <Cursors peers={peers.filter(visible)}/>;
  session.toolbar = <>
    <div className="cloud-presence" aria-label="People on this board">{[{ id: 'me', user }, ...peers].map(peer => <span key={peer.id} className="cloud-person" title={peer.user.name} style={{ '--person-color': peer.user.color }}>{peer.user.name}</span>)}</div>
    <button className="cloud-nav" onClick={() => session.leave?.(onBack)}>Boards</button><button className="cloud-nav" onClick={() => session.leave?.(onLogout)}>Sign out</button>
  </>;
  return <ReactFlowProvider><Editor key={boardId} boardId={boardId} cloudSession={session} {...editorProps}/></ReactFlowProvider>;
}

export default function CloudWorkspace({ Editor, HelperSetup, services }) {
  const [user, setUser] = useState(undefined), [boards, setBoards] = useState([]), [boardId, setBoardId] = useState(null);
  const [devLogin, setDevLogin] = useState(false), [email, setEmail] = useState(''), [name, setName] = useState('');
  const [error, setError] = useState(() => new Map([
    ['unavailable', 'Google sign-in is not configured.'], ['cancelled', 'Google sign-in was cancelled.'],
    ['failed', 'Google sign-in failed. Please try again.']
  ]).get(new URLSearchParams(window.location.search).get('auth_error')) || ''), [busy, setBusy] = useState(false);
  const [helperCode, setHelperCode] = useState(() => sessionStorage.getItem('concept-graph-helper-token') || '');
  const [pairing, setPairing] = useState(false), [paired, setPaired] = useState(false), [pairBusy, setPairBusy] = useState(false), [pairError, setPairError] = useState(''), [helperStatus, setHelperStatus] = useState({});
  const [pairCancel, setPairCancel] = useState(0);
  const [showAllBuilds, setShowAllBuilds] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('concept-graph-theme') === 'dark' ? 'dark' : 'light');
  const pendingRun = useRef(null);
  useEffect(() => { localStorage.setItem('concept-graph-theme', theme); document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    services.api('/api/cloud/me').then(result => setUser(result.user)).catch(failure => { setUser(null); if (failure.status !== 401) setError(failure.message); });
    services.api('/api/auth/config').then(result => setDevLogin(result.devLogin === true)).catch(() => {});
    const url = new URL(window.location.href);
    if (url.searchParams.has('auth_error')) { url.searchParams.delete('auth_error'); window.history.replaceState(null, '', url.href); }
  }, []);
  const pair = async token => {
    setPairBusy(true); setPairError('');
    try { setHelperStatus(await services.pair(token)); setPaired(true); setPairing(false); }
    catch (failure) { setPairError(failure.message || 'Could not reach the local helper. Start it and allow local network access.'); }
    finally { setPairBusy(false); }
  };
  useEffect(() => { if (helperCode) pair(helperCode); }, []);
  useEffect(() => {
    if (paired && pendingRun.current) { const run = pendingRun.current; pendingRun.current = null; run(); }
  }, [paired]);
  const openPair = (callback, downloads = false) => { pendingRun.current = callback || null; setShowAllBuilds(downloads); setPairing(true); };
  const cancelPair = () => { setPairing(false); pendingRun.current = null; setPairCancel(value => value + 1); };
  const unpair = (rejected = true) => {
    services.unpair(); setHelperCode(''); setPaired(false); setHelperStatus({});
    if (!rejected) { pendingRun.current = null; setPairCancel(value => value + 1); }
    setPairError(rejected ? 'The helper pairing code was rejected. Enter its current code.' : '');
  };
  const signIn = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await services.api('/api/auth/dev', json('POST', { email, name: name.trim() })); setUser(result.user); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const signOut = async () => {
    try { await services.api('/api/cloud/logout', { method: 'POST' }); setBoardId(null); setUser(null); setBoards([]); setError(''); }
    catch (failure) { setError(failure.message); }
  };
  if (user === undefined) return <div className="startup">Checking sign-in…</div>;
  if (!user) return <main className="cloud-startup"><section className="cloud-card"><img src="/favicon.svg" alt="" width="40"/><h1>Concept Graph Cloud</h1><p>Sign in with Google to access all shared boards.</p>
    {error && <p role="alert" className="cloud-error">{error}</p>}
    <a className="primary-button" href="/api/auth/google" style={{ display: 'inline-block', textDecoration: 'none' }}>Sign in with Google</a>
    <p><a className="cloud-nav" href="/privacy">Privacy</a></p>
    {devLogin && <form onSubmit={signIn}><p>Local development sign-in</p>
      <label htmlFor="cloud-name">Display name</label><input id="cloud-name" autoComplete="nickname" required maxLength={40} value={name} onChange={event => setName(event.target.value)}/>
      <label htmlFor="cloud-email">Email</label><input id="cloud-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)}/>
      <button className="primary-button" disabled={busy || !name.trim() || !email.trim()}>{busy ? 'Signing in…' : 'Sign in locally'}</button>
    </form>}</section></main>;
  return <>
    {boardId ? <CloudBoard key={boardId} boardId={boardId} user={user} paired={paired} pairing={pairing} pairCancel={pairCancel} helperStatus={helperStatus} openPair={openPair} unpair={unpair} onBack={() => setBoardId(null)} onLogout={signOut} services={services} Editor={Editor} boards={boards} updateBoards={setBoards} selectBoard={setBoardId} theme={theme} toggleTheme={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} waitForPreferences={async () => {}}/> :
      <BoardsHome user={user} boards={boards} setBoards={setBoards} services={services} onOpen={setBoardId} onLogout={signOut} theme={theme} toggleTheme={() => setTheme(current => current === 'dark' ? 'light' : 'dark')} error={error}/>}
    {pairing && <div className="cloud-pair-overlay" role="dialog" aria-modal="true" aria-label="Pair local helper" onKeyDown={event => { keepDialogFocus(event); if (event.key === 'Escape') cancelPair(); }}><button className="cloud-pair-close" autoFocus onClick={cancelPair}>Back to board</button><HelperSetup cloudMode showAllBuilds={showAllBuilds} code={helperCode} setCode={setHelperCode} connecting={pairBusy} error={pairError} connect={pair}/></div>}
    {error && boardId && <div className="toast" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
  </>;
}
