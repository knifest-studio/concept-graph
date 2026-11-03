import { assetPattern } from './assets.mjs';

export function boardStats(doc) {
  const images = [...doc.getMap('nodes').values()].filter(node => node?.get?.('type') === 'image');
  const latest = images.map(node => node.get('data')?.toJSON?.() || {}).sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  return { imageCount: images.length, covers: [...new Set(latest.map(data => data.asset).filter(asset => typeof asset === 'string' && assetPattern.test(asset)))].slice(0, 4) };
}
