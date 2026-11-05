import React, { useEffect, useState } from 'react';
import './run-diagnostics.css';
import { keepDialogFocus, restoreDialogFocus } from './dialog-focus.mjs';
import { t } from './i18n.mjs';

const eventLabels = {
  worker_context: 'Generation context',
  agent_message: 'Agent',
  image_started: 'Image tool item started',
  image_completed: 'Image tool call completed',
  image_failed: 'Image tool item failed',
  turn_started: 'Agent turn started',
  turn_completed: 'Agent turn completed',
  error: 'Error',
  model_rerouted: 'Model changed',
  reasoning_summary: 'Reasoning summary',
};
const usageLabels = {
  inputTokens: 'Input', cachedInputTokens: 'Cached input', outputTokens: 'Output',
  reasoningOutputTokens: 'Reasoning output', totalTokens: 'Total',
};
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const text = value => typeof value === 'string' ? value : '';
const requested = (diagnostics, key, snapshotValue) => {
  if (!diagnostics) return text(snapshotValue) || t('Not recorded');
  if (!Object.hasOwn(diagnostics, key)) return text(snapshotValue) || t('Not recorded');
  const value = diagnostics[key];
  return value == null ? t('Codex default') : text(value) || t('Unavailable');
};

function eventTime(at) {
  const date = new Date(at);
  return at && Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : '';
}

export function RunDiagnostics({ run, loadRun, onClose, returnFocus }) {
  const [snapshot, setSnapshot] = useState(null);
  const [snapshotError, setSnapshotError] = useState(false);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    setSnapshot(null); setSnapshotError(false); setSnapshotLoaded(false);
    loadRun(run.id).then(value => { if (active) { setSnapshot(value); setSnapshotLoaded(true); } }).catch(() => { if (active) { setSnapshotError(true); setSnapshotLoaded(true); } });
    return () => { active = false; };
  }, [loadRun, run.id]);
  useEffect(() => () => restoreDialogFocus(returnFocus?.current), [returnFocus]);
  const diagnostics = object(run.diagnostics);
  const events = Array.isArray(diagnostics?.events) ? diagnostics.events.filter(object) : [];
  const usage = object(diagnostics?.usage);
  const prompt = text(run.prompt) || text(snapshot?.prompt);
  const userText = text(run.target?.data?.text) || text(snapshot?.target?.data?.text);
  const resultError = text(run.error) || text(snapshot?.error);
  return <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="run-diagnostics-title" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } else keepDialogFocus(event); }} onClick={onClose}>
    <section className="run-diagnostics" onClick={event => event.stopPropagation()}>
      <header className="run-diagnostics-header"><div><span className="eyebrow">{t('GENERATION HISTORY')}</span><h2 id="run-diagnostics-title">{t('Run details')}</h2></div><button type="button" className="run-diagnostics-close" aria-label={t('Close run details')} autoFocus onClick={onClose}>×</button></header>
      <p className="run-diagnostics-subtitle">{text(run.label) || t('Image generation')} · {t(text(run.status))}</p>
      <dl className="run-diagnostics-models">
        <div><dt>{t('Requested model')}</dt><dd>{requested(diagnostics, 'requestedModel', run.target?.data?.model ?? snapshot?.target?.data?.model)}</dd></div>
        <div><dt>{t('Requested effort')}</dt><dd>{requested(diagnostics, 'requestedEffort', run.target?.data?.effort ?? snapshot?.target?.data?.effort)}</dd></div>
        <div><dt>{t('Initial thread model')}</dt><dd>{text(diagnostics?.model) || t('Unavailable')}</dd></div>
        <div><dt>{t('Initial thread effort')}</dt><dd>{text(diagnostics?.effort) || t('Unavailable')}</dd></div>
      </dl>
      <p className="run-diagnostics-note">{t('Thread values are reported when the thread starts. The requested values may override them for the generation.')}</p>
      {userText && <><h3>{t('Your request')}</h3><p className="run-diagnostics-user-text">{userText}</p></>}
      <details className="run-diagnostics-prompt"><summary>{t('Text sent to agent')}</summary><p className="run-diagnostics-note">{t('Attached reference images are sent separately.')}</p>{prompt ? <pre>{prompt}</pre> : <p>{snapshotError ? t('Could not load the original input.') : snapshotLoaded ? t('The original input is unavailable.') : t('Loading original input…')}</p>}</details>
      <h3>{t('Agent activity')}</h3>
      {!diagnostics ? <p className="run-diagnostics-note">{run.status === 'queued' ? t('Waiting for this run to start.') : run.status === 'running' ? t('Waiting for diagnostic activity.') : t('Diagnostics were not recorded for this run.')}</p> : !events.length ? <p className="run-diagnostics-note">{t('No activity has been reported yet.')}</p> : <ol className="run-diagnostics-events">{events.map((event, index) => <li key={index}>
        <div><strong>{Object.hasOwn(eventLabels, text(event.type)) ? t(eventLabels[event.type]) : text(event.type) || t('Activity')}</strong>{eventTime(text(event.at)) && <time dateTime={text(event.at)}>{eventTime(text(event.at))}</time>}</div>
        {text(event.text) && <pre>{text(event.text)}</pre>}
      </li>)}</ol>}
      {diagnostics?.truncated && <p className="run-diagnostics-note">{t('Some activity was omitted because the diagnostic limit was reached.')}</p>}
      {resultError && <div className="run-diagnostics-error"><strong>{t('Run error')}</strong><pre>{t(resultError)}</pre></div>}
      {usage && <><h3>{t('Codex-reported token usage')}</h3><dl className="run-diagnostics-usage">{Object.entries(usageLabels).filter(([key]) => Number.isFinite(usage[key])).map(([key, label]) => <div key={key}><dt>{t(label)}</dt><dd>{usage[key].toLocaleString()}</dd></div>)}</dl><p className="run-diagnostics-note">{t('Cumulative across agent model calls. Cached input is included in Input; reasoning is included in Output. These counts may exclude image-generation usage and do not measure cost or subscription allowance.')}</p></>}
      <p className="run-diagnostics-privacy">{t('Agent messages and diagnostics are saved locally with the board and included in board exports. They may contain personal information. Private reasoning and hidden tool outputs are not shown.')}</p>
    </section>
  </div>;
}
