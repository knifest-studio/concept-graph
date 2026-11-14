import { glbLength, maxModelBytes } from './model-assets.mjs';

let viewerModule;
// Shared with cards: importing this helper alone never loads Three/model-viewer.
export const loadViewer = () => viewerModule ||= import('@google/model-viewer').catch(cause => { viewerModule = null; throw cause; });
export const modelExtension = file => /\.([^.]+)$/.exec(file.name || '')?.[1].toLowerCase() || (file.type === 'model/gltf-binary' ? 'glb' : '');
export const modelFile = file => /^(glb|gltf|obj|fbx|stl|ply|3mf|usdz)$/.test(modelExtension(file));
export const modelInputAccept = '.glb,.gltf,.obj,.fbx,.stl,.ply,.3mf,.usdz,.zip,.mtl,.bin,.png,.jpg,.jpeg,.webp,.gif,.tga,.bmp,.ktx2,.avif,model/gltf-binary';
export const supportedModelFormats = 'Supported 3D formats: GLB, glTF, OBJ, FBX, STL, PLY, 3MF, USDZ, or ZIP with companion files.';
export const maxModelInputBytes = 300 * 1024 * 1024;
export function resourceName(path) {
  let clean = String(path).replace(/[?#].*$/, '');
  try { clean = decodeURIComponent(clean); } catch {}
  return clean.replace(/\\/g, '/').split('/').pop().toLowerCase();
}
export function groupModelFiles(files) {
  const models = [], images = [], unsupported = [], resources = new Map();
  for (const file of files) {
    const ext = modelExtension(file);
    if (modelFile(file)) models.push(file);
    else if (/^(mtl|bin|png|jpe?g|webp|gif|tga|bmp|ktx2|avif)$/.test(ext)) {
      if (!resources.has(resourceName(file.name))) resources.set(resourceName(file.name), file);
      if (/^(png|jpe?g|webp|gif)$/.test(ext)) images.push(file);
    } else if (/^image\/(png|jpeg|webp|gif)$/.test(file.type || '')) images.push(file);
    else unsupported.push(file);
  }
  return { models, images, resources, unsupported };
}
export function checkModelBatch(files) {
  if (files.reduce((sum, file) => sum + file.size, 0) > maxModelInputBytes) throw new Error('3D upload batches can be at most 300 MB, including unpacked files.');
}
export async function checkModelFile(file) {
  if (modelExtension(file) && modelExtension(file) !== 'glb') throw new Error(supportedModelFormats);
  if (file.size > maxModelBytes) throw new Error('3D models can be at most 80 MB.');
  if (glbLength(new Uint8Array(await file.slice(0, 12).arrayBuffer())) !== file.size) throw new Error('GLB length does not match the file.');
}

// model-viewer 4.4.0 pre-renders offscreen models once; toBlob reads that canvas.
// https://github.com/google/model-viewer/blob/v4.4.0/packages/model-viewer/src/model-viewer-base.ts
export async function modelPoster(file, { timeout = 20000 } = {}) {
  let element, url, timer, expired = false;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('3D preview timed out.')); }, timeout); });
  try {
    return await Promise.race([deadline, (async () => {
      await loadViewer();
      if (expired) return;
      element = document.createElement('model-viewer');
      element.style.cssText = 'position:fixed;left:-10000px;top:0;width:768px;height:768px;opacity:0;pointer-events:none;z-index:-1';
      element.setAttribute('aria-hidden', 'true');
      element.setAttribute('loading', 'eager');
      element.setAttribute('reveal', 'auto');
      element.setAttribute('interaction-prompt', 'none');
      const loaded = new Promise((resolve, reject) => {
        element.addEventListener('load', resolve, { once: true });
        element.addEventListener('error', () => reject(new Error('Could not render 3D preview.')), { once: true });
      });
      url = URL.createObjectURL(file); element.src = url;
      document.body.appendChild(element);
      await loaded;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (expired) return;
      return element.toBlob({ mimeType: 'image/png' });
    })()]);
  } finally {
    clearTimeout(timer);
    element?.remove();
    if (url) URL.revokeObjectURL(url);
  }
}
