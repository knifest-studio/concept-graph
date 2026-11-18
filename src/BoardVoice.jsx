import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { t } from './i18n.mjs';
import { Avatar, VoiceMark } from './BoardPresence.jsx';
import { popoverPosition } from './popover-position.mjs';
import { track } from './analytics.mjs';
import { voiceMediaDelay } from './voice-mesh.mjs';
import { boardPath } from './cloud-boards.mjs';

function Microphone({ muted }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>{muted && <path d="m2 2 20 20"/>}</svg>;
}

const invitedFor = 15000;

// People on the board who are not in voice, one row per person (their tabs share a name and colour, as in presence). An
// invite goes to all of that person's tabs through the room's call, which names the sender and spaces calls out. A link
// reaches people who are not on the board; they still need access to it.
function VoiceInvite({ session, peers, boardId }) {
  const [invited, setInvited] = useState({}), key = peer => `${peer.user.name}\u0000${peer.user.color}`;
  const inVoice = new Set(peers.filter(peer => peer.voice).map(key)), seen = new Set();
  const people = peers.filter(peer => { const id = key(peer); if (inVoice.has(id) || seen.has(id)) return false; seen.add(id); return true; });
  const invite = (to, name, mark) => {
    session.callAttention(to, name, true);
    setInvited(current => ({ ...current, [mark]: true }));
    setTimeout(() => setInvited(current => { const next = { ...current }; delete next[mark]; return next; }), invitedFor);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${boardPath(boardId)}?voice=1`);
      session.inform?.(t('Invite link copied. People need access to this board to join.'), 'voice_link_copied');
    } catch { session.notify?.(t('Could not copy the link.')); }
  };
  return <div className="voice-invite">
    <strong>{t('Invite to voice')}</strong>
    {people.length ? <ul>{people.map(peer => <li key={key(peer)}><Avatar user={peer.user}/><span>{peer.user.name}</span>
      <button type="button" className="voice-invite-button" data-analytics-name="Invite to voice" disabled={invited[key(peer)]} onClick={() => invite(peer.id, peer.user.name, key(peer))}>{invited[key(peer)] ? t('Invited') : t('Invite')}</button></li>)}</ul>
      : <p>{peers.length ? t('Everyone on this board is in voice.') : t('Nobody else is on this board right now.')}</p>}
    <div className="voice-invite-actions">
      {people.length > 1 && <button type="button" data-analytics-name="Invite everyone to voice" disabled={invited.all} onClick={() => invite('all', '', 'all')}>{invited.all ? t('Invited') : t('Invite everyone')}</button>}
      <button type="button" data-analytics-name="Copy voice invite link" onClick={copy}>{t('Copy invite link')}</button>
    </div>
  </div>;
}

export function VoiceControl({ session, peers = [], boardId, openOnStart = false }) {
  const state = useSyncExternalStore(session.voiceStore.subscribe, session.voiceStore.get), [open, setOpen] = useState(openOnStart), root = useRef(null), button = useRef(null), panel = useRef(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const element = panel.current, anchor = button.current;
      if (!element || !anchor) return;
      const position = popoverPosition(anchor.getBoundingClientRect(), { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
      element.style.left = `${position.left}px`;
      element.style.top = `${position.top}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    root.current?.querySelector('.voice-panel button')?.focus();
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div className="board-voice" ref={root} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } }}>
    <button ref={button} type="button" className="cloud-history-button" aria-expanded={open} aria-controls="board-voice" aria-label={t('Voice')} data-tooltip={t('Voice')} onClick={() => setOpen(value => !value)}><Microphone muted={false}/><span className="header-control-label">{t('Voice')}</span>{state.joined && <VoiceMark voice={{ muted: state.muted, speaking: state.speaking }}/>} {state.people.length > 0 && <small>{state.people.length}/8</small>}</button>
    {open && <div ref={panel} id="board-voice" className="voice-panel" data-analytics-area="voice" data-analytics-panel="Voice" aria-label={t('Board voice')}>
      <strong>{t('Board voice')} · {state.people.length}/8</strong>
      <p>{t('Audio only. Nothing is recorded. Peers may see your IP address.')}</p>
      <ul>{state.people.map(person => <li key={person.id}><Avatar user={person.user}/><span>{person.user.name}</span><VoiceMark voice={person.voice}/></li>)}</ul>
      {state.error && <p className="chat-error" role="alert">{t(state.error)}</p>}
      {state.reconnecting && <p role="status">{t('Reconnecting voice…')}</p>}
      {state.joined ? <div className="voice-actions"><button type="button" className="voice-mute" aria-pressed={state.muted} onClick={() => session.voice.mute()}><Microphone muted={state.muted}/>{t(state.muted ? 'Unmute microphone' : 'Mute microphone')}</button><button type="button" className="voice-leave" onClick={() => session.leaveVoice()}>{t('Leave voice')}</button></div>
        : <button type="button" className="primary-button voice-join" disabled={!state.online || state.busy} onClick={() => session.joinVoice()}>{state.busy ? t('Joining…') : t('Join voice')}</button>}
      {state.busy && !state.joined && <button type="button" onClick={() => session.leaveVoice()}>{t('Cancel')}</button>}
      {state.joined && <VoiceInvite session={session} peers={peers} boardId={boardId}/>}
    </div>}
  </div>;
}

function RemoteAudio({ stream, onBlocked }) {
  const audio = useRef(null);
  useEffect(() => {
    const element = audio.current; element.srcObject = stream;
    Promise.resolve(element.play()).catch(onBlocked);
    // Whether the page is still playing this teammate a few seconds in, beside the mesh's packet counts (voice_media).
    const check = setTimeout(() => track('voice_playback', { paused: element.paused, readyState: element.readyState }, 'app', 'voice'), voiceMediaDelay);
    return () => { clearTimeout(check); element.pause(); element.srcObject = null; };
  }, [stream]);
  return <audio ref={audio} autoPlay playsInline/>;
}
export function VoiceAudio({ session }) {
  const state = useSyncExternalStore(session.voiceStore.subscribe, session.voiceStore.get), [blocked, setBlocked] = useState(false), root = useRef(null), reported = useRef(false);
  useEffect(() => { if (!state.joined) { setBlocked(false); reported.current = false; } }, [state.joined]);
  // Once per call: the browser refused to play teammates' audio until a click, so they would seem silent.
  const block = () => { setBlocked(true); if (!reported.current) { reported.current = true; track('voice_audio_blocked', {}, 'app', 'voice'); } };
  return <div className="voice-audio" ref={root}>
    {state.streams.map(([id, stream]) => <RemoteAudio key={id} stream={stream} onBlocked={block}/>)}
    {blocked && state.joined && <button type="button" className="voice-play" onClick={async () => {
      const results = await Promise.allSettled([...root.current.querySelectorAll('audio')].map(element => element.play()));
      setBlocked(results.some(result => result.status === 'rejected'));
    }}>{t('Play voice audio')}</button>}
  </div>;
}
