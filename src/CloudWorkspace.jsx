import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LanguageSelect } from './LanguageSelect.jsx';
import { Preferences } from './Preferences.jsx';
import { useWaitingVideos } from './PendingNode.jsx';
import { plural, t } from './i18n.mjs';
import { rich } from './i18n-rich.jsx';
import { loopbackBlocked } from './platform-detection.mjs';
import { ReactFlowProvider, ViewportPortal } from '@xyflow/react';
import * as Y from 'yjs';
import YProvider from 'y-partyserver/provider';
import * as encoding from 'lib0/encoding';
import { encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { applyLocalGraph, CloudGraphReader } from './cloud-sync.mjs';
import { CloudGeneration } from './cloud-generation.mjs';
import { CodexSharing, sharingMessage } from './codex-sharing.mjs';
import { CodexRequests, CodexShareMenu, TeammateCodex } from './CodexSharing.jsx';
import { boardAuthor } from './annotations.mjs';
import { generators } from '../graph.mjs';
import { terminalRun } from './run-outputs.mjs';
import { cloudFeedback } from './feedback.mjs';
import { sharedPreviews } from './canvas-thumbnails.mjs';
import { keepDialogFocus } from './dialog-focus.mjs';
import { accessBadges, boardFromPath, boardPath, coverHue, relativeTime, roleNames } from './cloud-boards.mjs';
import { deleteBoardTemplate, readBoardTemplates, saveBoardTemplate } from './board-templates.mjs';
import { ShareDialog } from './ShareDialog.jsx';
import { VersionHistory } from './VersionHistory.jsx';
import { AttentionCard, AttentionPings } from './AttentionCall.jsx';
import { TeamAccessDialog } from './TeamAccessDialog.jsx';
import { AccountMenu } from './AccountMenu.jsx';
import { defaultPages } from './pages.mjs';
import { BoardPresence } from './BoardPresence.jsx';
import { BoardChatPanel, ChatButton } from './BoardChat.jsx';
import { VoiceAudio, VoiceControl } from './BoardVoice.jsx';
import { ChatClient } from './board-chat.mjs';
import { cloudVoice } from './cloud-voice.mjs';
import { fireFeel, mountFeelOverlay, presets } from './feel.mjs';
import { soundPreferenceKey, readSoundPreference, writeSoundPreference, unlockSounds, playSound } from './sounds.mjs';
import './cloud.css';

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
// Page names for the people list; a board that never stored pages has only the first one.
const presencePages = doc => {
  const pages = [...doc.getMap('pages')].filter(([, page]) => typeof page?.name === 'string').sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0)).map(([id, page]) => ({ id, name: page.name }));
  return pages.length ? pages : defaultPages();
};
sharedPreviews.enabled = true;
const agoForms = { year: ['{count} year ago', '{count} years ago'], month: ['{count} month ago', '{count} months ago'], day: ['{count} day ago', '{count} days ago'], hour: ['{count} hour ago', '{count} hours ago'], minute: ['{count} minute ago', '{count} minutes ago'] };
const timeWords = { recently: t('recently'), now: t('just now'), ago: (count, unit) => plural(count, ...agoForms[unit]) };

function BoardCover({ board }) {
  const [failed, setFailed] = useState([]);
  const covers = (board.covers || []).slice(0, 4).filter(asset => !failed.includes(asset));
  // Covers use the stored small preview when there is one, and fall back to the original once.
  return <div className={`cloud-board-cover covers-${covers.length}`} style={{ '--cover-hue': coverHue(board.id) }} aria-hidden="true">
    {covers.length ? covers.map(asset => <img key={asset} src={`/assets/${encodeURIComponent(asset)}${failed.includes(`${asset}/thumb`) ? '' : '/thumb'}`} alt="" loading="lazy" decoding="async" onError={() => setFailed(current => [...current, current.includes(`${asset}/thumb`) ? asset : `${asset}/thumb`])}/>) : <span>{Array.from(board.name.trim())[0]?.toLocaleUpperCase() || 'C'}</span>}
  </div>;
}

function BoardAccess({ board }) {
  return <span className="cloud-board-access"><span className={`cloud-access-badge ${board.access || 'private'}`}>{t(accessBadges[board.access] || accessBadges.private)}</span>
    {board.role !== 'owner' && <span>{t(roleNames[board.role] || roleNames.view)}{board.ownerName ? ` · ${board.ownerName}` : ''}</span>}</span>;
}

function BoardsHome({ user, siteRole, boards, setBoards, services, onOpen, onLogout, theme, toggleTheme, error }) {
  const [teamOpen, setTeamOpen] = useState(false);
  const waiting = useWaitingVideos(`cloud:${user.name}`), soundKey = soundPreferenceKey(`cloud:${user.name}`);
  const [sounds, setSounds] = useState(() => readSoundPreference(localStorage, soundKey));
  const toggleSounds = () => { const next = !sounds; writeSoundPreference(localStorage, soundKey, next); setSounds(next); if (next) unlockSounds(); };
  const [loading, setLoading] = useState(true), [loaded, setLoaded] = useState(false), [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(false), [name, setName] = useState(''), [busy, setBusy] = useState(false), [createError, setCreateError] = useState('');
  const [now, setNow] = useState(Date.now);
  const [trash, setTrash] = useState([]), [restoring, setRestoring] = useState(null), [trashError, setTrashError] = useState('');
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
        const [result, deleted] = await Promise.all([services.api('/api/cloud/boards'), services.api('/api/cloud/trash').catch(() => null)]);
        if (active) { if (!creating.current) setBoards(result.boards); if (deleted) setTrash(deleted.boards); setLoaded(true); setLoadError(''); }
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
    <span className="cloud-new-plus" aria-hidden="true">+</span><label htmlFor="new-cloud-board">{t('New board')}</label>
    <input ref={input} id="new-cloud-board" placeholder={t('Board name')} maxLength={80} value={name} disabled={busy} aria-describedby={createError ? 'cloud-create-error' : 'cloud-create-hint'} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}/>
    <small id="cloud-create-hint">{t('Enter to create · Esc to cancel')}</small>
    {createError && <p id="cloud-create-error" className="cloud-error" role="alert">{createError}</p>}
    <div><button type="button" className="cloud-nav" disabled={busy} onClick={cancel}>{t('Cancel')}</button><button className="primary-button" disabled={busy}>{busy ? t('Creating…') : t('Create board')}</button></div>
  </form> : <button type="button" className="cloud-new-tile" onClick={start}><span className="cloud-new-plus" aria-hidden="true">+</span><strong>{t('New board')}</strong><small>{t('Start a new direction')}</small></button>}</>;
  const restore = async board => {
    setRestoring(board.id); setTrashError('');
    try {
      await services.api(`/api/cloud/trash/${encodeURIComponent(board.id)}/restore`, json('POST', {}));
      if (!alive.current) return;
      setTrash(current => current.filter(item => item.id !== board.id));
      await refresh.current?.();
    } catch (failure) { if (alive.current) setTrashError(failure.message); }
    finally { if (alive.current) setRestoring(null); }
  };
  const days = value => Math.max(1, Math.ceil((Date.parse(value) - now) / 86400000));
  const sorted = [...boards].sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
  const own = sorted.filter(board => board.role === 'owner'), shared = sorted.filter(board => board.role !== 'owner');
  const tile = (board, index) => {
    const updated = board.updatedAt || board.createdAt;
    return <div className="cloud-board-entry" key={board.id} style={{ '--card-delay': `${Math.min(index, 7) * 40}ms` }}><button type="button" className="cloud-board-tile" aria-label={t('Open board {name}', { name: board.name })} onClick={() => onOpen(board.id)}><BoardCover board={board}/><div className="cloud-board-info"><strong>{board.name}</strong><small>{Number.isInteger(board.imageCount) && `${plural(board.imageCount, '{count} image', '{count} images')} · `}{rich('updated {time}', { time: <time dateTime={updated} title={new Date(updated).toLocaleString()}>{relativeTime(updated, now, timeWords)}</time> })}</small><BoardAccess board={board}/><span className="cloud-board-open" aria-hidden="true">{t('Open board')} <span>↗</span></span></div></button></div>;
  };
  return <div className="cloud-home">
    <header className="app-header cloud-home-header"><div className="brand"><img src="/favicon.svg" alt=""/><strong>Concept Graph</strong></div><div className="header-right">
      <button className="theme-button" type="button" aria-label={theme === 'dark' ? t('Switch to light theme') : t('Switch to dark theme')} title={theme === 'dark' ? t('Switch to light theme') : t('Switch to dark theme')} onClick={toggleTheme}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{theme === 'dark' ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></> : <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>}</svg></button>
      <LanguageSelect/>
      <Preferences theme={theme} toggleTheme={toggleTheme} sounds={sounds} toggleSounds={toggleSounds} waiting={waiting}/>
      <AccountMenu user={user} siteRole={siteRole} onTeam={() => setTeamOpen(true)} onSignOut={onLogout}/>
    </div></header>
    {teamOpen && <TeamAccessDialog services={services} onClose={() => { setTeamOpen(false); document.querySelector('.account-button')?.focus(); }}/>}
    <main className="cloud-home-main"><div className="cloud-home-heading"><div><h1>{t('Boards')}</h1><p>{t('New boards are private. Share each one by link or with the people you invite.')}</p></div><button ref={createButton} type="button" className="primary-button" onClick={start}><span aria-hidden="true">+</span> {t('New board')}</button></div>
      {(error || loadError) && <p role="alert" className="cloud-error cloud-home-error">{error || loadError}{loadError && <button type="button" onClick={() => refresh.current?.()}>{t('Try again')}</button>}</p>}
      {loading && !boards.length && !editing ? <p role="status" className="cloud-home-status">{t('Loading boards…')}</p> : <>
        {loaded && !boards.length && !editing && <section className="cloud-boards-empty"><div className="empty-glyph" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="7" height="7" rx="2"/><rect x="14" y="13" width="7" height="7" rx="2"/><path d="M10 7.5h4a3 3 0 0 1 3 3V13M7 15v6m-3-3h6"/></svg></div><h2>{t('No boards yet')}</h2><p>{t('Create a board, then share it by link or invite people by email.')}</p><button type="button" className="primary-button" onClick={start}>+ {t('New board')}</button></section>}
        {(loaded || boards.length > 0 || editing) && <><section className="cloud-board-section" aria-labelledby="cloud-own-boards"><h2 id="cloud-own-boards">{t('Your boards')}</h2><div className="cloud-board-grid">{newBoard}{own.map(tile)}</div></section>
          {shared.length > 0 && <section className="cloud-board-section" aria-labelledby="cloud-shared-boards"><h2 id="cloud-shared-boards">{t('Shared with you')}</h2><div className="cloud-board-grid">{shared.map(tile)}</div></section>}</>}
        {trash.length > 0 && <section className="cloud-board-section cloud-trash" aria-labelledby="cloud-trash-boards"><h2 id="cloud-trash-boards">{t('Recently deleted')}</h2>
          <p>{t('Deleted boards wait here for 30 days, with everything on them, and are then erased for good.')}</p>
          {trashError && <p role="alert" className="cloud-error">{trashError}</p>}
          <ul className="share-people">{trash.map(board => <li key={board.id}><span><b>{board.name}</b><small>{rich('deleted {time}', { time: <time dateTime={board.deletedAt} title={new Date(board.deletedAt).toLocaleString()}>{relativeTime(board.deletedAt, now, timeWords)}</time> })} · {plural(days(board.erasesAt), 'erased in {count} day', 'erased in {count} days')}{!board.own && board.ownerName ? ` · ${board.ownerName}` : ''}</small></span>
            <button type="button" className="share-copy" disabled={!!restoring} aria-label={t('Restore board {name}', { name: board.name })} onClick={() => restore(board)}>{restoring === board.id ? t('Restoring…') : t('Restore')}</button></li>)}</ul></section>}
      </>}
    </main>
  </div>;
}

// Who shared Codex with whom on a board, kept in this browser so a reload does not end it.
const sharingMemory = boardId => {
  const key = `concept-graph-codex-sharing:${boardId}`;
  return { read: () => JSON.parse(localStorage.getItem(key) || '{}'), write: value => localStorage.setItem(key, JSON.stringify(value)) };
};

// Cursors move many times a second; only this layer re-renders for them, never the board.
function store(value) {
  const listeners = new Set();
  return { get: () => value, set: next => { value = next; listeners.forEach(listener => listener()); }, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
}

function Cursors({ cursors, pings, visible }) {
  const peers = useSyncExternalStore(cursors.subscribe, cursors.get).filter(visible), spots = useSyncExternalStore(pings.subscribe, pings.get).filter(visible);
  return <ViewportPortal><AttentionPings pings={spots}/>{peers.filter(peer => Number.isFinite(peer.cursor?.x) && Number.isFinite(peer.cursor?.y)).map(peer => <div className="cloud-cursor" key={peer.id} style={{ transform: `translate(${peer.cursor.x}px, ${peer.cursor.y}px)`, color: peer.user.color }}>
    <svg width="18" height="23" viewBox="0 0 18 23" fill="currentColor" aria-hidden="true"><path d="M1 1 16 13l-7 1-3 7Z" stroke="white" strokeWidth="1.5"/></svg><span style={{ background: peer.user.color }}>{peer.user.name}</span>
  </div>)}</ViewportPortal>;
}

const emptySharing = { ready: false, teammates: [], outgoing: null, incoming: [], shared: [] };

// Remounted (with a fresh document) whenever the person's role changes, so edits the room ignored never linger.
function CloudBoard({ boardId, boardName, role, sharing, onSharing, onAccess, onDeleted, user: account, siteRole, paired, pairing, pairCancel, helperStatus, openPair, unpair, pairDialog, finishPair, onBack, onLogout, services, Editor, ...editorProps }) {
  const helperRef = useRef(helperStatus); helperRef.current = helperStatus;
  const user = boardAuthor(account) || { name: 'Teammate' }, editable = role !== 'view';
  const [session, setSession] = useState(null), [connection, setConnection] = useState('connecting'), [peers, setPeers] = useState([]), [error, setError] = useState(''), [sharingView, setSharingView] = useState(emptySharing);
  const [shareOpen, setShareOpen] = useState(false), shareButton = useRef(null), [teamOpen, setTeamOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false), historyButton = useRef(null);
  const [chatOpen, setChatOpen] = useState(false), chatButton = useRef(null);
  // A teammate's call waiting for this person's answer; a newer call replaces it.
  const [call, setCall] = useState(null);
  const latest = useRef({}); latest.current = { pairing, finishPair, onAccess, onDeleted };
  const [nano, setNano] = useState(undefined), nanoSoon = useRef(() => {});
  useEffect(() => {
    // Shared site-provider allowances change with teammates' runs and the UTC day, so they are re-read.
    let request = 0, timer = 0;
    const refresh = async () => {
      const id = ++request;
      try { const value = await services.api('/api/nano'); if (id === request) setNano(current => JSON.stringify(current) === JSON.stringify(value) ? current : value); }
      catch {}
    };
    nanoSoon.current = () => { clearTimeout(timer); timer = setTimeout(refresh, 800); };
    refresh();
    const interval = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
    window.addEventListener('focus', refresh);
    return () => { request = -1; clearTimeout(timer); clearInterval(interval); window.removeEventListener('focus', refresh); nanoSoon.current = () => {}; };
  }, [services]);
  useEffect(() => {
    const doc = new Y.Doc(), origin = {};
    const provider = new YProvider(location.host, boardId, doc, { party: 'board-room', disableBc: true, protocol: location.protocol === 'https:' ? 'wss' : 'ws' });
    // y-partyserver's provider sends every presence change it hears, anyone's, back to the room, so ten people multiply
    // cursor traffic about tenfold. The room relays each update itself: send only this client's own state, renewals included.
    provider.awareness.off('change', provider._awarenessUpdateHandler);
    const sendPresence = () => {
      const socket = provider.ws;
      if (!provider.wsconnected || socket?.readyState !== socket?.OPEN) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(provider.awareness, [doc.clientID]));
      socket.send(encoding.toUint8Array(encoder));
    };
    const ownPresence = ({ added, updated, removed }, origin) => { if (origin === 'local' && [...added, ...updated, ...removed].includes(doc.clientID)) sendPresence(); };
    provider.awareness.on('update', ownPresence);
    const sharing = new CodexSharing(provider.awareness, undefined, sharingMemory(boardId));
    const undo = new Y.UndoManager([doc.getMap('nodes'), doc.getMap('edges'), doc.getMap('groups'), doc.getMap('pages'), doc.getMap('sections')], { trackedOrigins: new Set([origin]) });
    const reader = new CloudGraphReader(doc), cursors = store([]), pings = store([]);
    const next = {
      doc, provider, undo, origin, user, paired, openPair, unpair, cursorStore: cursors, pingStore: pings,
      read: local => reader.read(local),
      // A viewer's edits are never written; the next read shows the board as it is.
      apply: (graph, before) => { if (editable) applyLocalGraph(doc, graph, before, origin, reader.stampIds()); },
      templates: {
        read: () => readBoardTemplates(doc),
        subscribe: callback => { const map = doc.getMap('templates'); map.observe(callback); return () => map.unobserve(callback); },
        save: (value, existing) => { if (!editable) throw new Error(t('You can only view this board.')); return saveBoardTemplate(doc, value, existing, origin); },
        remove: existing => { if (!editable) throw new Error(t('You can only view this board.')); deleteBoardTemplate(doc, existing.id, origin); },
      },
      subscribe: callback => {
        // Remote changes reach the editor once per frame, however many transactions arrive (ten people dragging send dozens a second).
        let frame = 0, timer = 0, pending = null;
        const flush = () => { cancelAnimationFrame(frame); clearTimeout(timer); frame = timer = 0; const feedback = pending; pending = null; if (feedback && !next.closed) callback(feedback); };
        const listener = transaction => {
          if (!transaction.changed.size || transaction.origin === origin) return;
          const feedback = cloudFeedback(transaction, provider, doc.clientID, next.feedbackLive), samePeer = pending?.peer && feedback.peer && pending.peer.name === feedback.peer.name && pending.peer.color === feedback.peer.color;
          pending = pending ? { live: feedback.live, peer: samePeer ? feedback.peer : null } : feedback;
          // Hidden tabs pause animation frames; the timer still delivers changes there, about once a second.
          if (!frame) { frame = requestAnimationFrame(flush); timer = setTimeout(flush, 250); }
        };
        doc.on('afterTransaction', listener);
        return () => { doc.off('afterTransaction', listener); cancelAnimationFrame(frame); clearTimeout(timer); };
      },
    };
    const collaborationSound = kind => {
      const key = soundPreferenceKey(`cloud:${user.name}`);
      if (readSoundPreference(localStorage, key)) { unlockSounds(); playSound(kind, () => readSoundPreference(localStorage, key), { background: true }); }
    };
    next.chatStore = store(null); next.chatSelection = store([]);
    next.chat = new ChatClient({ boardId, email: account.email, storage: localStorage, hidden: () => document.hidden,
      send: value => { if (provider.wsconnected) provider.sendMessage(JSON.stringify(value)); }, sound: () => collaborationSound('chat'), changed: value => next.chatStore.set(value) });
    next.voiceStore = store({ online: false, busy: false, joined: false, muted: false, speaking: false, people: [], streams: [], error: '' });
    const voice = cloudVoice({ provider, id: doc.clientID, api: services.api, boardId, view: value => next.voiceStore.set(value), sound: collaborationSound });
    next.voice = voice.mesh; next.joinVoice = voice.join; next.leaveVoice = voice.leave;
    next.jobs = new CloudGeneration({ doc, boardId, user, ...services, sharing, can: feature => !!helperRef.current?.features?.includes(feature), read: () => reader.read(), ready: () => provider.synced && provider.wsconnected, onStart: run => next.onOwnRun?.(run.id), onError: (message, failure) => { setError(t(message)); if (failure?.status === 403) unpair(); } });
    // Teammate Codex access is presence-only; every change re-checks grants and settles runs that can no longer start.
    next.sharing = sharing;
    // A viewer's helper could not place images on this board, so their Codex is never offered to teammates.
    next.shareCodex = ready => sharing.setReady(editable && ready);
    let sharingBusy = false;
    const share = () => {
      // Presence and run writes made here call back synchronously; the outer pass sees their result.
      if (next.closed || sharingBusy) return;
      sharingBusy = true;
      try {
        sharing.live(provider.synced && provider.wsconnected);
        for (const event of sharing.maintain()) {
          next.notify?.(sharingMessage(event));
          if (event.type === 'granted' && latest.current.pairing) latest.current.finishPair();
        }
        if (editable) next.jobs.maintain();
        const view = sharing.view([...doc.getMap('runs').values()]);
        setSharingView(current => JSON.stringify(current) === JSON.stringify(view) ? current : view);
      } finally { sharingBusy = false; }
    };
    next.share = share;
    // Cursor moves and run updates arrive many times a second; teammate access is re-checked a few times a second at most.
    let shareSoon = 0;
    const shareLater = () => { if (!shareSoon) shareSoon = setTimeout(() => { shareSoon = 0; share(); }, 200); };
    const shareTimer = setInterval(share, 2000), runsChanged = shareLater;
    doc.getMap('runs').observe(runsChanged);
    const nanoFinished = event => { if ([...event.keysChanged].some(id => { const run = doc.getMap('runs').get(id); return Object.values(generators).includes(run?.provider) && terminalRun(run.status); })) next.refreshNano?.(); };
    doc.getMap('runs').observe(nanoFinished);
    let lastPointer = 0, lastSelection = '';
    next.pointer = position => {
      if (document.hidden) position = null;
      if (position && Date.now() - lastPointer < 110) return;
      lastPointer = Date.now(); provider.awareness.setLocalStateField('cursor', position);
    };
    next.page = page => { if (provider.awareness.getLocalState()?.page !== page) provider.awareness.setLocalStateField('page', page); };
    // The middle of what this person sees, so a teammate can find them while their pointer is off the board.
    next.view = view => provider.awareness.setLocalStateField('view', view);
    next.selection = selection => {
      const value = JSON.stringify(selection);
      if (value !== lastSelection) { lastSelection = value; next.chatSelection.set(selection); provider.awareness.setLocalStateField('selection', selection); }
    };
    // Calling a teammate (a presence ID) or everyone ('all') to where this person is looking. The room names the caller and
    // answers with how many it reached; each person called later says whether they are coming.
    next.callAttention = (to, name) => {
      const local = provider.awareness.getLocalState(), spot = local?.cursor || local?.view || null;
      next.calling = { name, everyone: to === 'all', coming: [], later: [] };
      provider.sendMessage(JSON.stringify({ type: 'attention', to, page: local?.page ?? null, spot }));
    };
    next.answerCall = (id, answer) => provider.sendMessage(JSON.stringify({ type: 'attention-reply', id, answer }));
    next.ping = spot => {
      const id = crypto.randomUUID();
      pings.set([...pings.get(), { ...spot, id }]);
      setTimeout(() => pings.set(pings.get().filter(item => item.id !== id)), 2600);
    };
    const callMessage = value => {
      const calling = next.calling, names = list => list.join(', ');
      if (value.type === 'attention') {
        if (typeof value.id !== 'string' || typeof value.from?.name !== 'string' || !Number.isSafeInteger(value.from?.clientId)) return;
        setCall({ id: value.id, from: value.from, everyone: value.everyone === true, page: typeof value.page === 'string' ? value.page : null, spot: value.spot || null });
        const sounds = soundPreferenceKey(`cloud:${user.name}`);
        if (readSoundPreference(localStorage, sounds)) { unlockSounds(); playSound('call', () => readSoundPreference(localStorage, sounds), { background: true }); }
      } else if (value.type === 'attention-sent' && calling) {
        calling.id = value.id;
        next.notify?.(calling.everyone ? plural(value.people, 'Called {count} person here', 'Called {count} people here') : t('Called {name} here', { name: calling.name }));
      } else if (value.type === 'attention-reply' && calling?.id === value.id && typeof value.from?.name === 'string') {
        calling[value.answer === 'coming' ? 'coming' : 'later'].push(value.from.name);
        next.notify?.([calling.coming.length && t('Coming: {names}', { names: names(calling.coming) }), calling.later.length && t('Not now: {names}', { names: names(calling.later) })].filter(Boolean).join(' · '));
      } else if (value.type === 'attention-failed') {
        next.notify?.(value.reason === 'busy' ? t('Wait a few seconds before calling again.') : value.reason === 'alone' ? t('Nobody else is on this board right now.') : t('{name} has left the board.', { name: calling?.name || t('Someone') }));
      }
    };
    // The room forgets presence when it hibernates, so greet each newcomer with our state again.
    const greet = ({ added }) => { const local = provider.awareness.getLocalState(); if (local && added.some(id => id !== doc.clientID)) provider.awareness.setLocalState({ ...local }); };
    const presence = () => {
      const states = [...provider.awareness.getStates()].filter(([id, state]) => id !== doc.clientID && state.user);
      cursors.set(states.map(([id, state]) => ({ id, user: state.user, page: state.page, cursor: state.cursor, view: state.view })));
      // The board re-renders only when someone joins, leaves, renames or changes page, not when a cursor moves.
      const roster = states.map(([id, state]) => ({ id, user: state.user, page: state.page, voice: state.voice }));
      setPeers(current => JSON.stringify(current) === JSON.stringify(roster) ? current : roster);
      voice.refresh();
    };
    const status = ({ status }) => { if (status !== 'connected') { next.feedbackLive = false; next.chat.connected(false); voice.connected(false); } setConnection(status === 'connected' ? (provider.synced ? 'live' : 'connecting') : status === 'connecting' ? 'connecting' : 'offline'); share(); };
    const sync = synced => { next.feedbackLive = synced; if (synced) { next.loaded = true; setConnection('live'); next.chat.connected(true); voice.connected(true); } share(); };
    const hidden = () => { if (document.hidden) next.pointer(null); };
    // Background tabs throttle the awareness renewal timer until peers time us out (and end Codex grants);
    // incoming messages are not throttled, so renew from them while hidden.
    let renewed = Date.now();
    const keepAlive = (changes, origin) => {
      if (origin === 'local') { renewed = Date.now(); return; }
      const local = provider.awareness.getLocalState();
      if (document.hidden && local && Date.now() - renewed > 10000) provider.awareness.setLocalState({ ...local });
    };
    // An agent this person connected over MCP generates or cancels through this tab, the only way to their Codex; the room
    // asks only this person's tabs and hears the answer.
    const agentRequest = async value => {
      const reply = answer => provider.sendMessage(JSON.stringify({ type: 'agent-answer', requestId: value.requestId, ...answer }));
      try {
        if (value.type === 'agent-cancel') { await next.jobs.cancel(value.runId); reply({ ok: true }); }
        else if (!next.onAgentRun) throw new Error('The board is still opening. Try again in a moment.');
        else reply({ runId: await next.onAgentRun(value.nodeId) || null });
      } catch (error) { reply({ error: String(error?.message || 'Generation could not start.') }); }
    };
    // The room states this person's role when they connect and whenever the owner changes it. A refused reconnect (access
    // removed while away) looks like any failed connection, so the server is asked again, at most every 15 seconds.
    const accessMessage = message => {
      let value;
      try { value = JSON.parse(message); } catch { return; }
      if (typeof value?.type === 'string' && value.type.startsWith('chat-')) next.chat.receive(value);
      if (typeof value?.type === 'string' && value.type.startsWith('voice-')) voice.receive(value);
      if (value?.type === 'voice-left' && Number.isSafeInteger(value.from) && value.from !== doc.clientID) removeAwarenessStates(provider.awareness, [value.from], 'voice-left');
      if (value?.type === 'access') latest.current.onAccess(value.role);
      if (typeof value?.type === 'string' && value.type.startsWith('attention')) callMessage(value);
      if (['agent-generate', 'agent-cancel'].includes(value?.type) && typeof value.requestId === 'string') agentRequest(value);
      // The owner deleted the board: everyone goes back to their boards; only the others are told why.
      if (value?.type === 'deleted') latest.current.onDeleted(!next.deleting);
      // Someone put the whole board back as it was; everyone hears who did it and to when.
      if (value?.type === 'restored') next.notify?.(t('{name} restored the board to {time}.', { name: typeof value.by === 'string' && value.by ? value.by : t('Someone'), time: new Date(value.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }));
    };
    let checked = 0;
    const closed = event => { if (event?.code === 4403 || (!provider.wsconnected && Date.now() - checked > 15000)) { checked = Date.now(); latest.current.onAccess(undefined); } };
    provider.on('custom-message', accessMessage); provider.on('connection-close', closed);
    provider.awareness.setLocalState({ user, cursor: null });
    provider.awareness.on('change', presence); provider.awareness.on('change', greet); provider.awareness.on('change', shareLater); provider.awareness.on('update', keepAlive); provider.on('status', status); provider.on('sync', sync);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', voice.leave);
    setSession(next);
    return () => {
      next.flush?.(); next.closed = true;
      next.chat.destroy();
      voice.leave(); window.removeEventListener('pagehide', voice.leave);
      next.jobs.stop(); clearInterval(shareTimer); clearTimeout(shareSoon); doc.getMap('runs').unobserve(runsChanged); doc.getMap('runs').unobserve(nanoFinished); sharing.destroy(); reader.destroy(); provider.awareness.setLocalState(null); setCall(null);
      document.removeEventListener('visibilitychange', hidden);
      provider.awareness.off('change', presence); provider.awareness.off('change', greet); provider.awareness.off('change', shareLater); provider.awareness.off('update', keepAlive); provider.awareness.off('update', ownPresence); provider.off('status', status); provider.off('sync', sync);
      provider.off('custom-message', accessMessage); provider.off('connection-close', closed);
      undo.destroy(); provider.destroy(); doc.destroy();
    };
  }, [boardId, account.email, user.name, user.color]);
  useEffect(() => {
    if (!session || !paired || !editable) return;
    session.jobs.startPolling();
    return () => session.jobs.stop();
  }, [session, paired]);
  if (!session) return <div className="startup">{t('Connecting to board…')}</div>;
  const sharingActions = {
    onRequest: owner => { session.sharing.request(owner); session.share(); }, onWithdraw: () => { session.sharing.withdraw(); session.share(); },
    onAllow: id => { session.sharing.allow(id); session.share(); }, onDecline: id => { session.sharing.decline(id); session.share(); },
  };
  Object.assign(session, { paired, pairing, pairCancel, helperStatus, connection, peers, error, codex: sharingView, nano, refreshNano: () => nanoSoon.current(), role, deleted: () => onDeleted(false), home: () => session.leave?.(onBack) });
  session.cursors = visible => <Cursors cursors={session.cursorStore} pings={session.pingStore} visible={visible}/>;
  session.toolbar = <>
    <BoardPresence peers={peers} pages={presencePages(session.doc)} onFollow={id => session.follow?.(id)} onCall={to => session.callAttention(to, peers.find(peer => peer.id === to)?.user.name)}/>
    <ChatButton session={session} open={chatOpen} button={chatButton} onClick={() => setChatOpen(value => !value)}/>
    <VoiceControl session={session}/>
    {editable && <CodexShareMenu view={sharingView} {...sharingActions}/>}
    <button ref={historyButton} type="button" className="cloud-history-button" aria-haspopup="dialog" aria-label={t('Version history')} data-tooltip={t('Version history')} onClick={() => setHistoryOpen(true)}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg><span>{t('Versions')}</span></button>
    <button ref={shareButton} type="button" className="cloud-share-button" aria-haspopup="dialog" onClick={() => setShareOpen(true)}>{t('Share')}</button>
  </>;
  session.account = <AccountMenu user={account} siteRole={siteRole} onTeam={() => setTeamOpen(true)} onSignOut={() => session.leave?.(onLogout)}/>;
  session.panels = <>{chatOpen && <BoardChatPanel session={session} onClose={() => { setChatOpen(false); chatButton.current?.focus(); }}/>}<VoiceAudio session={session}/></>;
  return <>
    <ReactFlowProvider><Editor key={boardId} boardId={boardId} cloudSession={session} {...editorProps}/></ReactFlowProvider>
    {editable && <CodexRequests requests={sharingView.incoming} onAllow={sharingActions.onAllow} onDecline={sharingActions.onDecline}/>}
    {pairDialog(editable && !sharingView.ready && <TeammateCodex view={sharingView} onRequest={sharingActions.onRequest} onWithdraw={sharingActions.onWithdraw}/>)}
    {teamOpen && <TeamAccessDialog services={services} onClose={() => { setTeamOpen(false); document.querySelector('.account-button')?.focus(); }}/>}
    {call && (caller => <AttentionCard key={call.id} call={call} color={caller?.user.color || '#6b6e89'} pageName={presencePages(session.doc).length > 1 ? presencePages(session.doc).find(page => page.id === (caller?.page ?? call.page))?.name : ''}
      onGo={() => { session.answerCall(call.id, 'coming'); const arrived = session.follow?.(call.from.clientId, { ...call, name: call.from.name }); if (arrived) session.ping({ ...arrived.spot, page: arrived.page, color: caller?.user.color || '#6b6e89' }); return arrived; }}
      onLater={() => { session.answerCall(call.id, 'later'); setCall(null); }} onBack={previous => session.returnTo?.(previous)} onClose={() => setCall(null)}/>)(peers.find(peer => peer.id === call.from.clientId))}
    {historyOpen && <VersionHistory boardId={boardId} services={services} editable={editable} ago={value => relativeTime(value, Date.now(), timeWords)} onRestored={() => { setHistoryOpen(false); historyButton.current?.focus(); }} onClose={() => { setHistoryOpen(false); historyButton.current?.focus(); }}/>}
    {shareOpen && <ShareDialog boardId={boardId} name={boardName} sharing={sharing} services={services} onChange={onSharing} onClose={() => { setShareOpen(false); shareButton.current?.focus(); }}/>}
  </>;
}

// Shown instead of a board the person may not open; it names the owner to ask.
function BoardUnavailable({ state, user, onBack, onRetry, onSwitch }) {
  return <main className="cloud-startup"><section className="cloud-card cloud-unavailable" role="alert"><img src="/favicon.svg" alt="" width="40"/>
    <h1>{state.denied ? t('You don’t have access to this board') : state.error ? t('Couldn’t open this board') : t('Board not found')}</h1>
    <p>{state.denied ? state.owner ? rich('Ask {owner}, who owns it, to invite {email} or to share it with anyone who has the link.', { owner: <b>{state.owner}</b>, email: <b>{user.email}</b> }) : rich('Ask its owner to invite {email} or to share it with anyone who has the link.', { email: <b>{user.email}</b> }) : state.error || t('Check the link, or ask the person who sent it for a new one.')}</p>
    <div><button className="primary-button" type="button" onClick={state.error ? onRetry : onBack}>{state.error ? t('Try again') : t('Back to boards')}</button>
      {state.denied ? <button type="button" className="cloud-nav" onClick={onSwitch}>{t('Use another account')}</button> : state.error && <button type="button" className="cloud-nav" onClick={onBack}>{t('Back to boards')}</button>}</div>
  </section></main>;
}

export default function CloudWorkspace({ Editor, HelperSetup, services }) {
  const [user, setUser] = useState(undefined), [boards, setBoards] = useState([]), [boardId, setBoardId] = useState(() => boardFromPath(location.pathname));
  const [opened, setOpened] = useState(null), [accessCheck, setAccessCheck] = useState(0);
  const [devLogin, setDevLogin] = useState(false), [email, setEmail] = useState(''), [name, setName] = useState('');
  const [error, setError] = useState(() => new Map([
    ['unavailable', t('Google sign-in is not configured.')], ['cancelled', t('Google sign-in was cancelled.')],
    ['failed', t('Google sign-in failed. Please try again.')]
  ]).get(new URLSearchParams(window.location.search).get('auth_error')) || ''), [busy, setBusy] = useState(false);
  const [helperCode, setHelperCode] = useState(() => sessionStorage.getItem('concept-graph-helper-token') || '');
  const [pairing, setPairing] = useState(false), [paired, setPaired] = useState(false), [pairBusy, setPairBusy] = useState(false), [pairError, setPairError] = useState(''), [helperStatus, setHelperStatus] = useState({});
  const [pairCancel, setPairCancel] = useState(0), [siteRole, setSiteRole] = useState(null);
  const [showAllBuilds, setShowAllBuilds] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('concept-graph-theme') === 'dark' ? 'dark' : 'light');
  const pendingRun = useRef(null);
  useEffect(() => { localStorage.setItem('concept-graph-theme', theme); document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    services.api('/api/cloud/me').then(result => { setUser(result.user); setSiteRole(result.siteRole || null); }).catch(failure => { setUser(null); if (failure.status !== 401) setError(failure.message); });
    services.api('/api/auth/config').then(result => setDevLogin(result.devLogin === true)).catch(() => {});
    const url = new URL(window.location.href);
    if (url.searchParams.has('auth_error')) { url.searchParams.delete('auth_error'); window.history.replaceState(null, '', url.href); }
  }, []);
  const pair = async token => {
    setPairBusy(true); setPairError('');
    try { setHelperStatus(await services.pair(token)); setPaired(true); setPairing(false); }
    // A fetch that never reached the helper carries no status, and its browser wording ("Load failed") explains nothing.
    catch (failure) { setPairError(failure.status ? failure.message : loopbackBlocked() ? t('This browser cannot reach the local helper. Open this page in Chrome and paste the code there.') : t('Could not reach the local helper. Start it and allow local network access.')); }
    finally { setPairBusy(false); }
  };
  useEffect(() => { if (helperCode) pair(helperCode); }, []);
  useEffect(() => {
    if (paired && pendingRun.current) { const run = pendingRun.current; pendingRun.current = null; run(); }
  }, [paired]);
  const openPair = (callback, downloads = false) => { pendingRun.current = callback || null; setShowAllBuilds(downloads); setPairing(true); };
  const cancelPair = () => { setPairing(false); pendingRun.current = null; setPairCancel(value => value + 1); };
  // A teammate's Codex was granted instead: close setup but keep the pending generation, which then starts.
  const finishPair = () => { setPairing(false); pendingRun.current = null; };
  const pairDialog = teammates => pairing && <div className="cloud-pair-overlay" role="dialog" aria-modal="true" aria-label={t('Pair local helper')} onKeyDown={keepDialogFocus}><button className="cloud-pair-close" autoFocus onClick={cancelPair}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6"/></svg>{t('Back to board')}</button><HelperSetup cloudMode showAllBuilds={showAllBuilds} code={helperCode} setCode={setHelperCode} connecting={pairBusy} error={pairError} connect={pair} teammates={teammates} onClose={cancelPair}/></div>;
  const unpair = (rejected = true) => {
    services.unpair(); setHelperCode(''); setPaired(false); setHelperStatus({});
    if (!rejected) { pendingRun.current = null; setPairCancel(value => value + 1); }
    setPairError(rejected ? t('The helper pairing code was rejected. Enter its current code.') : '');
  };
  const signIn = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await services.api('/api/auth/dev', json('POST', { email, name: name.trim() })); setUser(result.user); setSiteRole(result.siteRole || null); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  // The open board lives in the URL, so its link opens it (after sign-in) and Back returns to the boards home.
  const openBoard = id => { const path = id ? boardPath(id) : '/'; if (location.pathname !== path) history.pushState(null, '', path); setBoardId(id); };
  useEffect(() => {
    const back = () => setBoardId(boardFromPath(location.pathname));
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  // What this person may do on the board; asked again when the room reports a different role or refuses to connect.
  useEffect(() => {
    if (!user || !boardId) return;
    let active = true;
    services.api(`/api/cloud/boards/${encodeURIComponent(boardId)}`).then(({ board, sharing }) => {
      if (!active) return;
      setOpened({ id: boardId, board, role: board.role, sharing });
      setBoards(current => current.some(item => item.id === board.id) ? current.map(item => item.id === board.id ? board : item) : [board, ...current]);
    }).catch(failure => {
      if (!active) return;
      if (failure.status === 401) setUser(null);
      else if (failure.status === 403 || failure.status === 404) setOpened({ id: boardId, denied: failure.status === 403, owner: failure.value?.owner?.name || '' });
      // A dropped connection keeps the open board; only a definite answer replaces it.
      else setOpened(current => current?.id === boardId && current.role ? current : { id: boardId, error: failure.message });
    });
    return () => { active = false; };
  }, [user, boardId, accessCheck]);
  // A board opened from its link still offers the person's other boards in the editor's board picker.
  useEffect(() => {
    if (user && boardId) services.api('/api/cloud/boards').then(result => setBoards(current => [...result.boards, ...current.filter(item => !result.boards.some(board => board.id === item.id))])).catch(() => {});
  }, [user]);
  const changeSharing = sharing => {
    setOpened(current => current?.id === boardId ? { ...current, sharing } : current);
    setBoards(current => current.map(item => item.id === boardId ? { ...item, access: sharing.access, linkRole: sharing.linkRole } : item));
  };
  const signOut = async (keepBoard = false) => {
    try { await services.api('/api/cloud/logout', { method: 'POST' }); if (!keepBoard) openBoard(null); setUser(null); setOpened(null); setBoards([]); setError(''); }
    catch (failure) { setError(failure.message); }
  };
  if (user === undefined) return <div className="startup">{t('Checking sign-in…')}</div>;
  if (!user) return <main className="cloud-startup"><section className="cloud-card"><img src="/favicon.svg" alt="" width="40"/><h1>Concept Graph Cloud</h1><p>{boardId ? t('Sign in with Google to open this board.') : t('Sign in with Google to see your boards and the boards shared with you.')}</p>
    {error && <p role="alert" className="cloud-error">{error}</p>}
    <a className="primary-button" href={boardId ? `/api/auth/google?next=${encodeURIComponent(boardPath(boardId))}` : '/api/auth/google'} style={{ display: 'inline-block', textDecoration: 'none' }}>{t('Sign in with Google')}</a>
    <p><a className="cloud-nav" href="/privacy">{t('Privacy')}</a></p>
    {devLogin && <form onSubmit={signIn}><p>{t('Local development sign-in')}</p>
      <label htmlFor="cloud-name">{t('Display name')}</label><input id="cloud-name" autoComplete="nickname" required maxLength={40} value={name} onChange={event => setName(event.target.value)}/>
      <label htmlFor="cloud-email">{t('Email')}</label><input id="cloud-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)}/>
      <button className="primary-button" disabled={busy || !name.trim() || !email.trim()}>{busy ? t('Signing in…') : t('Sign in locally')}</button>
    </form>}</section></main>;
  const current = boardId && opened?.id === boardId ? opened : null;
  return <>
    {!boardId ? <BoardsHome user={user} siteRole={siteRole} boards={boards} setBoards={setBoards} services={services} onOpen={openBoard} onLogout={() => signOut()} theme={theme} toggleTheme={() => setTheme(value => value === 'dark' ? 'light' : 'dark')} error={error}/>
      : current?.role ? <CloudBoard key={`${boardId}:${current.role}`} boardId={boardId} boardName={current.board.name} role={current.role} siteRole={siteRole} sharing={current.sharing} onSharing={changeSharing} onAccess={role => { if (role !== current.role) setAccessCheck(value => value + 1); }} onDeleted={notice => { setBoards(list => list.filter(board => board.id !== boardId)); openBoard(null); if (notice) setError(t('The owner deleted this board.')); }} user={user} paired={paired} pairing={pairing} pairCancel={pairCancel} helperStatus={helperStatus} openPair={openPair} unpair={unpair} pairDialog={pairDialog} finishPair={finishPair} onBack={() => openBoard(null)} onLogout={() => signOut()} services={services} Editor={Editor} boards={boards} updateBoards={setBoards} selectBoard={openBoard} theme={theme} toggleTheme={() => setTheme(value => value === 'dark' ? 'light' : 'dark')} waitForPreferences={async () => {}}/>
      : current ? <BoardUnavailable state={current} user={user} onBack={() => openBoard(null)} onRetry={() => setAccessCheck(value => value + 1)} onSwitch={() => signOut(true)}/>
      : <div className="startup">{t('Opening board…')}</div>}
    {!boardId && pairDialog()}
    {error && boardId && <div className="toast" role="alert">{error}<button onClick={() => setError('')}>{t('Dismiss')}</button></div>}
  </>;
}
