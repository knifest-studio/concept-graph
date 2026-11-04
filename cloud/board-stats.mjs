import { assetPattern } from './assets.mjs';

// One pass, without copying node data: the room runs this on every save, and a long sort here would hold up everyone's edits.
export function boardStats(doc) {
  let imageCount = 0;
  const top = [], newer = (a, b) => a.time > b.time || (a.time === b.time && a.index < b.index);
  for (const node of doc.getMap('nodes').values()) {
    if (node?.get?.('type') !== 'image') continue;
    const data = node.get('data'), asset = data?.get?.('asset'), entry = { asset, index: imageCount++, time: Date.parse(data?.get?.('createdAt')) || 0 };
    if (typeof asset !== 'string' || !assetPattern.test(asset)) continue;
    // The four newest distinct images, ties in document order, as a full sort would choose.
    const same = top.findIndex(item => item.asset === asset);
    if (same >= 0) { if (newer(entry, top[same])) top[same] = entry; else continue; }
    else if (top.length < 4) top.push(entry);
    else if (newer(entry, top[3])) top[3] = entry;
    else continue;
    top.sort((a, b) => newer(a, b) ? -1 : 1);
  }
  return { imageCount, covers: top.map(item => item.asset) };
}
