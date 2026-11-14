import React, { useEffect, useRef } from 'react';
import { NodeToolbar, Position, useStore } from '@xyflow/react';
import { NodeContextMenu } from './NodeContextMenu.jsx';
import { t } from './i18n.mjs';
import { track } from './analytics.mjs';
import { isMacPlatform, shortcutLabel } from './shortcuts.mjs';

const duplicateShortcut = shortcutLabel('Mod+D', isMacPlatform(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent));

export function CustomNodeActions({ node, tip, actions, onDismiss }) {
  const hidden = useStore(state => state.transform[2] < .38 || state.connection.inProgress || !!state.nodeLookup.get(node?.id || tip?.id)?.dragging);
  const shown = useRef(null);
  useEffect(() => { if (!hidden && tip && shown.current !== tip.id) { shown.current = tip.id; track('tip_event', { tip: 'duplicate_to_custom_node', action: 'shown' }); } }, [hidden, tip?.id]);
  if (hidden) return null;
  return <>
    {node && <NodeContextMenu id={node.id} type="text" actions={actions}>{open => <NodeToolbar nodeId={node.id} isVisible position={Position.Top} offset={12} role="toolbar" aria-label={t('Prompt options')} className="prompt-actions nodrag nopan" onPointerDown={event => event.stopPropagation()}>
      <button type="button" onClick={() => actions.duplicateNode(node.id)} data-tooltip={t('Duplicate')}><span>{t('Duplicate')}</span> <kbd>{duplicateShortcut}</kbd></button>
      <button type="button" onClick={() => actions.saveTemplateFromNode(node.id, 'node_toolbar')}>{t('Save as custom node')}</button>
      <button type="button" aria-label={t('Prompt options')} data-tooltip={t('Prompt options')} onClick={open}>⋯</button>
    </NodeToolbar>}</NodeContextMenu>}
    {tip && <NodeToolbar nodeId={tip.id} isVisible position={Position.Right} offset={14} className="custom-node-tip nodrag nopan" onPointerDown={event => event.stopPropagation()}>
      <p>{t('Reusing these instructions and references? Save them as a custom node and add it from Create in one click.')}</p>
      <div><button type="button" className="primary-button" onClick={() => { track('tip_event', { tip: 'duplicate_to_custom_node', action: 'accepted' }); actions.saveTemplateFromNode(tip.id, 'tip'); }}>{t('Save as custom node')}</button><button type="button" onClick={onDismiss}>{t('Not now')}</button></div>
    </NodeToolbar>}
  </>;
}
