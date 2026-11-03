import React, { cloneElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { contextMenuShortcut } from './node-context-menu.mjs';
import './node-context-menu.css';

export function NodeContextMenu({ children, id, type, actions }) {
  const [position, setPosition] = useState(null);
  const menu = useRef(null);
  const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
  const shortcut = isMac ? '⌘ C' : 'Ctrl+C';
  const idShortcut = isMac ? '⌘ ⇧ C' : 'Ctrl+Shift+C';

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
    if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); choose(actions.removeNode); return; }
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
    {position && createPortal(<div ref={menu} className="node-context-menu" role="menu" aria-label={`${type === 'group' ? 'Group' : type === 'image' ? 'Image' : 'Prompt'} options`} onContextMenu={event => event.preventDefault()} onKeyDown={onKeyDown}>
      {type === 'image' && <button type="button" role="menuitem" onClick={() => choose(actions.copyImage)}><span>Copy image</span><kbd>{shortcut}</kbd></button>}
      {type === 'text' && <button type="button" role="menuitem" onClick={() => choose(actions.saveTemplateFromNode)}>Save as custom node</button>}
      <button type="button" role="menuitem" onClick={() => choose(actions.removeNode)}>{type === 'group' ? 'Delete group; keep nodes' : 'Delete node'}</button>
      <button type="button" role="menuitem" onClick={() => choose(actions.copyNodeId)}><span>Copy {type === 'group' ? 'group' : 'node'} ID</span><kbd>{idShortcut}</kbd></button>
    </div>, document.body)}
  </>;
}
