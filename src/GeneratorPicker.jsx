import React from 'react';
import { generators } from '../graph.mjs';
import './generator-picker.css';

// The arrow beside Generate chooses who generates a cloud prompt: the person's own Codex (the default) or Nano Banana
// on the site's Gemini key. A native list keeps it compact and accessible; its last, disabled line says what Nano Banana
// can do now (quota left, or why it is unavailable).
export function GeneratorPicker({ id, generator, nano, choose }) {
  const nanoChosen = generator === generators.nanoBanana;
  return <label className={`generator-picker nodrag nopan${nanoChosen ? ' nano' : ''}`} data-tooltip={nanoChosen ? `Nano Banana · ${nano.note}` : 'Generate with Codex or Nano Banana'}>
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
    <select aria-label="Image generator" value={nanoChosen ? generator : ''} onChange={event => choose(id, event.target.value || null)}>
      <option value="">Codex</option>
      <option value={generators.nanoBanana} disabled={!nano.selectable && !nanoChosen}>Nano Banana</option>
      <option value="note" disabled>{nano.note}{nano.budget ? ` · ${nano.budget}` : ''}</option>
    </select>
  </label>;
}
