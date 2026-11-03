import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dictationError, dictationLanguage, dictationResults, insertDictation, nextDictationLanguage, typedLanguage } from './dictation.mjs';

const storageKey = 'concept-graph-dictation-language';
const readLanguage = () => { try { return localStorage.getItem(storageKey) || ''; } catch { return ''; } };
const lastTypedLanguage = { current: readLanguage() };
// Remembered across reloads: Chrome cannot report a Cyrillic layout until the user types.
const rememberLanguage = lang => {
  if (!lang || lang === lastTypedLanguage.current) return;
  lastTypedLanguage.current = lang;
  try { localStorage.setItem(storageKey, lang); } catch { /* Per-viewer convenience only. */ }
};

export function useDictationLanguage() {
  useEffect(() => {
    const remember = event => {
      if (!event.target.closest?.('.app-shell') || !event.target.closest('textarea,input,[contenteditable="true"]')) return;
      if (event.type === 'keydown' && (event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.key.length !== 1)) return;
      if (event.type === 'input' && !['insertText', 'insertCompositionText'].includes(event.inputType)) return;
      rememberLanguage(typedLanguage(event.type === 'keydown' ? event.key : event.data, lastTypedLanguage.current, navigator.language));
    };
    document.addEventListener('keydown', remember, true);
    document.addEventListener('input', remember, true);
    return () => { document.removeEventListener('keydown', remember, true); document.removeEventListener('input', remember, true); };
  }, []);
  return lastTypedLanguage;
}

export function usePromptDictation(editor, value, onChange, language, effects) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const [state, setState] = useState({ active: false, listening: false, stopping: false, language: '', interim: '', error: '' });
  const feedback = useRef(effects); feedback.current = effects;
  const cue = name => feedback.current?.fire(name, { element: editor.current?.closest('.text-node')?.querySelector('.dictation-button') });
  const ended = current => { if (current?.sounded) { current.sounded = false; cue('dictation-stop'); } };
  const session = useRef(null), caret = useRef(null), latest = useRef(null);
  latest.current = { value, onChange };
  const detach = recognition => {
    if (!recognition) return;
    recognition.onstart = () => recognition.abort();
    recognition.onresult = recognition.onerror = recognition.onend = null;
    recognition.abort();
  };
  const cancel = (update = true) => {
    const current = session.current;
    session.current = null;
    caret.current = null;
    ended(current);
    detach(current?.recognition);
    if (update) setState(current => ({ ...current, active: false, listening: false, stopping: false, interim: '' }));
  };
  const stop = () => {
    const current = session.current;
    if (!current || current.stopping) return;
    if (!current.started) { cancel(); return; }
    current.stopping = true;
    setState(state => ({ ...state, listening: false, stopping: true, interim: '' }));
    ended(current);
    current.recognition.stop();
  };
  const begin = (current, lang) => {
    const recognition = current.recognition = new Recognition();
    current.lang = lang;
    recognition.lang = lang;
    recognition.continuous = recognition.interimResults = true;
    setState(state => ({ ...state, language: lang.slice(0, 2).toUpperCase(), interim: '' }));
    recognition.onstart = () => {
      if (session.current !== current) { recognition.abort(); return; }
      current.started = true;
      if (!current.sounded) { current.sounded = true; cue('dictation-start'); }
      setState(state => ({ ...state, listening: true }));
    };
    recognition.onresult = event => {
      if (session.current !== current || !editor.current) return;
      const result = dictationResults(event.results, current.committed);
      current.committed = result.committed;
      if (result.final) {
        const input = editor.current;
        const merged = insertDictation(latest.current.value, result.final, input.selectionStart, input.selectionEnd);
        caret.current = merged.caret;
        latest.current.value = merged.text;
        latest.current.onChange(merged.text);
        feedback.current?.fire('dictated', { element: input });
      }
      setState(state => ({ ...state, interim: current.stopping ? '' : result.interim }));
    };
    recognition.onerror = event => {
      if (session.current !== current) return;
      cancel();
      setState(state => ({ ...state, error: dictationError(event.error) }));
    };
    recognition.onend = () => { if (session.current === current) { ended(current); session.current = null; setState(state => ({ ...state, active: false, listening: false, stopping: false, interim: '' })); } };
    recognition.start();
  };
  const toggle = async () => {
    if (session.current) { stop(); return; }
    if (!Recognition) return;
    const current = { recognition: null, started: false, stopping: false, committed: 0, lang: '' };
    session.current = current;
    setState({ active: true, listening: false, stopping: false, language: '', interim: '', error: '' });
    editor.current?.focus({ preventScroll: true });
    try {
      let layout;
      try { if (navigator.keyboard?.getLayoutMap) layout = await navigator.keyboard.getLayoutMap(); } catch { /* Use the last typed language when the map is blocked. */ }
      if (session.current !== current) return;
      begin(current, dictationLanguage(layout, language.current, navigator.language, latest.current.value));
    } catch (error) {
      if (session.current !== current) return;
      cancel();
      setState(state => ({ ...state, error: dictationError(error.name === 'NotAllowedError' ? 'not-allowed' : '') }));
    }
  };
  // Clicking the language tag cycles UK → EN → RU and restarts listening in that language.
  const switchLanguage = () => {
    const current = session.current;
    if (!current?.lang || current.stopping) return;
    const lang = nextDictationLanguage(current.lang);
    rememberLanguage(lang);
    detach(current.recognition);
    Object.assign(current, { recognition: null, started: false, committed: 0 });
    try { begin(current, lang); } catch { cancel(); setState(state => ({ ...state, error: dictationError('') })); }
  };
  useLayoutEffect(() => {
    if (caret.current === null || !editor.current) return;
    editor.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);
  useEffect(() => () => cancel(false), []);
  useEffect(() => {
    if (!state.active) return;
    // Window blur is not a stop signal: Chrome's microphone prompt takes focus while starting.
    const key = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); stop(); } };
    const outside = event => { if (!editor.current?.closest('.text-node')?.contains(event.target)) stop(); };
    const hidden = () => { if (document.hidden) stop(); };
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [state.active]);
  return { ...state, supported: !!Recognition, toggle, stop, cancel, switchLanguage };
}
