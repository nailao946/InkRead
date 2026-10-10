#!/usr/bin/env node
/* gen-icons.mjs —— 生成扩展图标 PNG（零依赖：手写 PNG 编码 + 4× 超采样抗锯齿）
 *
 * 设计：金色渐变圆角方块（品牌色）+ 深墨色播放三角 + 底部「字幕条」。
 *   node plugin/tools/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4;                     // 超采样倍数

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                                     // filter: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;  // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 几何工具（坐标归一化 0..1） ---------- */
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
};
const inTriangle = (px, py, ax, ay, bx, by, cx, cy) => {
  const s = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d1 = s(ax, ay, bx, by, px, py), d2 = s(bx, by, cx, cy, px, py), d3 = s(cx, cy, ax, ay, px, py);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
};
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

/* ---------- 图标绘制（返回该点的 [r,g,b,a]） ---------- */
const GOLD_A = [247, 201, 72];    // #f7c948
const GOLD_B = [194, 65, 12];     // #c2410c
const INK = [26, 20, 7];          // #1a1407

function shade(x, y) {
  /* 圆角方块底 */
  if (!inRoundRect(x, y, 0.045, 0.045, 0.955, 0.955, 0.22)) return [0, 0, 0, 0];
  /* 斜向渐变 */
  const t = Math.min(1, Math.max(0, (x * 0.55 + y * 0.75)));
  let col = mix(GOLD_A, GOLD_B, t);
  /* 左上高光 */
  const hl = Math.max(0, 1 - Math.hypot(x - 0.2, y - 0.16) / 0.55);
  col = mix(col, [255, 236, 170], hl * 0.35);

  const A = 242;   /* PNG 的 alpha 是 0–255，别写成 0–1 */
  /* 播放三角（略偏左，视觉居中） */
  if (inTriangle(x, y, 0.40, 0.30, 0.40, 0.66, 0.71, 0.48)) {
    return [...mix(INK, col, 0.04), A];
  }
  /* 底部「字幕条」 */
  if (inRoundRect(x, y, 0.27, 0.745, 0.73, 0.825, 0.04)) {
    return [...mix(INK, col, 0.04), A];
  }
  return [...col, A];
}

function render(size) {
  const N = size * SS;
  const acc = new Float64Array(size * size * 4);
  for (let sy = 0; sy < N; sy++) {
    for (let sx = 0; sx < N; sx++) {
      const c = shade((sx + 0.5) / N, (sy + 0.5) / N);
      const di = ((sy / SS) | 0) * size + ((sx / SS) | 0);
      acc[di * 4] += c[0]; acc[di * 4 + 1] += c[1]; acc[di * 4 + 2] += c[2]; acc[di * 4 + 3] += c[3];
    }
  }
  const n = SS * SS;
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    for (let k = 0; k < 4; k++) out[i * 4 + k] = Math.max(0, Math.min(255, Math.round(acc[i * 4 + k] / n)));
  }
  return out;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const s of SIZES) {
  const p = resolve(OUT_DIR, `icon${s}.png`);
  writeFileSync(p, encodePng(s, s, render(s)));
  console.log('OK  ' + p);
}
console.log('\n图标已生成（' + SIZES.join('/') + 'px）。');
