import { analyticsEnabled, setAnalyticsEnabled, subscribeAnalytics, track } from './analytics.mjs';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { LanguageSelect } from './LanguageSelect.jsx';
import { keepDialogFocus, restoreDialogFocus } from './dialog-focus.mjs';
import { useDictationPreference } from './usePromptDictation.jsx';
import { t } from './i18n.mjs';

function PreferencesDialog({ theme, setTheme, sounds, toggleSounds, waiting, beforeSwitch, onClose, analytics }) {
  const usage = useSyncExternalStore(subscribeAnalytics, analyticsEnabled);
  const first = useRef(null), [dictation, setDictation] = useDictationPreference();
  useEffect(() => { first.current?.focus(); }, []);
  return createPortal(<div className="board-modal" data-analytics-area="dialog:Preferences" role="dialog" aria-modal="true" aria-labelledby="preferences-title"
    onKeyDown={event => { keepDialogFocus(event); event.stopPropagation(); if (event.key === 'Escape') onClose(); }}
    onCopy={event => event.stopPropagation()} onPaste={event => event.stopPropagation()}>
    <div className="preferences-card">
      <h2 id="preferences-title">{t('Settings')}</h2>
      <div className="preference-row"><span id="theme-label">{t('Theme')}</span><div className="theme-segments" role="group" aria-labelledby="theme-label">
        {['light', 'dark', 'system'].map((value, index) => <button key={value} ref={index === 0 ? first : undefined} type="button" aria-pressed={theme === value} onClick={() => { if (value !== theme) { setTheme(value); if (analytics) track('theme_changed', { to: value, source: 'settings' }); } }}>{t({ light: 'Light', dark: 'Dark', system: 'System' }[value])}</button>)}
      </div></div>
      <div className="preference-row"><span>{t('Interface language')}</span><LanguageSelect beforeSwitch={beforeSwitch}/></div>
      <label className="preference-row"><span>{t('Sounds')}</span><input type="checkbox" checked={sounds} onChange={toggleSounds}/></label>
      <label className="preference-row"><span>{t('Dictation language')}</span><select value={dictation} onChange={event => setDictation(event.target.value)}>
        <option value="">{t('Automatic')}</option><option value="uk-UA">{t('Ukrainian')}</option><option value="en-US">{t('English')}</option><option value="ru-RU">{t('Russian')}</option>
      </select></label>
      <label className="preference-row"><span>{t('Videos while generating')}</span><input type="checkbox" checked={waiting.enabled} disabled={waiting.reducedMotion} onChange={waiting.toggle} aria-describedby={waiting.reducedMotion ? 'preferences-motion' : undefined}/></label>
      {waiting.reducedMotion && <p id="preferences-motion" className="preference-hint">{t('Your system’s reduced-motion setting turns videos off.')}</p>}
      {analytics && <label className="preference-row preference-analytics"><span>{t('Share usage data and session recordings to improve Concept Graph')}</span><input type="checkbox" checked={usage} onChange={event => setAnalyticsEnabled(event.target.checked)}/></label>}
      {analytics && <p className="preference-hint"><a href="/privacy" target="_blank" rel="noreferrer">{t('Privacy Policy')}</a></p>}
      <div className="preferences-actions"><button className="primary-button" type="button" onClick={onClose}>{t('Done')}</button></div>
    </div>
  </div>, document.body);
}

export function Preferences(props) {
  const [open, setOpen] = useState(false), trigger = useRef(null);
  const close = () => { setOpen(false); props.onOpenChange?.(false); restoreDialogFocus(trigger.current); };
  return <><button ref={trigger} className="theme-button settings-button" type="button" aria-label={t('Settings')} data-tooltip={t('Settings')} title={t('Settings')} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true); props.onOpenChange?.(true); }}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3 3-1 3 2 3-2 3 1 2-3-1-3 2-2-2-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></svg>
    <span>{t('Settings')}</span>
  </button>{open && <PreferencesDialog {...props} onClose={close}/>}</>;
}
