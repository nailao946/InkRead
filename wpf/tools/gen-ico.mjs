#!/usr/bin/env node
/* gen-ico.mjs —— 生成 Windows 桌面版图标 wpf/Assets/InkRead.ico
 *
 * 品牌取自 web/icons/make_icons.py（深琥珀主题）：深色圆盘 + 琥珀描边奖章 + 打开的书本。
 * 与网页/PWA 图标同一套配色，保证「任务栏 / 标题栏 / 网页」看起来是一家人。
 *
 * 完全零依赖：
 *   · PNG 编码自己写（zlib 来自 node 标准库），用于 128 / 256 两档（体积小）
 *   · 小尺寸用传统 BMP(DIB) 条目（16/24/32/48/64），兼容性最好
 *   · ICO 容器自己拼（6 字节头 + N×16 字节目录 + 图像数据）
 *
 *   node wpf/tools/gen-ico.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'Assets', 'InkRead.ico');

/* ---------- 品牌配色（与 web/icons/make_icons.py、THEMES.md 一致） ---------- */
const PANEL = [0x3A, 0x3A, 0x37];    // 奖章内盘
const ACCENT = [0xFA, 0xC7, 0x75];   // 琥珀（描边 + 书本）
const INK = [0x2C, 0x2C, 0x2A];      // 书页文字线条 / 中缝

/* ---------- 几何（坐标归一化 0..1） ---------- */
const inCircle = (x, y, cx, cy, r) => {
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
};
/* 凸四边形内部判定：所有边同号 */
function inConvex(pts, x, y) {
  let pos = 0, neg = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const d = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (d > 0) pos++; else if (d < 0) neg++;
  }
  return !(pos && neg);
}
const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

/* ---------- 单像素着色 ---------- */
const R_OUT = 0.455;       // 奖章外圈半径（留一点边距，任务栏里不糊）
const RING = 0.038;        // 描边厚度

const CX = 0.5, CY = 0.5;
const G = 0.013;           // 书脊半宽
const BW = 0.255;          // 半宽
const TY = CY - 0.135;     // 书顶
const BY = CY + 0.135;     // 书底
const DIP = 0.020;         // 外页上扬

function shade(x, y, detail) {
  const d = Math.hypot(x - CX, y - CY);
  if (d > R_OUT) return [0, 0, 0, 0];                       // 圆外全透明
  if (d > R_OUT - RING) return [...ACCENT, 255];            // 琥珀描边

  let col = PANEL;

  /* 左右两页（梯形） */
  const left = [[CX - G, TY], [CX - BW, TY + DIP], [CX - BW, BY + DIP], [CX - G, BY]];
  const right = [[CX + G, TY], [CX + BW, TY + DIP], [CX + BW, BY + DIP], [CX + G, BY]];
  if (inConvex(left, x, y) || inConvex(right, x, y)) col = ACCENT;

  /* 书页上的文字线条：小尺寸画不下（会糊成一团），只在 size ≥ 48 时画 */
  if (detail && col[0] === ACCENT[0]) {
    const lineW = BW * 0.58;
    const lines = detail === 2 ? 3 : 2;
    for (let k = 0; k < lines; k++) {
      const ly = TY + DIP + (BY - TY) * (lines === 3 ? (0.28 + k * 0.24) : (0.34 + k * 0.26));
      if (inRect(x, y, CX - BW * 0.90, ly, CX - BW * 0.90 + lineW, ly + 0.012)) col = INK;
      if (inRect(x, y, CX + BW * 0.90 - lineW, ly, CX + BW * 0.90, ly + 0.012)) col = INK;
    }
  }

  /* 中缝（最后画，压住书脊） */
  if (x >= CX - G && x <= CX + G && y >= TY && y <= BY + DIP) col = PANEL;

  return [...col, 255];
}

/* ---------- 渲染（4× 超采样抗锯齿，先乘 alpha 再平均，避免边缘发黑） ---------- */
const SS = 4;
function render(size) {
  const N = size * SS;
  const acc = new Float64Array(size * size * 4);
  const detail = size >= 48 ? (size >= 96 ? 2 : 1) : 0;
  for (let sy = 0; sy < N; sy++) {
    for (let sx = 0; sx < N; sx++) {
      const [r, g, b, a] = shade((sx + 0.5) / N, (sy + 0.5) / N, detail);
      const di = Math.min(size - 1, (sy / SS) | 0) * size + Math.min(size - 1, (sx / SS) | 0);
      const w = a / 255;
      acc[di * 4] += r * w; acc[di * 4 + 1] += g * w; acc[di * 4 + 2] += b * w; acc[di * 4 + 3] += a;
    }
  }
  const n = SS * SS;
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = acc[i * 4 + 3] / n;
    const cov = a / 255;
    out[i * 4] = cov > 0 ? Math.max(0, Math.min(255, Math.round(acc[i * 4] / n / cov))) : 0;
    out[i * 4 + 1] = cov > 0 ? Math.max(0, Math.min(255, Math.round(acc[i * 4 + 1] / n / cov))) : 0;
    out[i * 4 + 2] = cov > 0 ? Math.max(0, Math.min(255, Math.round(acc[i * 4 + 2] / n / cov))) : 0;
    out[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(a)));
  }
  return out;   // RGBA，行优先，上→下
}

/* ---------- PNG 编码 ---------- */
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = buf => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
};
function encodePng(W, H, rgba) {
  const stride = W * 4 + 1;
  const raw = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- BMP(DIB) 编码：ICO 里传统条目，兼容性最好 ---------- */
function encodeBmp(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);                 // biSize
  header.writeInt32LE(size, 4);                // biWidth
  header.writeInt32LE(size * 2, 8);            // biHeight = XOR + AND
  header.writeUInt16LE(1, 12);                 // biPlanes
  header.writeUInt16LE(32, 14);                // biBitCount
  header.writeUInt32LE(0, 16);                 // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);   // biSizeImage
  /* XOR 位图：BGRA，自下而上 */
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = src + x * 4, d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; xor[d + 1] = rgba[s + 1]; xor[d + 2] = rgba[s]; xor[d + 3] = rgba[s + 3];
    }
  }
  /* AND 掩码：32bpp 有 alpha，全 0 即可；每行按 4 字节对齐 */
  const rowBytes = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(rowBytes * size);
  return Buffer.concat([header, xor, and]);
}

/* ---------- ICO 容器 ---------- */
function buildIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;       // 0 表示 256
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;                            // 调色板数
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);               // planes
    dir.writeUInt16LE(32, o + 6);              // bitCount
    dir.writeUInt32LE(e.data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.data.length;
  });
  return Buffer.concat([head, dir, ...entries.map(e => e.data)]);
}

/* ---------- 预览图（给人眼看，不参与打包） ----------
   把每档尺寸并排画在棋盘格上，另附 32px 放大 8× 的小尺寸可读性检查。
   这样不用装 Windows 也能在仓库里直接看图标长什么样。 */
function makePreview() {
  const cellW = 280, cellH = 300, pad = 12;
  const W = cellW * SIZES.length, H = cellH + 300;
  const cv = Buffer.alloc(W * H * 4);
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    const cov = (a / 255);
    cv[i] = Math.round(cv[i] * (1 - cov) + r * cov);
    cv[i + 1] = Math.round(cv[i + 1] * (1 - cov) + g * cov);
    cv[i + 2] = Math.round(cv[i + 2] * (1 - cov) + b * cov);
    cv[i + 3] = Math.max(cv[i + 3], a);
  };
  /* 棋盘格底：浅灰/深灰交替，透明区域一眼可见 */
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = ((x >> 4) + (y >> 4)) % 2 ? 0x2A : 0x1E;
      cv[(y * W + x) * 4] = c; cv[(y * W + x) * 4 + 1] = c; cv[(y * W + x) * 4 + 2] = c; cv[(y * W + x) * 4 + 3] = 255;
    }
  }
  const blit = (rgba, size, ox, oy, scale) => {
    const s = scale || 1;
    for (let y = 0; y < size * s; y++) {
      for (let x = 0; x < size * s; x++) {
        const sx = (x / s) | 0, sy = (y / s) | 0;
        const i = (sy * size + sx) * 4;
        put(ox + x, oy + y, rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]);
      }
    }
  };
  SIZES.forEach((size, i) => {
    const rgba = render(size);
    const ox = i * cellW + Math.round((cellW - size) / 2);
    const oy = Math.round((cellH - size) / 2);
    blit(rgba, size, ox, oy, 1);
  });
  /* 第二行：32px 放大 8×（看小尺寸是否糊）、128px 放大 2× */
  blit(render(32), 32, pad, cellH + 20, 8);
  blit(render(128), 128, 280 + pad, cellH + 20, 2);
  return { buf: encodePng(W, H, cv), W, H };
}

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const entries = SIZES.map(size => {
  const rgba = render(size);
  /* 小尺寸用 BMP（兼容性），大尺寸用 PNG（体积小；Vista+ 支持） */
  return { size, data: size >= 128 ? encodePng(size, size, rgba) : encodeBmp(size, rgba) };
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buildIco(entries));
console.log('OK  ' + OUT);
console.log('    ' + SIZES.join('/') + ' px  ·  ' + (entries.reduce((n, e) => n + e.data.length, 0) / 1024).toFixed(1) + ' KB');

/* 预览图：给人眼看（也便于归档 / 评审）；--no-preview 可跳过 */
if (!process.argv.includes('--no-preview')) {
  const pv = makePreview();
  const PV = OUT.replace(/\.ico$/i, '-preview.png');
  writeFileSync(PV, pv.buf);
  console.log('OK  ' + PV + '  (' + pv.W + '×' + pv.H + '，各档 1:1 + 32px 放大 8×)');
}
