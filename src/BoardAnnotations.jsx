import React, { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NodeResizer, ViewportPortal, useReactFlow } from '@xyflow/react';
import { NodeContextMenu } from './NodeContextMenu.jsx';
import { useCanvasValue } from './canvas-context.jsx';
import './annotations.css';
import { arrowTargetAt } from './canvas.mjs';
import { t } from './i18n.mjs';
import { annotationSize, arrowPalette, authorInitials, boardAuthor, contrastColor, penPalette, penWidths, shapeKinds, shapePalette, stamps, stickyPalette, strokePath } from './annotations.mjs';

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
    {position && createPortal(<div ref={popup} className="board-color-popover nodrag nowheel" style={{ position: 'fixed', ...position }} role="group" aria-label={label} onKeyDown={key} onDoubleClick={event => event.stopPropagation()}>{allowDefault && <button type="button" className="color-default" onClick={() => choose(undefined)}>{t('Default')}</button>}{colors.map(value => <button type="button" key={value} className="color-swatch" aria-label={value} aria-pressed={color === value} style={{ background: value }} onClick={() => choose(value)}/>)}{custom && <label className="color-custom">{t('Custom')}<input type="color" aria-label={t('Custom {label}', { label: label.toLowerCase() })} value={color || colors[0]} onChange={event => onChange(event.target.value)}/></label>}</div>, document.body)}
  </details>;
}

export function AuthorBadge({ author, compact = false }) {
  const identity = boardAuthor(author);
  if (!identity) return null;
  return <span className={`board-author${compact ? ' compact' : ''}`} title={identity.name} aria-label={t('By {name}', { name: identity.name })}><span className="author-avatar" style={identity.color ? { background: identity.color, color: contrastColor(identity.color) } : undefined}>{authorInitials(identity)}</span>{!compact && <span className="author-name">{identity.name}</span>}</span>;
}

export function DrawingNode({ id, data, actions }) {
  const size = annotationSize({ type: 'drawing', data });
  return <NodeContextMenu id={id} type="drawing" actions={actions}><div className="drawing-node" style={size}><svg width={size.width} height={size.height} aria-label={t('Drawing')}><path d={strokePath(data.points)} fill="none" stroke={data.color} strokeWidth={data.width} strokeLinecap="round" strokeLinejoin="round"/></svg></div></NodeContextMenu>;
}

export function StickyNode({ id, data, selected, actions }) {
  const autoEdit = useCanvasValue(state => state.focusId === id && state.focusControl === 'sticky'), readOnly = useCanvasValue(state => state.readOnly);
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
  const edit = () => { if (readOnly) return; cancelled.current = false; setDraft(data.text); setEditing(true); };
  const save = () => { if (!cancelled.current && draft !== data.text) actions.editAnnotation(id, { text: draft }); setEditing(false); };
  return <NodeContextMenu id={id} type="sticky" actions={actions}><article className="sticky-node" style={{ background: data.color, color: contrastColor(data.color) }} onDoubleClick={() => { if (!editing) edit(); }} onKeyDown={event => { if (!editing && event.key === 'Enter') { event.stopPropagation(); edit(); } }}>
    <div className="sticky-tools"><ColorPicker color={data.color} colors={stickyPalette} label={t('Sticky color')} onChange={color => actions.editAnnotation(id, { color })}/>{selected && !editing && !readOnly && <button type="button" className="nodrag" aria-label={t('Edit sticky text')} onClick={edit}>{t('Edit')}</button>}</div>
    {editing ? <textarea ref={editor} autoFocus={autoEdit} className="nodrag nowheel" aria-label={t('Sticky text')} maxLength={10000} value={draft} onChange={event => setDraft(event.target.value)} onBlur={save} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { cancelled.current = true; setEditing(false); } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}/> : <div className="sticky-text">{data.text || (!readOnly && <span className="sticky-placeholder">{t('Double-click to write')}</span>)}</div>}
    {data.author && <footer><AuthorBadge author={data.author}/></footer>}
  </article></NodeContextMenu>;
}

export function StampNode({ id, data, actions }) {
  return <NodeContextMenu id={id} type="stamp" actions={actions}><div className="stamp-node" aria-label={stampName(data.kind)}><span aria-hidden="true">{stamps[data.kind]}</span>{data.author && <AuthorBadge author={data.author} compact/>}</div></NodeContextMenu>;
}

// Text typed into a sticky or a shape: Enter edits a selected one, Escape cancels, a blur or panning away saves.
function useAnnotationText(id, text, actions) {
  const autoEdit = useCanvasValue(state => state.focusId === id && state.focusControl === 'sticky'), readOnly = useCanvasValue(state => state.readOnly);
  const [editing, setEditing] = useState(autoEdit), [draft, setDraft] = useState(text);
  const editor = useRef(null), cancelled = useRef(false), unsaved = useRef(null);
  unsaved.current = editing && !cancelled.current && draft !== text ? draft : null;
  useEffect(() => () => { if (unsaved.current !== null) actions.editAnnotation(id, { text: unsaved.current }); }, []);
  useLayoutEffect(() => { if (!editing) setDraft(text); }, [text, editing]);
  useLayoutEffect(() => { if (autoEdit) { cancelled.current = false; setEditing(true); } }, [autoEdit]);
  useLayoutEffect(() => {
    if (!editing) return;
    let frame = 0, attempts = 0;
    const focus = () => {
      editor.current?.focus({ preventScroll: true });
      if (document.activeElement === editor.current || ++attempts > 20) { if (autoEdit) actions.clearFocus(); }
      else frame = requestAnimationFrame(focus);
    };
    focus();
    return () => cancelAnimationFrame(frame);
  }, [editing, autoEdit]);
  const edit = () => { if (readOnly) return; cancelled.current = false; setDraft(text); setEditing(true); };
  const save = () => { if (!cancelled.current && draft !== text) actions.editAnnotation(id, { text: draft }); setEditing(false); };
  const field = props => <textarea ref={editor} className="nodrag nowheel" maxLength={10000} value={draft} onChange={event => setDraft(event.target.value)} onBlur={save}
    onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape') { cancelled.current = true; setEditing(false); } }} {...props}/>;
  return { editing, edit, field, readOnly };
}

const shapeNames = { rectangle: 'Rectangle', ellipse: 'Ellipse', diamond: 'Diamond', triangle: 'Triangle' };
const shapeName = kind => t(shapeNames[kind]);
function ShapeOutline({ kind, width, height, fill }) {
  const props = { fill, stroke: '#25243d55', strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' };
  return <svg className="shape-outline" width={width} height={height} aria-hidden="true">{kind === 'ellipse' ? <ellipse cx={width / 2} cy={height / 2} rx={width / 2 - 1} ry={height / 2 - 1} {...props}/>
    : kind === 'diamond' ? <polygon points={`${width / 2},1 ${width - 1},${height / 2} ${width / 2},${height - 1} 1,${height / 2}`} {...props}/>
    : kind === 'triangle' ? <polygon points={`${width / 2},1 ${width - 1},${height - 1} 1,${height - 1}`} {...props}/>
    : <rect x={1} y={1} width={width - 2} height={height - 2} rx={8} {...props}/>}</svg>;
}
const shapeIcon = kind => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true">{kind === 'ellipse' ? <circle cx="12" cy="12" r="8.5"/> : kind === 'diamond' ? <path d="M12 3 21 12 12 21 3 12Z"/> : kind === 'triangle' ? <path d="M12 4 21 20H3Z"/> : <rect x="4" y="4" width="16" height="16" rx="2.5"/>}</svg>;

export function ShapeNode({ id, data, selected, actions }) {
  const text = useAnnotationText(id, data.text || '', actions), ink = contrastColor(data.color);
  return <NodeContextMenu id={id} type="shape" actions={actions}><div className={`shape-node shape-${data.shape}`} style={{ width: data.width, height: data.height, color: ink }} onDoubleClick={() => { if (!text.editing) text.edit(); }} onKeyDown={event => { if (!text.editing && event.key === 'Enter') { event.stopPropagation(); text.edit(); } }}>
    <NodeResizer isVisible={selected && !text.readOnly} minWidth={40} minHeight={40} color="var(--purple)"/>
    <ShapeOutline kind={data.shape} width={data.width} height={data.height} fill={data.color}/>
    <div className="shape-text">{text.editing ? text.field({ 'aria-label': t('Shape text'), style: { color: ink } }) : data.text ? <span>{data.text}</span> : selected && !text.readOnly ? <span className="shape-placeholder">{t('Double-click to add text')}</span> : null}</div>
    {selected && !text.editing && !text.readOnly && <div className="annotation-toolbar nodrag" role="toolbar" aria-label={t('Shape options')}>
      <ColorPicker color={data.color} colors={shapePalette} label={t('Shape color')} onChange={color => actions.editAnnotation(id, { color })}/>
      {shapeKinds.map(kind => <button type="button" key={kind} aria-label={shapeName(kind)} aria-pressed={data.shape === kind} data-tooltip={shapeName(kind)} onClick={() => actions.editAnnotation(id, { shape: kind })}>{shapeIcon(kind)}</button>)}
    </div>}
    {data.author && selected && <footer className="shape-author"><AuthorBadge author={data.author} compact/></footer>}
  </div></NodeContextMenu>;
}

// A filled head at (x2, y2), pointing away from (x1, y1).
function arrowHead(x1, y1, x2, y2, size) {
  const angle = Math.atan2(y2 - y1, x2 - x1), back = (side, spread) => `${x2 - size * Math.cos(angle + side * spread)},${y2 - size * Math.sin(angle + side * spread)}`;
  return `${x2},${y2} ${back(1, .45)} ${back(-1, .45)}`;
}
function ArrowShape({ line, data, width = 2.5, children }) {
  const { x1, y1, x2, y2 } = line, color = data.color, length = Math.hypot(x2 - x1, y2 - y1), head = Math.min(14, length / 2);
  // The line stops at the base of a head, so a thick stroke never pokes out past its tip.
  const trim = (ax, ay, bx, by, on) => on && length > 0 ? [bx - (bx - ax) * (head * .8) / length, by - (by - ay) * (head * .8) / length] : [bx, by];
  const [ex, ey] = trim(x1, y1, x2, y2, data.endArrow !== false), [sx, sy] = trim(x2, y2, x1, y1, data.startArrow === true);
  return <>
    <line x1={sx} y1={sy} x2={ex} y2={ey} stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={data.dashed ? '8 7' : undefined}/>
    {data.endArrow !== false && length > 0 && <polygon points={arrowHead(x1, y1, x2, y2, head)} fill={color}/>}
    {data.startArrow === true && length > 0 && <polygon points={arrowHead(x2, y2, x1, y1, head)} fill={color}/>}
    {children}
  </>;
}

const toggleIcons = { dashed: <path d="M3 12h4m4 0h3m4 0h3"/>, start: <path d="M20 12H5m5-5-5 5 5 5"/>, end: <path d="M4 12h15m-5-5 5 5-5 5"/> };
const toggleIcon = name => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{toggleIcons[name]}</svg>;

 export function ArrowNode({ id, data, selected, positionAbsoluteX, positionAbsoluteY, actions }) {
  const readOnly = useCanvasValue(state => state.readOnly), flow = useReactFlow(), [drag, setDrag] = useState(null);
  const line = drag ? { ...data.line, ...(drag.end === 'from' ? { x1: drag.x, y1: drag.y } : { x2: drag.x, y2: drag.y }) } : data.line;
  const local = event => { const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }); return { x: point.x - positionAbsoluteX, y: point.y - positionAbsoluteY, point }; };
  const grab = end => event => {
    if (event.button !== 0) return;
    event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ end, ...local(event) });
  };
  const move = event => { if (drag) { event.stopPropagation(); setDrag(current => ({ ...current, ...local(event) })); } };
  const drop = event => {
    if (!drag) return;
    event.stopPropagation();
    const { point } = local(event), node = arrowTargetAt(flow.getNodes(), point, id);
    setDrag(null);
    actions.setArrowEnd(id, drag.end, { x: point.x, y: point.y, ...(node ? { node } : {}) });
  };
  const toggle = key => actions.editAnnotation(id, { [key]: key === 'endArrow' ? data.endArrow === false : !data[key] });
  const top = Math.min(line.y1, line.y2), middle = (line.x1 + line.x2) / 2;
  return <NodeContextMenu id={id} type="arrow" actions={actions}><div className={`arrow-node${selected ? ' selected' : ''}`}>
    <svg aria-label={t('Arrow')} width="1" height="1">
      <line className="arrow-hit" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2}/>
      <ArrowShape line={line} data={data}>
        {selected && !readOnly && [['from', line.x1, line.y1], ['to', line.x2, line.y2]].map(([end, x, y]) => <circle key={end} className="arrow-end nodrag" cx={x} cy={y} r={6} onPointerDown={grab(end)} onPointerMove={move} onPointerUp={drop} onPointerCancel={() => setDrag(null)}><title>{t('Drag onto a shape, sticky or node to attach')}</title></circle>)}
      </ArrowShape>
    </svg>
    {selected && !drag && !readOnly && <div className="annotation-toolbar arrow-toolbar nodrag" role="toolbar" aria-label={t('Arrow options')} style={{ left: middle, top }}>
      <ColorPicker color={data.color} colors={arrowPalette} label={t('Arrow color')} onChange={color => actions.editAnnotation(id, { color })}/>
      <button type="button" aria-label={t('Dashed line')} aria-pressed={!!data.dashed} data-tooltip={t('Dashed line')} onClick={() => toggle('dashed')}>{toggleIcon('dashed')}</button>
      <button type="button" aria-label={t('Arrowhead at start')} aria-pressed={data.startArrow === true} data-tooltip={t('Arrowhead at start')} onClick={() => toggle('startArrow')}>{toggleIcon('start')}</button>
      <button type="button" aria-label={t('Arrowhead at end')} aria-pressed={data.endArrow !== false} data-tooltip={t('Arrowhead at end')} onClick={() => toggle('endArrow')}>{toggleIcon('end')}</button>
    </div>}
  </div></NodeContextMenu>;
}

// Zoomed-out annotations: same size and colour, without tools, author badges or menus.
export function LightAnnotation({ id, type, data }) {
  if (type === 'shape') return <div className={`shape-node lod-node shape-${data.shape}`} style={{ width: data.width, height: data.height, color: contrastColor(data.color) }}><ShapeOutline kind={data.shape} width={data.width} height={data.height} fill={data.color}/>{data.text && <div className="shape-text"><span>{data.text.slice(0, 300)}</span></div>}</div>;
  if (type === 'arrow') return <div className="arrow-node lod-node"><svg aria-label={t('Arrow')} width="1" height="1"><ArrowShape line={data.line} data={data}/></svg></div>;
  if (type === 'drawing') { const size = annotationSize({ type, data }); return <div className="drawing-node" style={size}><svg width={size.width} height={size.height} aria-label={t('Drawing')}><path d={strokePath(data.points)} fill="none" stroke={data.color} strokeWidth={data.width} strokeLinecap="round" strokeLinejoin="round"/></svg></div>; }
  if (type === 'stamp') return <div className="stamp-node lod-node" aria-label={stampName(data.kind)}><span aria-hidden="true">{stamps[data.kind]}</span></div>;
  const text = String(data.text || '');
  return <article data-feel-node={id} className="sticky-node lod-node" style={{ background: data.color, color: contrastColor(data.color) }}><div className="sticky-text">{text.length > 600 ? `${text.slice(0, 600)}…` : text}</div></article>;
}

// Laid out like FigJam's toolbar: Select; the marker, sticky and shapes "props" that peek up from the bar; then line
// icons. Shapes and arrows share one prop, as FigJam's shapes and connectors do, and a tray above picks the kind and colour.
const toolNames = { select: ['Select', 'V'], pen: ['Pen', 'P'], shape: ['Shape', 'R / O'], arrow: ['Arrow', 'L'], sticky: ['Sticky', 'S'], stamp: ['Stamp', 'E'], section: ['Section', 'Shift S'] };
const toolHint = value => value === 'select' ? '' : value === 'section' ? ` · ${t('drag on the canvas to draw; with a selection, Shift S wraps it')}`
  : value === 'shape' ? ` · ${t('click to place or drag to size')}` : value === 'arrow' ? ` · ${t('drag between things to connect them')}` : ` · ${t('click canvas to place')}`;
const stampNames = { like: 'like stamp', heart: 'heart stamp', star: 'star stamp', check: 'check stamp', question: 'question stamp', fire: 'fire stamp' };
const stampName = kind => Object.hasOwn(stampNames, kind) ? t(stampNames[kind]) : `${kind} stamp`;
const toolOptions = { pen: 'pen options', shape: 'shape options', arrow: 'arrow options', sticky: 'sticky options', stamp: 'stamp options' };
const lineIcon = (paths, size = 22) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
const toolIcons = { select: <path d="M5.5 3.5 19 10.2l-6.3 1.9L9.9 18.8Z"/>, section: <><rect x="3" y="4" width="18" height="16" rx="2"/><rect x="6" y="7" width="7" height="3" rx="1.5"/></>,
  stamp: <><path d="M12 3a3 3 0 0 1 3 3c0 1.7-1 2.4-1 4v2h-4v-2c0-1.6-1-2.3-1-4a3 3 0 0 1 3-3Z"/><path d="M5 14.5h14v3.5H5zM6 21h12"/></> };
// The props: a marker whose tip is the pen colour, a stack of stickies in the sticky colour, and FigJam's square, arrow and circle.
const Marker = ({ color }) => <svg width="30" height="58" viewBox="0 0 30 58" aria-hidden="true"><path d="M15 2 20 14H10Z" fill={color}/><path d="M10 14h10l4 10H6Z" fill="#e4e4ec"/><rect x="6" y="24" width="18" height="34" rx="2" fill="#fff" stroke="#d3d3dd"/><path d="M19 26v30" stroke="#ececf2" strokeWidth="3"/></svg>;
const StickyStack = ({ color }) => <svg width="50" height="56" viewBox="0 0 50 56" aria-hidden="true"><rect x="8" y="8" width="36" height="46" rx="2" transform="rotate(-9 26 31)" style={{ fill: `color-mix(in srgb, ${color} 82%, #25243d)` }}/><path d="M6 12h36v36l-8 8H6Z" fill={color}/><path d="M34 56v-8h8Z" style={{ fill: `color-mix(in srgb, ${color} 70%, #25243d)` }}/></svg>;
const ShapesArt = () => <svg width="54" height="54" viewBox="0 0 54 54" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="14" width="23" height="23" rx="2"/><path d="M32 19c1-7 6-11 14-11m-5-5 5 5-5 5"/><circle cx="41" cy="35" r="9"/></svg>;
const swatches = (colors, value, choose, label) => colors.map(color => <button type="button" key={color} className="tray-swatch" style={{ background: color }} aria-label={`${label} ${color}`} aria-pressed={value === color} onClick={() => choose(color)}/>);

export function AnnotationTools({ tool, onTool, pen, setPen, stickyColor, setStickyColor, stamp, setStamp, shape, setShape, arrowColor, setArrowColor }) {
  const button = (value, content, className = 'tool-button') => <button type="button" key={value} className={className} aria-label={t(toolNames[value][0])} aria-pressed={tool === value || (value === 'shape' && tool === 'arrow')}
    data-tooltip={`${t(toolNames[value][0])} · ${toolNames[value][1]}${toolHint(value)}`} onClick={() => onTool(value)}>{content}</button>;
  return <>
    <div className="toolbar-group" role="group" aria-label={t('Board tools')}>{button('select', lineIcon(toolIcons.select))}</div><i className="toolbar-divider"/>
    <div className="toolbar-group toolbar-props">{button('pen', <Marker color={pen.color}/>, 'tool-prop')}{button('sticky', <StickyStack color={stickyColor}/>, 'tool-prop')}{button('shape', <ShapesArt/>, 'tool-prop')}</div><i className="toolbar-divider"/>
    <div className="toolbar-group">{button('section', lineIcon(toolIcons.section))}{button('stamp', lineIcon(toolIcons.stamp))}</div>
    {!['select', 'section'].includes(tool) && <div className="annotation-options" role="group" aria-label={Object.hasOwn(toolOptions, tool) ? t(toolOptions[tool]) : `${tool} options`}>{['shape', 'arrow'].includes(tool) ? <>
        {shapeKinds.map(kind => <button type="button" key={kind} aria-label={shapeName(kind)} aria-pressed={tool === 'shape' && shape.kind === kind} data-tooltip={`${shapeName(kind)}${kind === 'rectangle' ? ' · R' : kind === 'ellipse' ? ' · O' : ''}`} onClick={() => { setShape(current => ({ ...current, kind })); onTool('shape'); }}>{shapeIcon(kind)}</button>)}
        <button type="button" aria-label={t('Arrow')} aria-pressed={tool === 'arrow'} data-tooltip={`${t('Arrow')} · L${toolHint('arrow')}`} onClick={() => onTool('arrow')}>{lineIcon(<path d="M5 19 19 5m-8 0h8v8"/>, 16)}</button><i className="tray-divider"/>
        {tool === 'arrow' ? swatches(arrowPalette, arrowColor, setArrowColor, t('New arrow color')) : swatches(shapePalette, shape.color, color => setShape(current => ({ ...current, color })), t('New shape color'))}</>
      : tool === 'pen' ? <>{swatches(penPalette, pen.color, color => setPen(current => ({ ...current, color })), t('Pen color'))}<i className="tray-divider"/>{penWidths.map(width => <button type="button" key={width} aria-label={t('Pen width {width}', { width })} aria-pressed={pen.width === width} onClick={() => setPen(current => ({ ...current, width }))}><span className="pen-width" style={{ height: width }}/></button>)}</>
      : tool === 'sticky' ? swatches(stickyPalette, stickyColor, setStickyColor, t('New sticky color'))
      : Object.entries(stamps).map(([kind, emoji]) => <button type="button" key={kind} aria-label={stampName(kind)} aria-pressed={stamp === kind} onClick={() => setStamp(kind)}>{emoji}</button>)}</div>}
  </>;
}

// The rectangle a Section tool drag will create, in canvas coordinates.
export const SectionPreview = forwardRef(function SectionPreview(_, ref) {
  const [rect, setRect] = useState(null);
  useImperativeHandle(ref, () => ({ show: value => setRect(value) }), []);
  if (!rect) return null;
  return <ViewportPortal><div className="section-draft" style={{ transform: `translate(${rect.x}px, ${rect.y}px)`, width: rect.width, height: rect.height }} aria-hidden="true"/></ViewportPortal>;
});

export const StrokePreview = forwardRef(function StrokePreview(_, ref) {
  const [stroke, setStroke] = useState(null);
  useImperativeHandle(ref, () => ({ show: (points, pen) => setStroke(points.length ? { points, pen } : null) }), []);
  if (!stroke) return null;
  return <ViewportPortal><svg className="stroke-preview" width="1" height="1" aria-hidden="true"><path d={strokePath(stroke.points)} fill="none" stroke={stroke.pen.color} strokeWidth={stroke.pen.width} strokeLinecap="round" strokeLinejoin="round"/></svg></ViewportPortal>;
});
