import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { readPng, reframePng } from '../cloud/png-frame.mjs';
import { imageSize } from '../graph.mjs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type), data]))); return Buffer.concat([head, data, tail]); };

// An RGB PNG whose pixel (x, y) is (x, y, x + y), each row stored with the filter given for it.
function png(width, height, filters = [0, 1, 2, 3, 4]) {
  const rows = [];
  let previous = Buffer.alloc(width * 3);
  for (let y = 0; y < height; y++) {
    const raw = Buffer.alloc(width * 3);
    for (let x = 0; x < width; x++) raw.set([x & 255, y & 255, (x + y) & 255], x * 3);
    const type = filters[y % filters.length], out = Buffer.alloc(width * 3 + 1);
    out[0] = type;
    for (let i = 0; i < raw.length; i++) {
      const a = i >= 3 ? raw[i - 3] : 0, b = previous[i], c = i >= 3 ? previous[i - 3] : 0, p = a + b - c;
      const predictor = type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : type === 4 ? (Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c) : 0;
      out[i + 1] = (raw[i] - predictor) & 255;
    }
    rows.push(out); previous = raw;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  const data = deflateSync(Buffer.concat(rows));
  // Split across two IDAT chunks, as encoders do.
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('gAMA', Buffer.from([0, 0, 177, 143])), chunk('IDAT', data.subarray(0, 40)), chunk('IDAT', data.subarray(40)), chunk('IEND', Buffer.alloc(0))]));
}

// Every pixel of an 8-bit RGB PNG, through Node's own inflate.
function pixels(bytes) {
  const info = readPng(bytes), raw = inflateSync(Buffer.concat(info.data.map(part => Buffer.from(part)))), stride = info.width * 3, out = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < info.height; y++) {
    const type = raw[y * (stride + 1)], row = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? row[i - 3] : 0, b = previous[i], c = i >= 3 ? previous[i - 3] : 0, p = a + b - c;
      row[i] = (row[i] + (type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : type === 4 ? (Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c) : 0)) & 255;
    }
    out.push(row); previous = row;
  }
  return { width: info.width, height: info.height, at: (x, y) => [...out[y].subarray(x * 3, x * 3 + 3)], info };
}

test('a PNG is padded by repeating its edges and cropped back to exactly the same pixels', async () => {
  const source = png(37, 19);
  const padded = pixels(await reframePng(source, { width: 41, height: 25, left: -2, top: -3 }));
  assert.deepEqual([padded.width, padded.height], [41, 25]);
  assert.deepEqual(padded.at(2, 3), [0, 0, 0]); assert.deepEqual(padded.at(10, 8), [8, 5, 13]);
  // Outside the source, the nearest edge pixel repeats.
  assert.deepEqual(padded.at(0, 0), [0, 0, 0]); assert.deepEqual(padded.at(40, 24), [36, 18, 54]); assert.deepEqual(padded.at(0, 10), [0, 7, 7]);
  // Colour chunks before the image data are kept.
  assert.deepEqual(padded.info.before.map(item => item.type), ['gAMA']);
  const back = pixels(await reframePng(await reframePng(source, { width: 41, height: 25, left: -2, top: -3 }), { width: 37, height: 19, left: 2, top: 3 }));
  const original = pixels(source);
  for (let y = 0; y < 19; y++) for (let x = 0; x < 37; x++) assert.deepEqual(back.at(x, y), original.at(x, y), `${x},${y}`);
  assert.deepEqual(imageSize(await reframePng(source, { width: 10, height: 5, left: 4, top: 4 })), { width: 10, height: 5 });
});

test('PNGs that cannot be reframed row by row are left alone', async () => {
  assert.equal(readPng(new Uint8Array([255, 216, 255, 224, ...new Array(40).fill(0)])), null);
  const interlaced = png(4, 4); interlaced[28] = 1;
  assert.equal(await reframePng(interlaced, { width: 4, height: 4 }), null);
});
