#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
墨读 InkRead — PWA 图标生成器（纯标准库，无需 Pillow）
生成 web/icons/icon-192.png 与 web/icons/icon-512.png

设计：深琥珀主题底色 (#2C2C2A) + 圆形奖章 + 琥珀描边 + 打开的书本图案。
可直接重跑本脚本以重新生成图标（改尺寸/配色见下方常量）。
"""
import os
import struct
import zlib

# ---- 配色（取自 THEMES.md 深琥珀主题）----
BG       = (0x2C, 0x2C, 0x2A)   # --bg
PANEL    = (0x3A, 0x3A, 0x37)   # --bg-panel（奖章内盘）
ACCENT   = (0xFA, 0xC7, 0x75)   # --accent（描边 + 书本）
INK      = (0x2C, 0x2C, 0x2A)   # 书页上的“文字线条”

HERE = os.path.dirname(os.path.abspath(__file__))


def write_png(path, size, pixels):
    """pixels: size*size 的 RGB 元组列表（行优先）"""
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # 每行 filter 类型 0 (None)
        row = pixels[y * size:(y + 1) * size]
        for (r, g, b) in row:
            raw += bytes((r, g, b))
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        crc = zlib.crc32(typ + data) & 0xFFFFFFFF
        return c + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit, color type 2 (RGB)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def make_canvas(size):
    return [BG] * (size * size)


def set_px(px, size, x, y, color):
    if 0 <= x < size and 0 <= y < size:
        px[y * size + x] = color


def fill_rect(px, size, x0, y0, x1, y1, color):
    for y in range(int(y0), int(y1)):
        for x in range(int(x0), int(x1)):
            set_px(px, size, x, y, color)


def fill_circle(px, size, cx, cy, r, color):
    r2 = r * r
    x0, x1 = int(cx - r), int(cx + r) + 1
    y0, y1 = int(cy - r), int(cy + r) + 1
    for y in range(y0, y1):
        for x in range(x0, x1):
            dx, dy = x - cx, y - cy
            if dx * dx + dy * dy <= r2:
                set_px(px, size, x, y, color)


def fill_poly(px, size, pts, color):
    """扫描线填充凸/凹多边形（点序顺时针或逆时针均可）"""
    ys = [p[1] for p in pts]
    ymin, ymax = int(min(ys)), int(max(ys))
    for y in range(ymin, ymax + 1):
        xs = []
        n = len(pts)
        for i in range(n):
            x1, y1 = pts[i]
            x2, y2 = pts[(i + 1) % n]
            if (y1 <= y < y2) or (y2 <= y < y1):
                x = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                xs.append(x)
        xs.sort()
        for i in range(0, len(xs) - 1, 2):
            xa, xb = int(round(xs[i])), int(round(xs[i + 1]))
            for x in range(xa, xb):
                set_px(px, size, x, y, color)


def render(size):
    px = make_canvas(size)
    cx = cy = size / 2.0

    # 1) 奖章外圈（描边色）
    R = size * 0.46
    fill_circle(px, size, cx, cy, R, ACCENT)
    # 2) 内盘（panel）
    t = size * 0.035  # 描边厚度
    fill_circle(px, size, cx, cy, R - t, PANEL)

    # 3) 打开的书本（两页）
    bw = size * 0.27          # 半宽
    ty = cy - size * 0.14     # 书顶
    by = cy + size * 0.14     # 书底
    g = size * 0.012          # 书脊半宽
    dip = size * 0.02         # 外页上扬

    left = [(cx - g, ty), (cx - bw, ty + dip), (cx - bw, by + dip), (cx - g, by)]
    right = [(cx + g, ty), (cx + bw, ty + dip), (cx + bw, by + dip), (cx + g, by)]
    fill_poly(px, size, left, ACCENT)
    fill_poly(px, size, right, ACCENT)

    # 4) 书页上的“文字线条”（深色短线，增加质感）
    line_w = bw * 0.6
    for k in range(3):
        ly = ty + dip + (by - ty) * (0.28 + k * 0.24)
        fill_rect(px, size,
                  cx - bw * 0.92, ly,
                  cx - bw * 0.92 + line_w, ly + size * 0.012, INK)
        fill_rect(px, size,
                  cx + bw * 0.92 - line_w, ly,
                  cx + bw * 0.92, ly + size * 0.012, INK)

    # 5) 书脊高光（中心竖线，panel 色，制造中缝）
    fill_rect(px, size, cx - g, ty, cx + g, by + dip, PANEL)
    return px


def main():
    for size in (192, 512):
        px = render(size)
        out = os.path.join(HERE, "icon-%d.png" % size)
        write_png(out, size, px)
        print("written:", out, "(%dx%d)" % (size, size))


if __name__ == "__main__":
    main()
