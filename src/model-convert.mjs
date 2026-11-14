import { Group, LoadingManager, Mesh, MeshStandardMaterial } from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { maxModelBytes } from './model-assets.mjs';
import { checkModelBatch, checkModelFile, maxModelInputBytes, modelExtension, resourceName, supportedModelFormats } from './model-upload.mjs';

const inputError = '3D upload batches can be at most 300 MB, including unpacked files.';
const outputError = 'Converted GLB exceeds 80 MB. Use smaller textures or a simpler model.';
const invalidGltf = 'Invalid glTF buffers or images.';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tga: 'image/tga', ktx2: 'image/ktx2', avif: 'image/avif' };
const mimeType = name => mimeTypes[modelExtension({ name })];
const aligned = length => Math.ceil(length / 4) * 4;

// Inspect sizes before fflate allocates decompressed buffers, including container formats.
// https://github.com/mrdoob/three.js/blob/r183/examples/jsm/libs/fflate.module.js (read 2026-11-14).
function unpack(bytes, budget, extract = true) {
  return unzipSync(bytes, { filter(entry) {
    budget.bytes += entry.originalSize;
    if (!Number.isSafeInteger(budget.bytes) || budget.bytes > maxModelInputBytes || ++budget.entries > 10000) throw new Error(inputError);
    return extract && !entry.name.endsWith('/');
  } });
}
export async function expandModelFiles(files) {
  checkModelBatch(files);
  const result = [], budget = { bytes: files.reduce((sum, file) => sum + file.size, 0), entries: 0 };
  for (const file of files) {
    if (modelExtension(file) !== 'zip') { result.push(file); continue; }
    for (const [name, bytes] of Object.entries(unpack(new Uint8Array(await file.arrayBuffer()), budget))) {
      if (name.startsWith('__MACOSX/') || name.split('/').some(part => part.startsWith('.'))) continue;
      const base = name.replace(/\\/g, '/').split('/').pop();
      result.push(new File([bytes], base, { type: mimeType(base) || 'application/octet-stream' }));
    }
  }
  checkModelBatch(result);
  return result;
}

function dataUri(uri) {
  const match = /^data:([^,]*?),(.*)$/s.exec(uri);
  if (!match) throw new Error(invalidGltf);
  const binary = /;base64/i.test(match[1]) ? atob(match[2]) : match[2].replace(/%([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return { bytes: Uint8Array.from(binary, char => char.charCodeAt(0)), type: match[1].split(';')[0] };
}

// Copy bytes, not scene objects: Draco/KTX2, animations and unknown scene extensions survive.
// https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout (read 2026-11-14).
export async function repackGltf(file, resources, { used = new Set(), missing = new Set() } = {}) {
  const json = JSON.parse(await file.text());
  if (json.asset?.version !== '2.0') throw new Error('Only glTF version 2.0 is supported.');
  const parts = [], offsets = [], buffers = json.buffers || [], views = json.bufferViews || [];
  let length = 0;
  const append = bytes => {
    const offset = aligned(length);
    if (offset + bytes.byteLength > maxModelBytes) throw new Error(outputError);
    parts.push({ offset, bytes }); length = offset + bytes.byteLength;
    return offset;
  };
  const read = async uri => {
    if (typeof uri !== 'string') throw new Error(invalidGltf);
    if (uri.startsWith('data:')) return dataUri(uri);
    const resource = resources.get(resourceName(uri));
    if (!resource) { missing.add(resourceName(uri)); return null; }
    used.add(resource);
    return { bytes: new Uint8Array(await resource.arrayBuffer()), type: resource.type || mimeType(uri) };
  };
  let missingBuffer = false;
  for (const buffer of buffers) {
    const data = await read(buffer.uri);
    if (!data) { missingBuffer = true; offsets.push(0); continue; }
    if (!Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0 || data.bytes.byteLength < buffer.byteLength) throw new Error(invalidGltf);
    offsets.push(append(data.bytes.subarray(0, buffer.byteLength)));
  }
  if (missingBuffer) throw new Error('A required glTF buffer is missing. Pick its .bin file together with the model, or use a ZIP.');
  const remap = view => {
    const buffer = buffers[view.buffer], offset = view.byteOffset || 0;
    if (!buffer || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength < 0 || offset + view.byteLength > buffer.byteLength) throw new Error(invalidGltf);
    view.byteOffset = offsets[view.buffer] + offset; view.buffer = 0;
  };
  for (const view of views) {
    remap(view);
    if (view.extensions?.EXT_meshopt_compression) remap(view.extensions.EXT_meshopt_compression);
  }
  for (const [index, image] of (json.images || []).entries()) {
    if (image.uri === undefined) continue;
    let data = await read(image.uri);
    const absent = !data;
    if (absent) {
      data = dataUri(png);
      for (const texture of json.textures || []) for (const key of ['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif']) {
        if (texture.extensions?.[key]?.source === index) { texture.source = index; delete texture.extensions[key]; }
      }
    }
    const type = absent ? 'image/png' : mimeType(image.uri) || image.mimeType || data.type;
    if (!type?.startsWith('image/')) throw new Error(invalidGltf);
    image.bufferView = views.length; image.mimeType = type; delete image.uri;
    views.push({ buffer: 0, byteOffset: append(data.bytes), byteLength: data.bytes.byteLength });
  }
  if (views.length) json.bufferViews = views;
  if (length) json.buffers = [{ byteLength: length }]; else delete json.buffers;
  const encoded = new TextEncoder().encode(JSON.stringify(json)), jsonLength = aligned(encoded.byteLength), binLength = aligned(length);
  const total = 20 + jsonLength + (length ? 8 + binLength : 0);
  if (total > maxModelBytes) throw new Error(outputError);
  const bytes = new Uint8Array(total), header = new DataView(bytes.buffer);
  header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, total, true);
  header.setUint32(12, jsonLength, true); header.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + jsonLength); bytes.set(encoded, 20);
  if (length) {
    header.setUint32(20 + jsonLength, binLength, true); header.setUint32(24 + jsonLength, 0x004e4942, true);
    for (const part of parts) bytes.set(part.bytes, 28 + jsonLength + part.offset);
  }
  return new File([bytes], file.name.replace(/\.gltf$/i, '.glb'), { type: 'model/gltf-binary' });
}

function sceneTextures(scene) {
  const textures = new Set();
  scene?.traverse(object => {
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material || {})) if (value?.isTexture) textures.add(value);
    }
  });
  return [...textures];
}

// USDComposer r183 uses Image directly; it does not report embedded texture loads to LoadingManager.
// https://github.com/mrdoob/three.js/blob/r183/examples/jsm/loaders/usd/USDComposer.js (read 2026-11-14).
async function waitUSDTextures(scene) {
  const textures = sceneTextures(scene), deadline = Date.now() + 15000;
  while (textures.some(texture => !texture.image) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
}

export async function convertModel(file, resources, { used = new Set(), missing = new Set() } = {}) {
  checkModelBatch([file, ...resources.values()]);
  if (modelExtension(file) === 'gltf') {
    const converted = await repackGltf(file, resources, { used, missing });
    await checkModelFile(converted); return converted;
  }
  const manager = new LoadingManager(), urls = new Map(), blobs = new Map();
  let scene;
  const done = new Promise(resolve => { manager.onLoad = resolve; });
  manager.onError = url => { missing.add(urls.get(url)?.name || resourceName(url)); };
  manager.setURLModifier(url => {
    if (/^(data:|blob:)/i.test(url)) return url;
    const resource = resources.get(resourceName(url));
    if (!resource) {
      missing.add(resourceName(url));
      // A valid 1px TGA keeps TGALoader's parser on its normal path.
      return /\.tga$/i.test(url) ? 'data:application/octet-stream;base64,AAACAAAAAAAAAAAAAQABACAo/////w==' : png;
    }
    used.add(resource);
    for (const [created, value] of urls) if (value === resource) return created;
    const created = URL.createObjectURL(resource); urls.set(created, resource); blobs.set(created, resource); return created;
  });
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  manager.itemStart('conversion');
  try {
    const ext = modelExtension(file), bytes = await file.arrayBuffer();
    if (ext === 'obj') {
      const text = new TextDecoder().decode(bytes), loader = new OBJLoader(manager), materials = {};
      const libraries = [...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].flatMap(match => {
        const whole = match[1].trim();
        return resources.has(resourceName(whole)) ? [whole] : whole.split(/\s+/);
      });
      for (const name of libraries) {
        const materialFile = resources.get(resourceName(name));
        if (!materialFile) { missing.add(resourceName(name)); continue; }
        used.add(materialFile);
        const creator = new MTLLoader(manager).parse(await materialFile.text(), '');
        Object.assign(materials, creator.materialsInfo);
      }
      if (Object.keys(materials).length) {
        const creator = new MTLLoader(manager).parse('', ''); creator.setMaterials(materials);
        loader.setMaterials(creator);
      }
      scene = loader.parse(text);
    } else {
      if (ext === '3mf' || ext === 'usdz') unpack(new Uint8Array(bytes), { bytes: file.size, entries: 0 }, false);
      // Capture only synchronous loader-created URLs; restore the API before any await.
      const create = URL.createObjectURL;
      URL.createObjectURL = blob => { const url = create.call(URL, blob); blobs.set(url, blob); return url; };
      try {
        if (ext === 'fbx') scene = new FBXLoader(manager).parse(bytes, '');
        else if (ext === '3mf') scene = new ThreeMFLoader(manager).parse(bytes);
        else if (ext === 'usdz') scene = new USDLoader(manager).parse(bytes);
        else if (ext === 'stl' || ext === 'ply') {
          const geometry = ext === 'stl' ? new STLLoader(manager).parse(bytes) : new PLYLoader(manager).parse(bytes);
          // STL normals are per facet, so no corners would weld (a 500k-triangle STL: 42 MB). A glTF mesh without normals
          // renders flat by spec, the same facets. https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#meshes-overview
          // (read 2026-11-14); three's GLTFLoader sets flatShading for it (r183 GLTFLoader.js, useFlatShading).
          if (ext === 'stl') geometry.deleteAttribute('normal');
          else if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
          scene = new Mesh(geometry, new MeshStandardMaterial({ vertexColors: geometry.hasAttribute('color'), ...(geometry.alpha !== undefined ? { opacity: geometry.alpha, transparent: geometry.alpha < 1 } : {}) }));
        } else throw new Error(supportedModelFormats);
      } finally { URL.createObjectURL = create; }
      // 3MF is Z-up by spec, and STL/PLY from printing, scanning and Blender's defaults are too; glTF is Y-up. Without this
      // the model lies on its back under the card's turntable orbit.
      // https://github.com/mrdoob/three.js/blob/r183/examples/jsm/loaders/3MFLoader.js ("z-up conversion"), read 2026-11-14.
      if (/^(stl|ply|3mf)$/.test(ext)) { const upright = new Group(); upright.rotation.x = -Math.PI / 2; upright.add(scene); scene = upright; }
    }
    manager.itemEnd('conversion'); await done;
    if (ext === 'usdz') await waitUSDTextures(scene);
    let vertices = 0;
    scene.traverse(object => { vertices += object.geometry?.attributes?.position?.count || 0; });
    if (!vertices) throw new Error('The 3D model is empty.');
    for (const texture of sceneTextures(scene)) {
      const src = texture.image?.src || '', blob = blobs.get(src);
      const head = blob && new Uint8Array(await blob.slice(0, 3).arrayBuffer());
      if (/^data:image\/jpeg[;,]|\.jpe?g(?:[?#]|$)/i.test(src) || blob?.type === 'image/jpeg' || (head?.[0] === 255 && head[1] === 216 && head[2] === 255)) texture.userData.mimeType = 'image/jpeg';
    }
    const welded = new Map();
    scene.traverse(object => {
      // OBJ/STL/FBX loaders emit one vertex per triangle corner; welding equal corners keeps the GLB near the source size
      // (a 500k-triangle OBJ: 49 MB unwelded). https://threejs.org/docs/pages/BufferGeometryUtils.html (read 2026-11-14).
      if (object.isMesh && object.geometry && !object.geometry.index) {
        if (!welded.has(object.geometry)) welded.set(object.geometry, mergeVertices(object.geometry));
        object.geometry = welded.get(object.geometry);
      }
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const [key, value] of Object.entries(material || {})) {
          if (value?.isTexture && !(value.image?.width > 0)) { material[key] = null; missing.add(value.name || 'Unknown texture'); }
        }
        // GLTFExporter writes emissive at full strength unless the material is MeshStandardMaterial, so bake dimming in:
        // Blender's FBX has EmissiveColor 1,1,1 with EmissiveFactor 0, which otherwise exports as a white glow.
        if (material?.emissive && material.emissiveIntensity >= 0 && material.emissiveIntensity < 1) { material.emissive.multiplyScalar(material.emissiveIntensity); material.emissiveIntensity = 1; }
        // In FBX a texture connected to DiffuseColor replaces the colour value; FBXLoader multiplies them, darkening the map.
        if (ext === 'fbx' && material?.map && material.color) material.color.setRGB(1, 1, 1);
      }
    });
    for (const [geometry] of welded) geometry.dispose();
    // https://threejs.org/docs/pages/GLTFExporter.html (read 2026-11-14).
    const output = await new GLTFExporter().parseAsync(scene, { binary: true, animations: scene.animations || [], maxTextureSize: 4096 });
    if (output.byteLength > maxModelBytes) throw new Error(outputError);
    const converted = new File([output], file.name.replace(/\.[^.]+$/, '.glb'), { type: 'model/gltf-binary' });
    await checkModelFile(converted); return converted;
  } finally {
    for (const url of new Set([...urls.keys(), ...blobs.keys()])) URL.revokeObjectURL(url);
    const textures = sceneTextures(scene), geometries = new Set(), materials = new Set();
    scene?.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) if (material) materials.add(material);
    });
    for (const item of [...textures, ...geometries, ...materials]) item.dispose();
  }
}
