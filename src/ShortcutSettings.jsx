import React, { useEffect, useRef, useState } from 'react';
import { bindingLabel, currentBindings, findShortcutConflict, platformIsMac, recordBinding, shortcutRegistry } from './shortcuts.mjs';
import { assignShortcut, hasOverride, resetAllShortcuts, resetConflict, resetShortcut, setShortcutBindings } from './shortcut-preferences.mjs';
import { useShortcutOverrides } from './useShortcutOverrides.jsx';
import { t } from './i18n.mjs';
import './shortcut-settings.css';

const editable = shortcutRegistry.filter(item => !item.fixed && !item.hidden);
const groups = [...new Set(editable.map(item => item.group))];

// Settings > Keyboard shortcuts: each person can change, turn off or reset the actions that are not fixed.
export function ShortcutSettings() {
  const overrides = useShortcutOverrides(), mac = platformIsMac();
  const [recording, setRecording] = useState(null), [notice, setNotice] = useState(null), [conflict, setConflict] = useState(null), [focusId, setFocusId] = useState(null);
  const root = useRef(null), recorder = useRef(null);
  useEffect(() => { if (recording) recorder.current?.focus(); }, [recording]);
  useEffect(() => { if (focusId) { root.current?.querySelector(`[data-shortcut-change="${focusId}"]`)?.focus(); setFocusId(null); } }, [focusId]);
  const start = id => { setConflict(null); setNotice(null); setRecording(id); };
  const stop = (id = recording) => { setRecording(null); setFocusId(id); };
  const record = event => {
    // Tab still moves focus, which ends recording; every other key is captured here, so Escape does not close Settings.
    if (event.key === 'Tab') return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { setNotice(null); stop(); return; }
    const result = recordBinding(event, mac, { id: recording, overrides });
    if (!result) return;
    const key = result.binding ? bindingLabel(result.binding, mac) : '';
    if (result.error) { setNotice({ id: recording, text: result.error === 'reserved' ? t('Your browser keeps {key} for itself. Choose another key.', { key }) : result.error === 'blocked' ? t('{key} is needed to move around the board and dialogs. Choose another key.', { key }) : result.error === 'typing' ? (mac ? t('This action also works while typing, so it needs ⌘ or Ctrl. Choose another key.') : t('This action also works while typing, so it needs Ctrl. Choose another key.')) : t('This key can’t be a shortcut. Choose another key.') }); return; }
    const other = findShortcutConflict(recording, result.binding, overrides, mac);
    if (other?.fixed) { setNotice({ id: recording, text: t('{key} is already used by {action}, which can’t be changed. Choose another key.', { key, action: t(other.label) }) }); return; }
    if (other) { setConflict({ id: recording, binding: result.binding, other }); setNotice(null); setRecording(null); return; }
    assignShortcut(recording, result.binding); setNotice(null); stop();
  };
  const replace = () => { if (conflict.reset) resetShortcut(conflict.id); else assignShortcut(conflict.id, conflict.binding); setFocusId(conflict.id); setConflict(null); };
  // A default that Replace gave another action since is asked about, as a new key would be.
  const reset = id => {
    setNotice(null);
    const clash = resetConflict(overrides, id, mac);
    if (clash) { setConflict({ id, binding: clash.binding, other: clash.other, reset: true }); return; }
    setConflict(null); resetShortcut(id); setFocusId(id);
  };
  return <section className="shortcut-settings" ref={root} aria-labelledby="shortcut-settings-title">
    <h3 id="shortcut-settings-title">{t('Keyboard shortcuts')}</h3>
    <p className="preference-hint">{t('They work on any keyboard layout and are saved on this device.')}</p>
    <div className="shortcut-list">{groups.map(group => <div key={group} role="group" aria-label={t(group)}><h4>{t(group)}</h4>
      {editable.filter(item => item.group === group).map(item => {
        const bindings = currentBindings(item.id, overrides, mac), label = t(item.label), active = recording === item.id;
        return <div key={item.id} className="shortcut-row">
          <span className="shortcut-name">{label}</span>
          <span className="shortcut-keys">{active
            ? <button ref={recorder} type="button" className="shortcut-recorder" data-shortcut-recorder aria-label={t('Press the new keys for {action}', { action: label })} onKeyDown={record} onBlur={() => setRecording(current => current === item.id ? null : current)}>{t('Press keys…')}</button>
            : bindings.length ? bindings.map(binding => <kbd key={binding}>{bindingLabel(binding, mac)}</kbd>) : <span className="shortcut-off">{t('Off')}</span>}</span>
          <span className="shortcut-actions">{active
            ? <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => { setNotice(null); stop(item.id); }}>{t('Cancel')}</button>
            : <><button type="button" data-shortcut-change={item.id} aria-label={t('Change shortcut for {action}', { action: label })} onClick={() => start(item.id)}>{t('Change')}</button>
              {bindings.length > 0 && <button type="button" aria-label={t('Turn off shortcut for {action}', { action: label })} onClick={() => { setShortcutBindings(item.id, []); setFocusId(item.id); }}>{t('Remove')}</button>}
              {hasOverride(overrides, item.id) && <button type="button" aria-label={t('Reset shortcut for {action}', { action: label })} onClick={() => reset(item.id)}>{t('Reset')}</button>}</>}</span>
          {notice?.id === item.id && <p className="shortcut-notice" role="alert">{notice.text}</p>}
          {conflict?.id === item.id && <div className="shortcut-conflict" role="alert"><p>{t('{key} is already used by {action}.', { key: bindingLabel(conflict.binding, mac), action: t(conflict.other.label) })}</p>
            <button type="button" className="primary-button" autoFocus onClick={replace}>{t('Replace')}</button><button type="button" onClick={() => { setFocusId(conflict.id); setConflict(null); }}>{t('Cancel')}</button></div>}
        </div>;
      })}</div>)}</div>
    <div className="shortcut-reset-all"><button type="button" disabled={!Object.keys(overrides.bindings).length} onClick={() => { setConflict(null); setNotice(null); setRecording(null); resetAllShortcuts(); }}>{t('Reset all shortcuts')}</button></div>
  </section>;
}
