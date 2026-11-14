import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { templateColor } from '../graph.mjs';
import { t } from './i18n.mjs';
import { rich } from './i18n-rich.jsx';
import { track } from './analytics.mjs';

export function CustomNodesCard({ cloud, hosted, readOnly, disabled, templates, error, retry, toolDrag, add, edit, view, create, copy, invitation, dismiss, Icon }) {
  const card = useRef(null), [position, setPosition] = useState(null);
  const invitationShown = useRef(false);
  useEffect(() => { if (invitation && position && !invitationShown.current) { invitationShown.current = true; track('tip_event', { tip: 'custom_nodes_invite', action: 'shown' }); } }, [invitation, position]);
  useLayoutEffect(() => {
    if (!invitation) return;
    const place = () => {
      const box = card.current.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(box.right + 10, innerWidth - 240)), top: Math.max(8, Math.min(box.top, innerHeight - 150)) });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    const observer = new ResizeObserver(place); observer.observe(card.current);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [invitation]);
  return <><section ref={card} className="custom-nodes" aria-label={t('Custom nodes')}>
    <div className="custom-nodes-heading"><span className="eyebrow">{t('CUSTOM NODES')}</span><small>{cloud ? t('this board') : hosted ? t('in this workspace') : t('on this computer')}</small></div>
    <p className="custom-nodes-subtitle">{t('Reuse instructions and reference images.')}</p>
    {error ? <button className="custom-retry" type="button" onClick={retry}>{error} {t('Retry')}</button> : templates.length ? <div className="custom-nodes-list">{templates.map(template => <div className="custom-node-row" key={template.id} style={{ '--template-color': templateColor(template) }}>
      <button className="custom-node-add" type="button" disabled={disabled} aria-label={readOnly ? t('View {name}', { name: template.name }) : t('Add {name}', { name: template.name })} {...(readOnly || disabled ? {} : toolDrag({ kind: 'template', id: template.id }))} onClick={() => readOnly ? view(template) : add(template)} data-tooltip={readOnly ? t('View this custom node') : t('Add custom node to board')}><span className="custom-node-glyph"><Icon name="text" size={16}/></span><span>{template.name}</span></button>
      {!readOnly && <button className="icon-button custom-node-edit" type="button" disabled={disabled} aria-label={t('Edit {name}', { name: template.name })} data-tooltip={t('Edit custom node')} onClick={() => edit(template)}><Icon name="edit" size={13}/></button>}
    </div>)}</div> : <p className="custom-nodes-empty">{readOnly ? t('This board has no custom nodes.') : rich('For example, {name}: “front, side and back view of the same character on a plain background” + 2 reference images.', { name: <strong>{t('Character multiview')}</strong> })}</p>}
    {!readOnly && <><button className="new-custom-node" type="button" disabled={disabled} onClick={() => create('sidebar')}>{t('+ New custom node')}</button>{cloud && <button type="button" className="copy-custom-link" disabled={disabled} onClick={copy}>{t('Copy from another board…')}</button>}</>}
  </section>{invitation && position && createPortal(<aside className="custom-node-invitation" style={position} aria-label={t('Custom nodes')}><button className="invitation-close" type="button" aria-label={t('Dismiss custom node invitation')} onClick={dismiss}>×</button><p>{t("Save a prompt's instructions and reference images as your own node.")}</p><button className="primary-button" type="button" onClick={() => { track('tip_event', { tip: 'custom_nodes_invite', action: 'accepted' }); create('invite'); }}>{t('Try it')}</button></aside>, document.body)}</>;
}
