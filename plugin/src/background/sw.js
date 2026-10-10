/* InkRead Video — 后台 Service Worker（MV3）
 *
 * 职责：① 视频：识别站点 → 取播放器元数据 → 抓字幕 → 与墨读词库比对 → 产出「词汇画像」→ 缓存 + 角标。
 *       ② 文章：接收内容脚本抽好的正文 → 用同一套内核分析 → 回传报告 + 阅读模式需要的逐词状态。
 *       ③ 查词：代理墨读本地服务的离线词典（/dict/<字母>.json，带 CORS），供阅读模式点词看释义。
 * 所有跨域请求都放在这里做：扩展 Service Worker 带 host_permissions，可绕开页面 CORS。
 */
import { api, url, fetchWithTimeout, onMessage } from '../shared/api.js';
import * as store from '../shared/store.js';
import { analyze, vocabSummary, ratingOf } from '../shared/analyze.js';
import { parseFreq } from '../shared/freq.js';
import { analyzeArticlePage, articleKey, articleStatuses } from '../shared/article.js';
import { mergeWordMarks, setWordMark, clearWordMark, addHighlight, delHighlight, listHighlights, marksSummary, normalizeMarks } from '../shared/marks.js';
import * as vs from '../shared/vocab-source.js';
import * as vc from '../shared/vocab-sync.js';
import * as fsx from '../shared/fssync.js';
import * as tr from '../shared/translate.js';
import { createPhrases, scanPhrases } from '../shared/phrases.js';
import {
  detectSite, pickYoutubeTrack, ytJson3Url, ytCaptionUrls, stripPot, pickBilibiliTrack, blAbsUrl, parseSubtitle, textSample
} from '../shared/subs.js';

const VOCAB_TTL_MS = 30 * 60 * 1000;      /* 词表缓存 30 分钟，避免每次分析都打本地服务 */
const ARTICLE_TTL_MS = 5 * 60 * 1000;     /* 文章报告只在内存里留 5 分钟，不落 storage（状态表太大） */

/* ================= 词组库（2.4 万条离线词组） =================
   数据：data/phrases.json（web_accessible_resource，同时也是扩展自身可 fetch 的内部资源）。
   只在 SW 里解析一次、建索引一次，给所有页面共用；内容脚本通过 phraseScan 拿「字符区间」，
   自己不做匹配 —— 单实现，不会与网页版/插件版漂移。 */
let _phr = null, _phrP = null, _phrErr = '';
function ensurePhrases() {
  if (_phr && _phr.isLoaded()) return Promise.resolve(_phr);
  if (_phrP) return _phrP;
  if (!_phr) _phr = createPhrases();
  _phrP = (async () => {
    try {
      const r = await fetch(url('data/phrases.json'), { cache: 'force-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _phr.load(await r.json());
      _phrErr = '';
    } catch (e) {
      _phrErr = String((e && e.message) || e);
      _phrP = null;                    /* 失败允许下次重试 */
      throw e;
    }
    return _phr;
  })();
  return _phrP;
}

/* ================= 词频表 ================= */
let _freq = null;
async function loadFreq() {
  if (_freq) return _freq;
  try {
    const r = await fetch(url('data/freq-bands.json'));
    _freq = parseFreq(await r.text());
  } catch (e) {
    _freq = { rank: null, count: null, top: 0, meta: null, error: String(e && e.message || e) };
  }
  return _freq;
}

/* ================= 词库联动 ================= */
let _vocab = { map: null, rec: null, link: null, at: 0 };
let _serverBase = '';                     /* 最近一次探测到的本地服务地址（查词复用） */
let _dirName = '';                        /* 已绑定存档目录的名字（展示用） */

/* ---- 直连存档目录（免启动桌面版 / 本地服务） ----
   与桌面版、网页版读的是同一个文件：<存档目录>/vocab.json。
   句柄由设置页选择并持久化在 IndexedDB，后台经离屏文档读写（见 shared/fssync.js）。 */
async function readVocabFromDir() {
  const res = await fsx.dirRead('vocab.json');
  if (!res || !res.ok) return null;
  const arr = vc.parseVocabText(res.text);
  const entries = vs.toEntryPairs(arr);
  const root = _dirName || (await dirNameOf()) || '存档目录';
  return { entries, count: entries.length, root, label: `存档目录 · ${root}` };
}

async function dirNameOf() {
  const st = await fsx.dirStatus();
  if (st && st.ok && st.name) { _dirName = st.name; return st.name; }
  return '';
}

/** 把一批 {word: status} 写回共享 vocab.json（读 → 合并 → 写）。 */
async function pushMarksToDir(changes) {
  const list = Object.keys(changes || {});
  if (!list.length) return { ok: false, skipped: 'empty' };
  const s = await store.getSettings();
  if (s.link.writeBack === false) return { ok: false, skipped: 'writeback-off' };

  const cur = await fsx.dirRead('vocab.json');
  if (!cur || !cur.ok) {
    return { ok: false, error: cur && cur.error === 'no-dir' ? '未绑定存档目录' : ((cur && cur.error) || '读取失败') };
  }
  let arr = [];
  try { arr = vc.parseVocabText(cur.text); } catch (e) { arr = []; }

  const r = vc.upsertEntries(arr, changes, Date.now());
  if (!r.changed) return { ok: true, changed: 0, added: 0, updated: 0 };

  const w = await fsx.dirWrite('vocab.json', vc.stringifyVocab(r.entries));
  if (!w || !w.ok) return { ok: false, error: (w && w.error) || '写入失败' };

  /* 文件变了 → 下次分析重读，保证插件自己看到的状态立刻一致 */
  _vocab = { map: null, rec: null, link: null, at: 0 };
  return { ok: true, changed: r.changed, added: r.added, updated: r.updated };
}

async function ensureVocab(force) {
  const s = await store.getSettings();
  if (_vocab.map && !force && Date.now() - _vocab.at < VOCAB_TTL_MS) return _vocab;

  const mode = s.link.mode;
  let rec = await store.getVocab();
  const link = { source: 'none', label: vs.LINK_SOURCE.none, count: 0, at: 0, ok: false, mode, base: '' };

  if (mode !== 'off') {
    const fresh = rec && (Date.now() - rec.at < VOCAB_TTL_MS);
    if (!fresh || force) {
      /* ① 首选：直连存档目录 —— 不需要启动桌面版，也不占用端口 */
      let done = false;
      if (fsx.dirSupported()) {
        try {
          const got = await readVocabFromDir();
          if (got) {
            rec = await store.setVocab('dir', got.label, got.entries);
            link.source = 'dir';
            link.ok = true;
            done = true;
          }
        } catch (e) {
          link.dirError = '存档目录读取失败：' + (e && e.message || e);
        }
      }

      /* ② 其次：本地服务（桌面版 17890 / 网页版 serve.py 8642） */
      if (!done) {
        const hit = await vs.detectServer({ custom: s.link.serverUrl, ports: s.link.ports, timeoutMs: 1500 });
        if (hit) {
          _serverBase = hit.base;
          link.base = hit.base;
          try {
            const got = await vs.readVocabFromServer(hit.base, 3000);
            rec = await store.setVocab('local', got.label, got.entries);
            link.ok = true;
          } catch (e) {
            link.error = '读取词表失败：' + (e && e.message || e);
          }
        } else {
          link.error = link.dirError
            || '未检测到墨读本地服务，也未绑定存档目录（桌面版或 start-server 未运行）';
        }
      }
    } else {
      link.ok = true;
    }
  }

  rec = rec || await store.getVocab();
  if (rec) {
    link.source = rec.source;
    link.label = rec.label;
    link.count = rec.count;
    link.at = rec.at;
    link.ok = link.ok || rec.source === 'file' || rec.source === 'dir';
    if (rec.source !== 'local' && rec.source !== 'dir') { link.error = link.error || '使用已导入的词表'; }
  }
  _vocab = { map: rec ? vocabToMapCached(rec) : new Map(), rec, link, at: Date.now() };
  return _vocab;
}

const _mapCache = new WeakMap();
function vocabToMapCached(rec) {
  let m = _mapCache.get(rec);
  if (!m) { m = store.vocabToMap(rec); _mapCache.set(rec, m); }
  return m;
}

/* ================= 标记（词级标记 + 文本划线） =================
   词级标记全局生效、优先于墨读词库——用户亲手标的说了算。
   任何标记变化都会清掉文章缓存，下次分析立刻按新标记重算。 */
let _marks = null;

async function ensureMarks(force) {
  if (_marks && !force) return _marks;
  _marks = await store.getMarks();
  return _marks;
}

async function saveMarks(next) {
  _marks = await store.setMarks(next);
  _articles.clear();                    /* 标记改了 → 文章报告作废，重新分析 */
  return _marks;
}

/* ================= 页面元数据（MAIN world） =================
   必须是「自包含函数」——会被序列化后在页面主世界执行，不能引用外部变量。 */
function probeMainWorld(site) {
  const out = { site, ok: false, title: document.title || '' };
  /* 从内联 <script> 里抠 JSON（花括号配对 + 字符串状态机，不能用正则） */
  const scan = marker => {
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const sc of scripts) {
        const t = sc.textContent || '';
        if (!t || t.length < 40) continue;
        const m = marker.exec(t);
        if (!m) continue;
        const start = t.indexOf('{', m.index + m[0].length - 1);
        if (start < 0) continue;
        let depth = 0, inStr = false, q = '', esc = false;
        for (let i = start; i < t.length; i++) {
          const c = t[i];
          if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) inStr = false; continue; }
          if (c === '"' || c === "'") { inStr = true; q = c; continue; }
          if (c === '{' || c === '[') depth++;
          else if (c === '}' || c === ']') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch (e) { break; } } }
        }
      }
    } catch (e) { /* 忽略 */ }
    return null;
  };
  try {
    if (site === 'youtube') {
      /* 优先从「活动播放器实例」取：getAudioTrack()/getPlayerResponse() 里的 captionTracks
         是**当前播放会话已签名**的 URL（多数带有效 pot），比页面初始 HTML 里的可靠得多
         —— 初始 URL 常带 exp=xpe/potc 标记，直接请求会 HTTP 200 + 空 body。 */
      let signed = null, livePr = null;
      try {
        const mp = document.getElementById('movie_player');
        if (mp) {
          if (typeof mp.getAudioTrack === 'function') {
            const at = mp.getAudioTrack();
            if (at && at.captionTracks && at.captionTracks.length) signed = at.captionTracks;
          }
          if (typeof mp.getPlayerResponse === 'function') livePr = mp.getPlayerResponse();
        }
      } catch (e) { /* 播放器还没就绪 */ }
      /* 退到 window 全局 / ytplayer.config / 扫内联 <script> */
      let pr = livePr || window.ytInitialPlayerResponse || null;
      if (!pr && window.ytplayer && window.ytplayer.config && window.ytplayer.config.args && window.ytplayer.config.args.player_response) {
        try { pr = JSON.parse(window.ytplayer.config.args.player_response); } catch (e) { pr = null; }
      }
      if (!pr) pr = scan(/ytInitialPlayerResponse\s*=\s*/);
      const vd = (pr && pr.videoDetails) || {};
      const tl = (pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer) || {};
      out.title = vd.title || out.title;
      out.videoId = vd.videoId || '';
      out.desc = vd.shortDescription || '';
      const rawTracks = signed || tl.captionTracks || [];
      out.captions = rawTracks.map(t => ({
        baseUrl: t.url || t.baseUrl,
        languageCode: t.languageCode || t.langCode || '',
        vssId: t.vssId || '',
        kind: t.kind || '',
        name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || t.displayName || ''
      }));
      out.captionSource = signed ? 'player-track' : (tl.captionTracks ? 'player-response' : '');
      /* 只有真拿到数据才算 ok —— 否则让上层继续走内容脚本的 DOM 兜底 */
      out.ok = !!pr || !!signed;
    } else if (site === 'bilibili') {
      const st = window.__INITIAL_STATE__ || null;
      if (st) {
        const vd = st.videoData || {};
        const ep = st.epInfo || {};
        out.title = vd.title || ep.title || out.title;
        out.aid = vd.aid || ep.aid || null;
        out.bvid = vd.bvid || null;
        out.cid = vd.cid || ep.cid || null;
        out.epId = ep.ep_id || null;
        out.desc = vd.desc || '';
        /* 页面内嵌字幕列表（部分视频免登录即可拿到） */
        const sub = vd.subtitle || {};
        out.subtitleTracks = (sub.subtitles || sub.list || []).map(x => ({
          lan: x.lan || '', lan_doc: x.lan_doc || '', subtitle_url: x.subtitle_url || x.subtitleUrl || ''
        }));
        out.ok = true;
      }
    }
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

async function getMediaInfo(site, tabId) {
  if (tabId != null && api.scripting && api.scripting.executeScript) {
    try {
      const res = await api.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: 'MAIN',
        func: probeMainWorld,
        args: [site]
      });
      const r = Array.isArray(res) ? res.find(x => x && x.result) : null;
      if (r && r.result && r.result.ok) return r.result;
    } catch (e) { /* Firefox<128 等不支持 world:MAIN → 走 DOM 兜底 */ }
  }
  /* 兜底：让内容脚本扫 <script> 标签（DOM 共享，跨浏览器可用） */
  if (tabId != null) {
    try {
      const r = await api.tabs.sendMessage(tabId, { type: 'domProbe', site });
      if (r && r.ok) return r;
    } catch (e) { /* 内容脚本未就绪 */ }
  }
  return { site, ok: false, error: '未能读取页面播放器数据' };
}

/* ================= InnerTube 兜底（MAIN world） =================
   页面里的字幕轨为空、或全部被 PoToken 拦住时，用 InnerTube player API 以
   ANDROID 客户端再要一份 —— 这份轨道对多数视频不要求 PoToken。
   必须「自包含」：会被序列化后在页面主世界执行，不能引用外部变量。 */
function innertubeCaptions(videoId) {
  return (async () => {
    try {
      if (!videoId) return [];
      /* API key 从页面 ytcfg 或内联脚本里取（拿不到也能请求，key 只是加速） */
      let key = '';
      try {
        if (window.ytcfg) {
          if (typeof window.ytcfg.get === 'function') key = window.ytcfg.get('INNERTUBE_API_KEY') || '';
          if (!key && window.ytcfg.data_) key = window.ytcfg.data_.INNERTUBE_API_KEY || '';
        }
      } catch (e) { /* 忽略 */ }
      if (!key) {
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
          const m = (s.textContent || '').match(/"INNERTUBE_API_KEY":"([^"]+)"/);
          if (m) { key = m[1]; break; }
        }
      }
      const ver = '20.10.38';
      const body = {
        context: { client: { clientName: 'ANDROID', clientVersion: ver, androidSdkVersion: 30, hl: 'en', gl: 'US' } },
        videoId
      };
      const url = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false' + (key ? '&key=' + encodeURIComponent(key) : '');
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': '3', 'X-YouTube-Client-Version': ver },
        body: JSON.stringify(body),
        credentials: 'omit'
      });
      if (!r.ok) return [];
      const j = await r.json();
      const ct = (j && j.captions && j.captions.playerCaptionsTracklistRenderer && j.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
      return ct.map(t => ({
        baseUrl: t.baseUrl, languageCode: t.languageCode || '', vssId: t.vssId || '', kind: t.kind || '',
        name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || ''
      }));
    } catch (e) { return []; }
  })();
}

async function innertubeFallback(videoId, tabId) {
  if (tabId == null || !videoId || !api.scripting || !api.scripting.executeScript) return [];
  try {
    const res = await api.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: innertubeCaptions,
      args: [videoId]
    });
    const r = Array.isArray(res) ? res.find(x => x && x.result) : null;
    return (r && Array.isArray(r.result)) ? r.result : [];
  } catch (e) { return []; }
}

/* ================= 抓字幕 ================= */
async function fetchText(u, timeoutMs) {
  const r = await fetchWithTimeout(u, { cache: 'no-store' }, timeoutMs || 12000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

/**
 * 抓字幕文本（两条通道 + 诊断）。
 * - `page`：让**内容脚本在页面上下文**里抓 —— 请求带页面自己的 Origin / Referer / Cookie，
 *   与播放器取字幕时一致；YouTube 优先走这条（PoToken 与 Cookie 都靠它）。
 * - `sw`：Service Worker 直连（带 host_permissions）。B 站字幕文件（hdslb）走这条最省事。
 * @returns {Promise<{text:string, via:string}>} 非空文本时 via 标出通道，否则 via 为空串
 */
async function fetchCaptionText(url, tabId, timeoutMs, preferPage) {
  if (!url) return { text: '', via: '' };
  const viaSw = async () => {
    try { const t = await fetchText(url, timeoutMs); if (t && t.trim()) return t; } catch (e) { /* 换通道 */ }
    return '';
  };
  const viaPage = async () => {
    if (tabId == null) return '';
    try {
      /* 内容脚本可能因页面状态不回复 —— 用竞速超时兜底，绝不让分析被一条消息挂死 */
      const wait = timeoutMs || 12000;
      const r = await Promise.race([
        api.tabs.sendMessage(tabId, { type: 'fetchCaption', url }),
        new Promise(res => setTimeout(() => res(null), wait))
      ]);
      if (r && r.ok && r.text && r.text.trim()) return r.text;
    } catch (e) { /* 内容脚本未就绪 */ }
    return '';
  };
  const order = preferPage ? [['page', viaPage], ['sw', viaSw]] : [['sw', viaSw], ['page', viaPage]];
  for (const [name, fn] of order) {
    const t = await fn();
    if (t) return { text: t, via: name };
  }
  return { text: '', via: '' };
}

async function getSubtitle(site, info, settings, tabId) {
  const preferEn = settings.subs.preferEn !== false;

  if (site === 'youtube') {
    let captions = info.captions || [];
    let track = pickYoutubeTrack(captions, preferEn);
    let source = (track && info.captionSource) || '';

    /* 页面里没有可用字幕轨 → InnerTube（ANDROID）兜底再要一份 */
    if (!track && info.videoId) {
      const extra = await innertubeFallback(info.videoId, tabId);
      if (extra.length) { captions = extra; track = pickYoutubeTrack(captions, preferEn); source = 'innertube'; }
    }
    if (!track) {
      return { text: '', track: null, reason: '该视频没有字幕/CC：页面播放器数据与 InnerTube 兜底都没有字幕轨（纯音乐 / 未上传字幕的视频属正常）' };
    }

    const label = { lang: track.languageCode, label: track.name, asr: track.kind === 'asr' };
    const tried = [];
    /* 逐个候选 URL × 「页面上下文优先，再 SW 直连」：任一拿到非空内容即成功 */
    for (const u of ytCaptionUrls(track.baseUrl)) {
      const got = await fetchCaptionText(u, tabId, 12000, true);
      tried.push(got.via ? got.via + '✓' : '空');
      const text = parseSubtitle('youtube', got.text);
      if (text) return { text, track: label, reason: '', via: got.via, source };
    }

    /* 页面轨道全被 PoToken 拦 → 用 InnerTube 重取一份轨道，再试一轮 */
    if (info.videoId && source !== 'innertube') {
      const extra = await innertubeFallback(info.videoId, tabId);
      const t2 = pickYoutubeTrack(extra, preferEn);
      if (t2) {
        for (const u of ytCaptionUrls(t2.baseUrl)) {
          const got = await fetchCaptionText(u, tabId, 12000, true);
          const text = parseSubtitle('youtube', got.text);
          if (text) return { text, track: label, reason: '', via: got.via, source: 'innertube' };
        }
        tried.push('InnerTube 轨道也空');
      } else {
        tried.push('InnerTube 无轨道');
      }
    }
    return {
      text: '', track: label, source,
      reason: '字幕轨拿到了但内容为空：YouTube 现在要求 PoToken（来源证明令牌），缺失时返回 200 + 空 body。已试 json3 / 原始 / 去 pot 三种 URL × 页面与后台两条通道，仍为空。',
      debug: '尝试记录：' + (tried.join(' · ') || '—')
    };
  }

  if (site === 'bilibili') {
    let list = (info.subtitleTracks && info.subtitleTracks.length) ? info.subtitleTracks : null;
    if (!list) {
      const q = new URLSearchParams();
      if (info.aid) q.set('aid', info.aid);
      if (info.bvid) q.set('bvid', info.bvid);
      if (info.cid) q.set('cid', info.cid);
      if (q.get('cid') && (q.get('aid') || q.get('bvid'))) {
        try {
          const body = await fetchText('https://api.bilibili.com/x/player/v2?' + q.toString(), 12000);
          const j = JSON.parse(body);
          list = ((j && j.data && j.data.subtitle && j.data.subtitle.subtitles) || []).map(x => ({
            lan: x.lan, lan_doc: x.lan_doc, subtitle_url: x.subtitle_url
          }));
        } catch (e) { list = []; }
      } else {
        list = [];
      }
    }
    if (!list || !list.length) {
      return { text: '', track: null, reason: '该视频没有可用字幕（AI 字幕通常需要登录 B 站）' };
    }
    const pick = pickBilibiliTrack(list, preferEn);
    if (!pick || !(pick.subtitle_url)) return { text: '', track: null, reason: '字幕轨为空' };
    if (pick._noEnglish) {
      return { text: '', track: null, reason: '该视频只有中文字幕，无法评估英文生词量', tracks: list.map(t => t.lan_doc || t.lan) };
    }
    const got = await fetchCaptionText(blAbsUrl(pick.subtitle_url), tabId, 15000, false);
    const text = parseSubtitle('bilibili', got.text);
    return { text, track: { lang: pick.lan, label: pick.lan_doc, asr: /^ai-/.test(pick.lan || '') }, reason: '', via: got.via };
  }

  return { text: '', track: null, reason: '未支持的站点' };
}

/* ================= 视频主流程 ================= */
async function analyzeHref(href, tabId, opts) {
  const site = detectSite(href);
  if (!site) return { error: 'unsupported', message: '当前页面不是受支持的视频站点（哔哩哔哩 / YouTube）' };

  const settings = await store.getSettings();
  const key = site.key + (settings.subs.preferEn === false ? ':any' : ':en');

  if (!(opts && opts.force)) {
    const cached = await store.getReport(key);
    if (cached && store.isFresh(cached, settings)) {
      if (tabId != null) setBadge(tabId, cached, settings);
      return { ...cached, cached: true };
    }
  }

  const info = await getMediaInfo(site.site, tabId);
  const [freq, vocab] = await Promise.all([loadFreq(), ensureVocab(false)]);

  let sub;
  try {
    sub = await getSubtitle(site.site, info, settings, tabId);
  } catch (e) {
    sub = { text: '', track: null, reason: '字幕抓取失败：' + (e && e.message || e) };
  }

  /* 无字幕：若有标题/简介，退化为「小样本估算」，并明确标注 */
  let text = sub.text || '';
  let fallback = false;
  if (!text) {
    const t = [info.title, info.desc].filter(Boolean).join('\n');
    if (t) { text = t; fallback = true; }
  }

  const minTokens = settings.subs.minTokens || 80;
  const tokCount = (text.match(/[A-Za-z][A-Za-z'’\-]*/g) || []).length;

  const report = analyze(text, vocab.map, freq, { maxTop: 24 });
  const out = {
    ...report,
    kind: 'video',
    key,
    site: site.site,
    siteLabel: site.label,
    videoId: site.id,
    href,
    title: info.title || '',
    subtitle: {
      ok: !!sub.text,
      label: sub.track ? [sub.track.label, sub.track.lang].filter(Boolean).join(' · ') : '',
      asr: !!(sub.track && sub.track.asr),
      reason: sub.reason || '',
      debug: sub.debug || '',
      via: sub.via || '',
      source: sub.source || '',
      fallback,
      tracks: sub.tracks || undefined
    },
    sample: textSample(text),
    lowSample: !fallback && tokCount > 0 && tokCount < minTokens,
    vocab: vocabInfo(vocab)
  };

  await store.putReport(key, out, settings);
  if (tabId != null) setBadge(tabId, out, settings);
  return out;
}

function vocabInfo(vocab) {
  return {
    source: vocab.link.source, label: vocab.link.label, count: vocab.link.count,
    at: vocab.link.at, ok: vocab.link.ok, error: vocab.link.error || '', mode: vocab.link.mode
  };
}

/* ================= 文章 ================= */
const _articles = new Map();      /* key → { at, payload } */

async function analyzeArticle(msg) {
  const settings = await store.getSettings();
  if (settings.article && settings.article.enabled === false) {
    return { ok: false, error: 'disabled', reason: '文章阅读已在设置里关闭' };
  }

  const href = msg.href || '';
  const key = articleKey(href);
  const text = Array.isArray(msg.paras) ? msg.paras.join('\n\n') : String(msg.text || '');

  if (!msg.force) {
    const hit = _articles.get(key);
    if (hit && Date.now() - hit.at < ARTICLE_TTL_MS && hit.payload.ok) {
      return { ...hit.payload, cached: true };
    }
  }

  const [freq, vocab, marks] = await Promise.all([loadFreq(), ensureVocab(false), ensureMarks(false)]);
  const map = mergeWordMarks(vocab.map, marks);
  const res = analyzeArticlePage({
    text, title: msg.title || '', href, statusMap: map, freq, opts: { maxTop: 40 }
  });

  if (!res.ok) return { ok: false, error: 'not-article', reason: res.reason, quality: res.quality, title: res.title };

  const report = {
    ...res.report,
    kind: 'article',
    key: res.key,
    site: 'article',
    siteLabel: hostLabel(href),
    href,
    title: res.title,
    quality: res.quality,
    subtitle: { ok: true, label: '网页正文', reason: '' },
    vocab: vocabInfo(vocab)
  };

  const pageHighlights = listHighlights(marks, msg.urlKey || '');
  const payload = {
    ok: true, report, statuses: res.statuses, text: res.text,
    marks: { words: marks.words, summary: marksSummary(marks, msg.urlKey || '') },
    highlights: pageHighlights
  };
  _articles.set(key, { at: Date.now(), payload });
  /* 简单上限，避免长会话里无限增长 */
  if (_articles.size > 20) {
    const oldest = Array.from(_articles.entries()).sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _articles.delete(oldest[0]);
  }
  return payload;
}

function hostLabel(href) {
  try { return new URL(href).hostname.replace(/^www\./, ''); } catch (e) { return '网页'; }
}

/* ================= 离线词典（阅读模式点词查释义） ================= */
const _shards = new Map();        /* `${base}|${letter}` → Promise<obj|null> */

function shardName(w) {
  const c = String(w || '')[0] ? String(w)[0].toLowerCase() : '';
  return (c >= 'a' && c <= 'z') ? c : 'other';
}

async function getServerBase(settings) {
  if (_serverBase) return _serverBase;
  const s = settings || await store.getSettings();
  const hit = await vs.detectServer({ custom: s.link.serverUrl, ports: s.link.ports, timeoutMs: 1200 });
  if (hit) _serverBase = hit.base;
  return _serverBase;
}

async function loadShard(base, letter) {
  const k = base + '|' + letter;
  if (_shards.has(k)) return _shards.get(k);
  const p = (async () => {
    try {
      const r = await fetchWithTimeout(base + '/dict/' + letter + '.json', { cache: 'no-store' }, 8000);
      if (!r.ok) return null;
      const j = await r.json();
      return (j && typeof j === 'object') ? j : null;
    } catch (e) { return null; }
  })();
  _shards.set(k, p);
  return p;
}

/** 词形还原候选（与 text.js lemmas 同思路的精简版，后台不 import 以免带进分词器） */
function lemmaCands(w) {
  const base = String(w || '').toLowerCase();
  const out = [base];
  if (base.length > 3) {
    const push = s => { if (s.length >= 2 && out.indexOf(s) < 0) out.push(s); };
    if (base.endsWith('ies')) push(base.slice(0, -3) + 'y');
    if (base.endsWith('es')) push(base.slice(0, -2));
    if (base.endsWith('s') && !base.endsWith('ss')) push(base.slice(0, -1));
    if (base.endsWith('ed')) { push(base.slice(0, -2)); push(base.slice(0, -1)); }
    if (base.endsWith('ing')) { push(base.slice(0, -3)); push(base.slice(0, -3) + 'e'); }
  }
  return out;
}

async function dictLookup(msg) {
  const word = String((msg && msg.word) || '').trim().toLowerCase();
  if (!word) return { ok: false, error: 'empty' };
  const settings = await store.getSettings();
  const base = await getServerBase(settings);
  if (!base) return { ok: false, error: 'no-server', message: '未检测到墨读本地服务，无法查词' };

  const cands = lemmaCands(word);
  const letters = Array.from(new Set(cands.map(shardName)));
  const shards = await Promise.all(letters.map(l => loadShard(base, l)));
  for (const c of cands) {
    const sh = shards[letters.indexOf(shardName(c))];
    const e = sh && sh[c];
    if (e) {
      return { ok: true, word: c, phonetic: e.p || '', meaning: e.t || '', pos: e.pos || '', base };
    }
  }
  return { ok: false, error: 'not-found', word, message: '离线词典里没有这个词' };
}

/* ================= 角标 ================= */
function setBadge(tabId, report, settings) {
  try {
    const r = ratingOf(report, (settings && settings.rating && settings.rating.system) || 'step');
    const text = (report && report.tokens) ? String((r && r.code) || '') : '';
    api.action.setBadgeText({ tabId, text: text.slice(0, 4) });
    const color = { ok: '#2e9e6b', good: '#3b82f6', warn: '#d98a19', bad: '#d64545' }[(r && r.tone) || ''] || '#6b7280';
    if (api.action.setBadgeBackgroundColor) api.action.setBadgeBackgroundColor({ tabId, color });
    api.action.setTitle({
      tabId,
      title: 'InkRead — ' + (report && report.tokens
        ? `${(r && r.headline) || ''} · 可理解度 ${Math.round(report.coverage * 100)}%`
        : '未分析')
    });
  } catch (e) { /* 忽略：标签页可能已关闭 */ }
}

/* ================= 在线翻译（联动墨读 PC 端） =================
 * 设计：翻译引擎逻辑在 shared/translate.js（移植自网页版 web/js/translate.js）；
 *   配置形状与墨读 settings.json 里的 settings.api 完全一致 → 可以直接把 PC 端配好的
 *   API Key 一键导入；请求统一经墨读本地服务的 /__proxy 转发（白名单已覆盖全部翻译域名），
 *   所以扩展**不需要任何新增主机权限**，也不会因 CORS 被拦。
 */
let _pc = { at: 0, base: '', root: '' };

/** 探测墨读本地服务（带 5 分钟缓存；force=true 强制重探） */
async function pcServer(force) {
  if (!force && _pc.base && Date.now() - _pc.at < 5 * 60 * 1000) return _pc;
  if (!force && _pc.at && Date.now() - _pc.at < 60 * 1000) return _pc;   /* 刚探过但没探到：1 分钟内不重试 */
  const s = await store.getSettings();
  let hit = null;
  try { hit = await vs.detectServer({ custom: s.link.serverUrl, ports: s.link.ports, timeoutMs: 1200 }); } catch (e) { hit = null; }
  _pc = hit ? { at: Date.now(), base: hit.base, root: hit.root || '' } : { at: Date.now(), base: '', root: '' };
  if (hit && hit.root && hit.root !== s.link.pcRoot) store.saveSettings({ link: { pcRoot: hit.root } }).catch(() => {});
  return _pc;
}

/** 读墨读 PC 端的 settings.json（含 storageDir 与 api 两份关键配置） */
async function readPcSettings(base, timeoutMs) {
  const r = await fetchWithTimeout(`${base}/__store/read?path=settings.json`, { cache: 'no-store' }, timeoutMs || 3000);
  if (!r.ok) throw new Error('读取 settings.json 失败：HTTP ' + r.status);
  const data = JSON.parse(await r.text());
  return (data && data.settings) || {};
}

/** 真正执行一次翻译：按设置决定走本地转发还是直连 */
async function runTranslate(q, engine) {
  const text = String(q == null ? '' : q).trim();
  if (!text) throw new Error('没有要翻译的内容');
  const s = await store.getSettings();
  if (!s.translate.enabled) throw new Error('在线翻译未开启（设置 → 翻译接口）');
  let proxyBase = '';
  if (s.translate.viaLocal) {
    const pc = await pcServer(false);
    proxyBase = pc.base || '';
  }
  return await tr.run(text, {
    api: s.api,
    engine: engine || s.api.engine,
    proxyBase,
    root: s.link.pcRoot || '',
    fetchImpl: (u, o) => fetch(u, o)
  });
}

/* ================= 消息路由 ================= */
onMessage(async (msg, sender, reply) => {
  const tabId = (msg && msg.tabId != null) ? msg.tabId : (sender && sender.tab && sender.tab.id);

  switch (msg && msg.type) {
    case 'ping':
      return { ok: true, v: 2 };

    case 'pcInfo': {
      /* 设置页用：拿墨读 PC 端的服务地址、存档根目录、以及它有没有配翻译接口 */
      const pc = await pcServer(true);
      if (!pc.base) return { ok: false, error: 'no-service', message: '没探测到「墨读」本地服务：请先打开墨读桌面版，或网页版跑 tools/serve.py' };
      let ps = null, err = '';
      try { ps = await readPcSettings(pc.base); } catch (e) { err = String(e && e.message || e); }
      return {
        ok: true, base: pc.base, root: pc.root,
        storageDir: (ps && ps.storageDir) || '',
        hasApi: !!(ps && ps.api),
        engine: (ps && ps.api && ps.api.engine) || '',
        err
      };
    }

    case 'pcImportApi': {
      /* 一键把墨读 PC 端配好的翻译接口搬过来（Key 不落磁盘，只进扩展自己的 storage） */
      const pc = await pcServer(true);
      if (!pc.base) return { ok: false, error: 'no-service', message: '没探测到「墨读」本地服务' };
      const ps = await readPcSettings(pc.base);
      const src = (ps && ps.api) || null;
      if (!src) return { ok: false, error: 'no-api', message: '墨读的设置里还没有翻译接口配置（先在墨读设置页填好 Key）' };
      const next = await store.saveSettings({ api: { ...src, importedAt: Date.now() } });
      return { ok: true, api: next.api, configured: tr.engineConfigured(next.api), engine: next.api.engine };
    }

    case 'translateStatus': {
      const s = await store.getSettings();
      const pc = await pcServer(false);
      return {
        ok: true,
        enabled: !!s.translate.enabled,
        viaLocal: !!s.translate.viaLocal,
        engine: s.api.engine,
        configured: tr.engineConfigured(s.api),
        labels: tr.ENGINE_LABELS,
        autoEngines: tr.AUTO_ENGINES,
        proxy: !!pc.base, base: pc.base,
        importedAt: s.api.importedAt || 0
      };
    }

    case 'translate': {
      try { const r = await runTranslate(msg.q, msg.engine); return { ok: true, engine: r.engine, text: r.text }; }
      catch (e) { return { ok: false, error: 'translate-failed', message: String(e && e.message || e) }; }
    }

    case 'wordStatuses': {
      /* 批量查一批词在「墨读词库 + 用户手标」里的状态。字幕划词与正文着色共用：
         内容脚本把当前看到的词丢进来，只回传命中的状态对（unknown 不回传，省体积）。
         词形还原交给 text.js（articleStatuses 内部走 lemmas），页面侧只做 toLowerCase 查表。 */
      try {
        const words = Array.isArray(msg.words) ? msg.words.slice(0, 4000) : [];
        const [vocab, marks] = await Promise.all([ensureVocab(false), ensureMarks(false)]);
        const map = mergeWordMarks(vocab.map, marks);
        /* linked：词库（或手标）里到底有没有东西。内容脚本据此决定「要不要给字幕上色」——
           空词库时每个词都会算 unknown，满屏橙点比不标更糟，所以宁可不着色。 */
        const linked = map.size > 0;
        if (!words.length) return { ok: true, linked, statuses: [] };
        return { ok: true, linked, statuses: articleStatuses(words.join(' '), map) };
      } catch (e) { return { ok: false, error: 'status-failed', message: String(e && e.message || e) }; }
    }

    case 'phraseInfo': {
      try {
        const p = await ensurePhrases();
        return { ok: true, ready: p.isLoaded(), count: p.isLoaded() ? p.size() : 0, error: _phrErr };
      } catch (e) { return { ok: false, ready: false, count: 0, error: String(e && e.message || e) }; }
    }

    case 'phraseScan': {
      /* 内容脚本把段落数组丢进来，回每个段落里「词典收录的常用词组」的字符区间。
         关闭词组功能时直接回空，不加载 950KB 的库。 */
      const paras = Array.isArray(msg.paras) ? msg.paras.map(t => String(t == null ? '' : t)) : [];
      try {
        const s = await store.getSettings();
        if (!s.phrases.enabled) return { ok: true, disabled: true, spans: paras.map(() => []) };
        const p = await ensurePhrases();
        if (!p.isLoaded()) {
          return { ok: false, error: 'phrases-unavailable', message: _phrErr || '词组库未就绪', spans: paras.map(() => []) };
        }
        return { ok: true, count: p.size(), spans: paras.map(t => scanPhrases(p, t)) };
      } catch (e) {
        return { ok: false, error: 'phrase-scan-failed', message: String(e && e.message || e), spans: paras.map(() => []) };
      }
    }

    case 'analyze': {
      try { return await analyzeHref(msg.href, tabId, { force: !!msg.force }); }
      catch (e) { return { error: 'analyze-failed', message: String(e && e.message || e) }; }
    }

    case 'analyzeActive': {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      const t = tabs && tabs[0];
      if (!t || !t.url) return { error: 'no-tab', message: '当前标签页不可用' };
      try { return await analyzeHref(t.url, t.id, { force: !!msg.force }); }
      catch (e) { return { error: 'analyze-failed', message: String(e && e.message || e) }; }
    }

    case 'analyzeArticle': {
      try { return await analyzeArticle(msg); }
      catch (e) { return { ok: false, error: 'analyze-failed', reason: String(e && e.message || e) }; }
    }

    case 'dictLookup': {
      try { return await dictLookup(msg); }
      catch (e) { return { ok: false, error: 'lookup-failed', message: String(e && e.message || e) }; }
    }

    case 'vocabStatus': {
      const v = await ensureVocab(!!msg.force);
      const s = v.rec ? store.vocabToMap(v.rec) : new Map();
      const st = v.link.source === 'dir' ? { ok: true, name: String(v.link.label || '').replace(/^存档目录 · /, '') } : await fsx.dirStatus();
      return {
        ...v.link,
        dirSupported: fsx.dirSupported(),
        dirBound: !!(st && st.ok),
        dirName: (st && st.name) || '',
        summary: vocabSummary(s),
        cached: v.rec ? { at: v.rec.at, count: v.rec.count, source: v.rec.source, label: v.rec.label } : null
      };
    }

    /* ---------- 标记 ---------- */
    case 'marksGet': {
      const m = await ensureMarks(!!msg.force);
      return {
        ok: true,
        words: m.words,
        highlights: listHighlights(m, msg.urlKey || ''),
        summary: marksSummary(m, msg.urlKey || '')
      };
    }

    case 'markSet': {
      const m = await ensureMarks(false);
      const next = msg.status
        ? setWordMark(m, msg.word, msg.status, Date.now())
        : clearWordMark(m, msg.word);
      await saveMarks(next);
      const word = String(msg.word || '').toLowerCase();
      /* 标记写回共享 vocab.json：桌面版 / 网页版随即看到同一个状态 */
      const shared = msg.status ? await pushMarksToDir({ [word]: msg.status }) : null;
      return {
        ok: true, word, status: msg.status || null,
        summary: marksSummary(next, msg.urlKey || ''),
        shared: shared ? { ok: !!shared.ok, changed: shared.changed || 0, skipped: shared.skipped || '', error: shared.error || '' } : null
      };
    }

    case 'hlAdd': {
      const m = await ensureMarks(false);
      const next = addHighlight(m, msg.urlKey || '', msg.text, msg.note, Date.now());
      await saveMarks(next);
      return { ok: true, highlights: listHighlights(next, msg.urlKey || ''), summary: marksSummary(next, msg.urlKey || '') };
    }

    case 'hlDel': {
      const m = await ensureMarks(false);
      const next = delHighlight(m, msg.urlKey || '', msg.id);
      await saveMarks(next);
      return { ok: true, highlights: listHighlights(next, msg.urlKey || ''), summary: marksSummary(next, msg.urlKey || '') };
    }

    case 'marksClear': {
      const next = normalizeMarks(await store.clearMarks());
      _marks = next;
      _articles.clear();
      return { ok: true, summary: marksSummary(next, msg.urlKey || '') };
    }

    case 'setVocab': {
      /* 由选项页导入文件后调用 */
      const rec = await store.setVocab(msg.source || 'file', msg.label || '导入文件', msg.entries || []);
      _vocab = { map: null, rec: null, link: null, at: 0 };
      await ensureVocab(true);
      return { ok: true, count: rec.count, label: rec.label };
    }

    case 'settingsChanged': {
      _vocab = { map: null, rec: null, link: null, at: 0 };
      _marks = null;
      _articles.clear();
      const v = await ensureVocab(true);
      await ensureMarks(true);
      return { ok: true, vocab: v.link };
    }

    /* ---------- 存档目录直连（免启动桌面版 / 三端同步） ---------- */
    case 'dirStatus': {
      const name = await dirNameOf();
      const st = await fsx.dirStatus();
      return {
        ok: !!(st && st.ok),
        supported: fsx.dirSupported(),
        offscreen: fsx.offscreenSupported(),
        bound: !!(st && st.ok),
        name: name || '',
        perm: (st && st.perm) || '',
        error: (st && !st.ok) ? (st.error || '') : ''
      };
    }

    case 'dirSync': {
      /* 从绑定的存档目录读 vocab.json，立即替换词表缓存 */
      try {
        const got = await readVocabFromDir();
        if (!got) {
          const st = await fsx.dirStatus();
          return { ok: false, error: fsx.dirSupported() ? ((st && st.error) || '目录里没有 vocab.json') : '当前浏览器不支持目录直连（Firefox 请用「导入文件」或本地服务）' };
        }
        const rec = await store.setVocab('dir', got.label, got.entries);
        _vocab = { map: null, rec: null, link: null, at: 0 };
        _articles.clear();
        await ensureVocab(true);
        return { ok: true, count: rec.count, name: got.root, label: rec.label };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }

    case 'dirPushMarks': {
      /* 把本地全部词标记一次性推回共享词库 */
      const m = await ensureMarks(false);
      const changes = msg.changes && typeof msg.changes === 'object' ? msg.changes : vc.marksToChanges(m.words);
      const r = await pushMarksToDir(changes);
      return { ok: !!r.ok, changed: r.changed || 0, added: r.added || 0, updated: r.updated || 0, skipped: r.skipped || '', error: r.error || '' };
    }

    case 'dirForget': {
      await fsx.dirForget();
      _dirName = '';
      await store.saveSettings({ link: { dirName: '' } });
      return { ok: true };
    }

    case 'dirProbe': {
      /* 诊断：离屏文档能不能起来（FSA 在 service worker 里不可用时的兜底通道） */
      const p = await fsx.probeOffscreen();
      return { ok: !!p.ok, error: p.error || '', hasFsa: !!p.hasFsa, supported: fsx.dirSupported(), offscreen: fsx.offscreenSupported() };
    }

    case 'tabGone':
      return { ok: true };

    default:
      return { ok: false, message: '未知消息类型：' + (msg && msg.type) };
  }
});

/* ================= 生命周期 ================= */
/* 扩展被重新加载 / 更新后，已打开标签页里**旧的**内容脚本会被孤立：
   `chrome.runtime` 变成 undefined，胶囊会报「与扩展后台通信失败：Cannot read properties
   of undefined (reading 'sendMessage')」，而点扩展图标（弹窗是新上下文）却能评估。
   修法：更新时就地重注入内容脚本（旧的会自毁让位），用户无需手动刷新页面。 */
async function reinjectContentScripts() {
  if (!api.scripting || !api.scripting.executeScript) return;
  let tabs = [];
  try { tabs = await api.tabs.query({}); } catch (e) { return; }
  for (const t of tabs) {
    if (!t || t.id == null || !t.url || !/^https?:/i.test(t.url)) continue;
    const video = /^https?:\/\/([^/]*\.)?(youtube\.com|bilibili\.com)\//i.test(t.url);
    const file = video ? 'src/content/content.js' : 'src/content/article.js';
    try {
      await api.scripting.executeScript({ target: { tabId: t.id, allFrames: false }, files: [file] });
    } catch (e) { /* 没有该站点主机权限（普通网页）→ 忽略，弹窗触发时再补 */ }
  }
}

api.runtime.onInstalled.addListener(async d => {
  await store.getSettings();                 /* 写入默认值 */
  if (d && d.reason === 'install' && api.runtime.openOptionsPage) {
    /* 首次安装打开选项页，引导联动设置 */
    try { api.runtime.openOptionsPage(); } catch (e) { /* 忽略 */ }
  }
  if (d && d.reason === 'update') {
    try { await reinjectContentScripts(); } catch (e) { /* 忽略 */ }
  }
});

/* 切标签 / 更新时清空角标，避免残留 */
api.tabs.onUpdated.addListener((tabId, info) => {
  if (info && info.status === 'loading' && api.action.setBadgeText) {
    try { api.action.setBadgeText({ tabId, text: '' }); } catch (e) { /* 忽略 */ }
  }
});
