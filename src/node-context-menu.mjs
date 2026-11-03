// While a node menu has focus, its shortcuts apply to that node, not a previous selection.
export function contextMenuShortcut(event, type) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'c') return null;
  if (event.shiftKey) return 'id';
  return type === 'image' ? 'image' : null;
}
