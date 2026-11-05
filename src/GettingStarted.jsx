import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { checklistEvent, checklistSteps, emptyChecklist, readChecklist, writeChecklist } from './onboarding.mjs';
import { t } from './i18n.mjs';

export function useGettingStarted(key) {
  const [state, setState] = useState(() => { try { return readChecklist(localStorage, key); } catch { return emptyChecklist(); } });
  const current = useRef(state), [reopened, setReopened] = useState(false), [tips, setTips] = useState(false);
  const report = useCallback(event => {
    const next = checklistEvent(current.current, event);
    if (next === current.current) return;
    current.current = next; setState(next);
    try { writeChecklist(localStorage, key, next); } catch {}
    if (!['reopen', 'dismiss', 'run-started'].includes(event.type)) setReopened(false);
  }, [key]);
  return { state, report, reopened, tips, reopen: () => { report({ type: 'reopen' }); setReopened(true); setTips(true); }, dismiss: () => { report({ type: 'dismiss' }); setReopened(false); } };
}

const labels = { helper: 'Connect helper', prompt: 'Add a prompt', generate: 'Generate your first image', variation: 'Make a variation: + Prompt from this' };

export function GettingStarted({ effects, guide, helperNeeded, ready, onStep, onDownloadHelper, disabled }) {
  const card = useRef(null), wasDone = useRef(false);
  const showHelper = useRef(helperNeeded && !ready);
  const steps = checklistSteps(guide.state, helperNeeded, showHelper.current ? false : ready);
  const done = steps.every(step => step.done), previous = useRef(new Map(steps.map(step => [step.id, step.done])));
  const [completed, setCompleted] = useState(new Set()), [hidden, setHidden] = useState(done);
  const signature = steps.map(step => `${step.id}:${step.done}`).join(',');
  useLayoutEffect(() => {
    const changed = steps.filter(step => step.done && previous.current.get(step.id) === false).map(step => step.id);
    previous.current = new Map(steps.map(step => [step.id, step.done]));
    if (!changed.length) return;
    setCompleted(new Set(changed));
    if (!guide.state.dismissed) for (const id of changed) effects.fire('step', { element: card.current?.querySelector(`[data-step="${id}"]`), index: steps.findIndex(step => step.id === id) }, `step:${id}`);
    const timer = setTimeout(() => setCompleted(new Set()), 410);
    return () => clearTimeout(timer);
  }, [signature]);
  useEffect(() => {
    const newlyDone = done && !wasDone.current; wasDone.current = done;
    if (!done) { setHidden(false); return; }
    if (newlyDone && previous.current.size && !hidden && !guide.state.dismissed && !document.hidden && effects.once('onboarding')) effects.fire('onboarding', { element: card.current });
    const timer = setTimeout(() => setHidden(true), 800);
    return () => clearTimeout(timer);
  }, [done]);
  if (guide.state.dismissed || (!guide.reopened && done && hidden)) return null;
  return <aside ref={card} className={`getting-started nodrag nopan${done && !guide.reopened ? ' feel-complete' : ''}`} aria-label={t('Getting started')}><header><strong>{t('Getting started')}</strong><button type="button" aria-label={t('Dismiss getting started')} onClick={guide.dismiss}>×</button></header>
    <ol>{steps.map((step, index) => <li key={step.id} data-step={step.id} className={completed.has(step.id) ? 'step-completed' : undefined}><button type="button" disabled={disabled || step.done} onClick={() => onStep(step.id)}><span aria-hidden="true">{step.done ? <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path pathLength="1" d="m3 8 3 3 7-7"/></svg> : index + 1}</span>{t(labels[step.id])}{step.done && <span className="sr-only"> · {t('Done')}</span>}</button></li>)}</ol>
    {guide.tips && <ul className="getting-started-tips">{helperNeeded && <li><button type="button" className="helper-download-link" onClick={onDownloadHelper}>{t('Download helper')}</button></li>}<li>{t('Connected nodes are references.')}</li><li>{t('Drag an output dot to branch.')}</li><li>{t('Cmd/Ctrl+D duplicates with connections.')}</li><li>{t('Custom nodes save reusable instructions.')}</li><li>{t('Collapse or group nodes to tidy.')}</li></ul>}
  </aside>;
}
