import { matchShortcut } from './shortcuts.mjs';

// While a node menu has focus, its shortcuts apply to that node, not a previous selection.
export function contextMenuShortcut(event, type, ctx) {
  const action = matchShortcut(event, { editing: false, ...ctx, scopes: ['canvas'], ids: ['copy.ids', 'edit.copy'] });
  if (action === 'copy.ids') return 'id';
  return action === 'edit.copy' && type === 'image' ? 'image' : null;
}
