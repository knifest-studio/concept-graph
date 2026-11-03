import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, createContext, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ReactFlow, ReactFlowProvider, Background, BaseEdge, getBezierPath, Handle, Position, applyNodeChanges, applyEdgeChanges, addEdge, useReactFlow, useUpdateNodeInternals, useNodesInitialized } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './style.css';
import { runTiming } from '../timing.mjs';
import { templatePalette, templateColor, nextTemplateColor, templateSnapshot } from '../graph.mjs';
import { ButtonHelp } from './ButtonHelp.jsx';
import { nodeClipboardType, selectedGraph, readNodeClipboard, cloneSelection, copyImageToClipboard } from './clipboard.mjs';
import { connectionColor, edgeDropCreatesPrompt, cleanGroups, pruneGroups, canvasView, moveGroup, alignNodes, freshOutputNodes, mergeAddedGroups, preserveFreshOutputGroups, mergeRemoteImageCaptions, preserveRemoteImageCaptions, restoreFirstImageFallback, stampTargetAt, attachStampAt } from './canvas.mjs';
import { cloudHelperDownload, fetchHelperArchive, helperOutdated } from './helper-download.mjs';
import { detectPlatform } from './platform-detection.mjs';
import { useCanvasImage, useImageButtonZoom } from './canvas-image-hooks.jsx';
import { NodeContextMenu } from './NodeContextMenu.jsx';
import { AnnotationTools, AuthorBadge, ColorPicker, DrawingNode, StickyNode, StampNode, StrokePreview } from './BoardAnnotations.jsx';
import { boardAuthor, drawingFromStroke, groupPalette, imageAuthor, isAnnotation, penPalette, simplifyStroke, stickyPalette, contrastColor, reconcileStampAttachments } from './annotations.mjs';
import { NodeTemplatePicker } from './NodeTemplatePicker.jsx';
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
import { arrangeLayers, layerShortcut, nextLayer, stackOnTop } from './layers.mjs';
import { assignPage, boardPages, defaultPageId, defaultPages, maxPages, mergePages, nextPageName, nodePage, pageContent, pageName, readPagePreference, resolvePage, storedPages, writePagePreference } from './pages.mjs';
import { gettingStartedKey, generationReadiness, generationIntent, intentUnchanged, directInputCounts, inputLabel, freePromptPosition, freeSpot, focusViewport } from './onboarding.mjs';

const Actions = createContext(null);
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
const busy = run => ['running', 'queued'].includes(run?.status);
const generateShortcut = () => /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent) ? '⌘ Enter' : 'Ctrl+Enter';
const finishBoardEdit = () => { const element = document.activeElement; if (element?.matches('.sticky-node textarea,.group-name-input')) flushSync(() => element.blur()); };

function Icon({ name, size = 18 }) {
  const paths = {
    sound: <><path d="M11 4 6 8H3v8h3l5 4Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
    muted: <><path d="M11 4 6 8H3v8h3l5 4Z"/><path d="m16 9 6 6m0-6-6 6"/></>,
    mic: <><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></>,
    group: <><rect x="3" y="3" width="18" height="18" rx="3" strokeDasharray="3 3"/><rect x="7" y="7" width="4" height="4"/><rect x="13" y="13" width="4" height="4"/></>,
    align: <><rect x="2" y="9" width="6" height="6" rx="1"/><rect x="16" y="2" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M8 12h4m4-7h-4v14h4"/></>,
    chevron: <path d="m8 5 7 7-7 7"/>, ungroup: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><path d="m9 9 6 6m0-6-6 6"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
    moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/></>,
    edit: <><path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>, image: <><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 16 5-5 4 4 4-6 5 8"/></>,
    text: <><path d="M4 5h16M12 5v14M8 19h8"/></>, play: <path d="m8 5 11 7-11 7z"/>, arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    tag: <><path d="M20 13 13 20 4 11V4h7l9 9Z"/><circle cx="8" cy="8" r="1"/></>,
    expand: <path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>, collapse: <path d="M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5"/>, download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>, undo: <path d="m9 5-5 5 5 5M4 10h10a6 6 0 0 1 0 12"/>, redo: <path d="m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>,
    minus: <path d="M5 12h14"/>, check: <path d="m5 12 4 4L19 6"/>, clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>, branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m12-10c0 7-12 1-12 8"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.plus}</svg>;
}

function TextNode(props) {
  const actions = useContext(Actions);
  const run = [...actions.runs].reverse().find(run => run.nodeId === props.id);
  return <NodeFeedback id={props.id} effects={actions.effects} working={busy(run) || actions.starting === props.id}>{props.data.collapsed ? <CollapsedNode {...props} kind="text"/> : <ExpandedTextNode {...props}/>}</NodeFeedback>;
}

function ExpandedTextNode({ id, data, selected }) {
  const actions = useContext(Actions);
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, updateNodeInternals]);
  const run = [...actions.runs].reverse().find(r => r.nodeId === id);
  const pending = busy(run) || actions.starting === id;
  const canCancel = !cloud || actions.starting === id || run?.by?.name === actions.user?.name;
  const timing = runTiming(actions.starting === id && !busy(run) ? null : run, actions.runs, actions.now);
  const [draft, setDraft] = useState(data.text);
  const canRun = !!draft.trim() || !!data.template?.instructions?.trim();
  const editor = useRef(null), generateButton = useRef(null), edited = useRef(false);
  const changeText = value => { setDraft(value); if (!edited.current) { actions.checkpoint(); edited.current = true; } actions.editText(id, value); };
  const dictation = usePromptDictation(editor, draft, changeText, actions.dictationLanguage, actions.effects);
  const inputText = inputLabel(actions.inputs.get(id) || { images: 0, text: 0 });
  const blocked = actions.readiness.key !== 'ready';
  // React Flow propagates node data through its store after the input event.
  // Keep the controlled input synchronous so React never restores an old value/caret.
  useLayoutEffect(() => {
    if (cloud || document.activeElement !== editor.current) setDraft(data.text);
  }, [data.text]);
  useLayoutEffect(() => {
    const input = editor.current;
    input.style.height = '0px';
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);
  useEffect(() => {
    if (actions.focusId === id) {
      // Wait until the release event finishes focusing the source node.
      const timer = setTimeout(() => {
        (actions.focusControl === 'generate' && canRun ? generateButton.current || editor.current : editor.current)?.focus({ preventScroll: true });
        actions.clearFocus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [actions.focusId, actions.focusControl, id]);
  return <NodeContextMenu id={id} type="text" actions={actions}><article className={`node-card text-node ${pending ? 'working' : ''} ${data.template ? 'custom-node' : ''}`} style={data.template ? { '--template-color': templateColor(data.template) } : undefined}>
    <Handle type="target" position={Position.Left} aria-label="Connect input to prompt"/>
    <header className="node-drag"><NodeTemplatePicker id={id} template={data.template} templates={actions.templates} switchTemplate={actions.switchTemplate} viewTemplate={actions.viewTemplate}/><button className="text-node-collapse nodrag" type="button" aria-label="Collapse text node" data-tooltip="Collapse node" onClick={() => actions.toggleNodeCollapsed(id)}><Icon name="collapse" size={15}/></button><div className="run-controls nodrag"><div className="generate-slot">{pending && <span className="generation-label" role="status">{actions.starting === id && !busy(run) ? 'Starting…' : canCancel ? `Generating… ${timing.label}` : `Generating… (${run?.by?.name})`}</span>}<button ref={generateButton} className={`run-button ${pending ? 'run-pending' : ''} ${actions.highlight === `${id}:generate` ? 'onboarding-highlight' : ''}`} type="button" aria-label={blocked ? 'Connect and generate' : 'Generate image'} onClick={event => actions.run(id, null, event)} disabled={pending || !canRun} data-tooltip={!canRun ? 'Write a prompt first' : `${blocked ? 'Connect and generate' : 'Generate image'} · ${generateShortcut()}`}><Icon name="play" size={12}/><span>{blocked ? 'Connect and generate' : 'Generate'}</span></button></div>{pending && canCancel && busy(run) && <button className="run-cancel" type="button" disabled={actions.starting === id} onClick={() => actions.cancel(run.id)}>Cancel</button>}</div></header>
    <div className="prompt-editor">
      <textarea ref={editor} className="nodrag" rows={1} aria-label="Image prompt" value={draft} placeholder="Describe the image you want, then click Generate" onFocus={() => { edited.current = false; }} onChange={event => { if (dictation.active) dictation.cancel(); changeText(event.target.value); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); dictation.cancel(); if (!pending && canRun) actions.run(id); } }}/>
      {dictation.supported && <button type="button" className={`dictation-button nodrag ${dictation.active ? 'active' : ''} ${dictation.listening ? 'recording' : ''}`} aria-label={dictation.active ? 'Stop dictation' : 'Dictate prompt'} aria-pressed={dictation.active} disabled={dictation.stopping} data-tooltip={dictation.active ? dictation.stopping ? 'Finishing dictation…' : 'Stop dictation · Esc' : 'Dictate (speech is recognised by your browser’s service)'} onPointerDown={event => event.preventDefault()} onClick={dictation.toggle} onDoubleClick={event => event.stopPropagation()}><Icon name="mic" size={13}/>{dictation.active && <i aria-hidden="true"/>}</button>}
      {dictation.active && <button type="button" className="dictation-lang nodrag" aria-label={`Dictation language ${dictation.language || '…'}, click to switch`} data-tooltip="Switch language · UK / EN / RU" disabled={!dictation.language || dictation.stopping} onPointerDown={event => event.preventDefault()} onClick={dictation.switchLanguage}>{dictation.language || '…'}</button>}
      {dictation.interim && <div className="dictation-interim" role="status">{dictation.interim}</div>}
      {dictation.active && <span className="sr-only" role="status">{dictation.stopping ? 'Finishing dictation' : dictation.listening ? `Recording ${dictation.language}` : 'Starting dictation'}</span>}
    </div>
    {dictation.error && <div className="node-error nodrag" role="alert">{dictation.error}</div>}
    {inputText && <div className="node-inputs">Inputs: {inputText}</div>}
    {selected && blocked && !pending && <div className="node-readiness nodrag"><span>{actions.readiness.key === 'helper' ? 'Helper not connected.' : actions.readiness.key === 'install' ? 'Codex is not installed.' : actions.readiness.key === 'signin' ? 'Sign-in needed.' : 'Codex is not ready.'}</span><button type="button" onClick={actions.fixReadiness}>{actions.readiness.action}</button></div>}
    {['error', 'failed'].includes(run?.status) && <div className="node-error nodrag">{run.error}{!cloud && <button type="button" className="run-details-link" onClick={() => actions.openRunDetails(run.id)}>View run details</button>}</div>}
    <Handle type="source" position={Position.Right} aria-label="Connect prompt to another node"/>
  </article></NodeContextMenu>;
}

function ImageNode(props) {
  const actions = useContext(Actions);
  const author = cloud && imageAuthor(props.data, actions.runs);
  // The author sits under the card and appears only on hover or selection, so it never covers the image.
  return <NodeFeedback id={props.id} effects={actions.effects}>{props.data.collapsed ? <CollapsedNode {...props} kind="image"/> : <ExpandedImageNode {...props}/>}{author && <span className={`image-author${props.data.collapsed ? ' collapsed' : ''}`}><AuthorBadge author={author}/></span>}</NodeFeedback>;
}

function ExpandedImageNode({ id, data }) {
  const actions = useContext(Actions);
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, updateNodeInternals]);
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
  useOutputReady(imageElement, image.src, id, actions.effects);
  const variationButton = useRef(null);
  useEffect(() => {
    if (actions.focusId !== id || actions.focusControl !== 'variation') return;
    const timer = setTimeout(() => { variationButton.current?.focus({ preventScroll: true }); actions.clearFocus(); }, 0);
    return () => clearTimeout(timer);
  }, [actions.focusId, actions.focusControl, id]);
  return <NodeContextMenu id={id} type="image" actions={actions}><div className="image-node-wrapper">
    {(captionFocused || !!data.caption?.trim()) && <input ref={captionInput} className="image-node-caption nodrag" aria-label="Image caption" title="Edit image caption" maxLength={120} value={caption} onFocus={() => { captionEdited.current = false; captionBeforeEdit.current = data.caption; setCaptionFocused(true); captionCheckpoint.current = actions.checkpoint(); }} onBlur={() => setCaptionFocused(false)} onChange={event => { captionEdited.current = true; setCaption(event.target.value); actions.editCaption(id, event.target.value); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === 'Escape') { event.stopPropagation(); setCaption(actions.cancelCaption(id, captionBeforeEdit.current, captionCheckpoint.current) || ''); event.currentTarget.blur(); } }}/>}<article className="node-card image-node" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }} onDoubleClick={() => actions.view(id)}>
    {data.runId && <Handle type="target" position={Position.Left} isConnectable={false}/>}
    <img ref={imageElement} className="image-content" src={image.src} style={{ aspectRatio: image.aspectRatio || (data.aspect ? `1 / ${data.aspect}` : undefined) }} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt={data.caption || data.label || 'Concept image'} draggable="false"/>
    <div className="image-shade"/>
    <button className="image-collapse nodrag" type="button" aria-label="Collapse image node" data-tooltip="Collapse node" onClick={event => { event.stopPropagation(); actions.toggleNodeCollapsed(id); }} onDoubleClick={event => event.stopPropagation()}><Icon name="collapse" size={15}/></button>
    {!data.caption?.trim() && !captionFocused && <button className="image-caption-add nodrag" type="button" aria-label="Add image caption" data-tooltip="Add image caption" onClick={event => { event.stopPropagation(); setCaptionFocused(true); }} onDoubleClick={event => event.stopPropagation()}><Icon name="tag" size={15}/></button>}
    <button className="image-expand nodrag" style={{ '--inverse-zoom': 1 / zoom }} data-tooltip="View fullscreen" aria-label="Open image fullscreen" onClick={() => actions.view(id)}><Icon name="expand" size={24}/></button>
    <button ref={variationButton} type="button" className={`image-prompt-from nodrag ${actions.highlight === `${id}:variation` ? 'onboarding-highlight' : ''}`} data-tooltip="New prompt that uses this image as a reference" onClick={event => { event.stopPropagation(); actions.promptFrom(id); }} onDoubleClick={event => event.stopPropagation()}>+ Prompt from this</button>
    <Handle type="source" position={Position.Right} aria-label="Connect image as reference"/>
  </article></div></NodeContextMenu>;
}

function useOutputReady(ref, source, id, effects) {
  useEffect(() => {
    const image = ref.current;
    if (!image || !effects.pending.has(id)) return;
    let active = true;
    const ready = async () => {
      try { if (image.decode) await image.decode(); } catch {}
      if (active && image.naturalWidth > 0) effects.outputReady(id);
    };
    if (image.complete) ready();
    const failed = () => effects.outputFailed(id);
    image.addEventListener('load', ready); image.addEventListener('error', failed);
    return () => { active = false; image.removeEventListener('load', ready); image.removeEventListener('error', failed); };
  }, [source, id, effects.pending.has(id)]);
}

function CollapsedImage({ asset, id }) {
  const effects = useContext(Actions).effects, ref = useRef(null);
  const image = useCanvasImage(assetUrl(asset));
  useOutputReady(ref, image.src, id, effects);
  return <img ref={ref} className="collapsed-node-image" src={image.src} alt="" draggable="false"/>;
}

function CollapsedNode({ id, data, kind }) {
  const actions = useContext(Actions);
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, updateNodeInternals]);
  const isImage = kind === 'image';
  const run = !isImage ? [...actions.runs].reverse().find(run => run.nodeId === id) : null;
  return <NodeContextMenu id={id} type={kind} actions={actions}>
    <article className={`collapsed-node ${isImage ? 'collapsed-node-image-card' : 'collapsed-node-text-card'} ${!isImage && data.template ? 'custom-node' : ''}`} style={!isImage && data.template ? { '--template-color': templateColor(data.template) } : undefined}>
      {(!isImage || data.runId) && <Handle type="target" position={Position.Left} isConnectable={!isImage} aria-label={isImage ? 'Image input' : 'Connect input to prompt'}/>}
      {isImage ? <CollapsedImage asset={data.asset} id={id}/> : <Icon name="text" size={26}/>}
      {busy(run) && <span className="collapsed-run-dot" aria-label="Generating" title="Generating…"/>}
      {['failed', 'error'].includes(run?.status) && <span className="collapsed-run-dot failed" aria-label={run.error} title={run.error}/>}
      <button className="collapsed-node-expand nodrag" type="button" aria-label={`Expand ${isImage ? 'image' : 'text'} node`} data-tooltip="Expand node" onClick={() => actions.toggleNodeCollapsed(id)}><Icon name="expand" size={15}/></button>
      {isImage && <button className="collapsed-prompt-from nodrag" type="button" aria-label="+ Prompt from this" data-tooltip="New prompt that uses this image as a reference" onClick={() => actions.promptFrom(id)}><Icon name="plus" size={15}/></button>}
      <Handle type="source" position={Position.Right} aria-label={isImage ? 'Connect image as reference' : 'Connect prompt to another node'}/>
    </article>
  </NodeContextMenu>;
}

function GroupNode({ id, data }) {
  const actions = useContext(Actions);
  const editing = actions.renamingGroup === id;
  const [name, setName] = useState(data.name), cancelled = useRef(false), input = useRef(null);
  useLayoutEffect(() => { if (editing) { cancelled.current = false; setName(data.name); input.current?.focus({ preventScroll: true }); input.current?.select(); } }, [editing]);
  const save = () => { if (!cancelled.current && name.trim()) actions.editGroup(id, { name: name.trim() }); actions.renameGroup(null); };
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, data.collapsed, updateNodeInternals]);
  return <NodeContextMenu id={id} type="group" actions={actions}><article data-feel-node={id} className={`group-frame ${data.collapsed ? 'collapsed' : ''} ${data.color ? 'colored' : ''}`} style={data.color ? { background: data.color, '--group-ink': contrastColor(data.color) } : undefined}>
    <header><button className={`group-toggle nodrag ${data.collapsed ? '' : 'expanded'}`} aria-label={`${data.collapsed ? 'Expand' : 'Collapse'} ${data.name}`} data-tooltip={data.collapsed ? 'Expand group' : 'Collapse group'} onClick={() => actions.toggleGroup(id)}><Icon name="chevron" size={16}/></button>{editing ? <input ref={input} className="group-name-input nodrag" aria-label="Group name" maxLength={80} value={name} onChange={event => setName(event.target.value)} onBlur={save} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === 'Escape') { cancelled.current = true; actions.renameGroup(null); } }}/> : <strong className="nodrag" tabIndex={0} role="button" title="Double-click to rename group" onDoubleClick={() => actions.renameGroup(id)} onKeyDown={event => { if (event.key === 'Enter') { event.stopPropagation(); actions.renameGroup(id); } }}>{data.name}</strong>}<span>{data.count} nodes</span><ColorPicker color={data.color} colors={groupPalette} label="Group background color" allowDefault custom onChange={color => actions.editGroup(id, { color })}/><button className="icon-button nodrag" aria-label={`Ungroup ${data.name}`} data-tooltip="Ungroup; keep nodes" onClick={() => actions.ungroup(id)}><Icon name="ungroup" size={16}/></button></header>
    {data.collapsed && <><Handle type="target" position={Position.Left} isConnectable={false}/><Handle type="source" position={Position.Right} isConnectable={false}/></>}
  </article></NodeContextMenu>;
}
function AnnotationNode(props) {
  const actions = useContext(Actions), Component = { drawing: DrawingNode, sticky: StickyNode, stamp: StampNode }[props.type];
  return <Component {...props} actions={actions}/>;
}
const nodeTypes = { text: TextNode, image: ImageNode, group: GroupNode, drawing: AnnotationNode, sticky: AnnotationNode, stamp: AnnotationNode };
function FeedbackEdge(props) {
  const [path] = getBezierPath(props);
  return <BaseEdge id={props.id} path={path} pathLength="1" style={props.style} markerStart={props.markerStart} markerEnd={props.markerEnd}/>;
}
const edgeTypes = { feedback: FeedbackEdge };
const cleanNodes = nodes => nodes.map(({ id, type, position, data, page, z }) => ({ id, type, position, data, ...(page === undefined ? {} : { page }), ...(z === undefined ? {} : { z }) }));
const cleanEdges = edges => edges.map(({ id, source, target }) => ({ id, source, target }));
const historySignature = (nodes, edges, groups, pages) => JSON.stringify({ nodes: cleanNodes(nodes), edges: cleanEdges(edges), groups: cleanGroups(groups), pages });
const capture = (nodes, edges, groups, pages, remoteGroupVersion = 0, remoteCaptionVersion = 0, activeRunIds = []) => JSON.stringify({ nodes: cleanNodes(nodes), edges: cleanEdges(edges), groups: cleanGroups(groups), pages, capturedAt: new Date().toISOString(), remoteGroupVersion, remoteCaptionVersion, activeRunIds });

async function api(url, options = {}) {
  const response = await request(url, options);
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error || 'Request failed.'), { status: response.status, value });
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
    if (!Number.isFinite(minutes) || minutes <= 0) return 'Usage window';
    if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
    if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
    return `${minutes}-minute limit`;
  };
  return <details className="usage" onToggle={event => { if (event.currentTarget.open) refresh(); }} onKeyDown={event => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}>
    <summary aria-label="Codex usage limits"><Icon name="clock" size={15}/><span>Usage{first ? ` · ${remaining(first.usedPercent)}% left` : ''}</span></summary>
    <div className="usage-panel" aria-label="Codex usage limits">
      <div className="usage-heading"><strong>Codex usage</strong><button type="button" onClick={refresh} disabled={!ready || loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
      <div aria-live="polite">
        {!ready ? <p>Connect and sign in to Codex to see usage.</p> : loading && !usage ? <p>Loading usage…</p> : !usage?.available || !buckets.length ? <p>Usage information is unavailable. Try refreshing later.</p> : buckets.map((bucket, index) => <div className="usage-bucket" key={bucket.id || index}>
          {bucket.name && <h3>{bucket.name}</h3>}
          {[bucket.primary, bucket.secondary].filter(Boolean).length ? [bucket.primary, bucket.secondary].filter(Boolean).map((window, windowIndex) => {
            const percent = remaining(window.usedPercent);
            const reset = Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? new Date(window.resetsAt * 1000) : null;
            const resetValid = reset && Number.isFinite(reset.getTime());
            return <div className="usage-window" key={windowIndex}>
              <div><span>{windowLabel(window.windowDurationMins)}</span><strong>{percent === null ? 'Unavailable' : `${percent}% left`}</strong></div>
              {percent !== null && <progress max="100" value={percent} aria-label={`${windowLabel(window.windowDurationMins)}: ${percent}% remaining`}/>}
              <small>{resetValid ? `Resets ${reset.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'Reset time unavailable'}</small>
            </div>;
          }) : <p>No usage windows available.</p>}
        </div>)}
      </div>
      <p className="usage-note">These are Codex usage limits; image generation may have a separate limit.</p>
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
    try { await task(); } catch (failure) { setError(failure.message || 'Something went wrong. Please try again.'); }
    finally { setBusy(false); onBusyChange(false); }
  };
  const upload = event => {
    const files = [...event.target.files]; event.target.value = '';
    if (!files.length) return;
    if (assets.length + files.length > 10) { setError('Choose at most 10 reference images.'); return; }
    perform(async () => {
      for (const file of files) {
        const { asset } = await api('/api/assets', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
        setAssets(current => [...current, asset]);
      }
    });
  };
  return <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="template-editor-title" onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
    <form className="template-editor" onSubmit={event => { event.preventDefault(); if (!name.trim() || busy) return; perform(() => onSave({ name: name.trim(), instructions, assets, ...(template || colorPicked ? { color } : {}), ...(initial?.labelOutputs === undefined ? {} : { labelOutputs: initial.labelOutputs }) })); }}>
      <h2 id="template-editor-title">{template ? 'Edit custom node' : 'Create custom node'}</h2>
      <p className="template-intro">Save instructions and reference images to reuse on any board.</p>
      <label htmlFor="template-name">Name</label>
      <input id="template-name" autoFocus value={name} maxLength={80} placeholder="e.g. Character multiview" onChange={event => setName(event.target.value)} disabled={busy} required/>
      <fieldset className="template-colors"><legend>Colour</legend>{templatePalette.map(value => <button key={value} type="button" aria-label={`Colour ${value}`} aria-pressed={color === value} style={{ '--swatch-color': value }} disabled={busy} onClick={() => { setColor(value); setColorPicked(true); }}>{color === value && <Icon name="check" size={14}/>}</button>)}</fieldset>
      <label htmlFor="template-instructions">Additional instructions</label>
      <textarea id="template-instructions" value={instructions} maxLength={100000} placeholder="Describe the result you want this node to create…" onChange={event => setInstructions(event.target.value)} disabled={busy} rows={5}/>
      <p className="template-hint">These instructions are included with the text you write in the node.</p>
      <div className="template-reference-heading"><span>Reference images <small>{assets.length}/10</small></span><button type="button" onClick={() => imageInput.current?.click()} disabled={busy || assets.length >= 10}>+ Add images</button></div>
      <input ref={imageInput} className="template-file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={upload} tabIndex={-1} aria-label="Choose reference images"/>
      {assets.length ? <div className="template-reference-grid">{assets.map((asset, index) => <div className="template-reference" key={`${asset}-${index}`}><img src={assetUrl(asset)} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt={`Reference ${index + 1}`}/><button type="button" aria-label={`Remove reference ${index + 1}`} data-tooltip="Remove reference" disabled={busy} onClick={() => setAssets(current => current.filter((_, i) => i !== index))}><Icon name="close" size={13}/></button></div>)}</div> : <p className="template-hint">Optional. These images are included every time you run the node.</p>}
      {error && <p className="template-error" role="alert">{error}</p>}
      <div className="template-editor-actions">{template && <button className="template-delete" type="button" disabled={busy} onClick={() => { if (window.confirm('Delete this custom node? Nodes already on your boards will keep their settings.')) perform(onDelete); }}>Delete</button>}<button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={busy || !name.trim()}>{busy ? 'Working…' : 'Save custom node'}</button></div>
    </form>
  </div>;
}

function TemplateDetails({ template, onClose }) {
  return <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="template-details-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="template-details">
      <h2 id="template-details-title">{template.name}</h2>
      <p className="template-hint">These settings are saved in this node. Editing the library won’t change them.</p>
      <h3>Additional instructions</h3><p className="template-instructions">{template.instructions || 'No additional instructions'}</p>
      <h3>Reference images</h3>
      {template.assets?.length ? <div className="template-reference-grid">{template.assets.map((asset, index) => <div className="template-reference" key={`${asset}-${index}`}><img src={assetUrl(asset)} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt={`Reference ${index + 1}`}/></div>)}</div> : <p className="template-hint">No saved reference images</p>}
      <div className="template-details-actions"><button className="primary-button" autoFocus onClick={onClose}>Done</button></div>
    </div>
  </div>;
}

function AgentConnect({ onClose }) {
  const [setup, setSetup] = useState(null), [error, setError] = useState(''), [copyStatus, setCopyStatus] = useState('');
  const promptRef = useRef(null);
  useEffect(() => {
    let active = true;
    api('/api/desktop/mcp-setup').then(value => { if (active) setSetup(value); }).catch(() => { if (active) setError('Could not load connection details. Restart Concept Graph and try again.'); });
    return () => { active = false; };
  }, []);
  const prompt = setup?.command && Array.isArray(setup.args) ? `Connect your current agent to the local Concept Graph MCP server using stdio. Concept Graph is installed on this computer. Use this configuration:\n${JSON.stringify({ command: setup.command, args: setup.args }, null, 2)}\nCheck the existing concept-graph configuration for your client; register it if missing or update outdated paths if needed, preserving other settings. Verify the connection and tell me if a new session or restart is needed. Keep Concept Graph open, and do not expose credentials or board contents.` : '';
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(prompt);
      setCopyStatus('Copied! Paste it into your agent.');
    } catch {
      promptRef.current?.focus();
      promptRef.current?.select();
      try {
        if (!document.execCommand('copy')) throw new Error('Copy failed');
        setCopyStatus('Copied! Paste it into your agent.');
      } catch { setCopyStatus('Select the text and copy it using your keyboard.'); }
    }
  };
  return <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="agent-connect-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
    <div className="agent-connect-card">
      <div className="agent-connect-heading"><div><span className="eyebrow">MCP CONNECTION</span><h2 id="agent-connect-title">Connect MCP</h2></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="close" size={17}/></button></div>
      <p>Copy this message and send it to Codex or Claude Code running on this computer. The agent can set up the connection for you.</p>
      {error ? <p className="agent-connect-error" role="alert">{error}</p> : !setup ? <p>Loading connection details…</p> : <>
        {!setup.available && <p className="agent-connect-error" role="alert">MCP is unavailable in this window. Close any other Concept Graph window and restart the app.</p>}
        {prompt && <><label htmlFor="agent-connect-prompt">Message for your agent</label><textarea id="agent-connect-prompt" ref={promptRef} readOnly value={prompt} rows={7} onFocus={event => event.target.select()}/><div className="agent-connect-actions"><button className="primary-button" autoFocus type="button" onClick={copy}><Icon name="copy" size={15}/> Copy message</button><span role="status">{copyStatus}</span></div></>}
      </>}
      <p className="agent-connect-note">Keep Concept Graph open. A connected agent can read and change your boards and images, and start generation.</p>
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
  const [renamingGroup, setRenamingGroup] = useState(null), [tool, setTool] = useState('select');
  const [pen, setPen] = useState({ color: penPalette[0], width: 4 }), [stickyColor, setStickyColor] = useState(stickyPalette[0]), [stamp, setStamp] = useState('like');
  const strokePreview = useRef(null), stroke = useRef(null), toolRef = useRef('select');
  const chooseTool = value => { if (stroke.current) moving.current = false; toolRef.current = value; setTool(value); stroke.current = null; strokePreview.current?.show([]); };
  const [focusControl, setFocusControl] = useState('text'), [highlight, setHighlight] = useState(null), [helperOffline, setHelperOffline] = useState(false);
  const canvasElement = useRef(null), highlightTimer = useRef(null), pendingIntent = useRef(null), alive = useRef(true), runAction = useRef(null), generationStarting = useRef(false);
  const guide = useGettingStarted(gettingStartedKey(cloud ? `cloud:${cloudSession.user.name}` : hosted ? 'hosted' : 'local'));
  const groupRef = useRef([]);
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
  const [boardForm, setBoardForm] = useState(null), [nameDraft, setNameDraft] = useState('');
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
  modalOpen.current = !!viewId || !!boardForm || !!pageDelete || !!templateForm || !!templateDetails || !!diagnosticsId || agentConnect || switching || !!transfer || !!login || installCodex || showSignIn || pairing;
  const flow = useReactFlow();
  const nodesInitialized = useNodesInitialized(), openingViewDone = useRef(false), viewerMoved = useRef(false);
  const scoped = pageContent({ nodes, edges, groups }, activePage, pages);
  useEffect(() => {
    if (!loaded || openingViewDone.current) return;
    if (!scoped.nodes.length) { openingViewDone.current = true; return; }
    if (!nodesInitialized || !flow.viewportInitialized) return;
    openingViewDone.current = true;
    const page = activePageRef.current, fit = () => flow.fitView({ padding: .18, minZoom: .01, maxZoom: 1 });
    fit();
    // Image nodes grow as their pictures load, so refit briefly unless the viewer has moved the canvas.
    [400, 1000, 2000, 3500].forEach(ms => setTimeout(() => { if (!viewerMoved.current && activePageRef.current === page) fit(); }, ms));
  }, [loaded, scoped.nodes.length, nodesInitialized, flow, activePage]);
  const teammateCodex = cloud && cloudSession.codex?.outgoing?.granted && cloudSession.codex.outgoing.available ? cloudSession.codex.outgoing : null;
  const readiness = generationReadiness({ required: helperNeeded, paired: cloud ? cloudSession.paired : !!helperSession?.paired, online: !helperOffline, status, teammate: teammateCodex });
  const ownReady = (readiness.own || readiness).key === 'ready';
  const readinessRef = useRef(readiness); readinessRef.current = readiness;
  const nodeRef = useRef([]), edgeRef = useRef([]), base = useRef({ revision: 0, nodes: [], edges: [] });
  const cloudBase = useRef({ nodes: [], edges: [], groups: [], runs: [] }), applyingCloud = useRef(false), cloudOfflineEdits = useRef(false);
  const dirty = useRef(false), version = useRef(0), saving = useRef(null), saveTimer = useRef(null), viewport = useRef({ x: 0, y: 0, zoom: 1 });
  const history = useRef([]), future = useRef([]), lastHistory = useRef('');
  const remoteGroups = useRef({ version: 0, added: new Map() });
  const remoteCaptions = useRef({ version: 0, added: new Map() });
  const mouse = useRef({ x: innerWidth / 2, y: innerHeight / 2 }), fileInput = useRef(null), toastTimer = useRef(null);
  const saveFn = useRef(null);
  const notify = useCallback(message => { setToast(message); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 6500); }, []);
  const refreshTemplates = useCallback(async () => {
    try { const result = await api('/api/templates'); setTemplates(result.templates); setTemplatesError(''); }
    catch { setTemplatesError('Custom nodes unavailable.'); }
  }, []);
  useEffect(() => {
    refreshTemplates();
    if (!cloud) return;
    const refresh = () => { if (!document.hidden) refreshTemplates(); };
    const timer = setInterval(refresh, 10000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [refreshTemplates]);
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
  useEffect(() => { if (cloudSession) cloudSession.selection([...scoped.nodes.filter(node => node.selected).map(node => node.id), ...scoped.groups.filter(group => group.selected).map(group => group.id)]); }, [nodes, groups, activePage]);
  useEffect(() => { cloudSession?.page?.(activePage); }, [activePage]);
  const putNodes = value => { nodeRef.current = typeof value === 'function' ? value(nodeRef.current) : value; setNodes(nodeRef.current); };
  const putEdges = value => { edgeRef.current = typeof value === 'function' ? value(edgeRef.current) : value; setEdges(edgeRef.current); };
  const putGroups = value => { groupRef.current = typeof value === 'function' ? value(groupRef.current) : value; setGroups(groupRef.current); };
  const putPages = value => { pagesRef.current = typeof value === 'function' ? value(pagesRef.current) : value; setPages(pagesRef.current); };
  const currentGraph = () => ({ nodes: nodeRef.current, edges: edgeRef.current, groups: groupRef.current });
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
    putNodes(current => current.map(node => ({ ...node, selected: node.id === nodeId || (preserveSelection && node.selected), data: node.id === nodeId && node.data.collapsed ? { ...node.data, collapsed: false } : node.data })));
    putGroups(current => current.map(group => ({ ...group, selected: false, collapsed: group.nodeIds.includes(nodeId) ? false : group.collapsed })));
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
    if (cloudSession) cloudSession.onOwnRun = trackOwnRun;
    return () => { if (cloudSession) cloudSession.onOwnRun = null; };
  }, []);
  useEffect(() => { for (const run of runs) guide.report({ type: 'run-finished', run }); }, [runs, guide.state.ownRuns]);
  useEffect(() => { if (helperNeeded && readiness.key === 'ready') guide.report({ type: 'helper' }); }, [readiness.key]);
  useEffect(() => { pendingIntent.current = null; }, [cloudSession?.pairCancel, helperSession?.pairCancel]);
  useEffect(() => {
    alive.current = true;
    const cancelIntent = () => { pendingIntent.current = null; };
    window.addEventListener('pagehide', cancelIntent);
    return () => { alive.current = false; cancelIntent(); clearTimeout(highlightTimer.current); window.removeEventListener('pagehide', cancelIntent); };
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
    else { focusNode(intent.nodeId); notify('Prompt changed — review and click Generate'); }
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
      if (dirty.current) cloudSession.apply({ nodes: nodeRef.current, edges: edgeRef.current, groups: groupRef.current, runs: cloudBase.current.runs, pages: storedPages(pagesRef.current, cloudBase.current.pages) }, cloudBase.current);
      const graph = cloudSession.read({ nodes: nodeRef.current, edges: edgeRef.current, groups: groupRef.current });
      if (!feedbackSeeded.current || feedback) effects.observeGraph(graph, feedback || {});
      feedbackSeeded.current = true;
      cloudBase.current = graph; dirty.current = false;
      putPages(boardPages(graph)); putNodes(graph.nodes); putEdges(graph.edges); putGroups(graph.groups);
      setRuns(graph.runs.map(run => ({ ...run, createdAt: run.createdAt || run.startedAt, outputIds: run.outputIds || [] })));
    } finally { applyingCloud.current = false; }
  };
  const markDirty = (drag = false) => {
    if (cloudSession) {
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
    const signature = historySignature(nodeRef.current, edgeRef.current, groupRef.current, pagesRef.current);
    if (signature !== lastHistory.current) { const snapshot = capture(nodeRef.current, edgeRef.current, groupRef.current, pagesRef.current, remoteGroups.current.version, remoteCaptions.current.version, runs.filter(busy).map(run => run.id)); history.current.push(snapshot); history.current = history.current.slice(-50); lastHistory.current = signature; future.current = []; return snapshot; }
    return null;
  };
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
    const signature = historySignature(nodeRef.current, edgeRef.current, groupRef.current, pagesRef.current);
    if (signature !== JSON.stringify({ nodes: snapshot.nodes, edges: snapshot.edges, groups: snapshot.groups, pages: snapshot.pages })) return restored;
    history.current.pop();
    const previous = history.current.at(-1) && JSON.parse(history.current.at(-1));
    lastHistory.current = previous ? JSON.stringify({ nodes: previous.nodes, edges: previous.edges, groups: previous.groups, pages: previous.pages }) : '';
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
    base.current = remote;
    if (newNodes.length) notify(`${newNodes.length} new image${newNodes.length === 1 ? '' : 's'} added to your canvas`);
  };
  const saveNow = async () => {
    if (cloudSession) { syncCloud(); if (cloudOfflineEdits.current && !cloudSession.provider.synced) throw new Error('Reconnect before leaving this board so your offline edits can sync.'); return; }
    clearTimeout(saveTimer.current);
    if (saving.current) { await saving.current; if (dirty.current) return saveNow(); return; }
    if (!dirty.current) return;
    const save = async () => {
      for (let attempt = 0; attempt < 8 && dirty.current; attempt++) {
        const editVersion = version.current;
        const payload = { revision: base.current.revision, nodes: cleanNodes(nodeRef.current), edges: cleanEdges(edgeRef.current), groups: cleanGroups(groupRef.current), pages: storedPages(pagesRef.current, base.current.pages), viewport: viewport.current };
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
      if (dirty.current) throw new Error('Canvas is changing too quickly to save. Try again in a moment.');
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
      cloudSession.leave = callback => {
        if (uploads.current || quitState.current.starting) { notify('Wait for the current transfer to finish before leaving this board.'); return; }
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
      flushSync(() => { putPages(boardPages(graph)); putNodes(graph.nodes); putEdges(graph.edges); putGroups(graph.groups || []); setRuns(graph.runs); setSaved('All changes saved'); });
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
        if (result.success) notify('Signed in to ChatGPT.');
        else if (result.reason !== 'cancelled') notify('Sign-in did not complete. Try again.');
      });
      events.addEventListener('graph', event => {
        if (mcpEnabled && !editorReady.current) { synchronize(); return; }
        const graph = JSON.parse(event.data); effects.observeGraph(graph, { live: feedbackLive }); feedbackLive = true; mergeRemote(graph); setRuns(graph.runs);
      });
      events.addEventListener('run', event => {
        const run = JSON.parse(event.data);
        effects.observeRun(run, feedbackLive);
        setRuns(current => { const old = current.find(r => r.id === run.id); return old ? current.map(r => r.id === run.id ? { ...r, ...run } : r) : [...current, run]; });
        if (['completed', 'cancelled', 'error'].includes(run.status) && run.captionMissing > 0) notify('Some images have generic labels. Click a label to edit it.');
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
      base.current = graph; putPages(boardPages(graph)); putNodes(graph.nodes); putEdges(graph.edges); putGroups(graph.groups || []); setRuns(graph.runs); setStatus(nextStatus);
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

  const addText = (position, text = '', template = null) => {
    checkpoint();
    const node = placeOnPage({ id: id(), type: 'text', z: nextLayer(nodeRef.current), position: position || freeSpot(pageGraph(), flow.screenToFlowPosition({ x: innerWidth * .52, y: innerHeight * .36 })), data: { text, createdAt: new Date().toISOString(), ...(template ? { labelOutputs: !!template.labelOutputs, template: templateSnapshot(template) } : {}) } });
    effects.createNodes([node.id]);
    putNodes(current => [...current.map(n => ({ ...n, selected: false })), { ...node, selected: true }]); markDirty();
    focusNode(node.id); guide.report({ type: 'prompt' });
    return node;
  };
  const promptFrom = sourceId => {
    if (mcpLocked.current || !loaded || switchingRef.current) return;
    if (!['text', 'image'].includes(nodeRef.current.find(node => node.id === sourceId)?.type)) return;
    try {
      const node = addText(freePromptPosition(pageGraph(), sourceId));
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
    if (templateId && !template) { notify('Custom node no longer exists.'); return; }
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
    const { template } = await api(existing ? `/api/templates/${existing.id}` : '/api/templates', jsonOptions(existing ? 'PUT' : 'POST', existing ? { ...value, expected: existing } : value));
    setTemplates(current => existing ? current.map(item => item.id === template.id ? template : item) : [...current.filter(item => item.id !== template.id), template]);
    setTemplateForm(null);
  };
  const deleteTemplate = async () => {
    const existing = templateForm?.template;
    if (!existing) return;
    await api(`/api/templates/${existing.id}`, jsonOptions('DELETE', { expected: existing }));
    setTemplates(current => current.filter(item => item.id !== existing.id));
    setTemplateForm(null);
  };
  const addImages = async (files, position) => {
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
    if (!selection.nodes.length) return;
    let copied;
    try { copied = cloneSelection(selection, position, duplicate ? { nodes: nodeRef.current, edges: edgeRef.current, groups: groupRef.current, pages: pagesRef.current } : selection); }
    catch (error) { notify(error.message); return; }
    copied = { ...copied, nodes: stackOnTop(nodeRef.current, copied.nodes).map(placeOnPage) };
    checkpoint();
    effects.createNodes(copied.nodes.map(node => node.id)); effects.createEdges(copied.edges.map(edge => edge.id), copied.edges.map(edge => edge.target));
    putNodes(current => [...current.map(node => ({ ...node, selected: false })), ...copied.nodes]);
    putEdges(current => [...current.map(edge => ({ ...edge, selected: false })), ...copied.edges]);
    putGroups(current => current.map(group => ({ ...group, selected: false })));
    markDirty();
    const prompt = copied.nodes.find(node => node.type === 'text');
    if (prompt) { focusNode(prompt.id, 'text', true); guide.report({ type: 'prompt' }); }
  };
  const removeNodes = (ids, selectedEdges = false) => {
    if (mcpLocked.current) return;
    checkpoint(); const removed = new Set(ids);
    const next = reconcileStampAttachments(nodeRef.current, nodeRef.current.filter(node => !removed.has(node.id)));
    const retained = new Set(next.map(node => node.id));
    for (const node of nodeRef.current) if (!retained.has(node.id)) removed.add(node.id);
    effects.remove([...removed]); putNodes(next);
    putEdges(current => current.filter(e => !(selectedEdges && e.selected) && !removed.has(e.source) && !removed.has(e.target)));
    putGroups(pruneGroups(groupRef.current.filter(group => !removed.has(group.id)), nodeRef.current)); markDirty();
  };
  const removeSelected = () => { const scoped = pageGraph(); removeNodes([...scoped.nodes.filter(n => n.selected).map(n => n.id), ...scoped.groups.filter(group => group.selected).map(group => group.id)], true); };
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
    to.push(capture(nodeRef.current, edgeRef.current, groupRef.current, pagesRef.current, remoteGroups.current.version, remoteCaptions.current.version, runs.filter(busy).map(run => run.id)));
    const snapshot = from.pop(); lastHistory.current = snapshot;
    const graph = JSON.parse(snapshot);
    const freshOutputs = freshOutputNodes(nodeRef.current, graph, runRef.current);
    const ids = new Set([...graph.nodes, ...freshOutputs].map(n => n.id));
    const freshEdges = edgeRef.current.filter(e => freshOutputs.some(n => n.id === e.target) && ids.has(e.source) && !graph.edges.some(old => old.id === e.id));
    const addedGroups = new Set([...remoteGroups.current.added].filter(([, version]) => version > (graph.remoteGroupVersion || 0)).map(([id]) => id));
    const restoredGroups = preserveFreshOutputGroups(graph.groups || [], groupRef.current, [...graph.nodes, ...freshOutputs], freshOutputs, addedGroups);
    const restoredNodes = restoreFirstImageFallback(preserveRemoteImageCaptions(graph.nodes, nodeRef.current, remoteCaptions.current.added, graph.remoteCaptionVersion || 0), nodeRef.current, runs, graph);
    putPages(graph.pages || defaultPages()); putNodes([...restoredNodes, ...freshOutputs]); putEdges([...graph.edges, ...freshEdges]); putGroups(restoredGroups); markDirty();
  };

  const groupSelected = () => {
    const members = pageGraph().nodes.filter(node => node.selected);
    if (members.length < 2 || groupRef.current.some(group => group.selected || group.nodeIds.some(id => members.some(node => node.id === id)))) return;
    checkpoint();
    const usedNames = new Set(groupRef.current.map(group => group.name));
    let number = 1; while (usedNames.has(`Group ${number}`)) number++;
    putGroups(current => [...current.map(group => ({ ...group, selected: false })), { id: id(), name: `Group ${number}`, nodeIds: members.map(node => node.id), collapsed: false, selected: true }]);
    putNodes(current => current.map(node => ({ ...node, selected: false }))); markDirty();
  };
  const editGroup = (groupId, patch) => {
    if (mcpLocked.current) return;
    const group = groupRef.current.find(group => group.id === groupId);
    if (!group || Object.entries(patch).every(([key, value]) => group[key] === value)) return;
    checkpoint();
    putGroups(current => current.map(group => {
      if (group.id !== groupId) return group;
      const next = { ...group, ...patch };
      if (next.color === undefined) delete next.color;
      return next;
    })); markDirty();
  };
  const editAnnotation = (nodeId, patch) => {
    if (mcpLocked.current) return;
    const node = nodeRef.current.find(node => node.id === nodeId);
    if (!isAnnotation(node)) return;
    checkpoint(); putNodes(current => current.map(node => node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node)); markDirty();
  };
  const addAnnotation = value => {
    if (mcpLocked.current || !loaded || switchingRef.current) return;
    if (nodeRef.current.length >= 2000) { notify('Canvas is too large.'); return; }
    const author = value.type !== 'drawing' && boardAuthor(cloudSession?.user);
    const node = placeOnPage({ ...value, id: id(), z: nextLayer(nodeRef.current), selected: true, data: { ...value.data, createdAt: new Date().toISOString(), ...(author ? { author } : {}) } });
    checkpoint();
    putNodes(current => [...current.map(node => ({ ...node, selected: false })), node]);
    putGroups(current => current.map(group => ({ ...group, selected: false }))); markDirty();
    if (node.type === 'sticky') { setFocusControl('sticky'); setFocusId(node.id); }
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
    } else {
      const attachedTo = stampTargetAt(flow.getNodes(), position);
      addAnnotation({ type: 'stamp', position: { x: position.x - 24, y: position.y - 24 }, data: { kind: stamp, ...(attachedTo === undefined ? {} : { attachedTo }) } });
    }
  };
  const annotationMove = event => {
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
  const toggleNodeCollapsed = nodeId => {
    if (mcpLocked.current || !nodeRef.current.some(node => node.id === nodeId)) return;
    checkpoint();
    putNodes(current => current.map(node => node.id === nodeId ? { ...node, data: { ...node.data, collapsed: !node.data.collapsed } } : node));
    markDirty();
  };
  const toggleGroup = groupId => {
    checkpoint();
    const group = groupRef.current.find(group => group.id === groupId);
    putNodes(current => current.map(node => group.nodeIds.includes(node.id) ? { ...node, selected: false } : node));
    putGroups(current => current.map(group => group.id === groupId ? { ...group, collapsed: !group.collapsed } : group)); markDirty();
  };
  const ungroup = groupId => { checkpoint(); putGroups(current => current.filter(group => group.id !== groupId)); markDirty(); };
  const autoAlign = () => {
    const scoped = pageGraph(), aligned = new Map(alignNodes(scoped.nodes, scoped.edges, scoped.groups).map(node => [node.id, node]));
    checkpoint(); putNodes(current => current.map(node => aligned.get(node.id) || node)); markDirty();
    requestAnimationFrame(() => flow.fitView({ duration: 300, padding: .18, maxZoom: 1 }));
  };
  const addPage = () => {
    if (mcpLocked.current || !loaded || switchingRef.current) return null;
    if (pagesRef.current.length >= maxPages) { notify(`A board can have at most ${maxPages} pages.`); return null; }
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
    if (pagesRef.current.length < 2) { notify('A board needs at least one page.'); return; }
    if (pageBusy(pageId)) { notify('Wait for generation on this page to finish before deleting it.'); return; }
    setPageDelete({ id: page.id, name: page.name, count: nodeRef.current.filter(node => nodePage(node, pagesRef.current) === pageId).length, returnFocus: document.activeElement });
  };
  const deletePage = pageId => {
    if (mcpLocked.current || pagesRef.current.length < 2 || !pagesRef.current.some(page => page.id === pageId)) return;
    if (pageBusy(pageId)) { notify('Wait for generation on this page to finish before deleting it.'); return; }
    checkpoint();
    const list = pagesRef.current, index = list.findIndex(page => page.id === pageId), removed = new Set(nodeRef.current.filter(node => nodePage(node, list) === pageId).map(node => node.id));
    const next = reconcileStampAttachments(nodeRef.current, nodeRef.current.filter(node => !removed.has(node.id)));
    effects.remove([...removed]); putNodes(next);
    putEdges(current => current.filter(edge => !removed.has(edge.source) && !removed.has(edge.target)));
    putGroups(pruneGroups(groupRef.current, next));
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
      if (targets.length) flow.fitView({ nodes: targets, duration: 350, padding: .25, minZoom: .01, maxZoom: 1 });
    });
  };
  const nodesChanged = changes => {
    if (mcpLocked.current && changes.some(change => ['position', 'remove', 'add', 'replace', 'select'].includes(change.type))) return;
    const groupIds = new Set(groupRef.current.map(group => group.id)), moved = new Set();
    const before = nodeRef.current;
    let next = before;
    for (const change of changes.filter(change => groupIds.has(change.id))) {
      if (change.type === 'select') putGroups(current => current.map(group => group.id === change.id ? { ...group, selected: change.selected } : group));
      if (change.type === 'position' && change.position) {
        const group = groupRef.current.find(group => group.id === change.id);
        next = moveGroup(next, group, change.position, false); group.nodeIds.forEach(id => moved.add(id));
      }
    }
    putNodes(reconcileStampAttachments(before, applyNodeChanges(changes.filter(change => !groupIds.has(change.id) && !(change.type === 'position' && moved.has(change.id))), next)));
    if (changes.some(change => change.type === 'remove')) {
      const retained = new Set(nodeRef.current.map(node => node.id));
      effects.remove(before.filter(node => !retained.has(node.id)).map(node => node.id));
      putEdges(current => current.filter(edge => retained.has(edge.source) && retained.has(edge.target)));
      putGroups(pruneGroups(groupRef.current, nodeRef.current));
    }
    if (changes.some(change => change.type === 'position' || change.type === 'remove')) markDirty(cloud && changes.every(change => change.type !== 'remove') && changes.some(change => change.dragging));
  };

  const nodeDragStopped = (event, node) => {
    effects.dragStop(event, node); moving.current = false;
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
      Promise.resolve(copied).then(() => notify('Image copied.')).catch(error => notify(error.message || 'Could not copy the image.'));
    } catch (error) { notify(error.message || 'Could not copy the image.'); }
  };
  const copyNodeId = value => {
    const text = Array.isArray(value) ? value.join('\n') : value;
    if (!text || mcpLocked.current) return;
    const fallback = () => {
      const field = document.createElement('textarea');
      field.value = text; field.style.position = 'fixed'; field.style.opacity = '0'; document.body.appendChild(field); field.select();
      const ok = document.execCommand('copy'); field.remove();
      if (!ok) throw new Error('Could not copy the ID.');
    };
    try {
      if (navigator.clipboard?.writeText) Promise.resolve(navigator.clipboard.writeText(text)).then(() => notify('ID copied.')).catch(() => { try { fallback(); notify('ID copied.'); } catch { notify('Could not copy the ID.'); } });
      else { fallback(); notify('ID copied.'); }
    } catch { notify('Could not copy the ID.'); }
  };

  useEffect(() => {
    if (!loaded) return;
    const paste = async event => {
      if (mcpLocked.current || modalOpen.current) return;
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
            if (!response.ok) throw new Error('A copied image is unavailable in this app installation.');
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
      const scoped = pageGraph(), selection = selectedGraph(scoped.nodes, scoped.edges);
      if (!selection.nodes.length) return;
      event.preventDefault();
      if (selection.nodes.length === 1 && selection.nodes[0].type === 'image') { copyImage(selection.nodes[0].id); return; }
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
        const scoped = pageGraph(), ids = [...scoped.nodes.filter(node => node.selected).map(node => node.id), ...scoped.groups.filter(group => group.selected).map(group => group.id)];
        if (ids.length) { event.preventDefault(); copyNodeId(ids); }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        if (document.activeElement?.matches('.text-node textarea')) document.activeElement.blur();
        const scoped = pageGraph(); insertSelection(selectedGraph(scoped.nodes, scoped.edges), undefined, true); return;
      }
      if (event.target.closest('textarea,input,[contenteditable="true"]')) return;
      const layer = layerShortcut(event);
      if (layer) { event.preventDefault(); arrange(layer); return; }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const tool = { v: 'select', p: 'pen', s: 'sticky', e: 'stamp' }[event.key.toLowerCase()];
        if (tool) { event.preventDefault(); chooseTool(tool); return; }
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
    if (!alive.current || pairing || mcpLocked.current) return;
    let requested;
    try { requested = generationIntent(currentGraph(), boardId, nodeId); }
    catch (error) { notify(error.message); return; }
    if (starting || generationStarting.current) return;
    if (readinessRef.current.key !== 'ready') {
      pendingIntent.current = requested; fixReadiness();
      return;
    }
    effects.start(nodeId, event);
    generationStarting.current = true;
    setStarting(nodeId);
    try {
      await saveNow();
      if (resumeIntent && !intentUnchanged(resumeIntent, currentGraph(), boardId)) { focusNode(nodeId); notify('Prompt changed — review and click Generate'); return; }
      if (cloudSession) { await cloudSession.jobs.start(nodeId, readinessRef.current.delegate); return; }
      const options = jsonOptions('POST', { nodeId, revision: base.current.revision });
      if (editorId.current) options.headers['X-Concept-Graph-UI-Session'] = editorId.current;
      const result = await api(boardPath + '/runs', options);
      trackOwnRun(result.id);
      setRuns(current => current.some(r => r.id === result.id) ? current : [...current, result]);
    } catch (error) {
      effects.failedStart();
      if (error.value?.graph) mergeRemote(error.value.graph);
      if (helperNeeded && (error.status === 403 || error instanceof TypeError)) {
        pendingIntent.current = requested;
        if (cloudSession) cloudSession.unpair(); setHelperOffline(true); openHelper();
      }
      notify(error.message);
    }
    finally { generationStarting.current = false; setStarting(null); }
  };
  runAction.current = run;
  const cancel = async runId => { pendingIntent.current = null; try { if (cloudSession) { if (!cloudSession.paired && !cloudSession.jobs.delegated(runId)) return cloudSession.openPair(() => cancel(runId)); await cloudSession.jobs.cancel(runId); } else await api(`${boardPath}/runs/${runId}/cancel`, { method: 'POST' }); } catch (error) { notify(error.message); } };
  const connect = connection => {
    if (mcpLocked.current) return;
    if (!['text', 'image'].includes(nodeRef.current.find(node => node.id === connection.source)?.type)) return;
    if (nodeRef.current.find(n => n.id === connection.target)?.type !== 'text') { notify('Connect inputs to a text prompt. Run creates image connections automatically.'); return; }
    const reachable = new Set();
    const walk = nodeId => { if (reachable.has(nodeId)) return; reachable.add(nodeId); edgeRef.current.filter(e => e.source === nodeId).forEach(e => walk(e.target)); };
    walk(connection.target);
    if (reachable.has(connection.source)) { notify('That connection would create a loop. Branch into a new prompt instead.'); return; }
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
    if (!edgeDropCreatesPrompt(state, onPane)) return;
    const position = flow.screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY });
    const node = addText({ x: position.x, y: position.y - 40 });
    const edge = { id: id(), source: state.fromNode.id, target: node.id }; effects.createEdges([edge.id], [edge.target]);
    putEdges(current => [...current, edge]); setFocusId(node.id); markDirty();
    if (state.fromNode.type === 'image') guide.report({ type: 'variation' });
  };
  const downloadImage = async asset => {
    try {
      const response = await request(`/assets/${asset}`);
      if (!response.ok) throw new Error('Could not download image.');
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
      if (!response.ok) throw new Error((await response.json()).error || 'Could not export board.');
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
      if (file.size > 512 * 1024 * 1024) throw new Error('Choose a .conceptgraph file no larger than 512 MB.');
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
      if (desktopMode && !next.connected) notify('Codex could not connect. Use Set Up Codex… on Mac or Codex → Set Up Compatible Codex… on Windows to install a compatible copy.');
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
      else { notify('Generate an image first, then choose + Prompt from this.'); gettingStartedStep('generate'); }
    }
  };
  const view = canvasView(scoped.nodes, scoped.edges, scoped.groups);
  view.edges = view.edges.map(edge => effects.edges.has(edge.id) ? { ...edge, type: 'feedback', className: 'feedback-edge' } : edge);
  const fitNodes = view.nodes.filter(node => node.selected && !node.hidden);
  const viewNode = nodes.find(node => node.id === viewId);
  const viewRun = runs.find(run => run.id === viewNode?.data.runId);
  const viewInputs = viewRun?.snapshot?.filter(node => node.id !== viewRun.nodeId) || [];
  const viewInfo = viewNode && imageInfo(viewNode, runs, viewSize?.asset === viewNode.data.asset ? viewSize : undefined);
  const selectedNodes = scoped.nodes.filter(n => n.selected), selectedCount = selectedNodes.length + scoped.groups.filter(group => group.selected).length;
  const canGroup = selectedNodes.length >= 2 && !groups.some(group => group.selected || group.nodeIds.some(id => selectedNodes.some(node => node.id === id)));
  const inputs = useMemo(() => directInputCounts({ nodes, edges }), [nodes, edges]);
  const actions = { renamingGroup, renameGroup: setRenamingGroup, editGroup, editAnnotation, removeNode: nodeId => removeNodes([nodeId]), dictationLanguage, effects, user: cloudSession?.user, inputs, readiness, fixReadiness, promptFrom, highlight, focusControl, runs, edges, now, starting, openRunDetails, checkpoint, cancelCaption, copyImage, copyNodeId, arrange, templates, saveTemplateFromNode, switchTemplate, focusId, clearFocus: () => setFocusId(null), toggleNodeCollapsed, toggleGroup, ungroup, editText: (nodeId, text) => { if (mcpLocked.current) return; putNodes(current => current.map(node => node.id === nodeId ? { ...node, data: { ...node.data, text } } : node)); markDirty(); }, editCaption: (nodeId, caption) => { if (mcpLocked.current) return; putNodes(current => current.map(node => node.id === nodeId ? { ...node, data: { ...node.data, caption } } : node)); markDirty(); }, run, cancel, view: setViewId, viewTemplate: setTemplateDetails };

  const blockWhenLocked = event => { if (mcpLocked.current) { event.preventDefault(); event.stopPropagation(); } };
  return <Actions.Provider value={actions}><div className="app-shell" data-cloud={cloud || undefined} data-theme={theme} inert={mcpBusy || pairing ? true : undefined} aria-busy={mcpBusy} onKeyDownCapture={blockWhenLocked} onClickCapture={blockWhenLocked} onDropCapture={blockWhenLocked} onInputCapture={blockWhenLocked} onBeforeInputCapture={blockWhenLocked} onPointerDownCapture={blockWhenLocked} onWheelCapture={blockWhenLocked} onPasteCapture={blockWhenLocked}>
    <header className="app-header"><div className="brand"><img src="/favicon.svg" alt=""/><strong>Concept Graph</strong></div><div className="save-state"><span className={(cloud ? cloudSession.connection === 'live' : saved === 'All changes saved') ? 'saved-dot' : 'saving-dot'}/>{cloud ? cloudSession.connection === 'live' ? 'Live' : cloudSession.connection === 'offline' ? 'Offline · edits kept in this tab' : 'Connecting…' : transfer === 'export' ? 'Exporting board…' : transfer === 'import' ? 'Importing board…' : switching ? 'Switching board…' : saved}</div><div className="header-right">{cloudSession?.toolbar}{desktopMode && <button className="mcp-connect-button" type="button" aria-label="Connect MCP" onClick={() => setAgentConnect(true)} data-tooltip="Connect MCP"><Icon name="branch" size={15}/><span>Connect MCP</span></button>}{(!cloud || cloudSession.paired) && <UsageLimit status={status} version={limitsVersion}/>}<button className="theme-button" type="button" aria-label={`Sounds ${effects.sounds ? 'on' : 'off'}`} aria-pressed={effects.sounds} data-tooltip={`Sounds ${effects.sounds ? 'on' : 'off'}`} onClick={effects.toggleSounds}><Icon name={effects.sounds ? 'sound' : 'muted'}/></button><button className="getting-started-help" type="button" aria-label="Getting started" data-tooltip="Getting started and canvas tips" onClick={guide.reopen}>?</button><button className="theme-button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} data-tooltip={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={toggleTheme}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18}/></button>{helperNeeded ? <HelperConnection effects={effects} readiness={readiness} status={status} paired={!helperOffline && (cloud ? cloudSession.paired : !!helperSession?.paired)} onSetup={openHelper} onDownloads={openHelperDownloads} onFix={fixReadiness} onDisconnect={cloudSession ? () => cloudSession.unpair(false) : null} loginBusy={loginBusy}/> : <button className={`connection ${status.connected && status.signedIn && status.imageGeneration ? 'connected' : ''}`} disabled={loginBusy} onClick={desktopMode && status.connected && !status.signedIn ? startLogin : checkCodex} data-tooltip={status.error || 'Check Codex connection'}><span/>{status.connected && status.signedIn && status.imageGeneration ? 'Codex connected' : desktopMode && status.connected && !status.signedIn ? 'Sign in with ChatGPT' : cloud && !cloudSession.paired ? 'Pair helper' : 'Check Codex'}</button>}</div></header>
    <aside className="sidebar" inert={!!transfer || switching ? true : undefined}>
      <div className="board-heading"><span className="eyebrow">YOUR BOARDS</span><div className="board-picker"><select data-tooltip="Switch board" aria-label="Board" value={boardId} disabled={switching || !!transfer || uploading || !!starting || !loaded} onChange={event => changeBoard(event.target.value)}>{boards.map(board => <option key={board.id} value={board.id}>{board.name}</option>)}</select><button data-tooltip="Rename board" aria-label="Rename board" className="icon-button" disabled={switching || !!transfer || !loaded} onClick={() => { originalBoardName.current = currentBoard?.name || ''; setNameDraft(originalBoardName.current); setBoardForm('rename'); }}><Icon name="edit" size={15}/></button></div><button className="new-board" data-tooltip="Create a new board" disabled={switching || !!transfer || uploading || !!starting || !loaded} onClick={() => { setNameDraft(''); setBoardForm('create'); }}><Icon name="plus" size={15}/> New board</button>{!cloud && <div className="board-transfer"><button data-tooltip="Save this board with its images" aria-label="Export board" disabled={switching || !!transfer || uploading || !!starting || !loaded} onClick={exportBoard}><Icon name="download" size={14}/> Export</button><button data-tooltip="Import a .conceptgraph file as a new board" aria-label="Import board" disabled={switching || !!transfer || uploading || !!starting || !loaded} onClick={() => boardFileInput.current.click()}><Icon name="upload" size={14}/> Import</button></div>}</div>
      <BoardPages pages={pages} active={activePage} peers={cloudSession?.peers || []} disabled={!loaded || switching || !!transfer || mcpBusy} onSelect={pageId => showPage(pageId)} onAdd={addPage} onRename={renamePage} onDelete={requestPageDelete}/>
      <div className="sidebar-tabs"><button data-tooltip="Show creation tools" className={tab === 'canvas' ? 'active' : ''} onClick={() => setTab('canvas')}>Create</button><button data-tooltip="View generation history" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>History <small>{runs.length}</small></button></div>
      {tab === 'canvas' ? <><div className="tool-list"><button disabled={!loaded || switching || !!transfer} data-tooltip="Add text prompt · T" aria-label="Add text prompt" className="add-prompt-tool" onClick={() => addText()}><span className="tool-icon text"><Icon name="text"/></span><span>+ Add text prompt</span><kbd>T</kbd></button><button disabled={!loaded || switching || !!transfer} data-tooltip="Upload reference images" aria-label="Add reference image" onClick={() => fileInput.current.click()}><span className="tool-icon image"><Icon name="image"/></span><span>Reference image</span></button></div><section className="custom-nodes" aria-label="Custom nodes"><div className="custom-nodes-heading"><span className="eyebrow">CUSTOM NODES</span><button type="button" className="icon-button" aria-label="Create custom node" data-tooltip="Create custom node" disabled={!loaded || switching || !!transfer} onClick={() => setTemplateForm({ template: null })}><Icon name="plus" size={15}/></button></div>{templatesError ? <button className="custom-retry" type="button" onClick={refreshTemplates}>{templatesError} Retry</button> : templates.length ? <div className="custom-nodes-list">{templates.map(template => <div className="custom-node-row" key={template.id}><button className="custom-node-add" type="button" onClick={() => addText(undefined, '', template)} data-tooltip="Add custom node to board"><span className="custom-node-glyph"><Icon name="text" size={14}/></span><span>{template.name}</span></button><button className="icon-button custom-node-edit" type="button" aria-label={`Edit ${template.name}`} data-tooltip="Edit custom node" onClick={() => setTemplateForm({ template })}><Icon name="edit" size={13}/></button></div>)}</div> : <p className="custom-nodes-empty">Save instructions and images to use again.</p>}</section><p className="paste-hint"><kbd>⌘ V</kbd> Paste text or an image.<br/>Drag a node’s output into empty space to add a prompt.<br/>Select nodes, then group them with the bottom toolbar.</p></> : <div className="history-list">{!runs.length && <p className="empty-history">Generations on this board will appear here.</p>}{[...runs].reverse().map(run => <div className={`history-item ${run.status}`} key={run.id}><button className="history-focus" data-tooltip="Show this generation" onClick={() => showRun(run)}><span className="history-status"><Icon name={run.status === 'completed' ? 'check' : 'clock'} size={14}/> {busy(run) ? runTiming(run, runs, now).label : run.status}</span><strong>{run.label}</strong><small>{new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {run.outputIds.length} image{run.outputIds.length === 1 ? '' : 's'}{pages.length > 1 && ` · ${pages.find(page => page.id === resolvePage(pages, run.page))?.name}`}</small></button>{busy(run) && (!cloud || run.by?.name === cloudSession.user.name) && <button className="cancel-link" data-tooltip="Cancel generation" onClick={() => cancel(run.id)}>Cancel run</button>}{run.error && <p>{run.error}</p>}{!cloud && <button type="button" className="run-details-link" onClick={() => openRunDetails(run.id)}>Run details</button>}</div>)}</div>}
      <div className="sidebar-bottom"><span className="legend-text"/> Text <span className="legend-image"/> Image</div>
    </aside>
    <main ref={canvasElement} data-board-tool={tool} onClickCapture={annotationClick} onDoubleClickCapture={annotationClick} onTouchStartCapture={event => { if (toolRef.current !== 'select' && event.target.closest('.react-flow')) event.stopPropagation(); }} onPointerDownCapture={annotationDown} onPointerMoveCapture={annotationMove} onPointerUpCapture={event => annotationUp(event)} onPointerCancelCapture={event => annotationUp(event, true)} onLostPointerCapture={event => annotationUp(event, true)} className={`canvas${fileOver ? ' file-drag-over' : ''}`} inert={switching || !!transfer || !loaded ? true : undefined} onPointerMove={event => { mouse.current = { x: event.clientX, y: event.clientY }; cloudSession?.pointer(flow.screenToFlowPosition(mouse.current)); }} onPointerLeave={() => cloudSession?.pointer(null)} onDragOver={event => { event.preventDefault(); if (!mcpLocked.current && [...event.dataTransfer.types].includes('Files')) { event.dataTransfer.dropEffect = 'copy'; setFileOver(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFileOver(false); }} onDrop={event => { event.preventDefault(); setFileOver(false); if (!mcpLocked.current) addImages([...event.dataTransfer.files], flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}>
      <div className="canvas-top"><span>{currentBoard?.name}</span>{loaded && <GenerationTray launching={!!starting} runs={runs} user={cloudSession?.user} onCancel={cancel} onFocus={showRun}/>}</div>
      <ReactFlow nodes={view.nodes} edges={view.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} elevateNodesOnSelect={false} onNodesChange={nodesChanged} onEdgesChange={changes => { if (mcpLocked.current) return; putEdges(current => applyEdgeChanges(changes, current)); if (changes.some(c => c.type !== 'select')) markDirty(); }} onConnect={connect} onConnectStart={(_, params) => { if (mcpLocked.current) return; connecting.current = true; setConnectionType(nodeRef.current.find(n => n.id === params.nodeId)?.type || 'text'); }} onConnectEnd={connectEnd} connectionLineStyle={{ stroke: connectionColor(connectionType), strokeWidth: 2 }} onNodeDragStart={(event, node) => { if (mcpLocked.current) return; effects.dragStart(event, node); moving.current = true; checkpoint(); }} onNodeDrag={(event, node) => { if (!mcpLocked.current) effects.dragMove(event, node); }} onNodeDragStop={nodeDragStopped} onMoveStart={event => {
        moving.current = true;
        if (event) viewerMoved.current = true;
        // A canvas gesture keeps ownership when the pointer crosses an editor.
        if (document.activeElement?.matches('.text-node textarea')) document.activeElement.blur();
      }} onMoveEnd={(_, view) => {
        moving.current = false; if (mcpLocked.current) return;
        if (openingViewDone.current) { pagePreference.current.viewports[activePageRef.current] = view; rememberPage(); }
        // The board's saved viewport remains the first page's fallback.
        if (activePageRef.current === defaultPageId) { viewport.current = view; if (loaded && !cloud) markDirty(); }
      }} onPaneClick={() => setViewId(null)} zoomOnDoubleClick={tool === 'select'} nodesDraggable={tool === 'select'} nodesConnectable={tool === 'select'} elementsSelectable={tool === 'select'} defaultEdgeOptions={{ type: 'default' }} minZoom={.15} maxZoom={2} deleteKeyCode={null} panOnScroll selectionOnDrag={tool === 'select'} panOnDrag={[1, 2]} selectionKeyCode="Shift" multiSelectionKeyCode="Meta" proOptions={{ hideAttribution: true }}>
        <Background color="var(--grid)" gap={24} size={1}/>{cloudSession?.cursors(peer => resolvePage(pages, peer.page) === activePage)}<StrokePreview ref={strokePreview}/>
      </ReactFlow>
      {loaded && !scoped.nodes.length && tool === 'select' && <div className="empty-board"><div className="empty-glyph"><Icon name="branch" size={36}/></div><span className="eyebrow">ONE IDEA. MANY DIRECTIONS.</span><h2>What are you imagining?</h2><p>Describe an image, then click Generate.</p><button className="primary-button" onClick={() => addText()}><Icon name="plus" size={16}/> Add text prompt</button></div>}
      <GettingStarted effects={effects} guide={guide} helperNeeded={helperNeeded} ready={readiness.key === 'ready'} onStep={gettingStartedStep} onDownloadHelper={openHelperDownloads} disabled={!loaded || switching || !!transfer}/>
      <div className="canvas-bottom"><div className="canvas-controls"><AnnotationTools tool={tool} onTool={chooseTool} pen={pen} setPen={setPen} stickyColor={stickyColor} setStickyColor={setStickyColor} stamp={stamp} setStamp={setStamp}/><i/><button data-tooltip="Undo · ⌘ Z" aria-label="Undo" onClick={() => undo()}><Icon name="undo" size={17}/></button><button data-tooltip="Redo · ⌘ Shift Z" aria-label="Redo" onClick={() => undo(true)}><Icon name="redo" size={17}/></button><i/><button data-tooltip="Zoom out" aria-label="Zoom out" onClick={() => flow.zoomOut({ duration: 150 })}><Icon name="minus" size={16}/></button><button data-tooltip={fitNodes.length ? "Fit selected nodes in view" : "Fit all nodes in view"} aria-label="Fit canvas" onClick={() => flow.fitView({ nodes: fitNodes.length ? fitNodes : undefined, duration: 300, padding: .2, maxZoom: 1 })}><Icon name="expand" size={16}/></button><button data-tooltip="Zoom in" aria-label="Zoom in" onClick={() => flow.zoomIn({ duration: 150 })}><Icon name="plus" size={16}/></button><i/><button data-tooltip="Align left to right · center parents" aria-label="Auto-align all nodes" disabled={!scoped.nodes.length} onClick={autoAlign}><Icon name="align" size={18}/></button><button data-tooltip={canGroup ? "Group selected nodes" : "Select 2+ ungrouped nodes"} aria-label="Group selected nodes" disabled={!canGroup} onClick={groupSelected}><Icon name="group" size={18}/></button>{selectedCount > 0 && <><i/><button data-tooltip="Delete selected" aria-label="Delete selected" onClick={removeSelected}><Icon name="trash" size={16}/></button></>}</div><span className="canvas-stats">{scoped.nodes.length} nodes <i/> {scoped.edges.length} connections</span></div>
    </main><input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { addImages([...event.target.files]); event.target.value = ''; }}/>
    {!cloud && <input ref={boardFileInput} type="file" accept=".conceptgraph,.zip" aria-label="Board archive file" hidden onChange={event => { const file = event.target.files[0]; event.target.value = ''; importBoard(file); }}/>}
    {boardForm && <div className="board-modal" role="dialog" aria-modal="true" aria-label={boardForm === 'create' ? 'Create board' : 'Rename board'}><form onSubmit={submitBoard}><h2>{boardForm === 'create' ? 'New board' : 'Rename board'}</h2><label htmlFor="board-name">Board name</label><input id="board-name" aria-label="Board name" autoFocus maxLength={80} value={nameDraft} onChange={event => setNameDraft(event.target.value)} placeholder="A new direction" disabled={switching}/><div><button data-tooltip="Cancel" type="button" onClick={() => setBoardForm(null)} disabled={switching}>Cancel</button><button className="primary-button" data-tooltip={boardForm === 'create' ? 'Create board' : 'Save board name'} type="submit" disabled={switching || !nameDraft.trim()}>{boardForm === 'create' ? 'Create board' : 'Save name'}</button></div></form></div>}
    {pageDelete && <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="page-delete-title" onKeyDown={event => { keepDialogFocus(event); if (event.key === 'Escape') { event.stopPropagation(); setPageDelete(null); restoreDialogFocus(pageDelete.returnFocus); } }}><div className="login-card page-delete-card"><h2 id="page-delete-title">Delete “{pageDelete.name}”?</h2><p>{pageDelete.count ? `Its ${pageDelete.count} node${pageDelete.count === 1 ? '' : 's'} will be deleted with it.` : 'This page is empty.'} Generation history and image files stay. You can undo this.</p><button className="primary-button danger" type="button" autoFocus onClick={() => { const { id: pageId } = pageDelete; setPageDelete(null); deletePage(pageId); }}>Delete page</button><button type="button" onClick={() => { setPageDelete(null); restoreDialogFocus(pageDelete.returnFocus); }}>Cancel</button></div></div>}
    {diagnosticsId && runs.find(run => run.id === diagnosticsId) && <RunDiagnostics run={runs.find(run => run.id === diagnosticsId)} loadRun={loadDiagnosticRun} returnFocus={diagnosticsReturnFocus} onClose={() => setDiagnosticsId(null)}/>}
    {templateForm && <TemplateEditor templates={templates} template={templateForm.template} initial={templateForm.initial || templateForm.template} onClose={() => setTemplateForm(null)} onSave={saveTemplate} onDelete={deleteTemplate} onBusyChange={setTemplateBusy}/>}
    {templateDetails && <TemplateDetails template={templateDetails} onClose={() => setTemplateDetails(null)}/>}
    {agentConnect && <AgentConnect onClose={() => setAgentConnect(false)}/>}
    {installCodex && <InstallCodex onClose={() => setInstallCodex(false)} onDone={async () => {
      const next = await api('/api/status', { method: 'POST', helper: cloud });
      setStatus(next); setHelperOffline(false);
      if (!next.connected) throw new Error(next.error || 'Codex could not connect after installation.');
      setInstallCodex(false);
      if (!next.signedIn) await startLogin();
    }}/>}
    {showSignIn && <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="codex-welcome-title"><div className="login-card"><h2 id="codex-welcome-title">Connect your ChatGPT account</h2><p>Sign in to generate images with your Codex account. Your boards and images stay on this computer.</p><button className="primary-button" type="button" disabled={loginBusy} onClick={startLogin}>Sign in with ChatGPT</button><button type="button" disabled={loginBusy} onClick={() => setDismissSignIn(true)}>Not now</button></div></div>}
    {login && <div className="board-modal" role="dialog" aria-modal="true" aria-labelledby="codex-login-title"><div className="login-card"><h2 id="codex-login-title">Sign in with ChatGPT</h2><p>Continue in your browser to connect your account. Return here when you finish.</p><a className="primary-button" href={login.authUrl} target="_blank" rel="noreferrer" referrerPolicy="no-referrer">Continue in browser</a><button type="button" disabled={loginBusy} onClick={cancelLogin}>Cancel</button></div></div>}
    {toast && <div className="toast" role="status">{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><Icon name="close" size={14}/></button></div>}
    {viewNode && <div className="lightbox" role="dialog" aria-modal="true" aria-label="Image details" onClick={() => setViewId(null)}><div className="lightbox-card" onClick={event => event.stopPropagation()}>
      <button className="lightbox-close icon-button" autoFocus aria-label="Close image" onClick={() => setViewId(null)}><Icon name="close"/></button>
      <div className="lightbox-image"><img src={assetUrl(viewNode.data.asset)} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt={viewNode.data.caption || viewNode.data.label || 'Concept image'} onLoad={event => setViewSize({ asset: viewNode.data.asset, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}/></div>
      <div className="lightbox-details"><span className="eyebrow">{viewInfo.kind === 'generated' ? 'GENERATED CONCEPT' : 'UPLOADED REFERENCE'}</span>
        {viewInfo.author && <div className="image-info-author"><span className="detail-label">{viewInfo.kind === 'generated' ? 'Generated by' : 'Added by'}</span><AuthorBadge author={viewInfo.author}/></div>}
        {viewInfo.caption && <h3 className="image-info-title">{viewInfo.caption}</h3>}
        {viewInfo.rows.length > 0 && <dl className="image-info">{viewInfo.rows.map(row => <div key={row.key}><dt>{row.label}</dt><dd>{row.value}{row.note && <small>{row.note}</small>}</dd></div>)}</dl>}
        {viewRun && <>{viewInfo.prompt && <><span className="detail-label">{cloud ? 'Prompt' : 'Original prompt'}</span><p className="prompt-snapshot">{viewInfo.prompt}</p></>}
          {!cloud && <><span className="detail-label">Inputs at the time of this run</span>
          <div className="run-inputs">{viewInputs.length ? viewInputs.map((node, index) => node.type === 'image'
            ? <img key={node.id} src={assetUrl(node.data.asset)} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt={`Input image ${index + 1}`} loading="lazy"/>
            : <p key={node.id}>{node.data.text}</p>) : <p>No connected inputs</p>}</div></>}
          {viewRun.snapshot?.filter(node => node.type === 'text' && node.data.template).map(node => <div className="run-template" key={node.id}>
            <span className="detail-label">Custom node: {node.data.template.name}</span>
            {node.data.template.instructions && <p>{node.data.template.instructions}</p>}
            {node.data.template.assets?.length > 0 && <div className="run-inputs">{node.data.template.assets.map((asset, index) => <img key={`${asset}-${index}`} src={assetUrl(asset)} referrerPolicy="no-referrer" crossOrigin={hosted ? 'anonymous' : undefined} alt={`${node.data.template.name} reference ${index + 1}`} loading="lazy"/>)}</div>}
          </div>)}</>}
        <div className="lightbox-actions"><button data-tooltip="Download original image" onClick={() => downloadImage(viewNode.data.asset)}><Icon name="download" size={17}/> Download original</button></div>
      </div>
    </div></div>}
  </div>{mcpBusy && <div className="toast" role="status">Synchronizing the board with the agent…</div>}<ButtonHelp/></Actions.Provider>;
}

const helperBuilds = [
  { id: 'macos-arm64', label: 'Mac with Apple silicon', detail: 'M1, M2, M3, M4 and later', family: 'macos' },
  { id: 'macos-x64', label: 'Mac with Intel', detail: 'Intel processor · preview', family: 'macos' },
  { id: 'windows-x64', label: 'Windows x64', detail: '64-bit Intel or AMD · preview', family: 'windows' },
];
const formatHelperSize = bytes => Number.isSafeInteger(bytes) && bytes > 0 ? `${(bytes / 1_000_000).toFixed(1)} MB` : null;

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
    <div className="login-card codex-install-card"><h2 id="codex-install-title">Install Codex</h2>
      <p>Codex isn’t installed on this computer. Concept Graph can download and install it for you from OpenAI’s official GitHub release (up to 155 MiB). Then you just sign in with ChatGPT.</p>
      {working && <div className="codex-install-progress" role="status"><p>{progress?.state === 'installing' ? 'Installing…' : progress?.state === 'done' ? 'Connecting to Codex…' : `Downloading…${percent === null ? '' : ` ${percent}%`}`}</p><progress aria-label="Codex installation" max="100" value={progress?.state === 'downloading' ? percent ?? undefined : undefined}/></div>}
      {(error || progress?.error) && <p className="codex-install-error" role="alert">{error || progress.error}</p>}
      <button className="primary-button" type="button" autoFocus disabled={!progress?.supported || working} onClick={install}>{progress?.state === 'error' ? 'Retry' : 'Install'}</button>
      <button type="button" onClick={onClose}>{working ? 'Back to board' : 'Not now'}</button>
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
    <button ref={trigger} className={`connection ${readiness.key === 'ready' ? 'connected' : ''} ${outdated ? 'helper-update' : ''}`} type="button" aria-expanded={open && paired} aria-haspopup={paired ? 'dialog' : undefined} aria-controls={open && paired ? 'helper-connection-details' : undefined} onClick={() => paired ? setOpen(value => !value) : onSetup()} data-tooltip={status.error || readiness.label}>{connected ? <svg className="feel-check" aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"><path pathLength="1" d="m3 8 3 3 7-7"/></svg> : <span/>}{outdated ? 'Update helper' : readiness.label}</button>
    {open && paired && <div ref={panel} id="helper-connection-details" className="helper-connection-panel" role="dialog" aria-label="Helper connection" tabIndex={-1}>
      <strong>Helper connected</strong>
      <p>Codex: {status.codexMissing ? 'not installed' : !status.connected ? 'not ready' : status.signedIn ? 'signed in' : 'sign-in needed'}</p>
      <p>Helper version: <span className="helper-version">{status.helperVersion || (status.helperVersion === null ? 'source' : 'unknown')}</span></p>
      {outdated && <p className="helper-update-note">A newer helper is available. Download it, quit the old helper, then open the new one and paste its new code.</p>}
      {(readiness.own || readiness).key !== 'ready' && <button type="button" disabled={loginBusy} onClick={() => { close(); onFix(); }}>{(readiness.own || readiness).action}</button>}
      {download ? <a href={download.url} download={download.file} onClick={close}>Download helper</a> : <button type="button" onClick={() => { close(); onDownloads(); }}>Download helper</button>}
      {cloud && (manifestError || (manifest && detection?.packageId && !download)) && <p>Download unavailable. Check other versions or try again later.</p>}
      <button type="button" onClick={() => { close(); onDownloads(); }}>Other versions</button>
      {onDisconnect && <button type="button" onClick={() => { close(); onDisconnect(); }}>Disconnect</button>}
    </div>}
  </div>;
}

function HelperSetup({ code, setCode, connecting, error, connect, cloudMode = false, showAllBuilds = false, teammates = null }) {
  const { detection, manifest, manifestError } = useHelperDownloads(cloudMode);
  const [selected, setSelected] = useState(''), [showBuilds, setShowBuilds] = useState(showAllBuilds);
  const [downloading, setDownloading] = useState(''), [downloadError, setDownloadError] = useState(''), [downloaded, setDownloaded] = useState(false);
  const officialSite = cloudMode || location.origin === 'https://concept-graph-local.knifest.chatgpt.site';
  useEffect(() => { if (detection?.packageId) setSelected(current => current || detection.packageId); }, [detection]);
  const downloadHelper = async platform => {
    setDownloading('Preparing download…'); setDownloadError(''); setDownloaded(false);
    try {
      const blob = await fetchHelperArchive(platform, setDownloading);
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `concept-graph-helper-${platform}.zip`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setDownloaded(true);
    } catch (failure) { setDownloadError(failure.message || 'Could not download the helper.'); }
    finally { setDownloading(''); }
  };
  const selectedBuild = helperBuilds.find(build => build.id === selected);
  const directDownload = cloudMode ? cloudHelperDownload(selected, manifest?.[selected]) : null;
  const isRecommended = selected && detection?.packageId === selected;
  const matchingFamily = detection?.platform === 'macos' || detection?.platform === 'windows' ? detection.platform : null;
  const orderedBuilds = matchingFamily ? [...helperBuilds].sort((a, b) => Number(b.family === matchingFamily) - Number(a.family === matchingFamily)) : helperBuilds;
  const sizeLabel = build => {
    const item = manifest?.[build.id];
    if (cloudMode && !cloudHelperDownload(build.id, item)) return manifest || manifestError ? 'Download unavailable' : 'Checking size…';
    const download = formatHelperSize(item?.size), unpacked = formatHelperSize(item?.unpackedSize);
    if (!download) return manifest || manifestError ? 'Size unavailable' : 'Checking size…';
    return `${download} download${unpacked ? ` · ${unpacked} ${cloudMode && build.family === 'windows' ? 'installed' : 'unpacked'}` : ''}`;
  };
  const platformMessage = !detection ? 'Checking your device…'
    : detection.platform === 'macos' && !detection.packageId ? 'Mac detected · choose your processor'
    : detection.platform === 'windows' && detection.architecture === 'arm64' ? 'Windows on ARM detected · no native build yet'
    : detection.platform === 'windows' && detection.architecture === 'x86' ? '32-bit Windows detected · no compatible build'
    : detection.platform === 'windows' && !detection.packageId ? 'Windows detected · choose a compatible build'
    : detection.platform === 'linux' ? 'Linux detected · no build available yet'
    : detection.platform === 'mobile' ? 'Open this page on your computer to get started'
    : detection.packageId ? 'Detected for this device' : 'Choose a build for your computer';
  return <main className="helper-startup">
    <div className="helper-layout">
      <aside className="helper-intro">
        <div className="helper-brand"><img src="/favicon.svg" alt=""/><strong>Concept Graph</strong></div>
        <span className="helper-intro-kicker">A LITTLE SETUP, A LOT OF ROOM TO CREATE</span>
        <h1>Your ideas.<br/><em>{cloudMode ? 'Your team.' : 'Your computer.'}</em></h1>
        <p>{cloudMode ? 'Boards and images are shared with your team on Cloudflare. Image generation runs through Codex on your computer.' : 'Bring your Codex workflow to a visual canvas. The helper connects the two while keeping your boards and images on your computer.'}</p>
        <div className="helper-privacy"><span className="helper-privacy-icon"><Icon name="check" size={16}/></span><span>{cloudMode ? 'Generation runs locally · boards live in the cloud' : <>Runs locally <i/> No Node.js installation</>}</span></div>
      </aside>
      <section className="helper-panel" aria-labelledby="helper-title">
        <header className="helper-panel-head"><span className="helper-kicker">GET STARTED</span><h2 id="helper-title">Connect your helper</h2><p>Three quick steps and you’re ready to create.</p></header>
        {teammates}
        {!officialSite && <p className="helper-error" role="alert">Open this app at its official site address to connect your local helper.</p>}
        <form onSubmit={event => { event.preventDefault(); connect(code); }}>
          <div className="helper-step">
            <div className="helper-step-marker">1</div>
            <div className="helper-step-content">
              <h3>Download the helper</h3><p>Choose the version for this computer.</p>
              <div className="helper-device-status"><span className="helper-status-dot"/>{platformMessage}</div>
              {selectedBuild && <div className="helper-selected">
                <div className="helper-selected-info"><span className="helper-device-icon"><Icon name="download" size={19}/></span><span><strong>{selectedBuild.label}</strong><small>{selectedBuild.detail}{isRecommended ? ' · recommended' : ''}</small></span></div>
                <div className="helper-selected-action">{cloudMode ? directDownload && officialSite ? <a className="helper-primary" href={directDownload.url} download={directDownload.file}><Icon name="download" size={16}/> Download</a> : <button className="helper-primary" type="button" disabled><Icon name="download" size={16}/> Download</button> : <button className="helper-primary" type="button" disabled={!!downloading || !officialSite} onClick={() => downloadHelper(selectedBuild.id)}><Icon name="download" size={16}/> Download</button>}<span>{sizeLabel(selectedBuild)}</span></div>
              </div>}
              {selectedBuild && <button type="button" className="helper-change" aria-expanded={showBuilds} onClick={() => setShowBuilds(value => !value)}>{showBuilds ? 'Hide other versions' : 'Choose another version'} <span aria-hidden="true">{showBuilds ? '−' : '+'}</span></button>}
              {(!selectedBuild || showBuilds) && <div className="helper-build-list" aria-label="Available helper versions">
                {orderedBuilds.map(build => <button key={build.id} type="button" className={`helper-build-option ${selected === build.id ? 'selected' : ''}`} onClick={() => { setSelected(build.id); setShowBuilds(false); setDownloaded(false); setDownloadError(''); }}><span><strong>{build.label}</strong><small>{build.detail}</small></span><span className="helper-build-size">{sizeLabel(build)}</span></button>)}
              </div>}
              {detection?.platform === 'macos' && !detection.packageId && (!selectedBuild || showBuilds) && <p className="helper-space-note">Not sure which Mac you have? Open Apple menu → About This Mac and look for Chip or Processor.</p>}
              {selectedBuild && selectedBuild.id !== 'macos-arm64' && <p className="helper-space-note">This build is a preview and has not yet been tested on its platform.</p>}
              {manifest && <p className="helper-space-note">Size excludes your boards and images.</p>}
              {manifestError && <p className="helper-space-note">Download sizes are unavailable. Refresh to try again.</p>}
              {downloading && <p className="helper-download-status" role="status">{downloading}</p>}
              {downloaded && <p className="helper-download-status" role="status">Download started. Check your Downloads folder.</p>}
              {downloadError && <p className="helper-error" role="alert">{downloadError}</p>}
            </div>
          </div>
          <div className="helper-step">
            <div className="helper-step-marker">2</div>
            <div className="helper-step-content"><h3>Open the helper</h3>{cloudMode && manifestError && <p className="helper-step-note">Start the helper for this site with <code>CONCEPT_GRAPH_SITE={location.origin} npm run helper</code> from the project folder, then paste its pairing code below.</p>}<p>{cloudMode ? selectedBuild?.family === 'macos' ? <>Open the downloaded disk image, drag <strong>Concept Graph Helper</strong> to Applications, then open it; it shows the pairing code. Keep its window open.</> : selectedBuild?.family === 'windows' ? <>Run the installer. If Windows shows “Windows protected your PC”, choose <strong>More info → Run anyway</strong>. The helper opens and shows the pairing code. Next time, start <strong>Concept Graph Helper</strong> from the Start menu. Keep its window open.</> : <>Choose your computer’s version above, then open the downloaded helper.</> : manifest?.[selected]?.kind === 'app' ? <>Unzip the file and open <strong>Concept Graph Helper.app</strong>. It shows your pairing code. Keep its window open.</> : <>Unzip the file and open the <strong>Concept-Graph-Helper</strong> folder. Run <strong>{selectedBuild?.family === 'windows' ? 'Start Concept Graph.cmd' : 'Start Concept Graph.command'}</strong>{!selectedBuild && <> on Mac, or <strong>Start Concept Graph.cmd</strong> on Windows</>}. Keep its window open.</>}</p><p className="helper-step-note">After pairing, the site offers to install Codex if needed, then asks you to sign in with ChatGPT. Your operating system may warn about an unidentified developer.</p></div>
          </div>
          <div className="helper-step helper-step-last">
            <div className="helper-step-marker">3</div>
            <div className="helper-step-content"><h3>Connect to your canvas</h3><p>Copy the pairing code from the helper window.</p><label className="helper-input-label" htmlFor="helper-code">Pairing code</label><div className="helper-connect"><input id="helper-code" type="password" autoComplete="off" spellCheck="false" value={code} onChange={event => setCode(event.target.value)} placeholder="Paste pairing code" required/><button className="helper-primary" type="submit" disabled={connecting || !code.trim() || !officialSite}>{connecting ? 'Connecting…' : 'Connect'} <Icon name="arrow" size={15}/></button></div>{error && <p className="helper-error" role="alert">{error}</p>}<p className="helper-step-note">{cloudMode ? 'If prompted, allow access to your local network. Only generation needs a helper.' : 'If prompted, allow access to your local network. Existing boards can be moved using Export and Import.'}</p></div>
          </div>
        </form>
      </section>
    </div>
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
        setError(failure.status === 403 ? 'The pairing code was not accepted. Check the terminal and try again.' : 'Could not reach the local helper. Start it, allow local network access if prompted, and try again.');
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
  if (!boardId) return <div className="startup">{error || 'Opening your boards…'}</div>;
  return <><ReactFlowProvider key={boardId}><App boardId={boardId} boards={boards} updateBoards={setBoards} selectBoard={selectBoard} theme={theme} toggleTheme={toggleTheme} waitForPreferences={() => preferenceWrites.current} desktopMode={!!desktopPreferences.current} mcpEnabled={mcpEnabled} editorReadyCallback={editorReadyCallback} helperSession={hosted ? helperSession.current : undefined}/></ReactFlowProvider>
    {hosted && pairing && <div className="helper-pair-overlay" role="dialog" aria-modal="true" aria-label="Connect local helper" onKeyDown={event => { keepDialogFocus(event); if (event.key === 'Escape') closePair(); }}><button className="helper-pair-close" autoFocus onClick={closePair}>Back to board</button><HelperSetup showAllBuilds={showAllBuilds} code={code} setCode={setCode} connecting={connecting} error={error} connect={openWorkspace}/></div>}
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
createRoot(document.getElementById('root')).render(cloud ? <React.Suspense fallback={<div className="startup">Opening cloud workspace…</div>}><CloudWorkspace Editor={App} HelperSetup={HelperSetup} services={cloudServices}/></React.Suspense> : <Workspace/>);
