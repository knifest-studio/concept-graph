// Newest first. Keep IDs stable: seeing this list acknowledges only these entries.
export const whatsNewEntries = [
  { id: 'system-theme', title: 'Your theme, your choice', benefit: 'Follow your system theme, or pick Light, Dark or System in Settings.' },
  { id: 'custom-node-discovery', title: 'Keep your best prompts handy', benefit: 'Find custom nodes in Create, save a prompt from its toolbar, or copy custom nodes from another team board.' },
  { id: 'gpt-image', title: 'Another way to generate', benefit: 'Choose GPT Image on team boards for another take on your ideas.' },
  { id: 'crop-mask', title: 'Edit right on the canvas', benefit: 'Crop images or paint a mask to show what you want to change on team boards.' },
  { id: 'board-chat', title: 'Talk it through', benefit: 'Use text and voice chat with your teammates right on the board.' },
  { id: 'reopen-view', title: 'Pick up where you left off', benefit: 'Boards remember your open page and view on this device.' }
];
export const whatsNewSeenKey = 'concept-graph-whats-new-seen';
export function readWhatsNewSeen(storage) {
  try {
    const value = JSON.parse(storage.getItem(whatsNewSeenKey));
    return Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
  } catch { return []; }
}
export const hasUnseenWhatsNew = (seen, entries = whatsNewEntries) => entries.some(entry => !seen.includes(entry.id));
export function markWhatsNewSeen(storage, entries = whatsNewEntries) {
  const seen = [...new Set([...readWhatsNewSeen(storage), ...entries.map(entry => entry.id)])];
  try { storage.setItem(whatsNewSeenKey, JSON.stringify(seen)); } catch {}
  return seen;
}
