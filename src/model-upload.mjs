import { glbLength, maxModelBytes } from './model-assets.mjs';

let viewerModule;
// Shared with cards: importing this helper alone never loads Three/model-viewer.
export const loadViewer = () => viewerModule ||= import('@google/model-viewer').catch(cause => { viewerModule = null; throw cause; });
export const modelFile = file => /\.(glb|gltf|obj|fbx)$/i.test(file.name || '') || file.type === 'model/gltf-binary';
export async function checkModelFile(file) {
  if (/\.(gltf|obj|fbx)$/i.test(file.name || '')) throw new Error('Only GLB files can be added. Export GLB from your 3D app.');
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
