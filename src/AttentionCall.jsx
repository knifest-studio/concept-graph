import React, { useEffect, useRef, useState } from 'react';
import { useViewport } from '@xyflow/react';
import { Avatar } from './BoardPresence.jsx';
import { t } from './i18n.mjs';

const countdown = 5, arrivedFor = 12000;
const typing = () => !!document.activeElement?.closest?.('textarea,input,select,[contenteditable="true"]');

// Blinks the tab title while a call waits in a background tab, and stops as soon as the person looks.
function useTitleBlink(active, text) {
  useEffect(() => {
    if (!active) return;
    const original = document.title;
    let shown = false;
    const timer = setInterval(() => { shown = document.hidden && !shown; document.title = shown ? text : original; }, 1000);
    return () => { clearInterval(timer); document.title = original; };
  }, [active, text]);
}

// A teammate's call, as in Figma's spotlight and Mural's summon. One person called gets a chime and this card and decides;
// everyone called is taken to the caller after a short countdown, unless they choose Not now. The countdown waits while
// they type or look at another tab, so nobody is pulled away mid-sentence.
export function AttentionCard({ call, color, pageName, onGo, onLater, onBack, onClose }) {
  const [left, setLeft] = useState(countdown), [held, setHeld] = useState(() => document.hidden || typing()), [arrived, setArrived] = useState(null);
  const remaining = useRef(countdown), go = useRef(null); go.current = () => { const result = onGo(); if (result) setArrived(result); else onClose(); };
  const name = call.from.name, title = call.everyone ? t('{name} is calling everyone', { name }) : t('{name} is calling you', { name });
  useTitleBlink(!arrived, `🔔 ${title}`);
  useEffect(() => {
    if (arrived) return;
    const timer = setInterval(() => {
      const wait = document.hidden || typing();
      setHeld(wait);
      if (!call.everyone || wait) return;
      remaining.current -= 1; setLeft(remaining.current);
      if (remaining.current <= 0) { clearInterval(timer); go.current(); }
    }, 1000);
    return () => clearInterval(timer);
  }, [arrived, call.id]);
  useEffect(() => {
    if (!arrived) return;
    const timer = setTimeout(onClose, arrivedFor);
    return () => clearTimeout(timer);
  }, [arrived]);
  const style = { '--caller': color };
  if (arrived) return <div className="attention-card attention-arrived" role="status" style={style}>
    <Avatar user={{ name, color }}/><span>{t('You’re with {name}', { name })}</span>
    <button type="button" className="attention-secondary" onClick={() => { onBack(arrived.previous); onClose(); }}>{t('Back to where I was')}</button>
    <button type="button" className="attention-close" aria-label={t('Dismiss')} onClick={onClose}>×</button>
  </div>;
  const note = call.everyone ? held ? (typing() ? t('Finish typing, then choose Go now.') : t('Waiting for you to return to this tab.')) : t('Taking you there in {count} s', { count: left })
    : pageName ? t('On {page}', { page: pageName }) : t('Choose Go now to see where on the board.');
  return <div className="attention-card" role="alert" style={style}>
    <span className="attention-avatar"><i/><i/><Avatar user={{ name, color }}/></span>
    <span className="attention-text"><b>{title}</b><small>{note}{call.everyone && pageName ? ` · ${pageName}` : ''}</small></span>
    <span className="attention-actions">
      <button type="button" className="attention-go" onClick={() => go.current()}>{t('Go now')}</button>
      <button type="button" className="attention-secondary" onClick={onLater}>{t('Not now')}</button>
    </span>
    {call.everyone && <span className="attention-progress" aria-hidden="true"><span style={{ transform: `scaleX(${left / countdown})` }}/></span>}
  </div>;
}

// Where a teammate was standing when they called: a ring in their colour that fades after a moment.
// It keeps its size on screen at any zoom.
export function AttentionPings({ pings }) {
  const { zoom } = useViewport();
  return pings.map(ping => <div key={ping.id} className="attention-ping" style={{ transform: `translate(${ping.x}px, ${ping.y}px) scale(${1 / zoom})`, '--caller': ping.color }}><i/><i/><i/></div>);
}
