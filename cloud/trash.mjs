import { getServerByName } from 'partyserver';

// Once a day, boards that spent 30 days in the trash are erased for good: first the room's storage and versions, then
// the board's row, so a failure leaves it to be tried again the next day.
export async function purgeTrash(env) {
  const store = env.Directory.get(env.Directory.idFromName('boards'));
  for (const id of await store.expiredBoards()) {
    try { await (await getServerByName(env.BoardRoom, id)).destroy(); await store.forgetBoard(id); }
    catch (cause) { console.error('Could not erase a board from the trash:', id, cause); }
  }
}
