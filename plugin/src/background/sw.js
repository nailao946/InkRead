/* InkRead Video — 后台 Service Worker（MV3）
 *
 * 职责：识别站点 → 取播放器元数据 → 抓字幕 → 与墨读词库比对 → 产出「视频词汇画像」→ 缓存 + 角标。
 * 所有跨域请求都放在这里做：扩展 Service Worker 带 host_permissions，可绕开页面 CORS。
 */
import { api, url, fetchWithTimeout, onMessage } from '../shared/api.js';
import * as store from '../shared/store.js';
import { buildStatusMap, analyze, vocabSummary } from '../shared/analyze.js';
import { parseFreq } from '../shared/freq.js';
import * as vs from '../shared/vocab-source.js';
import {
  detectSite, pickYoutubeTrack, ytJson3Url, pickBilibiliTrack, blAbsUrl, parseSubtitle, textSample
} from '../shared/subs.js';

const VOCAB_TTL_MS = 30 * 60 * 1000;      /* 词表缓存 30 分钟，避免每次分析都打本地服务 */

/* ================= 词频表 ================= */
let _freq = null;
async function loadFreq() {
  if (_freq) return _freq;
  try {
    const r = await fetch(url('data/freq-bands.json'));
    _freq = parseFreq(await r.text());
  } catch (e) {
    _freq = { rank: null, top: 0, meta: null, error: String(e && e.message || e) };
  }
  return _freq;
}

/* ================= 词库联动 ================= */
let _vocab = { map: null, rec: null, link: null, at: 0 };

async function ensureVocab(force) {
  const s = await store.getSettings();
  if (_vocab.map && !force && Date.now() - _vocab.at < VOCAB_TTL_MS) return _vocab;

  const mode = s.link.mode;
  let rec = await store.getVocab();
  const link = { source: 'none', label: vs.LINK_SOURCE.none, count: 0, at: 0, ok: false, mode };

  if (mode !== 'off') {
    const fresh = rec && (Date.now() - rec.at < VOCAB_TTL_MS);
    if (!fresh || force) {
      const hit = await vs.detectServer({ custom: s.link.serverUrl, ports: s.link.ports, timeoutMs: 1500 });
      if (hit) {
        try {
          const got = await vs.readVocabFromServer(hit.base, 3000);
          rec = await store.setVocab('local', got.label, got.entries);
          link.ok = true;
        } catch (e) {
          link.error = '读取词表失败：' + (e && e.message || e);
        }
      } else {
        link.error = '未检测到墨读本地服务（桌面版或 start-server 未运行）';
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
    link.ok = link.ok || rec.source === 'file';
    if (rec.source !== 'local') { link.error = link.error || '使用已导入的词表'; }
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

/* ================= 页面元数据（MAIN world） =================
   必须是「自包含函数」——会被序列化后在页面主世界执行，不能引用外部变量。 */
function probeMainWorld(site) {
  const out = { site, ok: false, title: document.title || '' };
  try {
    if (site === 'youtube') {
      const pr = window.ytInitialPlayerResponse || null;
      const vd = pr && pr.videoDetails;
      const tl = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
      out.title = (vd && (vd.title || out.title)) || out.title;
      out.videoId = (vd && vd.videoId) || '';
      out.desc = (vd && vd.shortDescription) || '';
      out.captions = ((tl && tl.captionTracks) || []).map(t => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode || '',
        vssId: t.vssId || '',
        kind: t.kind || '',
        name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || ''
      }));
      out.ok = true;
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

/* ================= 抓字幕 ================= */
async function fetchText(u, timeoutMs) {
  const r = await fetchWithTimeout(u, { cache: 'no-store' }, timeoutMs || 12000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

async function getSubtitle(site, info, settings) {
  const preferEn = settings.subs.preferEn !== false;

  if (site === 'youtube') {
    const track = pickYoutubeTrack(info.captions, preferEn);
    if (!track) return { text: '', track: null, reason: '该视频没有字幕/CC' };
    const body = await fetchText(ytJson3Url(track.baseUrl), 15000);
    const text = parseSubtitle('youtube', body);
    return { text, track: { lang: track.languageCode, label: track.name, asr: track.kind === 'asr' }, reason: '' };
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
    const body = await fetchText(blAbsUrl(pick.subtitle_url), 15000);
    const text = parseSubtitle('bilibili', body);
    return { text, track: { lang: pick.lan, label: pick.lan_doc, asr: /^ai-/.test(pick.lan || '') }, reason: '' };
  }

  return { text: '', track: null, reason: '未支持的站点' };
}

/* ================= 主流程 ================= */
async function analyzeHref(href, tabId, opts) {
  const site = detectSite(href);
  if (!site) return { error: 'unsupported', message: '当前页面不是受支持的视频站点（哔哩哔哩 / YouTube）' };

  const settings = await store.getSettings();
  const key = site.key + (settings.subs.preferEn === false ? ':any' : ':en');

  if (!(opts && opts.force)) {
    const cached = await store.getReport(key);
    if (cached && store.isFresh(cached, settings)) {
      if (tabId != null) setBadge(tabId, cached);
      return { ...cached, cached: true };
    }
  }

  const info = await getMediaInfo(site.site, tabId);
  const [freq, vocab] = await Promise.all([loadFreq(), ensureVocab(false)]);

  let sub;
  try {
    sub = await getSubtitle(site.site, info, settings);
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
      fallback,
      tracks: sub.tracks || undefined
    },
    sample: textSample(text),
    lowSample: !fallback && tokCount > 0 && tokCount < minTokens,
    vocab: {
      source: vocab.link.source, label: vocab.link.label, count: vocab.link.count,
      at: vocab.link.at, ok: vocab.link.ok, error: vocab.link.error || '', mode: vocab.link.mode
    },
    at: Date.now()
  };

  await store.putReport(key, out, settings);
  if (tabId != null) setBadge(tabId, out);
  return out;
}

/* ================= 角标 ================= */
function setBadge(tabId, report) {
  try {
    const text = report && report.tokens ? String(report.level) : '';
    api.action.setBadgeText({ tabId, text });
    const color = { 1: '#2e9e6b', 2: '#3b82f6', 3: '#d98a19', 4: '#d64545' }[report && report.level] || '#6b7280';
    if (api.action.setBadgeBackgroundColor) api.action.setBadgeBackgroundColor({ tabId, color });
    api.action.setTitle({ tabId, title: 'InkRead Video — ' + (report && report.tokens ? `L${report.level} ${report.levelText} · 可理解度 ${Math.round(report.coverage * 100)}%` : '未分析') });
  } catch (e) { /* 忽略：标签页可能已关闭 */ }
}

/* ================= 消息路由 ================= */
onMessage(async (msg, sender, reply) => {
  const tabId = (msg && msg.tabId != null) ? msg.tabId : (sender && sender.tab && sender.tab.id);

  switch (msg && msg.type) {
    case 'ping':
      return { ok: true, v: 1 };

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

    case 'vocabStatus': {
      const v = await ensureVocab(!!msg.force);
      const s = v.rec ? store.vocabToMap(v.rec) : new Map();
      return { ...v.link, summary: vocabSummary(s), cached: v.rec ? { at: v.rec.at, count: v.rec.count, source: v.rec.source, label: v.rec.label } : null };
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
      const v = await ensureVocab(true);
      return { ok: true, vocab: v.link };
    }

    case 'tabGone':
      return { ok: true };

    default:
      return { ok: false, message: '未知消息类型：' + (msg && msg.type) };
  }
});

/* ================= 生命周期 ================= */
api.runtime.onInstalled.addListener(async d => {
  await store.getSettings();                 /* 写入默认值 */
  const s = await store.getSettings();
  if (!s.link.serverUrl) { /* 首次安装不强探测，等用户打开视频 */ }
  if (d && d.reason === 'install' && api.runtime.openOptionsPage) {
    /* 首次安装打开选项页，引导联动设置 */
    try { api.runtime.openOptionsPage(); } catch (e) { /* 忽略 */ }
  }
});

/* 切标签 / 更新时清空角标，避免残留 */
api.tabs.onUpdated.addListener((tabId, info) => {
  if (info && info.status === 'loading' && api.action.setBadgeText) {
    try { api.action.setBadgeText({ tabId, text: '' }); } catch (e) { /* 忽略 */ }
  }
});
