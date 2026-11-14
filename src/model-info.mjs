import { model3dModels, modelNames, imageName } from '../graph.mjs';
import { boardAuthor } from './annotations.mjs';
import { formatDuration } from './image-info.mjs';
import { language, plural, t } from './i18n.mjs';

export const formatCount = count => Number.isSafeInteger(count) && count >= 0 ? count.toLocaleString(language()) : '—';
export function formatBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return '—';
  const unit = bytes >= 1e6 ? 'MB' : bytes >= 1e3 ? 'KB' : 'B', scale = unit === 'MB' ? 1e6 : unit === 'KB' ? 1e3 : 1;
  const size = (bytes / scale).toLocaleString(language(), { maximumFractionDigits: 1 });
  return unit === 'MB' ? t('{size} MB', { size }) : unit === 'KB' ? t('{size} KB', { size }) : t('{size} B', { size });
}

export function modelInfo(node, run, { stats, formatDate = value => new Date(value).toLocaleString(language()) } = {}) {
  const data = node.data, modelId = value => Object.hasOwn(model3dModels, value) ? model3dModels[value] : undefined;
  const model = modelId(data.modeler) || run?.model || modelId(run?.modeler);
  const created = data.createdAt || run?.finishedAt || run?.startedAt, author = boardAuthor(data.author) || boardAuthor(run?.by);
  const duration = run?.startedAt && run?.finishedAt ? formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : undefined;
  const oldSource = run?.snapshot?.filter(item => item.type === 'image')[run?.outputIds?.indexOf(node.id)];
  const source = data.source || (oldSource ? { nodeId: oldSource.id, name: imageName(oldSource) } : undefined);
  const usd = data.usd ?? (run?.outputIds?.length === 1 ? run?.usd : undefined);
  const textures = stats ? plural(stats.textures, '{count} texture', '{count} textures') + (stats.textureSize ? t(', up to {size} px', { size: formatCount(stats.textureSize) }) : '') : '—';
  const extension = /\.([^.]+)$/.exec(data.fileName || '')?.[1].toUpperCase();
  return [
    ...(data.uploaded ? [{ key: 'model', label: t('Source'), value: extension && extension !== 'GLB' ? t('Uploaded · converted from {format}', { format: extension }) : t('Uploaded') }, { key: 'fileName', label: t('Original file name'), value: data.fileName || `${data.name}.glb` }] : [{ key: 'model', label: t('Generator'), value: Object.hasOwn(modelNames, model) ? modelNames[model] : model || '—' }]),
    { key: 'created', label: t('Created'), value: created && Number.isFinite(Date.parse(created)) ? formatDate(created) : '—' },
    { key: 'author', label: t('By'), value: author?.name || '—' },
    ...(!data.uploaded ? [{ key: 'duration', label: t('Generation time'), value: duration || '—', note: duration && run?.outputIds?.length > 1 ? t('Whole run') : undefined },
    { key: 'cost', label: t('Cost'), value: Number.isFinite(usd) && usd >= 0 ? `$${usd.toFixed(3).replace(/(\.\d\d)0$/, '$1')}` : '—' },
    { key: 'source', label: t('Source image'), value: source?.name || '—', nodeId: source?.nodeId }] : []),
    { key: 'file', label: t('File'), value: `GLB · ${formatBytes(data.bytes)}` },
    { key: 'triangles', label: t('Triangles'), value: formatCount(stats?.triangles) },
    { key: 'vertices', label: t('Vertices'), value: formatCount(stats?.vertices) },
    { key: 'meshes', label: t('Meshes'), value: formatCount(stats?.meshes) },
    { key: 'materials', label: t('Materials'), value: formatCount(stats?.materials) },
    { key: 'textures', label: t('Textures'), value: textures },
    { key: 'bounds', label: t('Size (model units)'), value: stats?.dimensions?.map(side => side.toLocaleString(language(), { maximumFractionDigits: 3 })).join(' × ') || '—' },
  ];
}

// Private API pinned to @google/model-viewer 4.4.0; hide mesh controls if a future viewer changes it.
// https://github.com/google/model-viewer/blob/v4.4.0/packages/model-viewer/src/model-viewer-base.ts (read 2026-11-14).
export function modelScene(element) {
  const symbol = element && Object.getOwnPropertySymbols(element).find(key => key.description === 'scene'), scene = symbol && element[symbol];
  return typeof scene?.model?.traverse === 'function' && typeof scene.queueRender === 'function' ? scene : null;
}

export function meshStats(scene, dimensions) {
  let meshes = 0, triangles = 0, vertices = 0, textureSize = 0;
  const materials = new Set(), textures = new Set();
  scene.model.traverse(mesh => {
    if (!mesh.isMesh) return;
    const copies = mesh.isInstancedMesh ? mesh.count : 1, geometry = mesh.geometry;
    meshes++; vertices += (geometry?.attributes?.position?.count || 0) * copies;
    triangles += Math.floor((geometry?.index?.count ?? geometry?.attributes?.position?.count ?? 0) / 3) * copies;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material || materials.has(material)) continue;
      materials.add(material);
      for (const texture of Object.values(material)) if (texture?.isTexture && !textures.has(texture)) {
        textures.add(texture);
        const image = texture.source?.data || texture.image;
        for (const part of Array.isArray(image) ? image : [image]) textureSize = Math.max(textureSize, part?.width || 0, part?.height || 0);
      }
    }
  });
  return { meshes, triangles, vertices, materials: materials.size, textures: textures.size, textureSize,
    ...(dimensions && ['x', 'y', 'z'].every(key => Number.isFinite(dimensions[key])) ? { dimensions: [dimensions.x, dimensions.y, dimensions.z] } : {}) };
}

// Replace mesh references, never edit cached/shared originals. Dispose only our clones, not their shared textures.
// https://threejs.org/docs/pages/Material.html (clone/dispose, read 2026-11-14).
// The lines glow in `color` (the viewer's text colour, so they read on light and dark themes): a plain wireframe clone keeps
// the lit, textured material, which drew near-black lines on the dark viewer.
export function wireframeView(scene, color = '#c9cdf2') {
  const originals = new WeakMap(), changed = new Set(), clones = new Map();
  const restore = () => {
    for (const mesh of changed) mesh.material = originals.get(mesh);
    for (const clone of clones.values()) clone.dispose();
    changed.clear(); clones.clear(); scene.queueRender();
  };
  const clone = material => {
    if (!clones.has(material)) {
      const copy = material.clone();
      copy.wireframe = true;
      for (const key of ['map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) if (key in copy) copy[key] = null;
      copy.color?.set?.(color); copy.emissive?.set?.(color);
      if ('emissiveIntensity' in copy) copy.emissiveIntensity = 1;
      clones.set(material, copy);
    }
    return clones.get(material);
  };
  try {
    scene.model.traverse(mesh => {
      if (!mesh.isMesh || !mesh.material) return;
      originals.set(mesh, mesh.material); changed.add(mesh);
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material);
    });
    scene.queueRender();
  } catch (cause) { restore(); throw cause; }
  return restore;
}
