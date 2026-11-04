import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ViewportPortal } from '@xyflow/react';
import { NodeContextMenu } from './NodeContextMenu.jsx';
import { useCanvasValue } from './canvas-context.jsx';
import './annotations.css';
import { annotationSize, authorInitials, boardAuthor, contrastColor, penPalette, penWidths, stamps, stickyPalette, strokePath } from './annotations.mjs';

export function ColorPicker({ color, colors, label, onChange, allowDefault = false, custom = false }) {
  const root = useRef(null), popup = useRef(null), [position, setPosition] = useState(null);
  const close = () => { root.current?.removeAttribute('open'); setPosition(null); };
  useEffect(() => {
    if (!position) return;
    const outside = event => { if (!root.current?.contains(event.target) && !popup.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside); window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close); };
  }, [position]);
  const choose = value => { onChange(value); close(); };
  const key = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); root.current.querySelector('summary').focus(); } };
  return <details ref={root} className="board-color-picker nodrag nowheel" onToggle={event => { const bounds = event.currentTarget.getBoundingClientRect(); setPosition(event.currentTarget.open ? { left: Math.max(8, Math.min(bounds.left, innerWidth - 164)), top: Math.max(8, Math.min(bounds.bottom + 5, innerHeight - 172)) } : null); }} onDoubleClick={event => event.stopPropagation()} onKeyDown={key}>
    <summary aria-label={label} title={label}><span style={{ background: color || 'var(--panel)' }}/></summary>
    {position && createPortal(<div ref={popup} className="board-color-popover nodrag nowheel" style={{ position: 'fixed', ...position }} role="group" aria-label={label} onKeyDown={key} onDoubleClick={event => event.stopPropagation()}>{allowDefault && <button type="button" className="color-default" onClick={() => choose(undefined)}>Default</button>}{colors.map(value => <button type="button" key={value} className="color-swatch" aria-label={value} aria-pressed={color === value} style={{ background: value }} onClick={() => choose(value)}/>)}{custom && <label className="color-custom">Custom<input type="color" aria-label="Custom group color" value={color || colors[0]} onChange={event => onChange(event.target.value)}/></label>}</div>, document.body)}
  </details>;
}

export function AuthorBadge({ author, compact = false }) {
  const identity = boardAuthor(author);
  if (!identity) return null;
  return <span className={`board-author${compact ? ' compact' : ''}`} title={identity.name} aria-label={`By ${identity.name}`}><span className="author-avatar" style={identity.color ? { background: identity.color, color: contrastColor(identity.color) } : undefined}>{authorInitials(identity)}</span>{!compact && <span className="author-name">{identity.name}</span>}</span>;
}

export function DrawingNode({ id, data, actions }) {
  const size = annotationSize({ type: 'drawing', data });
  return <NodeContextMenu id={id} type="drawing" actions={actions}><div className="drawing-node" style={size}><svg width={size.width} height={size.height} aria-label="Drawing"><path d={strokePath(data.points)} fill="none" stroke={data.color} strokeWidth={data.width} strokeLinecap="round" strokeLinejoin="round"/></svg></div></NodeContextMenu>;
}

export function StickyNode({ id, data, selected, actions }) {
  const autoEdit = useCanvasValue(state => state.focusId === id && state.focusControl === 'sticky');
  const [editing, setEditing] = useState(autoEdit), [draft, setDraft] = useState(data.text);
  const editor = useRef(null), cancelled = useRef(false), unsaved = useRef(null);
  unsaved.current = editing && !cancelled.current && draft !== data.text ? draft : null;
  // Panning a sticky out of view unmounts it; its draft is saved like a blur would.
  useEffect(() => () => { if (unsaved.current !== null) actions.editAnnotation(id, { text: unsaved.current }); }, []);
  useLayoutEffect(() => { if (!editing) setDraft(data.text); }, [data.text, editing]);
  useLayoutEffect(() => { if (autoEdit) { cancelled.current = false; setEditing(true); } }, [autoEdit]);
  useLayoutEffect(() => {
    if (!editing) return;
    // React Flow keeps a new node hidden until it is measured, and hidden fields cannot take focus.
    let frame = 0, attempts = 0;
    const focus = () => {
      editor.current?.focus({ preventScroll: true });
      if (document.activeElement === editor.current || ++attempts > 20) { if (autoEdit) actions.clearFocus(); }
      else frame = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(frame);
  }, [editing, autoEdit]);
  const edit = () => { cancelled.current = false; setDraft(data.text); setEditing(true); };
  const save = () => { if (!cancelled.current && draft !== data.text) actions.editAnnotation(id, { text: draft }); setEditing(false); };
  return <NodeContextMenu id={id} type="sticky" actions={actions}><article className="sticky-node" style={{ background: data.color, color: contrastColor(data.color) }} onDoubleClick={() => { if (!editing) edit(); }} onKeyDown={event => { if (!editing && event.key === 'Enter') { event.stopPropagation(); edit(); } }}>
    <div className="sticky-tools"><ColorPicker color={data.color} colors={stickyPalette} label="Sticky color" onChange={color => actions.editAnnotation(id, { color })}/>{selected && !editing && <button type="button" className="nodrag" aria-label="Edit sticky text" onClick={edit}>Edit</button>}</div>
    {editing ? <textarea ref={editor} autoFocus={autoEdit} className="nodrag nowheel" aria-label="Sticky text" maxLength={10000} value={draft} onChange={event => setDraft(event.target.value)} onBlur={save} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { cancelled.current = true; setEditing(false); } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}/> : <div className="sticky-text">{data.text || <span className="sticky-placeholder">Double-click to write</span>}</div>}
    {data.author && <footer><AuthorBadge author={data.author}/></footer>}
  </article></NodeContextMenu>;
}

export function StampNode({ id, data, actions }) {
  return <NodeContextMenu id={id} type="stamp" actions={actions}><div className="stamp-node" aria-label={`${data.kind} stamp`}><span aria-hidden="true">{stamps[data.kind]}</span>{data.author && <AuthorBadge author={data.author} compact/>}</div></NodeContextMenu>;
}

// Zoomed-out annotations: same size and colour, without tools, author badges or menus.
export function LightAnnotation({ id, type, data }) {
  if (type === 'drawing') { const size = annotationSize({ type, data }); return <div className="drawing-node" style={size}><svg width={size.width} height={size.height} aria-label="Drawing"><path d={strokePath(data.points)} fill="none" stroke={data.color} strokeWidth={data.width} strokeLinecap="round" strokeLinejoin="round"/></svg></div>; }
  if (type === 'stamp') return <div className="stamp-node lod-node" aria-label={`${data.kind} stamp`}><span aria-hidden="true">{stamps[data.kind]}</span></div>;
  const text = String(data.text || '');
  return <article data-feel-node={id} className="sticky-node lod-node" style={{ background: data.color, color: contrastColor(data.color) }}><div className="sticky-text">{text.length > 600 ? `${text.slice(0, 600)}…` : text}</div></article>;
}

const toolNames = { select: ['Select', 'V'], pen: ['Pen', 'P'], sticky: ['Sticky', 'S'], stamp: ['Stamp', 'E'] };
export function AnnotationTools({ tool, onTool, pen, setPen, stickyColor, setStickyColor, stamp, setStamp }) {
  return <div className="annotation-tools" role="group" aria-label="Board tools">{Object.entries(toolNames).map(([value, [name, key]]) => <button type="button" key={value} aria-label={name} aria-pressed={tool === value} data-tooltip={`${name} · ${key}${value === 'select' ? '' : ' · click canvas to place'}`} onClick={() => onTool(value)}>{value === 'stamp' ? <span aria-hidden="true">{stamps[stamp]}</span> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{value === 'select' ? <path d="m5 3 14 10-7 1-3 7Z"/> : value === 'pen' ? <><path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/><path d="M3 23c3-3 5 1 8-1"/></> : <><path d="M4 3h16v12l-6 6H4Z"/><path d="M14 21v-6h6"/></>}</svg>}</button>)}
    {tool !== 'select' && <div className="annotation-options" role="group" aria-label={`${tool} options`}>{tool === 'pen' ? <><ColorPicker color={pen.color} colors={penPalette} label="Pen color" onChange={color => setPen(current => ({ ...current, color }))}/>{penWidths.map(width => <button type="button" key={width} aria-label={`Pen width ${width}`} aria-pressed={pen.width === width} onClick={() => setPen(current => ({ ...current, width }))}><span className="pen-width" style={{ height: width }}/></button>)}</> : tool === 'sticky' ? <ColorPicker color={stickyColor} colors={stickyPalette} label="New sticky color" onChange={setStickyColor}/> : Object.entries(stamps).map(([kind, emoji]) => <button type="button" key={kind} aria-label={`${kind} stamp`} aria-pressed={stamp === kind} onClick={() => setStamp(kind)}>{emoji}</button>)}</div>}
  </div>;
}

export const StrokePreview = forwardRef(function StrokePreview(_, ref) {
  const [stroke, setStroke] = useState(null);
  useImperativeHandle(ref, () => ({ show: (points, pen) => setStroke(points.length ? { points, pen } : null) }), []);
  if (!stroke) return null;
  return <ViewportPortal><svg className="stroke-preview" width="1" height="1" aria-hidden="true"><path d={strokePath(stroke.points)} fill="none" stroke={stroke.pen.color} strokeWidth={stroke.pen.width} strokeLinecap="round" strokeLinejoin="round"/></svg></ViewportPortal>;
});
