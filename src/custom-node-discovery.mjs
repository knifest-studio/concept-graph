export const discoveryKey = 'concept-graph-custom-nodes';
export function readDiscovery(storage) {
  try { return JSON.parse((storage || globalThis.localStorage).getItem(discoveryKey)) || {}; } catch { return {}; }
}
export function writeDiscovery(storage, change) {
  const next = { ...readDiscovery(storage), ...change };
  try { (storage || globalThis.localStorage).setItem(discoveryKey, JSON.stringify(next)); } catch {}
  return next;
}
// The invitation waits for this person's first image: shown in a newcomer's first second (Nov 16), it was mostly
// dismissed unread, and custom nodes mean little before someone has made an image.
export const invitationDue = ({ loaded, canvas, readOnly, generated, discovery }) => !!(loaded && canvas && !readOnly && generated && !discovery.used && !discovery.invitationSeen);
export const plainPrompt = node => node?.type === 'text' && !node.data.task && !node.data.template;
export function reusableDuplicate(node, nodes, edges) {
  const text = node?.data.text?.trim() || '';
  return plainPrompt(node) && !!text && (text.length > 40 || edges.some(edge => edge.target === node.id && nodes.some(source => source.id === edge.source && source.type === 'image')));
}
