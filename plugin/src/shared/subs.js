/* InkRead Video — 站点识别与字幕解析（纯函数，可在 Node 下单测） */

/* ---------- 站点识别 ---------- */
export function detectSite(href) {
  let u;
  try { u = new URL(href); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  if (/(^|\.)youtube\.com$/.test(host) || host === 'youtu.be') {
    let id = '';
    if (host === 'youtu.be') id = path.replace(/^\//, '').split('/')[0];
    else if (path === '/watch') id = u.searchParams.get('v') || '';
    else {
      const m = path.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/);
      if (m) id = m[2];
    }
    if (!/^[\w-]{6,}$/.test(id)) return null;
    return { site: 'youtube', id, key: 'yt:' + id, label: 'YouTube' };
  }

  if (/(^|\.)bilibili\.com$/.test(host)) {
    let m = path.match(/^\/video\/(BV[\w]+|av\d+)/i);
    if (m) return { site: 'bilibili', id: m[1], key: 'bl:' + m[1].toLowerCase(), label: '哔哩哔哩', kind: 'video' };
    m = path.match(/^\/bangumi\/play\/(ep\d+|ss\d+)/i);
    if (m) return { site: 'bilibili', id: m[1], key: 'bl:' + m[1].toLowerCase(), label: '哔哩哔哩', kind: 'bangumi' };
    return null;
  }

  return null;
}

/* ---------- YouTube ---------- */
/**
 * 给 timedtext baseUrl 强制 `fmt=json3`（已有别的 fmt 值就覆盖，不是只补缺失）。
 * json3 是 YouTube 目前最稳定、也最好解析的格式。
 */
export function ytJson3Url(baseUrl) {
  if (!baseUrl) return '';
  let u = String(baseUrl);
  if (/[?&]fmt=[^&]*/.test(u)) u = u.replace(/([?&])fmt=[^&]*/, '$1fmt=json3');
  else u += (u.includes('?') ? '&' : '?') + 'fmt=json3';
  return u;
}

/**
 * 去掉 PoToken 标记参数（`exp=xpe` / `potc` / `pot`），得到「干净 URL」再试一次。
 *
 * ⚠️ 真根因（2024–2025 起，实测确认）：
 * YouTube 对 `/api/timedtext` 强制要求 `pot`（Proof-of-Origin Token，来源证明令牌）。
 * **缺 token 时不报错，而是返回 HTTP 200 + 空 body** —— 于是上层静默退化成
 * 「只读标题/简介」。页面初始 `ytInitialPlayerResponse` 里的 baseUrl 常带
 * `exp=xpe`/`potc=1` 标记（说明它会走 PoToken 校验），直接请求必空。
 * 能拿到内容的可靠来源是**活动播放器实例已签名的 URL**（`movie_player.getAudioTrack()`）。
 * 把带标记的 URL 去掉这些参数后，一部分视频仍可直接取到字幕，故留作兜底候选。
 */
export function stripPot(url) {
  if (!url) return '';
  let u = String(url).replace(/([?&])(?:exp|potc|pot)=[^&]*/g, '$1');
  u = u.replace(/&&+/g, '&').replace(/\?&/g, '?').replace(/[?&]+$/, '');
  return u;
}

/** 把可能相对的 timedtext URL 归一化成绝对地址（播放器实例偶尔给 `/api/timedtext?...`） */
export function absYtUrl(u) {
  const s = String(u || '');
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('http')) return s;
  if (s.startsWith('/')) return 'https://www.youtube.com' + s;
  return s;
}

/**
 * 生成 YouTube 字幕 URL 候选（按「最可能成功」排序、去重）。
 * 上层逐个尝试，任一拿到非空内容即返回。
 */
export function ytCaptionUrls(baseUrl) {
  const base = absYtUrl(baseUrl);
  const out = [];
  const push = u => { if (u && !out.includes(u)) out.push(u); };
  push(ytJson3Url(base));            /* ① json3（首选） */
  push(stripPot(ytJson3Url(base)));  /* ② json3 + 去 PoToken 标记 */
  push(base);                        /* ③ 原样（srv3 / srv1 XML） */
  push(stripPot(base));              /* ④ 原样 + 去 PoToken 标记 */
  return out;
}

/** 在 captionTracks 里挑最合适的轨（优先英语、优选人工字幕） */
export function pickYoutubeTrack(tracks, preferEn = true) {
  const list = (tracks || []).filter(t => t && t.baseUrl);
  if (!list.length) return null;
  const score = t => {
    const lang = String(t.languageCode || t.langCode || '').toLowerCase();
    const vss = String(t.vssId || '').toLowerCase();
    let s = 0;
    if (lang.startsWith('en') || vss.includes('.en')) s += 100;
    else if (!preferEn) s += 10;
    if (t.kind !== 'asr') s += 20;          /* 人工字幕优于自动识别 */
    if (vss && !vss.startsWith('a.')) s += 5;
    return s;
  };
  return list.slice().sort((a, b) => score(b) - score(a))[0];
}

/** json3 → 文本（保留换行做「句」分隔） */
export function parseYoutubeJson3(obj) {
  const events = (obj && obj.events) || [];
  const parts = [];
  for (const ev of events) {
    if (!ev || !ev.segs) continue;
    let line = '';
    for (const s of ev.segs) line += (s && s.utf8) || '';
    line = line.replace(/\n+/g, ' ').trim();
    if (line) parts.push(line);
  }
  return parts.join('\n');
}

/** XML（timedtext 默认格式）→ 文本
 *  两种格式都认：
 *  - 经典 `fmt=srv1`：`<text start=.. dur=..>…</text>`
 *  - `fmt=srv3`：`<p t=.. d=..><s>…</s><s>…</s></p>`
 *  返回按「句/行」用 \n 分隔的纯文本。 */
export function parseYoutubeXml(xml) {
  const s = String(xml || '');
  const parts = [];
  let re = /<text[^>]*>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = re.exec(s))) {
    const t = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  }
  if (parts.length) return parts.join('\n');
  /* srv3：每个 <p> 是一句，内部可能再套 <s>/<br> 分段 */
  re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  while ((m = re.exec(s))) {
    const t = decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (t) parts.push(t);
  }
  return parts.join('\n');
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/* ---------- 哔哩哔哩 ---------- */
export function blAbsUrl(u) {
  const s = String(u || '');
  if (!s) return '';
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('http')) return s;
  return 'https://' + s.replace(/^\/+/, '');
}

/** 在 subtitles 列表里挑最合适的轨 */
export function pickBilibiliTrack(list, preferEn = true) {
  const arr = (list || []).filter(t => t && (t.subtitle_url || t.subtitleUrl));
  if (!arr.length) return null;
  const score = t => {
    const lan = String(t.lan || '').toLowerCase();
    const doc = String(t.lan_doc || '').toLowerCase();
    let s = 0;
    if (lan.startsWith('en') || lan === 'ai-en' || doc.includes('英语') || doc.includes('english')) s += 100;
    else if (!preferEn) s += 10;
    if (!/^ai-/.test(lan)) s += 5;    /* 非 AI 轨优先 */
    return s;
  };
  /* 完全没有英文字幕：标记 _noEnglish，让上层给出「该视频无英文字幕」的明确提示 */
  const anyEn = arr.some(t => score(t) >= 100);
  if (preferEn && !anyEn) return { ...arr[0], _noEnglish: true };
  return arr.slice().sort((a, b) => score(b) - score(a))[0];
}

/** 哔哩哔哩字幕 JSON → 文本 */
export function parseBilibiliSub(obj) {
  const body = (obj && (obj.body || obj.subtitle)) || [];
  const parts = [];
  for (const seg of body) {
    const c = String((seg && (seg.content != null ? seg.content : seg.text)) || '').replace(/\s+/g, ' ').trim();
    if (c) parts.push(c);
  }
  return parts.join('\n');
}

/* ---------- 统一入口：解析任意字幕响应体 ---------- */
/**
 * @param {'youtube'|'bilibili'} site
 * @param {string} bodyText 原始响应文本
 * @returns {string} 字幕纯文本（失败返回 ''）
 */
export function parseSubtitle(site, bodyText) {
  const t = String(bodyText || '').trim();
  if (!t) return '';
  if (site === 'bilibili') {
    if (t[0] === '{' || t[0] === '[') {
      try { return parseBilibiliSub(JSON.parse(t)); } catch (e) { /* 落到 XML */ }
    }
    return '';
  }
  /* YouTube：先按 json3 解析；空结果再退到 XML（srv1/srv3），双向兜底 */
  if (t[0] === '{' || t[0] === '[') {
    try {
      const txt = parseYoutubeJson3(JSON.parse(t));
      if (txt) return txt;
    } catch (e) { /* 落到 XML */ }
  }
  return parseYoutubeXml(t);
}

/** 文本粗画像（用于「样本是否足够」判断与 UI 展示） */
export function textSample(text) {
  const s = String(text || '');
  return { chars: s.length, lines: s ? s.split('\n').length : 0 };
}
