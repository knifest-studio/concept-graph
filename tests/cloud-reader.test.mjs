import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { CloudGraphReader, applyLocalGraph, readCloudGraph } from '../src/cloud-sync.mjs';

const random = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

function node(doc, id, fields, data) {
  const entry = new Y.Map(), values = new Y.Map();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) entry.set(key, value);
  for (const [key, value] of Object.entries(data)) values.set(key, value);
  entry.set('data', values);
  doc.getMap('nodes').set(id, entry);
}

// Random remote writes, the way other replicas change the document.
function mutate(doc, next) {
  const pick = list => list[Math.floor(next() * list.length)], nodes = doc.getMap('nodes'), ids = [...nodes.keys()], page = () => pick([undefined, 'page-1', 'p2', 'gone']);
  const operation = Math.floor(next() * 16);
  doc.transact(() => {
    if (operation < 3 || ids.length < 4) {
      const id = `n${Math.floor(next() * 1e6)}`, type = pick(['text', 'image', 'image', 'sticky', 'stamp', 'drawing']);
      const data = type === 'text' ? { text: 'prompt' } : type === 'image' ? { asset: 'a.png', ...(next() < .7 ? { runId: 'r1' } : {}) } : type === 'stamp' ? { kind: 'like', ...(ids.length && next() < .8 ? { attachedTo: pick(ids) } : {}) } : { color: '#fff3cd', text: '' };
      node(doc, id, { type, x: Math.round(next() * 900), y: Math.round(next() * 900), page: page(), z: next() < .5 ? Math.round(next() * 9) : undefined,
        stampAttachment: data.attachedTo && next() < .8 ? { nodeId: data.attachedTo, x: 5, y: 7 } : undefined }, data);
    } else if (operation < 6) { const entry = nodes.get(pick(ids)); entry.set('x', Math.round(next() * 900)); entry.set('y', Math.round(next() * 900)); }
    else if (operation === 6) { const value = page(); if (value === undefined) nodes.get(pick(ids)).delete('page'); else nodes.get(pick(ids)).set('page', value); }
    else if (operation === 7) { const data = nodes.get(pick(ids)).get('data'); if (next() < .5) data.set('caption', `c${Math.floor(next() * 9)}`); else if (data.has('runId')) data.delete('runId'); else data.set('runId', 'r2'); }
    else if (operation === 8) nodes.delete(pick(ids));
    else if (operation === 9) { const edges = doc.getMap('edges'); if (next() < .3 && edges.size) edges.delete(pick([...edges.keys()])); else edges.set(`e${Math.floor(next() * 1e6)}`, { source: pick(ids), target: pick(ids) }); }
    else if (operation === 10) {
      const groups = doc.getMap('groups');
      if (next() < .25 && groups.size) groups.delete(pick([...groups.keys()]));
      else { const group = new Y.Map(); group.set('name', 'G'); group.set('collapsed', next() < .3); group.set('nodeIds', [pick(ids), pick(ids), pick(ids)]); if (next() < .5) group.set('color', '#dcf3ef'); groups.set(`g${Math.floor(next() * 1e6)}`, group); }
    }
    else if (operation === 11) { const runs = doc.getMap('runs'), id = next() < .5 && runs.size ? pick([...runs.keys()]) : `r${Math.floor(next() * 1e6)}`; if (next() < .15) runs.delete(id); else runs.set(id, { id, nodeId: pick(ids), status: pick(['queued', 'completed']), startedAt: `2026-11-0${1 + Math.floor(next() * 3)}T00:00:00.000Z`, outputIds: [] }); }
    else if (operation === 12) { const pages = doc.getMap('pages'); if (next() < .3) pages.delete('p2'); else { pages.set('page-1', { name: 'Page 1', order: 0 }); pages.set('p2', { name: 'Two', order: 1 }); } }
    else if (operation === 14) {
      // Sections, sometimes with values another replica got wrong.
      const section = new Y.Map(), fields = { name: pick(['Moodboard', '', '  Spaced  ']), x: Math.round(next() * 900), y: next() < .05 ? 'bad' : Math.round(next() * 900), width: pick([150, 400, 900]), height: pick([90, 300]), color: pick([undefined, '#dceaff', 'red']), page: page() };
      for (const [key, value] of Object.entries(fields)) if (value !== undefined) section.set(key, value);
      doc.getMap('sections').set(`s${Math.floor(next() * 1e6)}`, section);
    }
    else if (operation === 15) {
      const sections = doc.getMap('sections'), keys = [...sections.keys()];
      if (!keys.length) return;
      const section = sections.get(pick(keys)), change = Math.floor(next() * 5);
      if (change === 0) sections.delete(pick(keys));
      else if (change === 1) { section.set('x', Math.round(next() * 900)); section.set('y', Math.round(next() * 900)); }
      else if (change === 2) section.set('width', pick([100, 500, 1200]));
      else if (change === 3) { if (next() < .5) section.delete('color'); else section.set('color', '#fff3cd'); }
      else { const value = page(); if (value === undefined) section.delete('page'); else section.set('page', value); }
    }
    else { const edges = doc.getMap('edges'); const [a, b] = [pick(ids), pick(ids)]; edges.set(`e${Math.floor(next() * 1e6)}`, { source: a, target: b }); edges.set(`e${Math.floor(next() * 1e6)}`, { source: b, target: a }); }
  });
}

// The editor's own copy: selection, measurements and unsaved positions on some objects.
function localCopy(graph, next) {
  if (!graph) return undefined;
  const touch = item => next() < .1 ? { ...item, selected: true } : next() < .05 ? { ...item, measured: { width: 310, height: 200 } } : item;
  const nodes = graph.nodes.filter(() => next() > .05).map(item => next() < .05 ? { ...item, position: { x: item.position.x + 1, y: item.position.y } } : next() < .03 ? { ...item, page: 'p2' } : touch(item));
  return { nodes: next() < .2 ? [...nodes].reverse() : nodes, edges: graph.edges.map(touch), groups: graph.groups.map(item => next() < .1 ? { ...item, selected: true, color: '#ffffff' } : item),
    sections: graph.sections?.filter(() => next() > .05).map(item => next() < .1 ? { ...item, selected: true } : next() < .05 ? { ...item, color: '#ffffff', page: 'p2' } : item) };
}

test('the incremental reader returns exactly what a full read returns, for any document and local copy', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const next = random(seed), doc = new Y.Doc(), reader = new CloudGraphReader(doc);
    let local;
    for (let step = 0; step < 400; step++) {
      mutate(doc, next);
      if (step % 3) continue;
      local = localCopy(local && { ...local, groups: local.groups || [] }, next);
      assert.deepEqual(reader.read(local), readCloudGraph(doc, local), `seed ${seed}, step ${step}`);
      assert.deepEqual(reader.read(), readCloudGraph(doc), `seed ${seed}, step ${step} without local`);
      local = reader.read(local);
    }
    reader.destroy();
  }
});

test('unchanged nodes, connections, groups and runs keep their identity across remote changes', () => {
  const doc = new Y.Doc(), reader = new CloudGraphReader(doc);
  doc.transact(() => {
    node(doc, 'a', { type: 'text', x: 0, y: 0 }, { text: 'one' });
    node(doc, 'b', { type: 'image', x: 400, y: 0 }, { asset: 'b.png', runId: 'r' });
    node(doc, 'c', { type: 'text', x: 800, y: 0 }, { text: 'two' });
    doc.getMap('edges').set('e1', { source: 'a', target: 'b' });
    const group = new Y.Map(); group.set('name', 'G'); group.set('collapsed', false); group.set('nodeIds', ['b', 'c']); doc.getMap('groups').set('g', group);
    doc.getMap('runs').set('r', { id: 'r', nodeId: 'a', status: 'completed', startedAt: '2026-11-04T00:00:00.000Z', outputIds: ['b'] });
  });
  const first = reader.read({ nodes: [], edges: [], groups: [] });
  const local = { ...first, nodes: first.nodes.map(item => item.id === 'c' ? { ...item, selected: true } : item) };
  doc.getMap('nodes').get('a').set('x', 50);
  const second = reader.read(local);
  assert.equal(second.nodes.find(item => item.id === 'b'), first.nodes.find(item => item.id === 'b'));
  assert.equal(second.nodes.find(item => item.id === 'c'), local.nodes.find(item => item.id === 'c'), 'local-only fields keep the local object');
  assert.notEqual(second.nodes.find(item => item.id === 'a'), first.nodes.find(item => item.id === 'a'));
  assert.equal(second.edges, local.edges); assert.equal(second.groups, local.groups); assert.equal(second.runs, first.runs);
  // Nothing changed: the caller's own arrays come back, so state setters can bail out.
  const third = reader.read(second);
  assert.equal(third.nodes, second.nodes); assert.equal(third.edges, second.edges);
  reader.destroy();
});

test('a local edit written with applyLocalGraph is read back as the same objects', () => {
  const doc = new Y.Doc(), reader = new CloudGraphReader(doc), origin = {};
  doc.transact(() => { node(doc, 'a', { type: 'text', x: 0, y: 0 }, { text: 'one' }); node(doc, 'b', { type: 'text', x: 400, y: 0 }, { text: 'two' }); });
  const base = reader.read({ nodes: [], edges: [], groups: [] });
  const edited = { ...base, nodes: base.nodes.map(item => item.id === 'a' ? { ...item, position: { x: 20, y: 30 }, data: { ...item.data, text: 'changed' } } : item) };
  applyLocalGraph(doc, edited, base, origin, reader.stampIds());
  const after = reader.read(edited);
  assert.equal(after.nodes, edited.nodes);
  assert.deepEqual(readCloudGraph(doc).nodes.find(item => item.id === 'a'), { id: 'a', type: 'text', position: { x: 20, y: 30 }, data: { text: 'changed' } });
  reader.destroy();
});
