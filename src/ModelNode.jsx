import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position } from '@xyflow/react';
import { useCanvas, useCanvasValue, useDetail } from './canvas-context.jsx';
import { useCanvasImage } from './canvas-image-hooks.jsx';
import { NodeContextMenu } from './NodeContextMenu.jsx';
import { NodeFeedback } from './InteractionFeedback.jsx';
import { keepDialogFocus, restoreDialogFocus } from './dialog-focus.mjs';
import { lodHandleProps } from './canvas.mjs';
import { t } from './i18n.mjs';
import './model-node.css';

let viewerModule;
// Only a visible full-detail model card loads Three/model-viewer; zoomed-out boards need only image posters.
const loadViewer = () => viewerModule ||= import('@google/model-viewer').catch(cause => { viewerModule = null; throw cause; });

function ModelViewer({ data, assetUrl, viewer, onReady, onError, modal = false, orbit }) {
  const [ready, setReady] = useState(false), area = useRef(null);
  useEffect(() => { let live = true; loadViewer().then(() => { if (live) setReady(true); }).catch(() => { if (live) onError(t('Could not load the 3D viewer. Reload and try again.')); }); return () => { live = false; }; }, []);
  useEffect(() => {
    const element = viewer.current;
    if (!ready || !element) return;
    const loaded = () => onReady(true), failed = () => { onReady(false); onError(t('Could not display this 3D model. Download the GLB to inspect it.')); };
    element.addEventListener('load', loaded); element.addEventListener('error', failed);
    if (element.loaded) loaded();
    return () => { element.removeEventListener('load', loaded); element.removeEventListener('error', failed); onReady(false); };
  }, [ready, data.asset]);
  // disable-zoom leaves the wheel alone (https://modelviewer.dev/docs/#entrydocs-stagingandcameras-attributes-disable-zoom, read 2026-11-14). Forward past React Flow's nowheel area
  // to its pane, so the same scroll/zoom gesture keeps working over a card as everywhere else on the canvas.
  const wheel = event => {
    if (modal) return;
    const pane = event.currentTarget.closest('.react-flow')?.querySelector('.react-flow__pane');
    if (!pane) return;
    event.preventDefault(); event.stopPropagation();
    pane.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, clientX: event.clientX, clientY: event.clientY }));
  };
  useEffect(() => { const element = area.current; if (modal || !element) return; element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel); }, [modal]);
  return <div ref={area} className="model-viewer-area nodrag nowheel nopan" onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    {ready ? <model-viewer ref={viewer} src={assetUrl(data.asset)} poster={data.poster ? assetUrl(data.poster) : undefined} alt={data.name} camera-controls="" disable-zoom={modal ? undefined : ''} camera-orbit={orbit} loading="lazy" interaction-prompt="none"/> : data.poster ? <img src={assetUrl(data.poster)} alt={data.name} loading="lazy" draggable="false"/> : <span>{t('Loading 3D viewer…')}</span>}
  </div>;
}

function ModelActions({ data, assetUrl, viewer, loaded, readOnly, save, open, Icon }) {
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const capture = async () => {
    setSaving(true); setError('');
    try { const blob = await viewer.current.toBlob({ mimeType: 'image/png' }); if (!blob) throw new Error(); await save(blob); }
    catch { setError(t('Could not save this view. Try again.')); }
    finally { setSaving(false); }
  };
  return <><div className="model-actions nodrag nopan">
    <a href={assetUrl(data.asset)} download={`${data.name}.glb`}><Icon name="download" size={14}/>{t('Download GLB')}</a>
    <button type="button" disabled={!loaded || readOnly || saving} onClick={capture}>{saving ? t('Saving…') : t('Save view as image')}</button>
    {open && <button type="button" onClick={open}>{t('Open')}</button>}
  </div>{error && <div className="node-error" role="alert">{error}</div>}</>;
}

function ModelPoster({ id, data, assetUrl, canvas, Icon, onContextMenu }) {
  const image = useCanvasImage(data.poster ? assetUrl(data.poster) : '', { small: true, create: !!data.poster });
  if (data.collapsed) return <article onContextMenu={onContextMenu} data-feel-node={id} className="collapsed-node collapsed-node-image-card lod-node"><i {...lodHandleProps('target')}/>{image.src && <img src={image.src} alt={data.name} draggable="false"/>}{Icon && <button className="collapsed-node-expand nodrag" type="button" aria-label={t('Expand node')} onClick={() => canvas.toggleNodeCollapsed(id)}><Icon name="expand" size={15}/></button>}</article>;
  return <article onContextMenu={onContextMenu} data-feel-node={id} className="node-card model-node lod-node"><i {...lodHandleProps('target')}/><header>{t('3D model')}</header><div className="model-viewer-area">{image.src && <img src={image.src} alt="" draggable="false"/>}</div><div className="model-actions"/></article>;
}

export function ModelNode({ id, data, assetUrl, Icon }) {
  const detail = useDetail(id), canvas = useCanvas(), viewer = useRef(null);
  const readOnly = useCanvasValue(state => state.readOnly), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  if (detail !== 'full' || data.collapsed) return <NodeContextMenu id={id} type="model" actions={canvas}><ModelPoster id={id} data={data} assetUrl={assetUrl} canvas={canvas} Icon={detail === 'full' ? Icon : undefined}/></NodeContextMenu>;
  return <NodeFeedback id={id}><NodeContextMenu id={id} type="model" actions={canvas}><article className="node-card model-node">
    <Handle type="target" position={Position.Left} isConnectable={false}/><header className="node-drag"><Icon name="cube" size={16}/><span className="model-name">{data.name}</span></header>
    <ModelViewer data={data} assetUrl={assetUrl} viewer={viewer} onReady={setLoaded} onError={setError}/>
    <ModelActions data={data} assetUrl={assetUrl} viewer={viewer} loaded={loaded} readOnly={readOnly} save={blob => canvas.saveModelView(id, blob)} open={() => canvas.openModel(id, viewer.current?.getCameraOrbit?.().toString())} Icon={Icon}/>
    {error && <div className="node-error" role="alert">{error}</div>}
  </article></NodeContextMenu></NodeFeedback>;
}

export function ModelDialog({ node, orbit, assetUrl, onClose, save, readOnly, Icon }) {
  const viewer = useRef(null), heading = useRef(null), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  useEffect(() => { const previous = document.activeElement; heading.current?.focus(); return () => restoreDialogFocus(previous); }, []);
  return createPortal(<div className="board-modal model-modal" role="dialog" aria-modal="true" aria-label={t('3D model')} onKeyDown={event => { keepDialogFocus(event); event.stopPropagation(); if (event.key === 'Escape') onClose(); }} onCopy={event => event.stopPropagation()} onPaste={event => event.stopPropagation()}>
    <div className="model-dialog"><header><h2 ref={heading} tabIndex={-1}>{node.data.name}</h2><button type="button" aria-label={t('Close')} onClick={onClose}>×</button></header>
      <ModelViewer data={node.data} assetUrl={assetUrl} viewer={viewer} onReady={setLoaded} onError={setError} modal orbit={orbit}/>
      <ModelActions data={node.data} assetUrl={assetUrl} viewer={viewer} loaded={loaded} readOnly={readOnly} save={blob => save(node.id, blob)} Icon={Icon}/>
      {error && <div className="node-error" role="alert">{error}</div>}
    </div>
  </div>, document.body);
}
