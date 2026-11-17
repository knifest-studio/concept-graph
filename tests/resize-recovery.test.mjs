import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { overLimitReferences, resizeRecovery, tooLargeToReduce, transformInputBytes } from '../cloud/reference-prep.mjs';
import { defaultResizeSide, resizeAllTargets, resizeTarget } from '../src/image-resize.mjs';
import { resizedImageData } from '../src/image-edits.mjs';
import { generationIntent, intentUnchanged } from '../src/onboarding.mjs';

const asset = i => `${String(i).repeat(8)}-${String(i).repeat(4)}-${String(i).repeat(4)}-${String(i).repeat(4)}-${String(i).repeat(12)}.png`;
const image = (id, file, mask) => ({ id, type: 'image', position: { x: 0, y: 0 }, data: { asset: file, ...(mask ? { mask } : {}) } });
const prompt = (id, text = 'A robot') => ({ id, type: 'text', position: { x: 400, y: 0 }, data: { text } });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target });

test('recovery picks every over-limit original, deduplicates assets and preserves masked failures', () => {
  const images = [{ asset: asset(1), label: 'A' }, { asset: asset(2) }, { asset: asset(3), maskOf: 'Masked' }, { asset: asset(1) }, { asset: asset(4), mask: true }];
  const infos = [21, 20, 24, 21, 25].map(mb => ({ bytes: mb * 1024 * 1024 }));
  assert.deepEqual(overLimitReferences(images, infos), [asset(1)]);
  assert.deepEqual(resizeRecovery(images, infos, tooLargeToReduce(images[0], infos[0].bytes)), [asset(1)]);
  assert.deepEqual(resizeRecovery(images, infos, tooLargeToReduce(images[2], infos[2].bytes)), []);
  assert.deepEqual(resizeRecovery(images, infos, 'Reference images are still too large.'), []);
  assert.deepEqual(overLimitReferences(images, [{ bytes: transformInputBytes }]), []);
});

test('only this prompt’s connected unmasked images and custom-node references are resized', () => {
  const masked = { source: asset(3), asset: asset(4), marked: asset(5), base: asset(3) };
  const graph = { nodes: [prompt('p'), image('large', asset(1)), image('small', asset(2)), image('masked', asset(3), masked), image('unrelated', asset(1)), prompt('custom', 'Context')], edges: [edge('large', 'p'), edge('small', 'p'), edge('masked', 'p'), edge('custom', 'p')] };
  graph.nodes[5].data.template = { name: 'Views', instructions: 'Side view', assets: [asset(6)] };
  assert.deepEqual(resizeAllTargets(graph, 'p', [asset(1), asset(3), asset(6)]).map(node => node.id), ['large', 'custom']);
  for (const [pixels, side] of [[{ width: 7680, height: 4320 }, 4096], [{ width: 4096, height: 2048 }, 3072], [{ width: 800, height: 600 }, 400]]) {
    assert.equal(defaultResizeSide(pixels), side); assert.ok(resizeTarget(pixels, side));
  }
});

// Exercise the actual editor action with I/O replaced, without mounting React or starting a server.
const main = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
const action = main.slice(main.indexOf('  const resizeAllAndGenerate ='), main.indexOf('  runAction.current = run;'));
function editor({ changed = false, fail = false } = {}) {
  let graph = { nodes: [prompt('p'), image('a', asset(1)), image('b', asset(2))], edges: [edge('a', 'p'), edge('b', 'p')] };
  const recovery = { nodeId: 'p', intent: generationIntent(graph, 'board', 'p'), assets: [asset(1), asset(2)] }, calls = [], errors = [], uploads = { current: 0 };
  let checks = 0, undo;
  const env = { resizingReferences: { current: false }, resizeRecovery: recovery, generationStarting: { current: false }, readOnlyRef: { current: false }, mcpLocked: { current: false }, switchingRef: { current: false }, alive: { current: true }, boardId: 'board', uploads,
    syncCloud() { if (changed && ++checks === 2) graph.nodes[1].data.asset = asset(6); }, currentGraph: () => graph, intentUnchanged, resizeAllTargets, defaultResizeSide, resizeTarget, resizedImageData,
    loadResizeImage: async file => { calls.push(['load', file]); return { image: { naturalWidth: 7680, naturalHeight: 4320 } }; }, assetUrl: file => file,
    saveResizedImage: async (data, image, target) => { if (fail && data.asset === asset(2)) throw new Error('Upload failed'); return resizedImageData(data, data.asset === asset(1) ? asset(4) : asset(5), target, { width: 7680, height: 4320 }); }, uploadEdit() {},
    checkpoint() { undo = structuredClone(graph); calls.push(['checkpoint']); }, putNodes(update) { graph = { ...graph, nodes: update(graph.nodes) }; }, markDirty() { calls.push(['dirty']); }, track() {}, setResizeRecovery() {}, setUploading() {},
    runAction: { current: async id => calls.push(['generate', id]) }, notify: message => errors.push(message), t: value => value };
  return { run: new Function(...Object.keys(env), `${action}; return resizeAllAndGenerate;`)(...Object.values(env)), calls, errors, uploads, graph: () => graph, undo: () => undo };
}
test('bulk recovery applies one undo step after all copies and reruns the same prompt', async () => {
  const env = editor(); await env.run();
  assert.equal(env.calls.filter(([name]) => name === 'checkpoint').length, 1);
  assert.deepEqual(env.calls.at(-1), ['generate', 'p']); assert.deepEqual(env.errors, []); assert.equal(env.uploads.current, 0);
  assert.deepEqual(env.graph().nodes.slice(1).map(node => node.data.asset), [asset(4), asset(5)]);
  assert.deepEqual(env.undo().nodes.slice(1).map(node => node.data.asset), [asset(1), asset(2)]);
});
test('an upload failure or remote reference edit makes no board edit and never generates', async () => {
  for (const options of [{ changed: true }, { fail: true }]) {
    const env = editor(options); await env.run();
    assert.equal(env.undo(), undefined); assert.equal(env.errors.length, 1); assert.equal(env.uploads.current, 0);
    assert.ok(!env.calls.some(([name]) => name === 'generate'));
  }
});
