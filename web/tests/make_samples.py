# -*- coding: utf-8 -*-
"""生成导入器测试样本：TXT(UTF-8/GBK) / EPUB / MOBI(无压缩 + PalmDOC压缩 + 尾部标志)"""
import os, struct, zipfile, base64

# 1x1 透明 PNG
PNG_1PX = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'samples')
os.makedirs(OUT, exist_ok=True)

# ---------------- TXT ----------------
txt = ("The morning sun rose over the quiet village.\n"
       "Emma walked along the narrow path.\n"
       "Her mind was full of ambition and a faint trepidation.\n"
       "She remained undaunted, tightening her grip on the icy rock.")
with open(os.path.join(OUT, 'sample-utf8.txt'), 'wb') as f:
    f.write(txt.encode('utf-8'))
with open(os.path.join(OUT, 'sample-gbk.txt'), 'wb') as f:
    f.write("少女踏上旅程，心中充满雄心。\nHer mind was full of ambition.".encode('gbk'))

# ---------------- EPUB ----------------
ch1 = ('<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">'
       '<head><title>c1</title></head><body>'
       '<p>The morning sun rose over the <b>quiet</b> village.</p>'
       '<p>Emma walked along the narrow path, her mind full of <i>ambition</i>.</p>'
       '</body></html>')
ch2 = ('<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">'
       '<head><title>c2</title></head><body>'
       '<h2>Chapter Two</h2>'
       '<p>A strange <i>trepidation</i> crept over her.</p>'
       '<p><img src="images/pic.png" alt="a tiny picture"/></p>'
       '<p>She remained <b>undaunted</b> on the icy rock.</p>'
       '</body></html>')
container = ('<?xml version="1.0"?>'
             '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
             '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
opf = ('<?xml version="1.0"?>'
       '<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">'
       '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
       '<dc:title>Ascent of Emma</dc:title><dc:identifier id="uid">test-1</dc:identifier></metadata>'
       '<manifest>'
       '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>'
       '<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>'
       '</manifest>'
       '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>')
with zipfile.ZipFile(os.path.join(OUT, 'sample.epub'), 'w') as z:
    z.writestr('mimetype', 'application/epub+zip')
    z.writestr('META-INF/container.xml', container)
    z.writestr('OEBPS/content.opf', opf)
    z.writestr('OEBPS/ch1.xhtml', ch1)
    z.writestr('OEBPS/ch2.xhtml', ch2)
    z.writestr('OEBPS/images/pic.png', PNG_1PX)

# ---------------- MOBI ----------------
def palmdoc_compress(data):
    out = bytearray()
    i, n = 0, len(data)
    while i < n:
        best_len, best_dist = 0, 0
        start = max(0, i - 2047)
        for j in range(start, i):
            l = 0
            while l < 10 and i + l < n and data[j + l] == data[i + l]:
                l += 1
            if l > best_len:
                best_len, best_dist = l, i - j
                if best_len == 10:
                    break
        if best_len >= 3:
            val = (best_dist << 3) | (best_len - 3)  # PalmDOC: distance 无 -1（libmobi 一致）
            out.append(0x80 | ((val >> 8) & 0x3F))
            out.append(val & 0xFF)
            i += best_len
        else:
            b = data[i]
            if 0x09 <= b <= 0x7F:
                out.append(b)
                i += 1
            else:  # 0x00-0x08 与 0x80-0xFF → 字面量成组
                lit = bytearray()
                j = i
                while j < n and len(lit) < 8:
                    bb = data[j]
                    if bb <= 0x08 or bb >= 0x80:
                        lit.append(bb)
                        j += 1
                    else:
                        break
                out.append(len(lit))
                out.extend(lit)
                i = j
    return bytes(out)

def build_mobi(path, html, compress, extra_flags, trailing=False, text_enc='utf-8', enc_field=65001):
    raw = html.encode(text_enc)
    payload = palmdoc_compress(raw) if compress else raw
    comp = 2 if compress else 1
    records = [payload[i:i+4096] for i in range(0, len(payload), 4096)] or [b'']
    if trailing:  # 最后一条记录尾部塞 2 字节，配 extra_flags=1 验证裁剪逻辑
        records[-1] = records[-1] + b'\x00\x01'
    fullname = 'Ascent of Emma'
    fn = fullname.encode('utf-8')
    r0 = bytearray(0xF8 + len(fn))
    struct.pack_into('>H', r0, 0, comp)
    struct.pack_into('>I', r0, 4, len(raw))          # textLength = 未压缩长度
    struct.pack_into('>H', r0, 8, len(records))       # 文本记录数
    struct.pack_into('>H', r0, 10, 4096)             # recordSize
    struct.pack_into('>H', r0, 12, 0)                 # encryption = 0
    r0[16:20] = b'MOBI'
    struct.pack_into('>I', r0, 20, 0xE8)             # mobi header 长度
    struct.pack_into('>I', r0, 24, 2)                # mobi type
    struct.pack_into('>I', r0, 28, enc_field)        # 文本编码字段
    struct.pack_into('>I', r0, 32, 12345)
    struct.pack_into('>I', r0, 36, 6)
    struct.pack_into('>I', r0, 84, 0xF8)             # fullNameOffset
    struct.pack_into('>I', r0, 88, len(fn))          # fullNameLength
    struct.pack_into('>H', r0, 0xF2, extra_flags)    # extra data flags
    r0[0xF8:] = fn
    all_recs = [bytes(r0)] + records
    n = len(all_recs)
    head = bytearray(78 + 8 * n + 2)
    head[0:32] = b'TestBook'.ljust(32, b'\x00')
    head[60:64] = b'BOOK'
    head[64:68] = b'MOBI'
    struct.pack_into('>H', head, 76, n)
    pos = 78 + 8 * n + 2
    offsets = []
    for rec in all_recs:
        offsets.append(pos)
        struct.pack_into('>I', head, 78 + 8 * len(offsets) - 8, pos)
        pos += len(rec)
    with open(path, 'wb') as f:
        f.write(bytes(head))
        for rec in all_recs:
            f.write(rec)

html = ('<html><body>'
        '<p>The morning sun rose over the quiet village.</p>'
        '<p>Emma walked along the narrow path, her mind full of ambition.</p>'
        '<p>A strange trepidation crept over her.</p>'
        '<p>She remained undaunted on the icy rock.</p>'
        '</body></html>')
build_mobi(os.path.join(OUT, 'sample-mobi.mobi'), html, compress=False, extra_flags=0)
build_mobi(os.path.join(OUT, 'sample-mobi-c.mobi'), html, compress=True, extra_flags=1, trailing=True)
# 中文 MOBI：GBK 编码 + 编码字段误标为 1252，验证 GB18030 兜底解码
cn_html = ('<html><body>'
           '<h2>第一章</h2>'
           '<p>你好，世界。这是一本中文电子书的测试。</p>'
           '<p>她踏上旅程，心中充满雄心与期待。</p>'
           '</body></html>')
build_mobi(os.path.join(OUT, 'sample-mobi-gbk.mobi'), cn_html, compress=False, extra_flags=0, text_enc='gbk', enc_field=1252)

print('samples written to', OUT)
for fn in sorted(os.listdir(OUT)):
    print(' -', fn, os.path.getsize(os.path.join(OUT, fn)), 'bytes')
