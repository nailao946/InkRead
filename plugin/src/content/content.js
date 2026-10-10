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
    right: 18px; bottom: 84px;
    font: 13px/1.5 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    color: #e8eaf0;
    --tone: #6b7280;
    --bg: rgba(20,23,29,.86);
    --line: rgba(255,255,255,.10);
  }
  .wrap[data-side="left"] { right: auto; left: 18px; }
  .wrap[hidden] { display: none; }

  /* ---------- 收起态胶囊 ---------- */
  .pill {
    display: inline-flex; align-items: center; gap: 7px;
    height: 34px; padding: 0 13px 0 11px; cursor: pointer;
    border: 1px solid var(--line); border-radius: 999px;
    background: var(--bg); backdrop-filter: blur(14px) saturate(1.4);
    -webkit-backdrop-filter: blur(14px) saturate(1.4);
    box-shadow: 0 6px 22px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.06);
    color: inherit; font: inherit; font-weight: 600;
    transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
  }
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
  `;

  /* ---------- 状态 ---------- */
  let host = null, root = null, refs = null;
  let currentHref = '';
  let open = false;
  let lastReport = null;
  let settings = { ui: { badge: true, badgeSide: 'right' }, subs: { autoAnalyze: true } };

  function isVideoPage() { return VIDEO_PATH_RE.test(location.pathname); }

  function mount() {
    if (host) return;
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
    (document.body || document.documentElement).appendChild(host);

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
      body: wrap.querySelector('.body')
    };
    refs.pill.addEventListener('click', () => toggle(!open));
    wrap.querySelector('.ph-x').addEventListener('click', () => toggle(false));
    root = sr;
  }

  function toggle(v) {
    open = v;
    refs.wrap.setAttribute('data-open', v ? '1' : '0');
    if (v && lastReport) renderPanel(lastReport);
  }

  function applyPrefs() {
    if (!host) return;
    refs.wrap.setAttribute('data-side', settings.ui.badgeSide === 'left' ? 'left' : 'right');
  }

  function show(state, text) {
    if (!host) return;
    if (!settings.ui.badge) { refs.wrap.setAttribute('hidden', ''); return; }
    refs.wrap.removeAttribute('hidden');
    refs.pill.setAttribute('data-state', state);
    if (text != null) refs.mini.textContent = text;
  }

  function hide() { if (host) refs.wrap.setAttribute('hidden', ''); }

  /* ---------- 渲染 ---------- */
  const TONE = { 1: '#2e9e6b', 2: '#3b82f6', 3: '#d98a19', 4: '#d64545' };
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function renderPill(r) {
    const tone = TONE[r.level] || '#6b7280';
    refs.wrap.style.setProperty('--tone', tone);
    refs.pill.setAttribute('data-state', r.tokens ? 'ok' : 'error');
    refs.lv.textContent = r.tokens ? 'L' + r.level : '!';
    refs.cov.textContent = r.tokens ? Math.round(r.coverage * 100) + '%' : '';
    refs.mini.textContent = r.tokens ? (r.verdict.kind === 'ideal' ? 'i+1 理想' : r.levelText) : '无法评估';
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
    refs.phSite.textContent = r.siteLabel || '视频';
    refs.phSub.textContent = r.subtitle && r.subtitle.label ? '· ' + r.subtitle.label : (r.subtitle && r.subtitle.fallback ? '· 仅标题/简介' : '');
    refs.phTitle.textContent = r.title || '(无标题)';

    const tone = TONE[r.level] || '#6b7280';
    refs.wrap.style.setProperty('--tone', tone);

    if (r.error === 'unsupported') {
      refs.body.innerHTML = `<div class="note">当前页面不是受支持的视频站点。</div>`;
      return;
    }
    if (!r.tokens) {
      const reason = (r.subtitle && r.subtitle.reason) || '未能获取到可分析的文本';
      refs.body.innerHTML = `
        <div class="note"><b>无法评估这个词视频</b><br>${esc(reason)}</div>
        <div class="foot"><span class="src">${esc(vocabText(r))}</span><button class="btn" data-act="reload">重试</button></div>`;
      bindBody();
      return;
    }

    const pct = Math.round(r.coverage * 1000) / 10;
    const f = r.freq || { bandTok: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, level: 0, text: '—', tier: '', coreRatio: 0, ready: false };
    const top = (r.topUnknown || []).slice(0, 14);

    refs.body.innerHTML = `
      <div class="hero">
        <div class="ring">
          ${ringSvg(r.coverage, tone)}
          <div class="mid"><div class="num">${pct}<i>%</i></div><div class="cap">可理解度</div></div>
        </div>
        <div class="hero-main">
          <span class="lvl">L${r.level} · ${esc(r.levelText)}</span>
          <div class="tier">${esc(r.tier)}${r.wordsPerNew ? ` · 平均每 ${r.wordsPerNew} 词遇 1 个生词` : ''}</div>
          <div class="verd ${r.verdict.ok ? 'ok' : 'no'}">${r.verdict.ok ? '✓ ' : '✕ '}${esc(r.verdict.title)}</div>
          <div class="vd">${esc(r.verdict.detail)}</div>
        </div>
      </div>

      <div class="grid">
        <div class="cell"><b>${r.tokens}</b><span>总词次</span></div>
        <div class="cell"><b>${r.unique}</b><span>独立词</span></div>
        <div class="cell"><b>${r.missTok}</b><span>生词词次</span></div>
        <div class="cell"><b>${r.density}</b><span>生词/百词</span></div>
      </div>

      <div class="sec">
        <div class="sec-h"><span>视频客观难度（脱离你的词库）</span><b>L${f.level} ${esc(f.text)}${f.tier ? ' · ' + esc(f.tier) : ''}</b></div>
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
  }

  /* ---------- 分析 ---------- */
  async function analyze(force) {
    mount(); applyPrefs();
    if (!isVideoPage()) { hide(); return; }
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
      lastReport = { error: 'analyze-failed', subtitle: { reason: '与扩展后台通信失败：' + (e && e.message || e) } };
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
          captions: (tl.captionTracks || []).map(t => ({
            baseUrl: t.baseUrl, languageCode: t.languageCode || '', vssId: t.vssId || '', kind: t.kind || '',
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

  /* ---------- 导航监听（SPA + 传统） ---------- */
  function onNav() {
    if (location.href === currentHref) return;
    currentHref = location.href;
    lastReport = null;
    open = false;
    if (host) { refs.wrap.setAttribute('data-open', '0'); }
    if (!isVideoPage()) { hide(); return; }
    if (!settings.subs.autoAnalyze) { hide(); return; }
    analyze(false);
  }

  window.addEventListener('yt-navigate-finish', () => setTimeout(onNav, 350), true);
  window.addEventListener('popstate', () => setTimeout(onNav, 350));
  setInterval(onNav, POLL_MS);

  /* ---------- 与后台通信 ---------- */
  api.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'domProbe') { reply(domProbe(msg.site)); return; }
    if (msg.type === 'showPanel') { mount(); applyPrefs(); if (msg.report) { lastReport = msg.report; renderPill(msg.report); show('ok', msg.report.levelText); } toggle(msg.open !== false); reply({ ok: true }); return; }
    if (msg.type === 'refresh') { analyze(true); reply({ ok: true }); return; }
    if (msg.type === 'settings') { settings = msg.settings || settings; applyPrefs(); if (host) show('ok'); reply({ ok: true }); return; }
  });

  api.runtime.sendMessage({ type: 'ping' })
    .then(() => { mount(); applyPrefs(); onNav(); })
    .catch(() => { /* 后台未就绪 */ });

  /* 首次加载：取一次设置 */
  api.storage.local.get('iv.settings').then(r => {
    const s = r && r['iv.settings'];
    if (s) { settings = { ui: { ...settings.ui, ...(s.ui || {}) }, subs: { ...settings.subs, ...(s.subs || {}) } }; applyPrefs(); }
  }).catch(() => { });
})();
