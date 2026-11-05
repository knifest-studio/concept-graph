import React from 'react';
import { language, languages, saveLanguage, t } from './i18n.mjs';

// Switching saves the choice and reloads the page; `beforeSwitch` lets the editor save the board first.
export function LanguageSelect({ beforeSwitch }) {
  const change = async event => {
    const value = event.target.value;
    try { await beforeSwitch?.(); } catch {}
    saveLanguage(value);
    location.reload();
  };
  return <label className="language-select" data-tooltip={t('Language')}>
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z"/></svg>
    <select aria-label={t('Language')} value={language()} onChange={change}>{Object.entries(languages).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select>
  </label>;
}
