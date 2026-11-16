import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@xyflow/react';
import { aspectRatios, codexGenerator, generationCapabilities, generationFields, generationReasons, generators, ratioAspect, resolveGeneration } from '../graph.mjs';
import { costLine, generatorNames, partsText, popoverMargin, settingLabel, settingParts, settingsPosition } from './generation-settings.mjs';
import { matchShortcut } from './shortcuts.mjs';
import { t } from './i18n.mjs';
import './generation-settings.css';

// The shapes shown first; More… opens the rest, Nano Banana's long and tall ones last.
const firstRatios = ['1:1', '3:4', '4:3', '9:16', '16:9'], moreRatios = aspectRatios.filter(ratio => !firstRatios.includes(ratio));
const popoverWidth = 310, viewOnly = 'You can only view this board.', boardKeys = ['edit.undo', 'edit.redo'];

// A small outline of the shape, so the ratios read at a glance.
function Shape({ ratio }) {
  const aspect = ratioAspect(ratio), width = Math.max(2, aspect > 1 ? 10 / aspect : 10), height = Math.max(2, aspect > 1 ? 10 : 10 * aspect);
  return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x={(12 - width) / 2} y={(12 - height) / 2} width={width} height={height} rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2"/></svg>;
}
const Sliders = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h9m4 0h3M4 17h3m4 0h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>;

/**
 * The settings chip at the right end of an image prompt's variants row, and the popover it opens. The popover lives in
 * screen space (a portal over the board), so it stays readable at any zoom and never changes the card's size; it closes
 * on Escape, a click elsewhere, any pan or zoom, and with the card itself (deleted, zoomed out to a light card, another
 * board). Viewers can open it to see the settings; every control is then disabled.
 */
export function GenerationSettings({ id, data, generator, readOnly, references = 0, cloud = true, change }) {
  const [open, setOpen] = useState(false), chip = useRef(null), popoverId = useId();
  // GPT Image keeps a masked image's shape. Only a GPT prompt with a chosen shape or an open popover looks, and only at its
  // own incoming connections (React Flow's lookup), so a large board's cards never walk all of its edges.
  const masked = useStore(state => generator === generators.gptImage && (open || data.aspectRatio !== undefined)
    && [...(state.connectionLookup.get(`${id}-target`)?.values() || [])].some(connection => { const source = state.nodeLookup.get(connection.source); return source?.type === 'image' && !!source.data?.mask; }));
  const node = { id, type: 'text', data }, parts = settingParts(node, generator, { mask: masked });
  const full = parts.map(part => part.off ? `${part.text} (${t(part.reason)})` : part.text).join(' · ') || partsText(parts);
  return <>
    <button ref={chip} type="button" className={`gen-settings-chip${parts.length ? ' set' : ''}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popoverId : undefined}
      aria-label={`${t('Generation settings')}: ${full}`} data-tooltip={`${t('Generation settings')} · ${full}`}
      onClick={() => setOpen(value => !value)} onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); } }}>
      <Sliders/><span className="gen-settings-chip-text">{parts.length ? parts.map((part, index) => <React.Fragment key={part.key}>{index ? ' · ' : ''}<span className={part.off ? 'off' : undefined}>{part.text}</span></React.Fragment>) : partsText(parts)}</span>
    </button>
    {open && <SettingsPopover id={popoverId} node={node} generator={generator} readOnly={readOnly} references={references} cloud={cloud} masked={masked} change={change} chip={chip} close={focusChip => { setOpen(false); if (focusChip) chip.current?.focus({ preventScroll: true }); }}/>}
  </>;
}

function SettingsPopover({ id, node, generator, readOnly, references, cloud, masked, change, chip, close }) {
  const popover = useRef(null), content = useRef(null), [position, setPosition] = useState(null), closing = useRef(close), place = useRef(null);
  closing.current = close;
  const { requested, unsupported } = resolveGeneration(node, generator, { mask: masked }), capabilities = generationCapabilities[generator] || generationCapabilities[codexGenerator];
  const [more, setMore] = useState(() => moreRatios.includes(requested.aspectRatio));
  // Any pan or zoom moves the card away from the popover, so the popover closes instead of floating over the wrong place.
  const transform = useStore(state => state.transform), opened = useRef(transform);
  useEffect(() => { if (transform.some((value, index) => value !== opened.current[index])) closing.current(false); }, [transform]);
  // Placed again whenever its content, the card or the window changes size, and when the card moves (a teammate dragging
  // it, say): the card grows after the popover opens, as the click that opened it also selects the card and that adds its
  // readiness row. The height is the content's own, so a popover held to the room it has can still grow into more.
  const moved = useStore(state => { const at = state.nodeLookup.get(node.id)?.internals.positionAbsolute; return at ? `${at.x},${at.y}` : ''; });
  useLayoutEffect(() => {
    let side;
    place.current = () => {
      const card = chip.current?.closest('.react-flow__node'), element = popover.current;
      if (!card || !element || !content.current) return;
      const style = getComputedStyle(element), frame = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
      const next = settingsPosition(card.getBoundingClientRect(), { width: Math.min(popoverWidth, innerWidth - 2 * popoverMargin), height: content.current.offsetHeight + frame },
        { width: innerWidth, height: innerHeight }, { chip: chip.current.getBoundingClientRect(), side });
      side = next.side;
      setPosition(current => current && current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight ? current : next);
    };
    const update = () => place.current?.();
    update();
    const observer = new ResizeObserver(update), card = chip.current?.closest('.react-flow__node');
    observer.observe(content.current); if (card) observer.observe(card);
    addEventListener('resize', update);
    return () => { observer.disconnect(); removeEventListener('resize', update); };
  }, []);
  useLayoutEffect(() => { place.current?.(); }, [moved]);
  // Focus moves in once the popover is placed (a hidden element cannot take it), so the keyboard reaches its choices.
  const focused = useRef(false);
  useEffect(() => { if (position && !focused.current) { focused.current = true; popover.current?.focus({ preventScroll: true }); } }, [position]);
  useEffect(() => {
    // A press anywhere else closes it and still does what it was for; the chip toggles it itself.
    const outside = event => { if (!popover.current?.contains(event.target) && !chip.current?.contains(event.target)) closing.current(false); };
    const escape = event => { if (event.key === 'Escape') closing.current(false); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); };
  }, []);
  const set = (key, value) => change(node.id, { [key]: value });
  // A choice: pressed when it is the stored value (undefined: nothing stored). A stored value the generator cannot use stays
  // pressed but dimmed, so it can be seen and changed; it is never sent. Disabled choices say why.
  const option = (key, value, label, { reason, pressed = value === undefined ? requested[key] === undefined : requested[key] === value, icon, beta, onPick = () => set(key, value) } = {}) => {
    const why = readOnly ? viewOnly : reason, off = pressed && Object.hasOwn(unsupported, key);
    return <button type="button" key={value ?? 'default'} className={off ? 'off' : undefined} aria-pressed={pressed} disabled={!!why || undefined}
      data-tooltip={why ? t(why) : off ? t(unsupported[key]) : beta} onClick={() => { if (!pressed) onPick(); }}>{icon}{label}{beta ? <sup>β</sup> : null}</button>;
  };
  const ratioReason = ratio => masked ? generationReasons.masked : capabilities.aspectRatio.includes(ratio) ? undefined : generationReasons.nanoOnly;
  const ratioOption = ratio => option('aspectRatio', ratio, ratio, { icon: <Shape ratio={ratio}/>, reason: ratioReason(ratio) });
  const sizeReason = capabilities.imageSize.length ? undefined : generationReasons.codexSize;
  const row = (label, controls, note) => <div className="gen-settings-row" role="group" aria-label={label}><span className="gen-settings-label">{label}</span><div>{controls}{note && <p>{note}</p>}</div></div>;
  return createPortal(<div ref={popover} id={id} tabIndex={-1} className={`gen-settings-popover nodrag nowheel nokey${generator === generators.gptImage ? ' gpt' : ''}`} role="dialog" aria-label={t('Generation settings')}
    style={position ? { left: position.left, top: position.top, ...(position.maxHeight !== undefined ? { maxHeight: position.maxHeight } : {}) } : { visibility: 'hidden' }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(true); return; }
      // Other keys stay here: on the board, Backspace would delete the selected prompt and letters would switch tools.
      // Undo and redo still reach it, so a choice made here can be taken back from here.
      if (!matchShortcut(event, { ids: boardKeys })) event.stopPropagation();
      // Tabbing past either end goes back to the chip instead of leaving focus nowhere at the end of the page.
      const controls = [...popover.current.querySelectorAll('button:not(:disabled)')], at = controls.indexOf(document.activeElement);
      if (event.key === 'Tab' && (event.shiftKey ? at <= 0 : at === controls.length - 1)) { event.preventDefault(); close(true); }
    }}
    onBlur={event => { if (event.relatedTarget && !popover.current?.contains(event.relatedTarget) && !chip.current?.contains(event.relatedTarget)) close(false); }}
    // Clicks stay with the popover: on the board they would select the prompt or open its menu.
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
    <div ref={content}>
    <header><strong>{t('Generation settings')}</strong><span>{generatorNames[generator] || generatorNames[codexGenerator]}</span></header>
    {row(t('Aspect'), <div className="gen-settings-options">{option('aspectRatio', undefined, t('Auto'))}{firstRatios.map(ratioOption)}{more ? moreRatios.map(ratioOption)
      : <button type="button" className="gen-settings-more" aria-expanded="false" onClick={() => setMore(true)}>{t('More…')}</button>}</div>,
      masked ? t(generationReasons.masked) : capabilities.guidance ? t('Added to the prompt as a hint') : null)}
    {/* No stored size is the generator's own, about 1K, so 1K stands for it; Codex has no size of its own to show. */}
    {row(t('Size'), <div className="gen-settings-options">{['1K', '2K', '4K'].map(size => option('imageSize', size, size, { reason: sizeReason,
      pressed: sizeReason ? requested.imageSize === size : (requested.imageSize || '1K') === size, onPick: () => set('imageSize', size === '1K' ? undefined : size),
      beta: capabilities.experimental?.includes(size) ? t('Experimental: OpenAI calls sizes above 2560×1440 experimental.') : undefined }))}</div>, sizeReason && t(sizeReason))}
    {capabilities.shown.includes('nanoThinking') && row(t('Thinking'), <div className="gen-settings-options">{['minimal', undefined, 'high'].map(value => option('nanoThinking', value, settingLabel('nanoThinking', value)))}</div>)}
    {capabilities.shown.includes('gptQuality') && row(t('Quality'), <div className="gen-settings-options">{['low', undefined, 'high'].map(value => option('gptQuality', value, settingLabel('gptQuality', value)))}</div>)}
    {row(t('Background'), <div className="gen-settings-options">{option('background', undefined, t('Normal'))}{option('background', 'transparent', t('Transparent'), { reason: capabilities.background.length ? undefined : generationReasons.nanoBackground })}</div>)}
    <footer><span className="gen-settings-cost" data-tooltip={generator === codexGenerator ? undefined : t('Held from the team budget when the run starts; the real cost is recorded when it finishes.')}>{costLine(node, generator, { references, cloud })}</span>
      <button type="button" className="gen-settings-reset" disabled={readOnly || !Object.keys(generationFields).some(key => node.data[key] !== undefined) || undefined} data-tooltip={readOnly ? t(viewOnly) : undefined}
        onClick={() => change(node.id, Object.fromEntries(Object.keys(generationFields).map(key => [key, undefined])))}>{t('Reset')}</button></footer>
    </div>
  </div>, document.body);
}
