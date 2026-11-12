import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LanguageSelect } from './LanguageSelect.jsx';
import { keepDialogFocus, restoreDialogFocus } from './dialog-focus.mjs';
import { useDictationPreference } from './usePromptDictation.jsx';
import { t } from './i18n.mjs';

function PreferencesDialog({ theme, toggleTheme, sounds, toggleSounds, waiting, beforeSwitch, onClose }) {
  const first = useRef(null), [dictation, setDictation] = useDictationPreference();
  useEffect(() => { first.current?.focus(); }, []);
  return createPortal(<div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="preferences-title"
    onKeyDown={event => { keepDialogFocus(event); event.stopPropagation(); if (event.key === 'Escape') onClose(); }}
    onCopy={event => event.stopPropagation()} onPaste={event => event.stopPropagation()}>
    <div className="preferences-card">
      <h2 id="preferences-title">{t('Preferences')}</h2>
      <label className="preference-row"><span>{t('Theme')}</span><select ref={first} value={theme} onChange={event => { if (event.target.value !== theme) toggleTheme(); }}><option value="light">{t('Light')}</option><option value="dark">{t('Dark')}</option></select></label>
      <div className="preference-row"><span>{t('Interface language')}</span><LanguageSelect beforeSwitch={beforeSwitch}/></div>
      <label className="preference-row"><span>{t('Sounds')}</span><input type="checkbox" checked={sounds} onChange={toggleSounds}/></label>
      <label className="preference-row"><span>{t('Dictation language')}</span><select value={dictation} onChange={event => setDictation(event.target.value)}>
        <option value="">{t('Automatic')}</option><option value="uk-UA">{t('Ukrainian')}</option><option value="en-US">{t('English')}</option><option value="ru-RU">{t('Russian')}</option>
      </select></label>
      <label className="preference-row"><span>{t('Videos while generating')}</span><input type="checkbox" checked={waiting.enabled} disabled={waiting.reducedMotion} onChange={waiting.toggle} aria-describedby={waiting.reducedMotion ? 'preferences-motion' : undefined}/></label>
      {waiting.reducedMotion && <p id="preferences-motion" className="preference-hint">{t('Your system’s reduced-motion setting turns videos off.')}</p>}
      <div className="preferences-actions"><button className="primary-button" type="button" onClick={onClose}>{t('Done')}</button></div>
    </div>
  </div>, document.body);
}

export function Preferences(props) {
  const [open, setOpen] = useState(false), trigger = useRef(null);
  const close = () => { setOpen(false); props.onOpenChange?.(false); restoreDialogFocus(trigger.current); };
  return <><button ref={trigger} className="theme-button" type="button" aria-label={t('Preferences')} data-tooltip={t('Preferences')} title={t('Preferences')} onClick={() => { setOpen(true); props.onOpenChange?.(true); }}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></svg>
  </button>{open && <PreferencesDialog {...props} onClose={close}/>}</>;
}
