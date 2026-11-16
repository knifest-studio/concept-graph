// The six newest updates, newest first. Keep IDs stable: seeing this list acknowledges only these entries.
export const whatsNewEntries = [
  { id: 'variants-shortcuts', title: 'More variants, tidier boards', benefit: 'Generate up to 32 variants at once on team boards and find results right beside their prompt. The generations tray folds away and clears itself, and oversized images are reduced for you (or use Resize…). Shortcuts work on any keyboard layout, now group and ungroup too, and you can change them in Settings; hold Alt while dragging to make a copy.' },
  { id: 'model3d', title: 'Turn images into 3D', benefit: 'On team boards, connect images to a 3D model node. Rotate the result, download its GLB, or save the current view as an image reference.' },
  { id: 'system-theme', title: 'Your theme, your choice', benefit: 'Follow your system theme, or pick Light, Dark or System in Settings.' },
  { id: 'custom-node-discovery', title: 'Keep your best prompts handy', benefit: 'Find custom nodes in Create, save a prompt from its toolbar, or copy custom nodes from another team board.' },
  { id: 'gpt-image', title: 'Another way to generate', benefit: 'Choose GPT Image on team boards for another take on your ideas.' },
  { id: 'crop-mask', title: 'Edit right on the canvas', benefit: 'Crop images or paint a mask to show what you want to change on team boards.' }
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
