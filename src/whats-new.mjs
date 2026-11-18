// The six newest updates, newest first. Keep IDs stable: seeing this list acknowledges only these entries.
export const whatsNewEntries = [
  { id: 'video-node', title: 'One Video node, four models', benefit: 'Choose MiniMax, Omni, Kling or Seedance. Assign Start, End, Middle or Reference to each image; settings stay stored when switching models, with visible limits and an approximate cost before generating.' },
  { id: 'cloud-update-notice', title: 'Know when the app updates', benefit: 'A small notice lets you reload for the latest version when you are ready.' },
  { id: 'resize-all-references', title: 'Resize all and generate', benefit: 'If references are too large to reduce automatically, resize them together and continue generating with one click. You can undo the resize.' },
  { id: 'quieter-generation-chip', title: 'Ready with the team key', benefit: 'The top bar shows Ready to generate when your chosen generator can use the team key. Click it any time to connect Codex or an AI agent.' },
  { id: 'team-key-start', title: 'Generate right away', benefit: 'With team access, new prompts start on Nano Banana when your Codex isn’t connected. Without it, Request access in the generator menu asks the admins for you. When several people generate at once, the board queues their runs instead of interrupting them.' },
  { id: 'connection-numbers', title: 'Point at images by number', benefit: 'Select a prompt to see 1, 2, 3… on its image connections, in the order you connected them. Write “make image 2 like the first one” and every generator knows which is which.' },
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
