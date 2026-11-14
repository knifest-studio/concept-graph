export const maxModelBytes = 80 * 1024 * 1024;
// GLB 2 header (https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout, read 2026-11-14); the declared length includes the header and all chunks.
export function glbLength(bytes) {
  if (bytes.byteLength < 12 || bytes[0] !== 103 || bytes[1] !== 108 || bytes[2] !== 84 || bytes[3] !== 70) throw new Error('Invalid GLB magic.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== 2) throw new Error('Only GLB version 2 is supported.');
  const length = view.getUint32(8, true);
  if (length < 20) throw new Error('Invalid GLB length.');
  if (length > maxModelBytes) throw new Error('3D models can be at most 80 MB.');
  return length;
}
export function validateGlb(bytes) {
  if (bytes.byteLength > maxModelBytes) throw new Error('3D models can be at most 80 MB.');
  if (glbLength(bytes) !== bytes.byteLength) throw new Error('GLB length does not match the file.');
  return bytes;
}
