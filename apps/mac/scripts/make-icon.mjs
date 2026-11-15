// Draws the Mac app icon: the Bureau mark on a white rounded plate, with the margins macOS expects.
// Usage: node make-icon.mjs <out.png>   (1024 x 1024, transparent outside the plate)
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const N = 1024;
const PLATE = { x: 100, y: 100, s: 824, r: 185 };
const px = Buffer.alloc(N * N * 4, 0);

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

/** Is this point inside a rounded square? */
function inside(x, y, p) {
  const lx = x - p.x, ly = y - p.y;
  if (lx < 0 || ly < 0 || lx > p.s || ly > p.s) return false;
  const cx = lx < p.r ? p.r : lx > p.s - p.r ? p.s - p.r : lx;
  const cy = ly < p.r ? p.r : ly > p.s - p.r ? p.s - p.r : ly;
  return (lx - cx) ** 2 + (ly - cy) ** 2 <= p.r ** 2;
}
/** How much of a pixel a rounded square covers, 0 to 1. */
function coverage(x, y, p) {
  let n = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4, p)) n++;
  return n / 16;
}

const edge = { x: PLATE.x + 3, y: PLATE.y + 3, s: PLATE.s - 6, r: PLATE.r - 3 };
// The mark: a black frame with a blue band along the bottom, as on the web and the iPhone.
const a = 312, b = 712, t = 50, band = a + Math.round((b - a) * 0.58);

for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const outer = coverage(x, y, PLATE);
  if (!outer) continue;
  const inner = coverage(x, y, edge);
  // A faint rule round the plate so it holds its shape on a white background.
  let r = 255 * inner + 0xcb * (1 - inner), g = 255 * inner + 0xd6 * (1 - inner), bl = 255 * inner + 0xe0 * (1 - inner);
  if (x >= a && x < b && y >= a && y < b) {
    const frame = x < a + t || x >= b - t || y < a + t || y >= b - t;
    const rule = y >= band - t && y < band;
    if (frame || rule) { r = 0; g = 0; bl = 0; }
    else if (y >= band) { r = 0x1d; g = 0x3f; bl = 0xe3; }
  }
  const i = (y * N + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = bl; px[i + 3] = Math.round(255 * outer);
}

const row = N * 4 + 1;
const raw = Buffer.alloc(row * N);
for (let y = 0; y < N; y++) px.copy(raw, y * row + 1, y * N * 4, (y + 1) * N * 4);
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(process.argv[2], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
