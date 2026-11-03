import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAddedGroups } from '../src/canvas.mjs';

test('merge adds only new remote members while preserving local group edits', () => {
  const nodes = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  const base = [{ id: 'g', name: 'Group', nodeIds: ['a', 'b'], collapsed: false }];
  const remote = [{ ...base[0], nodeIds: ['a', 'b', 'c', 'd'] }];
  const local = [{ ...base[0], name: 'Renamed', collapsed: true, nodeIds: ['b'] },
    { id: 'manual', name: 'Manual', nodeIds: ['d'], collapsed: false }];
  const merged = mergeAddedGroups(local, remote, base, nodes);
  assert.deepEqual(merged[0], { id: 'g', name: 'Renamed', nodeIds: ['b', 'c'], collapsed: true });
  assert.deepEqual(merged[1], local[1]);
  assert.deepEqual(local[0].nodeIds, ['b']);
});

test('a locally ungrouped group is not recreated by a later output', () => {
  const base = [{ id: 'g', name: 'Group', nodeIds: ['a', 'b'], collapsed: false }];
  const remote = [{ ...base[0], nodeIds: ['a', 'b', 'c'] }];
  assert.deepEqual(mergeAddedGroups([], remote, base, ['a', 'b', 'c'].map(id => ({ id }))), []);
});
