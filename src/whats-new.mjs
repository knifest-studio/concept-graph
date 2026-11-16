// The six newest updates, newest first. Keep IDs stable: seeing this list acknowledges only these entries.
export const whatsNewEntries = [
  { id: 'team-key-start', title: 'Generate right away', benefit: 'With team access, new prompts start on Nano Banana when your Codex isn’t connected, and a generator you can’t use says whom to ask. When several people generate at once, the board queues their runs instead of interrupting them.' },
  { id: 'connection-numbers', title: 'Point at images by number', benefit: 'Select a prompt to see 1, 2, 3… on its image connections, in the order you connected them. Write “make image 2 like the first one” and every generator knows which is which.' },
  { id: 'generation-settings', title: 'Choose the shape and size', benefit: 'Set the aspect ratio, size, thinking or quality and a transparent background from the button beside a prompt’s variants. Image details now show the reference images a run used.' },
  { id: 'variants-shortcuts', title: 'More variants, tidier boards', benefit: 'Generate up to 32 variants at once on team boards and find results right beside their prompt. The generations tray folds away and clears itself, and oversized images are reduced for you (or use Resize…). Shortcuts work on any keyboard layout, now group and ungroup too, and you can change them in Settings; hold Alt while dragging to make a copy.' },
  { id: 'model3d', title: 'Turn images into 3D', benefit: 'On team boards, connect images to a 3D model node. Rotate the result, download its GLB, or save the current view as an image reference.' },
  { id: 'system-theme', title: 'Your theme, your choice', benefit: 'Follow your system theme, or pick Light, Dark or System in Settings.' }
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
