import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { convertModel, expandModelFiles, repackGltf } from '../src/model-convert.mjs';
import { checkModelBatch, checkModelFile, groupModelFiles, maxModelInputBytes, modelFile, resourceName } from '../src/model-upload.mjs';
import { glbLength, maxModelBytes } from '../src/model-assets.mjs';

const file = (name, data = '', type = '') => new File([data], name, { type });
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));
function chunks(bytes) {
  assert.equal(glbLength(bytes), bytes.byteLength);
  const view = new DataView(bytes.buffer), jsonLength = view.getUint32(12, true), binStart = 20 + jsonLength;
  assert.equal(view.getUint32(16, true), 0x4e4f534a); assert.equal(jsonLength % 4, 0);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, binStart)));
  if (binStart === bytes.byteLength) return { json, bin: new Uint8Array() };
  assert.equal(view.getUint32(binStart + 4, true), 0x004e4942); assert.equal(view.getUint32(binStart, true) % 4, 0);
  assert.equal(binStart + 8 + view.getUint32(binStart, true), bytes.byteLength);
  return { json, bin: bytes.subarray(binStart + 8) };
}

test('pure grouping shares companions, matches path/case/URI escapes, keeps only board-supported images', () => {
  const models = ['robot.OBJ', 'robot.fbx', 'part.STL', 'part.ply', 'part.3mf', 'part.usdz', 'part.gltf', 'part.glb'].map(name => file(name));
  const texture = file('Color Map.JPG'), other = file('unused.webp'), tga = file('bump.TGA'), mtl = file('robot.mtl'), bin = file('mesh.bin');
  const list = [...models, texture, other, tga, mtl, bin, file('ignored.txt')], before = [...list];
  const grouped = groupModelFiles(list);
  assert.deepEqual(list, before); assert.deepEqual(grouped.models, models); assert.ok(models.every(modelFile));
  assert.deepEqual(grouped.images, [texture, other]); assert.equal(grouped.resources.get(resourceName('C:\\textures\\COLOR%20MAP.jpg?rev=2')), texture);
  assert.equal(grouped.resources.get('bump.tga'), tga); assert.equal(grouped.resources.get('mesh.bin'), bin);
  assert.equal(grouped.unsupported[0].name, 'ignored.txt');
  assert.equal(groupModelFiles([texture, file('color map.jpg')]).resources.get('color map.jpg'), texture);
  assert.deepEqual(groupModelFiles([texture, other]).images, [texture, other]);
  assert.throws(() => checkModelBatch([{ size: maxModelInputBytes }, { size: 1 }]), /300 MB/);
});

test('ZIP expands model basenames/resources without extracting metadata, checks unpacked sizes before allocation', async () => {
  const zip = zipSync({ 'project/model.obj': new TextEncoder().encode('v 0 0 0'), 'textures/Color.PNG': png, '__MACOSX/._model.obj': png });
  const loose = file('other.glb'), expanded = await expandModelFiles([file('models.zip', zip), loose]);
  assert.deepEqual(expanded.map(item => item.name), ['model.obj', 'Color.PNG', 'other.glb']);
  assert.equal(expanded[1].type, 'image/png'); assert.equal(expanded[2], loose);
  assert.deepEqual(new Uint8Array(await expanded[1].arrayBuffer()), png);
  const oversized = zip.slice(), view = new DataView(oversized.buffer);
  let directory = 0; while (view.getUint32(directory, true) !== 0x02014b50) directory++;
  view.setUint32(directory + 24, maxModelInputBytes + 1, true);
  await assert.rejects(expandModelFiles([file('bomb.zip', oversized)]), /300 MB/);
  await assert.rejects(expandModelFiles([file('bad.zip', 'invalid')]), /invalid zip/i);
});

test('a tiny valid glTF with external geometry and PNG repacks into a loadable GLB', async () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const doc = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ uri: 'triangle.bin', byteLength: positions.byteLength }], bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], images: [{ uri: 'color.png' }] };
  const resources = groupModelFiles([file('triangle.bin', positions), file('color.png', png)]).resources;
  const converted = await repackGltf(file('triangle.gltf', JSON.stringify(doc)), resources), bytes = await converted.arrayBuffer();
  const { json, bin } = chunks(new Uint8Array(bytes)), image = json.bufferViews[json.images[0].bufferView];
  assert.deepEqual(bin.subarray(image.byteOffset, image.byteOffset + image.byteLength), png);
  const loaded = await new GLTFLoader().parseAsync(bytes, '');
  assert.deepEqual(loaded.scene.children[0].geometry.attributes.position.array, positions);
});

test('glTF repack embeds external BIN and PNG, aligns chunks and preserves Draco, KTX2 and meshopt references', async () => {
  const raw = Uint8Array.of(1, 2, 3, 4, 5), extra = Uint8Array.of(9, 8, 7, 6), ktx = Uint8Array.of(171, 75, 84, 88);
  const doc = { asset: { version: '2.0' }, buffers: [{ uri: 'data/mesh.bin', byteLength: 5 }, { uri: 'extra.bin', byteLength: 4 }],
    bufferViews: [{ buffer: 0, byteOffset: 1, byteLength: 4 }, { buffer: 1, byteLength: 4, extensions: { EXT_meshopt_compression: { buffer: 1, byteOffset: 1, byteLength: 3, count: 1, byteStride: 4, mode: 'ATTRIBUTES' } } }],
    images: [{ uri: 'Textures/Color.PNG' }, { uri: 'compressed.ktx2' }], textures: [{ extensions: { KHR_texture_basisu: { source: 1 } } }],
    meshes: [{ primitives: [{ extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } } }] }],
    animations: [{ name: 'untouched' }], extensionsUsed: ['KHR_draco_mesh_compression', 'KHR_texture_basisu', 'EXT_meshopt_compression'] };
  const resources = groupModelFiles([file('MESH.BIN', raw), file('EXTRA.BIN', extra), file('color.png', png), file('compressed.ktx2', ktx)]).resources;
  const used = new Set(), missing = new Set(), converted = await repackGltf(file('robot.gltf', JSON.stringify(doc)), resources, { used, missing });
  await checkModelFile(converted); assert.equal(converted.name, 'robot.glb'); assert.equal(used.size, 4); assert.equal(missing.size, 0);
  const { json, bin } = chunks(new Uint8Array(await converted.arrayBuffer()));
  assert.deepEqual(json.buffers, [{ byteLength: 12 + png.length + (4 - png.length % 4) % 4 + ktx.length }]);
  assert.deepEqual(bin.subarray(0, 5), raw); assert.deepEqual(bin.subarray(8, 12), extra);
  assert.equal(json.bufferViews[1].byteOffset, 8); assert.equal(json.bufferViews[1].extensions.EXT_meshopt_compression.byteOffset, 9);
  assert.equal(json.bufferViews[1].extensions.EXT_meshopt_compression.buffer, 0);
  assert.equal(json.images[0].mimeType, 'image/png'); assert.equal(json.images[0].uri, undefined);
  const imageView = json.bufferViews[json.images[0].bufferView]; assert.equal(imageView.byteOffset % 4, 0);
  assert.deepEqual(bin.subarray(imageView.byteOffset, imageView.byteOffset + imageView.byteLength), png);
  assert.deepEqual(json.meshes, doc.meshes); assert.deepEqual(json.animations, doc.animations); assert.deepEqual(json.textures, doc.textures);
});

test('embedded glTF repacks without fetching; missing textures get PNG placeholders, missing BIN fails clearly', async () => {
  const doc = { asset: { version: '2.0' }, buffers: [{ uri: 'data:application/octet-stream;base64,AQID', byteLength: 3 }], bufferViews: [{ buffer: 0, byteLength: 3 }], images: [{ uri: 'missing.jpg' }, { uri: 'data:image/png;base64,' + Buffer.from(png).toString('base64') }] };
  const missing = new Set(), converted = await repackGltf(file('embedded.gltf', JSON.stringify(doc)), new Map(), { missing });
  const { json, bin } = chunks(new Uint8Array(await converted.arrayBuffer()));
  assert.deepEqual([...missing], ['missing.jpg']); assert.equal(json.images[0].mimeType, 'image/png'); assert.equal(json.images[1].mimeType, 'image/png');
  assert.deepEqual(bin.subarray(0, 3), Uint8Array.of(1, 2, 3));
  doc.buffers[0].uri = 'missing.bin';
  await assert.rejects(repackGltf(file('missing.gltf', JSON.stringify(doc)), new Map(), { missing }), /required glTF buffer is missing/);
  assert.ok(missing.has('missing.bin'));
  doc.buffers[0].uri = 'data:application/octet-stream;base64,AQID'; doc.bufferViews[0].byteLength = 4;
  await assert.rejects(repackGltf(file('invalid.gltf', JSON.stringify(doc)), new Map()), /Invalid glTF/);
  await assert.rejects(repackGltf(file('big.gltf', JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'big.bin', byteLength: maxModelBytes + 1 }] })), new Map([['big.bin', { arrayBuffer: async () => new ArrayBuffer(maxModelBytes + 1) }]])), /80 MB/);
});

// GLTFExporter uses browser FileReader even for textureless meshes; only that API is shimmed.
class FileReader {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }); }
}
test('STL, PLY and OBJ convert through the real exporter and load back with geometry/materials', async t => {
  const previous = globalThis.FileReader; globalThis.FileReader = FileReader;
  t.after(() => { if (previous === undefined) delete globalThis.FileReader; else globalThis.FileReader = previous; });
  const inputs = [
    file('triangle.stl', 'solid test\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid test'),
    file('triangle.obj', 'mtllib missing.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'),
    file('triangle.ply', 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0 255 0 0\n1 0 0 0 255 0\n0 1 0 0 0 255\n3 0 1 2\n')
  ];
  for (const input of inputs) {
    const missing = new Set(), converted = await convertModel(input, new Map(), { missing });
    await checkModelFile(converted);
    const buffer = await converted.arrayBuffer(), { json } = chunks(new Uint8Array(buffer));
    assert.equal(json.meshes.length, 1); assert.ok(json.accessors.some(accessor => accessor.count === 3));
    const loaded = await new GLTFLoader().parseAsync(buffer, '');
    let mesh; loaded.scene.traverse(object => { if (object.isMesh) mesh = object; }); assert.equal(mesh.geometry.attributes.position.count, 3);
    // STL facet normals are dropped so corners weld; the viewer shades such a mesh flat, as the STL was.
    if (input.name.endsWith('.stl')) { assert.equal(mesh.geometry.attributes.normal, undefined); assert.equal(mesh.material.flatShading, true); }
    else assert.ok(mesh.geometry.attributes.normal);
    // STL, PLY and 3MF are Z-up; the converted GLB stands them upright (Y-up) under a -90° X turn.
    // GLTFExporter writes node matrices (trs: false); column-major Rx(-90°) puts -1 at [6] and 1 at [9].
    if (!input.name.endsWith('.obj')) assert.ok(json.nodes.some(node => node.matrix && Math.abs(node.matrix[6] + 1) < 1e-6 && Math.abs(node.matrix[9] - 1) < 1e-6));
    if (input.name.endsWith('.ply')) { assert.ok(mesh.geometry.attributes.color); assert.equal(mesh.material.vertexColors, true); }
    if (input.name.endsWith('.obj')) assert.deepEqual([...missing], ['missing.mtl']);
  }
});

test('OBJ reads only referenced MTLs, tolerates missing materials, and restores URL API on parse failure', async t => {
  const previous = globalThis.FileReader; globalThis.FileReader = FileReader;
  t.after(() => { if (previous === undefined) delete globalThis.FileReader; else globalThis.FileReader = previous; });
  const mtl = file('paint.mtl', 'newmtl red\nKd 1 0 0\n'), unused = file('unused.mtl', 'newmtl unused\nmap_Kd missing.jpg\n');
  const used = new Set(), missing = new Set(), input = file('paint.obj', 'mtllib path/PAINT.MTL\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl red\nf 1 2 3\n');
  const output = await convertModel(input, groupModelFiles([mtl, unused]).resources, { used, missing });
  const { json } = chunks(new Uint8Array(await output.arrayBuffer()));
  assert.deepEqual(json.materials[0].pbrMetallicRoughness.baseColorFactor, [1, 0, 0, 1]); assert.deepEqual([...used], [mtl]); assert.equal(missing.size, 0);
  const create = URL.createObjectURL;
  await assert.rejects(convertModel(file('bad.stl', 'bad'), new Map())); assert.equal(URL.createObjectURL, create);
});

test('asynchronous OBJ textures settle before export, JPEG stays JPEG, TGA uses its loader, unused images stay free', async t => {
  const saved = Object.fromEntries(['FileReader', 'document', 'HTMLImageElement', 'ImageData', 'ProgressEvent'].map(key => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; });
  let loaded = 0, drawn = 0;
  class Image extends EventTarget {
    constructor() { super(); this.width = 0; this.height = 0; }
    set src(value) { this.url = value; setTimeout(() => { this.width = 1; this.height = 1; loaded++; this.dispatchEvent(new Event('load')); }, 10); }
    get src() { return this.url; }
  }
  globalThis.FileReader = FileReader; globalThis.HTMLImageElement = Image;
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  globalThis.ProgressEvent = class extends Event { constructor(type, values) { super(type); Object.assign(this, values); } };
  globalThis.document = {
    createElementNS(namespace, name) { assert.equal(name, 'img'); return new Image(); },
    createElement(name) {
      assert.equal(name, 'canvas');
      return { getContext() { return { translate() {}, scale() {}, drawImage(image) { assert.ok(loaded > 0); assert.equal(image.width, 1); drawn++; }, putImageData(image) { assert.equal(image.width, 1); drawn++; } }; }, toBlob(callback, type) { callback(new Blob([type === 'image/jpeg' ? Uint8Array.of(255, 216, 255, 217) : png], { type })); } };
    }
  };
  const tga = Uint8Array.of(0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 32, 40, 255, 255, 255, 255);
  const texture = file('Color.JPG', Uint8Array.of(255, 216, 255, 217)), bump = file('bump.tga', tga), unused = file('unused.png', png);
  const mtl = file('paint.mtl', 'newmtl paint\nmap_Kd textures/COLOR.jpg\nnorm images/BUMP.TGA\n');
  const input = file('paint.obj', 'mtllib PAINT.MTL\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl paint\nf 1/1 2/2 3/3\n');
  const batch = groupModelFiles([input, mtl, texture, bump, unused]), used = new Set(), missing = new Set(), revoked = [];
  const revoke = URL.revokeObjectURL;
  t.mock.method(URL, 'revokeObjectURL', url => { revoked.push(url); revoke.call(URL, url); });
  const converted = await convertModel(input, batch.resources, { used, missing });
  const { json } = chunks(new Uint8Array(await converted.arrayBuffer()));
  assert.deepEqual(json.images.map(image => image.mimeType).sort(), ['image/jpeg', 'image/png']); assert.equal(drawn, 2);
  assert.deepEqual(new Set(used), new Set([mtl, texture, bump])); assert.deepEqual(batch.images.filter(image => !used.has(image)), [unused]);
  assert.equal(missing.size, 0); assert.equal(new Set(revoked).size, 2);
});
