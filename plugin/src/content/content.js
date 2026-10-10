/* InkRead Video — 内容脚本
 *
 * 在哔哩哔哩 / YouTube 页面上挂一个悬浮徽标（可展开为面板），展示「这个视频对你的生词量/等级」。
 * 全部 UI 放在 Shadow DOM 里 —— 这些站点自身样式极重，必须彻底隔离，否则必然被改坏。
 * 本文件是经典脚本（MV3 内容脚本不支持 ESM），所以自带 api 垫片与少量内联逻辑。
 */
(function () {
  'use strict';
  const api = (typeof browser !== 'undefined' && browser && browser.runtime) ? browser : chrome;

  const VIDEO_PATH_RE = /(^\/watch)|(^\/shorts\/)|(^\/video\/)|(^\/bangumi\/play\/)/;
  const POLL_MS = 900;

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .wrap {
    position: fixed; z-index: 2147483000;
    left: 0; top: 0;                 /* 实际位置由 JS 计算：默认「右侧垂直居中」，可拖动并记忆 */
    font: 13px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    color: #e8eaf0;
    --tone: #6b7280;
    --bg: rgba(20,23,29,.86);
    --line: rgba(255,255,255,.10);
  }
  .wrap[hidden] { display: none; }
  .wrap[data-drag="1"] { user-select: none; -webkit-user-select: none; }

  /* ---------- 收起态胶囊 ---------- */
  .pill {
    display: inline-flex; align-items: center; gap: 7px;
    height: 34px; padding: 0 13px 0 11px; cursor: grab;
    border: 1px solid var(--line); border-radius: 999px;
    background: var(--bg); backdrop-filter: blur(14px) saturate(1.4);
    -webkit-backdrop-filter: blur(14px) saturate(1.4);
    box-shadow: 0 6px 22px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.06);
    color: inherit; font: inherit; font-weight: 600;
    touch-action: none;
    transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
  }
  .wrap[data-drag="1"] .pill { cursor: grabbing; }
  .wrap[data-drag="1"] .pill { transition: none; }
  .pill:hover { transform: translateY(-1px); box-shadow: 0 10px 26px rgba(0,0,0,.42); border-color: rgba(255,255,255,.2); }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 26%, transparent); flex: none; }
  .pill .lv { color: var(--tone); letter-spacing: .02em; }
  .pill .cov { font-variant-numeric: tabular-nums; color: #fff; }
  .pill .sep { width: 1px; height: 14px; background: var(--line); }
  .pill .mini { font-weight: 500; color: #a8adba; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill[data-state="loading"] .dot { animation: pulse 1.1s ease-in-out infinite; }
  .pill[data-state="error"] { --tone: #d64545; }
  @keyframes pulse { 0%,100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.15); } }

  /* ---------- 展开面板 ---------- */
  .panel {
    position: absolute; right: 0; bottom: calc(100% + 10px);
    width: 336px; max-height: min(76vh, 620px); overflow: hidden auto;
    border: 1px solid var(--line); border-radius: 16px;
    background: linear-gradient(180deg, rgba(28,31,38,.96), rgba(17,19,24,.97));
    backdrop-filter: blur(18px) saturate(1.5);
    -webkit-backdrop-filter: blur(18px) saturate(1.5);
    box-shadow: 0 22px 60px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
    opacity: 0; transform: translateY(8px) scale(.985); pointer-events: none;
    transition: opacity .18s ease, transform .18s ease;
  }
  .wrap[data-side="left"] .panel { right: auto; left: 0; }
  /* 胶囊靠屏幕顶部时，面板向下展开，避免被裁掉 */
  .wrap[data-v="down"] .panel { bottom: auto; top: calc(100% + 10px); }
  .wrap[data-open="1"] .panel { opacity: 1; transform: none; pointer-events: auto; }
  .panel::-webkit-scrollbar { width: 8px; }
  .panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 8px; }

  .ph { display: flex; align-items: flex-start; gap: 10px; padding: 14px 14px 10px; }
  .ph-logo { width: 26px; height: 26px; border-radius: 8px; flex: none; background: linear-gradient(140deg, #f0b429, #d97706); display: grid; place-items: center; color: #1a1407; font-weight: 800; font-size: 13px; }
  .ph-main { flex: 1; min-width: 0; }
  .ph-t { font-size: 12px; color: #9aa1b0; display: flex; gap: 6px; align-items: center; }
  .ph-site { color: #cfd4de; font-weight: 600; }
  .ph-title { font-size: 13px; font-weight: 600; color: #fff; margin-top: 3px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word; }
  .ph-x { border: 0; background: transparent; color: #7d8494; cursor: pointer; font-size: 15px; line-height: 1; padding: 3px 5px; border-radius: 7px; }
  .ph-x:hover { background: rgba(255,255,255,.08); color: #fff; }

  .body { padding: 0 14px 14px; }

  /* 主指标：环 + 结论 */
  .hero { display: flex; gap: 14px; align-items: center; padding: 6px 0 12px; }
  .ring { position: relative; width: 92px; height: 92px; flex: none; }
  .ring svg { transform: rotate(-90deg); display: block; }
  .ring .bg { stroke: rgba(255,255,255,.09); }
  .ring .fg { stroke: var(--tone); stroke-linecap: round; transition: stroke-dashoffset .5s cubic-bezier(.2,.7,.2,1); }
  .ring .mid { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; }
  .ring .num { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; color: #fff; }
  .ring .num i { font-size: 11px; font-style: normal; color: #9aa1b0; }
  .ring .cap { font-size: 10px; color: #8b93a3; margin-top: 3px; letter-spacing: .04em; }

  .hero-main { flex: 1; min-width: 0; }
  .lvl { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 700; color: var(--tone); background: color-mix(in srgb, var(--tone) 16%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 34%, transparent); }
  .tier { font-size: 11px; color: #8b93a3; margin-top: 6px; }
  .verd { margin-top: 8px; font-size: 12.5px; font-weight: 600; color: #fff; }
  .verd.ok { color: #7fe0aa; }
  .verd.no { color: #f0a86a; }
  .vd { margin-top: 3px; font-size: 11.5px; color: #98a0b0; line-height: 1.45; }

  /* 指标网格 */
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 4px 0 12px; }
  .cell { background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.06); border-radius: 10px; padding: 8px 6px; text-align: center; }
  .cell b { display: block; font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; color: #fff; }
  .cell span { display: block; font-size: 10px; color: #8b93a3; margin-top: 2px; }

  /* 客观难度 */
  .sec { margin-bottom: 12px; }
  .sec-h { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #8b93a3; margin-bottom: 6px; letter-spacing: .03em; }
  .sec-h b { color: #cfd4de; font-weight: 600; }
  .bar { display: flex; height: 8px; border-radius: 6px; overflow: hidden; background: rgba(255,255,255,.06); }
  .bar i { display: block; height: 100%; }
  .bar .b1 { background: #2e9e6b; } .bar .b2 { background: #4a9be8; }
  .bar .b3 { background: #d98a19; } .bar .b4 { background: #d97757; } .bar .b5 { background: #8b5cf6; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 6px; font-size: 10.5px; color: #8b93a3; }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .legend em { width: 7px; height: 7px; border-radius: 2px; font-style: normal; }

  /* 生词 */
  .chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .chip { font-size: 11.5px; padding: 3px 8px; border-radius: 7px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.07); color: #dfe3ea; }
  .chip b { font-weight: 700; color: #fff; }
  .chip em { font-style: normal; color: #8b93a3; font-size: 10px; margin-left: 3px; }
  .chip[data-s="new"] { border-color: color-mix(in srgb, #d64545 42%, transparent); }
  .chip[data-s="unknown"] { border-color: color-mix(in srgb, #f0b429 40%, transparent); }
  .chip[data-s="learning"] { border-color: color-mix(in srgb, #3b82f6 42%, transparent); }
  .empty { font-size: 11.5px; color: #8b93a3; padding: 4px 0; }

  /* 底部 */
  .foot { display: flex; align-items: center; gap: 8px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.07); font-size: 10.5px; color: #7d8494; }
  .foot .src { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .foot .warn { color: #f0a86a; }
  .btn { border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.05); color: #dfe3ea; border-radius: 8px; padding: 4px 9px; font: inherit; font-size: 11px; cursor: pointer; }
  .btn:hover { background: rgba(255,255,255,.1); }

  .note { font-size: 11.5px; color: #98a0b0; line-height: 1.5; padding: 2px 0 4px; }
  .note b { color: #f0a86a; }
  .skel { height: 92px; display: grid; place-items: center; color: #8b93a3; font-size: 12px; }

  /* 评级体系切换 */
  .sw { display: flex; gap: 3px; padding: 3px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.07); border-radius: 10px; margin: 0 0 12px; }
  .sw button { flex: 1; border: 0; background: transparent; color: #98a0b0; font: inherit; font-size: 11.5px; font-weight: 600; padding: 5px 0; border-radius: 7px; cursor: pointer; }
  .sw button:hover { color: #dfe3ea; }
  .sw button[data-on="1"] { background: rgba(255,255,255,.12); color: #fff; }
  .allrate { font-size: 11px; color: #8b93a3; margin-top: 6px; }
  .allrate b { color: #cfd4de; font-weight: 600; }

  /* 字幕标记开关行 */
  .subrow { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; padding: 8px 10px; border: 1px solid rgba(255,255,255,.07); border-radius: 10px; background: rgba(255,255,255,.035); }
  .subrow .t { flex: 1; min-width: 0; font-size: 11.5px; color: #98a0b0; }
  .subrow .t b { color: #dfe3ea; font-weight: 600; }
  .tg { border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.05); color: #98a0b0; border-radius: 8px; padding: 4px 10px; font: inherit; font-size: 11px; cursor: pointer; flex: none; }
  .tg[data-on="1"] { background: rgba(240,180,41,.2); border-color: rgba(240,180,41,.5); color: #fff; }

  /* ---------- 点词卡片（字幕 / 正文通用） ---------- */
  .wcard {
    position: fixed; z-index: 2147483600;
    width: 290px; max-width: calc(100vw - 32px);
    border: 1px solid var(--line); border-radius: 14px;
    background: linear-gradient(180deg, rgba(28,31,38,.985), rgba(17,19,24,.99));
    box-shadow: 0 18px 46px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.06);
    color: #e8eaf0; padding: 12px 13px 11px;
  }
  .wcard[hidden] { display: none; }
  .wcard .hd { display: flex; align-items: baseline; gap: 8px; }
  .wcard .wd { font-size: 16px; font-weight: 700; color: #fff; word-break: break-word; }
  .wcard .ph-txt { font-size: 12px; color: #9aa1b0; }
  .wcard .st { margin-left: auto; flex: none; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
  .wcard .st[data-s="new"] { color: #f2a2a2; background: rgba(214,69,69,.2); }
  .wcard .st[data-s="learning"] { color: #9cc2ff; background: rgba(59,130,246,.2); }
  .wcard .st[data-s="known"] { color: #8fdcb4; background: rgba(46,158,107,.2); }
  .wcard .st[data-s="unknown"] { color: #f2c68c; background: rgba(217,138,25,.2); }
  .wcard .x { margin-left: 4px; flex: none; border: 0; background: transparent; color: #7d8494; cursor: pointer; font-size: 13px; line-height: 1; padding: 2px 5px; border-radius: 6px; font-family: inherit; }
  .wcard .x:hover { background: rgba(255,255,255,.08); color: #fff; }
  .wcard .mn { margin: 8px 0 10px; font-size: 12.5px; line-height: 1.55; color: #cfd4de; white-space: pre-wrap; max-height: 190px; overflow: auto; word-break: break-word; }
  .wcard .mn.empty { color: #8b93a3; }
  .wcard .mn .loading { color: #8b93a3; }
  .wcard .mk { display: flex; gap: 6px; }
  .wcard .mk button { flex: 1; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.05); color: #dfe3ea; border-radius: 8px; padding: 5px 0; font: inherit; font-size: 11.5px; cursor: pointer; }
  .wcard .mk button:hover { background: rgba(255,255,255,.11); }
  .wcard .mk button[data-on="1"] { background: rgba(240,180,41,.22); border-color: rgba(240,180,41,.5); color: #fff; }
  .wcard .mk .clr { flex: none; width: 32px; color: #98a0b0; }
  .wcard .sp { margin-top: 8px; display: flex; gap: 6px; align-items: center; }
  .wcard .ft { margin-top: 9px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,.07); font-size: 10.5px; color: #7d8494; display: flex; gap: 6px; }
  .wcard .ft .grow { flex: 1; }
  `;

  /* 页面级样式：字幕里的逐词标记必须落在**页面 DOM** 上（内容脚本的 Shadow DOM 管不到），
     所以这里单独注入一份 <style>，并在自毁时摘掉。样式尽量克制，不破坏字幕可读性。 */
  const PAGE_CSS = `
  [data-ism] { cursor: pointer; border-radius: 3px; transition: background .12s ease; }
  [data-ism]:hover { background: rgba(255,255,255,.18); }
  [data-ism].ism-known { color: inherit; }
  [data-ism].ism-new { color: #ff9a9a; text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 2px; text-shadow: 0 0 3px rgba(0,0,0,.85), 0 0 2px rgba(0,0,0,.85); }
  [data-ism].ism-learning { color: #9ec7ff; text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 2px; text-shadow: 0 0 3px rgba(0,0,0,.85), 0 0 2px rgba(0,0,0,.85); }
  [data-ism].ism-unknown { color: #ffd79a; text-decoration: underline; text-decoration-style: dotted; text-decoration-thickness: 2px; text-underline-offset: 2px; text-shadow: 0 0 3px rgba(0,0,0,.85), 0 0 2px rgba(0,0,0,.85); }
  [data-ism].ism-mark { background: rgba(0,0,0,.42); }
  [data-ism].ism-new.ism-mark { background: rgba(190,44,44,.42); }
  [data-ism].ism-learning.ism-mark { background: rgba(37,99,235,.42); }
  [data-ism].ism-unknown.ism-mark { background: rgba(160,105,20,.42); }
  `;

  /* ---------- 状态 ---------- */
  let host = null, root = null, refs = null;
  let pageStyle = null;          /* 注入到页面 <head> 的字幕标记样式 */
  let currentHref = '';
  let open = false;
  let lastReport = null;
  let settings = {
    ui: { badge: true, badgeSide: 'right' },
    subs: { autoAnalyze: true, mark: true, markStyle: 'line' },
    rating: { system: 'step' }
  };
  const POS_PAD = 14;            /* 胶囊与视口边缘的最小间距 */
  let dragging = null;           /* 拖动会话 */
  let suppressClick = false;     /* 拖动结束后抑制紧随的 click，避免误触展开 */
  let dead = false;              /* 扩展上下文已失效（见 ctxAlive） */
  let navTimer = 0;              /* 轮询定时器句柄，自毁时要清掉 */

  /* 扩展被「重新加载 / 更新 / 停用」后，已注入的旧内容脚本会被孤立：
     `chrome.runtime` 变成 undefined，此后任何 api.runtime.sendMessage 都会抛
     “Cannot read properties of undefined (reading 'sendMessage')”。
     这种脚本自己救不回来——只能自毁，让后台注入的新脚本接管。 */
  function ctxAlive() {
    try { return !!(api && api.runtime && api.runtime.id); } catch (e) { return false; }
  }

  function selfDestruct() {
    if (dead) return;
    dead = true;
    try { clearInterval(navTimer); } catch (e) { /* 忽略 */ }
    try { subsMarkStop(); } catch (e) { /* 忽略 */ }
    try { if (pageStyle && pageStyle.parentNode) pageStyle.parentNode.removeChild(pageStyle); } catch (e) { /* 忽略 */ }
    try { if (host && host.parentNode) host.parentNode.removeChild(host); } catch (e) { /* 忽略 */ }
    host = null; root = null; refs = null; pageStyle = null;
  }

  /* 评级体系：三种尺子衡量同一份结果，切换只改「看哪套」。 */
  const RATING_ITEMS = [['step', 'L1–L4'], ['cefr', 'CEFR'], ['lexile', '蓝思']];
  const LEVEL_TONE = { 1: 'ok', 2: 'good', 3: 'warn', 4: 'bad' };
  function currentRating(r) {
    const rs = (r && r.ratings) || {};
    return rs[settings.rating.system] || rs.step || {
      code: 'L' + (r && r.level), text: (r && r.levelText) || '', tier: (r && r.tier) || '',
      tone: LEVEL_TONE[r && r.level] || 'warn', desc: ''
    };
  }
  function allRatings(r) {
    const x = (r && r.ratings) || {};
    const out = [];
    if (x.step) out.push('阶梯 <b>' + x.step.code + '</b>');
    if (x.cefr) out.push('CEFR <b>' + x.cefr.code + '</b>');
    if (x.lexile) out.push('蓝思 <b>' + x.lexile.code + '</b>');
    return out.join(' · ') || '—';
  }
  function switcherHtml() {
    const cur = settings.rating.system;
    return `<div class="sw">${RATING_ITEMS.map(([id, label]) =>
      `<button data-rate="${id}" data-on="${cur === id ? 1 : 0}">${label}</button>`).join('')}</div>`;
  }
  async function setRating(id) {
    settings.rating = { system: id };
    try {
      const r = await api.storage.local.get('iv.settings');
      const cur = (r && r['iv.settings']) || {};
      cur.rating = Object.assign({}, cur.rating || {}, { system: id });
      await api.storage.local.set({ 'iv.settings': cur });
    } catch (e) { /* 忽略 */ }
    if (lastReport && lastReport.tokens) { renderPill(lastReport); if (open) renderPanel(lastReport); }
  }

  function isVideoPage() { return VIDEO_PATH_RE.test(location.pathname); }

  function mount() {
    if (host) return;
    /* 幂等：旧的孤立脚本可能已经挂过一个根节点，先摘掉再挂新的，避免出现两个胶囊 */
    try {
      const stale = document.getElementById('inkread-video-root');
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    } catch (e) { /* 忽略 */ }
    host = document.createElement('div');
    host.id = 'inkread-video-root';
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
      <button class="pill" data-state="loading" part="pill">
        <span class="dot"></span>
        <span class="lv">…</span>
        <span class="cov"></span>
        <span class="sep"></span>
        <span class="mini">分析中</span>
      </button>
      <section class="panel" role="dialog" aria-label="InkRead 视频生词分析">
        <div class="ph">
          <div class="ph-logo">读</div>
          <div class="ph-main">
            <div class="ph-t"><span class="ph-site">—</span><span class="ph-sub"></span></div>
            <div class="ph-title">—</div>
          </div>
          <button class="ph-x" title="收起">✕</button>
        </div>
        <div class="body"><div class="skel">正在读取字幕并比对词库…</div></div>
      </section>`;
    sr.appendChild(wrap);

    /* 点词卡片：与胶囊同处 Shadow DOM，但用 fixed 定位跟到被点的词旁边 */
    const card = document.createElement('div');
    card.className = 'wcard';
    card.hidden = true;
    sr.appendChild(card);

    (document.body || document.documentElement).appendChild(host);
    ensurePageStyle();

    refs = {
      wrap,
      pill: wrap.querySelector('.pill'),
      lv: wrap.querySelector('.lv'),
      cov: wrap.querySelector('.cov'),
      mini: wrap.querySelector('.mini'),
      panel: wrap.querySelector('.panel'),
      phSite: wrap.querySelector('.ph-site'),
      phSub: wrap.querySelector('.ph-sub'),
      phTitle: wrap.querySelector('.ph-title'),
      body: wrap.querySelector('.body'),
      card
    };
    bindDrag(wrap, refs.pill);
    wrap.querySelector('.ph-x').addEventListener('click', () => toggle(false));
    card.addEventListener('click', e => e.stopPropagation());
    root = sr;
  }

  /* 字幕逐词标记的样式必须在页面 DOM 里生效（Shadow DOM 隔离不到字幕），单独注入一份 */
  function ensurePageStyle() {
    if (pageStyle && pageStyle.isConnected) return;
    try {
      pageStyle = document.getElementById('inkread-subs-style');
      if (!pageStyle) {
        pageStyle = document.createElement('style');
        pageStyle.id = 'inkread-subs-style';
        pageStyle.textContent = PAGE_CSS;
      }
      (document.head || document.documentElement).appendChild(pageStyle);
    } catch (e) { pageStyle = null; }
  }

  /* 拖动胶囊移动位置（pointer 事件，鼠标/触屏通用）；只点不动则是展开/收起 */
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
      if (!dragging.moved && Math.abs(dx) + Math.abs(dy) < 4) return;   /* 抖动阈值：小于 4px 仍算点击 */
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

  function toggle(v) {
    open = v;
    refs.wrap.setAttribute('data-open', v ? '1' : '0');
    if (v && lastReport) renderPanel(lastReport);
  }

  const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* 位置用「视口可用空间的比例」存（0–1），换分辨率/缩放都不会跑丢。
     没有存过位置时：默认右侧·垂直居中（老设置的 badgeSide='left' 则默认左侧居中）。 */
  function readPos() {
    const p = settings.ui && settings.ui.pos;
    if (p && typeof p.x === 'number' && typeof p.y === 'number') {
      return { x: clampNum(p.x, 0, 1), y: clampNum(p.y, 0, 1) };
    }
    return { x: (settings.ui && settings.ui.badgeSide === 'left') ? 0 : 1, y: 0.5 };
  }

  /* 面板朝屏幕内侧展开：胶囊在右半屏 → 面板右对齐向左展开；靠顶则向下展开 */
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
    if (!host) return;
    const p = readPos();
    placeWrap(p.x, p.y);
  }

  async function savePos() {
    const wrap = refs.wrap;
    const w = wrap.offsetWidth || 132, h = wrap.offsetHeight || 34;
    const left = parseFloat(wrap.style.left) || 0, top = parseFloat(wrap.style.top) || 0;
    const maxX = Math.max(1, window.innerWidth - w - POS_PAD * 2);
    const maxY = Math.max(1, window.innerHeight - h - POS_PAD * 2);
    const pos = {
      x: +clampNum((left - POS_PAD) / maxX, 0, 1).toFixed(4),
      y: +clampNum((top - POS_PAD) / maxY, 0, 1).toFixed(4)
    };
    settings.ui = Object.assign({}, settings.ui, { pos });
    try {
      const r = await api.storage.local.get('iv.settings');
      const cur = (r && r['iv.settings']) || {};
      cur.ui = Object.assign({}, cur.ui || {}, { pos });
      await api.storage.local.set({ 'iv.settings': cur });
    } catch (e) { /* 忽略 */ }
  }

  /* 视口变化时按存的比例重算，保证胶囊永远在可视区内 */
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!host || dragging) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!dragging) applyPrefs(); }, 150);
  });

  function show(state, text) {
    if (!host) return;
    if (!settings.ui.badge) { refs.wrap.setAttribute('hidden', ''); return; }
    refs.wrap.removeAttribute('hidden');
    if (!dragging) applyPrefs();     /* 可见后再定位，尺寸测量才准 */
    refs.pill.setAttribute('data-state', state);
    if (text != null) refs.mini.textContent = text;
  }

  function hide() { if (host) refs.wrap.setAttribute('hidden', ''); }

  /* ---------- 渲染 ---------- */
  const TONE = { 1: '#2e9e6b', 2: '#3b82f6', 3: '#d98a19', 4: '#d64545' };
  const TONE_BY_NAME = { ok: '#2e9e6b', good: '#3b82f6', warn: '#d98a19', bad: '#d64545' };
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /* 多行文本 → HTML：先转义，再把「字面量 \n / \r\n」（词典与后端文案里就是这样存的）
     与真实换行统一换成 <br>，与 web/js/util.js#escLines 完全同口径，避免界面出现裸的 \n。 */
  const escLines = s => esc(s)
    .replace(/\\r\\n|\\n|\\r/g, '<br>')
    .replace(/\r\n|\r|\n/g, '<br>');

  /* 当前体系对应的色调：切到 CEFR / 蓝思时用它们自己的难度热度，而不是 L1–L4 的档位色 */
  function activeTone(r) {
    const rating = currentRating(r);
    if (settings.rating.system !== 'step' && TONE_BY_NAME[rating.tone]) return TONE_BY_NAME[rating.tone];
    return TONE[r.level] || '#6b7280';
  }

  function renderPill(r) {
    const rating = currentRating(r);
    refs.wrap.style.setProperty('--tone', activeTone(r));
    refs.pill.setAttribute('data-state', r.tokens ? 'ok' : 'error');
    refs.lv.textContent = r.tokens ? (rating.code || ('L' + r.level)) : '!';
    refs.cov.textContent = r.tokens ? Math.round(r.coverage * 100) + '%' : '';
    refs.mini.textContent = r.tokens
      ? (settings.rating.system === 'step'
        ? (r.verdict.kind === 'ideal' ? 'i+1 理想' : r.levelText)
        : (rating.text || ''))
      : '无法评估';
    refs.cov.style.display = r.tokens ? '' : 'none';
  }

  function ringSvg(pct, tone) {
    const R = 38, C = 2 * Math.PI * R;
    const off = C * (1 - Math.max(0, Math.min(1, pct)));
    return `<svg width="92" height="92" viewBox="0 0 92 92">
      <circle class="bg" cx="46" cy="46" r="${R}" fill="none" stroke-width="8"></circle>
      <circle class="fg" cx="46" cy="46" r="${R}" fill="none" stroke-width="8"
        stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"></circle>
    </svg>`;
  }

  function bandBar(f) {
    const t = f.bandTok, sum = Math.max(1, t[1] + t[2] + t[3] + t[4] + t[5]);
    const pc = n => (n / sum * 100).toFixed(2) + '%';
    const names = { 1: '核心 1000', 2: '常用 2500', 3: '进阶 5000', 4: '高阶 5000+', 5: '生僻/专名' };
    const colors = { 1: '#2e9e6b', 2: '#4a9be8', 3: '#d98a19', 4: '#d97757', 5: '#8b5cf6' };
    return `<div class="bar">${[1, 2, 3, 4, 5].map(b => `<i class="b${b}" style="width:${pc(t[b])}"></i>`).join('')}</div>
      <div class="legend">${[1, 2, 3, 4, 5].map(b => `<span><em style="background:${colors[b]}"></em>${names[b]} ${Math.round(t[b] / sum * 100)}%</span>`).join('')}</div>`;
  }

  function renderPanel(r) {
    if (!refs) return;
    const st = r.subtitle || {};
    const srcName = { 'player-track': '播放器签名轨', 'player-response': '播放器响应', 'innertube': 'InnerTube 兜底' }[st.source] || '';
    const viaName = st.via ? (/^page/.test(st.via) ? '页面通道' : '后台通道') : '';
    refs.phSite.textContent = r.siteLabel || '视频';
    refs.phSub.textContent = st.label
      ? '· ' + st.label + (srcName ? ' · ' + srcName : '') + (viaName ? ' · ' + viaName : '')
      : (st.fallback ? '· 仅标题/简介（未读到视频内字幕）' : '');
    refs.phTitle.textContent = r.title || '(无标题)';

    const tone = TONE[r.level] || '#6b7280';
    refs.wrap.style.setProperty('--tone', tone);

    if (r.error === 'unsupported') {
      refs.body.innerHTML = `<div class="note">当前页面不是受支持的视频站点。</div>`;
      return;
    }
    if (!r.tokens) {
      const reason = st.reason || '未能获取到可分析的文本';
      refs.body.innerHTML = `
        <div class="note"><b>无法评估这个词视频</b><br>${escLines(reason)}${st.debug ? `<br><span style="opacity:.72">${escLines(st.debug)}</span>` : ''}</div>
        <div class="foot"><span class="src">${esc(vocabText(r))}</span><button class="btn" data-act="reload">重试</button></div>`;
      bindBody();
      return;
    }

    const pct = Math.round(r.coverage * 1000) / 10;
    const f = r.freq || { bandTok: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, level: 0, text: '—', tier: '', coreRatio: 0, ready: false };
    const top = (r.topUnknown || []).slice(0, 14);
    const rating = currentRating(r);
    const isStep = settings.rating.system === 'step';
    const markOn = !!settings.subs.mark;
    const markInfo = markOn
      ? (_sm.linked ? '播放器字幕逐词上色，点词查释义 / 改标记' : '已就绪，等待词库联动后上色')
      : '已关闭';

    refs.body.innerHTML = `
      ${switcherHtml()}

      <div class="subrow">
        <span class="t"><b>字幕标记</b> · ${esc(markInfo)}</span>
        <button class="tg" data-act="subsmark" data-on="${markOn ? 1 : 0}">${markOn ? '已开' : '开启'}</button>
      </div>

      <div class="hero">
        <div class="ring">
          ${ringSvg(r.coverage, TONE_BY_NAME[rating.tone] || tone)}
          <div class="mid"><div class="num">${pct}<i>%</i></div><div class="cap">可理解度</div></div>
        </div>
        <div class="hero-main">
          <span class="lvl">${esc(rating.code || ('L' + r.level))} · ${esc(rating.text || r.levelText)}</span>
          <div class="tier">${esc(rating.tier || r.tier)}${r.wordsPerNew ? ` · 平均每 ${r.wordsPerNew} 词遇 1 个生词` : ''}</div>
          ${isStep
            ? `<div class="verd ${r.verdict.ok ? 'ok' : 'no'}">${r.verdict.ok ? '✓ ' : '✕ '}${esc(r.verdict.title)}</div>
               <div class="vd">${escLines(r.verdict.detail)}</div>`
            : `<div class="vd" style="margin-top:6px">${escLines(rating.desc || '')}</div>`}
          <div class="allrate">三套体系：${allRatings(r)}</div>
        </div>
      </div>

      <div class="grid">
        <div class="cell"><b>${r.tokens}</b><span>总词次</span></div>
        <div class="cell"><b>${r.unique}</b><span>独立词</span></div>
        <div class="cell"><b>${r.missTok}</b><span>生词词次</span></div>
        <div class="cell"><b>${r.density}</b><span>生词/百词</span></div>
      </div>

      <div class="sec">
        <div class="sec-h"><span>客观难度（脱离你的词库）</span><b>${allRatings(r)}</b></div>
        ${bandBar(f)}
      </div>

      <div class="sec">
        <div class="sec-h"><span>高频生词（先攻这些收益最大）</span><b>${top.length ? 'Top ' + top.length : ''}</b></div>
        ${top.length
          ? `<div class="chips">${top.map(t => `<span class="chip" data-s="${esc(t.s)}" title="${esc(STATUS_TXT[t.s] || t.s)}${t.bandName ? ' · ' + esc(t.bandName) + '词' : ''}"><b>${esc(t.w)}</b><em>×${t.c}</em></span>`).join('')}</div>`
          : `<div class="empty">没有生词——这个词视频对你几乎没有词汇门槛。</div>`}
      </div>

      <div class="foot">
        <span class="src">词库：${esc(vocabText(r))}</span>
        <button class="btn" data-act="reload">重新分析</button>
      </div>`;
    bindBody();
  }

  const STATUS_TXT = { known: '已学', learning: '在学', new: '生词本', unknown: '生词' };

  function vocabText(r) {
    const v = r.vocab || {};
    if (v.mode === 'off') return '未联动（空词库）';
    if (v.ok && v.count) return `${v.label || '墨读'} · ${v.count} 词`;
    if (v.count) return `${v.label || '导入文件'} · ${v.count} 词（离线缓存）`;
    return v.error || '未联动';
  }

  function bindBody() {
    const btn = refs.body.querySelector('[data-act="reload"]');
    if (btn) btn.addEventListener('click', () => analyze(true));
    refs.body.querySelectorAll('[data-rate]').forEach(b =>
      b.addEventListener('click', () => setRating(b.dataset.rate)));
    const tg = refs.body.querySelector('[data-act="subsmark"]');
    if (tg) tg.addEventListener('click', () => setSubsMark(!settings.subs.mark));
  }

  /* 面板里的「字幕标记」开关：与设置页的 subs.mark 是同一个值，写回 storage 后三处同步 */
  async function setSubsMark(v) {
    settings.subs = Object.assign({}, settings.subs, { mark: !!v });
    try {
      const r = await api.storage.local.get('iv.settings');
      const cur = (r && r['iv.settings']) || {};
      cur.subs = Object.assign({}, cur.subs || {}, { mark: !!v });
      await api.storage.local.set({ 'iv.settings': cur });
    } catch (e) { /* 忽略 */ }
    subsSync();
    if (lastReport) renderPanel(lastReport);
  }

  /* ---------- 分析 ---------- */
  async function analyze(force) {
    if (dead) return;
    /* 上下文已失效（扩展刚更新/重载）→ 自毁，等后台重新注入新脚本。
       不能在这里硬发消息：只会抛 “Cannot read properties of undefined”。 */
    if (!ctxAlive()) { selfDestruct(); return; }
    mount(); applyPrefs();
    if (!isVideoPage()) { hide(); return; }
    subsSync();                     /* 字幕标记：只要在视频页就生效，与报告是否算得出来无关 */
    show('loading', '分析中');
    if (open && !lastReport) refs.body.innerHTML = '<div class="skel">正在读取字幕并比对词库…</div>';
    try {
      const r = await api.runtime.sendMessage({ type: 'analyze', href: location.href, force: !!force });
      if (!r || r.error === 'unsupported') { hide(); return; }
      lastReport = r;
      renderPill(r);
      show(r.tokens ? 'ok' : 'error', r.tokens ? (r.verdict.kind === 'ideal' ? 'i+1 理想' : r.levelText) : '无法评估');
      if (open) renderPanel(r);
    } catch (e) {
      const m = String((e && e.message) || e);
      /* 孤立上下文在「发消息的一瞬间」才彻底暴露：此处兜底自毁，交给后台重新注入 */
      if (!ctxAlive() || /context invalidated|Receiving end does not exist|reading 'sendMessage'/.test(m)) {
        selfDestruct(); return;
      }
      lastReport = { error: 'analyze-failed', subtitle: { reason: '与扩展后台通信失败：' + m } };
      renderPill({ level: 4, tokens: 0, coverage: 0, verdict: { kind: 'fail' }, levelText: '' });
      show('error', '通信失败');
      if (open) renderPanel(lastReport);
    }
  }

  /* ---------- DOM 兜底：从 <script> 里抠出播放器数据 ----------
     内容脚本与页面共享 DOM（只是 JS 世界隔离），所以能读到内联脚本文本。
     用于 Firefox < 128 等不支持 scripting world:'MAIN' 的场景。 */
  function sliceJson(s, start) {
    let depth = 0, inStr = false, q = '', escp = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (escp) escp = false;
        else if (c === '\\') escp = true;
        else if (c === q) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; q = c; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
    return null;
  }

  function extractAfter(markerRe) {
    const scripts = document.querySelectorAll('script:not([src])');
    for (const sc of scripts) {
      const t = sc.textContent || '';
      if (!t || t.length < 40) continue;
      const m = markerRe.exec(t);
      if (!m) continue;
      const start = t.indexOf('{', m.index + m[0].length - 1);
      if (start < 0) continue;
      const json = sliceJson(t, start);
      if (!json) continue;
      try { return JSON.parse(json); } catch (e) { /* 试下一个 */ }
    }
    return null;
  }

  function domProbe(site) {
    try {
      if (site === 'youtube') {
        const pr = extractAfter(/ytInitialPlayerResponse\s*=\s*/);
        if (!pr) return { site, ok: false };
        const vd = pr.videoDetails || {};
        const tl = (pr.captions && pr.captions.playerCaptionsTracklistRenderer) || {};
        return {
          site, ok: true, title: vd.title || document.title, videoId: vd.videoId || '', desc: vd.shortDescription || '',
          captionSource: (tl.captionTracks && tl.captionTracks.length) ? 'player-response' : '',
          captions: (tl.captionTracks || []).map(t => ({
            baseUrl: t.url || t.baseUrl, languageCode: t.languageCode || '', vssId: t.vssId || '', kind: t.kind || '',
            name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0] && t.name.runs[0].text))) || ''
          }))
        };
      }
      if (site === 'bilibili') {
        const st = extractAfter(/__INITIAL_STATE__\s*=\s*/);
        if (!st) return { site, ok: false };
        const vd = st.videoData || {}, ep = st.epInfo || {};
        const sub = vd.subtitle || {};
        return {
          site, ok: true, title: vd.title || ep.title || document.title,
          aid: vd.aid || ep.aid || null, bvid: vd.bvid || null, cid: vd.cid || ep.cid || null, epId: ep.ep_id || null,
          desc: vd.desc || '',
          subtitleTracks: (sub.subtitles || sub.list || []).map(x => ({ lan: x.lan || '', lan_doc: x.lan_doc || '', subtitle_url: x.subtitle_url || x.subtitleUrl || '' }))
        };
      }
    } catch (e) { return { site, ok: false, error: String(e && e.message || e) }; }
    return { site, ok: false };
  }

  /* ================= 字幕逐词标记 =================
     目标：在 YouTube / 哔哩哔哩 的**播放器字幕**里逐词上色，点词看离线释义、直接改标记
     （已学 / 在学 / 生词本），与文章正文的逐词着色用同一套语义与同一份词库状态。

     工程要点：
       · 字幕 DOM 由播放器高频重绘（每帧都可能重设 textContent）。因此绝不能整段重建字幕，
         只能「原地把文本节点拆成 [文本][span][文本]」；播放器重绘会自然把我们的 span 冲掉，
         靠 MutationObserver 防抖后再包一次，形成稳定的增量闭环。
       · 观察分两层：body 级（只看 childList，用于**发现**字幕容器，几乎不增加开销）
         + 容器级（childList+characterData，用于**跟踪**字幕变化）。两层共用同一个防抖。
       · 状态一律来自后台 wordStatuses（词库 + 用户手标，含词形还原），页面侧只做
         toLowerCase 查表 —— 与 article.js 同一条约定，避免两处实现漂移。
       · 未联动词库时不着色（否则每个词都算 unknown，满屏橙点，比不标更糟）。 */
  const SUB_ROOTS = {
    youtube: ['.ytp-caption-window-container', '.ytp-caption-window', '.caption-window'],
    bilibili: [
      '.bpx-player-subtitle-panel',
      '.bpx-player-subtitle-panel-text',
      '.bpx-player-subtitle-panel-text-inner',
      '.bilibili-player-video-subtitle',
      '.bilibili-player-video-subtitle-text'
    ]
  };
  const SUBS_WORD_RE = /[A-Za-z][A-Za-z'’\-]*/g;
  const SUBS_SCAN_MS = 160;          /* 字幕重绘防抖：攒一攒再扫，避免每帧都做 DOM 手术 */
  const SUBS_QUERY_MAX = 600;        /* 单次查询词数上限 */

  const _sm = {
    obs: null,                       /* body 级观察器（发现字幕容器） */
    roots: [], robs: [],             /* 已接管的字幕容器 + 各自的观察器 */
    timer: 0, flush: 0,
    cache: new Map(),                /* word(lower) → status */
    pending: new Set(),              /* 待查状态的新词 */
    known: false, linked: false,     /* 是否已知「词库有没有联动」/ 有没有联动 */
    on: false, style: 'line',
    marked: 0
  };
  let _wc = null;                    /* 当前词卡：{ word, el, rect } */
  const _dictCache = new Map();

  function siteOf() {
    const h = String(location.hostname || '').toLowerCase();
    if (/youtube\.com$/.test(h)) return 'youtube';
    if (/bilibili\.com$/.test(h)) return 'bilibili';
    return '';
  }

  function subsRoots() {
    const sels = SUB_ROOTS[siteOf()] || [];
    const out = [];
    for (const sel of sels) {
      let list;
      try { list = document.querySelectorAll(sel); } catch (e) { list = []; }
      for (const el of list) if (el && out.indexOf(el) < 0) out.push(el);
    }
    return out;
  }

  function subsCollect(rootEl) {
    const out = [];
    let walker;
    try {
      walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const v = node.nodeValue;
          if (!v || !/[A-Za-z]/.test(v)) return NodeFilter.FILTER_REJECT;
          const p = node.parentElement;
          if (p && p.getAttribute && p.getAttribute('data-ism')) return NodeFilter.FILTER_REJECT;
          if (p && p.tagName && /^(STYLE|SCRIPT|NOSCRIPT|TEXTAREA)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
    } catch (e) { return out; }
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function subsPaint(el, st) {
    /* 未联动词库：保持原样（ism-known 只继承颜色、无装饰），联动后再上色 */
    const linked = _sm.linked;
    const cls = linked ? ('ism-' + st) : 'ism-known';
    el.className = cls + (linked && _sm.style === 'mark' ? ' ism-mark' : '');
  }

  /* 把一个字幕文本节点拆成 [文本][span][文本]…；返回包出来的词数 */
  function subsWrap(node) {
    const text = node.nodeValue;
    const parent = node.parentNode;
    if (!parent || !text) return 0;
    SUBS_WORD_RE.lastIndex = 0;
    let m, last = 0, count = 0, frag = null;
    while ((m = SUBS_WORD_RE.exec(text))) {
      const w = m[0];
      const lower = w.toLowerCase();
      if (!frag) frag = document.createDocumentFragment();
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const el = document.createElement('span');
      el.setAttribute('data-ism', '1');
      el.setAttribute('data-w', w);
      subsPaint(el, _sm.cache.get(lower) || 'unknown');
      el.textContent = w;
      frag.appendChild(el);
      last = m.index + w.length;
      count++;
      /* 缓存里没有、且（还没确认联动状态 或 已确认联动）→ 排进待查队列 */
      if (!_sm.cache.has(lower) && (!_sm.known || _sm.linked)) _sm.pending.add(w);
    }
    if (!count) return 0;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag, node);
    return count;
  }

  /* 把已包好的字幕词重新上色（状态到货 / 样式切换后调用） */
  function subsRepaint() {
    let list;
    try { list = document.querySelectorAll('[data-ism="1"]'); } catch (e) { return; }
    for (const el of list) {
      const w = String(el.getAttribute('data-w') || el.textContent || '').toLowerCase();
      if (!_sm.cache.has(w)) continue;
      subsPaint(el, _sm.cache.get(w));
    }
  }

  function subsUnwrap() {
    let list;
    try { list = document.querySelectorAll('[data-ism="1"]'); } catch (e) { return; }
    const parents = new Set();
    for (const el of list) {
      const p = el.parentNode;
      if (!p) continue;
      try { p.replaceChild(document.createTextNode(el.textContent), el); parents.add(p); } catch (e) { /* 忽略 */ }
    }
    parents.forEach(p => { try { p.normalize(); } catch (e) { /* 忽略 */ } });
  }

  function subsScheduleFlush() {
    if (_sm.flush) return;
    _sm.flush = setTimeout(subsFlush, 240);
  }

  async function subsFlush() {
    _sm.flush = 0;
    if (dead || !_sm.pending.size || !ctxAlive()) return;
    const words = Array.from(_sm.pending).slice(0, SUBS_QUERY_MAX);
    _sm.pending.clear();
    try {
      const res = await api.runtime.sendMessage({ type: 'wordStatuses', words });
      if (res && res.ok) {
        _sm.linked = !!res.linked;
        _sm.known = true;
        for (const pair of (res.statuses || [])) {
          if (pair && pair[0]) _sm.cache.set(String(pair[0]).toLowerCase(), pair[1]);
        }
        subsRepaint();
      }
    } catch (e) { /* 忽略：下次扫描再试 */ }
    if (_sm.pending.size) subsScheduleFlush();
  }

  /* 发现并接管字幕容器；返回本次新接管数量 */
  function subsAttach() {
    const roots = subsRoots();
    let added = 0;
    for (const r of roots) {
      if (_sm.roots.indexOf(r) >= 0) continue;
      _sm.roots.push(r);
      added++;
      try {
        const ob = new MutationObserver(subsBump);
        ob.observe(r, { childList: true, subtree: true, characterData: true });
        _sm.robs.push(ob);
      } catch (e) { _sm.robs.push(null); }
    }
    /* 清掉已脱离文档的容器（换视频 / 切换播放器时会重建） */
    for (let i = _sm.roots.length - 1; i >= 0; i--) {
      if (_sm.roots[i].isConnected) continue;
      try { if (_sm.robs[i]) _sm.robs[i].disconnect(); } catch (e) { /* 忽略 */ }
      _sm.roots.splice(i, 1);
      _sm.robs.splice(i, 1);
    }
    return added;
  }

  function subsBump() {
    if (_sm.timer) return;
    _sm.timer = setTimeout(() => { _sm.timer = 0; subsScan(); }, SUBS_SCAN_MS);
  }

  function subsScan() {
    if (dead || !_sm.on || !siteOf()) return;
    subsAttach();
    if (!_sm.roots.length) return;
    ensurePageStyle();
    let marked = 0;
    for (const r of _sm.roots) {
      if (!r.isConnected) continue;
      for (const node of subsCollect(r)) marked += subsWrap(node);
    }
    _sm.marked = marked;
    if (_sm.pending.size) subsScheduleFlush();
  }

  function subsMarkStart() {
    if (dead || !siteOf()) return;
    ensurePageStyle();
    if (!_sm.obs) {
      try { _sm.obs = new MutationObserver(subsBump); } catch (e) { _sm.obs = null; }
    }
    if (_sm.obs) {
      try { _sm.obs.observe(document.body || document.documentElement, { childList: true, subtree: true }); } catch (e) { /* 忽略 */ }
    }
    subsBump();
  }

  function subsMarkStop() {
    if (_sm.obs) { try { _sm.obs.disconnect(); } catch (e) { /* 忽略 */ } _sm.obs = null; }
    for (const ob of _sm.robs) { try { if (ob) ob.disconnect(); } catch (e) { /* 忽略 */ } }
    _sm.robs = []; _sm.roots = [];
    subsUnwrap();
    if (_sm.timer) { clearTimeout(_sm.timer); _sm.timer = 0; }
    if (_sm.flush) { clearTimeout(_sm.flush); _sm.flush = 0; }
    _sm.marked = 0;
    _sm.known = false; _sm.linked = false;
    hideCard();
  }

  /* 设置里改了「字幕标记 / 样式」后对账 */
  function subsSync() {
    const on = !!settings.subs.mark;
    const style = settings.subs.markStyle === 'mark' ? 'mark' : 'line';
    const styleChanged = style !== _sm.style;
    _sm.style = style;
    if (on && !_sm.on) { _sm.on = true; subsMarkStart(); }
    else if (!on && _sm.on) { _sm.on = false; subsMarkStop(); }
    else if (on && styleChanged) subsRepaint();
  }

  /* ---------- 字幕点词卡片 ---------- */
  function hideCard() {
    _wc = null;
    if (refs && refs.card) refs.card.hidden = true;
  }

  function cardHtml(word, st, entry) {
    const ok = !!(entry && entry.ok);
    const phon = (ok && entry.phonetic) ? `<span class="ph-txt">/${esc(entry.phonetic)}/</span>` : '';
    let meaning = '<span class="loading">查询离线词典…</span>';
    if (entry) {
      if (ok) meaning = escLines(entry.meaning || '(无释义)');
      else {
        const lw = String(word).toLowerCase();
        meaning = escLines((entry.message || '未查到释义') + ((entry.word && entry.word !== lw) ? '（原形 ' + entry.word + '）' : ''));
      }
    }
    const cur = _sm.cache.get(String(word).toLowerCase()) || null;
    const btn = (id, label) => `<button data-mk="${id}" data-on="${cur === id ? 1 : 0}">${label}</button>`;
    const clr = cur ? `<button class="clr" data-mk="" title="取消标记">✕</button>` : '';
    return `<div class="hd">
        <span class="wd">${esc(word)}</span>${phon}
        <span class="st" data-s="${esc(st)}">${esc(STATUS_TXT[st] || st)}</span>
        <button class="x" title="关闭">✕</button>
      </div>
      <div class="mn${(entry && !ok) ? ' empty' : ''}">${meaning}</div>
      <div class="mk">${btn('new', '生词本')}${btn('learning', '在学')}${btn('known', '已学')}${clr}</div>
      <div class="ft"><span>墨读离线词典</span><span class="grow"></span><span>${esc(location.hostname)} 字幕</span></div>`;
  }

  function paintCard(word, st, entry) {
    if (!refs) return;
    const card = refs.card;
    card.hidden = false;
    card.innerHTML = cardHtml(word, st, entry);
    card.querySelectorAll('[data-mk]').forEach(b => b.addEventListener('click', ev => {
      ev.preventDefault(); ev.stopPropagation();
      markWord(word, b.dataset.mk || null);
    }));
    const x = card.querySelector('.x');
    if (x) x.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); hideCard(); });
  }

  function placeCard() {
    if (!_wc || !refs) return;
    const card = refs.card;
    if (card.hidden) return;
    let r = _wc.rect;
    if (!r && _wc.el && _wc.el.isConnected) r = _wc.el.getBoundingClientRect();
    if (!r) return;
    const w = card.offsetWidth || 290, h = card.offsetHeight || 190;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(10, Math.min(left, Math.max(10, window.innerWidth - w - 10)));
    let top = r.top - h - 10;
    if (top < 10) top = Math.min(r.bottom + 10, Math.max(10, window.innerHeight - h - 10));
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
  }

  async function showWordCard(el, word) {
    if (!word) return;
    mount();
    const lower = String(word).toLowerCase();
    const st = _sm.cache.get(lower) || 'unknown';
    const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    _wc = { word, el, rect };
    paintCard(word, st, null);
    placeCard();
    let entry = _dictCache.get(lower);
    if (entry === undefined) {
      try { entry = await api.runtime.sendMessage({ type: 'dictLookup', word }); }
      catch (err) { entry = { ok: false, message: '通信失败：' + (err && err.message || err) }; }
      _dictCache.set(lower, entry || { ok: false, message: '未查到释义' });
    }
    if (!_wc || String(_wc.word).toLowerCase() !== lower) return;   /* 用户已经点了别的词 */
    paintCard(word, _sm.cache.get(lower) || st, entry);
    placeCard();
  }

  async function markWord(word, status) {
    const lower = String(word).toLowerCase();
    const cur = _sm.cache.get(lower) || null;
    const next = (status == null) ? null : (cur === status ? null : status);   /* 再点一次 = 取消 */
    try { await api.runtime.sendMessage({ type: 'markSet', word, status: next }); } catch (e) { /* 忽略 */ }
    if (next) _sm.cache.set(lower, next); else _sm.cache.delete(lower);
    subsRepaint();
    if (_wc && String(_wc.word).toLowerCase() === lower) {
      paintCard(word, _sm.cache.get(lower) || 'unknown', _dictCache.get(lower) || null);
      placeCard();
    }
  }

  /* 页面级 capture 监听：字幕词被点中时抢下事件（否则会被播放器的「点击暂停」吃掉）。
     注意 Shadow DOM 会把面板/卡片内部的点击 target 重定向到宿主，这里必须先放行。 */
  document.addEventListener('click', e => {
    const t = e.target;
    if (t === host) return;                       /* 点在自己的面板 / 卡片上 */
    const el = (t && t.closest) ? t.closest('[data-ism="1"]') : null;
    if (!el) { if (_wc) hideCard(); return; }
    e.preventDefault();
    e.stopPropagation();
    showWordCard(el, el.getAttribute('data-w') || el.textContent || '');
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && _wc) hideCard(); }, true);
  window.addEventListener('resize', () => { if (_wc) placeCard(); });

  /* ---------- 导航监听（SPA + 传统） ---------- */
  function onNav() {
    if (dead) return;
    if (location.href === currentHref) return;
    currentHref = location.href;
    lastReport = null;
    open = false;
    if (host) { refs.wrap.setAttribute('data-open', '0'); }
    subsMarkStop();                 /* 换页/换视频：先摘干净，再按当前设置重挂 */
    if (!isVideoPage()) { hide(); subsSync(); return; }
    subsSync();
    if (!settings.subs.autoAnalyze) { hide(); return; }
    analyze(false);
  }

  window.addEventListener('yt-navigate-finish', () => setTimeout(onNav, 350), true);
  window.addEventListener('popstate', () => setTimeout(onNav, 350));
  navTimer = setInterval(onNav, POLL_MS);

  /* ---------- 与后台通信 ---------- */
  if (ctxAlive()) api.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'domProbe') { reply(domProbe(msg.site)); return; }
    if (msg.type === 'fetchCaption') {
      /* 在**页面上下文**里抓字幕：请求带页面自己的 Origin / Referer / Cookie，与播放器取字幕时一致。
         YouTube 现在要求 PoToken，且缺 token 时是 HTTP 200 + **空 body**（不抛错）——所以必须
         「取到非空文本」才算成功。凭据按「最可能成功」排序：same-origin（同源带 Cookie，
         与播放器一致）→ omit → include。每次尝试都挂 **AbortController 硬超时**，绝不至于把通道挂死。 */
      (async () => {
        /* 只用 same-origin 与 omit：内容脚本的 fetch 按**页面 Origin** 计，同源请求
           `same-origin` 就会带上 Cookie（与播放器一致）；对跨域目标它等同 omit，配合
           服务端 `ACAO:*` 正好可读。`include` 对不带凭据回显的跨域目标会长时间挂起
           （AbortController 也要等满超时），收益小、代价大，故不用。 */
        const inits = [
          { credentials: 'same-origin', cache: 'no-store' },
          { credentials: 'omit', cache: 'no-store' }
        ];
        let err = '';
        for (const init of inits) {
          const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { } }, 6000) : null;
          try {
            const r = await fetch(msg.url, ctrl ? { ...init, signal: ctrl.signal } : init);
            if (!r.ok) { err = 'HTTP ' + r.status; continue; }
            const t = await r.text();
            if (t && t.trim()) { reply({ ok: true, text: t, via: 'page:' + init.credentials }); return; }
            err = 'empty';
          } catch (e) { err = String((e && e.message) || e); }
          finally { if (timer) clearTimeout(timer); }
        }
        reply({ ok: false, error: err || 'empty' });
      })();
      return true;   // 异步回复，保持消息通道
    }
    if (msg.type === 'showPanel') { mount(); applyPrefs(); if (msg.report) { lastReport = msg.report; renderPill(msg.report); show('ok', msg.report.levelText); } toggle(msg.open !== false); reply({ ok: true }); return; }
    if (msg.type === 'refresh') { analyze(true); reply({ ok: true }); return; }
    if (msg.type === 'settings') {
      settings = msg.settings || settings;
      applyPrefs();
      subsSync();
      if (host) show('ok');
      reply({ ok: true });
      return;
    }
  });

  if (ctxAlive()) api.runtime.sendMessage({ type: 'ping' })
    .then(() => { mount(); applyPrefs(); onNav(); })
    .catch(() => { /* 后台未就绪 */ });

  /* 首次加载：取一次设置 */
  if (ctxAlive()) api.storage.local.get('iv.settings').then(r => {
    const s = r && r['iv.settings'];
    if (s) {
      settings = {
        ui: { ...settings.ui, ...(s.ui || {}) },
        subs: { ...settings.subs, ...(s.subs || {}) },
        rating: { ...settings.rating, ...(s.rating || {}) }
      };
      applyPrefs();
      subsSync();
    }
  }).catch(() => { });
})();
