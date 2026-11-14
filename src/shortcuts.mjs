export const isMacPlatform = platform => /Mac|iPhone|iPad|iPod/i.test(platform || '');
export const shortcutLabel = (keys, mac) => keys.replace(/Mod\+/g, mac ? '⌘ ' : 'Ctrl+').replace(/Shift\+/g, mac ? '⇧ ' : 'Shift+');
// The physical ?/ key also counts, so it works with a Ukrainian or other non-Latin layout active.
export const isHelpShortcut = event => (event.key === '?' || (event.code === 'Slash' && event.shiftKey)) && !event.metaKey && !event.ctrlKey && !event.altKey && !event.repeat && !event.isComposing
  && !event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]');

// Descriptions include context where a shortcut only works in a focused control.
export const keyboardShortcuts = [
  { keys: 'V', label: 'Select', group: 'Canvas tools' },
  { keys: 'P', label: 'Pen', group: 'Canvas tools' },
  { keys: 'S', label: 'Sticky note', group: 'Canvas tools' },
  { keys: 'E', label: 'Stamp', group: 'Canvas tools' },
  { keys: 'R', label: 'Rectangle', group: 'Canvas tools' },
  { keys: 'O', label: 'Ellipse', group: 'Canvas tools' },
  { keys: 'L / X', label: 'Arrow', group: 'Canvas tools' },
  { keys: 'Shift+S', label: 'Wrap selection in a section, or choose Section', group: 'Canvas tools' },
  { keys: 'T', label: 'Add text prompt', group: 'Canvas tools' },
  { keys: 'Mod+D', label: 'Duplicate selection with connections', group: 'Editing' },
  { keys: 'Mod+Z', label: 'Undo', group: 'Editing' },
  { keys: 'Mod+Shift+Z', label: 'Redo', group: 'Editing' },
  { keys: 'Delete / Backspace', label: 'Delete selection', group: 'Editing' },
  { keys: 'Mod+Enter', label: 'Generate (in a prompt editor)', group: 'Editing' },
  { keys: 'Mod+C', label: 'Copy selected nodes or image', group: 'Editing' },
  { keys: 'Mod+Shift+C', label: 'Copy selected node, group or section IDs', group: 'Editing' },
  { keys: 'Mod+V', label: 'Paste text, images or copied nodes', group: 'Editing' },
  { keys: 'F2', label: 'Rename page (when its button has focus)', group: 'Editing' },
  { keys: ']', label: 'Bring to front', group: 'Layers' },
  { keys: 'Mod+]', label: 'Bring forward', group: 'Layers' },
  { keys: 'Mod+[', label: 'Send backward', group: 'Layers' },
  { keys: '[', label: 'Send to back', group: 'Layers' },
  { keys: 'Escape', label: 'Return to Select / close dialog', group: 'Navigation' },
  { keys: '?', label: 'Keyboard shortcuts', group: 'Navigation' },
  { keys: '+ / −', label: 'Zoom image (fullscreen)', group: 'Navigation' },
  { keys: '0', label: 'Fit image (fullscreen)', group: 'Navigation' },
  { keys: '1', label: 'Real pixels (fullscreen)', group: 'Navigation' },
  { keys: '← / → / ↑ / ↓', label: 'Pan image (fullscreen)', group: 'Navigation' }
];
