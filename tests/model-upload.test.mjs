import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { cubeGlb } from './fixtures/cube-glb.mjs';
import { maxModelBytes } from '../src/model-assets.mjs';
import { modelFile, checkModelFile, modelPoster } from '../src/model-upload.mjs';

test('browser checks only the GLB header and reports unsupported formats and size errors', async () => {
  const file = new File([cubeGlb()], 'Cube.GLB', { type: 'application/octet-stream' });
  assert.equal(modelFile(file), true); assert.equal(modelFile({ type: 'model/gltf-binary' }), true);
  assert.equal(modelFile({ name: 'image.png', type: 'image/png' }), false);
  file.arrayBuffer = () => { throw new Error('Whole-file buffering is forbidden'); };
  await checkModelFile(file);
  for (const name of ['thing.gltf', 'thing.obj', 'thing.FBX']) {
    assert.equal(modelFile({ name }), true);
    await assert.rejects(checkModelFile(new File(['bad'], name)), /Only GLB files/);
  }
  await assert.rejects(checkModelFile(new File(['bad'], 'bad.glb')), /magic/);
  await assert.rejects(checkModelFile(new File([cubeGlb().subarray(0, 12)], 'short.glb')), /length/);
  await assert.rejects(checkModelFile({ size: maxModelBytes + 1 }), /80 MB/);
});

test('hidden poster capture cleans up URLs/elements on success, WebGL error, timeout and capture failure', async t => {
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === '@google/model-viewer' ? { url: 'data:text/javascript,export {};', shortCircuit: true } : next(specifier, context);
  } });
  t.after(() => hooks.deregister());
  const oldDocument = globalThis.document, oldFrame = globalThis.requestAnimationFrame;
  t.after(() => { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; if (oldFrame === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = oldFrame; });
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
  let mode, viewer, removed = 0, revoked = 0;
  t.mock.method(URL, 'createObjectURL', () => 'blob:test');
  t.mock.method(URL, 'revokeObjectURL', url => { assert.equal(url, 'blob:test'); revoked++; });
  const png = new Blob(['preview'], { type: 'image/png' });
  globalThis.document = {
    createElement(name) {
      assert.equal(name, 'model-viewer'); viewer = new EventTarget();
      Object.assign(viewer, { style: {}, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, remove() { removed++; }, async toBlob(options) { assert.deepEqual(options, { mimeType: 'image/png' }); if (mode === 'capture') throw new Error('capture failed'); return png; } });
      return viewer;
    },
    body: { appendChild(element) { if (mode !== 'timeout') queueMicrotask(() => element.dispatchEvent(new Event(mode === 'error' ? 'error' : 'load'))); } }
  };
  mode = 'success'; assert.equal(await modelPoster(new Blob(['glb'])), png);
  assert.match(viewer.style.cssText, /768px/); assert.equal(viewer.attributes.loading, 'eager'); assert.equal(viewer.attributes['aria-hidden'], 'true');
  mode = 'error'; await assert.rejects(modelPoster(new Blob(['glb'])), /render/);
  mode = 'capture'; await assert.rejects(modelPoster(new Blob(['glb'])), /capture/);
  mode = 'timeout'; await assert.rejects(modelPoster(new Blob(['glb']), { timeout: 15 }), /timed out/);
  assert.equal(removed, 4); assert.equal(revoked, 4);
});

test('picker/drop/paste share uploads, with cloud-only entry, edit guards and preview fallback', async () => {
  const source = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
  assert.match(source, /cloud && <input ref=\{modelInput\}[^>]*accept="\.glb,model\/gltf-binary" multiple/);
  assert.match(source, /const files = \[\.\.\.event.clipboardData.files\]/);
  assert.match(source, /else addFiles\(\[\.\.\.event.dataTransfer.files\], position\)/);
  assert.match(source, /if \(readOnlyRef.current \|\| mcpLocked.current \|\| switchingRef.current\) return/);
  assert.match(source, /catch \{ \/\* A missing preview must never discard an uploaded model/);
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(server, /model\/gltf-binary'\) return json\(response, \{ error: '3D model uploads are available on cloud boards only\.'/);
});
