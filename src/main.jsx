import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal, flushSync } from 'react-dom';
import { ReactFlow, ReactFlowProvider, Background, BaseEdge, getBezierPath, Handle, NodeResizer, NodeResizeControl, Position, SelectionMode, ViewportPortal, applyNodeChanges, applyEdgeChanges, addEdge, useReactFlow, useNodesInitialized, useStore, useStoreApi } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import { formatDuration, runElapsed } from '../timing.mjs';
import { maxNodes, templatePalette, templateColor, nextTemplateColor, templateSnapshot, describeTask, isDescribe } from '../graph.mjs';
import { ButtonHelp } from './ButtonHelp.jsx';
import { nodeClipboardType, selectedGraph, readNodeClipboard, cloneSelection, copyImageToClipboard } from './clipboard.mjs';
import { connectionColor, edgeDropCreatesPrompt, promptOverflows, arrowTargetAt, boardExtent, detachArrows, slideshowState, steppedSlide, frameBox, cleanGroups, pruneGroups, canvasView, createViewCache, viewSize as measureView, visibleTitles, lodHandleProps, moveGroup, sectionContents, captureSections, moveCaptured, wrapBounds, alignSelection, freshOutputNodes, mergeAddedGroups, preserveFreshOutputGroups, mergeRemoteImageCaptions, preserveRemoteImageCaptions, restoreFirstImageFallback, stampTargetAt, attachStampAt, boxTouches, boxSelection, reselect } from './canvas.mjs';
import { cloudHelperDownload, fetchHelperArchive, helperOutdated } from './helper-download.mjs';
import { detectPlatform } from './platform-detection.mjs';
import { useCanvasImage, useImageButtonZoom } from './canvas-image-hooks.jsx';
import { NodeContextMenu } from './NodeContextMenu.jsx';
import { AnnotationTools, ArrowNode, AuthorBadge, ColorPicker, DrawingNode, LightAnnotation, SectionPreview, ShapeNode, StickyNode, StampNode, StrokePreview } from './BoardAnnotations.jsx';
import { arrowPalette, arrowPosition, boardAuthor, stamps, drawingFromStroke, isAnnotation, penPalette, reconcileArrows, shapeDefault, shapePalette, simplifyStroke, stickyPalette, contrastColor, reconcileStampAttachments } from './annotations.mjs';
import { cleanSections, maxSections, mergeSections, nextSectionName, sectionDefault, sectionMinimum, sectionPalette } from './sections.mjs';
import { captureHistory, cleanEdges, cleanNodes, historySignature, snapshotSignature } from './history.mjs';
import { NodeTemplatePicker } from './NodeTemplatePicker.jsx';
import { GeneratorPicker, VariantRow } from './GeneratorPicker.jsx';
import { nanoState, usesNano } from './generator.mjs';
import { imageInfo } from './image-info.mjs';
import { RunDiagnostics } from './RunDiagnostics.jsx';
import { GenerationTray } from './GenerationTray.jsx';
import { generationFocusNodes } from './generation-tray.mjs';
import { switchNodeTemplate, templateFromNode } from './node-template.mjs';
import { GettingStarted, useGettingStarted } from './GettingStarted.jsx';
import { keepDialogFocus, restoreDialogFocus } from './dialog-focus.mjs';
import { NodeFeedback, useInteractionFeedback } from './InteractionFeedback.jsx';
import { useDictationLanguage, usePromptDictation } from './usePromptDictation.jsx';
import { BoardPages } from './BoardPages.jsx';
import { LanguageSelect } from './LanguageSelect.jsx';
import { plural, t } from './i18n.mjs';
import { rich } from './i18n-rich.jsx';
import { arrangeLayers, layerShortcut, nextLayer, stackOnTop } from './layers.mjs';
import { assignPage, boardPages, defaultPageId, defaultPages, maxPages, mergePages, nextPageName, nodePage, pageContent, pageName, pageResolver, readPagePreference, resolvePage, storedPages, writePagePreference } from './pages.mjs';
import { gettingStartedKey, generationReadiness, generationIntent, intentUnchanged, inputLabel, freePromptPosition, freeSpot, focusViewport } from './onboarding.mjs';
import { CanvasContext, useCanvas, useCanvasValue, useDetail } from './canvas-context.jsx';
import { createCanvasStore, detailLevel, inputCounts, latestCommands, outsideViewport, runAuthor, runLookups, shallowEqual } from './canvas-store.mjs';

const cloud = import.meta.env.VITE_CONCEPT_GRAPH_CLOUD === '1';
const hosted = !cloud && import.meta.env.VITE_CONCEPT_GRAPH_HOSTED === '1';
const CloudWorkspace = cloud ? React.lazy(() => import('./CloudWorkspace.jsx')) : null;
const helperOrigin = 'http://127.0.0.1:43170';
let helperToken = '';
const endpoint = url => hosted ? helperOrigin + url : url;
const tokenUrl = url => hosted ? `${endpoint(url)}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(helperToken)}` : url;
const assetUrl = asset => tokenUrl(`/assets/${asset}`);
if (hosted) {
  const policy = document.createElement('meta');
  policy.name = 'referrer'; policy.content = 'no-referrer'; document.head.appendChild(policy);
}
async function request(url, options = {}) {
  const { helper = false, ...init } = options;
  const localHelper = hosted || (cloud && helper);
  const headers = new Headers(init.headers || {});
  if (localHelper) headers.set('X-Concept-Graph-Token', helperToken);
  return fetch(localHelper ? helperOrigin + url : url, { ...init, headers, ...(localHelper ? { targetAddressSpace: 'loopback', credentials: 'omit', cache: 'no-store' } : {}) });
}
const id = () => crypto.randomUUID();
// Clearing a selection copies only what was selected, so unchanged cards keep their identity and do not re-render.
const deselected = item => item.selected ? { ...item, selected: false } : item;
// A card that folds or unfolds changes size; its old measurement would misplace its connections until React Flow re-measures.
const refolded = (node, collapsed) => { const { measured, ...rest } = node; return { ...rest, data: { ...node.data, collapsed } }; };
const busy = run => ['running', 'queued'].includes(run?.status);
const generateShortcut = () => /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent) ? '⌘ Enter' : 'Ctrl+Enter';
// Only an explicit selection is aligned, so drawings and stamps around other nodes never shift by accident.
const alignIds = scoped => new Set([...scoped.nodes.filter(node => node.selected).map(node => node.id), ...scoped.groups.filter(group => group.selected).flatMap(group => group.nodeIds)]);
const finishBoardEdit = () => { const element = document.activeElement; if (element?.matches('.sticky-node textarea,.group-name-input,.section-name-input')) flushSync(() => element.blur()); };

function Icon({ name, size = 18 }) {
  const paths = {
    sound: <><path d="M11 4 6 8H3v8h3l5 4Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
    muted: <><path d="M11 4 6 8H3v8h3l5 4Z"/><path d="m16 9 6 6m0-6-6 6"/></>,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></>,
    group: <><rect x="3" y="3" width="18" height="18" rx="3" strokeDasharray="3 3"/><rect x="7" y="7" width="4" height="4"/><rect x="13" y="13" width="4" height="4"/></>,
    align: <><rect x="2" y="9" width="6" height="6" rx="1"/><rect x="16" y="2" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M8 12h4m4-7h-4v14h4"/></>,
    chevron: <path d="m8 5 7 7-7 7"/>, boards: <><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></>, eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>, slides: <><rect x="6" y="5" width="12" height="14" rx="2"/><path d="M3 8v8m18-8v8"/></>, describe: <><rect x="3" y="4" width="9" height="9" rx="1.5"/><path d="M15 6h6M15 10h6M3 17h18M3 21h12"/></>, ungroup: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><path d="m9 9 6 6m0-6-6 6"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
    moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/></>,
    edit: <><path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>, image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 16 5-5 4 4 4-6 5 8"/></>,
    text: <><path d="M4 5h16M12 5v14M8 19h8"/></>, play: <path d="m8 5 11 7-11 7z"/>, arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    tag: <><path d="M20 13 13 20 4 11V4h7l9 9Z"/><circle cx="8" cy="8" r="1"/></>,
    expand: <path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>, collapse: <path d="M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5"/>, download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>, back: <path d="M19 12H5m6-6-6 6 6 6"/>, undo: <path d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12"/>, redo: <path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>,
    minus: <path d="M5 12h14"/>, check: <path d="m5 12 4 4L19 6"/>, clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>, branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m12-10c0 7-12 1-12 8"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.plus}</svg>;
}

const noInputs = { images: 0, text: 0 };
const failedRun = run => ['error', 'failed'].includes(run?.status);
const NanoReadiness = ({ note }) => <div className="node-readiness nodrag"><span>{note}</span></div>;
const Readiness = ({ readiness, action, fix }) => <div className="node-readiness nodrag"><span>{readiness === 'helper' ? t('Helper not connected.') : readiness === 'install' ? t('Codex is not installed.') : readiness === 'signin' ? t('Sign-in needed.') : t('Codex is not ready.')}</span><button type="button" onClick={fix}>{action}</button></div>;
// What a prompt shows about its latest run; `now` counts only while that run is active, so idle cards ignore the timer.
const runView = (state, id) => {
  const run = state.latestRun.get(id), active = busy(run);
  return { runId: run?.id, status: run?.status, error: run?.error, active, starting: state.starting === id, byName: run?.by?.name, timer: active ? formatDuration(runElapsed(run, state.now)) : '' };
};

const toolType = 'application/x-concept-graph-tool';
// A prompt grows with its text up to a square, then scrolls; dragging its bottom edge stores its own height instead.
const textHeights = Object.freeze({ min: 80, max: 4000 });
const textHeight = data => data.height ? { height: data.height, maxHeight: 'none' } : undefined;
const hiddenBelow = input => input.scrollHeight - input.scrollTop - input.clientHeight > 2;

// With the Stamp tool the pointer carries the chosen stamp over the board, as in FigJam; over the toolbar and panels the
// usual pointer comes back.
function StampCursor({ emoji, area, start }) {
  const ref = useRef(null);
  useEffect(() => {
    const element = area.current, cursor = ref.current;
    if (!element || !cursor) return;
    const place = (x, y, shown) => { cursor.style.transform = `translate(${x}px, ${y}px)`; cursor.style.opacity = shown ? '1' : '0'; };
    const move = event => place(event.clientX, event.clientY, !!event.target.closest?.('.react-flow__pane, .react-flow__node, .react-flow__edge'));
    const leave = () => { cursor.style.opacity = '0'; };
    if (start) { const under = document.elementFromPoint(start.x, start.y); place(start.x, start.y, !!under?.closest('.react-flow__pane, .react-flow__node, .react-flow__edge')); }
    element.addEventListener('pointermove', move); element.addEventListener('pointerleave', leave);
    return () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerleave', leave); };
  }, []);
  return createPortal(<div ref={ref} className="stamp-cursor" aria-hidden="true">{emoji}</div>, document.body);
}

function TextNode(props) {
  return useDetail(props.id) === 'full' ? <FullTextNode {...props}/> : <LightNode {...props}/>;
}

function FullTextNode(props) {
  const working = useCanvasValue(state => busy(state.latestRun.get(props.id)) || state.starting === props.id);
  return <NodeFeedback id={props.id} working={working}>{props.data.collapsed ? <CollapsedNode {...props} kind="text"/> : <ExpandedTextNode {...props}/>}</NodeFeedback>;
}

function ExpandedTextNode({ id, data, selected }) {
  const canvas = useCanvas();
  const view = useCanvasValue(state => ({ ...runView(state, id), userName: state.userName, inputs: inputLabel(state.inputs.get(id) || noInputs), readiness: state.readinessKey, readinessAction: state.readinessAction,
    focus: state.focusId === id ? state.focusControl : null, highlight: state.highlight === `${id}:generate`, templates: state.templates, images: (state.inputs.get(id) || noInputs).images, nanoSelectable: state.nanoSelectable, nanoReady: state.nanoReady, nanoNote: state.nanoNote, nanoBudget: state.nanoBudget, readOnly: state.readOnly }), shallowEqual);
  const pending = view.active || view.starting;
  const canCancel = !cloud || view.starting || view.byName === view.userName;
  const [draft, setDraft] = useState(data.text), [more, setMore] = useState(false);
  // A describe node needs only images; its text is an optional focus for the description.
  const describe = data.task === describeTask, canRun = describe ? view.images > 0 : !!draft.trim() || !!data.template?.instructions?.trim();
  const editor = useRef(null), generateButton = useRef(null), edited = useRef(false);
  const changeText = value => { setDraft(value); if (!edited.current) { canvas.checkpoint(); edited.current = true; } canvas.editText(id, value); };
  const dictation = usePromptDictation(editor, draft, changeText, canvas.dictationLanguage, canvas);
  // A Nano Banana prompt needs no helper; it is blocked only by what the site allows this person.
  // A Gemini description needs no daily images, only the person's place on the allowed list.
  const nano = cloud && usesNano(data), blocked = nano ? (describe ? !view.nanoSelectable : !view.nanoReady) : view.readiness !== 'ready', connect = blocked && !nano;
  // React Flow propagates node data through its store after the input event.
  // Keep the controlled input synchronous so React never restores an old value/caret.
  useLayoutEffect(() => {
    if (cloud || document.activeElement !== editor.current) setDraft(data.text);
  }, [data.text]);
  // The text grows the card up to a square (or the height its bottom edge was dragged to), then scrolls; only a field that
  // scrolls keeps the wheel from panning the board.
  useLayoutEffect(() => {
    const input = editor.current;
    input.style.height = '0px';
    input.style.height = `${input.scrollHeight}px`;
    input.classList.toggle('nowheel', input.scrollHeight > input.clientHeight + 1);
    setMore(hiddenBelow(input));
  }, [draft, data.height]);
  // Text cut off by the square (or a dragged height) fades out with a Show all button, until it is scrolled to the end.
  const showAll = () => { const input = editor.current, card = input?.closest('.text-node'); if (card) canvas.setPromptHeight(id, card.offsetHeight + input.scrollHeight - input.clientHeight + 4); };
  useEffect(() => {
    if (!view.focus) return;
    // Wait until the release event finishes focusing the source node.
    const timer = setTimeout(() => {
      (view.focus === 'generate' && canRun ? generateButton.current || editor.current : editor.current)?.focus({ preventScroll: true });
      canvas.clearFocus();
    }, 0);
    return () => clearTimeout(timer);
  }, [view.focus, id]);
  return <NodeContextMenu id={id} type="text" actions={canvas}><article className={`node-card text-node ${pending ? 'working' : ''} ${data.template ? 'custom-node' : ''}${describe ? ' describe-node' : ''}${data.height ? ' sized' : ''}`} style={{ ...(data.template ? { '--template-color': templateColor(data.template) } : {}), ...textHeight(data) }}>
    {!view.readOnly && <NodeResizeControl position="bottom" variant="line" resizeDirection="vertical" minHeight={textHeights.min} maxHeight={textHeights.max} className="text-height-handle" title={t('Drag to change the height')}/>}
    <Handle type="target" position={Position.Left} aria-label={t('Connect input to prompt')}/>
    <header className="node-drag">{describe ? <span className="describe-label"><Icon name="describe" size={14}/>{t('Describe image')}</span> : <NodeTemplatePicker id={id} template={data.template} templates={view.templates} switchTemplate={canvas.switchTemplate} viewTemplate={canvas.viewTemplate} disabled={view.readOnly}/>}<button className="text-node-collapse nodrag" type="button" aria-label={t('Collapse text node')} data-tooltip={t('Collapse node')} onClick={() => canvas.toggleNodeCollapsed(id)}><Icon name="collapse" size={15}/></button><div className="run-controls nodrag"><div className="generate-slot">{pending && <span className="generation-label" role="status">{view.starting && !view.active ? t('Starting…') : canCancel ? `${describe ? t('Describing') : t('Generating')}… ${view.timer}` : `${describe ? t('Describing') : t('Generating')}… (${view.byName})`}</span>}<button ref={generateButton} className={`run-button ${pending ? 'run-pending' : ''} ${view.highlight ? 'onboarding-highlight' : ''}${nano ? ' nano' : ''}`} type="button" aria-label={connect ? describe ? t('Connect and describe') : t('Connect and generate') : nano ? describe ? t('Describe with Gemini') : t('Generate with Nano Banana') : describe ? t('Describe images') : t('Generate image')} onClick={event => canvas.run(id, null, event)} disabled={pending || !canRun} data-tooltip={!canRun ? (describe ? t('Connect an image first') : t('Write a prompt first')) : nano && blocked ? view.nanoNote : `${connect ? describe ? t('Connect and describe') : t('Connect and generate') : nano ? describe ? t('Describe with Gemini') : t('Generate with Nano Banana') : describe ? t('Describe connected images') : t('Generate image')} · ${generateShortcut()}`}><Icon name="play" size={12}/><span>{connect ? t('Connect') : describe ? t('Describe') : nano ? 'Nano Banana' : t('Generate')}</span></button></div>{cloud && !pending && <GeneratorPicker describe={describe} id={id} generator={data.generator} nano={{ selectable: view.nanoSelectable, note: view.nanoNote, budget: view.nanoBudget }} choose={canvas.setGenerator}/>}{pending && canCancel && view.active && <button className="run-cancel" type="button" disabled={view.starting} onClick={() => canvas.cancel(view.runId)}>{t('Cancel')}</button>}</div></header>
    <div className={`prompt-editor${more ? ' has-more' : ''}`}>
      <textarea ref={editor} className="nodrag" rows={1} onScroll={event => setMore(hiddenBelow(event.currentTarget))} aria-label={describe ? t('Description focus') : t('Image prompt')} readOnly={view.readOnly} value={draft} placeholder={describe ? t('Optional: what should the description focus on?') : t('Describe the image you want, then click Generate')} onFocus={() => { edited.current = false; }} onChange={event => { if (dictation.active) dictation.cancel(); changeText(event.target.value); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); dictation.cancel(); if (!pending && canRun) canvas.run(id); } }}/>
      {dictation.supported && <button type="button" className={`dictation-button nodrag ${dictation.active ? 'active' : ''} ${dictation.listening ? 'recording' : ''}`} aria-label={dictation.active ? t('Stop dictation') : t('Dictate prompt')} aria-pressed={dictation.active} disabled={dictation.stopping} data-tooltip={dictation.active ? dictation.stopping ? t('Finishing dictation…') : t('Stop dictation · Esc') : t('Dictate (speech is recognised by your browser’s service)')} onPointerDown={event => event.preventDefault()} onClick={dictation.toggle} onDoubleClick={event => event.stopPropagation()}><Icon name="mic" size={13}/>{dictation.active && <i aria-hidden="true"/>}</button>}
      {dictation.active && <button type="button" className="dictation-lang nodrag" aria-label={t('Dictation language {language}, click to switch', { language: dictation.language || '…' })} data-tooltip={t('Switch language · UK / EN / RU')} disabled={!dictation.language || dictation.stopping} onPointerDown={event => event.preventDefault()} onClick={dictation.switchLanguage}>{dictation.language || '…'}</button>}
      {more && !view.readOnly && <button type="button" className="prompt-more nodrag" onClick={showAll}>{t('Show all')}</button>}
      {dictation.interim && <div className="dictation-interim" role="status">{dictation.interim}</div>}
      {dictation.active && <span className="sr-only" role="status">{dictation.stopping ? t('Finishing dictation') : dictation.listening ? t('Recording {language}', { language: dictation.language }) : t('Starting dictation')}</span>}
    </div>
    {dictation.error && <div className="node-error nodrag" role="alert">{dictation.error}</div>}
    {nano && !describe && <VariantRow id={id} variants={data.variants || 1} choose={canvas.setVariants} disabled={view.readOnly}/>}
    {view.inputs && <div className="node-inputs">{t('Inputs: {inputs}', { inputs: view.inputs })}</div>}
    {selected && blocked && !pending && (nano ? <NanoReadiness note={view.nanoNote}/> : <Readiness readiness={view.readiness} action={view.readinessAction} fix={canvas.fixReadiness}/>)}
    {failedRun(view) && <div className="node-error nodrag">{t(view.error)}{!cloud && <button type="button" className="run-details-link" onClick={() => canvas.openRunDetails(view.runId)}>{t('View run details')}</button>}</div>}
    <Handle type="source" position={Position.Right} aria-label={t('Connect prompt to another node')}/>
  </article></NodeContextMenu>;
}

function ImageNode(props) {
  return useDetail(props.id) === 'full' ? <FullImageNode {...props}/> : <LightNode {...props}/>;
}

function FullImageNode(props) {
  const author = useCanvasValue(state => cloud ? runAuthor(props.data, state.runById) : undefined, shallowEqual);
  // The author sits under the card and appears only on hover or selection, so it never covers the image.
  return <NodeFeedback id={props.id}>{props.data.collapsed ? <CollapsedNode {...props} kind="image"/> : <ExpandedImageNode {...props}/>}{author && <span className={`image-author${props.data.collapsed ? ' collapsed' : ''}`}><AuthorBadge author={author}/></span>}</NodeFeedback>;
}

function ExpandedImageNode({ id, data }) {
  const canvas = useCanvas();
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const [captionFocused, setCaptionFocused] = useState(false), [caption, setCaption] = useState(data.caption || '');
  const captionInput = useRef(null), captionBeforeEdit = useRef(), captionCheckpoint = useRef(null), captionEdited = useRef(false);
  useLayoutEffect(() => {
    const editing = document.activeElement === captionInput.current;
    if (cloud || !editing || !captionEdited.current) {
      setCaption(data.caption || '');
      if (editing) captionBeforeEdit.current = data.caption;
    }
  }, [data.caption]);
  useLayoutEffect(() => { if (captionFocused && !data.caption) captionInput.current?.focus({ preventScroll: true }); }, [captionFocused]);
  const zoom = useImageButtonZoom(hovered || focused);
  const image = useCanvasImage(assetUrl(data.asset));
  const imageElement = useRef(null);
  // The 44px button keeps its screen size, but never grows past a third of the image when zoomed out. It shows only on
  // hover or focus, so other cards skip the layout read.
  const expandScale = hovered || focused ? Math.min(1 / zoom, Math.min(310, imageElement.current?.offsetHeight || 310) / 3 / 44) : 1;
  useOutputReady(imageElement, image.src, id);
  const variationButton = useRef(null);
  const view = useCanvasValue(state => ({ variation: state.focusId === id && state.focusControl === 'variation', highlight: state.highlight === `${id}:variation`, readOnly: state.readOnly }), shallowEqual);
  useEffect(() => {
    if (!view.variation) return;
    const timer = setTimeout(() => { variationButton.current?.focus({ preventScroll: true }); canvas.clearFocus(); }, 0);
    return () => clearTimeout(timer);
  }, [view.variation, id]);
  const aspectRatio = image.aspectRatio || (data.aspect ? `1 / ${data.aspect}` : undefined);
  return <NodeContextMenu id={id} type="image" actions={canvas}><div className="image-node-wrapper">
    {(captionFocused || !!data.caption?.trim()) && <input ref={captionInput} className="image-node-caption nodrag" aria-label={t('Image caption')} title={view.readOnly ? undefined : t('Edit image caption')} readOnly={view.readOnly} maxLength={120} value={caption} onFocus={() => { captionEdited.current = false; captionBeforeEdit.current = data.caption; setCaptionFocused(true); captionCheckpoint.current = canvas.checkpoint(); }} onBlur={() => setCaptionFocused(false)} onChange={event => { captionEdited.current = true; setCaption(event.target.value); canvas.editCaption(id, event.target.value); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === 'Escape') { event.stopPropagation(); setCaption(canvas.cancelCaption(id, captionBeforeEdit.current, captionCheckpoint.current) || ''); event.currentTarget.blur(); } }}/>}<article className="node-card image-node" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }} onDoubleClick={() => canvas.view(id)}>
    {data.runId && <Handle type="target" position={Position.Left} isConnectable={false}/>}
    {image.src ? <img ref={imageElement} className="image-content" src={image.src} style={{ aspectRatio }} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt={data.caption || data.label || t('Concept image')} draggable="false"/> : <span className="image-content image-placeholder" style={{ aspectRatio: aspectRatio || '1' }}/>}
    <div className="image-shade"/>
    <button className="image-collapse nodrag" type="button" aria-label={t('Collapse image node')} data-tooltip={t('Collapse node')} onClick={event => { event.stopPropagation(); canvas.toggleNodeCollapsed(id); }} onDoubleClick={event => event.stopPropagation()}><Icon name="collapse" size={15}/></button>
    {!data.caption?.trim() && !captionFocused && <button className="image-caption-add nodrag" type="button" aria-label={t('Add image caption')} data-tooltip={t('Add image caption')} onClick={event => { event.stopPropagation(); setCaptionFocused(true); }} onDoubleClick={event => event.stopPropagation()}><Icon name="tag" size={15}/></button>}
    <button className="image-expand nodrag" style={{ '--inverse-zoom': expandScale }} data-tooltip={t('View fullscreen')} aria-label={t('Open image fullscreen')} onClick={() => canvas.view(id)}><Icon name="expand" size={24}/></button>
    <button ref={variationButton} type="button" className={`image-prompt-from nodrag ${view.highlight ? 'onboarding-highlight' : ''}`} data-tooltip={t('New prompt that uses this image as a reference')} onClick={event => { event.stopPropagation(); canvas.promptFrom(id); }} onDoubleClick={event => event.stopPropagation()}>{t('+ Prompt from this')}</button>
    <Handle type="source" position={Position.Right} aria-label={t('Connect image as reference')}/>
  </article></div></NodeContextMenu>;
}

function useOutputReady(ref, source, id) {
  const canvas = useCanvas(), waiting = useCanvasValue(state => state.pending.has(id));
  useEffect(() => {
    const image = ref.current;
    if (!image || !waiting) return;
    let active = true;
    const ready = async () => {
      try { if (image.decode) await image.decode(); } catch {}
      if (active && image.naturalWidth > 0) canvas.outputReady(id);
    };
    if (image.complete) ready();
    const failed = () => canvas.outputFailed(id);
    image.addEventListener('load', ready); image.addEventListener('error', failed);
    return () => { active = false; image.removeEventListener('load', ready); image.removeEventListener('error', failed); };
  }, [source, id, waiting]);
}

function CollapsedImage({ asset, id }) {
  const ref = useRef(null), image = useCanvasImage(assetUrl(asset), { small: true });
  useOutputReady(ref, image.src, id);
  return image.src ? <img ref={ref} className="collapsed-node-image" src={image.src} alt="" draggable="false"/> : <span className="collapsed-node-image image-placeholder"/>;
}

function CollapsedNode({ id, data, kind }) {
  const canvas = useCanvas(), isImage = kind === 'image';
  const run = useCanvasValue(state => { const run = !isImage && state.latestRun.get(id); return run ? { status: run.status, error: run.error } : null; }, shallowEqual);
  return <NodeContextMenu id={id} type={kind} actions={canvas}>
    <article className={`collapsed-node ${isImage ? 'collapsed-node-image-card' : 'collapsed-node-text-card'} ${!isImage && data.template ? 'custom-node' : ''}`} style={!isImage && data.template ? { '--template-color': templateColor(data.template) } : undefined}>
      {(!isImage || data.runId) && <Handle type="target" position={Position.Left} isConnectable={!isImage} aria-label={isImage ? t('Image input') : t('Connect input to prompt')}/>}
      {isImage ? <CollapsedImage asset={data.asset} id={id}/> : <Icon name="text" size={26}/>}
      {busy(run) && <span className="collapsed-run-dot" aria-label={t('Generating')} title={t('Generating…')}/>}
      {['failed', 'error'].includes(run?.status) && <span className="collapsed-run-dot failed" aria-label={t(run.error)} title={t(run.error)}/>}
      <button className="collapsed-node-expand nodrag" type="button" aria-label={isImage ? t('Expand image node') : t('Expand text node')} data-tooltip={t('Expand node')} onClick={() => canvas.toggleNodeCollapsed(id)}><Icon name="expand" size={15}/></button>
      {isImage && <button className="collapsed-prompt-from nodrag" type="button" aria-label={t('+ Prompt from this')} data-tooltip={t('New prompt that uses this image as a reference')} onClick={() => canvas.promptFrom(id)}><Icon name="plus" size={15}/></button>}
      <Handle type="source" position={Position.Right} aria-label={isImage ? t('Connect image as reference') : t('Connect prompt to another node')}/>
    </article>
  </NodeContextMenu>;
}

// Zoomed-out cards keep their size, colour and connection points but drop controls, menus, badges and effects.
// A prompt takes the height React Flow knows (measured, or estimated if never drawn), so crossing the zoom threshold moves nothing.
function LightNode({ id, type, data, selected }) {
  const isImage = type === 'image', canvas = useCanvas();
  const view = useCanvasValue(state => {
    const run = !isImage && state.latestRun.get(id);
    return { working: busy(run) || state.starting === id, failed: failedRun(run), error: run?.error, runId: run?.id, inputs: isImage ? '' : inputLabel(state.inputs.get(id) || noInputs), create: state.detail !== 'tiny' || !state.crowded,
      readiness: state.readinessKey, readinessAction: state.readinessAction, nanoReady: state.nanoReady, nanoNote: state.nanoNote };
  }, shallowEqual);
  const template = !isImage && data.template ? { '--template-color': templateColor(data.template) } : undefined, text = String(data.text || ''), nano = cloud && usesNano(data), sized = textHeight(data);
  if (data.collapsed) return <article data-feel-node={id} className={`collapsed-node lod-node ${isImage ? 'collapsed-node-image-card' : 'collapsed-node-text-card'}${template ? ' custom-node' : ''}`} style={template}>
    {(!isImage || data.runId) && <LodHandle type="target"/>}{isImage ? <LightImage id={id} asset={data.asset} create={view.create} collapsed/> : <Icon name="text" size={26}/>}
    {view.working && <span className="collapsed-run-dot"/>}{view.error && <span className="collapsed-run-dot failed"/>}<LodHandle type="source"/>
  </article>;
  // Captions are left out zoomed out: at this size they would only be specks of text over the board.
  if (isImage) return <div data-feel-node={id} className="image-node-wrapper lod-node"><article className="node-card image-node">{data.runId && <LodHandle type="target"/>}<LightImage id={id} asset={data.asset} aspect={data.aspect} create={view.create}/><LodHandle type="source"/></article></div>;
  // Same rows as the full card, so the card keeps its height (and its links stay put) when zooming in or out.
  const describe = data.task === describeTask;
  return <article data-feel-node={id} className={`node-card text-node lod-node${view.working ? ' working' : ''}${template ? ' custom-node' : ''}${describe ? ' describe-node' : ''}${sized ? ' sized' : ''}`} style={{ ...template, ...sized }}>
    <LodHandle type="target"/><header/><div className={`lod-text${text ? '' : ' empty'}${text && promptOverflows({ data }) ? ' has-more' : ''}`}>{text || (describe ? t('Connect images, then click Describe') : t('Describe the image you want, then click Generate'))}</div>
    {nano && !describe && <div className="variant-row" aria-hidden="true"/>}
    {view.inputs && <div className="node-inputs">{t('Inputs: {inputs}', { inputs: view.inputs })}</div>}
    {selected && (nano ? !view.nanoReady : view.readiness !== 'ready') && !view.working && (nano ? <NanoReadiness note={view.nanoNote}/> : <Readiness readiness={view.readiness} action={view.readinessAction} fix={canvas.fixReadiness}/>)}
    {view.failed && <div className="node-error nodrag">{t(view.error)}{!cloud && <button type="button" className="run-details-link" onClick={() => canvas.openRunDetails(view.runId)}>{t('View run details')}</button>}</div>}<LodHandle type="source"/>
  </article>;
}

const LodHandle = ({ type }) => <i {...lodHandleProps(type)}/>;

function LightImage({ id, asset, aspect, create, collapsed = false, slide }) {
  const ref = useRef(null), image = useCanvasImage(assetUrl(asset), { small: true, create });
  useOutputReady(ref, image.src, id);
  useLearnedAspect(slide, image.aspectRatio);
  const className = collapsed ? 'collapsed-node-image' : 'image-content', aspectRatio = collapsed ? undefined : image.aspectRatio || (aspect ? `1 / ${aspect}` : undefined);
  return image.src ? <img ref={ref} className={className} src={image.src} style={aspectRatio ? { aspectRatio } : undefined} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt="" draggable="false"/>
    : <span className={`${className} image-placeholder`} style={collapsed ? undefined : { aspectRatio: aspectRatio || '1' }}/>;
}

function GroupNode(props) {
  return useDetail(props.id) === 'full' ? <FullGroupNode {...props}/> : <LightGroupNode {...props}/>;
}

// A name that is a text field while it is being renamed: Enter saves, Escape cancels.
function RenameField({ name, label, className, onSave, onDone }) {
  const [value, setValue] = useState(name), cancelled = useRef(false), input = useRef(null);
  useLayoutEffect(() => { input.current?.focus({ preventScroll: true }); input.current?.select(); }, []);
  const save = () => { if (!cancelled.current && value.trim()) onSave(value.trim()); onDone(); };
  return <input ref={input} className={`${className} nodrag`} aria-label={label} maxLength={80} value={value} onChange={event => setValue(event.target.value)} onBlur={save} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === 'Escape') { cancelled.current = true; onDone(); } }}/>;
}

// Groups bundle nodes and fold them into one compact card; their small name sits in the frame's header. A folded
// slideshow (one run's images) shows one image instead, and its output dot connects that image.
function FullGroupNode({ id, data }) {
  const canvas = useCanvas(), editing = useCanvasValue(state => state.renaming === id), slideshow = data.collapsed && data.slide, kind = data.slideshow ? 'slideshow' : 'group';
  return <NodeContextMenu id={id} type="group" actions={canvas} slideshow={data.images ? !!data.slideshow : undefined}><article data-feel-node={id} className={`group-frame ${data.collapsed ? 'collapsed' : ''}${slideshow ? ' slideshow' : ''}`}>
    <header><button className={`group-toggle nodrag ${data.collapsed ? '' : 'expanded'}`} aria-label={data.collapsed ? t('Expand {name}', { name: data.name }) : t('Collapse {name}', { name: data.name })} data-tooltip={data.collapsed ? kind === 'slideshow' ? t('Expand slideshow') : t('Expand group') : data.slideshow ? t('Fold into slideshow') : t('Collapse group')} onClick={() => canvas.toggleGroup(id)}><Icon name="chevron" size={16}/></button>{data.slideshow && <i className="group-kind" title={t('Slideshow')}><Icon name="slides" size={14}/></i>}{editing ? <RenameField name={data.name} label={t('Group name')} className="group-name-input" onSave={name => canvas.editGroup(id, { name })} onDone={() => canvas.renameGroup(null)}/> : <strong tabIndex={0} role="button" title={t('Double-click to rename group')} onDoubleClick={() => canvas.renameGroup(id)} onKeyDown={event => { if (event.key === 'Enter') { event.stopPropagation(); canvas.renameGroup(id); } }}>{data.name}</strong>}<span>{slideshow ? `${data.index + 1} / ${data.images}` : data.slideshow ? plural(data.images, '{count} image', '{count} images') : plural(data.count, '{count} node', '{count} nodes')}</span><button className="icon-button nodrag" aria-label={t('Ungroup {name}', { name: data.name })} data-tooltip={t('Ungroup; keep nodes')} onClick={() => canvas.ungroup(id)}><Icon name="ungroup" size={16}/></button></header>
    {slideshow && <SlideshowStage id={id} slide={data.slide} count={data.images}/>}
    {data.collapsed && <><Handle type="target" position={Position.Left} isConnectable={false}/><Handle type="source" position={Position.Right} isConnectable={!!slideshow} aria-label={slideshow ? t('Connect the shown image as reference') : undefined}/></>}
  </article></NodeContextMenu>;
}

// An image with no stored proportions (older or imported ones) gets them from the loaded picture, so a folded
// slideshow takes the shown image's shape instead of a square.
const imageAspect = ratio => { const [width, height] = String(ratio || '').split('/').map(Number); return width > 0 && height > 0 ? height / width : undefined; };
function useLearnedAspect(slide, ratio) {
  const canvas = useCanvas(), aspect = imageAspect(ratio);
  useEffect(() => { if (slide && !slide.aspect && aspect) canvas.learnAspect(slide.asset, aspect); }, [slide?.asset, slide?.aspect, aspect]);
}

function SlideshowStage({ id, slide, count }) {
  const canvas = useCanvas(), image = useCanvasImage(assetUrl(slide.asset)), ref = useRef(null);
  useOutputReady(ref, image.src, slide.id);
  useLearnedAspect(slide, image.aspectRatio);
  const press = action => ({ onClick: event => { event.stopPropagation(); action(); }, onDoubleClick: event => event.stopPropagation() });
  return <div className="slideshow-stage">
    {image.src ? <img ref={ref} key={slide.id} className="slideshow-image" src={image.src} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt="" draggable="false"/> : <span className="slideshow-image image-placeholder"/>}
    <div className="image-shade"/>
    <button className="image-expand nodrag" data-tooltip={t('View fullscreen')} aria-label={t('Open image fullscreen')} {...press(() => canvas.view(slide.id))}><Icon name="expand" size={24}/></button>
    {count > 1 && <><button type="button" className="slideshow-step previous nodrag" aria-label={t('Previous image')} data-tooltip={t('Previous image')} {...press(() => canvas.showSlide(id, -1))}><Icon name="chevron" size={18}/></button>
      <button type="button" className="slideshow-step next nodrag" aria-label={t('Next image')} data-tooltip={t('Next image')} {...press(() => canvas.showSlide(id, 1))}><Icon name="chevron" size={18}/></button></>}
    <button type="button" className="image-prompt-from nodrag" data-tooltip={t('New prompt that uses this image as a reference')} {...press(() => canvas.promptFrom(slide.id))}>{t('+ Prompt from this')}</button>
  </div>;
}

function LightGroupNode({ id, data }) {
  const slideshow = data.collapsed && data.slide, create = useCanvasValue(state => state.detail !== 'tiny' || !state.crowded);
  return <article data-feel-node={id} className={`group-frame lod-node ${data.collapsed ? 'collapsed' : ''}${slideshow ? ' slideshow' : ''}`}>
    <header/>{slideshow && <div className="slideshow-stage"><LightImage id={data.slide.id} asset={data.slide.asset} create={create} collapsed slide={data.slide}/></div>}{data.collapsed && <><LodHandle type="target"/><LodHandle type="source"/></>}
  </article>;
}

const sectionStyle = color => color ? { '--section-color': color, '--section-ink': contrastColor(color) } : undefined;
const sectionEdges = ['top', 'right', 'bottom', 'left'];
// A section is a named background frame, as in FigJam. Its title pill and edges pick it up (dragging takes along what
// lies inside); its empty inside passes the pointer to the canvas, so a drag there selects or pans.
function SectionNode({ id, data, selected }) {
  const canvas = useCanvas(), full = useDetail(id) === 'full', editing = useCanvasValue(state => state.renaming === id);
  return <NodeContextMenu id={id} type="section" actions={canvas}><div className={`section-frame${data.color ? ' colored' : ''}`} style={sectionStyle(data.color)}>
    {sectionEdges.map(side => <i key={side} className={`section-edge ${side} section-handle`}/>)}
    {/* Zoomed out the visible title is drawn on top (SectionTitles); this copy stays under it, invisible, so the title still drags and renames. */}
    <div className={`section-label section-handle${full || editing ? '' : ' ghost'}`}>{editing ? <RenameField name={data.name} label={t('Section name')} className="section-name-input" onSave={name => canvas.editSection(id, { name })} onDone={() => canvas.renameSection(null)}/> : <strong tabIndex={0} role="button" title={t('Drag to move the section with its contents · double-click to rename')} onDoubleClick={() => canvas.renameSection(id)} onKeyDown={event => { if (event.key === 'Enter') { event.stopPropagation(); canvas.renameSection(id); } }}>{data.name}</strong>}{selected && !editing && <ColorPicker color={data.color} colors={sectionPalette} label={t('Section color')} allowDefault custom onChange={color => canvas.editSection(id, { color })}/>}</div>
    {full && <NodeResizer isVisible={selected && !editing} minWidth={sectionMinimum.width} minHeight={sectionMinimum.height} handleClassName="section-resize-handle" lineClassName="section-resize-line" onResizeStart={canvas.sectionResizeStart} onResizeEnd={canvas.sectionResizeEnd}/>}
  </div></NodeContextMenu>;
}

// Zoomed out, section titles are drawn above every card and connection at a steady size, so each section is still named
// from afar. A section being renamed keeps its own editable title.
function SectionTitles({ sections }) {
  const { detail, renaming } = useCanvasValue(state => ({ detail: state.detail, renaming: state.renaming }), shallowEqual);
  const zoom = useStore(state => detail === 'full' ? 1 : state.transform[2]), shown = useMemo(() => detail === 'full' ? null : visibleTitles(sections, zoom), [sections, zoom, detail]);
  if (detail === 'full' || !sections.length) return null;
  return <ViewportPortal>{sections.map(frame => frame.id === renaming || !shown.has(frame.id) ? null : <div key={frame.id} className={`section-title${frame.selected ? ' selected' : ''}${frame.data.color ? ' colored' : ''}`} style={{ transform: `translate(${frame.position.x}px, ${frame.position.y}px)`, '--frame-width': `${frame.width}px`, ...sectionStyle(frame.data.color) }} aria-hidden="true"><span>{frame.data.name}</span></div>)}</ViewportPortal>;
}

function AnnotationNode(props) {
  const canvas = useCanvas(), Component = useDetail(props.id) === 'full' ? { drawing: DrawingNode, sticky: StickyNode, stamp: StampNode, shape: ShapeNode, arrow: ArrowNode }[props.type] : LightAnnotation;
  return <Component {...props} actions={canvas}/>;
}
const nodeTypes = { text: TextNode, image: ImageNode, group: GroupNode, section: SectionNode, drawing: AnnotationNode, sticky: AnnotationNode, stamp: AnnotationNode, shape: AnnotationNode, arrow: AnnotationNode };
function FeedbackEdge(props) {
  const [path] = getBezierPath(props);
  return <BaseEdge id={props.id} path={path} pathLength="1" style={props.style} markerStart={props.markerStart} markerEnd={props.markerEnd}/>;
}
const edgeTypes = { feedback: FeedbackEdge };
// Constant props: React Flow copies changed props into its store, and every copy re-runs every card's and edge's selector.
// As in FigJam, Shift (or ⌘) toggles a card in or out of the selection, and a Shift drag starts on empty canvas like any box.
const defaultEdgeOptions = { type: 'default' }, panButtons = [1, 2], multiSelectKeys = ['Shift', 'Meta'], proOptions = { hideAttribution: true };
// One generation in the History tab. Memoized: a board can hold thousands, and only active runs need the 1 s timer.
const HistoryItem = React.memo(function HistoryItem({ run, now, page, canCancel, canvas }) {
  return <div className={`history-item ${run.status}`}><button className="history-focus" data-tooltip={t('Show this generation')} onClick={() => canvas.showRun(run)}><span className="history-status"><Icon name={run.status === 'completed' ? 'check' : 'clock'} size={14}/> {busy(run) ? formatDuration(runElapsed(run, now)) : t(run.status)}</span><strong>{run.label}</strong><small>{new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {run.task === 'describe' ? t('description') : plural(run.outputIds.length, '{count} image', '{count} images')}{page && ` · ${page}`}</small>{run.by && <span className="history-author"><AuthorBadge author={run.by}/></span>}</button>{busy(run) && canCancel && <button className="cancel-link" data-tooltip={t('Cancel generation')} onClick={() => canvas.cancel(run.id)}>{t('Cancel run')}</button>}{run.error && <p>{t(run.error)}</p>}{!cloud && <button type="button" className="run-details-link" onClick={() => canvas.openRunDetails(run.id)}>{t('Run details')}</button>}</div>;
});
const noSections = Object.freeze([]);

async function api(url, options = {}) {
  const response = await request(url, options);
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || t('Request failed.')), { status: response.status, value });
  return value;
}
const jsonOptions = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function UsageLimit({ status, version }) {
  const [usage, setUsage] = useState(null), [loading, setLoading] = useState(false);
  const requestId = useRef(0), inFlight = useRef(false), lastRequest = useRef(0);
  const ready = status.connected && status.signedIn;
  const refresh = useCallback(async () => {
    if (!ready) { requestId.current++; inFlight.current = false; setUsage(null); setLoading(false); return; }
    if (inFlight.current) return;
    const current = ++requestId.current;
    inFlight.current = true;
    lastRequest.current = Date.now();
    setLoading(true);
    try {
      const result = await api('/api/limits', { helper: cloud });
      if (current === requestId.current) setUsage(result);
    } catch {
      if (current === requestId.current) setUsage({ available: false, buckets: [] });
    } finally {
      if (current === requestId.current) { inFlight.current = false; lastRequest.current = Date.now(); setLoading(false); }
    }
  }, [ready]);
  useEffect(() => { refresh(); return () => { requestId.current++; inFlight.current = false; }; }, [refresh]);
  // Codex may emit an update as a side effect of reading limits; avoid a request loop.
  useEffect(() => { if (version && !inFlight.current && Date.now() - lastRequest.current >= 5000) refresh(); }, [refresh, version]);
  const buckets = usage?.available && Array.isArray(usage.buckets) ? usage.buckets : [];
  const remaining = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? Number((100 - value).toFixed(1)) : null;
  const first = buckets.flatMap(bucket => [bucket.primary, bucket.secondary]).find(window => remaining(window?.usedPercent) !== null);
  const windowLabel = minutes => {
    if (!Number.isFinite(minutes) || minutes <= 0) return t('Usage window');
    if (minutes % 1440 === 0) return plural(minutes / 1440, '{count}-day limit', '{count}-day limit');
    if (minutes % 60 === 0) return plural(minutes / 60, '{count}-hour limit', '{count}-hour limit');
    return plural(minutes, '{count}-minute limit', '{count}-minute limit');
  };
  return <details className="usage" onToggle={event => { if (event.currentTarget.open) refresh(); }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
    <summary aria-label={t('Codex usage limits')}><Icon name="clock" size={15}/><span>{first ? t('Usage · {percent}% left', { percent: remaining(first.usedPercent) }) : t('Usage')}</span></summary>
    <div className="usage-panel" aria-label={t('Codex usage limits')}>
      <div className="usage-heading"><strong>{t('Codex usage')}</strong><button type="button" onClick={refresh} disabled={!ready || loading}>{loading ? t('Refreshing…') : t('Refresh')}</button></div>
      <div aria-live="polite">
        {!ready ? <p>{t('Connect and sign in to Codex to see usage.')}</p> : loading && !usage ? <p>{t('Loading usage…')}</p> : !usage?.available || !buckets.length ? <p>{t('Usage information is unavailable. Try refreshing later.')}</p> : buckets.map((bucket, index) => <div className="usage-bucket" key={bucket.id || index}>
          {bucket.name && <h3>{bucket.name}</h3>}
          {[bucket.primary, bucket.secondary].filter(Boolean).length ? [bucket.primary, bucket.secondary].filter(Boolean).map((window, windowIndex) => {
            const percent = remaining(window.usedPercent);
            const reset = Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? new Date(window.resetsAt * 1000) : null;
            const resetValid = reset && Number.isFinite(reset.getTime());
            return <div className="usage-window" key={windowIndex}>
              <div><span>{windowLabel(window.windowDurationMins)}</span><strong>{percent === null ? t('Unavailable') : t('{percent}% left', { percent })}</strong></div>
              {percent !== null && <progress max="100" value={percent} aria-label={t('{window}: {percent}% remaining', { window: windowLabel(window.windowDurationMins), percent })}/>}
              <small>{resetValid ? t('Resets {time}', { time: reset.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }) : t('Reset time unavailable')}</small>
            </div>;
          }) : <p>{t('No usage windows available.')}</p>}
        </div>)}
      </div>
      <p className="usage-note">{t('These are Codex usage limits; image generation may have a separate limit.')}</p>
    </div>
  </details>;
}

function TemplateEditor({ template, initial = template, templates, onClose, onSave, onDelete, onBusyChange }) {
  const [name, setName] = useState(initial?.name || '');
  const [color, setColor] = useState(() => template ? templateColor(template) : nextTemplateColor(templates));
  const [colorPicked, setColorPicked] = useState(false);
  const [instructions, setInstructions] = useState(initial?.instructions || '');
  const [assets, setAssets] = useState(initial?.assets || []);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const imageInput = useRef(null);
  const perform = async task => {
    setError(''); setBusy(true); onBusyChange(true);
    try { await task(); } catch (failure) { setError(failure.message || t('Something went wrong. Please try again.')); }
    finally { setBusy(false); onBusyChange(false); }
  };
  const upload = event => {
    const files = [...event.target.files]; event.target.value = '';
    if (!files.length) return;
    if (assets.length + files.length > 10) { setError(t('Choose at most 10 reference images.')); return; }
    perform(async () => {
      for (const file of files) {
        const { asset } = await api('/api/assets', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
        setAssets(current => [...current, asset]);
      }
    });
  };
  return <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="template-editor-title" onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
    <form className="template-editor" onSubmit={event => { event.preventDefault(); if (!name.trim() || busy) return; perform(() => onSave({ name: name.trim(), instructions, assets, ...(template || colorPicked ? { color } : {}), ...(initial?.labelOutputs === undefined ? {} : { labelOutputs: initial.labelOutputs }) })); }}>
      <h2 id="template-editor-title">{template ? t('Edit custom node') : t('Create custom node')}</h2>
      <p className="template-intro">{cloud ? t('Save instructions and reference images to reuse on this board. Everyone on it can use and change them.') : t('Save instructions and reference images to reuse on any board.')}</p>
      <label htmlFor="template-name">{t('Name')}</label>
      <input id="template-name" autoFocus value={name} maxLength={80} placeholder={t('e.g. Character multiview')} onChange={event => setName(event.target.value)} disabled={busy} required/>
      <fieldset className="template-colors"><legend>{t('Colour')}</legend>{templatePalette.map(value => <button key={value} type="button" aria-label={t('Colour {value}', { value })} aria-pressed={color === value} style={{ '--swatch-color': value }} disabled={busy} onClick={() => { setColor(value); setColorPicked(true); }}>{color === value && <Icon name="check" size={14}/>}</button>)}</fieldset>
      <label htmlFor="template-instructions">{t('Additional instructions')}</label>
      <textarea id="template-instructions" value={instructions} maxLength={100000} placeholder={t('Describe the result you want this node to create…')} onChange={event => setInstructions(event.target.value)} disabled={busy} rows={5}/>
      <p className="template-hint">{t('These instructions are included with the text you write in the node.')}</p>
      <div className="template-reference-heading"><span>{t('Reference images')} <small>{assets.length}/10</small></span><button type="button" onClick={() => imageInput.current?.click()} disabled={busy || assets.length >= 10}>{t('+ Add images')}</button></div>
      <input ref={imageInput} className="template-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={upload} tabIndex={-1} aria-label={t('Choose reference images')}/>
      {assets.length ? <div className="template-reference-grid">{assets.map((asset, index) => <div className="template-reference" key={`${asset}-${index}`}><img src={assetUrl(asset)} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt={t('Reference {number}', { number: index + 1 })}/><button type="button" aria-label={t('Remove reference {number}', { number: index + 1 })} data-tooltip={t('Remove reference')} disabled={busy} onClick={() => setAssets(current => current.filter((_, i) => i !== index))}><Icon name="close" size={13}/></button></div>)}</div> : <p className="template-hint">{t('Optional. These images are included every time you run the node.')}</p>}
      {error && <p className="template-error" role="alert">{error}</p>}
      <div className="template-editor-actions">{template && <button className="template-delete" type="button" disabled={busy} onClick={() => { if (window.confirm(t('Delete this custom node? Nodes already on your boards will keep their settings.'))) perform(onDelete); }}>{t('Delete')}</button>}<button type="button" disabled={busy} onClick={onClose}>{t('Cancel')}</button><button className="primary-button" type="submit" disabled={busy || !name.trim()}>{busy ? t('Working…') : t('Save custom node')}</button></div>
    </form>
  </div>;
}

function TemplateDetails({ template, library = false, onClose }) {
  return <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="template-details-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="template-details">
      <h2 id="template-details-title">{template.name}</h2>
      <p className="template-hint">{library ? t('A custom node saved on this board.') : t('These settings are saved in this node. Editing the library won’t change them.')}</p>
      <h3>{t('Additional instructions')}</h3><p className="template-instructions">{template.instructions || t('No additional instructions')}</p>
      <h3>{t('Reference images')}</h3>
      {template.assets?.length ? <div className="template-reference-grid">{template.assets.map((asset, index) => <div className="template-reference" key={`${asset}-${index}`}><img src={assetUrl(asset)} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt={t('Reference {number}', { number: index + 1 })}/></div>)}</div> : <p className="template-hint">{t('No saved reference images')}</p>}
      <div className="template-details-actions"><button className="primary-button" autoFocus onClick={onClose}>{t('Done')}</button></div>
    </div>
  </div>;
}

// Desktop agents reach the app's local stdio server; on team boards they connect to the site's MCP address and sign in there.
function AgentConnect({ onClose, cloud = false }) {
  const [setup, setSetup] = useState(cloud ? { available: true } : null), [error, setError] = useState(''), [copyStatus, setCopyStatus] = useState('');
  const promptRef = useRef(null), endpoint = `${location.origin}/mcp`;
  useEffect(() => {
    if (cloud) return;
    let active = true;
    api('/api/desktop/mcp-setup').then(value => { if (active) setSetup(value); }).catch(() => { if (active) setError(t('Could not load connection details. Restart Concept Graph and try again.')); });
    return () => { active = false; };
  }, [cloud]);
  const prompt = cloud ? `Connect your current agent to my Concept Graph team boards. It is a remote MCP server (Streamable HTTP) at ${endpoint} that signs in with OAuth; no API key is needed. Register it as "concept-graph" in your MCP client, preserving other settings: in Claude Code, claude mcp add --transport http --scope user concept-graph ${endpoint}; in Codex, codex mcp add concept-graph --url ${endpoint}, then codex mcp login concept-graph. Then start the sign-in so I can approve access in my browser, and tell me if a new session or restart is needed. Do not expose tokens or board contents.`
    : setup?.command && Array.isArray(setup.args) ? `Connect your current agent to the local Concept Graph MCP server using stdio. Concept Graph is installed on this computer. Use this configuration:\n${JSON.stringify({ command: setup.command, args: setup.args }, null, 2)}\nCheck the existing concept-graph configuration for your client; register it if missing or update outdated paths if needed, preserving other settings. Verify the connection and tell me if a new session or restart is needed. Keep Concept Graph open, and do not expose credentials or board contents.` : '';
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(prompt);
      setCopyStatus(t('Copied! Paste it into your agent.'));
    } catch {
      promptRef.current?.focus();
      promptRef.current?.select();
      try {
        if (!document.execCommand('copy')) throw new Error('Copy failed');
        setCopyStatus(t('Copied! Paste it into your agent.'));
      } catch { setCopyStatus(t('Select the text and copy it using your keyboard.')); }
    }
  };
  return <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="agent-connect-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="agent-connect-card">
      <div className="agent-connect-heading"><div><span className="eyebrow">{t('MCP CONNECTION')}</span><h2 id="agent-connect-title">{t('Connect MCP')}</h2></div><button type="button" className="icon-button" aria-label={t('Close')} onClick={onClose}><Icon name="close" size={17}/></button></div>
      <p>{cloud ? t('Copy this message and send it to Claude Code, Codex or another agent. It connects with your Google sign-in, and you approve access in the browser.') : t('Copy this message and send it to Codex or Claude Code running on this computer. The agent can set up the connection for you.')}</p>
      {error ? <p className="agent-connect-error" role="alert">{error}</p> : !setup ? <p>{t('Loading connection details…')}</p> : <>
        {!setup.available && <p className="agent-connect-error" role="alert">{t('MCP is unavailable in this window. Close any other Concept Graph window and restart the app.')}</p>}
        {prompt && <><label htmlFor="agent-connect-prompt">{t('Message for your agent')}</label><textarea id="agent-connect-prompt" ref={promptRef} readOnly value={prompt} rows={7} onFocus={event => event.target.select()}/><div className="agent-connect-actions"><button className="primary-button" autoFocus type="button" onClick={copy}><Icon name="copy" size={15}/> {t('Copy message')}</button><span role="status">{copyStatus}</span></div></>}
      </>}
      {cloud && <p>{t('In apps such as Claude Desktop, add a custom connector with this address: {url}', { url: endpoint })}</p>}
      <p className="agent-connect-note">{cloud ? t('A connected agent acts as you: it can read and change every board you can open, and start Nano Banana generation.') : t('Keep Concept Graph open. A connected agent can read and change your boards and images, and start generation.')}</p>
    </div>
  </div>;
}

function App({ boardId, boards, updateBoards, selectBoard, theme, toggleTheme, waitForPreferences, desktopMode, mcpEnabled, editorReadyCallback, cloudSession, helperSession }) {
  const [nodes, setNodes] = useState([]), [edges, setEdges] = useState([]), [runs, setRuns] = useState([]);
  const dictationLanguage = useDictationLanguage();
  const effects = useInteractionFeedback(cloud ? `cloud:${cloudSession.user.name}` : hosted ? 'hosted' : 'local');
  const feedbackSeeded = useRef(false);
  const [fileOver, setFileOver] = useState(false);
  const runRef = useRef(runs); runRef.current = runs;
  const [groups, setGroups] = useState([]), [focusId, setFocusId] = useState(null);
  const [sections, setSections] = useState(noSections), [renaming, setRenaming] = useState(null), [tool, setTool] = useState('select');
  const [viewerSlides, setViewerSlides] = useState(() => new Map()), [learnedAspects, setLearnedAspects] = useState(() => new Map());
  const [pen, setPen] = useState({ color: penPalette[0], width: 4 }), [stickyColor, setStickyColor] = useState(stickyPalette[0]), [stamp, setStamp] = useState('like');
  const [shape, setShape] = useState({ kind: 'rectangle', color: shapePalette[0] }), [arrowColor, setArrowColor] = useState(arrowPalette[0]), arrowDraft = useRef(null);
  const strokePreview = useRef(null), stroke = useRef(null), toolRef = useRef('select'), sectionPreview = useRef(null), sectionDraft = useRef(null), sectionMoves = useRef(new Map());
  const chooseTool = value => { if (stroke.current || sectionDraft.current || arrowDraft.current) moving.current = false; toolRef.current = value; setTool(value); stroke.current = null; sectionDraft.current = null; arrowDraft.current = null; strokePreview.current?.show([]); sectionPreview.current?.show(null); };
  const [focusControl, setFocusControl] = useState('text'), [highlight, setHighlight] = useState(null), [helperOffline, setHelperOffline] = useState(false);
  const viewOnlyNoticed = useRef(0), imageDrop = useRef(null), canvasElement = useRef(null), highlightTimer = useRef(null), pendingIntent = useRef(null), alive = useRef(true), runAction = useRef(null), generationStarting = useRef(false);
  const guide = useGettingStarted(gettingStartedKey(cloud ? `cloud:${cloudSession.user.name}` : hosted ? 'hosted' : 'local'));
  const groupRef = useRef([]), sectionRef = useRef(noSections);
  // Pages are part of the board; the open page and its viewport are this person's preference.
  const [pages, setPages] = useState(defaultPages), pagesRef = useRef(pages);
  const pagePreferenceKey = `concept-graph-pages:${cloud ? `cloud:${cloudSession.user.name}` : hosted ? 'hosted' : 'local'}:${boardId}`;
  const pagePreference = useRef(null);
  pagePreference.current ||= readPagePreference(localStorage, pagePreferenceKey);
  const [pageChoice, setPageChoice] = useState(() => pagePreference.current.page);
  const activePage = resolvePage(pages, pageChoice), activePageRef = useRef(activePage); activePageRef.current = activePage;
  const [pageDelete, setPageDelete] = useState(null);
  const [status, setStatus] = useState({}), [saved, setSaved] = useState('Loading…'), [loaded, setLoaded] = useState(false);
  const [limitsVersion, setLimitsVersion] = useState(0);
  const [toast, setToast] = useState(''), [viewId, setViewId] = useState(null), [viewSize, setViewSize] = useState(null), [starting, setStarting] = useState(null);
  const [tab, setTab] = useState('canvas');
  const [diagnosticsId, setDiagnosticsId] = useState(null);
  const diagnosticsReturnFocus = useRef(null);
  const openRunDetails = id => { diagnosticsReturnFocus.current = document.activeElement; setDiagnosticsId(id); };
  const [switching, setSwitching] = useState(false), [uploading, setUploading] = useState(false);
  const [transfer, setTransfer] = useState(null);
  const [login, setLogin] = useState(null), [loginBusy, setLoginBusy] = useState(false);
  const [installCodex, setInstallCodex] = useState(false);
  const [dismissSignIn, setDismissSignIn] = useState(false);
  const [templates, setTemplates] = useState([]), [templatesError, setTemplatesError] = useState('');
  const [templateForm, setTemplateForm] = useState(null), [templateDetails, setTemplateDetails] = useState(null), [templateBusy, setTemplateBusy] = useState(false);
  const [agentConnect, setAgentConnect] = useState(false);
  const [mcpBusy, setMcpBusy] = useState(false);
  const editorId = useRef(null), editorReady = useRef(false), mcpLocked = useRef(false), mcpBarrier = useRef(null), mcpUiRequest = useRef(null), moving = useRef(false), connecting = useRef(false);
  const boardFileInput = useRef(null);
  const [boardForm, setBoardForm] = useState(null), [nameDraft, setNameDraft] = useState(''), [deleteName, setDeleteName] = useState('');
  const originalBoardName = useRef('');
  const switchingRef = useRef(false), uploads = useRef(0);
  const boardPath = `/api/boards/${boardId}`;
  const currentBoard = boards.find(board => board.id === boardId);
  const loadDiagnosticRun = useCallback(async id => { const { board } = await api(boardPath); return board.graph.runs.find(run => run.id === id) || null; }, [boardPath]);
  useEffect(() => { setDiagnosticsId(null); }, [boardId]);
  const [connectionType, setConnectionType] = useState('text');
  const [now, setNow] = useState(Date.now);
  const hasActiveRuns = runs.some(busy);
  const quitState = useRef({});
  quitState.current = { starting, transfer, templateForm, templateBusy };
  useEffect(() => {
    if (!hasActiveRuns) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasActiveRuns]);
  const modalOpen = useRef(false);
  const showSignIn = desktopMode && loaded && status.connected && !status.signedIn && !dismissSignIn && !login;
  const pairing = !!(cloudSession?.pairing || helperSession?.pairing), helperNeeded = cloud || hosted;
  // A viewer of a shared board sees it live and can select, copy and look around but change nothing; the room ignores their edits too.
  const readOnly = cloud && cloudSession.role === 'view', readOnlyRef = useRef(readOnly), canRename = !cloud || cloudSession.role === 'owner'; readOnlyRef.current = readOnly;
  modalOpen.current = !!viewId || !!boardForm || !!pageDelete || !!templateForm || !!templateDetails || !!diagnosticsId || agentConnect || switching || !!transfer || !!login || installCodex || showSignIn || pairing;
  const flow = useReactFlow();
  const nodesInitialized = useNodesInitialized(), openingViewDone = useRef(false), viewerMoved = useRef(false);
  const scoped = useMemo(() => pageContent({ nodes, edges, groups, sections }, activePage, pages), [nodes, edges, groups, sections, activePage, pages]);
  // Board-sized derivations are memoized, so the 1 s generation timer and other small updates do no per-node work.
  const canAlign = useMemo(() => { const alignable = alignIds(scoped); return scoped.nodes.filter(node => alignable.has(node.id) && !isAnnotation(node)).length >= 2; }, [scoped]);
  // Fitting may zoom out past the 0.15 gesture limit only on pages small enough to draw every card at once.
  const fitFloor = () => pageGraph().nodes.length > 1500 ? .15 : .01;
  useEffect(() => {
    if (!loaded || openingViewDone.current) return;
    if (!scoped.nodes.length && !scoped.sections.length) { openingViewDone.current = true; return; }
    if (!nodesInitialized || !flow.viewportInitialized) return;
    openingViewDone.current = true;
    const page = activePageRef.current, fit = () => flow.fitView({ padding: .18, minZoom: fitFloor(), maxZoom: 1 });
    fit();
    // Image nodes grow as their pictures load, so refit briefly unless the viewer has moved the canvas.
    [400, 1000, 2000, 3500].forEach(ms => setTimeout(() => { if (!viewerMoved.current && activePageRef.current === page) fit(); }, ms));
  }, [loaded, scoped.nodes.length, scoped.sections.length, nodesInitialized, flow, activePage]);
  const teammateCodex = cloud && cloudSession.codex?.outgoing?.granted && cloudSession.codex.outgoing.available ? cloudSession.codex.outgoing : null;
  const readiness = generationReadiness({ required: helperNeeded, paired: cloud ? cloudSession.paired : !!helperSession?.paired, online: !helperOffline, status, teammate: teammateCodex });
  const ownReady = (readiness.own || readiness).key === 'ready';
  const readinessRef = useRef(readiness); readinessRef.current = readiness;
  const nano = nanoState(cloudSession?.nano), nanoRef = useRef(nano); nanoRef.current = nano;
  const nodeRef = useRef([]), edgeRef = useRef([]), base = useRef({ revision: 0, nodes: [], edges: [] }), nodeCommit = useRef(null);
  const cloudBase = useRef({ nodes: [], edges: [], groups: [], runs: [] }), applyingCloud = useRef(false), cloudOfflineEdits = useRef(false), cloudRuns = useRef({ source: null, shown: new WeakMap() });
  const dirty = useRef(false), version = useRef(0), saving = useRef(null), saveTimer = useRef(null), viewport = useRef({ x: 0, y: 0, zoom: 1 });
  const history = useRef([]), future = useRef([]), lastHistory = useRef('');
  const remoteGroups = useRef({ version: 0, added: new Map() });
  const remoteCaptions = useRef({ version: 0, added: new Map() });
  const mouse = useRef({ x: innerWidth / 2, y: innerHeight / 2 }), fileInput = useRef(null), toastTimer = useRef(null);
  const saveFn = useRef(null);
  const notify = useCallback(message => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 6500); }, []);
  const refreshTemplates = useCallback(async () => {
    // An unchanged library keeps its identity, so a change elsewhere on the board does not re-render every prompt.
    const show = list => setTemplates(current => JSON.stringify(current) === JSON.stringify(list) ? current : list);
    if (cloudSession) { show(cloudSession.templates.read()); setTemplatesError(''); return; }
    try { show((await api('/api/templates')).templates); setTemplatesError(''); }
    catch { setTemplatesError(t('Custom nodes unavailable.')); }
  }, []);
  // A cloud board's custom nodes live in its document and arrive with everyone's other changes.
  useEffect(() => { refreshTemplates(); return cloudSession?.templates.subscribe(refreshTemplates); }, [refreshTemplates]);
  useEffect(() => { if (cloudSession) { setStatus(cloudSession.helperStatus); if (cloudSession.paired) setHelperOffline(false); } }, [cloudSession?.paired, cloudSession?.helperStatus]);
  useEffect(() => { if (helperSession?.status) { setStatus(helperSession.status); setHelperOffline(false); helperSession.reconnect?.(); } }, [helperSession?.status]);
  useEffect(() => { if (cloudSession?.error) notify(cloudSession.error); }, [cloudSession?.error, notify]);
  // Teammates on this board see whether this person's Codex can take their generations.
  useEffect(() => { cloudSession?.shareCodex?.(ownReady); }, [ownReady]);
  useEffect(() => {
    if (!cloudSession) return;
    cloudSession.notify = notify;
    return () => { cloudSession.notify = null; };
  }, [notify]);
  useEffect(() => { if (cloudSession) cloudSession.selection([...scoped.nodes.filter(node => node.selected).map(node => node.id), ...scoped.groups.filter(group => group.selected).map(group => group.id), ...scoped.sections.filter(section => section.selected).map(section => section.id)]); }, [nodes, groups, sections, activePage]);
  useEffect(() => { cloudSession?.page?.(activePage); }, [activePage]);
  const putNodes = value => { nodeRef.current = typeof value === 'function' ? value(nodeRef.current) : value; clearTimeout(nodeCommit.current); nodeCommit.current = null; setNodes(nodeRef.current); };
  // Typing updates the board (saves, sync, generation) at once but the editor's React state at most every 200ms,
  // so a keystroke re-renders only its own card. The commit renders synchronously, so no keystroke can land between.
  const putNodesSoon = update => {
    nodeRef.current = update(nodeRef.current);
    nodeCommit.current ||= setTimeout(() => { nodeCommit.current = null; if (alive.current) flushSync(() => setNodes(nodeRef.current)); }, 200);
  };
  const putEdges = value => { edgeRef.current = typeof value === 'function' ? value(edgeRef.current) : value; setEdges(edgeRef.current); };
  const putGroups = value => { groupRef.current = typeof value === 'function' ? value(groupRef.current) : value; setGroups(groupRef.current); };
  const putPages = value => { pagesRef.current = typeof value === 'function' ? value(pagesRef.current) : value; setPages(pagesRef.current); };
  const putSections = value => { sectionRef.current = typeof value === 'function' ? value(sectionRef.current) : value; setSections(sectionRef.current); };
  const deselectSections = () => putSections(current => current.some(section => section.selected) ? current.map(deselected) : current);
  const currentGraph = () => ({ nodes: nodeRef.current, edges: edgeRef.current, groups: groupRef.current, sections: sectionRef.current });
  // What undo snapshots: the whole board, every page.
  const boardContent = () => ({ ...currentGraph(), pages: pagesRef.current });
  // User-level actions see only the open page; saves, sync and history always keep the whole board.
  const pageGraph = () => pageContent(currentGraph(), activePageRef.current, pagesRef.current);
  const placeOnPage = node => assignPage(node, activePageRef.current);
  const rememberPage = () => writePagePreference(localStorage, pagePreferenceKey, { page: activePageRef.current, viewports: pagePreference.current.viewports }, pagesRef.current);
  const showPage = (pageId, restoreView = true) => {
    const target = resolvePage(pagesRef.current, pageId), previous = activePageRef.current;
    if (target === previous) return false;
    if (restoreView) finishBoardEdit();
    if (openingViewDone.current) pagePreference.current.viewports[previous] = flow.getViewport();
    activePageRef.current = target; pagePreference.current.page = target; setPageChoice(target);
    putNodes(current => current.some(node => node.selected) ? current.map(node => node.selected ? { ...node, selected: false } : node) : current);
    putGroups(current => current.some(group => group.selected) ? current.map(group => group.selected ? { ...group, selected: false } : group) : current);
    deselectSections();
    setFocusId(null); setViewId(null); viewerMoved.current = true;
    rememberPage();
    if (!restoreView) return true;
    const remembered = pagePreference.current.viewports[target];
    const fallback = target === defaultPageId && !cloud && base.current.viewport;
    if (remembered || fallback) flow.setViewport(remembered || fallback);
    else if (!nodeRef.current.some(node => nodePage(node, pagesRef.current) === target)) flow.setViewport({ x: 0, y: 0, zoom: 1 });
    else { openingViewDone.current = false; viewerMoved.current = false; }
    return true;
  };
  // Run actions after React Flow has received the newly shown page.
  const afterPageShown = (switched, action) => {
    if (!switched) return action();
    requestAnimationFrame(() => requestAnimationFrame(action));
    setTimeout(action, 350);
  };
  const focusNode = (nodeId, control = 'text', preserveSelection = false) => {
    const node = nodeRef.current.find(node => node.id === nodeId);
    if (!node || !alive.current) return;
    if (showPage(nodePage(node, pagesRef.current), false)) preserveSelection = false;
    const expand = node.data.collapsed || groupRef.current.some(group => group.collapsed && group.nodeIds.includes(nodeId));
    if (expand && !preserveSelection) checkpoint();
    putNodes(current => current.map(node => {
      const selected = node.id === nodeId || (preserveSelection && !!node.selected), opened = node.id === nodeId && node.data.collapsed;
      return opened ? { ...refolded(node, false), selected } : !!node.selected === selected ? node : { ...node, selected };
    }));
    putGroups(current => current.map(group => group.selected || (group.collapsed && group.nodeIds.includes(nodeId)) ? { ...group, selected: false, collapsed: group.nodeIds.includes(nodeId) ? false : group.collapsed } : group));
    if (!preserveSelection) deselectSections();
    if (expand) markDirty();
    setFocusControl(control); setFocusId(nodeId);
    clearTimeout(highlightTimer.current); setHighlight(control === 'text' ? null : `${nodeId}:${control}`);
    highlightTimer.current = setTimeout(() => setHighlight(null), 6000);
    requestAnimationFrame(() => {
      if (!alive.current || !canvasElement.current) return;
      const bounds = canvasElement.current.getBoundingClientRect(), card = canvasElement.current.querySelector('.getting-started')?.getBoundingClientRect();
      const target = focusViewport(nodeRef.current.find(node => node.id === nodeId) || node, flow.getViewport(), { width: bounds.width, height: bounds.height, occlusion: card ? { x: card.left - bounds.left, y: card.top - bounds.top, width: card.width, height: card.height } : null });
      if (target) flow.setCenter(target.x, target.y, { zoom: target.zoom, duration: 180 });
    });
  };
  const trackOwnRun = runId => { effects.ownRun(runId); guide.report({ type: 'run-started', id: runId }); };
  useEffect(() => {
    if (cloudSession) { cloudSession.onOwnRun = trackOwnRun; cloudSession.onAgentRun = nodeId => agentRunRef.current(nodeId); }
    return () => { if (cloudSession) cloudSession.onOwnRun = cloudSession.onAgentRun = null; };
  }, []);
  useEffect(() => { for (const run of runs) guide.report({ type: 'run-finished', run }); }, [runs, guide.state.ownRuns]);
  useEffect(() => { if (helperNeeded && readiness.key === 'ready') guide.report({ type: 'helper' }); }, [readiness.key]);
  useEffect(() => { pendingIntent.current = null; }, [cloudSession?.pairCancel, helperSession?.pairCancel]);
  useEffect(() => {
    alive.current = true;
    const cancelIntent = () => { pendingIntent.current = null; };
    window.addEventListener('pagehide', cancelIntent);
    return () => { alive.current = false; cancelIntent(); clearTimeout(highlightTimer.current); clearTimeout(nodeCommit.current); window.removeEventListener('pagehide', cancelIntent); };
  }, []);
  useEffect(() => {
    if (!helperNeeded || (!cloudSession?.paired && !helperSession?.paired)) return;
    let active = true;
    const refresh = async () => {
      if (document.hidden) return;
      try { const value = await api('/api/status', { method: 'POST', helper: cloud }); if (active) { setStatus(value); setHelperOffline(false); } }
      catch { if (active) setHelperOffline(true); }
    };
    refresh(); const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [cloudSession?.paired, helperSession?.paired]);
  useEffect(() => {
    if (pairing || readiness.key !== 'ready' || !pendingIntent.current) return;
    const intent = pendingIntent.current; pendingIntent.current = null;
    if (intentUnchanged(intent, currentGraph(), boardId)) runAction.current(intent.nodeId, intent);
    else { focusNode(intent.nodeId); notify(t('Prompt changed — review and click Generate')); }
  }, [readiness.key, pairing]);
  useEffect(() => {
    if (!login || !helperNeeded) return;
    let active = true;
    const timer = setInterval(async () => {
      try { const value = await api('/api/status', { method: 'POST', helper: cloud }); if (active) { setStatus(value); setHelperOffline(false); if (value.signedIn) setLogin(null); } } catch {}
    }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [login]);
  const syncCloud = feedback => {
    if (applyingCloud.current || cloudSession.closed) return;
    applyingCloud.current = true;
    clearTimeout(saveTimer.current); saveTimer.current = null;
    try {
      if (dirty.current) cloudSession.apply({ nodes: nodeRef.current, edges: edgeRef.current, groups: groupRef.current, sections: sectionRef.current, runs: cloudBase.current.runs, pages: storedPages(pagesRef.current, cloudBase.current.pages) }, cloudBase.current);
      const graph = cloudSession.read({ nodes: nodeRef.current, edges: edgeRef.current, groups: groupRef.current, sections: sectionRef.current });
      if (!feedbackSeeded.current || feedback) effects.observeGraph(graph, feedback || {});
      feedbackSeeded.current = true;
      cloudBase.current = graph; dirty.current = false;
      // Lists the reader returned unchanged are the editor's own arrays; skipping them avoids a board-wide re-render.
      const pages = boardPages(graph);
      if (JSON.stringify(pages) !== JSON.stringify(pagesRef.current)) putPages(pages);
      if (graph.nodes !== nodeRef.current) putNodes(graph.nodes);
      if (graph.edges !== edgeRef.current) putEdges(graph.edges);
      if (graph.groups !== groupRef.current) putGroups(graph.groups);
      // A board without sections reads none; an empty local list already shows that.
      const sharedSections = graph.sections || noSections;
      if (sharedSections !== sectionRef.current && (sharedSections.length || sectionRef.current.length)) putSections(sharedSections);
      if (graph.runs !== cloudRuns.current.source) {
        const known = cloudRuns.current.shown;
        cloudRuns.current.source = graph.runs;
        setRuns(graph.runs.map(run => { if (!known.has(run)) known.set(run, { ...run, createdAt: run.createdAt || run.startedAt, outputIds: run.outputIds || [] }); return known.get(run); }));
      }
    } finally { applyingCloud.current = false; }
  };
  const markDirty = (drag = false) => {
    if (cloudSession) {
      // A viewer's change is undone at once: nothing is written, and reading the board back restores it.
      if (readOnlyRef.current) {
        syncCloud();
        if (Date.now() - viewOnlyNoticed.current > 8000) { viewOnlyNoticed.current = Date.now(); notify(t('You can only view this board. Ask its owner for edit access.')); }
        return;
      }
      dirty.current = true;
      if (!cloudSession.provider.wsconnected || !cloudSession.provider.synced) cloudOfflineEdits.current = true;
      if (!drag) syncCloud();
      else if (!saveTimer.current) saveTimer.current = setTimeout(() => { saveTimer.current = null; syncCloud(); }, 80);
      return;
    }
    dirty.current = true; version.current++; setSaved('Saving…');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveFn.current().catch(error => { setSaved('Save failed'); notify(error.message); }), 500);
  };
  const checkpoint = () => {
    if (cloudSession) { syncCloud(); cloudSession.undo.stopCapturing(); return null; }
    const signature = historySignature(boardContent());
    if (signature !== lastHistory.current) { const snapshot = snapshotNow(); history.current.push(snapshot); history.current = history.current.slice(-50); lastHistory.current = signature; future.current = []; return snapshot; }
    return null;
  };
  const snapshotNow = () => captureHistory(boardContent(), { remoteGroupVersion: remoteGroups.current.version, remoteCaptionVersion: remoteCaptions.current.version, activeRunIds: runs.filter(busy).map(run => run.id) });
  const cancelCaption = (nodeId, caption, checkpointSnapshot) => {
    if (mcpLocked.current) return;
    const node = nodeRef.current.find(item => item.id === nodeId);
    const run = runs.find(item => item.id === node?.data.runId);
    const outputIndex = run?.outputIds?.indexOf(nodeId) ?? -1;
    const restored = caption === undefined && run?.outputIds?.length > 1 && outputIndex >= 0 ? `Image ${outputIndex + 1}` : caption;
    putNodes(current => current.map(node => {
      if (node.id !== nodeId) return node;
      const data = { ...node.data }; if (restored === undefined) delete data.caption; else data.caption = restored;
      return { ...node, data };
    }));
    markDirty();
    if (!checkpointSnapshot || history.current.at(-1) !== checkpointSnapshot) return restored;
    const snapshot = JSON.parse(checkpointSnapshot);
    if (historySignature(boardContent()) !== snapshotSignature(snapshot)) return restored;
    history.current.pop();
    const previous = history.current.at(-1) && JSON.parse(history.current.at(-1));
    lastHistory.current = previous ? snapshotSignature(previous) : '';
    return restored;
  };
  const mergeRemote = remote => {
    if (remote.revision <= base.current.revision) return;
    const knownNodes = new Set(base.current.nodes.map(n => n.id)), knownEdges = new Set(base.current.edges.map(e => e.id));
    const localIds = new Set(nodeRef.current.map(n => n.id));
    const newNodes = remote.nodes.filter(n => !knownNodes.has(n.id) && !localIds.has(n.id));
    const allIds = new Set([...localIds, ...newNodes.map(n => n.id)]);
    const localEdgeIds = new Set(edgeRef.current.map(e => e.id));
    const newEdges = remote.edges.filter(e => !knownEdges.has(e.id) && !localEdgeIds.has(e.id) && allIds.has(e.source) && allIds.has(e.target));
    const mergedNodes = mergeRemoteImageCaptions(nodeRef.current, remote.nodes, base.current.nodes);
    for (let i = 0; i < mergedNodes.length; i++) {
      const before = nodeRef.current[i], after = mergedNodes[i];
      if (after !== before && after.data.runId && !before.data.caption && after.data.caption) {
        remoteCaptions.current.added.set(after.id, { version: ++remoteCaptions.current.version, before: before.data.caption, after: after.data.caption });
      }
    }
    putPages(mergePages(pagesRef.current, boardPages(remote), boardPages(base.current)));
    putNodes([...mergedNodes, ...newNodes]); putEdges([...edgeRef.current, ...newEdges]);
    const mergedGroups = mergeAddedGroups(groupRef.current, remote.groups || [], base.current.groups || [], nodeRef.current);
    for (const group of mergedGroups) if (!groupRef.current.some(item => item.id === group.id)) remoteGroups.current.added.set(group.id, ++remoteGroups.current.version);
    putGroups(mergedGroups);
    putSections(mergeSections(sectionRef.current, remote.sections || [], base.current.sections || []));
    base.current = remote;
    const newImages = newNodes.filter(node => node.type === 'image').length;
    if (newImages) notify(plural(newImages, '{count} new image added to your canvas', '{count} new images added to your canvas'));
    else if (newNodes.some(node => node.data.runId)) notify(t('New description added to your canvas'));
  };
  const saveNow = async () => {
    if (cloudSession) { syncCloud(); if (cloudOfflineEdits.current && !cloudSession.provider.synced) throw new Error(t('Reconnect before leaving this board so your offline edits can sync.')); return; }
    clearTimeout(saveTimer.current);
    if (saving.current) { await saving.current; if (dirty.current) return saveNow(); return; }
    if (!dirty.current) return;
    const save = async () => {
      for (let attempt = 0; attempt < 8 && dirty.current; attempt++) {
        const editVersion = version.current;
        const payload = { revision: base.current.revision, nodes: cleanNodes(nodeRef.current), edges: cleanEdges(edgeRef.current), groups: cleanGroups(groupRef.current), sections: cleanSections(sectionRef.current), pages: storedPages(pagesRef.current, base.current.pages), viewport: viewport.current };
        try {
          const options = jsonOptions('PUT', payload);
          if (editorId.current) options.headers['X-Concept-Graph-UI-Session'] = editorId.current;
          if (mcpBarrier.current) options.headers['X-Concept-Graph-Barrier'] = mcpBarrier.current;
          if (mcpUiRequest.current) options.headers['X-Concept-Graph-UI-Request'] = mcpUiRequest.current;
          const result = await api(boardPath + '/graph', options);
          if (result.revision >= base.current.revision) base.current = { ...payload, revision: result.revision };
          if (editVersion === version.current) dirty.current = false;
          setSaved(dirty.current ? 'Saving…' : 'All changes saved');
        } catch (error) {
          if (error.status !== 409) throw error;
          mergeRemote(error.value.graph);
        }
      }
      if (dirty.current) throw new Error(t('Canvas is changing too quickly to save. Try again in a moment.'));
    };
    saving.current = save();
    try { await saving.current; } finally { saving.current = null; }
  };
  saveFn.current = saveNow;

  useEffect(() => {
    if (cloudSession) return;
    const prepare = async () => {
      if (mcpLocked.current) throw new Error('Wait for the agent update or connection recovery before quitting.');
      if (uploads.current || switchingRef.current || quitState.current.starting || quitState.current.transfer || quitState.current.templateBusy) throw new Error('Wait for the current transfer to finish before quitting.');
      if (quitState.current.templateForm) throw new Error('Save or cancel the custom node before quitting.');
      finishBoardEdit(); await saveFn.current();
      await waitForPreferences();
      const { activeRuns } = await api('/api/desktop/status');
      if (typeof activeRuns !== 'boolean') throw new Error('Could not check the generation queue before quitting.');
      return { activeRuns };
    };
    window.conceptGraphPrepareToQuit = prepare;
    return () => { if (window.conceptGraphPrepareToQuit === prepare) delete window.conceptGraphPrepareToQuit; };
  }, []);

  useEffect(() => {
    if (cloudSession) {
      cloudSession.flush = syncCloud;
      cloudSession.follow = peerId => latest.current.followPeer(peerId);
      cloudSession.leave = callback => {
        if (uploads.current || quitState.current.starting) { notify(t('Wait for the current transfer to finish before leaving this board.')); return; }
        pendingIntent.current = null;
        saveNow().then(callback).catch(error => notify(error.message));
      };
      const unsubscribe = cloudSession.subscribe(syncCloud);
      const sync = value => { if (value) { cloudOfflineEdits.current = false; setLoaded(true); syncCloud({ live: false }); } };
      const hide = () => syncCloud();
      cloudSession.provider.on('sync', sync); window.addEventListener('pagehide', hide);
      syncCloud(); setLoaded(!!cloudSession.loaded || cloudSession.provider.synced);
      return () => { syncCloud(); unsubscribe(); cloudSession.provider.off('sync', sync); window.removeEventListener('pagehide', hide); clearTimeout(saveTimer.current); clearTimeout(toastTimer.current); };
    }
    let events, disposed = false, syncing = false, retryTimer, recoveryTimer, screenshotTimer, screenshotId, pageHiding = false, resumeId;
    const editorKey = `concept-graph-editor:${boardId}`;
    if (mcpEnabled) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(editorKey) || 'null');
        if (saved?.closed === true && typeof saved.id === 'string') {
          resumeId = saved.id;
          sessionStorage.setItem(editorKey, JSON.stringify({ id: resumeId, closed: false }));
        }
      } catch {}
    }
    const pagehide = () => {
      pageHiding = true;
      const id = editorId.current || resumeId;
      try {
        const saved = JSON.parse(sessionStorage.getItem(editorKey) || 'null');
        if (id && saved?.id === id) sessionStorage.setItem(editorKey, JSON.stringify({ id, closed: true }));
      } catch {}
      if (editorId.current && !dirty.current && !saving.current && !mcpLocked.current) {
        request(`/api/desktop/editors/${editorId.current}/close`, { ...jsonOptions('POST', {}), keepalive: true }).catch(() => {});
      }
    };
    if (mcpEnabled) window.addEventListener('pagehide', pagehide);
    const editorPath = suffix => `/api/desktop/editors/${editorId.current}/${suffix}`;
    const lock = () => {
      if (document.activeElement instanceof HTMLElement) flushSync(() => document.activeElement.blur());
      mcpLocked.current = true;
      document.querySelector('.app-shell')?.setAttribute('inert', '');
      setMcpBusy(true);
    };
    const unlock = () => {
      mcpLocked.current = false; mcpBarrier.current = null; mcpUiRequest.current = null;
      document.querySelector('.app-shell')?.removeAttribute('inert');
      setMcpBusy(false);
    };
    const replaceGraph = async graph => {
      effects.observeGraph(graph);
      base.current = graph;
      flushSync(() => { putPages(boardPages(graph)); putNodes(graph.nodes); putEdges(graph.edges); putGroups(graph.groups || []); putSections(graph.sections || noSections); setRuns(graph.runs); setSaved('All changes saved'); });
      if (openingViewDone.current) { viewport.current = graph.viewport; await flow.setViewport(graph.viewport); }
    };
    const acknowledge = value => api(editorPath('ack'), jsonOptions('POST', value));
    const synchronize = async () => {
      if (disposed || syncing || !editorId.current) return;
      syncing = true; lock();
      try {
        if (dirty.current) await saveFn.current();
        const { board: { graph }, status: nextStatus } = await api(boardPath);
        if (disposed) return;
        await replaceGraph(graph); setStatus(nextStatus);
        await api(editorPath('ready'), jsonOptions('POST', { revision: graph.revision }));
        if (disposed) return;
        editorReady.current = true; feedbackLive = true;
        flushSync(() => { setLoaded(true); unlock(); });
        await editorReadyCallback(editorId.current).catch(() => {});
      } catch {
        if (!disposed) { setSaved('Synchronizing…'); retryTimer = setTimeout(synchronize, 700); }
      } finally { syncing = false; }
    };
    let feedbackLive = false;
    const connect = () => {
      const suffix = editorId.current ? `?editor=${encodeURIComponent(editorId.current)}` : '';
      events = new EventSource(tokenUrl(boardPath + '/events' + suffix));
      events.addEventListener('open', () => { feedbackLive = false; });
      events.addEventListener('error', () => { feedbackLive = false; effects.forgetPending(); });
      events.addEventListener('boards', event => updateBoards(JSON.parse(event.data).boards));
      events.addEventListener('status', event => setStatus(JSON.parse(event.data)));
      events.addEventListener('limits-changed', () => setLimitsVersion(version => version + 1));
      events.addEventListener('login', event => {
        const result = JSON.parse(event.data); setLogin(null);
        if (result.success) notify(t('Signed in to ChatGPT.'));
        else if (result.reason !== 'cancelled') notify(t('Sign-in did not complete. Try again.'));
      });
      events.addEventListener('graph', event => {
        if (mcpEnabled && !editorReady.current) { synchronize(); return; }
        const graph = JSON.parse(event.data); effects.observeGraph(graph, { live: feedbackLive }); feedbackLive = true; mergeRemote(graph); setRuns(graph.runs);
      });
      events.addEventListener('run', event => {
        const run = JSON.parse(event.data);
        effects.observeRun(run, feedbackLive);
        setRuns(current => { const old = current.find(r => r.id === run.id); return old ? current.map(r => r.id === run.id ? { ...r, ...run } : r) : [...current, run]; });
        if (['completed', 'cancelled', 'error'].includes(run.status) && run.captionMissing > 0) notify(t('Some images have generic labels. Click a label to edit it.'));
      });
      events.addEventListener('templates', refreshTemplates);
      events.addEventListener('mcp-prepare', async event => {
        const { id } = JSON.parse(event.data);
        if (!editorReady.current || mcpLocked.current || moving.current || stroke.current || connecting.current || modalOpen.current || uploads.current || switchingRef.current || quitState.current.starting || quitState.current.transfer || quitState.current.templateBusy) {
          await acknowledge({ id, phase: 'prepared', message: 'Finish the current operation before the agent edits this board.' }).catch(() => {}); return;
        }
        mcpBarrier.current = id; lock();
        try {
          await saveFn.current();
          await acknowledge({ id, phase: 'prepared', revision: base.current.revision });
        } catch (error) {
          await acknowledge({ id, phase: 'prepared', message: error.message || 'Could not save the board.' }).catch(() => {});
        }
      });
      events.addEventListener('mcp-commit', async event => {
        const { id, graph } = JSON.parse(event.data);
        if (mcpBarrier.current !== id || !mcpLocked.current) return;
        recoveryTimer = setTimeout(() => {
          if (disposed || mcpBarrier.current !== id) return;
          editorReady.current = false; events?.close(); connect();
        }, 9000);
        try { checkpoint(); await replaceGraph(graph); await acknowledge({ id, phase: 'applied', revision: graph.revision }); } catch {}
      });
      events.addEventListener('mcp-ui-request', async event => {
        const value = JSON.parse(event.data), id = value.id;
        const send = result => api('/api/desktop/ui-results', jsonOptions('POST', { editorId: editorId.current, id, ...result }));
        if (value.action === 'screenshot') {
          if (mcpLocked.current || !editorReady.current || screenshotId) { await send({ error: 'The editor is busy.' }).catch(() => {}); return; }
          screenshotId = id;
          screenshotTimer = setTimeout(() => { screenshotId = null; send({ error: 'Screenshot timed out.' }).catch(() => {}); }, 26000);
          try {
            const message = { type: 'mcp-screenshot', id };
            if (window.webkit?.messageHandlers?.conceptGraph) window.webkit.messageHandlers.conceptGraph.postMessage(message);
            else if (window.chrome?.webview) window.chrome.webview.postMessage(message);
            else throw new Error('Native screenshot is unavailable.');
          } catch (error) { clearTimeout(screenshotTimer); screenshotId = null; await send({ error: error.message }).catch(() => {}); }
          return;
        }
        if (value.action === 'select_board') {
          if (!editorReady.current || mcpLocked.current || moving.current || stroke.current || connecting.current || modalOpen.current || uploads.current || switchingRef.current || quitState.current.starting || quitState.current.transfer || quitState.current.templateBusy) {
            await send({ error: 'Finish the current operation before switching boards.' }).catch(() => {}); return;
          }
          mcpUiRequest.current = id; lock();
          try {
            await saveFn.current(); await waitForPreferences();
            const workspace = await api('/api/workspace');
            if (!workspace.boards.some(board => board.id === value.boardId)) throw new Error('Board not found.');
            updateBoards(workspace.boards);
            selectBoard(value.boardId, id);
          } catch (error) { unlock(); await send({ error: error.message || 'Could not switch boards.' }).catch(() => {}); }
          return;
        }
        if (value.action === 'undo' || value.action === 'redo') {
          if (!editorReady.current || mcpLocked.current || moving.current || stroke.current || connecting.current || modalOpen.current || uploads.current || switchingRef.current || quitState.current.starting || quitState.current.transfer || quitState.current.templateBusy) {
            await send({ error: 'Finish the current operation before changing history.' }).catch(() => {}); return;
          }
          const redo = value.action === 'redo';
          finishBoardEdit();
          if (!(redo ? future.current : history.current).length) { await send({ changed: false, saved: true }).catch(() => {}); return; }
          mcpUiRequest.current = id; lock(); let changed = false;
          try { undo(redo); changed = true; await saveFn.current(); await send({ changed: true, saved: true }); }
          catch (error) {
            if (changed) await send({ changed: true, saved: false, warning: 'The change is visible but could not be saved. Do not repeat it.' }).catch(() => {});
            else await send({ error: error.message || 'Could not change history.' }).catch(() => {});
          } finally { unlock(); }
        }
      });
      const release = event => { const { id } = JSON.parse(event.data); if (mcpBarrier.current === id) { clearTimeout(recoveryTimer); unlock(); } };
      events.addEventListener('mcp-release', release);
      events.addEventListener('mcp-abort', release);
      events.onerror = () => { setStatus(current => ({ ...current, connected: false })); if (mcpEnabled) { editorReady.current = false; lock(); } };
    };
    if (helperSession) helperSession.reconnect = () => { events?.close(); connect(); saveFn.current().catch(error => notify(error.message)); };
    window.conceptGraphScreenshotResult = value => {
      if (!value || value.id !== screenshotId) return;
      const id = screenshotId; screenshotId = null; clearTimeout(screenshotTimer);
      api('/api/desktop/ui-results', jsonOptions('POST', { editorId: editorId.current, id, ...(value.error ? { error: String(value.error).slice(0, 500) } : { mimeType: value.mimeType, data: value.data }) })).catch(() => {});
    };
    (async () => {
      if (mcpEnabled) {
        let id;
        for (let attempt = 0; attempt < 40 && !disposed; attempt++) {
          try { ({ editorId: id } = await api('/api/desktop/editors', jsonOptions('POST', { boardId, ...(resumeId ? { previousEditorId: resumeId } : {}) }))); break; }
          catch (error) {
            if (error.status !== 423 || attempt === 39) throw error;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
        if (!id) return;
        editorId.current = id;
        try { sessionStorage.setItem(editorKey, JSON.stringify({ id, closed: false })); } catch {}
        if (disposed) { await request(editorPath('close'), { ...jsonOptions('POST', {}), keepalive: true }); return; }
        connect(); return;
      }
      const { board: { graph }, status: nextStatus } = await api(boardPath);
      if (disposed) return;
      effects.observeGraph(graph);
      base.current = graph; putPages(boardPages(graph)); putNodes(graph.nodes); putEdges(graph.edges); putGroups(graph.groups || []); putSections(graph.sections || noSections); setRuns(graph.runs); setStatus(nextStatus);
      setLoaded(true); setSaved('All changes saved'); connect();
    })().catch(error => { if (!disposed) { setSaved('Could not load'); notify(error.message); } });
    return () => {
      disposed = true; events?.close(); clearTimeout(retryTimer); clearTimeout(recoveryTimer); clearTimeout(screenshotTimer); clearTimeout(saveTimer.current); clearTimeout(toastTimer.current);
      if (helperSession) helperSession.reconnect = null;
      if (mcpEnabled) window.removeEventListener('pagehide', pagehide);
      if (!pageHiding) {
        try { const saved = JSON.parse(sessionStorage.getItem(editorKey) || 'null'); if (saved?.id === editorId.current) sessionStorage.removeItem(editorKey); } catch {}
      }
      delete window.conceptGraphScreenshotResult;
      if (editorId.current) request(editorPath('close'), { ...jsonOptions('POST', {}), keepalive: true }).catch(() => {});
    };
  }, []);

  const addText = (position, text = '', template = null, extra = {}) => {
    checkpoint();
    const node = placeOnPage({ id: id(), type: 'text', z: nextLayer(nodeRef.current), position: position || freeSpot(pageGraph(), flow.screenToFlowPosition({ x: innerWidth * .52, y: innerHeight * .36 })), data: { text, createdAt: new Date().toISOString(), ...(template ? { labelOutputs: !!template.labelOutputs, template: templateSnapshot(template) } : {}), ...extra } });
    effects.createNodes([node.id]);
    putNodes(current => [...current.map(deselected), { ...node, selected: true }]); markDirty();
    focusNode(node.id); guide.report({ type: 'prompt' });
    return node;
  };
  // From a folded slideshow a new prompt goes beside the card, not beside the hidden image.
  const promptSpot = sourceId => {
    const graph = pageGraph(), folded = graph.groups.find(group => group.collapsed && group.slideshow && group.nodeIds.includes(sourceId)), box = folded && frameBox(folded, graph.nodes);
    return box ? freeSpot(graph, { x: box.x + box.width + 90, y: box.y }) : freePromptPosition(graph, sourceId);
  };
  // A describe node fed by the given images; from the sidebar, by the selected ones.
  const addDescribe = (sourceIds = pageGraph().nodes.filter(node => node.selected && node.type === 'image').map(node => node.id)) => {
    if (mcpLocked.current || !loaded || switchingRef.current) return;
    try {
      const sources = sourceIds.slice(0, 10), node = addText(sources.length ? promptSpot(sources[0]) : undefined, '', null, { task: describeTask });
      if (!sources.length) return;
      const added = sources.map(source => ({ id: id(), source, target: node.id })); effects.createEdges(added.map(edge => edge.id), added.map(edge => edge.target));
      putEdges(current => [...current, ...added]); markDirty();
    } catch (error) { notify(error.message); }
  };
  const promptFrom = sourceId => {
    if (mcpLocked.current || !loaded || switchingRef.current) return;
    if (!['text', 'image'].includes(nodeRef.current.find(node => node.id === sourceId)?.type)) return;
    try {
      const node = addText(promptSpot(sourceId));
      const edge = { id: id(), source: sourceId, target: node.id }; effects.createEdges([edge.id], [edge.target]);
      putEdges(current => [...current, edge]); markDirty();
      guide.report({ type: 'variation' });
    } catch (error) { notify(error.message); }
  };
  const switchTemplate = (nodeId, templateId) => {
    if (mcpLocked.current) return;
    const node = nodeRef.current.find(item => item.id === nodeId);
    const template = templateId ? templates.find(item => item.id === templateId) : null;
    if (!node || node.type !== 'text') return;
    if (templateId && !template) { notify(t('Custom node no longer exists.')); return; }
    if (!template && !node.data.template) return;
    checkpoint();
    putNodes(current => current.map(item => item.id === nodeId ? switchNodeTemplate(item, template) : item));
    markDirty();
  };
  const saveTemplateFromNode = nodeId => {
    if (mcpLocked.current) return;
    try { setTemplateForm({ template: null, initial: templateFromNode(nodeRef.current.find(node => node.id === nodeId), nodeRef.current, edgeRef.current) }); }
    catch (error) { notify(error.message); }
  };
  const saveTemplate = async value => {
    const existing = templateForm?.template;
    const template = cloudSession ? cloudSession.templates.save(value, existing) : (await api(existing ? `/api/templates/${existing.id}` : '/api/templates', jsonOptions(existing ? 'PUT' : 'POST', existing ? { ...value, expected: existing } : value))).template;
    setTemplates(current => existing ? current.map(item => item.id === template.id ? template : item) : [...current.filter(item => item.id !== template.id), template]);
    setTemplateForm(null);
  };
  const deleteTemplate = async () => {
    const existing = templateForm?.template;
    if (!existing) return;
    if (cloudSession) cloudSession.templates.remove(existing);
    else await api(`/api/templates/${existing.id}`, jsonOptions('DELETE', { expected: existing }));
    setTemplates(current => current.filter(item => item.id !== existing.id));
    setTemplateForm(null);
  };
  // Sidebar items can be dragged onto the board as well as clicked; what is dropped lands under the pointer.
  const toolDrag = value => ({ draggable: true, onDragStart: event => { event.dataTransfer.setData(toolType, JSON.stringify(value)); event.dataTransfer.effectAllowed = 'copy'; } });
  const dropTool = (raw, point) => {
    let value;
    try { value = JSON.parse(raw); } catch { return; }
    const at = { x: point.x - 155, y: point.y - 40 };
    if (value?.kind === 'text') addText(at);
    else if (value?.kind === 'describe') addText(at, '', null, { task: describeTask });
    else if (value?.kind === 'template') { const template = templates.find(item => item.id === value.id); if (template) addText(at, '', template); }
    // Images still come from a file; they are placed where the item was dropped.
    else if (value?.kind === 'image') { imageDrop.current = point; fileInput.current.click(); }
  };
  const addImages = async (files, position) => {
    if (readOnlyRef.current) return;
    checkpoint(); uploads.current++; setUploading(true);
    const page = activePageRef.current;
    try { for (const [index, file] of [...files].entries()) {
      try {
        const { asset } = await api('/api/assets', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
        const start = position || flow.screenToFlowPosition({ x: innerWidth * .5, y: innerHeight * .3 });
        const node = assignPage({ id: id(), type: 'image', z: nextLayer(nodeRef.current), position: { x: start.x + index * 35, y: start.y + index * 35 }, data: { asset, label: file.name || 'Pasted image', createdAt: new Date().toISOString() } }, page);
        effects.createNodes([node.id]); putNodes(current => [...current, node]); markDirty();
      } catch (error) { notify(error.message); }
    } } finally { uploads.current--; setUploading(uploads.current > 0); }
  };
  const insertSelection = (selection, position, duplicate = false) => {
    if (!selection.nodes.length && !selection.sections?.length) return;
    let copied;
    try { copied = cloneSelection(selection, position, duplicate ? { nodes: nodeRef.current, edges: edgeRef.current, groups: groupRef.current, pages: pagesRef.current } : selection); }
    catch (error) { notify(error.message); return; }
    const copiedSections = (copied.sections || []).map(placeOnPage);
    if (sectionRef.current.length + copiedSections.length > maxSections) { notify(t('A board can have at most {count} sections.', { count: maxSections })); return; }
    copied = { ...copied, nodes: stackOnTop(nodeRef.current, copied.nodes).map(placeOnPage) };
    checkpoint();
    effects.createNodes(copied.nodes.map(node => node.id)); effects.createEdges(copied.edges.map(edge => edge.id), copied.edges.map(edge => edge.target));
    putNodes(current => [...current.map(deselected), ...copied.nodes]);
    putEdges(current => [...current.map(deselected), ...copied.edges]);
    putGroups(current => current.map(deselected));
    putSections(current => [...current.map(deselected), ...copiedSections]);
    markDirty();
    const prompt = copied.nodes.find(node => node.type === 'text');
    if (prompt) { focusNode(prompt.id, 'text', true); guide.report({ type: 'prompt' }); }
  };
  const removeNodes = (ids, selectedEdges = false) => {
    if (mcpLocked.current) return;
    checkpoint();
    // Deleting a section deletes what it holds, as in FigJam; Remove section keeps it.
    const known = new Set(sectionRef.current.map(section => section.id)), sectionIds = new Set(ids.filter(id => known.has(id)));
    const held = sectionIds.size ? sectionContents(pageGraph(), sectionIds, measureView(viewCache.current)) : null;
    const removed = new Set([...ids, ...(held ? [...held.nodeIds, ...held.sectionIds] : [])]);
    const next = detachArrows(nodeRef.current, reconcileStampAttachments(nodeRef.current, nodeRef.current.filter(node => !removed.has(node.id))), measureView(viewCache.current));
    const retained = new Set(next.map(node => node.id));
    for (const node of nodeRef.current) if (!retained.has(node.id)) removed.add(node.id);
    effects.remove([...removed]); putNodes(next);
    putEdges(current => current.filter(e => !(selectedEdges && e.selected) && !removed.has(e.source) && !removed.has(e.target)));
    putGroups(pruneGroups(groupRef.current.filter(group => !removed.has(group.id)), nodeRef.current));
    if (held) putSections(current => current.filter(section => !removed.has(section.id)));
    markDirty();
  };
  const removeSelected = () => { const scoped = pageGraph(); removeNodes([...scoped.nodes, ...scoped.groups, ...scoped.sections].filter(item => item.selected).map(item => item.id), true); };
  const undo = (redo = false) => {
    effects.forgetPending();
    if (cloudSession) {
      syncCloud(); cloudSession.undo.stopCapturing();
      const changed = cloudSession.undo[redo ? 'redo' : 'undo']();
      if (changed && (!cloudSession.provider.wsconnected || !cloudSession.provider.synced)) cloudOfflineEdits.current = true;
      return;
    }
    const from = redo ? future.current : history.current, to = redo ? history.current : future.current;
    if (!from.length) return;
    to.push(snapshotNow());
    const snapshot = from.pop(); lastHistory.current = snapshot;
    const graph = JSON.parse(snapshot);
    const freshOutputs = freshOutputNodes(nodeRef.current, graph, runRef.current);
    const ids = new Set([...graph.nodes, ...freshOutputs].map(n => n.id));
    const freshEdges = edgeRef.current.filter(e => freshOutputs.some(n => n.id === e.target) && ids.has(e.source) && !graph.edges.some(old => old.id === e.id));
    const addedGroups = new Set([...remoteGroups.current.added].filter(([, version]) => version > (graph.remoteGroupVersion || 0)).map(([id]) => id));
    const restoredGroups = preserveFreshOutputGroups(graph.groups || [], groupRef.current, [...graph.nodes, ...freshOutputs], freshOutputs, addedGroups);
    const restoredNodes = restoreFirstImageFallback(preserveRemoteImageCaptions(graph.nodes, nodeRef.current, remoteCaptions.current.added, graph.remoteCaptionVersion || 0), nodeRef.current, runs, graph);
    putPages(graph.pages || defaultPages()); putNodes([...restoredNodes, ...freshOutputs]); putEdges([...graph.edges, ...freshEdges]); putGroups(restoredGroups); putSections(graph.sections || noSections); markDirty();
  };

  const groupSelected = () => {
    const members = pageGraph().nodes.filter(node => node.selected);
    if (members.length < 2 || groupRef.current.some(group => group.selected || group.nodeIds.some(id => members.some(node => node.id === id)))) return;
    checkpoint();
    const usedNames = new Set(groupRef.current.map(group => group.name));
    let number = 1; while (usedNames.has(`Group ${number}`)) number++;
    putGroups(current => [...current.map(deselected), { id: id(), name: `Group ${number}`, nodeIds: members.map(node => node.id), collapsed: false, selected: true }]);
    putNodes(current => current.map(deselected)); markDirty();
  };
  const editGroup = (groupId, patch) => {
    if (mcpLocked.current) return;
    const group = groupRef.current.find(group => group.id === groupId);
    if (!group || Object.entries(patch).every(([key, value]) => group[key] === value)) return;
    checkpoint();
    putGroups(current => current.map(group => {
      if (group.id !== groupId) return group;
      const next = { ...group, ...patch };
      for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key];
      return next;
    })); markDirty();
  };
  const addSection = rect => {
    if (mcpLocked.current || !loaded || switchingRef.current) return null;
    if (sectionRef.current.length >= maxSections) { notify(t('A board can have at most {count} sections.', { count: maxSections })); return null; }
    const section = placeOnPage({ id: id(), name: nextSectionName(sectionRef.current), x: rect.x, y: rect.y, width: Math.max(sectionMinimum.width, rect.width), height: Math.max(sectionMinimum.height, rect.height), selected: true });
    checkpoint();
    putNodes(current => current.some(node => node.selected) ? current.map(deselected) : current); putGroups(current => current.map(deselected));
    putSections(current => [...current.map(deselected), section]); markDirty();
    return section;
  };
  // Shift S and the menu wrap the selection; the menu of an unselected item wraps only that item, like Figma's right-click selection.
  const wrapInSection = targetId => {
    if (mcpLocked.current || !loaded || switchingRef.current) return;
    const scoped = pageGraph(), selected = new Set([...scoped.nodes, ...scoped.groups, ...scoped.sections].filter(item => item.selected).map(item => item.id));
    const ids = typeof targetId === 'string' && !selected.has(targetId) ? new Set([targetId]) : selected, bounds = ids.size ? wrapBounds(scoped, ids, measureView(viewCache.current)) : null;
    if (bounds) addSection(bounds);
  };
  const editSection = (sectionId, patch) => {
    if (mcpLocked.current) return;
    const section = sectionRef.current.find(item => item.id === sectionId);
    if (!section || Object.entries(patch).every(([key, value]) => section[key] === value)) return;
    checkpoint();
    putSections(current => current.map(item => {
      if (item.id !== sectionId) return item;
      const next = { ...item, ...patch };
      if (next.color === undefined) delete next.color;
      return next;
    })); markDirty();
  };
  const unwrapSection = sectionId => {
    if (mcpLocked.current || !sectionRef.current.some(section => section.id === sectionId)) return;
    checkpoint(); putSections(current => current.filter(section => section.id !== sectionId)); markDirty();
  };
  // A move takes along what each dragged section held when it started.
  const captureMove = sectionIds => {
    const page = pageGraph(), measure = measureView(viewCache.current);
    for (const sectionId of sectionIds) if (!sectionMoves.current.has(sectionId)) sectionMoves.current.set(sectionId, captureSections(page, new Set([sectionId]), measure));
    return sectionMoves.current;
  };
  const sectionResizeStart = () => { if (mcpLocked.current) return; moving.current = true; checkpoint(); };
  const sectionResizeEnd = () => { moving.current = false; if (cloudSession) syncCloud(); };
  const editAnnotation = (nodeId, patch) => {
    if (mcpLocked.current) return;
    const node = nodeRef.current.find(node => node.id === nodeId);
    if (!isAnnotation(node)) return;
    checkpoint(); putNodes(current => current.map(node => node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node)); markDirty();
  };
  // Moves one end of an arrow; on a node it holds on to that node, elsewhere it stays where it was dropped.
  const setArrowEnd = (arrowId, end, value) => {
    const node = nodeRef.current.find(item => item.id === arrowId);
    if (mcpLocked.current || node?.type !== 'arrow') return;
    const data = { ...node.data, [end]: value.node === arrowId ? { x: value.x, y: value.y } : value };
    checkpoint(); putNodes(current => current.map(item => item.id === arrowId ? { ...item, position: arrowPosition(data.from, data.to), data } : item)); markDirty();
  };
  const addAnnotation = value => {
    if (mcpLocked.current || !loaded || switchingRef.current) return;
    if (nodeRef.current.length >= maxNodes) { notify(t('Canvas is too large.')); return; }
    const author = value.type !== 'drawing' && boardAuthor(cloudSession?.user);
    const node = placeOnPage({ ...value, id: id(), z: nextLayer(nodeRef.current), selected: true, data: { ...value.data, createdAt: new Date().toISOString(), ...(author ? { author } : {}) } });
    checkpoint();
    putNodes(current => [...current.map(deselected), node]);
    putGroups(current => current.map(deselected)); deselectSections(); markDirty();
    if (['sticky', 'shape'].includes(node.type)) { setFocusControl('sticky'); setFocusId(node.id); }
  };
  // Menu actions on an unselected node arrange only that node, like Figma's right-click selection.
  const arrange = (action, nodeId) => {
    if (mcpLocked.current || !loaded || switchingRef.current) return;
    const scoped = pageGraph(), target = nodeId && scoped.nodes.find(node => node.id === nodeId);
    const layers = arrangeLayers(scoped.nodes, target && !target.selected ? [target.id] : scoped.nodes.filter(node => node.selected).map(node => node.id), action);
    if (!layers.size) return;
    checkpoint(); putNodes(current => current.map(node => layers.has(node.id) ? { ...node, z: layers.get(node.id) } : node)); markDirty();
  };
  const annotationDown = event => {
    if (toolRef.current === 'select' || event.button !== 0 || !event.target.closest('.react-flow') || mcpLocked.current || modalOpen.current) return;
    event.preventDefault(); event.stopPropagation();
    const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (toolRef.current === 'pen') {
      moving.current = true;
      stroke.current = { pointerId: event.pointerId, points: [[position.x, position.y]], pen: { ...pen } };
      event.currentTarget.setPointerCapture(event.pointerId); strokePreview.current?.show(stroke.current.points, stroke.current.pen);
    } else if (toolRef.current === 'sticky') {
      finishBoardEdit();
      addAnnotation({ type: 'sticky', position: { x: position.x - 100, y: position.y - 100 }, data: { text: '', color: stickyColor } }); chooseTool('select');
    } else if (toolRef.current === 'section' || toolRef.current === 'shape') {
      finishBoardEdit(); moving.current = true;
      sectionDraft.current = { pointerId: event.pointerId, start: position, screen: { x: event.clientX, y: event.clientY }, tool: toolRef.current };
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (toolRef.current === 'arrow') {
      // FigJam's connector: press on a thing (or anywhere), drag, release on another thing; ends hold on to what they touch.
      finishBoardEdit(); moving.current = true;
      const node = arrowTargetAt(flow.getNodes(), position);
      arrowDraft.current = { pointerId: event.pointerId, from: { x: position.x, y: position.y, ...(node ? { node } : {}) }, screen: { x: event.clientX, y: event.clientY } };
      event.currentTarget.setPointerCapture(event.pointerId);
    } else {
      const attachedTo = stampTargetAt(flow.getNodes(), position);
      addAnnotation({ type: 'stamp', position: { x: position.x - 24, y: position.y - 24 }, data: { kind: stamp, ...(attachedTo === undefined ? {} : { attachedTo }) } });
    }
  };
  const draftRect = (draft, event) => {
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    return { x: Math.min(draft.start.x, point.x), y: Math.min(draft.start.y, point.y), width: Math.abs(point.x - draft.start.x), height: Math.abs(point.y - draft.start.y) };
  };
  const annotationMove = event => {
    const draft = sectionDraft.current;
    if (draft?.pointerId === event.pointerId) { event.stopPropagation(); sectionPreview.current?.show(draftRect(draft, event)); return; }
    const line = arrowDraft.current;
    if (line?.pointerId === event.pointerId) {
      event.stopPropagation();
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      strokePreview.current?.show([[line.from.x, line.from.y], [point.x, point.y]], { color: arrowColor, width: 2.5 });
      return;
    }
    const current = stroke.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const coalesced = event.nativeEvent.getCoalescedEvents?.(), samples = coalesced?.length ? coalesced : [event];
    for (const sample of samples) {
      const point = flow.screenToFlowPosition({ x: sample.clientX, y: sample.clientY });
      const last = current.points.at(-1);
      if (Math.hypot(point.x - last[0], point.y - last[1]) >= .5) current.points.push([point.x, point.y]);
    }
    if (current.points.length > 4000) current.points = simplifyStroke(current.points, .75, 2000);
    strokePreview.current?.show([...current.points], current.pen);
  };
  const annotationUp = (event, cancelled = false) => {
    const draft = sectionDraft.current;
    if (draft?.pointerId === event.pointerId) {
      event.stopPropagation(); moving.current = false; sectionDraft.current = null; sectionPreview.current?.show(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (cancelled) return;
      // A click, or a drag of only a few pixels, makes a default-size section (or shape, centred there) with its corner there.
      const dragged = Math.hypot(event.clientX - draft.screen.x, event.clientY - draft.screen.y) >= 6;
      if (draft.tool === 'shape') {
        const rect = dragged ? draftRect(draft, event) : { x: draft.start.x - shapeDefault.width / 2, y: draft.start.y - shapeDefault.height / 2, ...shapeDefault };
        addAnnotation({ type: 'shape', position: { x: rect.x, y: rect.y }, data: { shape: shape.kind, width: Math.min(4000, Math.max(40, rect.width)), height: Math.min(4000, Math.max(40, rect.height)), color: shape.color, text: '' } });
      } else addSection(dragged ? draftRect(draft, event) : { ...draft.start, ...sectionDefault });
      // Back to Select after the click this release produces, so that click cannot deselect the new item.
      setTimeout(() => { if (['section', 'shape'].includes(toolRef.current)) chooseTool('select'); });
      return;
    }
    const line = arrowDraft.current;
    if (line?.pointerId === event.pointerId) {
      event.stopPropagation(); moving.current = false; arrowDraft.current = null; strokePreview.current?.show([]);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (cancelled) return;
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }), node = arrowTargetAt(flow.getNodes(), point);
      // A click draws a short arrow to the right; a drag that ends on its own start node does too.
      const short = Math.hypot(event.clientX - line.screen.x, event.clientY - line.screen.y) < 8 || (node && node === line.from.node);
      const to = short ? { x: line.from.x + 160, y: line.from.y } : { x: point.x, y: point.y, ...(node ? { node } : {}) };
      addAnnotation({ type: 'arrow', position: arrowPosition(line.from, to), data: { from: line.from, to, color: arrowColor } });
      return;
    }
    const current = stroke.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.stopPropagation(); moving.current = false; stroke.current = null; strokePreview.current?.show([]);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!cancelled) {
      const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }); current.points.push([point.x, point.y]);
      try { addAnnotation(drawingFromStroke(current.points, current.pen.color, current.pen.width)); } catch (error) { notify(error.message); }
    }
  };
  const annotationClick = event => {
    if (toolRef.current !== 'select' && event.target.closest('.react-flow')) { event.preventDefault(); event.stopPropagation(); }
  };
  // Show all on a cut-off prompt: the card grows to its whole text (its bottom edge can still be dragged back up).
  const setPromptHeight = (nodeId, height) => {
    const node = nodeRef.current.find(item => item.id === nodeId);
    if (mcpLocked.current || node?.type !== 'text') return;
    checkpoint(); putNodes(current => current.map(item => item.id === nodeId ? { ...item, data: { ...item.data, height: Math.round(Math.min(4000, Math.max(80, height))) } } : item)); markDirty();
  };
  const setVariants = (nodeId, count) => {
    const node = nodeRef.current.find(item => item.id === nodeId);
    if (mcpLocked.current || node?.type !== 'text' || (node.data.variants || 1) === count) return;
    checkpoint();
    putNodes(current => current.map(item => { if (item.id !== nodeId) return item; const data = { ...item.data }; if (count > 1) data.variants = count; else delete data.variants; return { ...item, data }; }));
    markDirty();
  };
  const setGenerator = (nodeId, generator) => {
    const node = nodeRef.current.find(item => item.id === nodeId);
    if (mcpLocked.current || node?.type !== 'text' || (node.data.generator || null) === (generator || null)) return;
    checkpoint();
    putNodes(current => current.map(item => { if (item.id !== nodeId) return item; const data = { ...item.data }; if (generator) data.generator = generator; else delete data.generator; return { ...item, data }; }));
    markDirty();
    if (generator) cloudSession?.refreshNano?.();
  };
  const toggleNodeCollapsed = nodeId => {
    if (mcpLocked.current || !nodeRef.current.some(node => node.id === nodeId)) return;
    checkpoint();
    putNodes(current => current.map(node => node.id === nodeId ? refolded(node, !node.data.collapsed) : node));
    markDirty();
  };
  const toggleGroup = groupId => {
    checkpoint();
    const group = groupRef.current.find(group => group.id === groupId);
    putNodes(current => current.map(node => group.nodeIds.includes(node.id) ? { ...node, selected: false } : node));
    putGroups(current => current.map(group => group.id === groupId ? { ...group, collapsed: !group.collapsed } : group)); markDirty();
  };
  const ungroup = groupId => { checkpoint(); putGroups(current => current.filter(group => group.id !== groupId)); markDirty(); };
  const toggleSlideshow = groupId => { const group = groupRef.current.find(item => item.id === groupId); if (group) editGroup(groupId, group.slideshow ? { slideshow: undefined, slide: undefined } : { slideshow: true }); };
  // The arrows of a folded slideshow step through its images. A viewer's choice stays on their screen and is never written.
  const showSlide = (groupId, step) => {
    if (mcpLocked.current) return;
    const group = groupRef.current.find(item => item.id === groupId), byId = new Map(nodeRef.current.map(node => [node.id, node]));
    if (!group) return;
    if (readOnlyRef.current) { setViewerSlides(current => new Map(current).set(groupId, steppedSlide({ ...group, slide: current.get(groupId) ?? group.slide }, byId, step))); return; }
    const slide = steppedSlide(group, byId, step);
    if (!slide || slide === group.slide) return;
    checkpoint(); putGroups(current => current.map(item => item.id === groupId ? { ...item, slide } : item)); markDirty();
  };
  // A connection dragged from a folded slideshow starts at the image it shows.
  const slideSource = nodeId => {
    const group = groupRef.current.find(item => item.id === nodeId);
    return group?.slideshow && group.collapsed ? slideshowState(group, new Map(nodeRef.current.map(node => [node.id, node]))).node?.id : nodeId;
  };
  const autoAlign = () => {
    const scoped = pageGraph(), ids = alignIds(scoped), next = alignSelection(scoped.nodes, scoped.edges, scoped.groups, ids);
    if (next === scoped.nodes) return;
    const aligned = new Map(next.map(node => [node.id, node]));
    checkpoint(); putNodes(current => current.map(node => aligned.get(node.id) || node)); markDirty();
    requestAnimationFrame(() => flow.fitView({ nodes: [...ids].map(id => ({ id })), duration: 300, padding: .18, maxZoom: 1 }));
  };
  const addPage = () => {
    if (mcpLocked.current || !loaded || switchingRef.current) return null;
    if (pagesRef.current.length >= maxPages) { notify(t('A board can have at most {count} pages.', { count: maxPages })); return null; }
    checkpoint();
    const page = { id: id(), name: nextPageName(pagesRef.current) };
    putPages(current => [...current, page]); markDirty(); showPage(page.id);
    return page;
  };
  const renamePage = (pageId, value) => {
    if (mcpLocked.current) return;
    let name; try { name = pageName(value); } catch (error) { notify(error.message); return; }
    if (!pagesRef.current.some(page => page.id === pageId && page.name !== name)) return;
    checkpoint(); putPages(current => current.map(page => page.id === pageId ? { ...page, name } : page)); markDirty();
  };
  const pageBusy = pageId => runRef.current.some(run => busy(run) && resolvePage(pagesRef.current, run.page) === pageId)
    || (!!starting && nodePage(nodeRef.current.find(node => node.id === starting), pagesRef.current) === pageId);
  const requestPageDelete = pageId => {
    if (mcpLocked.current) return;
    const page = pagesRef.current.find(item => item.id === pageId);
    if (!page) return;
    if (pagesRef.current.length < 2) { notify(t('A board needs at least one page.')); return; }
    if (pageBusy(pageId)) { notify(t('Wait for generation on this page to finish before deleting it.')); return; }
    setPageDelete({ id: page.id, name: page.name, count: nodeRef.current.filter(node => nodePage(node, pagesRef.current) === pageId).length, returnFocus: document.activeElement });
  };
  const deletePage = pageId => {
    if (mcpLocked.current || pagesRef.current.length < 2 || !pagesRef.current.some(page => page.id === pageId)) return;
    if (pageBusy(pageId)) { notify(t('Wait for generation on this page to finish before deleting it.')); return; }
    checkpoint();
    const list = pagesRef.current, index = list.findIndex(page => page.id === pageId), removed = new Set(nodeRef.current.filter(node => nodePage(node, list) === pageId).map(node => node.id));
    const next = detachArrows(nodeRef.current, reconcileStampAttachments(nodeRef.current, nodeRef.current.filter(node => !removed.has(node.id))), measureView(viewCache.current));
    effects.remove([...removed]); putNodes(next);
    putEdges(current => current.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)));
    putGroups(pruneGroups(groupRef.current, next));
    putSections(current => current.filter(section => nodePage(section, list) !== pageId));
    putPages(list.filter(page => page.id !== pageId));
    if (activePageRef.current === pageId) showPage(list[index > 0 ? index - 1 : 1].id);
    else rememberPage();
    markDirty();
  };
  const showRun = run => {
    const page = [run.nodeId, ...(run.outputIds || [])].map(id => nodeRef.current.find(node => node.id === id)).find(Boolean);
    const switched = showPage(page ? nodePage(page, pagesRef.current) : resolvePage(pagesRef.current, run.page), false);
    afterPageShown(switched, () => {
      const targets = generationFocusNodes(run, flow.getNodes(), groupRef.current);
      if (targets.length) flow.fitView({ nodes: targets, duration: 350, padding: .25, minZoom: fitFloor(), maxZoom: 1 });
    });
  };
  // FigJam selection: the box picks what it touches, Shift flips that against the selection the drag started from, and a
  // Shift-click on empty canvas keeps the selection. React Flow's box would pick whole bounding boxes and always start
  // afresh, so while the box is out the board's pick (`ids`, see the store subscription) overrules each of React Flow's.
  // Its picks are applied first rather than dropped: React Flow has already marked them in its own copy of the cards,
  // which only a changed card brings back in step.
  const marquee = useRef(null), shiftGrab = useRef(null), nodeDragged = useRef(false);
  const marqueeDown = event => {
    const onPane = toolRef.current === 'select' && event.button === 0 && event.target.classList?.contains('react-flow__pane');
    const base = onPane && event.shiftKey ? new Set([...nodeRef.current, ...groupRef.current, ...sectionRef.current].filter(item => item.selected).map(item => item.id)) : null;
    marquee.current = onPane ? { base, ids: base } : null;
    // The click's own modifiers decide, even when the window missed the key press (it had no focus yet).
    if (toolRef.current === 'select') flowStore.setState({ multiSelectionActive: event.shiftKey || event.metaKey });
    // React Flow drops a selected card that a Shift or ⌘ drag starts on; FigJam keeps it and moves the whole selection.
    shiftGrab.current = (event.shiftKey || event.metaKey) && event.target.closest?.('.react-flow__node.selected')?.dataset.id;
    nodeDragged.current = false;
  };
  const boxSelect = () => {
    const ids = marquee.current?.ids, { nodeLookup, edgeLookup } = flowStore.getState();
    if (!ids) return;
    // Connections follow their cards, as React Flow's box does.
    const edgeIds = new Set([...edgeLookup.values()].filter(edge => ids.has(edge.source) || ids.has(edge.target)).map(edge => edge.id));
    for (const [list, put, picked, scope] of [[nodeRef, putNodes, ids, nodeLookup], [groupRef, putGroups, ids, nodeLookup], [sectionRef, putSections, ids, nodeLookup], [edgeRef, putEdges, edgeIds, edgeLookup]]) {
      const next = reselect(list.current, picked, scope);
      if (next !== list.current) put(next);
    }
  };
  // A plain click (a drag moves them all) on one of several selected items leaves just that one selected, as in FigJam.
  const nodeClick = (event, node) => { if (!nodeDragged.current && !event.shiftKey && !event.metaKey && node.selected && [...flowStore.getState().nodeLookup.values()].some(item => item.selected && item.id !== node.id)) flowStore.getState().addSelectedNodes([node.id]); };
  // Shift-click in a text field extends its text selection; it must not also add or remove the card.
  const shiftTextClick = event => { if (event.shiftKey && event.target.closest?.('textarea,input,[contenteditable="true"]')) event.stopPropagation(); };
  const nodesChanged = changes => {
    if (mcpLocked.current && changes.some(change => ['position', 'remove', 'add', 'replace', 'select'].includes(change.type) || (change.type === 'dimensions' && change.resizing !== undefined))) return;
    const groupIds = new Set(groupRef.current.map(group => group.id)), sectionIds = new Set(sectionRef.current.map(section => section.id)), moved = new Set();
    const before = nodeRef.current;
    let next = before;
    for (const change of changes.filter(change => groupIds.has(change.id))) {
      if (change.type === 'select') putGroups(current => current.map(group => group.id === change.id ? { ...group, selected: change.selected } : group));
      if (change.type === 'position' && change.position) {
        const group = groupRef.current.find(group => group.id === change.id);
        next = moveGroup(next, group, change.position, false); group.nodeIds.forEach(id => moved.add(id));
      }
    }
    const sectionChanges = sectionIds.size ? changes.filter(change => sectionIds.has(change.id)) : [];
    if (sectionChanges.length) {
      let list = sectionRef.current;
      const update = (sectionId, patch) => { list = list.map(section => section.id === sectionId ? { ...section, ...patch } : section); };
      for (const change of sectionChanges) {
        if (change.type === 'select') update(change.id, { selected: change.selected });
        // Resizing from the top or left edge moves the frame alone; only a drag takes the contents along.
        else if (change.type === 'position' && change.position && change.dragging === undefined) update(change.id, change.position);
        else if (change.type === 'position' && change.position) {
          const capture = captureMove([change.id]).get(change.id), start = capture.sections.get(change.id);
          ({ nodes: next, sections: list } = moveCaptured({ nodes: next, sections: list }, capture, { x: change.position.x - start.x, y: change.position.y - start.y }));
          capture.nodes.forEach((_, nodeId) => moved.add(nodeId));
          if (!change.dragging) sectionMoves.current.delete(change.id);
        } else if (change.type === 'dimensions' && change.dimensions && (change.resizing !== undefined || change.setAttributes)) {
          update(change.id, { width: Math.max(sectionMinimum.width, change.dimensions.width), height: Math.max(sectionMinimum.height, change.dimensions.height) });
        }
      }
      if (list !== sectionRef.current) putSections(list);
    }
    // A shape's resize handles change its stored size, and a prompt's bottom edge its stored height; cards are drawn from these.
    const resizedShapes = changes.filter(change => change.type === 'dimensions' && change.dimensions && (change.resizing !== undefined || change.setAttributes) && ['shape', 'text'].includes(before.find(node => node.id === change.id)?.type));
    if (resizedShapes.length) {
      const sizes = new Map(resizedShapes.map(change => [change.id, change.dimensions])), fit = (value, min) => Math.round(Math.min(4000, Math.max(min, value)));
      next = next.map(node => !sizes.has(node.id) ? node : node.type === 'text' ? { ...node, data: { ...node.data, height: fit(sizes.get(node.id).height, textHeights.min) } }
        : { ...node, data: { ...node.data, width: fit(sizes.get(node.id).width, 40), height: fit(sizes.get(node.id).height, 40) } });
    }
    putNodes(reconcileArrows(before, reconcileStampAttachments(before, applyNodeChanges(changes.filter(change => !groupIds.has(change.id) && !sectionIds.has(change.id) && !resizedShapes.includes(change) && !(change.type === 'position' && moved.has(change.id))), next))));
    if (changes.some(change => change.type === 'remove')) {
      const retained = new Set(nodeRef.current.map(node => node.id));
      effects.remove(before.filter(node => !retained.has(node.id)).map(node => node.id));
      putEdges(current => current.filter(edge => retained.has(edge.source) && retained.has(edge.target)));
      putGroups(pruneGroups(groupRef.current, nodeRef.current));
    }
    const resized = resizedShapes.length > 0 || sectionChanges.some(change => change.type === 'dimensions' && change.resizing !== undefined);
    if (resized || changes.some(change => change.type === 'position' || change.type === 'remove')) markDirty(cloud && changes.every(change => change.type !== 'remove') && changes.some(change => change.dragging || change.resizing));
    if (marquee.current?.ids) boxSelect();
  };

  const nodeDragStopped = (event, node) => {
    effects.dragStop(event, node); moving.current = false; sectionMoves.current.clear();
    if (mcpLocked.current) return;
    if (node.type === 'stamp') {
      const pointer = 'changedTouches' in event ? event.changedTouches[0] : event;
      const point = flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
      putNodes(attachStampAt(nodeRef.current, node.id, point, flow.getNodes())); markDirty();
    }
    if (cloudSession) syncCloud();
  };

  const copyImage = nodeId => {
    const node = nodeRef.current.find(item => item.id === nodeId && item.type === 'image');
    if (!node || mcpLocked.current) return;
    try {
      const copied = copyImageToClipboard(request(`/assets/${node.data.asset}`));
      Promise.resolve(copied).then(() => notify(t('Image copied.'))).catch(error => notify(error.message || t('Could not copy the image.')));
    } catch (error) { notify(error.message || t('Could not copy the image.')); }
  };
  // The open page's selection for copying; a selected section brings what it holds.
  const boardSelection = () => { const scoped = pageGraph(); return selectedGraph(scoped.nodes, scoped.edges, { sections: scoped.sections, groups: scoped.groups, measure: measureView(viewCache.current) }); };
  const copyNodeId = value => {
    const text = Array.isArray(value) ? value.join('\n') : value;
    if (!text || mcpLocked.current) return;
    const fallback = () => {
      const field = document.createElement('textarea');
      field.value = text; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.appendChild(field); field.select();
      const ok = document.execCommand('copy'); field.remove();
      if (!ok) throw new Error(t('Could not copy the ID.'));
    };
    try {
      if (navigator.clipboard?.writeText) Promise.resolve(navigator.clipboard.writeText(text)).then(() => notify(t('ID copied.'))).catch(() => { try { fallback(); notify(t('ID copied.')); } catch { notify(t('Could not copy the ID.')); } });
      else { fallback(); notify(t('ID copied.')); }
    } catch { notify(t('Could not copy the ID.')); }
  };

  useEffect(() => {
    if (!loaded) return;
    const paste = async event => {
      if (mcpLocked.current || modalOpen.current || readOnlyRef.current) return;
      const files = [...event.clipboardData.items].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); addImages(files, flow.screenToFlowPosition(mouse.current)); return; }
      if (event.target.closest('textarea,input,[contenteditable="true"]')) return;
      const selection = readNodeClipboard(event.clipboardData.getData(nodeClipboardType) || event.clipboardData.getData('text/plain'));
      if (selection) {
        event.preventDefault();
        const position = flow.screenToFlowPosition(mouse.current);
        const assets = [...new Set(selection.nodes.filter(node => node.type === 'image').map(node => node.data.asset))];
        uploads.current++; setUploading(true);
        try {
          await Promise.all(assets.map(async asset => {
            const response = await request(`/assets/${asset}`, { method: cloud ? 'GET' : 'HEAD' });
            if (!response.ok) throw new Error(t('A copied image is unavailable in this app installation.'));
            if (cloud) response.body?.cancel().catch(() => {});
          }));
          insertSelection(selection, position);
        } catch (error) { notify(error.message); }
        finally { uploads.current--; setUploading(uploads.current > 0); }
        return;
      }
      const text = event.clipboardData.getData('text/plain');
      if (text.trim()) { event.preventDefault(); addText(flow.screenToFlowPosition(mouse.current), text); }
    };
    const copy = event => {
      if (mcpLocked.current || modalOpen.current || event.target.closest('textarea,input,[contenteditable="true"]')) return;
      const selection = boardSelection();
      if (!selection.nodes.length && !selection.sections) return;
      event.preventDefault();
      if (selection.nodes.length === 1 && !selection.sections && selection.nodes[0].type === 'image') { copyImage(selection.nodes[0].id); return; }
      const text = JSON.stringify(selection);
      event.clipboardData.setData(nodeClipboardType, text);
      event.clipboardData.setData('text/plain', text);
    };
    const key = event => {
      if (mcpLocked.current) return;
      if (event.key === 'Escape') { pendingIntent.current = null; chooseTool('select'); setViewId(null); setBoardForm(null); return; }
      if (modalOpen.current) return;
      if (event.target.closest('.image-node-caption')) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'c' && !event.target.closest('textarea,input,[contenteditable="true"]')) {
        const scoped = pageGraph(), ids = [...scoped.nodes, ...scoped.groups, ...scoped.sections].filter(item => item.selected).map(item => item.id);
        if (ids.length) { event.preventDefault(); copyNodeId(ids); }
        return;
      }
      // Copying and Escape above are all a viewer's shortcuts do.
      if (readOnlyRef.current) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        if (document.activeElement?.matches('.text-node textarea')) document.activeElement.blur();
        insertSelection(boardSelection(), undefined, true); return;
      }
      if (event.target.closest('textarea,input,[contenteditable="true"]')) return;
      const layer = layerShortcut(event);
      if (layer) { event.preventDefault(); arrange(layer); return; }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const key = event.key.toLowerCase(), tool = { v: 'select', p: 'pen', s: 'sticky', e: 'stamp', r: 'shape', o: 'shape', l: 'arrow', x: 'arrow' }[key];
        if (key === 'r' || key === 'o') setShape(current => ({ ...current, kind: key === 'r' ? 'rectangle' : 'ellipse' }));
        if (tool) { event.preventDefault(); chooseTool(tool); return; }
      }
      // FigJam's Shift S: wrap the selection in a section, or pick the Section tool. The physical key also works on layouts such as Ukrainian.
      if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key.toLowerCase() === 's' || event.code === 'KeyS')) {
        event.preventDefault();
        const scoped = pageGraph();
        if ([...scoped.nodes, ...scoped.groups, ...scoped.sections].some(item => item.selected)) wrapInSection(); else chooseTool('section');
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(event.shiftKey); }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); }
      if (event.key.toLowerCase() === 't' && !event.metaKey && !event.ctrlKey) addText(flow.screenToFlowPosition(mouse.current));
    };
    const unload = event => { if (dirty.current || cloudOfflineEdits.current) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('paste', paste); document.addEventListener('copy', copy); document.addEventListener('keydown', key); window.addEventListener('beforeunload', unload);
    return () => { document.removeEventListener('paste', paste); document.removeEventListener('copy', copy); document.removeEventListener('keydown', key); window.removeEventListener('beforeunload', unload); };
  }, [loaded]);

  const run = async (nodeId, resumeIntent = null, event) => {
    if (!alive.current || pairing || mcpLocked.current || readOnlyRef.current) return;
    let requested;
    try { requested = generationIntent(currentGraph(), boardId, nodeId); }
    catch (error) { notify(error.message); return; }
    if (starting || generationStarting.current) return;
    const runNode = nodeRef.current.find(node => node.id === nodeId), nanoRun = cloud && usesNano(runNode?.data);
    if (nanoRun && !(isDescribe(runNode) ? nanoRef.current.selectable : nanoRef.current.ready)) { notify(nanoRef.current.note); cloudSession.refreshNano?.(); return; }
    if (!nanoRun && readinessRef.current.key !== 'ready') {
      pendingIntent.current = requested; fixReadiness();
      return;
    }
    effects.start(nodeId, event);
    generationStarting.current = true;
    setStarting(nodeId);
    try {
      await saveNow();
      if (resumeIntent && !intentUnchanged(resumeIntent, currentGraph(), boardId)) { focusNode(nodeId); notify(t('Prompt changed — review and click Generate')); return; }
      if (nanoRun) { await cloudSession.jobs.startNano(nodeId); cloudSession.refreshNano?.(); return; }
      if (cloudSession) { await cloudSession.jobs.start(nodeId, readinessRef.current.delegate); return; }
      const options = jsonOptions('POST', { nodeId, revision: base.current.revision });
      if (editorId.current) options.headers['X-Concept-Graph-UI-Session'] = editorId.current;
      const result = await api(boardPath + '/runs', options);
      trackOwnRun(result.id);
      setRuns(current => current.some(r => r.id === result.id) ? current : [...current, result]);
    } catch (error) {
      effects.failedStart();
      if (error.value?.graph) mergeRemote(error.value.graph);
      if (nanoRun) cloudSession.refreshNano?.();
      else if (helperNeeded && (error.status === 403 || error instanceof TypeError)) {
        pendingIntent.current = requested;
        if (cloudSession) cloudSession.unpair(); setHelperOffline(true); openHelper();
      }
      notify(error.message);
    }
    finally { generationStarting.current = false; setStarting(null); }
  };
  runAction.current = run;
  // An agent the person connected over MCP generates through this tab, on whatever Codex Generate would use. Nothing opens
  // here: what Generate would ask the person to fix goes back to the agent instead.
  const agentRun = async nodeId => {
    if (!alive.current || readOnlyRef.current) throw new Error('This board is view-only in the open tab.');
    generationIntent(currentGraph(), boardId, nodeId);
    const fix = { helper: 'Connect the Concept Graph helper on the open board first.', install: 'Install Codex from the open board first.', signin: 'Sign in to Codex on the open board first.' }[readinessRef.current.key];
    if (readinessRef.current.key !== 'ready') throw new Error(fix || 'Codex is not ready on this computer. Check its connection on the open board.');
    if (pairing || mcpLocked.current || generationStarting.current) throw new Error('Another generation is starting on the open board. Try again in a moment.');
    effects.start(nodeId);
    generationStarting.current = true; setStarting(nodeId);
    try {
      await saveNow();
      const runId = await cloudSession.jobs.start(nodeId, readinessRef.current.delegate);
      if (runId) notify(t('Your agent started a generation'));
      return runId;
    } catch (error) { effects.failedStart(); throw error; }
    finally { generationStarting.current = false; setStarting(null); }
  };
  const agentRunRef = useRef(agentRun); agentRunRef.current = agentRun;
  const cancel = async runId => { pendingIntent.current = null; try { if (cloudSession) { if (!cloudSession.paired && !cloudSession.jobs.remote(runId)) return cloudSession.openPair(() => cancel(runId)); await cloudSession.jobs.cancel(runId); } else await api(`${boardPath}/runs/${runId}/cancel`, { method: 'POST' }); } catch (error) { notify(error.message); } };
  const connect = connection => {
    if (mcpLocked.current) return;
    const source = slideSource(connection.source);
    if (source !== connection.source) connection = { ...connection, source, sourceHandle: null };
    if (!['text', 'image'].includes(nodeRef.current.find(node => node.id === connection.source)?.type)) return;
    if (nodeRef.current.find(n => n.id === connection.target)?.type !== 'text') { notify(t('Connect inputs to a text prompt. Run creates image connections automatically.')); return; }
    const reachable = new Set();
    const walk = nodeId => { if (reachable.has(nodeId)) return; reachable.add(nodeId); edgeRef.current.filter(e => e.source === nodeId).forEach(e => walk(e.target)); };
    walk(connection.target);
    if (reachable.has(connection.source)) { notify(t('That connection would create a loop. Branch into a new prompt instead.')); return; }
    checkpoint();
    const next = addEdge({ ...connection, id: id() }, edgeRef.current);
    const added = next.filter(edge => !edgeRef.current.some(item => item.id === edge.id));
    effects.createEdges(added.map(edge => edge.id), added.map(edge => edge.target));
    putEdges(next); markDirty();
  };
  const connectEnd = (event, state) => {
    connecting.current = false;
    if (mcpLocked.current) return;
    const pointer = 'changedTouches' in event ? event.changedTouches[0] : event;
    const onPane = pointer && document.elementFromPoint(pointer.clientX, pointer.clientY)?.classList.contains('react-flow__pane');
    const from = state.fromNode && slideSource(state.fromNode.id), fromNode = from === state.fromNode?.id ? state.fromNode : nodeRef.current.find(node => node.id === from);
    if (!edgeDropCreatesPrompt({ ...state, fromNode }, onPane)) return;
    const position = flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
    const node = addText({ x: position.x, y: position.y - 40 });
    const edge = { id: id(), source: fromNode.id, target: node.id }; effects.createEdges([edge.id], [edge.target]);
    putEdges(current => [...current, edge]); setFocusId(node.id); markDirty();
    if (fromNode.type === 'image') guide.report({ type: 'variation' });
  };
  const downloadImage = async asset => {
    try {
      const response = await request(`/assets/${asset}`);
      if (!response.ok) throw new Error(t('Could not download image.'));
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
      link.href = url; link.download = asset;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { notify(error.message); }
  };
  const exportBoard = async () => {
    if (switchingRef.current || uploads.current || starting || !loaded) return;
    switchingRef.current = true; setTransfer('export');
    try {
      await saveNow();
      const response = await request(boardPath + '/export');
      if (!response.ok) throw new Error((await response.json()).error || t('Could not export board.'));
      const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
      link.href = url; link.download = currentBoard.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') + '.conceptgraph';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { notify(error.message); }
    finally { switchingRef.current = false; setTransfer(null); }
  };
  const importBoard = async file => {
    if (!file || switchingRef.current || uploads.current || starting || !loaded) return;
    pendingIntent.current = null;
    switchingRef.current = true; setTransfer('import');
    try {
      if (file.size > 512 * 1024 * 1024) throw new Error(t('Choose a .conceptgraph file no larger than 512 MB.'));
      await saveNow();
      const { board } = await api('/api/boards/import', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
      updateBoards(current => current.some(item => item.id === board.id) ? current : [...current, board]);
      selectBoard(board.id);
    } catch (error) { notify(error.message); }
    finally { switchingRef.current = false; setTransfer(null); }
  };
  const changeBoard = async (nextId, createName) => {
    if (switchingRef.current || uploads.current || starting || (!createName && nextId === boardId)) return;
    pendingIntent.current = null; switchingRef.current = true; setSwitching(true);
    try {
      await saveNow();
      if (createName) {
        const result = await api(cloud ? '/api/cloud/boards' : '/api/boards', jsonOptions('POST', { name: createName }));
        const board = cloud ? result.board : result;
        updateBoards(current => current.some(b => b.id === board.id) ? current : [...current, board]);
        nextId = board.id;
      }
      selectBoard(nextId);
    } catch (error) { notify(error.message); }
    finally { switchingRef.current = false; setSwitching(false); }
  };
  const submitBoard = async event => {
    event.preventDefault();
    if (!nameDraft.trim()) return;
    if (boardForm === 'create') return changeBoard(null, nameDraft.trim());
    try {
      const result = await api(cloud ? `/api/cloud/boards/${boardId}` : boardPath, jsonOptions('PATCH', cloud ? { name: nameDraft.trim() } : { name: nameDraft.trim(), expectedName: originalBoardName.current }));
      const board = cloud ? result.board : result;
      updateBoards(current => current.map(b => b.id === board.id ? { ...b, name: board.name } : b));
      setBoardForm(null);
    } catch (error) { notify(error.message); }
  };
  // Only the owner sees this; the name must be typed exactly, and the server checks it again.
  const deleteBoard = async event => {
    event.preventDefault();
    const name = currentBoard?.name;
    if (!name || deleteName !== name || switchingRef.current || uploads.current || starting) return;
    pendingIntent.current = null; switchingRef.current = true; setSwitching(true);
    try {
      if (!cloud) await saveNow();
      if (cloud) cloudSession.deleting = true;
      const result = await api(cloud ? `/api/cloud/boards/${boardId}` : boardPath, jsonOptions('DELETE', { confirmName: name }));
      setBoardForm(null);
      if (cloud) { cloudSession.deleted?.(); return; }
      updateBoards(result.boards);
      selectBoard(result.defaultBoardId);
      notify(t('Deleted “{name}”', { name }));
    } catch (error) { if (cloud) cloudSession.deleting = false; notify(error.message); }
    finally { switchingRef.current = false; setSwitching(false); }
  };
  const startLogin = async () => {
    if (loginBusy || login) return;
    setLoginBusy(true);
    try { setLogin(await api('/api/desktop/login', { method: 'POST', helper: cloud })); }
    catch (error) { notify(error.message); }
    finally { setLoginBusy(false); }
  };
  const checkCodex = async () => {
    if (cloudSession && !cloudSession.paired) return cloudSession.openPair();
    try {
      const next = await api('/api/status', { method: 'POST', helper: cloud });
      setStatus(next);
      setHelperOffline(false);
      if (desktopMode && !next.connected) notify(t('Codex could not connect. Use Set Up Codex… on Mac or Codex → Set Up Compatible Codex… on Windows to install a compatible copy.'));
    } catch (error) { if (cloudSession && error.status === 403) { cloudSession.unpair(); cloudSession.openPair(); } notify(error.message); }
  };
  const cancelLogin = async () => {
    pendingIntent.current = null;
    if (!login) return;
    setLoginBusy(true);
    try { await api('/api/desktop/login/cancel', { ...jsonOptions('POST', { loginId: login.loginId }), helper: cloud }); setLogin(null); }
    catch (error) { setLogin(null); notify(error.message); }
    finally { setLoginBusy(false); }
  };
  const openHelper = () => cloudSession ? cloudSession.openPair() : helperSession?.openPair();
  const openHelperDownloads = () => cloudSession ? cloudSession.openPair(null, true) : helperSession?.openPair(true);
  const fixReadiness = () => {
    const key = (readinessRef.current.own || readinessRef.current).key;
    if (key === 'helper') openHelper();
    else if (key === 'install') setInstallCodex(true);
    else if (key === 'signin') startLogin();
    else checkCodex();
  };
  const gettingStartedStep = step => {
    if (step === 'helper') return fixReadiness();
    if (step === 'prompt') return addText();
    if (step === 'generate') {
      const nodes = pageGraph().nodes, node = nodes.find(node => node.selected && node.type === 'text') || nodes.find(node => node.type === 'text');
      if (node) focusNode(node.id, 'generate'); else addText();
    }
    if (step === 'variation') {
      const nodes = pageGraph().nodes, image = nodes.find(node => node.selected && node.type === 'image') || [...nodes].reverse().find(node => node.type === 'image');
      if (image) focusNode(image.id, 'variation');
      else { notify(t('Generate an image first, then choose + Prompt from this.')); gettingStartedStep('generate'); }
    }
  };
  const viewCache = useRef(null); viewCache.current ||= createViewCache();
  const shownGroups = useMemo(() => viewerSlides.size ? scoped.groups.map(group => viewerSlides.has(group.id) ? { ...group, slide: viewerSlides.get(group.id) } : group) : scoped.groups, [scoped.groups, viewerSlides]);
  const view = useMemo(() => { viewCache.current.aspects = learnedAspects; return canvasView(scoped.nodes, scoped.edges, shownGroups, viewCache.current, scoped.sections); }, [scoped, shownGroups, learnedAspects]);
  const extent = useMemo(() => boardExtent(scoped, measureView(viewCache.current)), [scoped]);
  // Gestures stop at 0.15 (light cards), but never before the zoom that shows the whole page, as opening the board does.
  const minZoom = useMemo(() => {
    const box = canvasElement.current?.getBoundingClientRect(), [[left, top], [right, bottom]] = boardExtent(scoped, measureView(viewCache.current), 0);
    if (!box?.width || right <= left) return .15;
    const fit = Math.min(box.width / ((right - left) * 1.36), box.height / ((bottom - top) * 1.36));
    return Math.max(fitFloor(), Math.min(.15, fit * .9));
  }, [scoped]);
  // A new connection animates for 300 ms; otherwise the edge list keeps its identity and React Flow skips it.
  const viewEdges = useMemo(() => effects.edges.size ? view.edges.map(edge => effects.edges.has(edge.id) ? { ...edge, type: 'feedback', className: 'feedback-edge' } : edge) : view.edges, [view.edges, effects.edges]);
  const fitNodes = useMemo(() => view.nodes.filter(node => node.selected && !node.hidden), [view.nodes]);
  const viewNode = viewId ? nodes.find(node => node.id === viewId) : undefined;
  const viewRun = runs.find(run => run.id === viewNode?.data.runId);
  const viewInputs = viewRun?.snapshot?.filter(node => node.id !== viewRun.nodeId) || [];
  const viewInfo = viewNode && imageInfo(viewNode, runs, viewSize?.asset === viewNode.data.asset ? viewSize : undefined);
  const { selectedCount, canGroup } = useMemo(() => {
    const selectedNodes = scoped.nodes.filter(n => n.selected), ids = new Set(selectedNodes.map(node => node.id));
    return { selectedCount: selectedNodes.length + scoped.groups.filter(group => group.selected).length + scoped.sections.filter(section => section.selected).length, canGroup: selectedNodes.length >= 2 && !groups.some(group => group.selected || group.nodeIds.some(id => ids.has(id))) };
  }, [scoped, groups]);
  const inputMemo = useRef(null);
  const inputs = useMemo(() => inputMemo.current = inputCounts(nodes, edges, inputMemo.current), [nodes, edges]);
  const lookups = useMemo(() => runLookups(runs), [runs]);
  const runPage = pageResolver(pages), pageNames = new Map(pages.map(page => [page.id, page.name]));
  const crowded = useMemo(() => scoped.nodes.reduce((count, node) => count + (node.type === 'image'), 0) > 600, [scoped.nodes]);
  const edgesChanged = changes => { if (mcpLocked.current) return; putEdges(current => applyEdgeChanges(changes, current)); if (marquee.current?.ids) boxSelect(); if (changes.some(c => c.type !== 'select')) markDirty(); };
  const connectStart = (_, params) => { if (mcpLocked.current) return; connecting.current = true; setConnectionType(nodeRef.current.find(n => n.id === slideSource(params.nodeId))?.type || 'text'); };
  const nodeDragStart = (event, node, dragged = [node]) => {
    if (mcpLocked.current) return;
    nodeDragged.current = true;
    if (shiftGrab.current === node.id) flowStore.getState().addSelectedNodes([node.id]);
    effects.dragStart(event, node); moving.current = true; checkpoint();
    const sectionIds = dragged.filter(item => item.type === 'section').map(item => item.id);
    sectionMoves.current.clear();
    if (sectionIds.length) captureMove(sectionIds);
  };
  const nodeDrag = (event, node) => { if (!mcpLocked.current) effects.dragMove(event, node); };
  const moveStart = event => {
    moving.current = true;
    if (event) viewerMoved.current = true;
    // A canvas gesture keeps ownership when the pointer crosses an editor.
    if (document.activeElement?.matches('.text-node textarea')) document.activeElement.blur();
  };
  // Glides to where a teammate is: their pointer, or the middle of what they see, switching page first if needed.
  const followPeer = peerId => {
    const peer = cloudSession.cursorStore.get().find(item => item.id === peerId), spot = peer?.cursor || peer?.view;
    if (!peer) return;
    if (!Number.isFinite(spot?.x) || !Number.isFinite(spot?.y)) { notify(t('{name} isn’t looking at the board right now.', { name: peer.user.name })); return; }
    showPage(peer.page, false);
    flow.setCenter(spot.x, spot.y, { zoom: flow.getZoom(), duration: 900 });
  };
  useEffect(() => { if (cloudSession?.connection === 'live') shareView(flow.getViewport()); }, [cloudSession?.connection]);
  const shareView = viewport => {
    const box = canvasElement.current?.getBoundingClientRect();
    if (cloudSession && box?.width) cloudSession.view?.({ x: (box.width / 2 - viewport.x) / viewport.zoom, y: (box.height / 2 - viewport.y) / viewport.zoom });
  };
  const moveEnd = (_, next) => {
    shareView(next);
    moving.current = false; if (mcpLocked.current) return;
    if (openingViewDone.current) { pagePreference.current.viewports[activePageRef.current] = next; rememberPage(); }
    // The board's saved viewport remains the first page's fallback.
    if (activePageRef.current === defaultPageId) { viewport.current = next; if (loaded && !cloud) markDirty(); }
  };
  // Cards and React Flow get functions that never change identity and always run the latest code, so an editor render
  // re-renders no card by itself; changing values reach cards through the canvas store below.
  const latest = useRef(null);
  const rename = value => { if (value === null || !readOnlyRef.current) setRenaming(value); };
  latest.current = { renameGroup: rename, renameSection: rename, editGroup, editSection, unwrapSection, wrapInSection, sectionResizeStart, sectionResizeEnd, editAnnotation, removeNode: nodeId => removeNodes([nodeId]), fixReadiness, promptFrom, describeImage: imageId => addDescribe([imageId]), openRunDetails, checkpoint, cancelCaption, copyImage, copyNodeId, arrange, saveTemplateFromNode, switchTemplate, setGenerator, clearFocus: () => setFocusId(null), followPeer, setVariants, setPromptHeight, setArrowEnd, learnAspect: (asset, aspect) => setLearnedAspects(current => Math.abs((current.get(asset) || 0) - aspect) < .005 ? current : new Map(current).set(asset, aspect)), toggleNodeCollapsed, toggleGroup, ungroup, toggleSlideshow, showSlide,
    editText: (nodeId, text) => { if (mcpLocked.current) return; putNodesSoon(current => current.map(node => node.id === nodeId ? { ...node, data: { ...node.data, text } } : node)); markDirty(); },
    editCaption: (nodeId, caption) => { if (mcpLocked.current) return; putNodesSoon(current => current.map(node => node.id === nodeId ? { ...node, data: { ...node.data, caption } } : node)); markDirty(); },
    run, cancel, showRun, view: setViewId, viewTemplate: setTemplateDetails, fire: (...args) => effects.fire(...args), outputReady: nodeId => effects.outputReady(nodeId), outputFailed: nodeId => effects.outputFailed(nodeId),
    nodesChanged, edgesChanged, connect, connectStart, connectEnd, nodeDragStart, nodeDrag, nodeDragStopped, moveStart, moveEnd, paneClick: () => setViewId(null),
    marqueeDown, shiftTextClick, nodeClick, marqueeEnd: () => { marquee.current = null; } };
  const canvasState = { latestRun: lookups.latestRun, runById: lookups.runById, now, starting, focusId, focusControl, highlight, renaming, readinessKey: readiness.key, readinessAction: readiness.action,
    nanoSelectable: nano.selectable, nanoReady: nano.ready, nanoNote: nano.note, nanoBudget: nano.budget, userName: cloudSession?.user?.name, inputs: inputs.counts, templates, readOnly, effectNodes: effects.nodes, pending: effects.pending, pendingIds: [...effects.pending.keys()].join(' '), crowded };
  const [canvasStore] = useState(() => createCanvasStore({ detail: 'full', ...canvasState }));
  const [canvas] = useState(() => ({ ...latestCommands(latest), store: canvasStore, dictationLanguage }));
  useLayoutEffect(() => { canvasStore.update(canvasState); });
  const flowStore = useStoreApi();
  // Zoom reaches the canvas as a CSS variable (group titles) and a detail bucket (card variants), without rendering anything.
  // The canvas element can mount after the first viewport, so it is also brought up to date when it appears.
  const showZoom = element => { if (!element) return; element.style.setProperty('--zoom', flowStore.getState().transform[2]); element.dataset.detail = canvasStore.get().detail; };
  const canvasRef = useCallback(element => { canvasElement.current = element; showZoom(element); }, []);
  useLayoutEffect(() => {
    let zoom;
    const follow = ({ transform: [, , next] }) => {
      if (next === zoom) return;
      zoom = next;
      canvasStore.update({ detail: detailLevel(next, canvasStore.get().detail) });
      showZoom(canvasElement.current);
    };
    follow(flowStore.getState());
    return flowStore.subscribe(follow);
  }, []);
  // While the selection box is out, the board selects what it touches (see marqueeDown).
  useLayoutEffect(() => flowStore.subscribe(({ userSelectionActive, userSelectionRect: box, transform: [x, y, zoom], nodeLookup }, previous) => {
    if (!userSelectionActive || !box || box === previous.userSelectionRect || !marquee.current || mcpLocked.current) return;
    const area = { x: (box.x - x) / zoom, y: (box.y - y) / zoom, width: box.width / zoom, height: box.height / zoom };
    marquee.current.ids = boxSelection(boxTouches(nodeLookup.values(), area, { x: box.startX, y: box.startY }), marquee.current.base);
    boxSelect();
  }), []);
  // An output that lands off screen, inside a folded group or on a far zoomed-out crowded board is never drawn,
  // so its arrival cannot wait for the image to decode.
  useEffect(() => {
    if (!effects.pending.size) return;
    const viewport = flow.getViewport(), { width, height } = flowStore.getState(), far = crowded && canvasStore.get().detail === 'tiny';
    for (const node of view.nodes) if (effects.pending.has(node.id) && (far || node.hidden || outsideViewport(node, viewport, width, height))) effects.outputReady(node.id);
  });
  const connectionLineStyle = useMemo(() => ({ stroke: connectionColor(connectionType), strokeWidth: 2 }), [connectionType]);

  const blockWhenLocked = event => { if (mcpLocked.current) { event.preventDefault(); event.stopPropagation(); } };
  return <CanvasContext.Provider value={canvas}><div className="app-shell" data-cloud={cloud || undefined} data-view-only={readOnly || undefined} data-theme={theme} inert={mcpBusy || pairing ? true : undefined} aria-busy={mcpBusy} onKeyDownCapture={blockWhenLocked} onClickCapture={blockWhenLocked} onDropCapture={blockWhenLocked} onInputCapture={blockWhenLocked} onBeforeInputCapture={blockWhenLocked} onPointerDownCapture={blockWhenLocked} onWheelCapture={blockWhenLocked} onPasteCapture={blockWhenLocked}>
    <header className="app-header">{cloud ? <><button type="button" className="brand brand-home" data-tooltip={t('All boards')} aria-label={t('Concept Graph: all boards')} onClick={() => cloudSession.home()}><img src="/favicon.svg" alt=""/><strong>Concept Graph</strong></button><button type="button" className="header-boards" onClick={() => cloudSession.home()}><Icon name="boards" size={15}/>{t('Boards')}</button></> : <div className="brand"><img src="/favicon.svg" alt=""/><strong>Concept Graph</strong></div>}<div className="save-state"><span className={(cloud ? cloudSession.connection === 'live' : saved === 'All changes saved') ? 'saved-dot' : 'saving-dot'}/>{cloud ? cloudSession.connection === 'live' ? t('Live') : cloudSession.connection === 'offline' ? t('Offline · edits kept in this tab') : t('Connecting…') : transfer === 'export' ? t('Exporting board…') : transfer === 'import' ? t('Importing board…') : switching ? t('Switching board…') : t(saved)}{readOnly && <span className="view-only-badge">{t('View only')}</span>}</div><div className="header-right">{cloudSession?.toolbar}{(desktopMode || cloud) && <button className="mcp-connect-button" type="button" aria-label={t('Connect MCP')} onClick={() => setAgentConnect(true)} data-tooltip={t('Connect MCP')}><Icon name="branch" size={15}/><span>{t('Connect MCP')}</span></button>}{(!cloud || cloudSession.paired) && <UsageLimit status={status} version={limitsVersion}/>}<button className="theme-button" type="button" aria-label={effects.sounds ? t('Sounds on') : t('Sounds off')} aria-pressed={effects.sounds} data-tooltip={effects.sounds ? t('Sounds on') : t('Sounds off')} onClick={effects.toggleSounds}><Icon name={effects.sounds ? 'sound' : 'muted'}/></button><LanguageSelect beforeSwitch={() => cloud ? syncCloud() : saveNow()}/><button className="getting-started-help" type="button" aria-label={t('Getting started')} data-tooltip={t('Getting started and canvas tips')} onClick={guide.reopen}>?</button><button className="theme-button" aria-label={theme === 'dark' ? t('Switch to light theme') : t('Switch to dark theme')} data-tooltip={theme === 'dark' ? t('Switch to light theme') : t('Switch to dark theme')} onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18}/></button>{helperNeeded ? <HelperConnection effects={effects} readiness={readiness} status={status} paired={!helperOffline && (cloud ? cloudSession.paired : !!helperSession?.paired)} onSetup={openHelper} onDownloads={openHelperDownloads} onFix={fixReadiness} onDisconnect={cloudSession ? () => cloudSession.unpair(false) : null} loginBusy={loginBusy}/> : <button className={`connection ${status.connected && status.signedIn && status.imageGeneration ? 'connected' : ''}`} disabled={loginBusy} onClick={desktopMode && status.connected && !status.signedIn ? startLogin : checkCodex} data-tooltip={status.error || t('Check Codex connection')}><span/>{status.connected && status.signedIn && status.imageGeneration ? t('Codex connected') : desktopMode && status.connected && !status.signedIn ? t('Sign in with ChatGPT') : cloud && !cloudSession.paired ? t('Pair helper') : t('Check Codex')}</button>}{cloudSession?.account}</div></header>
    <aside className="sidebar" inert={!!transfer || switching ? true : undefined}>
      <div className="board-heading"><span className="eyebrow">{t('YOUR BOARDS')}</span><div className="board-picker"><select data-tooltip={t('Switch board')} aria-label={t('Board')} value={boardId} disabled={switching || !!transfer || uploading || !!starting || !loaded} onChange={event => changeBoard(event.target.value)}>{boards.map(board => <option key={board.id} value={board.id}>{board.name}</option>)}</select>{canRename && <button data-tooltip={t('Rename board')} aria-label={t('Rename board')} className="icon-button" disabled={switching || !!transfer || !loaded} onClick={() => { originalBoardName.current = currentBoard?.name || ''; setNameDraft(originalBoardName.current); setBoardForm('rename'); }}><Icon name="edit" size={15}/></button>}{canRename && <button data-tooltip={t('Delete board')} aria-label={t('Delete board')} className="icon-button board-delete" disabled={switching || !!transfer || uploading || !!starting || !loaded} onClick={() => { setDeleteName(''); setBoardForm('delete'); }}><Icon name="trash" size={15}/></button>}</div><button className="new-board" data-tooltip={t('Create a new board')} disabled={switching || !!transfer || uploading || !!starting || !loaded} onClick={() => { setNameDraft(''); setBoardForm('create'); }}><Icon name="plus" size={15}/> {t('New board')}</button>{!cloud && <div className="board-transfer"><button data-tooltip={t('Save this board with its images')} aria-label={t('Export board')} disabled={switching || !!transfer || uploading || !!starting || !loaded} onClick={exportBoard}><Icon name="download" size={14}/> {t('Export')}</button><button data-tooltip={t('Import a .conceptgraph file as a new board')} aria-label={t('Import board')} disabled={switching || !!transfer || uploading || !!starting || !loaded} onClick={() => boardFileInput.current.click()}><Icon name="upload" size={14}/> {t('Import')}</button></div>}</div>
      <BoardPages pages={pages} active={activePage} peers={cloudSession?.peers || []} readOnly={readOnly} disabled={!loaded || switching || !!transfer || mcpBusy} onSelect={pageId => showPage(pageId)} onAdd={addPage} onRename={renamePage} onDelete={requestPageDelete}/>
      <div className="sidebar-tabs"><button data-tooltip={t('Show creation tools')} className={tab === 'canvas' ? 'active' : ''} onClick={() => setTab('canvas')}>{t('Create')}</button><button data-tooltip={t('View generation history')} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>{t('History')} <small>{runs.length}</small></button></div>
      {tab === 'canvas' ? <>{!readOnly && <div className="tool-list"><button disabled={!loaded || switching || !!transfer} data-tooltip={t('Add text prompt · T')} aria-label={t('Add text prompt')} className="add-prompt-tool" {...toolDrag({ kind: 'text' })} onClick={() => addText()}><span className="tool-icon text"><Icon name="text"/></span><span>{t('+ Add text prompt')}</span><kbd>T</kbd></button><button disabled={!loaded || switching || !!transfer} data-tooltip={t('Upload reference images')} aria-label={t('Add reference image')} {...toolDrag({ kind: 'image' })} onClick={() => { imageDrop.current = null; fileInput.current.click(); }}><span className="tool-icon image"><Icon name="image"/></span><span>{t('Reference image')}</span></button><button disabled={!loaded || switching || !!transfer} data-tooltip={t('Describe connected or selected images as text')} aria-label={t('Add describe image node')} {...toolDrag({ kind: 'describe' })} onClick={() => addDescribe()}><span className="tool-icon describe"><Icon name="describe"/></span><span>{t('Describe image')}</span></button></div>}<section className="custom-nodes" aria-label={t('Custom nodes')}><div className="custom-nodes-heading"><span className="eyebrow">{t('CUSTOM NODES')}</span>{!readOnly && <button type="button" className="icon-button" aria-label={t('Create custom node')} data-tooltip={t('Create custom node')} disabled={!loaded || switching || !!transfer} onClick={() => setTemplateForm({ template: null })}><Icon name="plus" size={15}/></button>}</div>{templatesError ? <button className="custom-retry" type="button" onClick={refreshTemplates}>{templatesError} {t('Retry')}</button> : templates.length ? <div className="custom-nodes-list">{templates.map(template => <div className="custom-node-row" key={template.id}><button className="custom-node-add" type="button" {...(readOnly ? {} : toolDrag({ kind: 'template', id: template.id }))} onClick={() => readOnly ? setTemplateDetails(template) : addText(undefined, '', template)} data-tooltip={readOnly ? t('View this custom node') : t('Add custom node to board')}><span className="custom-node-glyph"><Icon name="text" size={14}/></span><span>{template.name}</span></button>{!readOnly && <button className="icon-button custom-node-edit" type="button" aria-label={t('Edit {name}', { name: template.name })} data-tooltip={t('Edit custom node')} onClick={() => setTemplateForm({ template })}><Icon name="edit" size={13}/></button>}</div>)}</div> : <p className="custom-nodes-empty">{readOnly ? t('This board has no custom nodes.') : t('Save instructions and images to use again.')}</p>}</section>{readOnly ? <p className="paste-hint">{t('You can view this board. Ask its owner for edit access to change it.')}</p> : <p className="paste-hint"><kbd>⌘ V</kbd> {t('Paste text or an image.')}<br/>{t('Drag a node’s output into empty space to add a prompt.')}<br/>{t('Select nodes, then group them with the bottom toolbar.')}</p>}</> : <div className="history-list">{!runs.length && <p className="empty-history">{t('Generations on this board will appear here.')}</p>}{[...runs].reverse().map(run => <HistoryItem key={run.id} run={run} now={busy(run) ? now : 0} page={pages.length > 1 ? pageNames.get(runPage(run.page)) : ''} canCancel={!readOnly && (!cloud || run.by?.name === cloudSession.user.name)} canvas={canvas}/>)}</div>}
      <div className="sidebar-bottom"><span className="legend-text"/> {t('Text')} <span className="legend-image"/> {t('Image')}</div>
    </aside>
    <main ref={canvasRef} data-board-tool={tool} onClickCapture={annotationClick} onDoubleClickCapture={annotationClick} onTouchStartCapture={event => { if (toolRef.current !== 'select' && event.target.closest('.react-flow')) event.stopPropagation(); }} onPointerDownCapture={annotationDown} onPointerMoveCapture={annotationMove} onPointerUpCapture={event => annotationUp(event)} onPointerCancelCapture={event => annotationUp(event, true)} onLostPointerCapture={event => annotationUp(event, true)} className={`canvas${fileOver ? ' file-drag-over' : ''}`} inert={switching || !!transfer || !loaded ? true : undefined} onPointerMove={event => { mouse.current = { x: event.clientX, y: event.clientY }; cloudSession?.pointer(flow.screenToFlowPosition(mouse.current)); }} onPointerLeave={() => cloudSession?.pointer(null)} onDragOver={event => { event.preventDefault(); if (mcpLocked.current || readOnly) return; const types = [...event.dataTransfer.types]; if (types.includes(toolType)) event.dataTransfer.dropEffect = 'copy'; else if (types.includes('Files')) { event.dataTransfer.dropEffect = 'copy'; setFileOver(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFileOver(false); }} onDrop={event => { event.preventDefault(); setFileOver(false); if (mcpLocked.current || readOnly) return; const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }); if ([...event.dataTransfer.types].includes(toolType)) dropTool(event.dataTransfer.getData(toolType), position); else addImages([...event.dataTransfer.files], position); }}>
      <div className="canvas-top"><span>{currentBoard?.name}</span>{loaded && <GenerationTray launching={!!starting} runs={runs} user={cloudSession?.user} onCancel={cancel} onFocus={showRun}/>}</div>
      <ReactFlow nodes={view.nodes} edges={viewEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onlyRenderVisibleElements elevateNodesOnSelect={false} onNodesChange={canvas.nodesChanged} onEdgesChange={canvas.edgesChanged} onConnect={canvas.connect} onConnectStart={canvas.connectStart} onConnectEnd={canvas.connectEnd} connectionLineStyle={connectionLineStyle} onNodeDragStart={canvas.nodeDragStart} onNodeDrag={canvas.nodeDrag} onNodeDragStop={canvas.nodeDragStopped} onMoveStart={canvas.moveStart} onMoveEnd={canvas.moveEnd} onPaneClick={canvas.paneClick} zoomOnDoubleClick={tool === 'select'} nodesDraggable={tool === 'select' && !readOnly} nodesConnectable={tool === 'select' && !readOnly} elementsSelectable={tool === 'select'} defaultEdgeOptions={defaultEdgeOptions} translateExtent={extent} minZoom={minZoom} maxZoom={2} deleteKeyCode={null} panOnScroll selectionOnDrag={tool === 'select'} selectionMode={SelectionMode.Partial} panOnDrag={panButtons} selectionKeyCode={null} multiSelectionKeyCode={multiSelectKeys} onNodeClick={canvas.nodeClick} onPointerDownCapture={canvas.marqueeDown} onClickCapture={canvas.shiftTextClick} onPointerUp={canvas.marqueeEnd} onPointerCancel={canvas.marqueeEnd} proOptions={proOptions}>
        <Background color="var(--grid)" gap={24} size={1}/><SectionTitles sections={view.sections}/>{cloudSession?.cursors(peer => resolvePage(pages, peer.page) === activePage)}<StrokePreview ref={strokePreview}/><SectionPreview ref={sectionPreview}/>
      </ReactFlow>
      {loaded && !scoped.nodes.length && !scoped.sections.length && tool === 'select' && <div className="empty-board"><div className="empty-glyph"><Icon name="branch" size={36}/></div><span className="eyebrow">{t('ONE IDEA. MANY DIRECTIONS.')}</span>{readOnly ? <><h2>{t('This page is empty')}</h2><p>{t('You can view this board but not change it.')}</p></> : <><h2>{t('What are you imagining?')}</h2><p>{t('Describe an image, then click Generate.')}</p><button className="primary-button" onClick={() => addText()}><Icon name="plus" size={16}/> {t('Add text prompt')}</button></>}</div>}
      {readOnly && <div className="view-only-banner" role="status"><Icon name="eye" size={15}/><span><strong>{t('View only.')}</strong> {t('You can look around, but you can’t edit or generate on this board. Ask its owner for edit access.')}</span></div>}
      {tool === 'stamp' && <StampCursor emoji={stamps[stamp]} area={canvasElement} start={mouse.current}/>}
      {!readOnly && <GettingStarted effects={effects} guide={guide} helperNeeded={helperNeeded} ready={readiness.key === 'ready'} onStep={gettingStartedStep} onDownloadHelper={openHelperDownloads} disabled={!loaded || switching || !!transfer}/>}
      <div className="canvas-bottom"><span className="canvas-stats">{plural(scoped.nodes.length, '{count} node', '{count} nodes')} <i/> {plural(scoped.edges.length, '{count} connection', '{count} connections')}</span>
        {!readOnly && <div className="board-toolbar" role="toolbar" aria-label={t('Board tools')}><AnnotationTools tool={tool} onTool={chooseTool} pen={pen} setPen={setPen} stickyColor={stickyColor} setStickyColor={setStickyColor} stamp={stamp} setStamp={setStamp} shape={shape} setShape={setShape} arrowColor={arrowColor} setArrowColor={setArrowColor}/><i className="toolbar-divider"/>
          <div className="toolbar-group"><button className="tool-button" data-tooltip={t('Undo · ⌘ Z')} aria-label={t('Undo')} onClick={() => undo()}><Icon name="undo" size={19}/></button><button className="tool-button" data-tooltip={t('Redo · ⌘ Shift Z')} aria-label={t('Redo')} onClick={() => undo(true)}><Icon name="redo" size={19}/></button>
            <button className="tool-button" data-tooltip={canAlign ? t('Align selected nodes left to right') : t('Select nodes to align them')} aria-label={t('Auto-align selected nodes')} disabled={!canAlign} onClick={autoAlign}><Icon name="align" size={20}/></button><button className="tool-button" data-tooltip={canGroup ? t('Group selected nodes') : t('Select 2+ ungrouped nodes')} aria-label={t('Group selected nodes')} disabled={!canGroup} onClick={groupSelected}><Icon name="group" size={20}/></button>{selectedCount > 0 && <button className="tool-button" data-tooltip={t('Delete selected')} aria-label={t('Delete selected')} onClick={removeSelected}><Icon name="trash" size={18}/></button>}</div></div>}
        <div className="zoom-controls" role="group" aria-label={t('Zoom')}><button data-tooltip={t('Zoom out')} aria-label={t('Zoom out')} onClick={() => flow.zoomOut({ duration: 150 })}><Icon name="minus" size={18}/></button><i/><button data-tooltip={fitNodes.length ? t('Fit selected nodes in view') : t('Fit all nodes in view')} aria-label={t('Fit canvas')} onClick={() => flow.fitView({ nodes: fitNodes.length ? fitNodes : undefined, duration: 300, padding: .2, maxZoom: 1 })}><Icon name="expand" size={17}/></button><i/><button data-tooltip={t('Zoom in')} aria-label={t('Zoom in')} onClick={() => flow.zoomIn({ duration: 150 })}><Icon name="plus" size={18}/></button></div></div>
    </main><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { addImages([...event.target.files], imageDrop.current || undefined); imageDrop.current = null; event.target.value = ''; }}/>
    {!cloud && <input ref={boardFileInput} type="file" accept=".conceptgraph,.zip" aria-label={t('Board archive file')} hidden onChange={event => { const file = event.target.files[0]; event.target.value = ''; importBoard(file); }}/>}
    {boardForm === 'delete' && <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="board-delete-title"><form onSubmit={deleteBoard}><h2 id="board-delete-title">{t('Delete “{name}”?', { name: currentBoard?.name ?? '' })}</h2>
      <p className="board-delete-warning">{cloud ? t('The board, its pages and its history are removed for everyone who has access. This can’t be undone.') : t('The board, its pages and its history are removed from this computer. This can’t be undone; export it first to keep a copy.')}</p>
      <label htmlFor="board-delete-name">{t('Type the board name to confirm')}</label><input id="board-delete-name" autoFocus autoComplete="off" maxLength={80} value={deleteName} onChange={event => setDeleteName(event.target.value)} placeholder={currentBoard?.name} disabled={switching}/>
      <div><button type="button" onClick={() => setBoardForm(null)} disabled={switching}>{t('Cancel')}</button><button className="danger-button" type="submit" disabled={switching || deleteName !== currentBoard?.name}>{switching ? t('Deleting…') : t('Delete board')}</button></div></form></div>}
    {boardForm && boardForm !== 'delete' && <div className="board-modal" role="dialog" aria-modal="true" aria-label={boardForm === 'create' ? t('Create board') : t('Rename board')}><form onSubmit={submitBoard}><h2>{boardForm === 'create' ? t('New board') : t('Rename board')}</h2><label htmlFor="board-name">{t('Board name')}</label><input id="board-name" aria-label={t('Board name')} autoFocus maxLength={80} value={nameDraft} onChange={event => setNameDraft(event.target.value)} placeholder={t('A new direction')} disabled={switching}/><div><button data-tooltip={t('Cancel')} type="button" onClick={() => setBoardForm(null)} disabled={switching}>{t('Cancel')}</button><button className="primary-button" data-tooltip={boardForm === 'create' ? t('Create board') : t('Save board name')} type="submit" disabled={switching || !nameDraft.trim()}>{boardForm === 'create' ? t('Create board') : t('Save name')}</button></div></form></div>}
    {pageDelete && <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="page-delete-title" onKeyDown={event => { keepDialogFocus(event); if (event.key === 'Escape') { event.stopPropagation(); setPageDelete(null); restoreDialogFocus(pageDelete.returnFocus); } }}><div className="login-card page-delete-card"><h2 id="page-delete-title">{t('Delete “{name}”?', { name: pageDelete.name })}</h2><p>{pageDelete.count ? plural(pageDelete.count, 'Its {count} node will be deleted with it.', 'Its {count} nodes will be deleted with it.') : t('This page is empty.')} {t('Generation history and image files stay. You can undo this.')}</p><button className="primary-button danger" type="button" autoFocus onClick={() => { const { id: pageId } = pageDelete; setPageDelete(null); deletePage(pageId); }}>{t('Delete page')}</button><button type="button" onClick={() => { setPageDelete(null); restoreDialogFocus(pageDelete.returnFocus); }}>{t('Cancel')}</button></div></div>}
    {diagnosticsId && runs.find(run => run.id === diagnosticsId) && <RunDiagnostics run={runs.find(run => run.id === diagnosticsId)} loadRun={loadDiagnosticRun} returnFocus={diagnosticsReturnFocus} onClose={() => setDiagnosticsId(null)}/>}
    {templateForm && <TemplateEditor templates={templates} template={templateForm.template} initial={templateForm.initial || templateForm.template} onClose={() => setTemplateForm(null)} onSave={saveTemplate} onDelete={deleteTemplate} onBusyChange={setTemplateBusy}/>}
    {templateDetails && <TemplateDetails template={templateDetails} library={templates.includes(templateDetails)} onClose={() => setTemplateDetails(null)}/>}
    {agentConnect && <AgentConnect cloud={cloud} onClose={() => setAgentConnect(false)}/>}
    {installCodex && <InstallCodex onClose={() => setInstallCodex(false)} onDone={async () => {
      const next = await api('/api/status', { method: 'POST', helper: cloud });
      setStatus(next); setHelperOffline(false);
      if (!next.connected) throw new Error(next.error || t('Codex could not connect after installation.'));
      setInstallCodex(false);
      if (!next.signedIn) await startLogin();
    }}/>}
    {showSignIn && <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="codex-welcome-title"><div className="login-card"><h2 id="codex-welcome-title">{t('Connect your ChatGPT account')}</h2><p>{t('Sign in to generate images with your Codex account. Your boards and images stay on this computer.')}</p><button className="primary-button" type="button" disabled={loginBusy} onClick={startLogin}>{t('Sign in with ChatGPT')}</button><button type="button" disabled={loginBusy} onClick={() => setDismissSignIn(true)}>{t('Not now')}</button></div></div>}
    {login && <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="codex-login-title"><div className="login-card"><h2 id="codex-login-title">{t('Sign in with ChatGPT')}</h2><p>{t('Continue in your browser to connect your account. Return here when you finish.')}</p><a className="primary-button" href={login.authUrl} target="_blank" rel="noreferrer" referrerPolicy="no-referrer">{t('Continue in browser')}</a><button type="button" disabled={loginBusy} onClick={cancelLogin}>{t('Cancel')}</button></div></div>}
    {toast && <div className="toast" role="status">{t(toast)}<button aria-label={t('Dismiss notification')} onClick={() => setToast('')}><Icon name="close" size={14}/></button></div>}
    {viewNode && <div className="lightbox" role="dialog" aria-modal="true" aria-label={t('Image details')} onClick={() => setViewId(null)}><div className="lightbox-card" onClick={event => event.stopPropagation()}>
      <button className="lightbox-close icon-button" autoFocus aria-label={t('Close image')} onClick={() => setViewId(null)}><Icon name="close"/></button>
      <div className="lightbox-image"><img src={assetUrl(viewNode.data.asset)} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt={viewNode.data.caption || viewNode.data.label || t('Concept image')} onLoad={event => setViewSize({ asset: viewNode.data.asset, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}/></div>
      <div className="lightbox-details"><span className="eyebrow">{viewInfo.kind === 'generated' ? t('GENERATED CONCEPT') : t('UPLOADED REFERENCE')}</span>
        {viewInfo.author && <div className="image-info-author"><span className="detail-label">{viewInfo.kind === 'generated' ? t('Generated by') : t('Added by')}</span><AuthorBadge author={viewInfo.author}/></div>}
        {viewInfo.caption && <h3 className="image-info-title">{viewInfo.caption}</h3>}
        {viewInfo.rows.length > 0 && <dl className="image-info">{viewInfo.rows.map(row => <div key={row.key}><dt>{row.label}</dt><dd>{row.value}{row.note && <small>{row.note}</small>}</dd></div>)}</dl>}
        {viewRun && <>{viewInfo.prompt && <><span className="detail-label">{cloud ? t('Prompt') : t('Original prompt')}</span><p className="prompt-snapshot">{viewInfo.prompt}</p></>}
          {!cloud && <><span className="detail-label">{t('Inputs at the time of this run')}</span>
          <div className="run-inputs">{viewInputs.length ? viewInputs.map((node, index) => node.type === 'image'
            ? <img key={node.id} src={assetUrl(node.data.asset)} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt={t('Input image {number}', { number: index + 1 })} loading="lazy"/>
            : <p key={node.id}>{node.data.text}</p>) : <p>{t('No connected inputs')}</p>}</div></>}
          {viewRun.snapshot?.filter(node => node.type === 'text' && node.data.template).map(node => <div className="run-template" key={node.id}>
            <span className="detail-label">{t('Custom node: {name}', { name: node.data.template.name })}</span>
            {node.data.template.instructions && <p>{node.data.template.instructions}</p>}
            {node.data.template.assets?.length > 0 && <div className="run-inputs">{node.data.template.assets.map((asset, index) => <img key={`${asset}-${index}`} src={assetUrl(asset)} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt={t('{name} reference {number}', { name: node.data.template.name, number: index + 1 })} loading="lazy"/>)}</div>}
          </div>)}</>}
        <div className="lightbox-actions"><button data-tooltip={t('Download original image')} onClick={() => downloadImage(viewNode.data.asset)}><Icon name="download" size={17}/> {t('Download original')}</button></div>
      </div>
    </div></div>}
  </div>{mcpBusy && <div className="toast" role="status">{t('Synchronizing the board with the agent…')}</div>}<ButtonHelp/></CanvasContext.Provider>;
}

const helperBuilds = [
  { id: 'macos-arm64', label: 'Mac with Apple silicon', detail: 'M1, M2, M3, M4 and later', family: 'macos' },
  { id: 'macos-x64', label: 'Mac with Intel', detail: 'Intel processor · preview', family: 'macos' },
  { id: 'windows-x64', label: 'Windows x64', detail: '64-bit Intel or AMD · preview', family: 'windows' },
];
const formatHelperSize = bytes => Number.isSafeInteger(bytes) && bytes > 0 ? t('{size} MB', { size: (bytes / 1_000_000).toFixed(1) }) : null;

function useHelperDownloads(cloudMode) {
  const [detection, setDetection] = useState(null), [manifest, setManifest] = useState(null), [manifestError, setManifestError] = useState(false);
  useEffect(() => {
    let active = true;
    detectPlatform(navigator).then(result => {
      if (!active) return;
      setDetection(result);
    }).catch(() => { if (active) setDetection({ platform: 'unknown', architecture: 'unknown', packageId: null }); });
    fetch(cloudMode ? '/concept-graph-helper-downloads.json' : '/concept-graph-helper-manifest.json', { cache: 'no-store' }).then(response => {
      if (!response.ok) throw new Error('Manifest unavailable');
      return response.json();
    }).then(value => { if (active) setManifest(value); }).catch(() => { if (active) setManifestError(true); });
    return () => { active = false; };
  }, [cloudMode]);
  return { detection, manifest, manifestError };
}

function InstallCodex({ onClose, onDone }) {
  const [progress, setProgress] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const callbacks = useRef({ onDone }), finishing = useRef(false), submitting = useRef(false), mounted = useRef(true);
  callbacks.current = { onDone };
  useEffect(() => {
    const previous = document.activeElement;
    mounted.current = true;
    let active = true, timer;
    const refresh = async () => {
      try {
        const next = await api('/api/codex/install', { helper: cloud });
        if (!active) return;
        setProgress(next);
        if (next.state === 'done' && !finishing.current) {
          finishing.current = true;
          await callbacks.current.onDone();
          return;
        }
      } catch (failure) { if (active) { setError(failure.message); finishing.current = false; } }
      if (active) timer = setTimeout(refresh, 750);
    };
    refresh();
    return () => { active = false; mounted.current = false; clearTimeout(timer); restoreDialogFocus(previous); };
  }, []);
  const install = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const next = await api('/api/codex/install', { method: 'POST', helper: cloud });
      if (mounted.current) setProgress(next);
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { submitting.current = false; if (mounted.current) setBusy(false); }
  };
  const working = busy || ['downloading', 'installing', 'done'].includes(progress?.state);
  const percent = progress?.total ? Math.min(100, Math.floor(progress.received / progress.total * 100)) : null;
  return <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="codex-install-title" onKeyDown={event => { keepDialogFocus(event); event.stopPropagation(); if (event.key === 'Escape') onClose(); }}>
    <div className="login-card codex-install-card"><h2 id="codex-install-title">{t('Install Codex')}</h2>
      <p>{t('Codex isn’t installed on this computer. Concept Graph can download and install it for you from OpenAI’s official GitHub release (up to 155 MiB). Then you just sign in with ChatGPT.')}</p>
      {working && <div className="codex-install-progress" role="status"><p>{progress?.state === 'installing' ? t('Installing…') : progress?.state === 'done' ? t('Connecting to Codex…') : `${t('Downloading…')}${percent === null ? '' : ` ${percent}%`}`}</p><progress aria-label={t('Codex installation')} max="100" value={progress?.state === 'downloading' ? percent ?? undefined : undefined}/></div>}
      {(error || progress?.error) && <p className="codex-install-error" role="alert">{error || progress.error}</p>}
      <button className="primary-button" type="button" autoFocus disabled={!progress?.supported || working} onClick={install}>{progress?.state === 'error' ? t('Retry') : t('Install')}</button>
      <button type="button" onClick={onClose}>{working ? t('Back to board') : t('Not now')}</button>
    </div>
  </div>;
}

function HelperConnection({ effects, readiness, status, paired, onSetup, onDownloads, onFix, onDisconnect, loginBusy }) {
  const { detection, manifest, manifestError } = useHelperDownloads(cloud);
  const [open, setOpen] = useState(false), container = useRef(null), trigger = useRef(null), panel = useRef(null);
  const download = cloud ? cloudHelperDownload(detection?.packageId, manifest?.[detection?.packageId]) : null;
  const outdated = paired && helperOutdated(status.helperVersion, download);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open || !paired) return;
    panel.current?.focus();
    const outside = event => { if (!container.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, paired]);
  useEffect(() => { if (!paired) setOpen(false); }, [paired]);
  const wasPaired = useRef(paired), [connected, setConnected] = useState(false);
  useEffect(() => {
    const changed = paired && !wasPaired.current; wasPaired.current = paired;
    if (!changed) return;
    effects.fire('helper', { element: trigger.current }); setConnected(true);
    const timer = setTimeout(() => setConnected(false), 650); return () => clearTimeout(timer);
  }, [paired]);
  return <div className="helper-connection" ref={container} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    event.stopPropagation();
  }}>
    <button ref={trigger} className={`connection ${readiness.key === 'ready' ? 'connected' : ''} ${outdated ? 'helper-update' : ''}`} type="button" aria-expanded={open && paired} aria-haspopup={paired ? 'dialog' : undefined} aria-controls={open && paired ? 'helper-connection-details' : undefined} onClick={() => paired ? setOpen(value => !value) : onSetup()} data-tooltip={status.error || readiness.label}>{connected ? <svg className="feel-check" aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path pathLength="1" d="m3 8 3 3 7-7"/></svg> : <span/>}{outdated ? t('Update helper') : readiness.label}</button>
    {open && paired && <div ref={panel} id="helper-connection-details" className="helper-connection-panel" role="dialog" aria-label={t('Helper connection')} tabIndex={-1}>
      <strong>{t('Helper connected')}</strong>
      <p>{t('Codex: {state}', { state: status.codexMissing ? t('not installed') : !status.connected ? t('not ready') : status.signedIn ? t('signed in') : t('sign-in needed') })}</p>
      <p>{t('Helper version:')} <span className="helper-version">{status.helperVersion || (status.helperVersion === null ? t('source') : t('unknown'))}</span></p>
      {outdated && <p className="helper-update-note">{t('A newer helper is available. Download it, quit the old helper, then open the new one and paste its new code.')}</p>}
      {(readiness.own || readiness).key !== 'ready' && <button type="button" disabled={loginBusy} onClick={() => { close(); onFix(); }}>{(readiness.own || readiness).action}</button>}
      {download ? <a href={download.url} download={download.file} onClick={close}>{t('Download helper')}</a> : <button type="button" onClick={() => { close(); onDownloads(); }}>{t('Download helper')}</button>}
      {cloud && (manifestError || (manifest && detection?.packageId && !download)) && <p>{t('Download unavailable. Check other versions or try again later.')}</p>}
      <button type="button" onClick={() => { close(); onDownloads(); }}>{t('Other versions')}</button>
      {onDisconnect && <button type="button" onClick={() => { close(); onDisconnect(); }}>{t('Disconnect')}</button>}
    </div>}
  </div>;
}

// With onClose, the screen sits over a board: Escape, a click on the empty space around the panel, the panel's close
// button and Back to board all return to it.
function HelperSetup({ code, setCode, connecting, error, connect, cloudMode = false, showAllBuilds = false, teammates = null, onClose }) {
  const { detection, manifest, manifestError } = useHelperDownloads(cloudMode);
  const [selected, setSelected] = useState(''), [showBuilds, setShowBuilds] = useState(showAllBuilds);
  const [downloading, setDownloading] = useState(''), [downloadError, setDownloadError] = useState(''), [downloaded, setDownloaded] = useState(false);
  const officialSite = cloudMode || location.origin === 'https://concept-graph-local.knifest.chatgpt.site';
  useEffect(() => { if (detection?.packageId) setSelected(current => current || detection.packageId); }, [detection]);
  const downloadHelper = async platform => {
    setDownloading(t('Preparing download…')); setDownloadError(''); setDownloaded(false);
    try {
      // The download module is shared with the build scripts, so its progress text is translated here.
      const blob = await fetchHelperArchive(platform, message => { const part = /^Downloading part (\d+) of (\d+)…$/.exec(message); setDownloading(part ? t('Downloading part {part} of {parts}…', { part: part[1], parts: part[2] }) : t(message)); });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `concept-graph-helper-${platform}.zip`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setDownloaded(true);
    } catch (failure) { setDownloadError(t(failure.message || 'Could not download the helper.')); }
    finally { setDownloading(''); }
  };
  const selectedBuild = helperBuilds.find(build => build.id === selected);
  const directDownload = cloudMode ? cloudHelperDownload(selected, manifest?.[selected]) : null;
  const isRecommended = selected && detection?.packageId === selected;
  const matchingFamily = detection?.platform === 'macos' || detection?.platform === 'windows' ? detection.platform : null;
  const orderedBuilds = matchingFamily ? [...helperBuilds].sort((a, b) => Number(b.family === matchingFamily) - Number(a.family === matchingFamily)) : helperBuilds;
  const sizeLabel = build => {
    const item = manifest?.[build.id];
    if (cloudMode && !cloudHelperDownload(build.id, item)) return manifest || manifestError ? t('Download unavailable') : t('Checking size…');
    const download = formatHelperSize(item?.size), unpacked = formatHelperSize(item?.unpackedSize);
    if (!download) return manifest || manifestError ? t('Size unavailable') : t('Checking size…');
    return `${t('{size} download', { size: download })}${unpacked ? ` · ${cloudMode && build.family === 'windows' ? t('{size} installed', { size: unpacked }) : t('{size} unpacked', { size: unpacked })}` : ''}`;
  };
  const platformMessage = t(!detection ? 'Checking your device…'
    : detection.platform === 'macos' && !detection.packageId ? 'Mac detected · choose your processor'
    : detection.platform === 'windows' && detection.architecture === 'arm64' ? 'Windows on ARM detected · no native build yet'
    : detection.platform === 'windows' && detection.architecture === 'x86' ? '32-bit Windows detected · no compatible build'
    : detection.platform === 'windows' && !detection.packageId ? 'Windows detected · choose a compatible build'
    : detection.platform === 'linux' ? 'Linux detected · no build available yet'
    : detection.platform === 'mobile' ? 'Open this page on your computer to get started'
    : detection.packageId ? 'Detected for this device' : 'Choose a build for your computer');
  const openHint = cloudMode ? selectedBuild?.family === 'macos' ? rich('Open the downloaded file, drag {app} to Applications, then open it.', { app: <strong>Concept Graph Helper</strong> })
    : selectedBuild?.family === 'windows' ? rich('Run the installer. If Windows warns you, choose {choice}.', { choice: <strong>{t('More info → Run anyway')}</strong> })
    : t('Choose your computer’s version, then open the downloaded helper.')
    : manifest?.[selected]?.kind === 'app' ? rich('Unzip it and open {app}.', { app: <strong>Concept Graph Helper.app</strong> })
    : rich('Unzip it and run {file}.', { file: <strong>{selectedBuild?.family === 'windows' ? 'Start Concept Graph.cmd' : 'Start Concept Graph.command'}</strong> });
  const codeInput = useRef(null), connectRef = useRef(connect);
  connectRef.current = connect;
  const pasted = value => { const text = value.trim(); setCode(text); if (/^[\da-f]{64}$/i.test(text) && officialSite) connectRef.current(text); };
  // A pasted pairing code connects at once, wherever the user pastes it on this screen.
  useEffect(() => {
    const paste = event => { if (event.target.closest?.('input,textarea')) return; const text = event.clipboardData?.getData('text') || ''; if (!text.trim()) return; event.preventDefault(); pasted(text); codeInput.current?.focus(); };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  }, []);
  const closeRef = useRef(onClose), pressedOutside = useRef(false); closeRef.current = onClose;
  useEffect(() => {
    if (!onClose) return;
    const key = event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeRef.current?.(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [!onClose]);
  // A press that starts in the panel (selecting text, say) and ends outside it does not close.
  const outside = event => !event.target.closest?.('.helper-panel');
  return <main className="helper-startup" onPointerDown={event => { pressedOutside.current = !!onClose && outside(event); }} onClick={event => { if (pressedOutside.current && outside(event)) onClose(); pressedOutside.current = false; }}>
    <section className="helper-panel" aria-labelledby="helper-title">
      <header className="helper-panel-head">{onClose && <button type="button" className="helper-panel-close icon-button" aria-label={t('Back to board')} data-tooltip={t('Back to board')} onClick={onClose}><Icon name="close" size={18}/></button>}<div className="helper-brand"><img src="/favicon.svg" alt=""/><strong>Concept Graph</strong></div><h2 id="helper-title">{t('Connect Codex to generate images')}</h2><p>{cloudMode ? t('Images are generated by Codex on your computer. A small helper app links it to this board.') : t('A small helper app links this canvas to Codex on your computer.')}</p></header>
      {teammates}
      {!officialSite && <p className="helper-error" role="alert">{t('Open this app at its official site address to connect your local helper.')}</p>}
      <form onSubmit={event => { event.preventDefault(); connect(code); }}>
        <div className="helper-step">
          <div className="helper-step-marker">1</div>
          <div className="helper-step-content">
            <h3>{t('Download and open the helper')}</h3>
            {(!detection || !detection.packageId) && <div className="helper-device-status"><span className="helper-status-dot"/>{platformMessage}</div>}
            {selectedBuild && <div className="helper-selected">
              <div className="helper-selected-info"><span className="helper-device-icon"><Icon name="download" size={17}/></span><span><strong>{t(selectedBuild.label)}</strong><small>{sizeLabel(selectedBuild)}{isRecommended ? ` · ${t('recommended')}` : ''}</small></span></div>
              {cloudMode ? directDownload && officialSite ? <a className="helper-primary" href={directDownload.url} download={directDownload.file}><Icon name="download" size={16}/> {t('Download')}</a> : <button className="helper-primary" type="button" disabled><Icon name="download" size={16}/> {t('Download')}</button> : <button className="helper-primary" type="button" disabled={!!downloading || !officialSite} onClick={() => downloadHelper(selectedBuild.id)}><Icon name="download" size={16}/> {t('Download')}</button>}
            </div>}
            {(!selectedBuild || showBuilds) && <div className="helper-build-list" aria-label={t('Available helper versions')}>
              {orderedBuilds.map(build => <button key={build.id} type="button" className={`helper-build-option ${selected === build.id ? 'selected' : ''}`} onClick={() => { setSelected(build.id); setShowBuilds(false); setDownloaded(false); setDownloadError(''); }}><span><strong>{t(build.label)}</strong><small>{t(build.detail)}</small></span><span className="helper-build-size">{sizeLabel(build)}</span></button>)}
            </div>}
            <p className="helper-open-hint">{openHint} {t('Already installed? Just open it.')}{selectedBuild && <> <button type="button" className="helper-change" aria-expanded={showBuilds} onClick={() => setShowBuilds(value => !value)}>{showBuilds ? t('Hide other versions') : t('Other versions')}</button></>}</p>
            {detection?.platform === 'macos' && !detection.packageId && (!selectedBuild || showBuilds) && <p className="helper-space-note">{t('Not sure which Mac you have? Apple menu → About This Mac → Chip.')}</p>}
            {selectedBuild && selectedBuild.id !== 'macos-arm64' && <p className="helper-space-note">{t('This build is a preview and has not yet been tested on its platform.')}</p>}
            {cloudMode && manifestError && <p className="helper-space-note">{rich('Start the helper for this site with {command} from the project folder.', { command: <code>CONCEPT_GRAPH_SITE={location.origin} npm run helper</code> })}</p>}
            {downloading && <p className="helper-download-status" role="status">{downloading}</p>}
            {downloaded && <p className="helper-download-status" role="status">{t('Download started. Check your Downloads folder.')}</p>}
            {downloadError && <p className="helper-error" role="alert">{downloadError}</p>}
          </div>
        </div>
        <div className="helper-step helper-step-last">
          <div className="helper-step-marker">2</div>
          <div className="helper-step-content">
            <h3>{t('Paste the code from the helper window')}</h3>
            <div className="helper-code-box">
              <label className="helper-input-label" htmlFor="helper-code">{t('The helper shows a pairing code. Copy it and paste it here.')}</label>
              <div className="helper-connect"><input ref={codeInput} id="helper-code" type="password" autoComplete="off" spellCheck="false" value={code} onChange={event => setCode(event.target.value)} onPaste={event => { const text = event.clipboardData.getData('text'); if (text.trim()) { event.preventDefault(); pasted(text); } }} placeholder={t('Paste pairing code')} required/><button className="helper-primary" type="submit" disabled={connecting || !code.trim() || !officialSite}>{connecting ? t('Connecting…') : t('Connect')} <Icon name="arrow" size={15}/></button></div>
              {error && <p className="helper-error" role="alert">{error}</p>}
            </div>
            <p className="helper-step-note">{t('If your browser asks about local network access, allow it. Next you’ll be guided to install Codex if needed and sign in with ChatGPT.')}</p>
          </div>
        </div>
      </form>
    </section>
  </main>;
}

function Workspace() {
  const [boards, setBoards] = useState([]), [boardId, setBoardId] = useState(null), [error, setError] = useState('');
  const [mcpEnabled, setMcpEnabled] = useState(false);
  const [code, setCode] = useState(() => hosted ? sessionStorage.getItem('concept-graph-helper-token') || '' : '');
  const [connecting, setConnecting] = useState(false), [pairing, setPairing] = useState(false), [pairCancel, setPairCancel] = useState(0), [helperStatus, setHelperStatus] = useState(null);
  const [showAllBuilds, setShowAllBuilds] = useState(false);
  const helperSession = useRef({});
  Object.assign(helperSession.current, { paired: !!helperToken, pairing, pairCancel, status: helperStatus, openPair: (downloads = false) => { setShowAllBuilds(downloads); setPairing(true); } });
  const closePair = () => { setPairing(false); setPairCancel(value => value + 1); };
  const [theme, setTheme] = useState(() => localStorage.getItem('concept-graph-theme') === 'dark' ? 'dark' : 'light');
  const themeRef = useRef(theme), desktopPreferences = useRef(null), preferenceWrites = useRef(Promise.resolve()), pendingMcpSelection = useRef(null);
  useEffect(() => { localStorage.setItem('concept-graph-theme', theme); document.documentElement.dataset.theme = theme; }, [theme]);
  const savePreferences = next => {
    desktopPreferences.current = next;
    const operation = preferenceWrites.current.catch(() => {}).then(() => api('/api/desktop/preferences', jsonOptions('PUT', next)));
    preferenceWrites.current = operation;
    operation.catch(() => {});
  };
  const openWorkspace = async token => {
    const previousToken = helperToken;
    if (hosted) helperToken = token.trim();
    setError(''); setConnecting(true);
    try {
      const workspace = await api('/api/workspace');
      setMcpEnabled(workspace.mcpEnabled === true);
      if (hosted) { setHelperStatus(workspace.status); setPairing(false); }
      if (hosted) sessionStorage.setItem('concept-graph-helper-token', helperToken);
      setBoards(workspace.boards);
      const preferences = workspace.desktopPreferences;
      const remembered = preferences ? preferences.boardId : localStorage.getItem('concept-graph-board');
      if (preferences) {
        desktopPreferences.current = { theme: preferences.theme, boardId: workspace.boards.some(b => b.id === remembered) ? remembered : null };
        themeRef.current = preferences.theme;
        setTheme(preferences.theme);
      }
      setBoardId(current => workspace.boards.some(board => board.id === current) ? current : workspace.boards.some(b => b.id === remembered) ? remembered : workspace.defaultBoardId);
    } catch (failure) {
      if (hosted) {
        helperToken = previousToken;
        setError(failure.status === 403 ? t('The pairing code was not accepted. Check the terminal and try again.') : t('Could not reach the local helper. Start it, allow local network access if prompted, and try again.'));
      } else setError(failure.message);
    } finally { setConnecting(false); }
  };
  useEffect(() => { if (!hosted) openWorkspace(''); }, []);
  const selectBoard = (next, mcpRequestId) => {
    if (mcpRequestId) pendingMcpSelection.current = { id: mcpRequestId, boardId: next };
    localStorage.setItem('concept-graph-board', next);
    if (desktopPreferences.current) savePreferences({ ...desktopPreferences.current, boardId: next });
    setBoardId(next);
  };
  const editorReadyCallback = async editorId => {
    const pending = pendingMcpSelection.current;
    if (!pending || pending.boardId !== boardId) return;
    try {
      await preferenceWrites.current;
      await api('/api/desktop/ui-results', jsonOptions('POST', { editorId, id: pending.id, boardId }));
    } catch {
      await api('/api/desktop/ui-results', jsonOptions('POST', { editorId, id: pending.id, error: 'The board is open, but the selection could not be saved. Do not repeat before checking the window.' })).catch(() => {});
    }
    finally { if (pendingMcpSelection.current === pending) pendingMcpSelection.current = null; }
  };
  const toggleTheme = () => {
    const next = themeRef.current === 'dark' ? 'light' : 'dark';
    themeRef.current = next;
    if (desktopPreferences.current) savePreferences({ ...desktopPreferences.current, theme: next });
    setTheme(next);
  };
  if (!boardId && hosted) return <HelperSetup code={code} setCode={setCode} connecting={connecting} error={error} connect={openWorkspace}/>;
  if (!boardId) return <div className="startup">{error || t('Opening your boards…')}</div>;
  return <><ReactFlowProvider key={boardId}><App boardId={boardId} boards={boards} updateBoards={setBoards} selectBoard={selectBoard} theme={theme} toggleTheme={toggleTheme} waitForPreferences={() => preferenceWrites.current} desktopMode={!!desktopPreferences.current} mcpEnabled={mcpEnabled} editorReadyCallback={editorReadyCallback} helperSession={hosted ? helperSession.current : undefined}/></ReactFlowProvider>
    {hosted && pairing && <div className="helper-pair-overlay" role="dialog" aria-modal="true" aria-label={t('Connect local helper')} onKeyDown={keepDialogFocus}><button className="helper-pair-close" autoFocus onClick={closePair}><Icon name="back" size={16}/>{t('Back to board')}</button><HelperSetup showAllBuilds={showAllBuilds} code={code} setCode={setCode} connecting={connecting} error={error} connect={openWorkspace} onClose={closePair}/></div>}
  </>;
}
const cloudServices = {
  api, request,
  unpair: () => { helperToken = ''; sessionStorage.removeItem('concept-graph-helper-token'); },
  helperApi: (url, options = {}) => api(url, { ...options, helper: true }),
  helperRequest: (url, options = {}) => request(url, { ...options, helper: true }),
  pair: async token => {
    const previous = helperToken;
    helperToken = token.trim();
    try {
      const status = await api('/api/status', { method: 'POST', helper: true });
      sessionStorage.setItem('concept-graph-helper-token', helperToken);
      return status;
    } catch (error) { helperToken = previous; throw error; }
  },
};
createRoot(document.getElementById('root')).render(cloud ? <React.Suspense fallback={<div className="startup">{t('Opening cloud workspace…')}</div>}><CloudWorkspace Editor={App} HelperSetup={HelperSetup} services={cloudServices}/></React.Suspense> : <Workspace/>);
