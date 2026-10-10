/* InkRead — 网页文章内容脚本
 *
 * 两件事：
 *   ① 轻量抽取正文 → 交给后台用「和视频同一套内核」分析 → 在页面角落挂一个评级胶囊。
 *   ② 阅读模式：把正文搬进一个覆盖层，按你的墨读词库逐词着色（已学 / 在学 / 生词本 / 未收录），
 *      点任意词即可查离线释义（走墨读本地服务的 /dict/<字母>.json，无需联网、无需额外依赖）。
 *
 * 为什么是经典脚本：MV3 内容脚本不支持 ESM，所以这里自带 api 垫片、自带正则与工具函数。
 * 与视频脚本的分工：本文件在 youtube / bilibili 域名下直接退出（那边由 content.js 负责），
 * 也不在 localhost / 127.0.0.1 上运行（避免把墨读网页版自己当成文章）。
 */
(function () {
  'use strict';
  const api = (typeof browser !== 'undefined' && browser && browser.runtime) ? browser : chrome;

  const SKIP_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i;
  const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|bilibili\.com)$/i;
  const WORD_RE = /[A-Za-z][A-Za-z'’\-]*/g;
  const POLL_MS = 2000;
  const MIN_PARAS = 3;

  /* ============================================================
     状态
     ============================================================ */
  let host = null, root = null, refs = null;
  let readerHost = null, readerRoot = null, readerRefs = null;
  let settings = {
    article: {
      enabled: true, autoPill: true, dimKnown: false, fontSize: 17,
      inlineColor: true, inlineStyle: 'line', hlStyle: 'mark', siteOff: []
    },
    rating: { system: 'step' },
    /* 在线翻译 / 词组库：段落「译」按钮与词组划线都看这两个开关 */
    translate: { enabled: true, paraTrans: true },
    phrases: { enabled: true, underline: true }
  };
  let currentHref = '';
  let payload = null;         /* { ok, report, statuses, text, marks, highlights } */
  let probing = false;
  let open = false;
  let lastExtract = null;
  let inlineRoot = null;      /* 当前页面上色的正文容器 */
  let marksWords = {};        /* 词级标记快照（来自后台） */
  let pageHighlights = [];    /* 当前页面的划线 */
  const dictCache = new Map();

  /* 拖动 / 定位：位置按「视口可用空间比例」存（0–1），换分辨率/缩放都不跑丢 */
  const POS_PAD = 14;
  let dragging = null;
  let suppressClick = false;
  let dead = false;           /* 扩展上下文已失效（见 ctxAlive） */
  let navTimer = 0;

  /* 动态渲染（SPA / 客户端 hydrate）内容就绪重试：首探为空时退避重试 + MutationObserver 兜底 */
  const MAX_RETRY = 10;
  const MAX_MO_RUNS = 40;
  let retryN = 0, retryTimer = 0, mo = null, moTimer = 0, moRuns = 0;

  /* 扩展被「重新加载 / 更新 / 停用」后，旧内容脚本会被孤立：`chrome.runtime` 变为 undefined，
     之后任何 api.runtime.sendMessage 都会抛 “Cannot read properties of undefined (reading 'sendMessage')”。
     这种脚本自己救不回来 → 自毁，让后台重新注入的新脚本接管。 */
  function ctxAlive() {
    try { return !!(api && api.runtime && api.runtime.id); } catch (e) { return false; }
  }

  function selfDestruct() {
    if (dead) return;
    dead = true;
    try { clearInterval(navTimer); } catch (e) { /* 忽略 */ }
    try { clearTimeout(retryTimer); } catch (e) { /* 忽略 */ }
    try { clearTimeout(moTimer); } catch (e) { /* 忽略 */ }
    try { if (mo) mo.disconnect(); } catch (e) { /* 忽略 */ }
    mo = null;
    try { if (host && host.parentNode) host.parentNode.removeChild(host); } catch (e) { /* 忽略 */ }
    try { if (readerHost && readerHost.parentNode) readerHost.parentNode.removeChild(readerHost); } catch (e) { /* 忽略 */ }
    host = null; root = null; refs = null;
    readerHost = null; readerRoot = null; readerRefs = null;
  }

  function bail() {
    try { return SKIP_HOSTS.test(location.hostname) || VIDEO_HOSTS.test(location.hostname) || !/^https?:$/.test(location.protocol); }
    catch (e) { return true; }
  }
  if (bail()) return;

  function isEnglishPath() {
    return !/\.(pdf|zip|rar|7z|mp4|mp3|png|jpe?g|gif|webp|svg|json|csv|xlsx?|docx?|pptx?)$/i.test(location.pathname);
  }

  /* ============================================================
     抽取（薄抽取：只做 DOM，不做判断）
     ============================================================ */
  const BLOCK_SEL = 'p, li, blockquote, h2, h3, h4';
  const NOISE_SEL = 'nav,header,footer,aside,form,script,style,noscript,figure,picture,svg,button,select';
  const CONTAINER_SEL = [
    'article', '[role="article"]', 'main', '[role="main"]',
    '.post-content', '.article-content', '.entry-content', '.markdown-body', '.rich_media_content',
    '.RichText', '.Post-RichText', '.article', '.post', '.entry', '.content', '#content'
  ];

  /* 特定站点（阅读器 / 期刊 / 杂志）的正文容器优先于通用选择器。
     这些站点的正文常常不在 <article> 里，通用打分容易抽偏。 */
  const SITE_RULES = [
    { host: /(^|\.)weread\.qq\.com$/i, sel: ['.readerChapterContent', '.app_content', '#js_content', '.wr_whiteTheme'] },
    { host: /(^|\.)(z-lib|zlib|1lib|z-librar|singlelogin|z-library)/i, sel: ['#bookReader', '#book-content', '.bookContent', '#readerContent', '.readerContent'] },
    { host: /(^|\.)annas-archive\.org$/i, sel: ['#main-content', '.js-book-content', 'main'] },
    { host: /(^|\.)book\.douban\.com$/i, sel: ['#content', '.note'] },
    { host: /(^|\.)(medium\.com|substack\.com)$/i, sel: ['article', 'main'] },
    { host: /(^|\.)(nytimes|economist|newyorker|theatlantic|wsj|ft|bloomberg|wired|arstechnica|theverge|bbc|theguardian|cnn|reuters|apnews)\./i, sel: ['article', '[role="article"]', 'main'] }
  ];

  function siteRuleRoot() {
    const host = location.hostname || '';
    for (const r of SITE_RULES) {
      if (!r.host.test(host)) continue;
      for (const sel of r.sel) {
        let el = null;
        try { el = document.querySelector(sel); } catch (e) { el = null; }
        if (el && visible(el)) return el;
      }
    }
    return null;
  }

  function visible(el) {
    if (!el || el.hidden) return false;
    try {
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.05) return false;
    } catch (e) { /* 忽略 */ }
    return true;
  }

  function collectFrom(container, cap) {
    const out = [];
    let els;
    try { els = container.querySelectorAll(BLOCK_SEL); } catch (e) { return out; }
    for (let i = 0; i < els.length && out.length < cap; i++) {
      const b = els[i];
      if (b.closest(NOISE_SEL)) continue;
      if (!visible(b)) continue;
      const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 24) continue;
      out.push(t);
    }
    return out;
  }

  function scoreParas(paras) {
    let chars = 0;
    for (const p of paras) chars += p.length;
    return paras.length * 60 + chars;
  }

  function extractArticle() {
    const h1 = document.querySelector('h1');
    const title = ((h1 && h1.textContent) || document.title || '').replace(/\s+/g, ' ').trim().slice(0, 180);

    let best = null, bestScore = 0, bestSel = '', bestEl = null;
    const seen = new Set();
    for (const sel of CONTAINER_SEL) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        const paras = collectFrom(el, 400);
        if (paras.length < MIN_PARAS) continue;
        const sc = scoreParas(paras);
        if (sc > bestScore) { bestScore = sc; best = paras; bestSel = sel; bestEl = el; }
      }
    }
    if (!best) {
      const paras = collectFrom(document.body, 400);
      if (paras.length >= MIN_PARAS) { best = paras; bestSel = 'body'; bestEl = document.body; }
    }
    return { title, paras: best || [], container: bestSel, el: bestEl };
  }

  /* ============================================================
     样式（Shadow DOM 隔离，避免被站点样式污染）
     ============================================================ */
  const TONE = { ok: '#2e9e6b', good: '#3b82f6', warn: '#d98a19', bad: '#d64545' };
  const STATUS_TXT = { known: '已学', learning: '在学', new: '生词本', unknown: '未收录' };

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .wrap {
    position: fixed; z-index: 2147483000;
    left: 0; top: 0;                 /* 实际位置由 JS 计算：默认「右下角」，可拖动并记忆 */
    font: 13px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    color: #e8eaf0; --tone: #6b7280; --bg: rgba(20,23,29,.86); --line: rgba(255,255,255,.10);
  }
  .wrap[hidden] { display: none; }
  .wrap[data-drag="1"] { user-select: none; -webkit-user-select: none; }
  .pill {
    display: inline-flex; align-items: center; gap: 7px; height: 34px; padding: 0 13px 0 11px;
    cursor: grab; border: 1px solid var(--line); border-radius: 999px; background: var(--bg);
    backdrop-filter: blur(14px) saturate(1.4); -webkit-backdrop-filter: blur(14px) saturate(1.4);
    box-shadow: 0 6px 22px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.06);
    color: inherit; font: inherit; font-weight: 600; touch-action: none;
    transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
  }
  .wrap[data-drag="1"] .pill { cursor: grabbing; transition: none; }
  .pill:hover { transform: translateY(-1px); box-shadow: 0 10px 26px rgba(0,0,0,.42); border-color: rgba(255,255,255,.2); }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone); flex: none; }
  .pill .lv { color: var(--tone); letter-spacing: .02em; }
  .pill .cov { font-variant-numeric: tabular-nums; color: #fff; }
  .pill .sep { width: 1px; height: 14px; background: var(--line); }
  .pill .mini { font-weight: 500; color: #a8adba; }
  .pill[data-state="loading"] .dot { animation: pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.15); } }

  .panel {
    position: absolute; right: 0; bottom: calc(100% + 10px); width: 330px;
    max-height: min(74vh, 600px); overflow: hidden auto;
    border: 1px solid var(--line); border-radius: 16px;
    background: linear-gradient(180deg, rgba(28,31,38,.97), rgba(17,19,24,.98));
    backdrop-filter: blur(18px) saturate(1.5); -webkit-backdrop-filter: blur(18px) saturate(1.5);
    box-shadow: 0 22px 60px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
    opacity: 0; transform: translateY(8px) scale(.985); pointer-events: none;
    transition: opacity .18s ease, transform .18s ease;
  }
  .wrap[data-open="1"] .panel { opacity: 1; transform: none; pointer-events: auto; }
  .panel::-webkit-scrollbar { width: 8px; }
  .panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 8px; }
  /* 拖到另半屏 / 靠顶时，面板改朝屏幕内侧展开，避免出界 */
  .wrap[data-side="left"] .panel { right: auto; left: 0; }
  .wrap[data-v="down"] .panel { bottom: auto; top: calc(100% + 10px); }

  .ph { display: flex; align-items: flex-start; gap: 10px; padding: 14px 14px 10px; }
  .ph-logo { width: 26px; height: 26px; border-radius: 8px; flex: none; background: linear-gradient(140deg, #f0b429, #d97706); display: grid; place-items: center; color: #1a1407; font-weight: 800; font-size: 13px; }
  .ph-main { flex: 1; min-width: 0; }
  .ph-t { font-size: 12px; color: #9aa1b0; }
  .ph-t .host { color: #cfd4de; font-weight: 600; }
  .ph-title { font-size: 13px; font-weight: 600; color: #fff; margin-top: 3px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
  .ph-x { border: 0; background: transparent; color: #7d8494; cursor: pointer; font-size: 15px; line-height: 1; padding: 3px 5px; border-radius: 7px; }
  .ph-x:hover { background: rgba(255,255,255,.08); color: #fff; }

  .body { padding: 0 14px 14px; }

  .sw { display: flex; gap: 3px; padding: 3px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.07); border-radius: 10px; margin-bottom: 12px; }
  .sw button { flex: 1; border: 0; background: transparent; color: #98a0b0; font: inherit; font-size: 11.5px; font-weight: 600; padding: 5px 0; border-radius: 7px; cursor: pointer; }
  .sw button:hover { color: #dfe3ea; }
  .sw button[data-on="1"] { background: rgba(255,255,255,.12); color: #fff; }

  .hero { display: flex; gap: 12px; align-items: center; padding: 2px 0 12px; }
  .big { flex: none; min-width: 84px; text-align: center; padding: 10px 8px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--tone) 40%, transparent); background: color-mix(in srgb, var(--tone) 14%, transparent); }
  .big .code { font-size: 24px; font-weight: 800; line-height: 1; color: var(--tone); font-variant-numeric: tabular-nums; }
  .big .cap { font-size: 10px; color: #98a0b0; margin-top: 4px; }
  .hero-main { flex: 1; min-width: 0; }
  .tier { font-size: 12.5px; font-weight: 700; color: #fff; }
  .sub { font-size: 11.5px; color: #98a0b0; margin-top: 4px; line-height: 1.45; }
  .all { font-size: 11px; color: #8b93a3; margin-top: 6px; }
  .all b { color: #cfd4de; font-weight: 600; }

  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 2px 0 12px; }
  .cell { background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.06); border-radius: 10px; padding: 8px 6px; text-align: center; }
  .cell b { display: block; font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; color: #fff; }
  .cell span { display: block; font-size: 10px; color: #8b93a3; margin-top: 2px; }

  .sec { margin-bottom: 12px; }
  .sec-h { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #8b93a3; margin-bottom: 6px; }
  .sec-h b { color: #cfd4de; font-weight: 600; }
  .bar { display: flex; height: 8px; border-radius: 6px; overflow: hidden; background: rgba(255,255,255,.06); }
  .bar i { display: block; height: 100%; }
  .bar .b1 { background: #2e9e6b; } .bar .b2 { background: #4a9be8; }
  .bar .b3 { background: #d98a19; } .bar .b4 { background: #d97757; } .bar .b5 { background: #8b5cf6; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 6px; font-size: 10.5px; color: #8b93a3; }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .legend em { width: 7px; height: 7px; border-radius: 2px; font-style: normal; }

  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { font-size: 11.5px; padding: 3px 8px; border-radius: 7px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.07); color: #dfe3ea; }
  .chip b { font-weight: 700; color: #fff; }
  .chip em { font-style: normal; color: #8b93a3; font-size: 10px; margin-left: 3px; }
  .chip[data-s="new"] { border-color: color-mix(in srgb, #d64545 42%, transparent); }
  .chip[data-s="unknown"] { border-color: color-mix(in srgb, #f0b429 40%, transparent); }
  .chip[data-s="learning"] { border-color: color-mix(in srgb, #3b82f6 42%, transparent); }

  .btn { border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.05); color: #dfe3ea; border-radius: 8px; padding: 4px 9px; font: inherit; font-size: 11px; cursor: pointer; }
  .btn:hover { background: rgba(255,255,255,.1); }
  .btn.main { width: 100%; padding: 9px 0; font-size: 12.5px; font-weight: 700; border-radius: 10px; background: linear-gradient(140deg, #f0b429, #d97706); color: #1a1407; border: 0; margin-bottom: 10px; }
  .btn.main:hover { filter: brightness(1.08); }

  .foot { display: flex; align-items: center; gap: 8px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.07); font-size: 10.5px; color: #7d8494; }
  .foot .src { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .note { font-size: 11.5px; color: #98a0b0; line-height: 1.5; padding: 2px 0 4px; }
  .note b { color: #f0a86a; }
  .skel { height: 80px; display: grid; place-items: center; color: #8b93a3; font-size: 12px; }

  /* ---------- 阅读模式 ---------- */
  .reader {
    position: fixed; inset: 0; z-index: 2147483001; background: #14161b;
    color: #e6e8ee; font: 17px/1.85 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    display: none; flex-direction: column;
  }
  .reader[data-on="1"] { display: flex; }
  .rd-bar { flex: none; display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid rgba(255,255,255,.08); background: rgba(20,22,27,.96); backdrop-filter: blur(10px); }
  .rd-bar .t { font: 600 13px/1.4 inherit; color: #dfe3ea; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34vw; }
  .rd-bar .grow { flex: 1; }
  .rd-sum { font-size: 12px; color: #9aa1b0; white-space: nowrap; }
  .rd-sum b { color: #fff; }
  .rd-sw { display: flex; gap: 3px; padding: 3px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); border-radius: 9px; }
  .rd-sw button { border: 0; background: transparent; color: #98a0b0; font: inherit; font-size: 11.5px; font-weight: 600; padding: 4px 9px; border-radius: 6px; cursor: pointer; }
  .rd-sw button[data-on="1"] { background: rgba(255,255,255,.13); color: #fff; }
  .rd-bar .btn { font-size: 11.5px; padding: 5px 10px; }
  .rd-body { flex: 1; overflow: auto; padding: 32px 0 120px; }
  .rd-page { max-width: 760px; margin: 0 auto; padding: 0 24px; }
  .rd-page h1 { font: 700 27px/1.35 inherit; margin: 0 0 8px; color: #fff; letter-spacing: .01em; }
  .rd-meta { font-size: 12px; color: #7d8494; margin-bottom: 26px; padding-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,.07); }
  .rd-page p { margin: 0 0 1.05em; }
  .rd-page h2, .rd-page h3 { font: 700 19px/1.4 inherit; margin: 1.5em 0 .6em; color: #fff; }
  .w { cursor: pointer; border-radius: 3px; padding: 1px 0; }
  .w-learning { color: #93c5fd; border-bottom: 1.5px solid rgba(59,130,246,.75); }
  .w-new { color: #fca5a5; border-bottom: 1.5px solid rgba(214,69,69,.8); }
  .w-unknown { color: #fcd34d; border-bottom: 1.5px dotted rgba(240,180,41,.75); }
  .w:hover { background: rgba(255,255,255,.12); }
  .reader[data-dim="1"] .w-known { opacity: .28; }

  /* ---------- 词组（离线词组库）：整组画【一条不断的线】，组内单词自己不再画线 ---------- */
  .ph { text-decoration: underline dotted rgba(240,180,41,.75); text-decoration-thickness: 1px; text-underline-offset: 4px; cursor: pointer; }
  .ph[data-off="1"] { text-decoration-color: rgba(240,180,41,.9); }
  .ph .w, .ph .w-unknown, .ph .w-learning, .ph .w-new, .ph .w-known { text-decoration: none; }
  .ph:hover { background: rgba(255,255,255,.1); }

  /* ---------- 段落翻译（每段末尾的「译」） ---------- */
  .para-tr {
    margin-left: .35em; padding: 0 .36em; vertical-align: .06em;
    font-size: .72em; line-height: 1.5; font-family: inherit;
    color: #8b93a3; background: transparent;
    border: 1px solid rgba(255,255,255,.14); border-radius: 4px; cursor: pointer;
    opacity: .42; transition: opacity .15s, color .15s, border-color .15s;
  }
  .rd-page p:hover .para-tr { opacity: 1; }
  .para-tr:hover, .para-tr.on { color: #f0b429; border-color: rgba(240,180,41,.6); opacity: 1; }
  .para-trans {
    display: block; margin: .5rem 0 .2rem; padding: .5rem .7rem;
    font-size: .88em; line-height: 1.75; color: #cfd4de;
    background: rgba(240,180,41,.08); border-left: 3px solid rgba(240,180,41,.7);
    border-radius: 0 8px 8px 0; text-align: left;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .para-trans .pt-line { display: block; }
  .para-trans .pt-src { display: block; font-size: .7em; color: #8b93a3; margin-bottom: .25rem; }
  .para-trans .pt-note { font-size: .8em; color: #8b93a3; }

  /* 词组卡片：「分开看」词块 */
  .card .phk { font-size: 11px; color: #8b93a3; margin: -2px 0 6px; }
  .card .wp-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
  .card .wp-chip { border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05); color: #dfe3ea; border-radius: 7px; padding: 3px 8px; font: inherit; font-size: 12px; cursor: pointer; }
  .card .wp-chip:hover { background: rgba(255,255,255,.12); }
  .card .ph-loading { color: #8b93a3; }
  .card .st[data-s="ph"] { color: #f0b429; border-color: rgba(240,180,41,.5); }

  .rd-legend { display: flex; gap: 16px; flex-wrap: wrap; font-size: 11.5px; color: #8b93a3; margin-top: 28px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,.07); }
  .rd-legend i { display: inline-block; width: 22px; height: 0; border-bottom-width: 2px; border-bottom-style: solid; vertical-align: middle; margin-right: 5px; }

  .card { position: fixed; z-index: 2147483002; width: 300px; max-height: 46vh; overflow: auto; padding: 12px 13px; border-radius: 12px; border: 1px solid rgba(255,255,255,.13); background: rgba(24,26,32,.98); box-shadow: 0 18px 48px rgba(0,0,0,.6); color: #e6e8ee; font: 12.5px/1.6 -apple-system, "Segoe UI", "PingFang SC", system-ui, sans-serif; }
  .card[hidden] { display: none; }
  .card .hd { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .card .wd { font-size: 16px; font-weight: 700; color: #fff; }
  .card .ph-txt { font-size: 12px; color: #93c5fd; }
  .card .st { margin-left: auto; font-size: 10.5px; padding: 2px 7px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14); color: #cfd4de; }
  .card .st[data-s="learning"] { color: #93c5fd; border-color: rgba(59,130,246,.5); }
  .card .st[data-s="new"] { color: #fca5a5; border-color: rgba(214,69,69,.5); }
  .card .st[data-s="unknown"] { color: #fcd34d; border-color: rgba(240,180,41,.5); }
  .card .mn { white-space: pre-wrap; color: #dfe3ea; }
  .card .mn.empty { color: #8b93a3; }
  .card .ft { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.08); display: flex; gap: 8px; align-items: center; font-size: 11px; color: #7d8494; }

  /* ---------- 释义卡片：标记按钮 ---------- */
  .card .mk { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
  .card .mk button { flex: 1 1 auto; min-width: 62px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05); color: #cfd4de; border-radius: 7px; padding: 5px 8px; font: inherit; font-size: 11px; cursor: pointer; white-space: nowrap; }
  .card .mk button:hover { background: rgba(255,255,255,.11); color: #fff; }
  .card .mk button[data-on="1"] { border-color: currentColor; background: rgba(255,255,255,.14); color: #fff; font-weight: 700; }
  .card .mk button[data-mk="new"] { color: #fca5a5; }
  .card .mk button[data-mk="learning"] { color: #93c5fd; }
  .card .mk button[data-mk="known"] { color: #86efac; }
  .card .mk .clr { flex: 0 0 auto; color: #9aa1b0; }

  /* ---------- 选中文本：浮动工具条 ---------- */
  .selbar { position: fixed; z-index: 2147483002; display: none; align-items: center; gap: 4px;
    padding: 5px; border-radius: 11px; border: 1px solid rgba(255,255,255,.14);
    background: rgba(24,26,32,.97); box-shadow: 0 14px 40px rgba(0,0,0,.55); color: #e6e8ee;
    font: 12px/1.4 -apple-system, "Segoe UI", "PingFang SC", system-ui, sans-serif; }
  .selbar[data-on="1"] { display: flex; }
  .selbar button { border: 0; background: transparent; color: #dfe3ea; font: inherit; font-size: 11.5px; font-weight: 600; padding: 5px 9px; border-radius: 7px; cursor: pointer; white-space: nowrap; }
  .selbar button:hover { background: rgba(255,255,255,.12); }
  .selbar button[data-act="hl-add"] { color: #fcd34d; }
  .selbar button[data-act="hl-del"] { color: #9aa1b0; }
  .selbar .note-in { border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05); color: #e6e8ee;
    border-radius: 7px; padding: 5px 8px; font: inherit; font-size: 11.5px; width: 180px; }
  .selbar .note-in[hidden] { display: none; }

  /* ---------- 面板：开关与标记区 ---------- */
  .toggles { display: flex; gap: 6px; margin-bottom: 10px; }
  .tg { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid rgba(255,255,255,.1);
    background: rgba(255,255,255,.045); color: #b9c0cd; border-radius: 9px; padding: 7px 6px; font: inherit; font-size: 11.5px; cursor: pointer; }
  .tg:hover { background: rgba(255,255,255,.09); color: #fff; }
  .tg[data-on="1"] { border-color: rgba(240,180,41,.5); background: rgba(240,180,41,.14); color: #ffd98a; font-weight: 700; }
  .tg i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; font-style: normal; }
  .mks { display: flex; flex-wrap: wrap; gap: 5px; }
  .mks .mk-chip { font-size: 11.5px; padding: 3px 8px; border-radius: 7px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.09); color: #dfe3ea; cursor: pointer; }
  .mks .mk-chip em { font-style: normal; font-size: 10px; margin-left: 4px; color: #8b93a3; }
  .mks .mk-chip[data-s="new"] { border-color: color-mix(in srgb, #d64545 45%, transparent); }
  .mks .mk-chip[data-s="learning"] { border-color: color-mix(in srgb, #3b82f6 45%, transparent); }
  .mks .mk-chip[data-s="known"] { border-color: color-mix(in srgb, #2e9e6b 45%, transparent); }
  .hl-item { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.06); font-size: 11.5px; color: #cfd4de; }
  .hl-item .tx { flex: 1; min-width: 0; }
  .hl-item .nt { color: #8b93a3; font-size: 10.5px; margin-top: 2px; }
  .hl-item button { border: 0; background: transparent; color: #7d8494; cursor: pointer; font-size: 12px; padding: 2px 5px; border-radius: 6px; }
  .hl-item button:hover { background: rgba(255,255,255,.1); color: #fff; }
  `;

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /* 多行文本 → HTML：把词典数据里的「字面量 \n」与真实换行统一转 <br>，与 web/js/util.js#escLines 同口径 */
  const escLines = s => esc(s)
    .replace(/\\r\\n|\\n|\\r/g, '<br>')
    .replace(/\r\n|\r|\n/g, '<br>');
  const ratingText = r => (r ? r.code : '—');

  /* ============================================================
     胶囊 + 面板
     ============================================================ */
  function mount() {
    if (host) return;
    /* 幂等：旧的孤立脚本可能已挂过根节点，先摘掉，避免页面出现两个胶囊 */
    try {
      const stale = document.getElementById('inkread-article-root');
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    } catch (e) { /* 忽略 */ }
    host = document.createElement('div');
    host.id = 'inkread-article-root';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;';
    const sr = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    sr.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.setAttribute('hidden', '');
    wrap.setAttribute('data-open', '0');
    wrap.innerHTML = `
      <button class="pill" data-state="loading">
        <span class="dot"></span>
        <span class="lv">…</span>
        <span class="cov"></span>
        <span class="sep"></span>
        <span class="mini">分析中</span>
      </button>
      <section class="panel" role="dialog" aria-label="InkRead 文章生词分析">
        <div class="ph">
          <div class="ph-logo">读</div>
          <div class="ph-main">
            <div class="ph-t"><span class="host">—</span></div>
            <div class="ph-title">—</div>
          </div>
          <button class="ph-x" title="收起">✕</button>
        </div>
        <div class="body"><div class="skel">正在抽取正文并比对词库…</div></div>
      </section>
      <div class="card" hidden></div>
      <div class="selbar" data-on="0">
        <button data-act="hl-add">划线</button>
        <button data-act="hl-del" hidden>取消划线</button>
        <button data-act="note">笔记</button>
        <input class="note-in" placeholder="写点想法，回车保存" hidden>
      </div>`;
    sr.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);

    refs = {
      wrap,
      pill: wrap.querySelector('.pill'),
      lv: wrap.querySelector('.lv'),
      cov: wrap.querySelector('.cov'),
      mini: wrap.querySelector('.mini'),
      host: wrap.querySelector('.host'),
      title: wrap.querySelector('.ph-title'),
      body: wrap.querySelector('.body'),
      card: wrap.querySelector('.card'),
      selbar: wrap.querySelector('.selbar'),
      noteIn: wrap.querySelector('.note-in')
    };
    bindDrag(wrap, refs.pill);
    wrap.querySelector('.ph-x').addEventListener('click', () => toggle(false));
    bindSelbar();
    root = sr;
  }

  /* ---------- 拖动 / 定位 ----------
     与视频侧 content.js 同一套做法：pointer 事件（鼠标/触屏通用）；
     抖动 < 4px 视为点击（展开/收起），否则算拖动并记忆位置。 */
  function bindDrag(wrap, pill) {
    pill.addEventListener('pointerdown', e => {
      if (e.button != null && e.button !== 0) return;
      const rect = wrap.getBoundingClientRect();
      dragging = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top, moved: false };
      try { pill.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });
    pill.addEventListener('pointermove', e => {
      if (!dragging || e.pointerId !== dragging.id) return;
      const dx = e.clientX - dragging.sx, dy = e.clientY - dragging.sy;
      if (!dragging.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      dragging.moved = true;
      wrap.setAttribute('data-drag', '1');
      const w = wrap.offsetWidth || 132, h = wrap.offsetHeight || 34;
      const left = clampNum(dragging.ox + dx, POS_PAD, Math.max(POS_PAD, window.innerWidth - w - POS_PAD));
      const top = clampNum(dragging.oy + dy, POS_PAD, Math.max(POS_PAD, window.innerHeight - h - POS_PAD));
      wrap.style.left = Math.round(left) + 'px';
      wrap.style.top = Math.round(top) + 'px';
      updateSide(left, w, top);
      e.preventDefault();
    });
    const endDrag = e => {
      if (!dragging) return;
      if (e && e.pointerId != null && e.pointerId !== dragging.id) return;
      const moved = dragging.moved;
      dragging = null;
      wrap.removeAttribute('data-drag');
      if (e && e.pointerId != null) { try { pill.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ } }
      if (moved) { suppressClick = true; savePos(); }
    };
    pill.addEventListener('pointerup', endDrag);
    pill.addEventListener('pointercancel', endDrag);
    pill.addEventListener('click', e => {
      if (suppressClick) { suppressClick = false; e.preventDefault(); return; }
      toggle(!open);
    });
  }

  const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* 默认「右下角」；存过位置就用存的 */
  function readPos() {
    const p = settings.article && settings.article.pos;
    if (p && typeof p.x === 'number' && typeof p.y === 'number') {
      return { x: clampNum(p.x, 0, 1), y: clampNum(p.y, 0, 1) };
    }
    return { x: 1, y: 1 };
  }

  function updateSide(left, w, top) {
    if (!refs) return;
    refs.wrap.setAttribute('data-side', (left + w / 2) > window.innerWidth / 2 ? 'right' : 'left');
    refs.wrap.setAttribute('data-v', top > Math.min(340, window.innerHeight * 0.5) ? 'up' : 'down');
  }

  function placeWrap(fx, fy) {
    if (!refs) return;
    const wrap = refs.wrap;
    const w = wrap.offsetWidth || 132, h = wrap.offsetHeight || 34;
    const maxX = Math.max(0, window.innerWidth - w - POS_PAD * 2);
    const maxY = Math.max(0, window.innerHeight - h - POS_PAD * 2);
    const left = Math.round(POS_PAD + clampNum(fx, 0, 1) * maxX);
    const top = Math.round(POS_PAD + clampNum(fy, 0, 1) * maxY);
    wrap.style.left = left + 'px';
    wrap.style.top = top + 'px';
    updateSide(left, w, top);
  }

  function applyPrefs() {
    if (!host || !refs) return;
    const p = readPos();
    placeWrap(p.x, p.y);
  }

  async function savePos() {
    if (!refs) return;
    const wrap = refs.wrap;
    const w = wrap.offsetWidth || 132, h = wrap.offsetHeight || 34;
    const left = parseFloat(wrap.style.left) || 0, top = parseFloat(wrap.style.top) || 0;
    const maxX = Math.max(1, window.innerWidth - w - POS_PAD * 2);
    const maxY = Math.max(1, window.innerHeight - h - POS_PAD * 2);
    const pos = {
      x: +clampNum((left - POS_PAD) / maxX, 0, 1).toFixed(4),
      y: +clampNum((top - POS_PAD) / maxY, 0, 1).toFixed(4)
    };
    settings.article = Object.assign({}, settings.article, { pos });
    await patchSettings({ article: { pos } });
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!host || dragging) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!dragging) applyPrefs(); }, 150);
  });

  function toggle(v) {
    open = v;
    if (!refs) return;
    refs.wrap.setAttribute('data-open', v ? '1' : '0');
    if (v && payload) renderPanel();
  }

  function showPill(state, mini) {
    if (!host || !refs) return;
    if (!settings.article.autoPill) { refs.wrap.setAttribute('hidden', ''); return; }
    refs.wrap.removeAttribute('hidden');
    if (!dragging) applyPrefs();     /* 可见后再定位，尺寸测量才准 */
    refs.pill.setAttribute('data-state', state);
    if (mini != null) refs.mini.textContent = mini;
  }

  function hidePill() { if (refs) refs.wrap.setAttribute('hidden', ''); }

  function renderPill() {
    if (!refs || !payload || !payload.ok) return;
    const r = payload.report;
    const rating = (r.ratings || {})[settings.rating.system] || (r.ratings || {}).step || {};
    refs.wrap.style.setProperty('--tone', TONE[rating.tone] || '#6b7280');
    refs.lv.textContent = ratingText(rating);
    refs.cov.textContent = Math.round(r.coverage * 100) + '%';
    refs.mini.textContent = rating.text || '文章';
  }

  function switcherHtml() {
    const cur = settings.rating.system;
    const items = [['step', 'L1–L4'], ['cefr', 'CEFR'], ['lexile', '蓝思']];
    return `<div class="sw">${items.map(([id, label]) =>
      `<button data-rate="${id}" data-on="${cur === id ? 1 : 0}">${label}</button>`).join('')}</div>`;
  }

  function allRatingsHtml(r) {
    const x = r.ratings || {};
    const parts = [];
    if (x.step) parts.push(`阶梯 <b>${esc(x.step.code)}</b>`);
    if (x.cefr) parts.push(`CEFR <b>${esc(x.cefr.code)}</b>`);
    if (x.lexile) parts.push(`蓝思 <b>${esc(x.lexile.code)}</b>`);
    return parts.join(' · ') || '—';
  }

  function bandBar(f) {
    const t = f.bandTok || { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const sum = Math.max(1, t[1] + t[2] + t[3] + t[4] + t[5]);
    const pc = n => (n / sum * 100).toFixed(2) + '%';
    const names = { 1: '核心 1000', 2: '常用 2500', 3: '进阶 5000', 4: '高阶 5000+', 5: '生僻/专名' };
    const colors = { 1: '#2e9e6b', 2: '#4a9be8', 3: '#d98a19', 4: '#d97757', 5: '#8b5cf6' };
    return `<div class="bar">${[1, 2, 3, 4, 5].map(b => `<i class="b${b}" style="width:${pc(t[b])}"></i>`).join('')}</div>
      <div class="legend">${[1, 2, 3, 4, 5].map(b => `<span><em style="background:${colors[b]}"></em>${names[b]} ${Math.round(t[b] / sum * 100)}%</span>`).join('')}</div>`;
  }

  function renderPanel() {
    if (!refs) return;
    const r = payload && payload.report;
    if (!r) { refs.body.innerHTML = '<div class="note">还没有可展示的结果。</div>'; return; }

    refs.host.textContent = r.siteLabel || location.hostname;
    refs.title.textContent = r.title || document.title || '(无标题)';

    const rating = (r.ratings || {})[settings.rating.system] || (r.ratings || {}).step || {};
    refs.wrap.style.setProperty('--tone', TONE[rating.tone] || '#6b7280');

    const top = (r.topUnknown || []).slice(0, 16);
    const f = r.freq || { bandTok: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };

    refs.body.innerHTML = `
      ${switcherHtml()}
      <div class="hero">
        <div class="big">
          <div class="code">${esc(rating.code || '—')}</div>
          <div class="cap">${esc(rating.text || '')}</div>
        </div>
        <div class="hero-main">
          <div class="tier">${esc(rating.tier || '')}</div>
          <div class="sub">${esc(rating.desc || '')}</div>
          <div class="all">三套体系：${allRatingsHtml(r)}</div>
        </div>
      </div>

      <button class="btn main" data-act="read">进入阅读模式</button>

      <div class="toggles">
        <button class="tg" data-act="inline" data-on="${(settings.article.inlineColor && !isSiteOff()) ? 1 : 0}">
          <i></i>网页上色
        </button>
        <button class="tg" data-act="style" data-on="${(settings.article.inlineStyle || 'line') === 'mark' ? 1 : 0}">
          <i></i>${(settings.article.inlineStyle || 'line') === 'mark' ? '底色' : '下划线'}
        </button>
      </div>

      <div class="grid">
        <div class="cell"><b>${r.tokens}</b><span>总词次</span></div>
        <div class="cell"><b>${r.unique}</b><span>独立词</span></div>
        <div class="cell"><b>${r.missTok}</b><span>生词词次</span></div>
        <div class="cell"><b>${r.density}</b><span>生词/百词</span></div>
      </div>

      <div class="sec">
        <div class="sec-h"><span>客观难度（脱离你的词库）</span><b>${allRatingsHtml(r)}</b></div>
        ${bandBar(f)}
      </div>

      <div class="sec">
        <div class="sec-h"><span>高频生词（先攻这些收益最大）</span><b>${top.length ? 'Top ' + top.length : ''}</b></div>
        ${top.length
          ? `<div class="chips">${top.map(t => `<span class="chip" data-s="${esc(t.s)}" title="${esc(STATUS_TXT[t.s] || t.s)}${t.bandName ? ' · ' + esc(t.bandName) + '词' : ''}"><b>${esc(t.w)}</b><em>×${t.c}</em></span>`).join('')}</div>`
          : `<div class="sub">没有生词——这篇文章对你几乎没有词汇门槛。</div>`}
      </div>

      ${marksSectionHtml()}

      <div class="foot">
        <span class="src">词库：${esc(vocabText(r))}</span>
        <button class="btn" data-act="reload">重新分析</button>
      </div>`;

    bindPanel();
  }

  /** 面板里的「我的标记 / 划线」区块：点词可直接改状态，划线可删 */
  function marksSectionHtml() {
    const mw = Object.keys(marksWords || {});
    const hls = pageHighlights || [];
    if (!mw.length && !hls.length) {
      return `<div class="sec">
        <div class="sec-h"><span>我的标记</span><b></b></div>
        <div class="sub">直接在网页上点词即可标记（生词本 / 在学 / 已学）；选中句子可以划线。</div>
      </div>`;
    }
    const onPage = mw.filter(w => {
      const rep = payload && payload.report;
      return rep && (rep.topUnknown || []).some(t => String(t.w).toLowerCase() === w);
    });
    const list = (onPage.length ? onPage : mw).slice(0, 24);
    return `<div class="sec">
      <div class="sec-h"><span>我的标记</span><b>${mw.length} 词 · ${hls.length} 划线</b></div>
      ${list.length ? `<div class="mks">${list.map(w => {
        const st = (marksWords[w] || {}).status || 'unknown';
        return `<span class="mk-chip" data-s="${esc(st)}" data-word="${esc(w)}" title="点击改/取消标记">${esc(w)}<em>${esc(STATUS_TXT[st] || st)}</em></span>`;
      }).join('')}</div>` : ''}
      ${hls.length ? `<div style="margin-top:8px">${hls.map(h => `<div class="hl-item">
        <div class="tx">${esc(h.text.length > 90 ? h.text.slice(0, 90) + '…' : h.text)}${h.note ? `<div class="nt">📝 ${esc(h.note)}</div>` : ''}</div>
        <button data-hl="${esc(h.id)}" title="删除这条划线">✕</button>
      </div>`).join('')}</div>` : ''}
    </div>`;
  }

  function vocabText(r) {
    const v = r.vocab || {};
    if (v.mode === 'off') return '未联动（空词库）';
    if (v.ok && v.count) return `${v.label || '墨读'} · ${v.count} 词`;
    if (v.count) return `${v.label || '导入文件'} · ${v.count} 词（离线缓存）`;
    return v.error || '未联动';
  }

  function bindPanel() {
    refs.body.querySelectorAll('[data-rate]').forEach(b => b.addEventListener('click', () => setRating(b.dataset.rate)));
    const read = refs.body.querySelector('[data-act="read"]');
    if (read) read.addEventListener('click', () => { toggle(false); openReader(false); });
    const rl = refs.body.querySelector('[data-act="reload"]');
    if (rl) rl.addEventListener('click', () => probe(true));
    const il = refs.body.querySelector('[data-act="inline"]');
    if (il) il.addEventListener('click', () => toggleInline());
    const st = refs.body.querySelector('[data-act="style"]');
    if (st) st.addEventListener('click', () => toggleStyle());
    /* 点标记 chip：new → learning → known → 取消 */
    refs.body.querySelectorAll('.mk-chip').forEach(c => c.addEventListener('click', () => {
      const w = c.dataset.word;
      const cur = (marksWords[String(w).toLowerCase()] || {}).status || null;
      const order = ['new', 'learning', 'known'];
      const i = order.indexOf(cur);
      markWord(w, i < 0 ? 'new' : (i >= order.length - 1 ? null : order[i + 1]));
    }));
    /* 删划线 */
    refs.body.querySelectorAll('[data-hl]').forEach(b => b.addEventListener('click', () => delHighlight(b.dataset.hl)));
  }

  function toggleStyle() {
    const next = (settings.article.inlineStyle || 'line') === 'mark' ? 'line' : 'mark';
    settings.article.inlineStyle = next;
    patchSettings({ article: { inlineStyle: next } });
    restyleAll();
    applyHighlights();
    if (open) renderPanel();
  }

  async function setRating(id) {
    settings.rating = { system: id };
    patchSettings({ rating: { system: id } });
    try { await api.runtime.sendMessage({ type: 'ratingChanged', system: id }); } catch (e) { /* 忽略 */ }
    renderPill();
    if (open) renderPanel();
    if (readerRoot) renderReaderChrome();
  }

  /* 只补丁式写回设置：先读当前值再深合并，避免把 link / subs 等字段整块冲掉。
     （曾写成「用内存快照整体覆盖 iv.settings」，会把用户的词库联动配置清空。） */
  let settingsWrite = Promise.resolve();
  function patchSettings(patch) {
    settingsWrite = settingsWrite.then(async () => {
      try {
        const r = await api.storage.local.get('iv.settings');
        const cur = (r && r['iv.settings']) || {};
        await api.storage.local.set({ 'iv.settings': deepMerge(cur, patch) });
      } catch (e) { /* 忽略 */ }
    }).catch(() => { });
    return settingsWrite;
  }

  function deepMerge(base, patch) {
    const out = Object.assign({}, base);
    for (const k of Object.keys(patch || {})) {
      const pv = patch[k], bv = base ? base[k] : undefined;
      out[k] = (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv))
        ? deepMerge(bv, pv) : pv;
    }
    return out;
  }

  /* ============================================================
     探测 / 分析
     ============================================================ */
  async function probe(force, opts) {
    if (probing || dead) return;
    if (!ctxAlive()) { selfDestruct(); return; }
    const explicit = !!(opts && opts.explicit);       /* 用户主动点开阅读模式时，忽略「自动胶囊」开关 */
    if (!explicit && !settings.article.enabled) { clearInline(); hidePill(); return; }
    if (!isEnglishPath()) { clearInline(); hidePill(); return; }

    mount();
    const ex = extractArticle();
    /* 正文还没渲染出来（SPA / 客户端 hydrate）→ 退避重试，别一次探空就永久放弃 */
    if (!ex.paras.length) { clearInline(); hidePill(); scheduleRetry(); return; }
    lastExtract = ex;

    probing = true;
    showPill('loading', '分析中');
    try {
      const res = await api.runtime.sendMessage({
        type: 'analyzeArticle',
        href: location.href,
        urlKey: pageKey(),
        title: ex.title || document.title,
        paras: ex.paras,
        force: !!force
      });
      if (!res || !res.ok) {
        payload = { ok: false, reason: (res && res.reason) || '无法分析这个页面' };
        clearInline();
        hidePill();
        scheduleRetry();          /* 内容仍可能没加载完（正文异步注入）→ 再等等 */
        return;
      }
      payload = res;
      markReady();
      marksWords = (res.marks && res.marks.words) || {};
      pageHighlights = res.highlights || [];
      renderPill();
      showPill('ok');
      updateInlineToggle();
      /* 直接在网页上着色：不用进阅读模式也能看哪个词没掌握 */
      if (settings.article.inlineColor && !isSiteOff()) applyInline();
      if (open) renderPanel();
    } catch (e) {
      const m = String((e && e.message) || e);
      /* 上下文失效：自毁，等后台重新注入 */
      if (!ctxAlive() || /context invalidated|Receiving end does not exist|reading 'sendMessage'/.test(m)) {
        selfDestruct(); return;
      }
      payload = { ok: false, reason: '与扩展后台通信失败：' + m };
      clearInline();
      hidePill();
      scheduleRetry();
    } finally {
      probing = false;
    }
  }

  /* ---------- 「内容就绪」重试 ----------
     很多站点（含 Next.js/React SSR + hydrate）首屏 HTML 里没有正文 <p>，
     要等客户端 JS 渲染完才有。若只在 onNav 里探一次、之后 href 不变就永不再探，
     这类页面会一直「识别不了」。这里用「退避重试 + DOM 变化观察」补齐。 */
  function scheduleRetry() {
    if (dead || retryTimer || retryN >= MAX_RETRY) return;
    const delay = Math.min(1200 * Math.pow(1.35, retryN), 6000);
    retryTimer = setTimeout(() => { retryTimer = 0; retryN++; probe(false); }, delay);
  }

  function markReady() {
    retryN = 0;
    try { clearTimeout(retryTimer); } catch (e) { /* 忽略 */ }
    retryTimer = 0;
    try { if (mo) mo.disconnect(); } catch (e) { /* 忽略 */ }
    mo = null;
  }

  function watchForContent() {
    if (mo || dead || typeof MutationObserver === 'undefined') return;
    try {
      mo = new MutationObserver(() => {
        if (dead || (payload && payload.ok)) return;
        /* 重试预算用完（已退避重试 10 次仍没内容）→ 别再观察，避免在重页面里反复空跑 */
        if (retryN >= MAX_RETRY) { try { mo.disconnect(); } catch (e) { /* 忽略 */ } return; }
        if (moRuns >= MAX_MO_RUNS) { try { mo.disconnect(); } catch (e) { /* 忽略 */ } return; }
        clearTimeout(moTimer);
        moTimer = setTimeout(() => {
          moTimer = 0; moRuns++;
          if (moRuns >= MAX_MO_RUNS) { try { mo.disconnect(); } catch (e) { /* 忽略 */ } }
          probe(false);
        }, 900);
      });
      mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
    } catch (e) { mo = null; }
  }

  /* ============================================================
     阅读模式
     ============================================================ */
  function mountReader() {
    if (readerHost) return;
    readerHost = document.createElement('div');
    readerHost.id = 'inkread-reader-root';
    readerHost.style.cssText = 'all:initial;';
    const sr = readerHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    sr.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'reader';
    wrap.setAttribute('data-on', '0');
    wrap.innerHTML = `
      <div class="rd-bar">
        <span class="t"></span>
        <span class="rd-sum"></span>
        <span class="grow"></span>
        <span class="rd-sw"></span>
        <button class="btn" data-act="font-down">A-</button>
        <button class="btn" data-act="font-up">A+</button>
        <button class="btn" data-act="dim">只看生词</button>
        <button class="btn" data-act="close">退出</button>
      </div>
      <div class="rd-body"><div class="rd-page">
        <h1></h1>
        <div class="rd-meta"></div>
        <div class="rd-content"></div>
        <div class="rd-legend">
          <span><i style="border-color:rgba(59,130,246,.75)"></i>在学</span>
          <span><i style="border-color:rgba(214,69,69,.8)"></i>生词本</span>
          <span><i style="border-color:rgba(240,180,41,.75);border-bottom-style:dotted"></i>未收录</span>
          <span>其余为已学；点任意词看释义</span>
        </div>
      </div></div>
      <div class="card" hidden></div>`;
    sr.appendChild(wrap);
    (document.body || document.documentElement).appendChild(readerHost);

    readerRefs = {
      wrap,
      t: wrap.querySelector('.t'),
      sum: wrap.querySelector('.rd-sum'),
      sw: wrap.querySelector('.rd-sw'),
      h1: wrap.querySelector('h1'),
      meta: wrap.querySelector('.rd-meta'),
      body: wrap.querySelector('.rd-body'),
      content: wrap.querySelector('.rd-content'),
      card: wrap.querySelector('.card')
    };

    wrap.querySelector('[data-act="close"]').addEventListener('click', closeReader);
    wrap.querySelector('[data-act="font-up"]').addEventListener('click', () => bumpFont(1));
    wrap.querySelector('[data-act="font-down"]').addEventListener('click', () => bumpFont(-1));
    wrap.querySelector('[data-act="dim"]').addEventListener('click', toggleDim);
    readerRefs.content.addEventListener('click', onWordClick);
    /* 点正文空白处（不是词/词组/「译」）收起释义卡片 */
    readerRefs.body.addEventListener('click', e => {
      const t = e.target;
      if (!t || !t.closest) { hideCard(); return; }
      if (t.closest('.w') || t.closest('.ph') || t.closest('.para-tr') || t.closest('.para-trans') || t.closest('.card')) return;
      hideCard();
    });
    wrap.addEventListener('click', e => { if (e.target === wrap) hideCard(); });
    readerRoot = sr;
  }

  async function openReader(force) {
    mountReader();
    if (!payload || !payload.ok || force) {
      readerRefs.h1.textContent = lastExtract ? lastExtract.title : document.title;
      readerRefs.content.innerHTML = '<div class="skel" style="height:200px;display:grid;place-items:center;color:#8b93a3">正在抽取正文…</div>';
      readerRefs.wrap.setAttribute('data-on', '1');
      await probe(!!force);
    }
    if (!payload || !payload.ok) {
      readerRefs.content.innerHTML = `<div class="note" style="color:#fcd34d">没能抽取到足够的正文：${esc((payload && payload.reason) || '页面正文太短或不是英文文章')}</div>`;
      return;
    }
    /* 词组索引先就位再渲染 —— 保证全文的词组线一次画齐，不会先渲染完再补线抖动 */
    await scanPhrases(payload.text);
    renderReader();
    readerRefs.wrap.setAttribute('data-on', '1');
    document.addEventListener('keydown', onKey, true);
  }

  function closeReader() {
    if (readerRefs) readerRefs.wrap.setAttribute('data-on', '0');
    hideCard();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', hideCard);
  }

  function onKey(e) {
    if (e.key === 'Escape') { hideCard(); closeReader(); }
  }

  function bumpFont(d) {
    const n = Math.max(13, Math.min(26, (settings.article.fontSize || 17) + d * 1));
    settings.article.fontSize = n;
    readerRefs.wrap.style.fontSize = n + 'px';
    patchSettings({ article: { fontSize: n } });
  }

  function toggleDim() {
    const on = !settings.article.dimKnown;
    settings.article.dimKnown = on;
    readerRefs.wrap.setAttribute('data-dim', on ? '1' : '0');
    patchSettings({ article: { dimKnown: on } });
  }

  function renderReaderChrome() {
    if (!readerRefs || !payload || !payload.ok) return;
    const r = payload.report;
    const cur = settings.rating.system;
    const items = [['step', 'L1–L4'], ['cefr', 'CEFR'], ['lexile', '蓝思']];
    readerRefs.sw.innerHTML = items.map(([id, label]) =>
      `<button data-rate="${id}" data-on="${cur === id ? 1 : 0}">${label}</button>`).join('');
    readerRefs.sw.querySelectorAll('[data-rate]').forEach(b =>
      b.addEventListener('click', () => { setRating(b.dataset.rate); renderReaderChrome(); }));

    const rating = (r.ratings || {})[cur] || {};
    readerRefs.sum.innerHTML = `${esc(rating.code || '—')} · ${allRatingsHtml(r)} · 可理解度 <b>${Math.round(r.coverage * 100)}%</b> · 生词 <b>${r.missTok}</b>`;
  }

  function renderReader() {
    const r = payload.report;
    const mapStatus = new Map(payload.statuses || []);
    const paras = String(payload.text || '').split(/\n{2,}/).filter(Boolean);
    /* 词组区间：优先用最近一次 phraseScan 的结果；没有（还没扫到 / 关了词组）就按空处理。
       用段落文本本身做键——renderReader 重渲染时顺序可能变，用下标会串位。 */
    const spans = _phSpans || [];

    readerRefs.h1.textContent = r.title || document.title || '';
    readerRefs.meta.textContent = `${location.hostname} · ${r.tokens} 词 · ${paras.length} 段 · 词库：${vocabText(r)}`;
    readerRefs.wrap.style.fontSize = (settings.article.fontSize || 17) + 'px';
    readerRefs.wrap.setAttribute('data-dim', settings.article.dimKnown ? '1' : '0');
    renderReaderChrome();

    const frag = document.createDocumentFragment();
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i];
      if (/^[A-Z][^.!?]{0,80}$/.test(p) && p.length < 90) {
        /* 短标题行渲染成二级标题，读起来更有层次 */
        const h = document.createElement('h2');
        h.textContent = p;
        frag.appendChild(h);
        continue;
      }
      const el = document.createElement('p');
      el.dataset.src = p;                       /* 供「译」按钮取原文 */
      colorize(p, mapStatus, el, spans[i]);
      /* 段落末尾的「译」：一键翻译本段（与墨读 PC 端同一个交互） */
      if (settings.translate && settings.translate.enabled !== false && settings.translate.paraTrans !== false) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'para-tr';
        btn.title = '翻译本段';
        btn.textContent = '译';
        btn.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); toggleParaTrans(btn); });
        el.appendChild(btn);
      }
      frag.appendChild(el);
    }
    readerRefs.content.innerHTML = '';
    readerRefs.content.appendChild(frag);
    hideCard();
    window.addEventListener('resize', hideCard);
  }

  /* 把一段文本渲染成节点序列：[{gap}|{node,st,text}, …] —— 词组包层时要在父容器间搬运，所以先出中间表示 */
  function segNodes(seg, mapStatus) {
    const out = [];
    WORD_RE.lastIndex = 0;
    let last = 0, m;
    while ((m = WORD_RE.exec(seg))) {
      if (m.index > last) out.push({ gap: seg.slice(last, m.index) });
      const w = m[0];
      const st = mapStatus.get(w.toLowerCase()) || 'unknown';
      const s = document.createElement('span');
      s.className = 'w w-' + st;
      s.textContent = w;
      s.dataset.w = w;
      out.push({ node: s, st, text: w });
      last = m.index + w.length;
    }
    if (last < seg.length) out.push({ gap: seg.slice(last) });
    return out;
  }

  function appendSeg(container, parts) {
    for (const p of parts) {
      if (p.gap != null) container.appendChild(document.createTextNode(p.gap));
      else container.appendChild(p.node);
    }
  }

  /**
   * 渲染一段正文：逐词上色 + 词组整组包 .ph（一条不断的线）。
   * @param {Array} phSpans 该段的词组字符区间 [[start,end,base,meaning], …]（后台 phraseScan 给的）
   */
  function colorize(text, mapStatus, container, phSpans) {
    /* 词组线只在「组内至少有一个生词」时画 —— 已掌握的词组不划线，跟 PC 端一个规矩 */
    const usePh = !settings.phrases || settings.phrases.enabled === false ? false : true;
    const list = usePh ? (phSpans || []).slice().sort((a, b) => a[0] - b[0]) : [];
    let cursor = 0;
    for (const sp of list) {
      const s0 = sp[0], s1 = sp[1];
      if (!(s1 > s0) || s0 < cursor || s1 > text.length) continue;   /* 重叠 / 越界：放弃这条 */
      if (s0 > cursor) appendSeg(container, segNodes(text.slice(cursor, s0), mapStatus));
      const parts = segNodes(text.slice(s0, s1), mapStatus);
      const hasUnknown = parts.some(p => p.node && p.st === 'unknown');
      if (hasUnknown) {
        const ph = document.createElement('span');
        ph.className = 'ph';
        ph.dataset.ph = text.slice(s0, s1);
        ph.dataset.phk = sp[2] || text.slice(s0, s1).toLowerCase();
        ph.dataset.phm = sp[3] || '';
        if (sp[3]) ph.setAttribute('data-off', '1');
        appendSeg(ph, parts);
        container.appendChild(ph);
      } else {
        appendSeg(container, parts);
      }
      cursor = s1;
    }
    if (cursor < text.length) appendSeg(container, segNodes(text.slice(cursor), mapStatus));
  }

  /* ---------- 词组区间（后台扫描，页面侧不重复实现匹配算法） ---------- */
  let _phSpans = null;          /* 与当前 payload.text 的段落一一对应；null = 还没扫到 */
  let _phScanKey = '';          /* 去重键，避免同一篇文章重复扫 */

  async function scanPhrases(text) {
    if (!settings.phrases || settings.phrases.enabled === false) { _phSpans = null; return null; }
    const paras = String(text || '').split(/\n{2,}/).filter(Boolean);
    if (!paras.length) { _phSpans = null; return null; }
    const key = paras.length + '|' + (paras[0] || '').slice(0, 40) + '|' + String(text.length);
    if (key === _phScanKey && _phSpans) return _phSpans;
    try {
      const r = await api.runtime.sendMessage({ type: 'phraseScan', paras });
      if (r && r.ok && Array.isArray(r.spans)) {
        _phSpans = r.spans;
        _phScanKey = key;
        return _phSpans;
      }
      _phSpans = r && r.disabled ? [] : null;
    } catch (e) { _phSpans = null; }
    return _phSpans;
  }

  /* ---------- 段落翻译（每段末尾的「译」） ---------- */
  const _paraTrans = new Map();         /* 段落文本 → { ok, engine, text }：本会话内不重复调接口 */
  async function translatePara(text) {
    const k = String(text).slice(0, 512);
    const hit = _paraTrans.get(k);
    if (hit) return hit;
    if (!settings.translate || settings.translate.enabled === false) throw new Error('在线翻译未开启（设置 → 翻译接口）');
    const r = await api.runtime.sendMessage({ type: 'translate', q: text });
    if (_paraTrans.size > 120) _paraTrans.clear();
    _paraTrans.set(k, r);
    return r;
  }

  /* 译文按句分行（译文里的换行都当断句，一行一句更好读） */
  function sentHtml(t) {
    const lines = String(t == null ? '' : t).split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (lines.length <= 1) return escLines(t);
    return lines.map(s => `<span class="pt-line">${esc(s)}</span>`).join('');
  }

  async function toggleParaTrans(btn) {
    const p = (btn.closest && btn.closest('p')) || btn.parentElement;
    if (!p) return;
    let box = p.querySelector('.para-trans');
    if (box) {                                   /* 已译过：展开 / 收起 */
      box.hidden = !box.hidden;
      btn.classList.toggle('on', !box.hidden);
      return;
    }
    box = document.createElement('span');
    box.className = 'para-trans';
    box.innerHTML = '<span class="pt-note">翻译中…</span>';
    p.appendChild(box);
    btn.classList.add('on');
    const text = String(p.dataset.src || '').trim();
    if (!text) { box.innerHTML = '<span class="pt-note">本段没有可翻译的文本</span>'; return; }
    try {
      const r = await translatePara(text);
      if (!r || !r.ok) throw new Error((r && (r.message || r.error)) || '翻译失败');
      box.innerHTML = `<span class="pt-src">${esc(r.engine || '')}</span>${sentHtml(r.text)}`;
    } catch (err) {
      box.innerHTML = `<span class="pt-note" style="color:#e58">${esc(String((err && err.message) || err))}</span>`;
    }
  }

  /* ---------- 释义卡片 ---------- */
  async function onWordClick(e) {
    const t = e.target;
    /* 词组优先：整组一个卡片（给整组中文），并给「分开看」入口 */
    const ph = t && t.closest ? t.closest('.ph') : null;
    if (ph) {
      e.preventDefault();
      e.stopPropagation();
      showPhraseCard(ph);
      return;
    }
    const span = t && t.closest ? t.closest('.w') : null;
    if (!span) { hideCard(); return; }
    e.preventDefault();
    e.stopPropagation();
    const word = span.dataset.w;
    const st = (span.className.match(/w-(\w+)/) || [, 'unknown'])[1];
    const rect = span.getBoundingClientRect();
    showWordCard(word, st, { left: rect.left, top: rect.top, bottom: rect.bottom });
  }

  /* 单词卡片：先出壳（含状态），再异步补释义 —— 全程不阻塞点击响应 */
  async function showWordCard(word, st, at) {
    const card = readerRefs.card;
    const lower = String(word).toLowerCase();
    card.hidden = false;
    card.innerHTML = cardHtml(word, st, null);
    place(card, at);
    let entry = dictCache.get(lower);
    if (entry === undefined) {
      try { entry = await api.runtime.sendMessage({ type: 'dictLookup', word }); }
      catch (err) { entry = { ok: false, message: '通信失败：' + (err && err.message || err) }; }
      dictCache.set(lower, entry || { ok: false, message: '未查到释义' });
    }
    card.innerHTML = cardHtml(word, st, entry);
    place(card, at);
  }

  /* ---------- 词组卡片（点词组 → 整组中文 + 「分开看」） ---------- */
  let _phraseCard = null;        /* { surface, base, el, at } */

  async function showPhraseCard(ph) {
    const surface = ph.dataset.ph || '';
    if (!surface) return;
    const base = (ph.dataset.phk || surface).toLowerCase();
    const off = ph.dataset.phm || '';
    const rect = ph.getBoundingClientRect();
    const at = { left: rect.left, top: rect.top, bottom: rect.bottom };
    _phraseCard = { surface, base, el: ph, at };
    const card = readerRefs.card;
    card.hidden = false;
    card.innerHTML = phraseCardHtml(surface, base, off, null);
    bindPhraseCard(card);
    place(card, at);
    if (off) return;                              /* 离线词组库命中：不用再打翻译接口 */
    if (!(settings.translate && settings.translate.phraseAuto !== false)) {
      card.innerHTML = phraseCardHtml(surface, base, '', { ok: false, message: '离线的词组库里没有这一组（可在设置里开启「词组自动在线翻译」）' });
      bindPhraseCard(card);
      place(card, at);
      return;
    }
    let tr = null;
    try { tr = await api.runtime.sendMessage({ type: 'translate', q: surface }); }
    catch (err) { tr = { ok: false, message: String((err && err.message) || err) }; }
    if (!_phraseCard || _phraseCard.surface !== surface) return;   /* 用户已经点了别的词组 */
    card.innerHTML = phraseCardHtml(surface, base, '', tr);
    bindPhraseCard(card);
    place(card, at);
  }

  function phraseCardHtml(surface, base, off, tr) {
    let meaning, src = '';
    if (off) {
      meaning = escLines(off);
      src = '离线词组库';
    } else if (!tr) {
      meaning = '<span class="ph-loading">查询词组释义…</span>';
    } else if (tr.ok) {
      meaning = escLines(tr.text);
      src = tr.engine || '在线翻译';
    } else {
      meaning = `<span class="empty">${escLines((tr.message || tr.error || '没查到这一组的意思'))}</span>`;
    }
    const badge = off ? '<span class="st" data-s="ph">词组</span>' : '';
    const baseLine = (base && base !== surface.toLowerCase()) ? `<div class="phk">基形 ${esc(base)}</div>` : '';
    return `<div class="hd"><span class="wd">${esc(surface)}</span>${badge}</div>${baseLine}
      <div class="mn${(tr && !tr.ok && !off) ? ' empty' : ''}">${meaning}</div>
      <div class="mk"><button data-op="split">分开看各词</button></div>
      <div class="ft"><span>${esc(src || '墨读词组库')}</span><span style="flex:1"></span><span>${esc(location.hostname)}</span></div>`;
  }

  function bindPhraseCard(card) {
    const b = card.querySelector('[data-op="split"]');
    if (!b) return;
    b.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!_phraseCard) return;
      const words = String(_phraseCard.surface).split(/\s+/).filter(Boolean);
      const map = statusMap();
      card.innerHTML = `<div class="hd"><span class="wd">${esc(_phraseCard.surface)}</span><span class="st" data-s="ph">分开看</span></div>`
        + `<div class="wp-chips">${words.map(w => `<button class="wp-chip" data-w="${esc(w)}" title="${esc(STATUS_TXT[map.get(w.toLowerCase()) || 'unknown'] || '')}">${esc(w)}</button>`).join('')}</div>`
        + `<div class="ft"><span>点任一词看单词语义</span></div>`;
      card.querySelectorAll('.wp-chip').forEach(cb => cb.addEventListener('click', ev2 => {
        ev2.preventDefault();
        ev2.stopPropagation();
        const w = cb.dataset.w || '';
        const st2 = map.get(w.toLowerCase()) || 'unknown';
        const r2 = _phraseCard ? _phraseCard.at : null;
        showWordCard(w, st2, r2);
      }));
      place(card, _phraseCard.at);
    });
  }

  /* 一次性渲染整张卡片——避免「先插音标再删掉」这类残留节点 bug */
  function cardHtml(word, st, entry) {
    const ok = !!(entry && entry.ok);
    const phon = (ok && entry.phonetic) ? `<span class="ph-txt">/${esc(entry.phonetic)}/</span>` : '';
    let meaning = '查询离线词典…';
    if (entry) {
      if (ok) meaning = entry.meaning || '(无释义)';
      else meaning = (entry.message || '未查到释义') +
        ((entry.word && entry.word !== word.toLowerCase()) ? `（原形 ${entry.word}）` : '');
    }
    return `<div class="hd">
        <span class="wd">${esc(word)}</span>${phon}
        <span class="st" data-s="${esc(st)}">${esc(STATUS_TXT[st] || st)}</span>
      </div>
      <div class="mn${(entry && !ok) ? ' empty' : ''}">${escLines(meaning)}</div>
      <div class="ft"><span>墨读离线词典</span><span style="flex:1"></span><span>${esc(location.hostname)}</span></div>`;
  }

  function place(card, rect) {
    const w = 300, h = card.offsetHeight || 140;
    let left = Math.min(Math.max(8, rect.left), window.innerWidth - w - 12);
    let top = rect.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 8);
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  function hideCard() {
    _phraseCard = null;
    if (readerRefs) readerRefs.card.hidden = true;
  }

  /* ============================================================
     网页内联上色（直接在正文上着色 + 点词释义 + 标记 + 划线）
     ------------------------------------------------------------
     要点：
       · 不改动站点原有结构语义——只把「含英文单词的文本节点」拆成 <span data-irw>
         （带上 data-irw 作为「这是我们的」标记，用于跳过与还原）。
       · 可逆：clearInline() 把所有 [data-irw]/[data-irhl] 拆回纯文本并 normalize。
       · 增量：MutationObserver 只对「新增且不是我们插的」节点补色；分片跑，避免长页卡顿。
       · 样式用 CSSOM（el.style）而非注入 <style>：这样不受页面 CSP 的 style-src 限制。
     ============================================================ */
  const INLINE_CAP_NODES = 4000;
  const SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, BUTTON: 1,
    CODE: 1, PRE: 1, KBD: 1, SAMP: 1, SVG: 1, CANVAS: 1, IFRAME: 1, MATH: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1
  };

  const inline = { obs: null, idle: 0, timer: 0, applied: 0 };

  function pageKey() {
    try {
      const u = new URL(location.href);
      return u.hostname.toLowerCase().replace(/^www\./, '') + u.pathname.replace(/\/+$/, '');
    } catch (e) { return String(location.href || '').slice(0, 200).toLowerCase(); }
  }

  function siteHost() { return String(location.hostname || '').toLowerCase().replace(/^www\./, ''); }

  function isSiteOff() {
    const off = settings.article.siteOff || [];
    return off.indexOf(siteHost()) >= 0;
  }

  function idleRun(fn) {
    if (typeof window.requestIdleCallback === 'function') return window.requestIdleCallback(fn, { timeout: 400 });
    return window.setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: true }), 1);
  }
  function idleCancel(id) {
    if (!id) return;
    if (typeof window.cancelIdleCallback === 'function') { try { window.cancelIdleCallback(id); } catch (e) { } }
    else { try { clearTimeout(id); } catch (e) { } }
  }

  /* 逐词状态的 Map（来自后台；已含用户标记的覆盖） */
  function statusMap() {
    const m = new Map();
    const arr = (payload && payload.statuses) || [];
    for (const pair of arr) if (pair && pair[0]) m.set(pair[0], pair[1]);
    return m;
  }

  /* 某个状态对应什么样式。默认「已知词不动」，只标出没掌握的——满屏着色比不标更伤阅读。 */
  function wordCss(st, style) {
    const s = style || settings.article.inlineStyle || 'line';
    if (st === 'known') return s === 'dim' ? '' : '';
    const color = st === 'new' ? '#dc2626' : st === 'learning' ? '#2563eb' : '#b45309';
    if (s === 'mark') {
      const bg = st === 'new' ? 'rgba(220,38,38,.16)' : st === 'learning' ? 'rgba(37,99,235,.15)' : 'rgba(180,83,9,.15)';
      return `background:${bg};border-radius:2px;cursor:pointer;`;
    }
    /* line（默认）：下划线 + 轻微着色，不改底色，页面上最不扰人 */
    return `color:${color};text-decoration:underline;text-decoration-thickness:1.5px;` +
      `text-underline-offset:2px;text-decoration-style:${st === 'unknown' ? 'dotted' : 'solid'};` +
      `text-decoration-color:${color};cursor:pointer;`;
  }

  function skipNode(node, rootEl) {
    let n = node.parentElement;
    if (!n) return true;
    while (n) {
      if (n.nodeType === 1) {
        if (SKIP_TAGS[n.tagName]) return true;
        if (n.getAttribute && n.getAttribute('data-irw')) return true;
        if (n.getAttribute && n.getAttribute('data-irhl')) return true;
        if (n.isContentEditable) return true;
        if (n.id && n.id.indexOf('inkread') === 0) return true;
      }
      if (n === rootEl) break;
      n = n.parentElement;
    }
    return false;
  }

  function collectTextNodes(rootEl) {
    const out = [];
    if (!rootEl) return out;
    let walker;
    try {
      walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const v = node.nodeValue;
          if (!v || v.length < 2 || !/[A-Za-z]/.test(v)) return NodeFilter.FILTER_REJECT;
          if (skipNode(node, rootEl)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
    } catch (e) { return out; }
    let n;
    while ((n = walker.nextNode()) && out.length < INLINE_CAP_NODES) out.push(n);
    return out;
  }

  /* 把一个文本节点拆成 [文本][span.irw][文本]…；返回包裹的词数 */
  function wrapNode(node, mapStatus) {
    const text = node.nodeValue;
    const parent = node.parentNode;
    if (!parent || !text) return 0;
    const frag = document.createDocumentFragment();
    let last = 0, m, count = 0;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const w = m[0];
      const st = mapStatus.get(w.toLowerCase()) || 'unknown';
      const s = document.createElement('span');
      s.setAttribute('data-irw', '1');
      s.setAttribute('data-w', w);
      s.className = 'irw irw-' + st;
      const css = wordCss(st);
      if (css) s.style.cssText = css;
      s.textContent = w;
      frag.appendChild(s);
      last = m.index + w.length;
      count++;
    }
    if (!count) return 0;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, node);
    return count;
  }

  /** 找一个合适的正文容器：站点规则优先，其次抽取结果，最后兜底 */
  function pickInlineRoot() {
    const r = siteRuleRoot();
    if (r) return r;
    if (lastExtract && lastExtract.el && lastExtract.el.isConnected) return lastExtract.el;
    let el = null;
    try { el = document.querySelector('article, [role="article"], main, [role="main"]'); } catch (e) { el = null; }
    return (el && visible(el)) ? el : null;
  }

  function applyInline() {
    if (!payload || !payload.ok) return;
    if (!settings.article.inlineColor || isSiteOff()) return;
    const rootEl = pickInlineRoot();
    if (!rootEl) return;
    inlineRoot = rootEl;
    const map = statusMap();
    const nodes = collectTextNodes(rootEl);
    inline.applied = 0;
    let i = 0;
    const step = () => {
      const t0 = Date.now();
      let guard = 0;
      while (i < nodes.length) {
        const node = nodes[i++];
        if (node.isConnected) inline.applied += wrapNode(node, map);
        if (++guard % 40 === 0 && Date.now() - t0 > 6) break;   /* 每帧最多干 ~6ms */
      }
      /* 丢掉我们这批插入产生的 mutation 记录，避免自触发循环 */
      if (inline.obs) { try { inline.obs.takeRecords(); } catch (e) { } }
      if (i < nodes.length) inline.idle = idleRun(step);
      else { inline.idle = 0; applyHighlights(); watchInline(rootEl); }
    };
    step();
  }

  function unwrapAll(sel) {
    let list;
    try { list = document.querySelectorAll(sel); } catch (e) { return; }
    const parents = new Set();
    for (const el of list) {
      const p = el.parentNode;
      if (!p) continue;
      try { p.replaceChild(document.createTextNode(el.textContent), el); parents.add(p); } catch (e) { /* 忽略 */ }
    }
    parents.forEach(p => { try { p.normalize(); } catch (e) { /* 忽略 */ } });
  }

  function clearInline() {
    if (inline.obs) { try { inline.obs.disconnect(); } catch (e) { } inline.obs = null; }
    idleCancel(inline.idle); inline.idle = 0;
    if (inline.timer) { clearTimeout(inline.timer); inline.timer = 0; }
    unwrapAll('[data-irhl="1"]');
    unwrapAll('[data-irw="1"]');
    inline.applied = 0;
    inlineRoot = null;
  }

  /** 重新上色（设置/标记变化后调用） */
  function recolor() {
    if (!payload || !payload.ok) return;
    clearInline();
    if (!settings.article.inlineColor || isSiteOff()) { updateInlineToggle(); return; }
    applyInline();
    updateInlineToggle();
  }

  /** 只改某一个词的样式（点标记后免于整页重排） */
  function restyleWord(word) {
    const w = String(word || '').toLowerCase();
    if (!w) return;
    const map = statusMap();
    let list;
    try { list = document.querySelectorAll('[data-irw="1"]'); } catch (e) { return; }
    for (const s of list) {
      if (String(s.getAttribute('data-w') || '').toLowerCase() !== w) continue;
      const st = map.get(w) || 'unknown';
      s.className = 'irw irw-' + st;
      const css = wordCss(st);
      s.style.cssText = css;
      if (s.getAttribute('data-hl') === '1') s.classList.add('irw-hl');
    }
  }

  /** 全量重刷样式（上色样式改了就靠这个，不必重新拆/包 DOM） */
  function restyleAll() {
    const map = statusMap();
    let list;
    try { list = document.querySelectorAll('[data-irw="1"]'); } catch (e) { return; }
    for (const s of list) {
      const w = String(s.getAttribute('data-w') || '').toLowerCase();
      const st = map.get(w) || 'unknown';
      s.className = 'irw irw-' + st;
      const css = wordCss(st);
      if (s.getAttribute('data-hl') === '1') s.style.cssText = css + hlStyleOf();
      else s.style.cssText = css;
    }
  }

  /* ---------- 划线渲染 ---------- */
  function hlStyleOf() {
    return settings.article.hlStyle === 'line'
      ? 'text-decoration:underline wavy;text-decoration-thickness:1.5px;text-underline-offset:3px;text-decoration-color:#f0a020;'
      : 'background:rgba(240,180,41,.30);border-radius:2px;';
  }

  function textIndex(rootEl) {
    const nodes = [];
    let s = '', n;
    let walker;
    try { walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null); } catch (e) { return { s: '', nodes }; }
    while ((n = walker.nextNode())) { nodes.push({ node: n, start: s.length }); s += n.nodeValue; }
    return { s, nodes };
  }

  function nodeAt(idxInfo, idx) {
    const list = idxInfo.nodes;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].start <= idx) return { node: list[i].node, offset: idx - list[i].start };
    }
    return null;
  }

  function clearHighlightMarks() {
    unwrapAll('[data-irhl="1"]');
    let list;
    try { list = document.querySelectorAll('[data-irw="1"]'); } catch (e) { return; }
    for (const s of list) {
      if (s.getAttribute('data-hl') === '1') { s.removeAttribute('data-hl'); s.classList.remove('irw-hl'); }
    }
  }

  function applyHighlights() {
    if (!inlineRoot && !payload) return;
    const rootEl = inlineRoot || pickInlineRoot();
    if (!rootEl) return;
    const list = pageHighlights || [];
    if (!list.length) return;
    const info = textIndex(rootEl);
    if (!info.s) return;
    const css = hlStyleOf();
    let cursor = 0;
    for (const h of list) {
      const t = h && h.text;
      if (!t) continue;
      let idx = info.s.indexOf(t, cursor);
      if (idx < 0) idx = info.s.indexOf(t);
      if (idx < 0) continue;
      cursor = idx + t.length;
      const a = nodeAt(info, idx), b = nodeAt(info, idx + t.length);
      if (!a || !b) continue;
      let range;
      try {
        range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
      } catch (e) { continue; }
      markRange(rootEl, range, css, h.id);
    }
    if (inline.obs) { try { inline.obs.takeRecords(); } catch (e) { } }
  }

  function markRange(rootEl, range, css, id) {
    const targets = [];
    let walker;
    try { walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null); } catch (e) { return; }
    let n;
    while ((n = walker.nextNode())) {
      try { if (range.intersectsNode(n)) targets.push(n); } catch (e) { /* 忽略 */ }
    }
    for (const tn of targets) {
      const p = tn.parentElement;
      if (!p) continue;
      if (p.getAttribute && p.getAttribute('data-irw')) {
        p.setAttribute('data-hl', '1');
        p.setAttribute('data-hlid', id || '');
        p.classList.add('irw-hl');
        /* 词上的划线用「额外一层」表达，避免覆盖掉生词本身的颜色 */
        if (!p.style.textDecoration) p.style.cssText += css;
        continue;
      }
      if (p.getAttribute && p.getAttribute('data-irhl')) continue;
      const wrap = document.createElement('span');
      wrap.setAttribute('data-irhl', '1');
      if (id) wrap.setAttribute('data-hlid', id);
      wrap.style.cssText = css;
      const parent = tn.parentNode;
      if (parent) { parent.replaceChild(wrap, tn); wrap.appendChild(tn); }
    }
  }

  /** 用选中范围加一条划线 */
  async function addHighlightFromSelection(range, text, note) {
    const key = pageKey();
    let res = null;
    try { res = await api.runtime.sendMessage({ type: 'hlAdd', urlKey: key, text, note: note || '' }); } catch (e) { res = null; }
    if (res && res.ok) { pageHighlights = res.highlights || []; }
    else pageHighlights = (pageHighlights || []).concat([{ id: 'local', text, at: Date.now(), note: note || '' }]);
    /* 立即在页面上画出来 */
    const rootEl = inlineRoot || pickInlineRoot();
    if (rootEl) { try { markRange(rootEl, range, hlStyleOf(), (res && res.highlights && res.highlights[res.highlights.length - 1] || {}).id); } catch (e) { } }
    if (inline.obs) { try { inline.obs.takeRecords(); } catch (e) { } }
    hideSelbar();
    if (open) renderPanel();
  }

  async function delHighlight(id) {
    const key = pageKey();
    try { const r = await api.runtime.sendMessage({ type: 'hlDel', urlKey: key, id }); if (r && r.ok) pageHighlights = r.highlights || []; }
    catch (e) { pageHighlights = (pageHighlights || []).filter(h => h.id !== id); }
    clearHighlightMarks();
    applyHighlights();
    hideSelbar();
    if (open) renderPanel();
  }

  /* ---------- 页面上色开关 ---------- */
  function updateInlineToggle() {
    if (!refs) return;
    const on = !!settings.article.inlineColor && !isSiteOff();
    refs.wrap.setAttribute('data-inline', on ? '1' : '0');
  }

  async function toggleInline() {
    const on = !(settings.article.inlineColor && !isSiteOff());
    const off = (settings.article.siteOff || []).filter(h => h !== siteHost());
    if (on) {
      settings.article.inlineColor = true;
      settings.article.siteOff = off;
      patchSettings({ article: { inlineColor: true, siteOff: off } });
      recolor();
    } else {
      /* 关掉 = 记住这个站点，避免下次又自动上色 */
      const list = (settings.article.siteOff || []).concat([siteHost()]).filter((v, i, a) => a.indexOf(v) === i);
      settings.article.siteOff = list;
      patchSettings({ article: { siteOff: list } });
      clearInline();
    }
    updateInlineToggle();
    if (open) renderPanel();
  }

  /* ---------- MutationObserver：内容更新后增量补色 ---------- */
  function watchInline(rootEl) {
    if (inline.obs || !rootEl) return;
    try {
      inline.obs = new MutationObserver(muts => {
        let relevant = false;
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n.getAttribute && (n.getAttribute('data-irw') || n.getAttribute('data-irhl'))) continue;
            if (n.nodeType === 3 && n.parentElement && n.parentElement.getAttribute && n.parentElement.getAttribute('data-irw')) continue;
            relevant = true; break;
          }
          if (relevant) break;
        }
        if (!relevant) return;
        if (inline.timer) clearTimeout(inline.timer);
        inline.timer = setTimeout(() => { inline.timer = 0; applyInline(); }, 500);
      });
      inline.obs.observe(rootEl, { childList: true, subtree: true });
    } catch (e) { inline.obs = null; }
  }

  /* ---------- 页面上点词：释义卡片 + 标记 ---------- */
  let pageCard = null;        /* { word, st, rect } */

  function onPageClick(e) {
    const t = e.target;
    const span = (t && t.closest) ? t.closest('[data-irw="1"]') : null;
    if (!span) { if (!(t && t.closest && t.closest('.selbar'))) hidePageCard(); return; }
    e.preventDefault();
    e.stopPropagation();
    showPageCard(span);
  }

  async function showPageCard(span) {
    mount();
    const word = span.getAttribute('data-w') || span.textContent || '';
    const st = (span.className.match(/irw-(\w+)/) || [, 'unknown'])[1];
    const rect = span.getBoundingClientRect();
    pageCard = { word, st, rect: { left: rect.left, top: rect.top, bottom: rect.bottom } };
    const card = refs.card;
    card.hidden = false;
    card.innerHTML = pageCardHtml(word, st, null);
    bindCard(card, word);
    place(card, pageCard.rect);

    const lower = word.toLowerCase();
    let entry = dictCache.get(lower);
    if (entry === undefined) {
      try { entry = await api.runtime.sendMessage({ type: 'dictLookup', word }); }
      catch (err) { entry = { ok: false, message: '通信失败：' + (err && err.message || err) }; }
      dictCache.set(lower, entry || { ok: false, message: '未查到释义' });
    }
    card.innerHTML = pageCardHtml(word, st, entry);
    bindCard(card, word);
    place(card, pageCard.rect);
  }

  function hidePageCard() { if (refs && refs.card) refs.card.hidden = true; }

  function pageCardHtml(word, st, entry) {
    const ok = !!(entry && entry.ok);
    const phon = (ok && entry.phonetic) ? `<span class="ph-txt">/${esc(entry.phonetic)}/</span>` : '';
    let meaning = '查询离线词典…';
    if (entry) {
      if (ok) meaning = entry.meaning || '(无释义)';
      else meaning = (entry.message || '未查到释义') + ((entry.word && entry.word !== word.toLowerCase()) ? `（原形 ${entry.word}）` : '');
    }
    const cur = (marksWords[word.toLowerCase()] || {}).status || null;
    const btn = (id, label, cls) =>
      `<button data-mk="${id}" data-on="${cur === id ? 1 : 0}"${cls ? ' class="' + cls + '"' : ''}>${label}</button>`;
    const clr = cur ? `<button class="clr" data-mk="" title="取消标记">✕</button>` : '';
    return `<div class="hd">
        <span class="wd">${esc(word)}</span>${phon}
        <span class="st" data-s="${esc(st)}">${esc(STATUS_TXT[st] || st)}</span>
      </div>
      <div class="mn${(entry && !ok) ? ' empty' : ''}">${escLines(meaning)}</div>
      <div class="mk">
        ${btn('new', '生词本')}${btn('learning', '在学')}${btn('known', '已学')}${clr}
      </div>
      <div class="ft"><span>墨读离线词典</span><span style="flex:1"></span><span>${esc(location.hostname)}</span></div>`;
  }

  function bindCard(card, word) {
    card.querySelectorAll('[data-mk]').forEach(b => b.addEventListener('click', ev => {
      ev.preventDefault(); ev.stopPropagation();
      markWord(word, b.dataset.mk || null);
    }));
    card.addEventListener('click', ev => ev.stopPropagation());
  }

  async function markWord(word, status) {
    const lower = String(word || '').toLowerCase();
    const cur = (marksWords[lower] || {}).status || null;
    const next = (status == null) ? null : (cur === status ? null : status);   /* 再点一次 = 取消 */
    try { await api.runtime.sendMessage({ type: 'markSet', word, status: next, urlKey: pageKey() }); } catch (e) { /* 忽略 */ }
    if (next) marksWords[lower] = { status: next, at: Date.now() }; else delete marksWords[lower];
    restyleWord(word);
    /* 让面板/胶囊的统计跟上（后台已失效文章缓存 → 这次会重算） */
    await probe(true);
    restyleWord(word);
    if (pageCard && pageCard.word.toLowerCase() === lower) {
      const card = refs.card;
      const stNow = (statusMap().get(lower) || 'unknown');
      const entry = dictCache.get(lower) || null;
      card.innerHTML = pageCardHtml(word, stNow, entry);
      bindCard(card, word);
      place(card, pageCard.rect);
    }
    if (open) renderPanel();
  }

  /* ---------- 选中文本 → 浮动工具条（划线 / 笔记） ---------- */
  let selState = null;        /* { text, rect, range } */

  function onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hideSelbar(); return; }
    const text = String(sel).replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2 || text.length > 400) { hideSelbar(); return; }
    const t = sel.anchorNode && sel.anchorNode.parentElement;
    const span = t && t.closest ? t.closest('[data-irw="1"]') : null;
    /* 只选中了「一个词」→ 那是查词场景，走单词卡片，不弹划线条。
       跨词拖选（哪怕起点落在词里）仍然要能划线。 */
    const f = sel.focusNode && sel.focusNode.parentElement;
    const fspan = f && f.closest ? f.closest('[data-irw="1"]') : null;
    if (span && span === fspan) return;
    const rootEl = inlineRoot || pickInlineRoot();
    if (!rootEl) { hideSelbar(); return; }
    const range = sel.getRangeAt(0);
    if (!rootEl.contains(range.commonAncestorContainer)) { hideSelbar(); return; }
    mount();
    selState = { text, range: range.cloneRange(), rect: range.getBoundingClientRect() };
    showSelbar(selState.rect, text);
  }

  function showSelbar(rect, text) {
    if (!refs) return;
    const bar = refs.selbar;
    const exists = (pageHighlights || []).some(h => h.text === text);
    bar.querySelector('[data-act="hl-del"]').hidden = !exists;
    bar.setAttribute('data-on', '1');
    refs.noteIn.hidden = true;
    refs.noteIn.value = '';
    const w = bar.offsetWidth || 220;
    let left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), window.innerWidth - w - 12);
    let top = rect.top - (bar.offsetHeight || 34) - 8;
    if (top < 8) top = rect.bottom + 8;
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
  }

  function hideSelbar() { if (refs && refs.selbar) refs.selbar.setAttribute('data-on', '0'); }

  function bindSelbar() {
    const bar = refs.selbar;
    bar.addEventListener('mousedown', e => e.preventDefault());   /* 保住选区 */
    bar.querySelector('[data-act="hl-add"]').addEventListener('click', () => {
      if (selState) addHighlightFromSelection(selState.range, selState.text, '');
    });
    bar.querySelector('[data-act="hl-del"]').addEventListener('click', () => {
      if (!selState) return;
      const hit = (pageHighlights || []).find(h => h.text === selState.text);
      if (hit) delHighlight(hit.id);
    });
    bar.querySelector('[data-act="note"]').addEventListener('click', () => {
      refs.noteIn.hidden = !refs.noteIn.hidden;
      if (!refs.noteIn.hidden) refs.noteIn.focus();
    });
    refs.noteIn.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (selState) addHighlightFromSelection(selState.range, selState.text, refs.noteIn.value.trim());
    });
  }

  document.addEventListener('click', onPageClick, true);
  document.addEventListener('mouseup', () => setTimeout(onSelectionChange, 10), true);
  document.addEventListener('keyup', e => { if (e.key !== 'Escape') setTimeout(onSelectionChange, 10); }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hidePageCard(); hideSelbar(); }
  }, true);
  window.addEventListener('scroll', () => { hidePageCard(); hideSelbar(); }, true);
  window.addEventListener('resize', () => { hidePageCard(); hideSelbar(); });

  /* ============================================================
     导航 / 消息
     ============================================================ */
  function onNav() {
    if (dead) return;
    if (location.href === currentHref) return;
    currentHref = location.href;
    payload = null;
    lastExtract = null;
    marksWords = {};
    pageHighlights = [];
    _phSpans = null; _phScanKey = '';        /* 换页：词组区间与段落译文缓存一起作废 */
    _paraTrans.clear();
    retryN = 0; moRuns = 0;
    try { clearTimeout(retryTimer); } catch (e) { /* 忽略 */ }
    retryTimer = 0;
    clearInline();
    hidePageCard();
    hideSelbar();
    if (readerRefs && readerRefs.wrap.getAttribute('data-on') === '1') closeReader();
    if (!settings.article.enabled) { hidePill(); return; }
    if (!isEnglishPath()) { hidePill(); return; }
    /* 首屏可能还没有正文（SPA / hydrate）→ 不在这里放弃，交给 probe 的重试与 DOM 观察 */
    watchForContent();
    setTimeout(() => probe(false), 500);
  }

  window.addEventListener('popstate', () => setTimeout(onNav, 300));
  window.addEventListener('hashchange', () => setTimeout(onNav, 300));
  navTimer = setInterval(onNav, POLL_MS);

  if (ctxAlive()) api.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'articleSummary') {
      /* 弹出面板要一份摘要：现场抽一次正文再答（异步，必须 return true 保持通道） */
      (async () => {
        if (!payload || !payload.ok || msg.force) await probe(!!msg.force, { explicit: true });
        if (payload && payload.ok) reply({ ok: true, report: payload.report });
        else reply({ ok: false, reason: (payload && payload.reason) || '没能在这个页面上找到正文' });
      })();
      return true;
    }
    if (msg.type === 'openReader') { openReader(!!msg.force); reply({ ok: true }); return; }
    if (msg.type === 'articleProbe') { probe(!!msg.force); reply({ ok: true }); return; }
    if (msg.type === 'ratingChanged') { settings.rating = { system: msg.system || 'step' }; renderPill(); if (open) renderPanel(); if (readerRoot) renderReaderChrome(); reply({ ok: true }); return; }
    if (msg.type === 'settings') {
      const a = (msg.settings && msg.settings.article) || null;
      if (a) settings.article = Object.assign(settings.article, a);
      if (msg.settings && msg.settings.rating) settings.rating = msg.settings.rating;
      const tSet = (msg.settings && msg.settings.translate) || null;
      if (tSet) settings.translate = Object.assign(settings.translate, tSet);
      const pSet = (msg.settings && msg.settings.phrases) || null;
      if (pSet) {
        const changed = ('enabled' in pSet) || ('underline' in pSet);
        settings.phrases = Object.assign(settings.phrases, pSet);
        /* 词组开关变了 → 阅读模式重渲染（词组是渲染期就决定的），内联模式暂不支持词组 */
        if (changed && readerRoot && payload && payload.ok) renderReader();
      }
      if (!settings.article.enabled) { clearInline(); hidePill(); }
      else {
        /* 上色开关 / 样式变了 → 重新上色（样式变化只需重刷已包裹的词） */
        if (a && ('inlineStyle' in a || 'hlStyle' in a)) { restyleAll(); applyHighlights(); }
        if (a && ('inlineColor' in a || 'siteOff' in a)) recolor();
        updateInlineToggle();
      }
      reply({ ok: true });
    }
  });

  /* 首次加载：取设置 → 探测 */
  function boot() {
    if (dead) return;
    if (!ctxAlive()) { selfDestruct(); return; }
    watchForContent();                 /* 先挂上 DOM 观察，抢在慢渲染站点 hydrate 之前 */
    onNav();
  }

  if (ctxAlive()) {
    api.storage.local.get('iv.settings').then(r => {
      const s = r && r['iv.settings'];
      if (s) {
        if (s.article) settings.article = Object.assign(settings.article, s.article);
        if (s.rating) settings.rating = Object.assign(settings.rating, s.rating);
        if (s.translate) settings.translate = Object.assign(settings.translate, s.translate);
        if (s.phrases) settings.phrases = Object.assign(settings.phrases, s.phrases);
      }
      if (document.readyState === 'complete') boot();
      else {
        window.addEventListener('load', () => setTimeout(boot, 300), { once: true });
        setTimeout(boot, 1500);        /* load 迟迟不来（长连接页面）也要跑一次 */
      }
    }).catch(() => { boot(); });
  } else {
    boot();
  }
})();
