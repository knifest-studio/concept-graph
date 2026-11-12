import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { t } from './i18n.mjs';
import { Avatar, VoiceMark } from './BoardPresence.jsx';
import { popoverPosition } from './popover-position.mjs';

function Microphone({ muted }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>{muted && <path d="m2 2 20 20"/>}</svg>;
}

export function VoiceControl({ session }) {
  const state = useSyncExternalStore(session.voiceStore.subscribe, session.voiceStore.get), [open, setOpen] = useState(false), root = useRef(null), button = useRef(null), panel = useRef(null);
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
    <button ref={button} type="button" className="cloud-history-button" aria-expanded={open} aria-controls="board-voice" onClick={() => setOpen(value => !value)}>{t('Voice')}{state.joined && <VoiceMark voice={{ muted: state.muted, speaking: state.speaking }}/>} {state.people.length > 0 && <small>{state.people.length}/8</small>}</button>
    {open && <div ref={panel} id="board-voice" className="voice-panel" aria-label={t('Board voice')}>
      <strong>{t('Board voice')} · {state.people.length}/8</strong>
      <p>{t('Audio only. Nothing is recorded. Peers may see your IP address.')}</p>
      <ul>{state.people.map(person => <li key={person.id}><Avatar user={person.user}/><span>{person.user.name}</span><VoiceMark voice={person.voice}/></li>)}</ul>
      {state.error && <p className="chat-error" role="alert">{t(state.error)}</p>}
      {state.reconnecting && <p role="status">{t('Reconnecting voice…')}</p>}
      {state.joined ? <div className="voice-actions"><button type="button" className="voice-mute" aria-pressed={state.muted} onClick={() => session.voice.mute()}><Microphone muted={state.muted}/>{t(state.muted ? 'Unmute microphone' : 'Mute microphone')}</button><button type="button" className="voice-leave" onClick={() => session.leaveVoice()}>{t('Leave voice')}</button></div>
        : <button type="button" className="primary-button voice-join" disabled={!state.online || state.busy} onClick={() => session.joinVoice()}>{state.busy ? t('Joining…') : t('Join voice')}</button>}
      {state.busy && !state.joined && <button type="button" onClick={() => session.leaveVoice()}>{t('Cancel')}</button>}
    </div>}
  </div>;
}

function RemoteAudio({ stream, onBlocked }) {
  const audio = useRef(null);
  useEffect(() => {
    const element = audio.current; element.srcObject = stream;
    Promise.resolve(element.play()).catch(onBlocked);
    return () => { element.pause(); element.srcObject = null; };
  }, [stream]);
  return <audio ref={audio} autoPlay playsInline/>;
}
export function VoiceAudio({ session }) {
  const state = useSyncExternalStore(session.voiceStore.subscribe, session.voiceStore.get), [blocked, setBlocked] = useState(false), root = useRef(null);
  useEffect(() => { if (!state.joined) setBlocked(false); }, [state.joined]);
  return <div className="voice-audio" ref={root}>
    {state.streams.map(([id, stream]) => <RemoteAudio key={id} stream={stream} onBlocked={() => setBlocked(true)}/>)}
    {blocked && state.joined && <button type="button" className="voice-play" onClick={async () => {
      const results = await Promise.allSettled([...root.current.querySelectorAll('audio')].map(element => element.play()));
      setBlocked(results.some(result => result.status === 'rejected'));
    }}>{t('Play voice audio')}</button>}
  </div>;
}
