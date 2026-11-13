import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';
import { cropRect, croppedImageData, dragCrop, fullRect, generationReferences, hasGenerationPrompt, hasSelection, imageAssets, maskFromSelection, maskPlacement, resetImageData, selectionFromMask, validCropRect } from '../src/image-edits.mjs';

const asset = '11111111-1111-1111-1111-111111111111.png', cropped = '22222222-2222-2222-2222-222222222222.jpg';
const pixels = { width: 1200, height: 800 }, rect = { x: 200, y: 100, width: 600, height: 400 };
test('crop rectangles stay integral and bounded, with every handle anchored to its opposite side', () => {
  assert.deepEqual(cropRect({ x: -10, y: 799.8, width: 1300, height: -10 }, pixels), { x: 0, y: 799, width: 1200, height: 1 });
  assert.deepEqual(dragCrop(rect, 'move', 900, -200, pixels), { ...rect, x: 600, y: 0 });
  const expected = { nw: [250, 150, 550, 350], n: [200, 150, 600, 350], ne: [200, 150, 650, 350], e: [200, 100, 650, 400], se: [200, 100, 650, 450], s: [200, 100, 600, 450], sw: [250, 100, 550, 450], w: [250, 100, 550, 400] };
  for (const [handle, values] of Object.entries(expected)) assert.deepEqual(Object.values(dragCrop(rect, handle, 50, 50, pixels)), values, handle);
  for (const handle of [...Object.keys(expected), 'move']) for (const dx of [-2000, -5, 0, 12, 2000]) for (const dy of [-2000, 0, 2000]) {
    const result = dragCrop(rect, handle, dx, dy, pixels, true);
    assert.equal(validCropRect(result, pixels), true, `${handle}: ${JSON.stringify(result)}`);
    assert.ok(Math.abs(result.width - result.height * 1.5) <= 2, `${handle} preserves ratio to a pixel`);
  }
  assert.deepEqual(dragCrop(rect, 'se', 300, 0, pixels, true), { ...rect, width: 900, height: 600 });
});

test('repeated crops retain the first original and reset preserves node provenance and naming', () => {
  const data = { asset, label: 'source.png', caption: 'Storm', runId: 'run', author: { name: 'Artist' }, pixels, aspect: 2 / 3 };
  const first = croppedImageData(data, cropped, pixels, rect), secondRect = { x: 50, y: 40, width: 1000, height: 700 };
  const second = croppedImageData(first, asset, { width: 600, height: 400 }, secondRect);
  assert.deepEqual(second.uncropped, { asset, pixels, rect: secondRect });
  assert.deepEqual(first.pixels, { width: 600, height: 400 }); assert.equal(second.aspect, .7);
  assert.deepEqual(resetImageData(second), data); assert.equal(resetImageData(data), data);
  assert.deepEqual(maskPlacement(rect, secondRect), { x: 150, y: 60, width: 600, height: 400 });
  assert.deepEqual(maskPlacement(rect, { x: 400, y: 300, width: 200, height: 100 }), { x: -200, y: -200, width: 600, height: 400 });
  assert.deepEqual(fullRect(pixels), { x: 0, y: 0, ...pixels });
});

test('mask alpha is inverted, binary, RGBA, and preview colours match the exact editable pixels', () => {
  const selection = new Uint8ClampedArray([230, 40, 180, 255, 230, 40, 180, 127, 230, 40, 180, 128, 0, 0, 0, 0]);
  const mask = maskFromSelection(selection);
  assert.deepEqual([...mask], [255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255]);
  const restored = selectionFromMask(mask);
  assert.deepEqual([restored[3], restored[7], restored[11], restored[15]], [255, 0, 255, 0]);
  assert.equal(hasSelection(restored), true); assert.equal(hasSelection(new Uint8ClampedArray(16)), false);
  assert.deepEqual(maskFromSelection(restored), mask);
  const inPlace = selection.slice(); assert.equal(maskFromSelection(inPlace, inPlace), inPlace); assert.deepEqual(inPlace, mask);
  assert.equal(selectionFromMask(inPlace, inPlace), inPlace); assert.deepEqual(inPlace, restored);
});

test('generation references and asset inventories keep all edit assets, in provider-specific order', () => {
  const mask = { asset, marked: asset, base: asset, source: cropped }, image = { asset: cropped, label: 'Storm', mask }, other = { asset, label: 'Reference' };
  assert.deepEqual(generationReferences([other, image]).map(image => image.label), ['Reference', 'Storm', 'Storm (highlighted edit area)']);
  assert.deepEqual(generationReferences([other, image], true).map(image => image.label), ['Storm', 'Reference']);
  assert.equal(generationReferences([other, image], true)[0].asset, asset);
  assert.deepEqual(imageAssets({ type: 'image', data: { asset: cropped, mask, uncropped: { asset } } }), [cropped, asset, asset, asset, asset, cropped]);
  assert.deepEqual(imageAssets({ type: 'text', data: { template: { assets: [asset] } } }), [asset]);
});

test('only outgoing image-generation prompts suppress automatic prompt creation', () => {
  const image = { id: 'i', type: 'image', data: {} }, text = { id: 'p', type: 'text', data: { text: '' } }, edge = { source: 'i', target: 'p' };
  for (const task of ['describe', 'upscale']) assert.equal(hasGenerationPrompt({ nodes: [image, { ...text, data: { task } }], edges: [edge] }, 'i'), false);
  assert.equal(hasGenerationPrompt({ nodes: [image, text], edges: [edge] }, 'i'), true);
  assert.equal(hasGenerationPrompt({ nodes: [image, text], edges: [{ source: 'p', target: 'i' }] }, 'i'), false);
});

test('image editor, menu and integration JSX compile without running a server or browser', async () => {
  for (const name of ['ImageEditor', 'NodeContextMenu', 'main']) {
    const source = await readFile(new URL(`../src/${name}.jsx`, import.meta.url), 'utf8');
    assert.ok((await transformWithEsbuild(source, `${name}.jsx`, { loader: 'jsx' })).code.length);
  }
});

test('both desktop packages include the pure module required by their shared server and graph', async () => {
  for (const path of ['scripts/build-macos-desktop.mjs', 'desktop/windows/package.mjs']) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8'); assert.match(source, /'image-edits\.mjs'/);
  }
});
