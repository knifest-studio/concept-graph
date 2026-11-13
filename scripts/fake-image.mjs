// Shared PNG fixture for the local Gemini and OpenAI stand-ins.
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

function chunk(type, data) {
  const head = Buffer.alloc(8), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

// A soft two-colour gradient with a few bands, coloured from the prompt so every generation looks different.
export function picture(seed, width = 512, height = 512) {
  const hash = createHash('sha256').update(seed).digest(), a = [...hash.subarray(0, 3)], b = [...hash.subarray(3, 6)], bands = 3 + (hash[6] % 5);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const offset = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const t = (x + y) / (width + height), band = Math.floor((y / height) * bands) % 2 ? 0.9 : 1;
      for (let c = 0; c < 3; c++) rows[offset + 1 + x * 3 + c] = Math.round((a[c] * (1 - t) + b[c] * t) * band);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

export const send = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };

