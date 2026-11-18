export const maxVideoBytes = 128 * 1024 * 1024;
export function validateMp4Header(bytes) {
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp' || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) < 12) throw new Error('The video must be an MP4 file.');
}
