import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from './i18n.mjs';
import { track } from './analytics.mjs';

export { dismissFirstPromptHint, firstPromptHintDismissed, firstPromptStep } from './first-prompt.mjs';

// Points at the + Add text prompt tool: step 'add' adds a prompt, step 'write' goes to the one this person added.
export function FirstPromptHint({ step, anchor, onAdd, onShow, onDismiss }) {
  const [position, setPosition] = useState(null), shown = useRef(new Set());
  useLayoutEffect(() => {
    const place = () => {
      const box = document.querySelector(anchor)?.getBoundingClientRect();
      setPosition(box?.width ? { left: Math.max(8, Math.min(box.right + 10, innerWidth - 250)), top: Math.max(8, Math.min(box.top - 4, innerHeight - 150)) } : null);
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    const timer = setInterval(place, 1000);
    return () => { clearInterval(timer); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor]);
  useEffect(() => { if (position && !shown.current.has(step)) { shown.current.add(step); track('tip_event', { tip: 'first_prompt', action: 'shown', target: step }); } }, [position, step]);
  if (!position) return null;
  const write = step === 'write';
  return createPortal(<aside className="custom-node-invitation first-prompt-hint" style={position} aria-label={t('Getting started')}>
    <button className="invitation-close" type="button" aria-label={t('Dismiss tip')} onClick={() => { track('tip_event', { tip: 'first_prompt', action: 'dismissed', target: step }); onDismiss(); }}>×</button>
    <p>{write ? t('Write what you want to see in your prompt, then press Generate.') : t('Start here: add a prompt, describe the image you want, then press Generate.')}</p>
    <button className="primary-button" type="button" data-analytics-name={write ? 'First prompt: go to prompt' : 'First prompt: add'} onClick={() => { track('tip_event', { tip: 'first_prompt', action: 'accepted', target: step }); (write ? onShow : onAdd)(); }}>{write ? t('Go to my prompt') : t('Add a prompt')}</button>
  </aside>, document.body);
}
