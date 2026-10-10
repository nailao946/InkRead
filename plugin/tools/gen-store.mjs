#!/usr/bin/env node
/* gen-store.mjs —— 生成浏览器扩展商店所需的品牌图（零依赖，复用 gen-icons 的 PNG 编码思路）
 *
 * 产出（plugin/store/）：
 *   logo-300.png        300×300   Edge 商店徽标（图标放大版）
 *   promo-440x280.png   440×280   Edge 小宣传图 / Chrome 小图
 *   marquee-1400x560.png 1400×560 Chrome 精选横幅 / Edge 大宣传图
 *
 *   node plugin/tools/gen-store.mjs
 *
 * 说明：宣传图是**无文字的抽象品牌图**（深墨底 + 金色图标 + 词性色块 / 难度条），
 * 足以过审且不会被字体版权卡住；需要带营销文案的版本，改 store/preview.html 后截图即可。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'store');
const SS = 3;   // 超采样倍数（宣传图面积大，3× 已足够平滑）

/* ---------- PNG 编码（与 gen-icons.mjs 同款） ---------- */
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
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------- 几何 / 颜色工具 ---------- */
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
const clamp01 = v => Math.min(1, Math.max(0, v));

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

/* ---------- 品牌色 ---------- */
const GOLD_A = [247, 201, 72];    // #f7c948
const GOLD_B = [194, 65, 12];     // #c2410c
const INK = [26, 20, 7];          // #1a1407
const BG_TOP = [18, 20, 26];      // #12141a
const BG_BOT = [27, 31, 39];      // #1b1f27
/* 词性状态色（与扩展面板里的生词/在学/已学一致） */
const C_NEW = [214, 69, 69], C_LEARN = [59, 130, 246], C_KNOWN = [46, 158, 107], C_WARN = [217, 138, 25];

/* ============ 图标本身（坐标归一化，来自 gen-icons.mjs） ============ */
function iconShade(x, y) {
  if (!inRoundRect(x, y, 0.045, 0.045, 0.955, 0.955, 0.22)) return [0, 0, 0, 0];
  const t = clamp01(x * 0.55 + y * 0.75);
  let col = mix(GOLD_A, GOLD_B, t);
  const hl = Math.max(0, 1 - Math.hypot(x - 0.2, y - 0.16) / 0.55);
  col = mix(col, [255, 236, 170], hl * 0.35);
  const A = 255;
  if (inTriangle(x, y, 0.40, 0.30, 0.40, 0.66, 0.71, 0.48)) return [...mix(INK, col, 0.04), A];
  if (inRoundRect(x, y, 0.27, 0.745, 0.73, 0.825, 0.04)) return [...mix(INK, col, 0.04), A];
  return [...col, A];
}

/* ============ 宣传图配色（深墨底 + 金色光晕 + 装饰件） ============ */
/**
 * 采样一个宣传图坐标（**像素**）→ [r,g,b,a]
 * 布局：左侧品牌图标；右侧「面板」示意（标题条 + 可理解度环 + 指标格 + 难度条 + 生词词块）。
 */
function promoShade(px, py, W, H, L) {
  /* ---- 背景：纵向渐变 + 左上金色光晕 + 斜向微高光 ---- */
  const nx = px / W, ny = py / H;
  let col = mix(BG_TOP, BG_BOT, clamp01(ny * 1.1));
  const glow = Math.max(0, 1 - Math.hypot(nx - 0.16, ny - 0.28) / 0.62);
  col = mix(col, [120, 84, 22], glow * 0.30);
  const sheen = Math.max(0, 1 - Math.abs((nx * 0.7 + ny) - 0.85) / 0.045);
  col = mix(col, [255, 226, 150], sheen * 0.05);

  /* ---- 品牌图标（左侧方块） ---- */
  const S = L.icon, ix0 = L.iconX, iy0 = (H - S) / 2;
  if (px >= ix0 && px < ix0 + S && py >= iy0 && py < iy0 + S) {
    const c = iconShade((px - ix0) / S, (py - iy0) / S);
    if (c[3] > 0) return c;
  }

  /* ---- 右侧「分析面板」示意 ---- */
  const qx0 = L.panelX, qx1 = L.panelX + L.panelW;
  const qy0 = H * 0.18, qy1 = H * 0.82, qh = qy1 - qy0;
  if (!inRoundRect(px, py, qx0, qy0, qx1, qy1, qh * 0.10)) return [...col, 255];
  /* 面板底：深色卡 + 1px 描边 */
  let panel = mix([24, 27, 34], [45, 52, 66], (py - qy0) / qh * 0.6);
  if (!inRoundRect(px, py, qx0 + 1.5, qy0 + 1.5, qx1 - 1.5, qy1 - 1.5, qh * 0.10)) return [...mix(panel, [255, 255, 255], 0.10), 255];

  const pad = L.panelW * 0.065;
  const rx0 = qx0 + pad, rx1 = qx1 - pad, rw = rx1 - rx0;
  const R = (a, b) => px >= a && px <= b;
  const Y = (a, b) => py >= qy0 + qh * a && py <= qy0 + qh * b;

  /* 标题条 + 副标题条 */
  if (Y(0.09, 0.135) && R(rx0, rx0 + rw * 0.62)) return [208, 214, 224, 255];
  if (Y(0.155, 0.185) && R(rx0, rx0 + rw * 0.38)) return [122, 130, 144, 255];

  /* 可理解度环（左）—— 与指标格同一行 */
  const cxc = rx0 + rw * 0.13, cyc = qy0 + qh * 0.43;
  const ringR = qh * 0.15, th = qh * 0.035;
  const rr = Math.hypot(px - cxc, py - cyc);
  if (rr <= ringR && rr >= ringR - th) {
    const ang = Math.atan2(py - cyc, px - cxc);                      /* -π..π */
    const frac = (((ang + Math.PI / 2) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
    return frac < 0.96 ? [...C_KNOWN, 255] : [70, 76, 90, 255];
  }

  /* 指标小格（4 个，环右侧） */
  if (Y(0.34, 0.41)) {
    for (let i = 0; i < 4; i++) {
      const bx = rx0 + rw * 0.32 + i * rw * 0.166;
      if (R(bx, bx + rw * 0.13)) return [46, 52, 64, 255];
    }
  }

  /* 难度条（5 段彩色） */
  if (Y(0.585, 0.645) && R(rx0 + rw * 0.02, rx1 - rw * 0.02)) {
    const span = rw * 0.96, t = (px - (rx0 + rw * 0.02)) / span;
    const seg = [C_KNOWN, [74, 155, 232], C_WARN, [217, 119, 87], [139, 92, 246]];
    return [...seg[Math.min(4, Math.floor(t / 0.2 + 0.5))], 255];
  }

  /* 生词词块（两排 chip，带描边） */
  for (let row = 0; row < 2; row++) {
    const cyy = qy0 + qh * (row === 0 ? 0.685 : 0.795), ch = qh * 0.07;
    const widths = row === 0 ? [0.17, 0.22, 0.14, 0.19] : [0.20, 0.15, 0.23];
    const cols = row === 0 ? [C_NEW, C_LEARN, C_WARN, C_KNOWN] : [C_LEARN, C_NEW, C_KNOWN];
    let cx0 = rx0 + rw * 0.02;
    for (let i = 0; i < widths.length; i++) {
      const w = rw * widths[i], r = ch * 0.30, c = cols[i % cols.length];
      if (inRoundRect(px, py, cx0, cyy, cx0 + w, cyy + ch, r)) {
        const edge = !inRoundRect(px, py, cx0 + 2, cyy + 2, cx0 + w - 2, cyy + ch - 2, Math.max(0.5, r - 1));
        return edge ? [...c, 255] : [...mix([255, 255, 255], c, 0.17), 255];
      }
      cx0 += w + rw * 0.025;
    }
  }

  return [...panel, 255];
}

function renderPromo(W, H, layout) {
  const N = SS;
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const c = promoShade(x + (sx + 0.5) / N, y + (sy + 0.5) / N, W, H, layout);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = N * N, i = (y * W + x) * 4;
      out[i] = Math.round(r / n); out[i + 1] = Math.round(g / n); out[i + 2] = Math.round(b / n); out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* ============ 图标放大版（300 店标） ============ */
function renderIcon(size) {
  const N = 4;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const c = iconShade((x + (sx + 0.5) / N) / size, (y + (sy + 0.5) / N) / size);
          r += c[0]; g += c[1]; b += c[2]; a += c[3];
        }
      }
      const n = N * N, i = (y * size + x) * 4;
      out[i] = Math.round(r / n); out[i + 1] = Math.round(g / n); out[i + 2] = Math.round(b / n); out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* ============ 输出 ============ */
mkdirSync(OUT_DIR, { recursive: true });

function write(name, w, h, rgba) {
  const buf = encodePng(w, h, rgba);
  const p = resolve(OUT_DIR, name);
  writeFileSync(p, buf);
  console.log(`OK  ${name}  ${w}×${h}  ${(buf.length / 1024).toFixed(1)} KB`);
}

write('logo-300.png', 300, 300, renderIcon(300));

/* 440×280：图标靠左、右侧面板示意 */
write('promo-440x280.png', 440, 280, renderPromo(440, 280, {
  icon: 150, iconX: 34, panelX: 210, panelW: 196
}));

/* 1400×560：宽幅精选横幅 */
write('marquee-1400x560.png', 1400, 560, renderPromo(1400, 560, {
  icon: 300, iconX: 120, panelX: 620, panelW: 660
}));

console.log('\n商店品牌图已生成 → plugin/store/');
console.log('提示：截图（1280×800）请按 STORE.md 的「截图清单」在真机上抓。');
