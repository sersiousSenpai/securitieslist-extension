// Draws the toolbar icon (a list with an alert dot) at 16/32/48/128 px as
// PNGs, with 4x supersampling. No image libraries needed.
// Run: node scripts/build-icons.mjs

import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const NAVY = [23, 43, 77];
const WHITE = [255, 255, 255];
const RED = [217, 48, 37];

function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// Colour at a point in unit coordinates (0..1), or null for transparent.
function shade(x, y) {
  let c = null;
  if (roundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) c = NAVY;
  const bars = [[0.3, 0.5], [0.5, 0.8], [0.7, 0.8]]; // [y, right edge]; top bar clears the dot
  for (const [by, right] of bars) {
    if (roundRect(x, y, 0.2, by - 0.055, right, by + 0.055, 0.055)) c = WHITE;
  }
  const dx = x - 0.74, dy = y - 0.28;
  if (dx * dx + dy * dy <= 0.17 ** 2) c = WHITE; // ring
  if (dx * dx + dy * dy <= 0.13 ** 2) c = RED;
  return c;
}

function render(size) {
  const S = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = shade((x + (sx + 0.5) / S) / size, (y + (sy + 0.5) / S) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const i = (y * size + x) * 4;
      if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; px[i + 3] = (255 * a) / (S * S); }
    }
  }
  return png(size, px);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  await writeFile(new URL(`../extension/icons/icon${size}.png`, import.meta.url), render(size));
}
console.log("icons written");
