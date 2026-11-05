// Reframes a PNG without holding its pixels in memory: rows are inflated, unfiltered, re-filtered and deflated one at a
// time, so even an 8K image fits the board room's 128 MB. Used to give Nano Banana an image padded to a ratio it can
// draw, then to cut its larger answer back to the original's shape. Handles 8-bit, non-interlaced PNGs (grey, grey with
// alpha, RGB, RGBA, palette); anything else returns null and is used as it is.

const signature = [137, 80, 78, 71, 13, 10, 26, 10], channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (type, data) => {
  let c = 0xffffffff;
  for (const bytes of [type, data]) for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const ascii = text => new Uint8Array([...text].map(letter => letter.charCodeAt(0)));
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer), name = ascii(type);
  view.setUint32(0, data.length); out.set(name, 4); out.set(data, 8); view.setUint32(8 + data.length, crc(name, data));
  return out;
}

// The chunks of a PNG, or null when the bytes are not a PNG this module can reframe.
export function readPng(bytes) {
  if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), before = [], data = [];
  let header, offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset), type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)), body = bytes.subarray(offset + 8, offset + 8 + length);
    if (offset + 12 + length > bytes.length) return null;
    if (type === 'IHDR') header = { width: view.getUint32(offset + 8), height: view.getUint32(offset + 12), depth: bytes[offset + 16], color: bytes[offset + 17], interlace: bytes[offset + 20] };
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    // Colour information (palette, transparency, gamma, profile) comes before the image data and is kept.
    else if (!data.length) before.push({ type, body });
    offset += 12 + length;
  }
  if (!header || !data.length || header.depth !== 8 || header.interlace !== 0 || !channels[header.color]) return null;
  return { ...header, bpp: channels[header.color], before, data };
}

const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
function unfilter(type, row, previous, bpp) {
  for (let i = 0; i < row.length; i++) {
    const left = i >= bpp ? row[i - bpp] : 0, up = previous[i], corner = i >= bpp ? previous[i - bpp] : 0;
    row[i] = (row[i] + (type === 1 ? left : type === 2 ? up : type === 3 ? (left + up) >> 1 : type === 4 ? paeth(left, up, corner) : 0)) & 255;
  }
}

async function collect(readable) {
  const parts = [], reader = readable.getReader();
  let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); size += value.length; }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/**
 * A new PNG `width` × `height` whose pixel (x, y) is the source pixel (x + left, y + top), with coordinates outside the
 * source taken from its nearest edge. A negative left or top pads (repeating the edge), a positive one crops.
 */
export async function reframePng(bytes, { width, height, left = 0, top = 0 }) {
  const png = readPng(bytes);
  if (!png || !(width > 0 && height > 0)) return null;
  const sourceRow = png.width * png.bpp, outRow = width * png.bpp;
  const inflated = new Blob(png.data).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const compressor = new CompressionStream('deflate'), writer = compressor.writable.getWriter(), compressed = collect(compressor.readable);
  let pending = new Uint8Array(0), sourceY = -1, current = new Uint8Array(sourceRow), previous = new Uint8Array(sourceRow);
  // Reads and unfilters the next source row.
  const nextRow = async () => {
    while (pending.length < sourceRow + 1) {
      const { done, value } = await inflated.read();
      if (done) throw new Error('Truncated PNG.');
      const joined = new Uint8Array(pending.length + value.length); joined.set(pending); joined.set(value, pending.length); pending = joined;
    }
    [previous, current] = [current, previous];
    current.set(pending.subarray(1, sourceRow + 1));
    unfilter(pending[0], current, sourceY < 0 ? new Uint8Array(sourceRow) : previous, png.bpp);
    pending = pending.subarray(sourceRow + 1); sourceY++;
  };
  const row = new Uint8Array(outRow), above = new Uint8Array(outRow), line = new Uint8Array(outRow + 1);
  try {
    for (let y = 0; y < height; y++) {
      const wanted = Math.min(png.height - 1, Math.max(0, y + top));
      while (sourceY < wanted) await nextRow();
      for (let x = 0; x < width; x++) {
        const from = Math.min(png.width - 1, Math.max(0, x + left)) * png.bpp;
        for (let k = 0; k < png.bpp; k++) row[x * png.bpp + k] = current[from + k];
      }
      // Paeth suits illustrations and photos alike.
      line[0] = 4;
      for (let i = 0; i < outRow; i++) line[i + 1] = (row[i] - paeth(i >= png.bpp ? row[i - png.bpp] : 0, y ? above[i] : 0, y && i >= png.bpp ? above[i - png.bpp] : 0)) & 255;
      await writer.write(line.slice());
      above.set(row);
    }
    await writer.close();
  } catch (cause) { writer.abort(cause).catch(() => {}); inflated.cancel().catch(() => {}); throw cause; }
  inflated.cancel().catch(() => {});
  const deflated = await compressed, header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header.set([8, png.color, 0, 0, 0], 8);
  const parts = [new Uint8Array(signature), chunk('IHDR', header), ...png.before.map(item => chunk(item.type, item.body))];
  for (let offset = 0; offset < deflated.length; offset += 1 << 20) parts.push(chunk('IDAT', deflated.subarray(offset, offset + (1 << 20))));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}
