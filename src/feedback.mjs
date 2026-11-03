import { eventOnce } from './sounds.mjs';

// Remember every observed ID, including history and deleted nodes, for this board session.
export function newOutputIds(seen, nodes, runs, live) {
  const outputs = new Set(runs.flatMap(run => run.outputIds || []));
  const fresh = [];
  for (const node of nodes) {
    const first = eventOnce(seen, node.id);
    if (live && first && node.type === 'image' && node.data.runId && outputs.has(node.id)) fresh.push(node.id);
  }
  return fresh;
}

export function cloudFeedback(transaction, provider, clientId, live) {
  const clients = [...transaction.afterState].filter(([id, clock]) => id !== clientId && clock > (transaction.beforeState.get(id) || 0));
  const peer = !transaction.local && clients.length === 1 ? provider.awareness.getStates().get(clients[0][0])?.user : null;
  return { live: !!live && provider.synced && provider.wsconnected, peer };
}
