/* 墨读 InkRead — 电子书导入器
   统一返回 { title, author, description, cover, text, blocks, toc }
   - text  ：纯文本（段落 \n\n 分隔），供词频/朗读/兼容
   - blocks：结构化块 [{t:'p',text}|{t:'h',text}|{t:'img',data,alt}]，供渲染（含图片）
   - toc   ：[{title, bi}] bi 指向 blocks 下标，供目录跳转
   - cover ：封面 dataURL（无则为 ''）
   TXT 自动识别 UTF-8/UTF-16/GBK·GB18030；MOBI 自研解析（PalmDOC，UTF-8/CP1252） */
window.IR = window.IR || {};
IR.importers = {};

/* ================= 通用工具 ================= */
IR.importers.sniffMime = b => {
  if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  return null;
};
IR.importers.bytesToDataURL = (bytes, mime) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return 'data:' + mime + ';base64,' + btoa(bin);
};
IR.importers.decodeEntities = s => s
  .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
  .replace(/&ldquo;/g, '\u201C').replace(/&rdquo;/g, '\u201D')
  .replace(/&lsquo;/g, '\u2018').replace(/&rsquo;/g, '\u2019')
  .replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013').replace(/&hellip;/g, '\u2026')
  .replace(/&copy;/g, '\u00A9').replace(/&trade;/g, '\u2122').replace(/&reg;/g, '\u00AE');

/* ================= TXT ================= */
IR.importers.detectEncoding = buf => {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'utf-16be';
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return 'utf-8'; } catch (e) { /* 非法 UTF-8 序列 */ }
  try { new TextDecoder('gb18030', { fatal: true }).decode(buf); return 'gb18030'; } catch (e) { /* 兜底 */ }
  return 'gb18030';
};
IR.importers.importTxt = async file => {
  const buf = new Uint8Array(await file.arrayBuffer());
  const enc = IR.importers.detectEncoding(buf);
  const text = new TextDecoder(enc).decode(buf);
  const lines = text.replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '').split(/\n+/).map(l => l.trim()).filter(Boolean);
  const blocks = lines.map(l => ({ t: 'p', text: l }));
  return { title: file.name.replace(/\.[^.]+$/, ''), author: '', description: '', cover: '', text: lines.join('\n\n'), blocks, toc: IR.importers.buildToc(blocks), encoding: enc };
};

/* ================= HTML → blocks（EPUB/MOBI 共用，图片占位） ================= */
IR.importers.htmlToBlocks = html => {
  let h = html
    .replace(/<\?xml[\s\S]*?\?>/gi, '')           /* XML 声明 */
    .replace(/<head[\s\S]*?<\/head>/gi, '')        /* head（含 title，非正文） */
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const BLOCK = /^(p|div|h[1-6]|li|blockquote|section|article|figure|table|tr|td|th|pre)$/;
  const blocks = [];
  let buf = '';
  const flush = () => { const t = buf.replace(/\s+/g, ' ').trim(); if (t) blocks.push({ t: 'p', text: t }); buf = ''; };
  const doc = typeof DOMParser !== 'undefined' ? new DOMParser().parseFromString(h, 'text/html') : null;
  const root = doc ? (doc.body || doc.documentElement) : null;
  if (root) {
    const walk = el => {
      for (const node of el.childNodes) {
        if (node.nodeType === 3) { buf += node.nodeValue; continue; }
        if (node.nodeType !== 1) continue;
        const tag = node.tagName.toLowerCase();
        if (tag === 'img') {
          flush();
          blocks.push({ t: 'img', src: node.getAttribute('src') || '', recindex: node.getAttribute('recindex') || '', alt: node.getAttribute('alt') || '' });
        } else if (tag === 'br') {
          buf += '\n';
        } else if (/^h[1-6]$/.test(tag)) {
          flush();
          const txt = node.textContent.replace(/\s+/g, ' ').trim();
          if (txt) blocks.push({ t: 'h', text: txt });
        } else if (BLOCK.test(tag)) {
          flush();
          walk(node);
          flush();
        } else {
          buf += node.textContent;  /* 内联标签 */
        }
      }
    };
    walk(root);
  } else {
    /* 正则退化（Node 测试环境无 DOMParser）：图片先替换成占位符，保持与正文的相对位置 */
    const imgMarkers = [];
    h = h.replace(/<img\b[^>]*>/gi, m => {
      const srcM = m.match(/src="([^"]*)"/i);
      const recM = m.match(/recindex="([^"]*)"/i);
      const mk = '\u0000IMG' + imgMarkers.length + '\u0000';
      imgMarkers.push({ t: 'img', src: srcM ? srcM[1] : '', recindex: recM ? recM[1] : '', alt: '' });
      return mk;
    });
    h = h.replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article|pre)>/gi, '\n');
    for (const raw of h.split('\n')) {
      const segs = raw.split(/\u0000IMG(\d+)\u0000/);
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i];
        if (i % 2 === 1) { const m = imgMarkers[+seg]; if (m) blocks.push(m); continue; }
        const hm = seg.match(/<h([1-6])\b[^>]*>/i);
        const txt = IR.importers.decodeEntities(seg.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        blocks.push(hm ? { t: 'h', text: txt } : { t: 'p', text: txt });
      }
    }
  }
  return blocks;
};
/* 目录：标题块 + Chapter/第X章 模式 */
IR.importers.buildToc = blocks => {
  const toc = [];
  blocks.forEach((b, bi) => {
    if (b.t === 'h') { toc.push({ title: b.text.slice(0, 60), bi }); return; }
    if (b.t === 'p' && /^(Chapter|CHAPTER|Part|PART|PROLOGUE|EPILOGUE)\b|^(第[0-9一二三四五六七八九十百]+[章节卷部篇])/.test(b.text) && b.text.length < 80) {
      toc.push({ title: b.text.slice(0, 60), bi });
    }
  });
  return toc;
};

/* ================= EPUB ================= */
IR.importers.importEpub = async file => {
  const JSZipRef = typeof JSZip !== 'undefined' ? JSZip : (typeof window !== 'undefined' ? window.JSZip : null);
  if (!JSZipRef) throw new Error('EPUB 解析组件（JSZip）未加载');
  const zip = await JSZipRef.loadAsync(await file.arrayBuffer());
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('这不是标准的 EPUB 文件（缺少 container.xml）');
  const container = await containerFile.async('string');
  const m = container.match(/full-path="([^"]+)"/);
  if (!m) throw new Error('EPUB 结构异常：找不到 OPF 描述文件');
  const opfPath = m[1];
  const findInZip = path => {
    let f = zip.file(path);
    if (f) return f;
    try { const dec = decodeURIComponent(path); f = zip.file(dec); if (f) return f; } catch (e) { /* 忽略 */ }
    const low = path.toLowerCase();
    const keys = Object.keys(zip.files);
    const hit = keys.find(k => k.toLowerCase() === low) || keys.find(k => k.toLowerCase().endsWith('/' + low));
    return hit ? zip.file(hit) : null;
  };
  const opfFile = findInZip(opfPath);
  if (!opfFile) throw new Error('EPUB 结构异常：无法读取 ' + opfPath);
  const opf = await opfFile.async('string');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = {};
  for (const mm of opf.matchAll(/<item\b[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*>/g)) manifest[mm[1]] = mm[2];
  for (const mm of opf.matchAll(/<item\b[^>]*href="([^"]+)"[^>]*id="([^"]+)"[^>]*>/g)) manifest[mm[2]] = mm[1];
  const order = [];
  for (const sm of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)) order.push(sm[1]);
  const pick = re => { const mm = opf.match(re); return mm ? mm[1].trim() : ''; };
  const title = pick(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || file.name.replace(/\.[^.]+$/, '');
  const author = pick(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
  const description = pick(/<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i);
  /* 封面：多路兜底 —— meta name=cover / properties="cover-image" / guide reference */
  const coverSrc = async href => {
    if (!href) return '';
    try {
      const cf = findInZip(base + href);
      if (!cf) return '';
      const bytes = new Uint8Array(await cf.async('arraybuffer'));
      const mime = IR.importers.sniffMime(bytes);
      return (mime && bytes.length < 2 * 1024 * 1024) ? IR.importers.bytesToDataURL(bytes, mime) : '';
    } catch (e) { return ''; }
  };
  let cover = '';
  let coverHref = '';
  const coverMeta = opf.match(/<meta\b[^>]*name="cover"[^>]*content="([^"]+)"/i) || opf.match(/<meta\b[^>]*content="([^"]+)"[^>]*name="cover"/i);
  if (coverMeta) coverHref = manifest[coverMeta[1]] || '';
  if (!coverHref) {
    const cm = opf.match(/<item\b[^>]*properties="cover-image"[^>]*href="([^"]+)"/i) || opf.match(/<item\b[^>]*href="([^"]+)"[^>]*properties="cover-image"/i);
    if (cm) coverHref = cm[1];
  }
  cover = await coverSrc(coverHref);
  if (!cover) {
    const gm = opf.match(/<reference\b[^>]*type="cover"[^>]*href="([^"]+)"/i);
    if (gm) {
      try {
        const cf = findInZip(base + gm[1]);
        if (cf) {
          const coverHtml = await cf.async('string');
          const im = coverHtml.match(/<img\b[^>]*src="([^"]+)"/i);
          if (im) cover = await coverSrc(im[1]);
        }
      } catch (e) { /* 忽略封面页解析失败 */ }
    }
  }
  /* 正文 blocks */
  const blocks = [];
  for (const idref of order) {
    const href = manifest[idref];
    if (!href) continue;
    const f = findInZip(base + href);
    if (!f) continue;
    const raw = await f.async('string');
    blocks.push(...IR.importers.htmlToBlocks(raw));
  }
  /* 解析图片 src → dataURL */
  for (const b of blocks) {
    if (b.t === 'img' && b.src) {
      try {
        const imgF = findInZip(base + b.src);
        if (imgF) {
          const bytes = new Uint8Array(await imgF.async('arraybuffer'));
          const mime = IR.importers.sniffMime(bytes);
          if (mime && bytes.length < 4 * 1024 * 1024) { b.data = IR.importers.bytesToDataURL(bytes, mime); delete b.src; continue; }
        }
      } catch (e) { /* 忽略单张图片失败 */ }
    }
    delete b.src; delete b.recindex;
  }
  const text = blocks.filter(b => b.t !== 'img').map(b => b.text).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('EPUB 内容为空或全部为图片');
  return { title, author, description, cover, text, blocks, toc: IR.importers.buildToc(blocks) };
};

/* ================= PDF ================= */
IR.importers.importPdf = async file => {
  const lib = typeof pdfjsLib !== 'undefined' ? pdfjsLib : (typeof window !== 'undefined' ? window.pdfjsLib : null);
  if (!lib) throw new Error('PDF 解析组件（pdf.js）未加载');
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await lib.getDocument({ data }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const lines = [];
    let line = '';
    for (const item of tc.items) {
      line += item.str;
      if (item.hasEOL) { lines.push(line); line = ''; }
    }
    if (line) lines.push(line);
    pages.push(lines.map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'));
    page.cleanup && page.cleanup();
  }
  const text = pages.filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!/[A-Za-z]{2,}/.test(text)) {
    throw new Error('该 PDF 没有可提取的文本层（可能是扫描图片版），暂不支持，请换文本版 PDF 或 EPUB');
  }
  const blocks = text.split(/\n{2,}/).filter(p => p.trim()).map(p => ({ t: 'p', text: p }));
  return { title: file.name.replace(/\.[^.]+$/, ''), author: '', description: '', cover: '', text, blocks, toc: IR.importers.buildToc(blocks) };
};

/* ================= MOBI ================= */
/* 读【backward-encoded】Mobipocket 变宽整数（从 data[end-1] 往前读）：
   big-endian、每字节低 7 位是数据、只有 MSB（最高位字节）的 bit8 置位。
   例：0x11111 的 backward 编码为 0x84 0x22 0x11（末尾 0x11 是 LSB，最前 0x84 是 MSB）。 */
IR.importers._varintFromEnd = (data, end) => {
  let num = 0;
  let shift = 0;
  for (let i = end - 1; i >= 0; i--) {
    const b = data[i];
    num |= (b & 0x7F) << shift;
    if (b & 0x80) break;   /* 遇到 MSB（bit8 置位）即停止 */
    shift += 7;
  }
  return num;
};
/* 裁剪文本记录末尾的 trailing entries（这些字节【不参与压缩】，必须在解压前剔除）。
   Extra Data Flags 各位：bit0=多字节字符重叠，bit1..=索引等（bit 越大越靠记录末尾）。
   处理顺序（从末尾往前）：先处理高 bit 的 trailing entry（backward varint 存 size），
   最后处理 bit0 的多字节重叠（末尾字节 bits1-3 存重叠字节数 N，共 N+1 字节）。 */
IR.importers._trimTrailing = (data, extraFlags) => {
  let end = data.length;
  for (let bit = 15; bit >= 1; bit--) {
    if (extraFlags & (1 << bit)) {
      const size = IR.importers._varintFromEnd(data, end);
      if (size > 0 && size <= end) end -= size;
    }
  }
  if (extraFlags & 1) {
    const b = data[end - 1];
    const N = b & 0x07;   /* bits1-3 编码重叠字节数（0-3） */
    end -= N + 1;
  }
  return end > 0 ? data.subarray(0, end) : data.subarray(0, 0);
};
IR.importers._palmDocDecompress = d => {
  const out = [];
  let i = 0;
  while (i < d.length) {
    const c = d[i++];
    if (c === 0) { out.push(0); }
    else if (c <= 8) { for (let j = 0; j < c; j++) out.push(d[i++]); }
    else if (c <= 0x7F) { out.push(c); }
    else if (c <= 0xBF) {
      /* 回溯对：11 位 distance + 3 位 length，distance【无 +1】（libmobi/KindleUnpack 一致） */
      const next = d[i++];
      const dist = (((c << 8) | next) >> 3) & 0x7FF;
      const len = (next & 0x7) + 3;
      for (let j = 0; j < len; j++) out.push(out[out.length - dist]);
    } else { out.push(32); out.push(c ^ 0x80); }
  }
  return Uint8Array.from(out);
};
/* 在记录前 64 字节内定位图片签名（部分 MOBI 图片记录前有头部） */
IR.importers._extractImage = recBytes => {
  const sigs = [
    { bytes: [0xFF, 0xD8], mime: 'image/jpeg' },
    { bytes: [0x89, 0x50, 0x4E, 0x47], mime: 'image/png' },
    { bytes: [0x47, 0x49, 0x46], mime: 'image/gif' }
  ];
  for (const s of sigs) {
    const limit = Math.min(64, recBytes.length - s.bytes.length);
    for (let i = 0; i <= limit; i++) {
      if (s.bytes.every((b, k) => b === recBytes[i + k])) return { mime: s.mime, offset: i };
    }
  }
  return null;
};

/* 入口包装：任何解析失败都把「文件信息 + MOBI 头部参数」附加到错误里，
   便于直接把报错内容发回来定位（不用猜） */
IR.importers.importMobi = async file => {
  const buf = new Uint8Array(await file.arrayBuffer());
  const facts = () => {
    try {
      const u16 = o => (buf[o] << 8) | buf[o + 1];
      const u32 = o => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
      const numRec = u16(76);
      const r0 = buf.subarray(u32(78), numRec > 1 ? u32(86) : buf.length);
      const ru16 = o => (r0[o] << 8) | r0[o + 1];
      const ru32 = o => ((r0[o] << 24) | (r0[o + 1] << 16) | (r0[o + 2] << 8) | r0[o + 3]) >>> 0;
      return '〔自检：' + (buf.length / 1048576).toFixed(2) + 'MB · PDB ' +
        String.fromCharCode(...buf.subarray(60, 68)).trim() + ' · 记录 ' + numRec +
        ' · 头部长度 ' + r0.length + ' · 压缩 ' + ru16(0) + ' · 加密 ' + ru16(12) +
        ' · 文本长度 ' + ru32(4) + ' · 文本记录 ' + ru16(8) + ' · MOBI 版本 ' + ru32(36) + '〕';
    } catch (e) { return ''; }
  };
  try {
    return await IR.importers._mobiParse(file, buf);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (msg.indexOf('〔自检') >= 0) throw e;
    throw new Error(msg + ' ' + facts());
  }
};

IR.importers._mobiParse = async (file, buf) => {
  const u16 = o => (buf[o] << 8) | buf[o + 1];
  const u32 = o => ((buf[o] << 24) | (buf[o+1] << 16) | (buf[o+2] << 8) | buf[o+3]) >>> 0;
  if (buf.length < 88) throw new Error('文件太小，不是有效的 MOBI 电子书');
  const type = String.fromCharCode(...buf.subarray(60, 68));
  if (type !== 'BOOKMOBI') throw new Error('这不是 MOBI/Kindle 格式（PDB 类型 ' + type.trim() + '）');
  const numRecords = u16(76);
  const offsets = [];
  for (let i = 0; i < numRecords; i++) offsets.push(u32(78 + i * 8));
  const rec = i => buf.subarray(offsets[i], i + 1 < numRecords ? offsets[i + 1] : buf.length);
  const r0 = rec(0);
  const ru16 = o => (r0[o] << 8) | r0[o + 1];
  const ru32 = o => ((r0[o] << 24) | (r0[o+1] << 16) | (r0[o+2] << 8) | r0[o+3]) >>> 0;
  const compression = ru16(0);
  const textLength = ru32(4);
  const textRecordCount = ru16(8);
  const encryption = ru16(12);
  if (encryption !== 0) throw new Error('该电子书受 DRM 版权保护，无法导入（请用你购买渠道授权的方式获取无 DRM 版本）');
  if (compression !== 1 && compression !== 2) {
    if (compression === 17480 || compression === 17472 || compression === 17456) {
      throw new Error('这是 AZW3/KF8 格式（Kindle 新版专有压缩 HUFF/CDIC），当前版本暂不支持。建议：用免费的 Calibre 软件转成 EPUB 后导入（约 30 秒），或告诉我，我加 KF8 支持');
    }
    throw new Error('不支持的 MOBI 压缩类型 ' + compression + '（可能是 AZW3/KF8 或异常文件）。建议用 Calibre 转成 EPUB 后导入');
  }
  if (r0.length < 24 || String.fromCharCode(...r0.subarray(16, 20)) !== 'MOBI') throw new Error('MOBI 头部异常，无法解析');
  const mobiLen = ru32(20);
  const encoding = ru32(28);  /* 1252 或 65001 */
  /* 图片起始：firstNonBook(0x50)/firstImage(0x6C)，字段存在才读 */
  const firstNonBook = (mobiLen >= 0x54 && r0.length > 84) ? ru32(80) : 0;
  const firstImage = (mobiLen >= 0x70 && r0.length > 112) ? ru32(108) : 0;
  const imageStart = firstNonBook || firstImage || 0;
  /* 文本记录数：PalmDOC header 的 recordCount（offset 8）优先；异常时兜底 */
  let textRecs = textRecordCount || (imageStart > 0 ? imageStart - 1 : 0);
  if (textRecs <= 0 || textRecs >= numRecords) {
    textRecs = (imageStart > 0 && imageStart < numRecords) ? imageStart - 1 : numRecords - 1;
  }
  /* 标题 / EXTH 元数据 */
  let title = file.name.replace(/\.[^.]+$/, ''), author = '', description = '', cover = '';
  const decTitle = buf => {
    try { return new TextDecoder('utf-8').decode(buf).trim(); } catch (e) { return ''; }
  };
  if (mobiLen >= 0x4C) {
    const fnOff = ru32(84), fnLen = ru32(88);
    if (fnOff > 0 && fnLen > 0 && offsets[0] + fnOff + fnLen <= buf.length) {
      title = decTitle(buf.subarray(offsets[0] + fnOff, offsets[0] + fnOff + fnLen)) || title;
    }
  }
  const exthFlags = r0.length > 132 ? ru32(128) : 0;  /* 相对 record0 绝对 0x80 */
  let coverOffset = 0, thumbOffset = 0;
  if (exthFlags & 0x40) {
    const exthStart = 16 + mobiLen;
    if (r0.length > exthStart + 12 && String.fromCharCode(...r0.subarray(exthStart, exthStart + 4)) === 'EXTH') {
      const count = ru32(exthStart + 8);
      let p = exthStart + 12;
      for (let i = 0; i < count && p + 8 <= r0.length; i++) {
        const t = ru32(p), len = ru32(p + 4);
        const d = r0.subarray(p + 8, p + len);
        if (t === 100) author = decTitle(d);
        if (t === 103) description = decTitle(d);
        if (t === 201) coverOffset = ru32(p + 8);
        if (t === 202) thumbOffset = ru32(p + 8);
        p += len;
      }
    }
  }
  /* extra data flags：record0 绝对偏移 0xF2（242），仅当 header 长度 >= 0xE4 */
  let extraFlags = 0;
  if (mobiLen >= 0xE4 && r0.length > 0xF4) extraFlags = ru16(0xF2);
  /* 逐条解出文本记录。
     trailing entries（bit0 多字节重叠 + bit1..索引）附加在【压缩数据之后】、不参与压缩，
     必须先裁剪掉末尾的 trailing 字节，再对剩余部分解压（与 libmobi 的
     record_size = curr->size - extra_size 一致）。 */
  const chunks = [];
  let total = 0;
  for (let i = 1; i <= textRecs && i < numRecords; i++) {
    let d = rec(i);
    d = IR.importers._trimTrailing(d, extraFlags);
    const dec = compression === 1 ? d : IR.importers._palmDocDecompress(d);
    chunks.push(dec);
    total += dec.length;
  }
  const raw = new Uint8Array(Math.min(total, Math.max(textLength, 0) || total));
  { let p = 0;
    for (const c of chunks) {
      const n = Math.min(c.length, raw.length - p);
      raw.set(c.subarray(0, n), p);
      p += n;
      if (p >= raw.length) break;
    }
  }
  let html;
  if (encoding === 65001) {
    html = new TextDecoder('utf-8').decode(raw);
  } else {
    /* 声明 1252，但实际可能是 UTF-8 或 GBK 中文：
       1) 严格 UTF-8 成功 → UTF-8；2) 否则 GB18030 解码后中文占比高 → 中文书；
       3) 否则 CP1252（西文）。GB18030 首字节 0x81-0xFE，西文 CP1252 的 0x80-0x9F 非法会自动失败。 */
    try { html = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
    catch (e) {
      try {
        const gb = new TextDecoder('gb18030', { fatal: true }).decode(raw);
        const cn = (gb.match(/[\u4e00-\u9fff]/g) || []).length;
        if (gb && cn / Math.max(1, gb.length) > 0.12) html = gb;
        else html = new TextDecoder('windows-1252').decode(raw);
      } catch (e2) { html = new TextDecoder('windows-1252').decode(raw); }
    }
  }
  const blocks = IR.importers.htmlToBlocks(html);
  /* 解析图片 recindex → dataURL（recindex 是相对 firstImage 记录的偏移） */
  for (const b of blocks) {
    if (b.t === 'img' && b.recindex) {
      const ri = parseInt(b.recindex, 10);
      const actualIdx = imageStart > 0 ? imageStart + ri : ri;
      if (!isNaN(ri) && actualIdx > 0 && actualIdx < numRecords) {
        const img = IR.importers._extractImage(rec(actualIdx));
        if (img) {
          const bytes = rec(actualIdx).subarray(img.offset);
          if (bytes.length < 4 * 1024 * 1024) b.data = IR.importers.bytesToDataURL(bytes, img.mime);
        }
      }
    }
    delete b.src; delete b.recindex;
  }
  /* 封面：EXTH cover/thumbnail 偏移，或首个图片记录 */
  if (!cover && imageStart > 0 && imageStart < numRecords) {
    const off = coverOffset > 0 ? coverOffset : thumbOffset;
    const idx = off > 0 ? imageStart + Math.floor(off / 4096) : imageStart;
    if (idx < numRecords) {
      const img = IR.importers._extractImage(rec(idx));
      if (img) cover = IR.importers.bytesToDataURL(rec(idx).subarray(img.offset), img.mime);
    }
  }
  const text = blocks.filter(b => b.t !== 'img').map(b => b.text).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) {
    const diag = { compression, encoding, textRecordCount, firstNonBook, firstImage, imageStart, textRecs, numRecords, mobiLen, extraFlags, exthFlags, total, textLength };
    throw new Error('MOBI 文本内容为空（诊断：' + JSON.stringify(diag) + '）');
  }
  return { title, author, description, cover, text, blocks, toc: IR.importers.buildToc(blocks) };
};

/* ================= 统一入口 ================= */
IR.importers.byExtension = ext => {
  ext = ext.toLowerCase();
  if (ext === '.txt' || ext === '.text') return IR.importers.importTxt;
  if (ext === '.epub') return IR.importers.importEpub;
  if (ext === '.pdf') return IR.importers.importPdf;
  if (ext === '.mobi' || ext === '.azw' || ext === '.azw3' || ext === '.prc') return IR.importers.importMobi;
  if (ext === '.html' || ext === '.htm') return async file => {
    const html = await file.text();
    const blocks = IR.importers.htmlToBlocks(html);
    return { title: file.name.replace(/\.[^.]+$/, ''), author: '', description: '', cover: '', text: blocks.filter(b => b.t !== 'img').map(b => b.text).join('\n\n'), blocks, toc: IR.importers.buildToc(blocks) };
  };
  return null;
};
IR.importers.importBookFile = async file => {
  const ext = '.' + (file.name.split('.').pop() || '');
  const fn = IR.importers.byExtension(ext);
  if (!fn) throw new Error('暂不支持 ' + ext + ' 格式，支持 TXT / EPUB / MOBI / PDF');
  try {
    return await fn(file);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (msg.indexOf('〔自检') >= 0 || msg.indexOf('[' + file.name) >= 0) throw e;
    /* 附上文件名/大小/格式，便于定位是哪个文件出的问题 */
    throw new Error(msg + ' 〔文件 ' + file.name + ' · ' + Math.round(file.size / 1024) + 'KB · ' + ext + '〕');
  }
};

/* ================= 词表解析（词库导入用） ================= */
IR.importers.parseVocabLines = text => {
  const out = [];
  for (let line of text.replace(/\r\n?/g, '\n').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const m = line.match(/^([A-Za-z][A-Za-z'’\-]*)\s*(?:[,;，；\t]\s*|\s{1,})(.*)$/);
    if (m) out.push({ word: m[1].toLowerCase(), display: m[1], meaning: (m[2] || '').trim() });
    else if (/^[A-Za-z][A-Za-z'’\-]*$/.test(line)) out.push({ word: line.toLowerCase(), display: line, meaning: '' });
  }
  return out;
};
