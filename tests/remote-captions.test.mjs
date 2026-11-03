import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRemoteImageCaptions } from '../src/canvas.mjs';

test('generated captions merge without overwriting local edits or restoring deleted nodes', () => {
  const image = (id, caption) => ({ id, type: 'image', data: caption === undefined ? { asset: id } : { asset: id, caption } });
  const base = [image('a'), image('b', 'Old'), image('c'), image('deleted')];
  const local = [image('a'), image('b', 'Edited'), image('c', '')];
  const remote = [image('a', 'Image 1'), image('b', 'New'), image('c', 'Image 3'), image('deleted', 'Image 4')];
  const merged = mergeRemoteImageCaptions(local, remote, base);
  assert.deepEqual(merged.map(node => node.data.caption), ['Image 1', 'Edited', '']);
  assert.equal(merged.length, 3);
  assert.equal(local[0].data.caption, undefined);
});
