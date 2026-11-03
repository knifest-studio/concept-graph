import React, { useEffect, useRef, useState } from 'react';
import { generationRows } from './generation-tray.mjs';

export function GenerationTray({ runs, launching, user, onFocus, onCancel }) {
  const dismissed = useRef(new Set());
  const [rows, setRows] = useState(() => generationRows(runs));
  useEffect(() => { setRows(current => generationRows(runs, current, Date.now(), dismissed.current)); }, [runs]);
  const ticking = rows.some(row => row.active || !row.error);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setRows(current => generationRows(runs, current, Date.now(), dismissed.current)), 500);
    return () => clearInterval(timer);
  }, [runs, ticking]);
  if (!rows.length && !launching) return <span className="canvas-tagline">A little room to think bigger</span>;
  return <section className="generation-tray" aria-label="Board generations">
    <header><strong>Generations</strong><span role="status">{rows.filter(row => row.active).length || (launching ? 1 : 0)} in progress</span></header>
    <div className="generation-tray-list">{launching && !rows.some(row => row.active) && <div className="generation-tray-row"><span role="status">Starting generation…</span></div>}{rows.map(row => <div key={row.run.id} className={`generation-tray-row${row.error ? ' failed' : ''}${row.run.status === 'completed' ? ' done' : ''}${row.fading ? ' fading' : ''}`}>
      <button type="button" className="generation-tray-focus" onClick={() => onFocus(row.run)} aria-label={`Show prompt: ${row.label}`}>
        <strong title={row.label}>{row.label}</strong>
        <span className="generation-tray-status"><span title={row.run.error || row.status}>{row.run.status === 'completed' && <svg className="feel-check" aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path pathLength="1" d="m3 8 3 3 7-7"/></svg>}{row.status}</span><time aria-label="Elapsed time">{row.elapsed}</time></span>
        {user && row.run.by && <span className="generation-tray-person"><i style={{ background: row.run.by.color }}/>{row.run.by.name}</span>}
      </button>
      {row.active && (!user || row.run.by?.name === user.name) && <button type="button" className="generation-tray-action" aria-label={`Cancel ${row.label}`} onClick={() => onCancel(row.run.id)}>Cancel</button>}
      {row.error && <button type="button" className="generation-tray-action" aria-label={`Dismiss error for ${row.label}`} onClick={() => { dismissed.current.add(row.run.id); setRows(current => current.filter(item => item.run.id !== row.run.id)); }}>Dismiss</button>}
    </div>)}</div>
  </section>;
}
