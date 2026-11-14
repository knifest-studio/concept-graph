import test from 'node:test';
import assert from 'node:assert/strict';
import { Group, Mesh, MeshStandardMaterial, BufferGeometry, Float32BufferAttribute, Texture, InstancedMesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { cubeGlb } from './fixtures/cube-glb.mjs';
import { model3dModels } from '../graph.mjs';
import { formatDuration } from '../src/image-info.mjs';
import { formatBytes, formatCount, modelInfo, meshStats, modelScene, wireframeView } from '../src/model-info.mjs';
import { setLanguage } from '../src/i18n.mjs';

const node = { id: 'output', data: { name: 'Cube', runId: 'r' } }, rows = (data = {}, run, options) => Object.fromEntries(modelInfo({ ...node, data: { ...node.data, ...data } }, run, options).map(row => [row.key, row]));
test('model facts prefer the persistent node; legacy runs supply only known facts', () => {
  const run = { id: 'r', model: model3dModels.rodin, modeler: 'rodin', by: { name: 'Old author' }, startedAt: '2026-11-14T10:00:00Z', finishedAt: '2026-11-14T10:02:43Z', outputIds: ['output'], usd: .4 };
  const info = rows({ modeler: 'hunyuan', createdAt: '2026-11-14T10:02:40Z', author: { name: 'Lead' }, usd: .375, bytes: 12400000, source: { nodeId: 'input', name: 'Front' } }, run, { formatDate: value => value });
  assert.equal(info.model.value, 'Hunyuan 3D 3.1 Pro'); assert.equal(info.author.value, 'Lead'); assert.equal(info.duration.value, '2 min 43 s');
  assert.equal(info.created.value, '2026-11-14T10:02:40Z'); assert.equal(info.cost.value, '$0.375'); assert.equal(info.file.value, 'GLB · 12.4 MB'); assert.equal(info.source.nodeId, 'input');
  const legacy = rows({}, run); assert.equal(legacy.model.value, 'Rodin Gen-2.5'); assert.equal(legacy.author.value, 'Old author'); assert.equal(legacy.cost.value, '$0.40');
  assert.equal(rows({}, { ...run, model: undefined }).model.value, 'Rodin Gen-2.5');
  const multiple = rows({}, { ...run, outputIds: ['output', 'other'] }); assert.equal(multiple.cost.value, '—'); assert.equal(multiple.duration.note, 'Whole run');
  const old = rows({}, { ...run, snapshot: [{ id: 'i', type: 'image', data: { caption: 'Original' } }] }); assert.equal(old.source.value, 'Original'); assert.equal(old.source.nodeId, 'i');
  const missing = rows(); assert.ok(Object.values(missing).every(row => row.value === (row.key === 'file' ? 'GLB · —' : '—')));
  assert.equal(rows({ usd: 0 }).cost.value, '$0.00'); assert.equal(rows({}, { ...run, finishedAt: run.startedAt }).duration.value, 'under 1 s');
  assert.equal(rows({}, { ...run, finishedAt: 'invalid' }).duration.value, '—');
});

test('sizes, counts and durations handle unknowns, boundaries and Ukrainian', () => {
  assert.equal(formatBytes(12), '12 B'); assert.equal(formatBytes(1240), '1.2 KB'); assert.equal(formatBytes(12400000), '12.4 MB');
  for (const value of [undefined, NaN, -1, 0, 1.5]) assert.equal(formatBytes(value), '—');
  assert.equal(formatCount(123456), '123,456'); assert.equal(formatCount(0), '0'); assert.equal(formatCount(undefined), '—');
  assert.equal(formatDuration(163000), '2 min 43 s'); assert.equal(formatDuration(-1), undefined); assert.equal(formatDuration(NaN), undefined);
  setLanguage('uk');
  try {
    assert.equal(formatBytes(12400000), '12,4 МБ'); assert.equal(formatDuration(163000), '2 хв 43 с');
    const info = rows({}, undefined, { stats: { textures: 4, textureSize: 2048, dimensions: [1.23456, 2, 3] } });
    assert.equal(info.textures.value, '4 текстури, до 2 048 пкс'); assert.equal(info.bounds.value, '1,235 × 2 × 3');
    assert.equal(info.model.label, 'Генератор'); assert.equal(info.source.label, 'Вихідне зображення');
  } finally { setLanguage('en'); }
});

const sceneOf = model => ({ model, renders: 0, queueRender() { this.renders++; } });
test('real GLB scene reports geometry and restores wireframe materials exactly over repeated cycles', async () => {
  const bytes = cubeGlb(), gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const scene = sceneOf(gltf.scene), symbol = Symbol('scene'), viewer = { [symbol]: scene };
  assert.equal(modelScene(viewer), scene); assert.equal(modelScene({ [Symbol('scene')]: {} }), null); assert.equal(modelScene({}), null); assert.equal(modelScene(null), null);
  assert.deepEqual(meshStats(scene, { x: 1, y: 2, z: 3 }), { triangles: 12, vertices: 8, meshes: 1, materials: 1, textures: 0, textureSize: 0, dimensions: [1, 2, 3] });
  const mesh = gltf.scene.children[0], original = mesh.material;
  for (let i = 0; i < 3; i++) {
    const restore = wireframeView(scene), copy = mesh.material; let disposed = 0;
    copy.addEventListener('dispose', () => disposed++);
    assert.notEqual(copy, original); assert.equal(copy.wireframe, true); assert.equal(original.wireframe, false);
    restore(); restore(); assert.equal(mesh.material, original); assert.equal(disposed, 1);
  }
  assert.equal(scene.renders, 9);
});

test('shared materials, material arrays, textures, nonindexed and instanced meshes stay viewer-local', () => {
  const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(new Array(18).fill(0), 3));
  const texture = new Texture({ width: 1024, height: 2048 }), material = new MeshStandardMaterial({ map: texture, normalMap: texture });
  const root = new Group(), first = new Mesh(geometry, material), second = new Mesh(geometry, [material, material]), instances = new InstancedMesh(geometry, material, 3);
  root.add(first, second, instances);
  const scene = sceneOf(root), otherViewer = new Mesh(geometry, material), originalArray = second.material;
  assert.deepEqual(meshStats(scene), { meshes: 3, triangles: 10, vertices: 30, materials: 1, textures: 1, textureSize: 2048 });
  const restore = wireframeView(scene), clone = first.material; let disposed = 0, textureDisposed = 0;
  clone.addEventListener('dispose', () => disposed++); texture.addEventListener('dispose', () => textureDisposed++);
  assert.equal(second.material[0], clone); assert.equal(second.material[1], clone); assert.equal(otherViewer.material, material); assert.equal(material.wireframe, false);
  // Reload can detach the old root before cleanup; restoration must still reach those old meshes.
  scene.model = new Group(); restore();
  assert.equal(first.material, material); assert.equal(second.material, originalArray); assert.equal(instances.material, material); assert.equal(disposed, 1); assert.equal(textureDisposed, 0);
});

test('partial wireframe failure restores originals and disposes already-created clones', () => {
  const root = new Group(), material = new MeshStandardMaterial(), first = new Mesh(new BufferGeometry(), material), second = new Mesh(new BufferGeometry(), { clone() { throw new Error('changed API'); } });
  root.add(first, second); const originalSecond = second.material;
  assert.throws(() => wireframeView(sceneOf(root)), /changed API/); assert.equal(first.material, material); assert.equal(second.material, originalSecond);
});

test('uploaded Info shows source and original filename without generator cost or timing', () => {
  const info = rows({ uploaded: true, fileName: 'Source name.glb', bytes: 1240, author: { name: 'Uploader' }, createdAt: '2026-11-14T10:00:00Z' }, { model: model3dModels.tripo, usd: .3 }, { stats: { triangles: 12, vertices: 8, meshes: 1, materials: 1, textures: 0 }, formatDate: () => 'today' });
  assert.equal(info.model.label, 'Source'); assert.equal(info.model.value, 'Uploaded'); assert.equal(info.fileName.value, 'Source name.glb');
  assert.equal(info.author.value, 'Uploader'); assert.equal(info.created.value, 'today'); assert.equal(info.file.value, 'GLB · 1.2 KB'); assert.equal(info.triangles.value, '12');
  for (const key of ['duration', 'cost', 'source']) assert.equal(info[key], undefined);
  assert.equal(rows({ modeler: 'tripo' }).model.value, 'Tripo H3.1');
  setLanguage('uk');
  try { assert.equal(rows({ uploaded: true }).model.value, 'Додано з файлу'); } finally { setLanguage('en'); }
});
