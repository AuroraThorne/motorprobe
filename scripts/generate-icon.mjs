import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { deflateSync } from 'zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Generates a clean 128x128 RGBA PNG extension icon without external image dependencies.
const W = 128;
const H = 128;
const raw = Buffer.alloc((W * 4 + 1) * H);

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([len, t, data, crc]);
}

for (let y = 0; y < H; y++) {
  const rowOff = y * (W * 4 + 1);
  raw[rowOff] = 0; // filter None
  for (let x = 0; x < W; x++) {
    const p = rowOff + 1 + x * 4;
    const dx = x - 63.5;
    const dy = y - 63.5;
    const r = Math.hypot(dx, dy);

    // Rounded square mask
    const rx = Math.max(0, Math.abs(dx) - 42);
    const ry = Math.max(0, Math.abs(dy) - 42);
    const cornerDist = Math.hypot(rx, ry);
    if (cornerDist > 18) {
      raw[p] = 0;
      raw[p + 1] = 0;
      raw[p + 2] = 0;
      raw[p + 3] = 0;
      continue;
    }

    // Deep blue gradient background (#0e4d92 -> #042146)
    const t = (x + y) / (W + H);
    let R = Math.round(14 * (1 - t) + 4 * t);
    let G = Math.round(77 * (1 - t) + 33 * t);
    let B = Math.round(146 * (1 - t) + 70 * t);

    // Stator ring + rotor core + waveform accent
    const waveY = 64 - 16 * Math.sin((x - 24) * 0.095);
    const onOuterRing = Math.abs(r - 36) < 3.4;
    const onInnerHub = r < 9.5;
    const onWave = x >= 24 && x <= 104 && Math.abs(y - waveY) < 2.6;

    if (onWave) {
      R = 79;
      G = 195;
      B = 247;
    } else if (onOuterRing || onInnerHub) {
      R = 235;
      G = 244;
      B = 255;
    }

    raw[p] = R;
    raw[p + 1] = G;
    raw[p + 2] = B;
    raw[p + 3] = cornerDist > 17 ? Math.round((18 - cornerDist) * 255) : 255;
  }
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const mediaDir = join(ROOT, 'media');
mkdirSync(mediaDir, { recursive: true });
writeFileSync(join(mediaDir, 'icon.png'), png);
console.log('Generated media/icon.png (' + png.length + ' bytes)');
