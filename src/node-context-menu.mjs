import { matchShortcut } from './shortcuts.mjs';

// While a node menu has focus, its shortcuts apply to that node, not a previous selection.
export function contextMenuShortcut(event, type, ctx) {
  const action = matchShortcut(event, { editing: false, ...ctx, scopes: ['canvas'], ids: ['copy.ids', 'edit.copy', 'group.remove'] });
  if (action === 'copy.ids') return 'id';
  // A group's menu shows the Ungroup keys, so they remove that group rather than the groups of the selection.
  if (action === 'group.remove') return type === 'group' ? 'ungroup' : null;
  return action === 'edit.copy' && type === 'image' ? 'image' : null;
}
