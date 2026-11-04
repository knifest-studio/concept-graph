import React, { cloneElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { contextMenuShortcut } from './node-context-menu.mjs';
import { layerShortcut } from './layers.mjs';
import { sectionPalette } from './sections.mjs';
import './node-context-menu.css';

// Every card renders one of these menus, so the platform labels are worked out once.
const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
const shortcut = isMac ? '⌘ C' : 'Ctrl+C';
const idShortcut = isMac ? '⌘ ⇧ C' : 'Ctrl+Shift+C';
const step = isMac ? '⌘ ' : 'Ctrl+';
const layers = [['front', 'Bring to front', ']'], ['forward', 'Bring forward', `${step}]`], ['backward', 'Send backward', `${step}[`], ['back', 'Send to back', '[']];

export function NodeContextMenu({ children, id, type, actions }) {
  const [position, setPosition] = useState(null);
  const menu = useRef(null);

  useLayoutEffect(() => {
    if (!position || !menu.current) return;
    const element = menu.current;
    element.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - element.offsetHeight - 8))}px`;
    element.querySelector('button')?.focus();
  }, [position]);

  useEffect(() => {
    if (!position) return;
    const closeOutside = event => { if (!menu.current?.contains(event.target)) setPosition(null); };
    const close = () => setPosition(null);
    document.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [position]);

  // A viewer's menu only copies. Read when the menu is open, so closed menus on every card cost nothing.
  const readOnly = !!position && !!actions.store?.get().readOnly;
  const open = event => {
    if (event.target.closest('input, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    event.stopPropagation();
    setPosition({ x: event.clientX, y: event.clientY });
  };
  const onKeyDown = event => {
    const shortcutAction = contextMenuShortcut(event, type);
    if (shortcutAction) {
      event.preventDefault(); event.stopPropagation();
      choose(shortcutAction === 'image' ? actions.copyImage : actions.copyNodeId);
      return;
    }
    const layer = !readOnly && !['group', 'section'].includes(type) && layerShortcut(event);
    if (layer) { event.preventDefault(); event.stopPropagation(); choose(nodeId => actions.arrange(layer, nodeId)); return; }
    if (!readOnly && ['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); choose(actions.removeNode); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPosition(null); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...menu.current.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };
  const choose = action => {
    action(id);
    setPosition(null);
  };
  return <>
    {cloneElement(children, { onContextMenu: open })}
    {position && createPortal(<div ref={menu} className="node-context-menu" role="menu" aria-label={`${type === 'text' ? 'Prompt' : type} options`} onContextMenu={event => event.preventDefault()} onKeyDown={onKeyDown}>
      {type === 'image' && <button type="button" role="menuitem" onClick={() => choose(actions.copyImage)}><span>Copy image</span><kbd>{shortcut}</kbd></button>}
      {!readOnly && <>{type === 'text' && <button type="button" role="menuitem" onClick={() => choose(actions.saveTemplateFromNode)}>Save as custom node</button>}
      {type === 'group' && <button type="button" role="menuitem" onClick={() => choose(actions.renameGroup)}>Rename</button>}
      {type === 'section' && <><button type="button" role="menuitem" onClick={() => choose(actions.renameSection)}>Rename</button>
        <div className="menu-colors" role="group" aria-label="Section color">{[undefined, ...sectionPalette].map(color => <button type="button" role="menuitem" key={color || 'default'} className="color-swatch" aria-label={color ? `Section color ${color}` : 'Default section color'} title={color || 'Default'} style={{ background: color || 'var(--card)' }} onClick={() => choose(sectionId => actions.editSection(sectionId, { color }))}/>)}</div><hr role="separator"/></>}
      {!['group', 'section'].includes(type) && <>{layers.map(([action, label, key]) => <button type="button" role="menuitem" key={action} onClick={() => choose(nodeId => actions.arrange(action, nodeId))}><span>{label}</span><kbd>{key}</kbd></button>)}<hr role="separator"/></>}
      <button type="button" role="menuitem" onClick={() => choose(actions.wrapInSection)}><span>Wrap in section</span><kbd>⇧ S</kbd></button>
      {type === 'section' && <button type="button" role="menuitem" onClick={() => choose(actions.unwrapSection)}>Remove section; keep contents</button>}
      <button type="button" role="menuitem" onClick={() => choose(actions.removeNode)}>{type === 'group' ? 'Delete group; keep nodes' : type === 'section' ? 'Delete section and contents' : 'Delete node'}</button></>}
      <button type="button" role="menuitem" onClick={() => choose(actions.copyNodeId)}><span>Copy {type === 'group' || type === 'section' ? type : 'node'} ID</span><kbd>{idShortcut}</kbd></button>
    </div>, document.body)}
  </>;
}
