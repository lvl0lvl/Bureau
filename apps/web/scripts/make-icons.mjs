// Draws the Bureau mark (a framed square with a blue band) as PNG icons. No dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pad) {
  const px = Buffer.alloc(size * size * 3, 255);
  const set = (x, y, [r, g, b]) => { const i = (y * size + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b; };
  const a = Math.round(size * pad), b = size - a;            // outer square
  const t = Math.max(2, Math.round((b - a) * 0.125));         // stroke
  const band = Math.round(a + (b - a) * 0.58);                // where the blue band starts
  for (let y = a; y < b; y++) for (let x = a; x < b; x++) {
    const edge = x < a + t || x >= b - t || y < a + t || y >= b - t;
    const rule = y >= band - t && y < band;
    if (edge || rule) set(x, y, [0, 0, 0]);
    else if (y >= band) set(x, y, [0x1d, 0x3f, 0xe3]);
  }
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 3 + 1)] = 0; px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

writeFileSync(out('icon-192.png'), png(192, 0.2));
writeFileSync(out('icon-512.png'), png(512, 0.2));
writeFileSync(out('icon-maskable-512.png'), png(512, 0.28));
writeFileSync(out('apple-touch-icon.png'), png(180, 0.2));
console.log('icons written');
