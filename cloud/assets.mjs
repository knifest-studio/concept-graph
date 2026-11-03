export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const assetPattern = /^[\da-f-]{36}\.(png|jpg|gif|webp)$/;
export const imageTypes = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function imageFormat(bytes) {
  const starts = (values, offset = 0) => values.every((value, i) => bytes[offset + i] === value);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
  if (starts([255, 216, 255])) return 'jpg';
  if (starts([71, 73, 70, 56]) && [55, 57].includes(bytes[4]) && bytes[5] === 97) return 'gif';
  if (starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)) return 'webp';
  throw new Error('Use a PNG, JPEG, WebP or GIF image.');
}

export async function readBody(request, limit = MAX_IMAGE_BYTES) {
  const tooLarge = () => Object.assign(new Error('Request body is too large.'), { status: 413 });
  if (Number(request.headers.get('Content-Length')) > limit) throw tooLarge();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
