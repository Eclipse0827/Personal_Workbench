'use strict';

/**
 * 生成 PWA 安装图标（192 / 512 PNG）。
 * 只用 Node 内置 zlib，不引第三方图像库；图形与 public/icon.svg 保持一致：
 * 棕底圆角 + 米色表盘 + 两根指针，呼应「缓一缓」的时间感。
 * 用法：node scripts/make-pwa-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');
const BG = [0x5c, 0x40, 0x33];
const INK = [0xef, 0xe6, 0xd8];
const GOLD = [0xd9, 0xb9, 0x8a];

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.285;
  const ring = size * 0.035;
  const corner = size * 0.22;
  let o = 0;

  for (let y = 0; y < size; y += 1) {
    raw[o] = 0; // PNG filter: none
    o += 1;
    for (let x = 0; x < size; x += 1) {
      const qx = Math.min(Math.max(x, corner), size - 1 - corner);
      const qy = Math.min(Math.max(y, corner), size - 1 - corner);
      const inside = Math.hypot(x - qx, y - qy) <= corner;
      let color = BG;
      let alpha = 255;
      if (!inside) {
        alpha = 0;
      } else {
        const d = Math.hypot(x - cx, y - cy);
        if (Math.abs(d - r) <= ring) color = INK;
        for (const [px, py] of [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]]) {
          if (Math.hypot(x - px, y - py) <= size * 0.026) color = INK;
        }
        if (distToSegment(x, y, cx, cy, cx, cy - r * 0.62) <= size * 0.021) color = INK;
        if (distToSegment(x, y, cx, cy, cx + r * 0.48, cy + r * 0.3) <= size * 0.016) color = GOLD;
        if (d <= size * 0.032) color = INK;
      }
      raw[o] = color[0]; raw[o + 1] = color[1]; raw[o + 2] = color[2]; raw[o + 3] = alpha;
      o += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log(`生成 ${file} (${fs.statSync(file).size} 字节)`);
}
