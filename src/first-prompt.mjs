// The first thing a newcomer is shown on a board others already filled: where to start their own prompt and, once it
// exists, to write it and press Generate. On Nov 16, 4 of 13 newcomers never wrote a prompt while the custom-node
// invitation took the first second of their visit; that invitation now waits for their first image (invitationDue).
export const firstPromptHintKey = 'concept-graph-first-prompt-hint';
export const firstPromptHintDismissed = (storage = globalThis.localStorage) => { try { return storage.getItem(firstPromptHintKey) === 'dismissed'; } catch { return false; } };
export const dismissFirstPromptHint = (storage = globalThis.localStorage) => { try { storage.setItem(firstPromptHintKey, 'dismissed'); } catch {} };
// 'add' until this person adds a prompt, then 'write' on the first image prompt they added this visit until they start
// a generation.
export function firstPromptStep({ dismissed, readOnly, emptyBoard, done, startedRuns, ownPrompt }) {
  if (dismissed || readOnly) return null;
  if (!done.prompt) return emptyBoard ? null : 'add';
  return ownPrompt && !startedRuns && !done.generate ? 'write' : null;
}
