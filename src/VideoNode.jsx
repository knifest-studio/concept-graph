import React, { useLayoutEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { useCanvas, useCanvasValue, useDetail } from './canvas-context.jsx';
import { shallowEqual, nodeStarting } from './canvas-store.mjs';
import { useCanvasImage } from './canvas-image-hooks.jsx';
import { NodeContextMenu } from './NodeContextMenu.jsx';
import { lodHandleProps } from './canvas.mjs';
import { resolveVideo, videoModels, rolesForVideoInput } from './video-generation.mjs';
import { formatDuration, runElapsed } from '../timing.mjs';
import { t } from './i18n.mjs';
import './video-node.css';

const noImages = [];
const busy = run => ['running', 'queued'].includes(run?.status);
const clipRoleLabels = { reference: 'Reference video', edit: 'Edit this video', extend: 'Extend this video' };
const roleLabels = { start: 'Start frame', end: 'End frame', middle: 'Middle frame', reference: 'Reference' };
const money = value => value < 1 ? value.toFixed(2) : value.toFixed(2);
const perSecond = rate => `$${String(Number(rate.toFixed(4)))}`;
const resolutionLabel = value => value === '4k' ? '4K' : value.replace(/P$/, 'p');
export const videoModelLabels = Object.freeze({ minimax: 'MiniMax', omni: 'Omni', kling: 'Kling', seedance: 'Seedance' });
// One line on what each model is good at, shown under the model buttons and as their tooltips.
const modelHints = {
  minimax: 'MiniMax H3: best value, start and end frames, references.',
  omni: 'Gemini Omni Flash 1.2: cheap, sound always included, 16:9 or 9:16.',
  kling: 'Kling 4.0: up to 30 s, start, end and up to 8 middle frames.',
  seedance: 'Seedance 2.5: top quality, up to 30 s and 30 references, the most expensive.',
};
const audioNotes = { omni: 'Sound is always included.' };
// What a person reads under the controls: values the model changes, then what blocks Generate.
function clampLines(resolved) {
  const { requested, applied, unsupported } = resolved;
  return Object.keys(unsupported).flatMap(key => {
    if (key === 'duration' && resolved.autoLength) return [t('Editing follows the input video’s length and format.')];
    if (key === 'duration') return [t('Duration {requested} → {applied} s for this model', { requested: requested.duration, applied: applied.duration })];
    if (key === 'videoResolution') return [t('Resolution {requested} → {applied} for this model', { requested: resolutionLabel(requested.videoResolution), applied: resolutionLabel(applied.videoResolution) })];
    if (key === 'videoAspectRatio' && applied.videoAspectRatio !== 'auto') return [t('Shape {requested} → {applied} for this model', { requested: requested.videoAspectRatio, applied: applied.videoAspectRatio })];
    if (key === 'videoAudio') return [t(resolved.model === 'omni' ? 'Sound is always included.' : 'This model has no sound switch.')];
    return [];
  });
}
export function VideoPrompt({ id, data, assetUrl, Icon }) {
  const canvas = useCanvas(), detail = useDetail(id);
  const state = useCanvasValue(state => {
    const run = state.latestRun.get(id), active = busy(run);
    return { images: state.videoInputs.get(id) || noImages, active, starting: nodeStarting(state.starting, id), runId: run?.id, status: run?.status, error: run?.error, byName: run?.by?.name,
      timer: active ? formatDuration(runElapsed(run, state.now)) : '', readOnly: state.readOnly, ready: state.videoReady, note: state.videoNote, userName: state.userName };
  }, shallowEqual);
  const resolved = resolveVideo({ data }, state.images), { applied, requested } = resolved, pending = state.active || state.starting;
  const disabled = state.readOnly || pending, set = (key, value) => canvas.setVideo(id, { [key]: value });
  // The board commits typed text a moment later (putNodesSoon), so the field shows its own draft at once, as prompt cards do;
  // a teammate's or undo's change to the stored text still replaces it.
  const [draft, setDraft] = useState(String(data.text || '')), edited = useRef(false);
  useLayoutEffect(() => { setDraft(String(data.text || '')); }, [data.text]);
  const changeText = value => { setDraft(value); if (!edited.current) { canvas.checkpoint(); edited.current = true; } canvas.editText(id, value); };
  const text = draft, price = money(resolved.usd), light = detail !== 'full';
  const modelChips = interactive => <div className="upscale-options" role={interactive ? 'radiogroup' : undefined} aria-label={interactive ? t('Video model') : undefined} aria-hidden={interactive ? undefined : true}>
    {Object.entries(videoModelLabels).map(([key, label]) => interactive
      ? <button type="button" role="radio" key={key} data-analytics-name={`Video model: ${label}`} aria-checked={resolved.model === key} data-tooltip={t(modelHints[key])} disabled={disabled} onClick={() => set('videoModel', key)}>{label}</button>
      : <span key={key} data-on={resolved.model === key || undefined}>{label}</span>)}</div>;
  const summary = `${t('{seconds} s', { seconds: resolved.outputSeconds })} · ${resolutionLabel(applied.videoResolution)} · ≈$${price}`;
  if (data.collapsed && !light) return <NodeContextMenu id={id} type="text" actions={canvas}><article className="collapsed-node lod-node video-prompt-collapsed">
    <i {...lodHandleProps('target')}/><Icon name="film" size={26}/>{pending && <span className="collapsed-run-dot"/>}
    <button type="button" className="collapsed-node-expand nodrag" aria-label={t('Expand node')} data-tooltip={t('Expand node')} onClick={() => canvas.toggleNodeCollapsed(id)}><Icon name="expand" size={15}/></button><i {...lodHandleProps('source')}/>
  </article></NodeContextMenu>;
  // Zoomed out the card keeps its size and rows, so links stay put, but holds no controls.
  if (light) return <article className={`node-card text-node lod-node describe-node upscale-node video-prompt${pending ? ' working' : ''}${data.collapsed ? ' collapsed-node' : ''}`}>
    <i {...lodHandleProps('target')}/><header><span className="describe-label"><Icon name="film" size={14}/>{t('Video')}</span></header>
    {!data.collapsed && <><div className="upscale-settings">{modelChips(false)}<small>{summary}</small></div><p className="video-light-text">{text}</p></>}<i {...lodHandleProps('source')}/>
  </article>;
  const clamps = clampLines(resolved), blocked = !state.ready || resolved.blocked || !text.trim();
  const runTip = !state.ready ? state.note : resolved.blocked ? t(resolved.issues[0].reason) : !text.trim() ? t('Describe the motion first') : t('Generate a {seconds} s video with {model} · about ${price}', { seconds: resolved.outputSeconds, model: videoModels[resolved.model].name, price });
  const canCancel = state.starting || state.byName === state.userName, followsImage = resolved.followsImage;
  return <NodeContextMenu id={id} type="text" actions={canvas}><article className={`node-card text-node describe-node upscale-node video-prompt${pending ? ' working' : ''}`}>
    <Handle type="target" position={Position.Left} aria-label={t('Connect images or videos as inputs')}/>
    <header className="node-drag"><span className="describe-label"><Icon name="film" size={14}/>{t('Video')}</span>
      <div className="run-controls nodrag"><div className="generate-slot">{pending && <span className="generation-label" role="status">{t('Generating video')}… {state.timer}</span>}
        <button className={`run-button nano${pending ? ' run-pending' : ''}`} type="button" data-analytics-name="Generate video" aria-label={runTip} data-tooltip={runTip} disabled={disabled || blocked} onClick={event => canvas.run(id, null, event)}>
          {pending ? <i className="model-spinner" aria-hidden="true"/> : <span aria-hidden="true">▶</span>}<span>{t('{seconds} s · ≈${price}', { seconds: resolved.outputSeconds, price })}</span></button></div>
        {pending && canCancel && state.active && <button className="run-cancel" type="button" onClick={() => canvas.cancel(state.runId)}>{t('Cancel')}</button>}</div>
      <button className="text-node-collapse nodrag" type="button" aria-label={t('Collapse node')} data-tooltip={t('Collapse node')} onClick={() => canvas.toggleNodeCollapsed(id)}><Icon name="collapse" size={15}/></button></header>
    <div className="video-body nodrag nopan nowheel">
      <div className="upscale-settings video-models">{modelChips(true)}<small>{t(modelHints[resolved.model])} {t('{price} a second', { price: perSecond(resolved.rate) })}</small></div>
      <textarea className="video-text" aria-label={t('Video prompt')} placeholder={t('Describe the motion. Mention inputs as #1, #2.')} value={text} disabled={state.readOnly} onChange={event => changeText(event.target.value)} onBlur={() => { edited.current = false; }} onKeyDown={event => event.stopPropagation()}/>
      <section className="video-inputs" aria-label={t('Inputs')}>
        {resolved.inputs.length ? resolved.inputs.map(input => {
          const reasons = resolved.issues.filter(issue => issue.nodeIds.includes(input.nodeId)).map(issue => t(issue.reason));
          return <div key={input.nodeId} className={`video-input${reasons.length ? ' unsupported' : ''}`}>
            {input.kind === 'video' ? <span className="video-input-preview">{input.poster ? <img src={assetUrl(input.poster)} alt="" loading="lazy" draggable="false"/> : <Icon name="film" size={20}/>}<em>{t('{seconds} s', { seconds: Number(input.duration?.toFixed(1)) || '?' })}</em></span> : <img src={assetUrl(input.asset)} alt="" loading="lazy" draggable="false"/>}<span className="video-input-number">#{input.number}</span>
            <select aria-label={t(input.kind === 'video' ? 'Role of video #{number}' : 'Role of image #{number}', { number: input.number })} value={input.role} disabled={disabled} onChange={event => canvas.setVideoRole(id, input.nodeId, event.target.value)}>{rolesForVideoInput(input).map(role => <option key={role} value={role}>{t((input.kind === 'video' ? clipRoleLabels : roleLabels)[role])}</option>)}</select>
            <button type="button" className="video-input-remove" disabled={disabled} aria-label={t(input.kind === 'video' ? 'Disconnect video #{number}' : 'Disconnect image #{number}', { number: input.number })} data-tooltip={t(input.kind === 'video' ? 'Disconnect video #{number}' : 'Disconnect image #{number}', { number: input.number })} onClick={() => canvas.disconnectVideo(id, input.nodeId)}><Icon name="close" size={12}/></button>
            {reasons.length > 0 && <small>{reasons.join(' ')}</small>}</div>;
        }) : <p className="video-empty">{t('Connect images or MP4 videos. Images default to Start, then End; videos default to Reference. Without inputs, generate from text.')}</p>}
      </section>
      <div className="video-settings">
        <label><span>{t('Length')}</span><span className="video-field"><input type="number" min={videoModels[resolved.model].min} max={videoModels[resolved.model].max} step="1" value={requested.duration} disabled={disabled || resolved.autoLength} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= 120) set('duration', value); }}/><em>{t('s')}</em></span><small>{resolved.autoLength ? t('From video') : t('{min}–{max} s', { min: videoModels[resolved.model].min, max: resolved.model === 'omni' && resolved.inputs.some(input => input.role === 'end') ? 10 : videoModels[resolved.model].max })}</small></label>
        <label><span>{t('Quality')}</span><select value={applied.videoResolution} disabled={disabled} onChange={event => set('videoResolution', event.target.value)}>{resolved.resolutions.map(value => <option key={value} value={value}>{resolutionLabel(value)}</option>)}</select><small>{t('{price} a second', { price: perSecond(resolved.rate) })}</small></label>
        <label><span>{t('Format')}</span>{resolved.followsVideo ? <><span className="video-static">{t('From video')}</span><small>{t('Follows the input video')}</small></> : followsImage ? <><span className="video-static">{t('From image')}</span><small>{t('Follows the start frame')}</small></> : <><select value={requested.videoAspectRatio === 'auto' ? 'auto' : applied.videoAspectRatio} disabled={disabled} onChange={event => set('videoAspectRatio', event.target.value)}>{['auto', ...resolved.aspects].map(value => <option key={value} value={value}>{value === 'auto' ? t('Auto') : value}</option>)}</select>{requested.videoAspectRatio === 'auto' && <small>{applied.videoAspectRatio === 'auto' ? t('Follows the inputs') : resolved.mode === 'text' ? t('16:9 without inputs') : t('{shape} from the inputs', { shape: applied.videoAspectRatio })}</small>}</>}</label>
      </div>
      {resolved.model === 'seedance' ? <label className="video-audio"><input type="checkbox" checked={applied.videoAudio} disabled={disabled} onChange={event => set('videoAudio', event.target.checked)}/>{t('Generate sound')}<small>{t('Same price')}</small></label>
        : audioNotes[resolved.model] && <small className="video-note">{t(audioNotes[resolved.model])}</small>}
      {resolved.inputSeconds > 0 && <small className="video-note">{t('Includes {seconds} s of input video', { seconds: Number(resolved.inputSeconds.toFixed(1)) })}</small>}
      {resolved.videos.length > 0 && ['minimax', 'omni'].includes(resolved.model) && <small className="video-note">{t(resolved.model === 'omni' ? 'Input token cost is estimated at 1024 tokens/s; fal does not publish a video token rate.' : 'Input token cost is estimated from MiniMax’s table; frame rate and shape affect it.')}</small>}
      {resolved.model === 'seedance' && resolved.videos.some(input => !input.fps) && <small className="video-note">{t('Seedance checks the required 24–60 fps upstream; browser metadata does not report frame rate.')}</small>}
      {clamps.map(line => <small className="video-clamp" key={line}>{line}</small>)}
      {resolved.issues.filter(issue => !issue.nodeIds.length || !resolved.inputs.length).map((issue, index) => <small className="video-issue" role="alert" key={index}>{t(issue.reason)}</small>)}
      {!state.ready && state.note && <small className="video-issue">{state.note}</small>}
      {['error', 'failed'].includes(state.status) && <div className="node-error" role="alert">{t(state.error)}</div>}
      <small className="video-note">{t('Prices are approximate; references may add a little.')}</small>
    </div><Handle type="source" position={Position.Right}/>
  </article></NodeContextMenu>;
}
function VideoPoster({ data, assetUrl }) {
  const image = useCanvasImage(data.poster ? assetUrl(data.poster) : '', { small: true, create: !!data.poster });
  return image.src ? <img src={image.src} alt="" draggable="false"/> : <span className="video-placeholder">{t('Video')}</span>;
}
export function VideoNode({ id, data, assetUrl }) {
  const canvas = useCanvas(), detail = useDetail(id), video = useRef(null), [error, setError] = useState('');
  const light = detail !== 'full' || data.collapsed;
  return <NodeContextMenu id={id} type="video" actions={canvas}><article className={`node-card video-node${light ? ' lod-node' : ''}${data.collapsed ? ' collapsed-node' : ''}`}>
    {light ? <><i {...lodHandleProps('target')}/><i {...lodHandleProps('source')}/></> : <><Handle type="target" position={Position.Left} isConnectable={false}/><Handle type="source" position={Position.Right} aria-label={t('Connect video as reference')}/></>}
    <header className="node-drag">{data.name}</header>
    <div className="video-player nodrag nopan" onDoubleClick={event => event.stopPropagation()}>{light ? <VideoPoster data={data} assetUrl={assetUrl}/> : <video ref={video} src={assetUrl(data.asset)} poster={data.poster ? assetUrl(data.poster) : undefined} controls loop muted autoPlay={false} playsInline preload="none" onLoadedMetadata={event => canvas.learnVideoMetadata?.(id, event.currentTarget)} onError={() => setError(t('Could not play this video. Download the MP4 to inspect it.'))}/>}</div>
    {data.collapsed && detail === 'full' && <button type="button" className="collapsed-node-expand nodrag" aria-label={t('Expand node')} onClick={() => canvas.toggleNodeCollapsed(id)}>{t('Open')}</button>}
    {!light && <><div className="video-actions nodrag nopan"><a href={assetUrl(data.asset)} download={data.fileName || `${data.name}.mp4`}>{t('Download MP4')}</a><a href={assetUrl(data.asset)} target="_blank" rel="noreferrer">{t('Open')}</a><button type="button" onClick={() => video.current?.requestFullscreen?.().catch(() => setError(t('Fullscreen is unavailable. Use Open.')))}>{t('Fullscreen')}</button></div>
      <small className="video-info" title={data.endpoint}>{t('Info')}: {data.uploaded ? data.fileName || data.name : videoModels[data.videoModel]?.name || t('Video')} · {t('{seconds} s', { seconds: data.duration })} · {data.uploaded ? `${data.width} × ${data.height}` : <>{data.videoResolution} · ≈${money(data.usd || 0)}<br/>{data.endpoint}</>}</small>{error && <div className="node-error" role="alert">{error}</div>}</>}
  </article></NodeContextMenu>;
}
