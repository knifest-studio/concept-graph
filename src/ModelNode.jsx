import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position } from '@xyflow/react';
import { useCanvas, useCanvasValue, useDetail } from './canvas-context.jsx';
import { useCanvasImage } from './canvas-image-hooks.jsx';
import { NodeContextMenu } from './NodeContextMenu.jsx';
import { NodeFeedback } from './InteractionFeedback.jsx';
import { keepDialogFocus, restoreDialogFocus } from './dialog-focus.mjs';
import { lodHandleProps } from './canvas.mjs';
import { meshStats, modelInfo, modelScene, wireframeView } from './model-info.mjs';
import { t } from './i18n.mjs';
import { loadViewer } from './model-upload.mjs';
import './model-node.css';

function ModelViewer({ data, assetUrl, viewer, onReady, onError, modal = false, orbit, children }) {
  const [ready, setReady] = useState(false), area = useRef(null);
  useEffect(() => { let live = true; loadViewer().then(() => { if (live) setReady(true); }).catch(() => { if (live) onError(t('Could not load the 3D viewer. Reload and try again.')); }); return () => { live = false; }; }, []);
  useEffect(() => {
    const element = viewer.current;
    if (!ready || !element) return;
    const loaded = () => onReady(element), failed = () => { onReady(false); onError(t('Could not display this 3D model. Download the GLB to inspect it.')); };
    element.addEventListener('load', loaded); element.addEventListener('error', failed);
    if (element.loaded) loaded();
    return () => { element.removeEventListener('load', loaded); element.removeEventListener('error', failed); onReady(false); };
  }, [ready, data.asset]);
  // disable-zoom leaves the wheel alone (https://modelviewer.dev/docs/#entrydocs-stagingandcameras-attributes-disable-zoom, read 2026-11-14). Forward past React Flow's nowheel area
  // to its pane, so the same scroll/zoom gesture keeps working over a card as everywhere else on the canvas.
  const wheel = event => {
    if (modal || event.target.closest?.('.model-info')) return;
    const pane = event.currentTarget.closest('.react-flow')?.querySelector('.react-flow__pane');
    if (!pane) return;
    event.preventDefault(); event.stopPropagation();
    pane.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, clientX: event.clientX, clientY: event.clientY }));
  };
  useEffect(() => { const element = area.current; if (modal || !element) return; element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel); }, [modal]);
  return <div ref={area} className="model-viewer-area nodrag nowheel nopan" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    {ready ? <model-viewer ref={viewer} src={assetUrl(data.asset)} poster={data.poster ? assetUrl(data.poster) : undefined} alt={data.name} camera-controls="" disable-zoom={modal ? undefined : ''} camera-orbit={orbit} loading="lazy" interaction-prompt="none"/> : data.poster ? <img src={assetUrl(data.poster)} alt={data.name} loading="lazy" draggable="false"/> : <span>{t('Loading 3D viewer…')}</span>}
    {children}
  </div>;
}

function ModelActions({ data, assetUrl, viewer, loaded, readOnly, save, open, Icon, info, infoId, toggleInfo, wireframe, toggleWireframe, canWireframe, infoButton, modal }) {
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const capture = async () => {
    setSaving(true); setError('');
    try { const blob = await viewer.current.toBlob({ mimeType: 'image/png' }); if (!blob) throw new Error(); await save(blob); }
    catch { setError(t('Could not save this view. Try again.')); }
    finally { setSaving(false); }
  };
  return <><div className="model-actions nodrag nopan">
    <a href={assetUrl(data.asset)} download={`${data.name}.glb`} title={t('Download GLB')} aria-label={t('Download GLB')}><Icon name="download" size={14}/>{modal && t('Download GLB')}</a>
    <button type="button" title={saving ? t('Saving…') : t('Save view as image')} aria-label={saving ? t('Saving…') : t('Save view as image')} disabled={!loaded || readOnly || saving} onClick={capture}><Icon name="image" size={14}/>{modal && (saving ? t('Saving…') : t('Save view as image'))}</button>
    <button ref={infoButton} type="button" aria-expanded={info} aria-controls={infoId} onClick={toggleInfo}><Icon name="info" size={14}/>{t('Info')}</button>
    {canWireframe && <button type="button" aria-pressed={wireframe} onClick={toggleWireframe}>{t('Wireframe')}</button>}
    {open && <button type="button" onClick={open}>{t('Open')}</button>}
  </div>{error && <div className="node-error" role="alert">{error}</div>}</>;
}

function ModelSource({ nodeId, name }) {
  const canvas = useCanvas(), exists = useCanvasValue(state => state.imageIds.has(nodeId));
  return exists ? <button type="button" onClick={() => canvas.focusModelSource(nodeId)}>{name}</button> : name;
}

function ModelInfo({ node, run, stats, id }) {
  return <aside id={id} className="model-info nodrag nopan nowheel" aria-label={t('Model information')} onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    <dl>{modelInfo(node, run, { stats }).map(row => <div key={row.key}><dt>{row.label}</dt><dd>{row.nodeId ? <ModelSource nodeId={row.nodeId} name={row.value}/> : row.value}{row.note && <small>{row.note}</small>}</dd></div>)}</dl>
  </aside>;
}

function ModelContent({ node, assetUrl, viewer, readOnly, save, open, Icon, modal = false, orbit }) {
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [info, setInfo] = useState(false);
  const [scene, setScene] = useState(null), [stats, setStats] = useState(null), [wireframe, setWireframe] = useState(false);
  const restore = useRef(null), infoButton = useRef(null), infoId = useId();
  const run = useCanvasValue(state => state.runById.get(node.data.runId));
  const reset = () => { restore.current?.(); restore.current = null; setWireframe(false); };
  const inspected = element => {
    reset(); setLoaded(!!element); setError('');
    const next = element ? modelScene(element) : null;
    setScene(next); setStats(next ? meshStats(next, element.getDimensions?.()) : null);
  };
  useEffect(() => () => { restore.current?.(); restore.current = null; }, []);
  useEffect(() => {
    if (!info || modal) return;
    const escape = event => { if (event.key === 'Escape' && !event.target.closest?.('.board-modal')) { event.stopPropagation(); setInfo(false); infoButton.current?.focus(); } };
    document.addEventListener('keydown', escape, true); return () => document.removeEventListener('keydown', escape, true);
  }, [info, modal]);
  const toggleWireframe = () => {
    if (wireframe) reset();
    else try { restore.current = wireframeView(scene, viewer.current ? getComputedStyle(viewer.current).color : undefined); setWireframe(true); }
    catch { setScene(null); }
  };
  const panel = info && <ModelInfo node={node} run={run} stats={stats} id={infoId}/>;
  return <>
    <div className={`model-content${info ? ' has-info' : ''}`}>
      <ModelViewer key={node.data.asset} data={node.data} assetUrl={assetUrl} viewer={viewer} onReady={inspected} onError={setError} modal={modal} orbit={orbit}>{!modal && panel}</ModelViewer>
      {modal && panel}
    </div>
    <ModelActions data={node.data} assetUrl={assetUrl} viewer={viewer} loaded={loaded} readOnly={readOnly} save={save} open={open} Icon={Icon} info={info} infoId={infoId} toggleInfo={() => setInfo(value => !value)} wireframe={wireframe} canWireframe={!!scene} toggleWireframe={toggleWireframe} infoButton={infoButton} modal={modal}/>
    {error && <div className="node-error" role="alert">{error}</div>}
  </>;
}

function ModelPoster({ id, data, assetUrl, canvas, Icon, onContextMenu }) {
  const image = useCanvasImage(data.poster ? assetUrl(data.poster) : '', { small: true, create: !!data.poster });
  if (data.collapsed) return <article onContextMenu={onContextMenu} data-feel-node={id} className="collapsed-node collapsed-node-image-card lod-node"><i {...lodHandleProps('target')}/>{image.src ? <img src={image.src} alt={data.name} draggable="false"/> : <span className="model-placeholder" aria-hidden="true"><Icon name="cube" size={32}/></span>}{Icon && <button className="collapsed-node-expand nodrag" type="button" aria-label={t('Expand node')} onClick={() => canvas.toggleNodeCollapsed(id)}><Icon name="expand" size={15}/></button>}</article>;
  return <article onContextMenu={onContextMenu} data-feel-node={id} className="node-card model-node lod-node"><i {...lodHandleProps('target')}/><header>{t('3D model')}</header><div className="model-viewer-area">{image.src ? <img src={image.src} alt="" draggable="false"/> : <span className="model-placeholder" aria-hidden="true"><Icon name="cube" size={48}/></span>}</div><div className="model-actions"/></article>;
}

export function ModelNode({ id, data, assetUrl, Icon }) {
  const detail = useDetail(id), canvas = useCanvas(), viewer = useRef(null);
  const readOnly = useCanvasValue(state => state.readOnly);
  if (detail !== 'full' || data.collapsed) return <NodeContextMenu id={id} type="model" actions={canvas}><ModelPoster id={id} data={data} assetUrl={assetUrl} canvas={canvas} Icon={detail === 'full' ? Icon : undefined}/></NodeContextMenu>;
  return <NodeFeedback id={id}><NodeContextMenu id={id} type="model" actions={canvas}><article className="node-card model-node">
    <Handle type="target" position={Position.Left} isConnectable={false}/><header className="node-drag"><Icon name="cube" size={16}/><span className="model-name">{data.name}</span></header>
    <ModelContent node={{ id, data }} assetUrl={assetUrl} viewer={viewer} readOnly={readOnly} save={blob => canvas.saveModelView(id, blob)} open={() => canvas.openModel(id, viewer.current?.getCameraOrbit?.().toString())} Icon={Icon}/>
  </article></NodeContextMenu></NodeFeedback>;
}

export function ModelDialog({ node, orbit, assetUrl, onClose, save, readOnly, Icon }) {
  const viewer = useRef(null), heading = useRef(null);
  useEffect(() => { const previous = document.activeElement; heading.current?.focus(); return () => restoreDialogFocus(previous); }, []);
  return createPortal(<div className="board-modal model-modal" role="dialog" aria-modal="true" aria-label={t('3D model')} onKeyDown={event => { keepDialogFocus(event); event.stopPropagation(); if (event.key === 'Escape') onClose(); }} onCopy={event => event.stopPropagation()} onPaste={event => event.stopPropagation()}>
    <div className="model-dialog"><header><h2 ref={heading} tabIndex={-1}>{node.data.name}</h2><button type="button" aria-label={t('Close')} onClick={onClose}>×</button></header>
      <ModelContent node={node} assetUrl={assetUrl} viewer={viewer} readOnly={readOnly} save={blob => save(node.id, blob)} Icon={Icon} modal orbit={orbit}/>
    </div>
  </div>, document.body);
}
