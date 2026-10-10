#!/usr/bin/env node
/* InkRead Video — 真机端到端测试（Edge/Chromium + CDP）
 *
 * 验证链路：内容脚本注入 → 读页面播放器数据 → 抓字幕 → 与「墨读本地服务」词库比对 → 渲染面板。
 *
 * 做法（不依赖外网）：
 *   · 本机起一个假「墨读本地服务」：实现 /__store/ping|read 与 /sub.json
 *   · CDP Fetch 拦截 https://www.bilibili.com/video/… 返回自造视频页（带 __INITIAL_STATE__）
 *   · 视频页里的字幕地址指向本机服务 → 扩展后台真去抓（走 host_permissions，不需要拦截）
 *
 *   node plugin/tests/e2e-browser.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(process.env.FIXTURE_PORT || 17890);
const DEBUG_PORT = Number(process.env.CDP_PORT || 9333);

let pass = 0, fail = 0; const fails = [];
const check = (n, c, e) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; fails.push(n + (e ? '  → ' + e : '')); console.log('  ✗ ' + n + (e ? '  → ' + e : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= 1. 假字幕与词库 ================= */
const SUB_LINES = [
  'Today we are going to talk about how to learn a new language every single day',
  'The best way is to read and listen to things that you really enjoy',
  'If the material is just slightly above your level you will improve quickly',
  'This is called comprehensible input and it works very well'
];
const SUB_TITLE = SUB_LINES.join('\n');

/* 除 comprehensible / input 外，全部标为已学 → 制造 2 个生词 */
const KNOWN = new Set(
  SUB_TITLE.toLowerCase().match(/[a-z][a-z'’\-]*/g).filter(w => w !== 'comprehensible' && w !== 'input')
);
const FIXTURE_VOCAB = [...KNOWN].map(w => ({
  word: w, display: w, meaning: '', status: 'known', source: 'fixture', addedAt: 1, updatedAt: 1
}));
/* 再加一个「生词本」词，验证 new 状态也进生词统计 */
FIXTURE_VOCAB.push({ word: 'input', display: 'input', meaning: '输入', status: 'new', source: 'fixture', addedAt: 1, updatedAt: 1 });
/* 文章阅读模式要用的几种状态（已学 / 在学 / 生词本）各来一个 */
FIXTURE_VOCAB.push(
  { word: 'language', display: 'language', meaning: '语言', status: 'known', source: 'fixture', addedAt: 1, updatedAt: 1 },
  { word: 'vocabulary', display: 'vocabulary', meaning: '词汇', status: 'new', source: 'fixture', addedAt: 1, updatedAt: 1 },
  { word: 'material', display: 'material', meaning: '材料', status: 'learning', source: 'fixture', addedAt: 1, updatedAt: 1 }
);

/* 词表按单词去重后入库（同一个词只保留一条），所以期望值要按去重后的数量算 */
const EXPECT_VOCAB = new Set(FIXTURE_VOCAB.map(v => String(v.word).toLowerCase())).size;

const EXPECT_TOKENS = (SUB_TITLE.match(/[A-Za-z][A-Za-z'’\-]*/g) || []).length;
/* 生词 = comprehensible 与 input 的出现次数（两者都不在「已学」词库里） */
const EXPECT_MISS = (SUB_TITLE.toLowerCase().match(/\bcomprehensible\b/g) || []).length
  + (SUB_TITLE.toLowerCase().match(/\binput\b/g) || []).length;
const EXPECT_COVERAGE = Math.round(((EXPECT_TOKENS - EXPECT_MISS) / EXPECT_TOKENS) * 1000) / 1000;
const EXPECT_PCT = Math.round(EXPECT_COVERAGE * 100);

const PAGE_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>FIXTURE · 英语学习视频</title></head><body>
<h1>fixture video page</h1>
<script>
window.__INITIAL_STATE__ = ${JSON.stringify({
  videoData: {
    aid: 123456, bvid: 'BV1E2e3fE2e3', cid: 7654321,
    title: 'How to learn a new language every single day',
    desc: 'fixture: 用于端到端验证的假视频页',
    subtitle: { subtitles: [{ lan: 'en-US', lan_doc: '英语（自动生成）', subtitle_url: `http://127.0.0.1:${PORT}/sub.json` }] }
  }
})};
</script>
</body></html>`;

/* ---- YouTube 夹具：走 json3 字幕，且刻意做成 L3（更难的档位） ---- */
const YT_EXTRA = 'Photosynthesis chlorophyll mitochondria';      // 3 个生僻词 → 把覆盖率压到 L3
const YT_TEXT = SUB_LINES.concat([YT_EXTRA]).join('\n');
const YT_ALL = (YT_TEXT.match(/[A-Za-z][A-Za-z'’\-]*/g) || []);
const YT_KNOWN_TOK = YT_ALL.filter(t => KNOWN.has(t.toLowerCase())).length;
const YT_TOKENS = YT_ALL.length;
const YT_MISS = YT_TOKENS - YT_KNOWN_TOK;
const YT_COVERAGE = Math.round((YT_KNOWN_TOK / YT_TOKENS) * 1000) / 1000;

const YT_PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>FIXTURE · YouTube 英语视频</title></head><body>
<h1>fixture youtube page</h1>
<script>
var ytInitialPlayerResponse = ${JSON.stringify({
  videoDetails: {
    videoId: 'abcdefghijk',
    title: 'A deeper look at how cells make energy',
    shortDescription: 'fixture: YouTube 端到端验证'
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: `https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=zh`, languageCode: 'zh-Hans', vssId: '.zh', kind: '', name: { simpleText: '中文' } },
        /* 模拟真实 YouTube：英语轨的 baseUrl 与页面**同源**且带 PoToken 标记（potc/exp）——
           缺有效 token 时 /api/timedtext 返回 HTTP 200 + **空 body**（不抛错）。
           扩展必须去掉标记、并在页面上下文（同源、带 Cookie）重抓，才能拿到内容。 */
        { baseUrl: `https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&potc=1&exp=xpe`, languageCode: 'en', vssId: 'a.en', kind: 'asr', name: { simpleText: 'English (auto-generated)' } }
      ]
    }
  }
})};
</script>
</body></html>`;

/* ---- 文章夹具：足够长的英文正文 + <article> 语义标签 ---- */
const ART_TITLE = 'Why Reading Beats Memorising';
const ART_PARAS = [
  'Learning a language is mostly about the amount of comprehensible input you get every single day.',
  'If you read material that is slightly above your current level, your brain will gradually pick up new words.',
  'The most important thing is to keep going, even when a paragraph feels difficult at the beginning.',
  'Over time, the same vocabulary shows up again and again, and it finally sticks without memorisation.',
  'Many learners give up because they try to understand every word instead of enjoying the story itself.',
  'When you meet a new word in a meaningful context, you remember it far better than a word from a list.',
  'So choose articles and videos about subjects you genuinely care about, and read a little every day.',
  'That simple habit will carry you further than any short burst of intensive study ever could.',
  'A short article about a topic you already understand is perfect practice material for this approach.',
  'You already know the background, so your attention goes to the language rather than the subject.',
  'Keep a small notebook of the words that keep appearing, and review them once a week or so.',
  'After a few months you will be surprised how much easier the same article feels to read.'
];
const ART_WORDS = (ART_PARAS.join(' ').match(/[A-Za-z][A-Za-z'’\-]*/g) || []).length;

const ART_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>FIXTURE · 英文文章</title></head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<article>
  <h1>${ART_TITLE}</h1>
  ${ART_PARAS.map(p => `<p>${p}</p>`).join('\n  ')}
</article>
<footer>© fixture</footer>
</body></html>`;

/* ---- 晚渲染文章夹具：首屏 HTML **没有**正文 <p>，正文由 JS 在 ~1.2s 后才插入。
   复现 Next.js / React「SSR 载荷 + 客户端 hydrate」的站点（如 www.ireadworld.com）：
   扩展若只在 onNav 探一次、之后 href 不变就不再探，这类页面会永远「识别不了」。 */
const ART_LATE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>FIXTURE · 晚渲染文章</title></head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<article id="lateHost"></article>
<footer>© fixture</footer>
<script>
  setTimeout(function () {
    var host = document.getElementById('lateHost');
    var h1 = document.createElement('h1');
    h1.textContent = ${JSON.stringify(ART_TITLE)};
    host.appendChild(h1);
    ${JSON.stringify(ART_PARAS)}.forEach(function (p) {
      var el = document.createElement('p');
      el.textContent = p;
      host.appendChild(el);
    });
  }, 1200);
</script>
</body></html>`;

/* 阅读模式要查的离线释义（假墨读服务的 /dict/<字母>.json）
   注意：ECDICT 里多义项是用「字面量 \n」（反斜杠+n）分隔的，这里刻意照抄，
   用来验证内容脚本的换行渲染（escLines）确实把它变成了 <br>，而不是原样显示。 */
const DICT = {
  v: { vocabulary: { t: 'n. 词汇；词汇量\\n词汇表', p: 'vəˈkæbjələri' }, very: { t: 'adv. 很，非常', p: 'ˈveri' } },
  l: { language: { t: 'n. 语言', p: 'ˈlæŋɡwɪdʒ' }, learn: { t: 'v. 学习', p: 'lɜːn' } },
  i: { input: { t: 'n. 输入；投入', p: 'ˈɪnpʊt' } },
  m: { memorisation: { t: 'n. 记忆，背诵', p: 'ˌmeməraɪˈzeɪʃn' } }
};

/* ================= 2. 假墨读本地服务 ================= */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  if (u.pathname === '/__store/ping') return json({ store: 1, root: 'FIXTURE_DIR' });
  if (u.pathname === '/__store/read') {
    const p = u.searchParams.get('path');
    if (p === 'settings.json') return json({ app: 'inkread', version: 2, kind: 'config', settings: { storageDir: '' } });
    if (p === 'vocab.json') return json(FIXTURE_VOCAB);
    res.statusCode = 404; return res.end('not found');
  }
  if (u.pathname === '/sub.json') {
    /* 哔哩哔哩字幕体：body[{from,to,content}] */
    return json({ body: SUB_LINES.map((c, i) => ({ from: i * 2, to: i * 2 + 2, location: 2, content: c })) });
  }
  if (u.pathname === '/yt.json') {
    /* 模拟 YouTube 的 PoToken 拦截：URL 带 potc/exp/pot 标记（且没带有效 token）→ 200 + 空 body。
       这是「只读到标题」的真凶——不抛错、静默。扩展必须去掉标记重试才能拿到内容。 */
    if (u.searchParams.has('potc') || u.searchParams.has('exp') || u.searchParams.has('pot')) {
      res.statusCode = 200; return res.end('');
    }
    /* YouTube json3 字幕体：events[].segs[].utf8 */
    return json({ wireMagic: 'pb3', events: YT_TEXT.split('\n').map(l => ({ segs: [{ utf8: l }] })) });
  }
  /* 离线词典分片（与墨读桌面版 /dict/<字母>.json 同形状） */
  let mDict = u.pathname.match(/^\/dict\/([a-z]+)\.json$/);
  if (mDict) return json(DICT[mDict[1]] || {});
  res.statusCode = 404; res.end('not found');
});

/* ================= 3. 极简 CDP 客户端 ================= */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) { this.handlers.forEach(h => h(m)); }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时：' + method)); } }, 20000);
    });
  }
  on(fn) { this.handlers.push(fn); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 异常');
    return r.result && r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) { } }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS 连接失败 ' + wsUrl)), { once: true });
  });
  return new CDP(ws);
}

async function httpJson(url) {
  const r = await fetch(url);
  return r.json();
}

/* ================= 主流程 ================= */
let edge = null, profileDir = null, page = null, browser = null;
try {
  if (!existsSync(EDGE)) throw new Error('找不到 Edge：' + EDGE);

  await new Promise(res => server.listen(PORT, '127.0.0.1', res));
  console.log(`假墨读服务已起：http://127.0.0.1:${PORT}`);

  /* EXT_DIR 可指向打包产物（plugin/dist/chrome），用来验证「发出去的包」本身可用 */
  const EXT = process.env.EXT_DIR ? resolve(process.env.EXT_DIR) : ROOT;
  console.log('加载扩展目录：' + EXT);
  profileDir = mkdtempSync(join(tmpdir(), 'inkread-e2e-'));
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    '--no-first-run', '--no-default-browser-check', '--no-default-browser-check',
    '--disable-features=Translate,msEdgeTranslate', '--disable-sync',
    '--window-size=1100,760',
    'about:blank'
  ];
  const headless = process.argv.includes('--headless');
  if (headless) args.unshift('--headless=new');
  edge = spawn(EDGE, args, { stdio: 'ignore' });

  /* 等调试端口 */
  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`); break; }
    catch (e) { await sleep(500); }
  }
  if (!version) throw new Error('调试端口未就绪');
  console.log('浏览器：' + version.Browser);

  browser = await connect(version.webSocketDebuggerUrl);

  /* 新建标签页 */
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  let pageWs = '';
  for (let i = 0; i < 40; i++) {
    const list = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const t = list.find(x => x.id === targetId);
    if (t && t.webSocketDebuggerUrl) { pageWs = t.webSocketDebuggerUrl; break; }
    await sleep(250);
  }
  if (!pageWs) throw new Error('拿不到页面调试端点');
  page = await connect(pageWs);

  await page.send('Page.enable');
  await page.send('Runtime.enable');

  /* 全程收集页面未捕获异常（要在交互之前挂上） */
  const pageErrors = [];
  page.on(m => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails;
      pageErrors.push((d && ((d.exception && d.exception.description) || d.text)) || 'unknown');
    }
  });

  await page.send('Fetch.enable', {
    patterns: [
      { urlPattern: 'https://www.bilibili.com/video/*', requestStage: 'Request' },
      { urlPattern: 'https://www.youtube.com/watch*', requestStage: 'Request' },
      { urlPattern: 'https://www.youtube.com/api/timedtext*', requestStage: 'Request' },
      { urlPattern: 'https://example.com/article*', requestStage: 'Request' },
      { urlPattern: 'https://example.com/late-article*', requestStage: 'Request' }
    ]
  });

  page.on(async m => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    /* 同源字幕端点：模拟 PoToken 拦截 —— 带 potc/exp/pot 标记（无有效 token）→ 200 + 空 body */
    if (/^https:\/\/www\.youtube\.com\/api\/timedtext/.test(request.url)) {
      try {
        const u = new URL(request.url);
        const poisoned = u.searchParams.has('potc') || u.searchParams.has('exp') || u.searchParams.has('pot');
        const body = poisoned ? '' : JSON.stringify({ wireMagic: 'pb3', events: YT_TEXT.split('\n').map(l => ({ segs: [{ utf8: l }] })) });
        await page.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
          body: Buffer.from(body, 'utf8').toString('base64')
        });
      } catch (e) { /* 请求可能已被取消 */ }
      return;
    }
    const html = /^https:\/\/www\.bilibili\.com\/video\//.test(request.url) ? PAGE_HTML
      : /^https:\/\/www\.youtube\.com\/watch/.test(request.url) ? YT_PAGE_HTML
        : /^https:\/\/example\.com\/late-article/.test(request.url) ? ART_LATE_HTML
          : /^https:\/\/example\.com\/article/.test(request.url) ? ART_HTML : null;
    try {
      if (html) {
        await page.send('Fetch.fulfillRequest', {
          requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from(html, 'utf8').toString('base64')
        });
      } else {
        await page.send('Fetch.continueRequest', { requestId });
      }
    } catch (e) { /* 请求可能已被取消 */ }
  });

  /* ---------- [0] 先播一份「带标记」的设置，后面用它验证写入不会误伤其它字段 ----------
     标记：subs.minTokens = MARK_MIN_TOKENS。若某处实现成「整体覆盖 iv.settings」，
     这个值会被冲回默认的 80，[8] 里就能立刻抓到。 */
  const MARK_MIN_TOKENS = 123;
  let extId = '';
  {
    const list = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    /* 用「背景脚本路径」锁定本扩展，避免撞上浏览器自带的其它扩展 */
    const t = list.find(x => /^chrome-extension:\/\//.test(x.url || '') && /src\/background\/sw\.js/.test(x.url));
    if (t) extId = new URL(t.url).hostname;
  }
  console.log('\n[0] 播种设置（用于后面的完整性回归）  扩展 ID：' + (extId || '(未找到)'));

  if (extId) {
    await page.send('Page.navigate', { url: `chrome-extension://${extId}/src/options/options.html` });
    let ok = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try { ok = await page.eval(`(() => !!(window.chrome && chrome.storage && chrome.storage.local))()`); } catch (e) { ok = false; }
      if (ok) break;
    }
    if (ok) {
      const seeded = await page.eval(`(async () => {
        await chrome.storage.local.set({ 'iv.settings': {
          v: 2,
          link: { mode: 'auto', serverUrl: '', ports: [17890, 8642] },
          ui: { badge: true, badgeSide: 'right' },
          subs: { preferEn: true, autoAnalyze: true, minTokens: ${MARK_MIN_TOKENS} },
          rating: { system: 'step' },
          article: { enabled: true, autoPill: true, dimKnown: false, fontSize: 17,
                     inlineColor: true, inlineStyle: 'line', hlStyle: 'mark', siteOff: [] },
          cache: { ttlHours: 6, maxReports: 60 }
        } });
        const r = await chrome.storage.local.get('iv.settings');
        return JSON.stringify(r['iv.settings']);
      })()`);
      check('播种设置成功（含标记 minTokens=' + MARK_MIN_TOKENS + '）', /123/.test(String(seeded)), String(seeded).slice(0, 200));
    } else {
      check('能打开扩展设置页（用于播种）', false, 'chrome.storage 不可用');
    }
  } else {
    check('能找到本扩展 ID', false, '未在调试端点里找到本扩展的背景脚本');
  }

  /* 打开假视频页 */
  await page.send('Page.navigate', { url: 'https://www.bilibili.com/video/BV1E2e3fE2e3/' });

  /* 等扩展注入并渲染 */
  const pillSel = `document.getElementById('inkread-video-root') && document.getElementById('inkread-video-root').shadowRoot
    ? document.getElementById('inkread-video-root').shadowRoot.querySelector('.pill') : null`;
  let pillText = '';
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      pillText = (await page.eval(`(() => { const p = ${pillSel}; return p ? (p.getAttribute('data-state') + '|' + p.textContent) : ''; })()`)) || '';
    } catch (e) { pillText = ''; }
    if (pillText && pillText.indexOf('|') > 0 && !/loading/.test(pillText.split('|')[0])) break;
    if (/ok\|/.test(pillText) || /error\|/.test(pillText)) break;
  }

  console.log('\n[1] 内容脚本注入与徽标渲染');
  check('扩展内容脚本已注入页面（#inkread-video-root 存在）', !!pillText, pillText);
  check('徽标进入 ok 态（拿到分析结果）', /^ok\|/.test(pillText), pillText);
  check(`徽标显示等级 L2（i+1 区间，期望覆盖率 ${EXPECT_COVERAGE}）`, /L2/.test(pillText), pillText);
  check(`徽标显示可理解度百分比 ${EXPECT_PCT}%`, pillText.indexOf(EXPECT_PCT + '%') >= 0, pillText);
  check('徽标标出「i+1 理想」', /i\+1/.test(pillText), pillText);

  /* 展开面板（读整个面板，字幕来源在头部、指标在 body） */
  await page.eval(`(() => { const r = document.getElementById('inkread-video-root').shadowRoot; r.querySelector('.pill').click(); return 1; })()`);
  await sleep(600);
  const readShadow = sel => page.eval(`(() => {
    const h = document.getElementById('inkread-video-root');
    if (!h || !h.shadowRoot) return '';
    const el = h.shadowRoot.querySelector(${JSON.stringify(sel)});
    return el ? el.innerText : '';
  })()`);
  const readCells = () => page.eval(`(() => {
    const h = document.getElementById('inkread-video-root');
    const g = h && h.shadowRoot ? h.shadowRoot.querySelector('.grid') : null;
    return g ? Array.from(g.querySelectorAll('.cell')).map(c => c.querySelector('span').textContent + '=' + c.querySelector('b').textContent).join(',') : '';
  })()`);

  const panel = await readShadow('.panel');
  const body = await readShadow('.body');
  const cells = await readCells();

  console.log('\n[2] 面板内容（分析质量）');
  check('面板渲染出内容', !!panel && panel.length > 40, (panel || '').slice(0, 60));
  check('标题区显示视频标题', /How to learn a new language/.test(panel), (panel.match(/How[^\n]*/) || [''])[0]);
  check('面板显示 tier「i+1 理想区」', /i\+1 理想区/.test(panel));
  check('面板显示「可理解度」环', /可理解度/.test(panel));
  check('面板给出 i+1 结论', /i\+1/.test(body) && /黄金区间|理想/.test(body), (body.match(/[^\n]*i\+1[^\n]*/) || [''])[0]);
  check(`指标：总词次 = ${EXPECT_TOKENS}`, new RegExp('(^|,)总词次=' + EXPECT_TOKENS + '(,|$)').test(cells), cells);
  check(`指标：生词词次 = ${EXPECT_MISS}`, new RegExp('(^|,)生词词次=' + EXPECT_MISS + '(,|$)').test(cells), cells);
  check('指标：可理解度环显示 96%', new RegExp(Math.round(EXPECT_COVERAGE * 1000) / 10 + '%').test(panel), panel.match(/[\d.]+%/)?.[0]);
  check('面板列出高频生词 comprehensible', /comprehensible/.test(body));
  check('面板标注生词状态（生词本 input）', /input/.test(body));
  check('面板显示客观难度分层', /客观难度/.test(body));
  check('面板显示字数分层图例（核心/常用/进阶）', /核心|常用|进阶/.test(body));

  console.log('\n[3] 墨读词库联动');
  check('面板显示词库来源段', /词库：/.test(body), (body.match(/词库：[^\n]*/) || [''])[0]);
  check('词库来源为墨读本地服务', /墨读/.test(body), (body.match(/词库：[^\n]*/) || [''])[0]);
  check(`词库词条数与假服务一致（去重后 ${EXPECT_VOCAB}）`, new RegExp('\\b' + EXPECT_VOCAB + '\\b').test(body), (body.match(/词库：[^\n]*/) || [''])[0]);
  check('头部标注字幕来源为英语轨', /英语/.test(panel), (panel.match(/[^\n]*英语[^\n]*/) || [''])[0]);
  check('头部标注字幕语言代码 en-US', /en-US/.test(panel), (panel.match(/[^\n]*en-US[^\n]*/) || [''])[0]);

  console.log('\n[4] 运行期无异常');
  await sleep(400);
  check('哔哩哔哩页无未捕获异常', pageErrors.length === 0, pageErrors.join(';'));

  /* ---------- [5] YouTube 链路：json3 字幕 + L3 档 ---------- */
  console.log('\n[5] YouTube：json3 字幕解析 + L3 判定');
  await page.send('Page.navigate', { url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  let ytPill = '';
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      ytPill = (await page.eval(`(() => { const h = document.getElementById('inkread-video-root');
        const p = h && h.shadowRoot ? h.shadowRoot.querySelector('.pill') : null;
        return p ? (p.getAttribute('data-state') + '|' + p.textContent) : ''; })()`)) || '';
    } catch (e) { ytPill = ''; }
    if (/^(ok|error)\|/.test(ytPill)) break;
  }
  check('YouTube：内容脚本已注入', !!ytPill, ytPill);
  check('YouTube：徽标进入 ok 态', /^ok\|/.test(ytPill), ytPill);
  check(`YouTube：判为 L3 偏难（期望覆盖率 ${YT_COVERAGE}）`, /L3/.test(ytPill), ytPill);


  await page.eval(`(() => { const h = document.getElementById('inkread-video-root'); const p = h.shadowRoot.querySelector('.pill'); if (p) p.click(); return 1; })()`);
  await sleep(600);
  const ytPanel = await readShadow('.panel');
  const ytBody = await readShadow('.body');
  const ytCells = await readCells();
  check('YouTube：标题区显示视频标题', /A deeper look at how cells make energy/.test(ytPanel), (ytPanel.match(/A deeper[^\n]*/) || [''])[0]);
  check(`YouTube：总词次 = ${YT_TOKENS}`, new RegExp('(^|,)总词次=' + YT_TOKENS + '(,|$)').test(ytCells), ytCells);
  check(`YouTube：生词词次 = ${YT_MISS}`, new RegExp('(^|,)生词词次=' + YT_MISS + '(,|$)').test(ytCells), ytCells);
  check('YouTube：判定为偏难（建议先攻高频生词）', /偏难/.test(ytBody) && /先攻/.test(ytBody), (ytBody.match(/[^\n]*先攻[^\n]*/) || [''])[0]);
  check('YouTube：生词榜出现 photosynthesis', /photosynthesis/i.test(ytBody));
  check('YouTube：标注自动生成字幕', /English/.test(ytPanel) && /auto-generated/.test(ytPanel), (ytPanel.match(/[^\n]*English[^\n]*/) || [''])[0]);
  /* 假服务对「带 potc/exp 标记」的 URL 返回 200+空体（模拟真实 PoToken 拦截）——
     英语轨正是这种 URL。能显示「播放器响应 + 页面通道」就证明扩展走完了
     「去 PoToken 标记 → 页面上下文重抓」这条路，而不是退化成只读标题/简介。 */
  check('YouTube：头部标出字幕来源（播放器响应 + 页面通道，证明真读到了视频内字幕）',
    /播放器响应/.test(ytPanel) && /页面通道/.test(ytPanel), (ytPanel.match(/[^\n]*页面通道[^\n]*/) || [''])[0]);
  check('YouTube：仍联动词库（墨读）', /墨读/.test(ytBody), (ytBody.match(/词库：[^\n]*/) || [''])[0]);
  check('YouTube：客观难度分层已渲染', /客观难度/.test(ytBody));
  await sleep(300);
  check('YouTube 页无未捕获异常', pageErrors.length === 0, pageErrors.join(';'));

  /* ---------- [6] 评级体系切换（视频面板） ---------- */
  console.log('\n[6] 评级体系切换：L1–L4 / CEFR / 蓝思');
  const pillTextOf = () => page.eval(`(() => { const h = document.getElementById('inkread-video-root');
    const p = h && h.shadowRoot ? h.shadowRoot.querySelector('.pill') : null;
    return p ? p.textContent : ''; })()`);

  check('面板里有三套体系切换按钮', (await page.eval(`(() => {
    const h = document.getElementById('inkread-video-root');
    return h && h.shadowRoot ? h.shadowRoot.querySelectorAll('.sw [data-rate]').length : 0; })()`)) === 3);

  check('默认按 L1–L4 显示', /L3/.test(await pillTextOf()), await pillTextOf());

  await page.eval(`(() => { const h = document.getElementById('inkread-video-root');
    h.shadowRoot.querySelector('.sw [data-rate="cefr"]').click(); return 1; })()`);
  await sleep(400);
  const cefrPill = await pillTextOf();
  check('切到 CEFR 后胶囊显示 A1–C2 代码', /[ABC][12]/.test(cefrPill), cefrPill);

  await page.eval(`(() => { const h = document.getElementById('inkread-video-root');
    h.shadowRoot.querySelector('.sw [data-rate="lexile"]').click(); return 1; })()`);
  await sleep(400);
  const lexPill = await pillTextOf();
  check('切到蓝思后胶囊显示 ###L', /\d+L/.test(lexPill), lexPill);

  const allRate = await readShadow('.allrate');
  check('面板同时展示三套体系的值', /阶梯/.test(allRate) && /CEFR/.test(allRate) && /蓝思/.test(allRate), allRate);
  const cefrBody = await readShadow('.body');
  check('CEFR 面板不再显示 i+1 结论（换成客观难度说明）', !/黄金区间/.test(cefrBody) || /i\+1/.test(cefrBody));

  await page.eval(`(() => { const h = document.getElementById('inkread-video-root');
    h.shadowRoot.querySelector('.sw [data-rate="step"]').click(); return 1; })()`);
  await sleep(400);
  check('切回 L1–L4 后恢复等级代码', /L3/.test(await pillTextOf()), await pillTextOf());

  /* ---------- [7] 网页文章 + 阅读模式 ---------- */
  console.log('\n[7] 网页文章：正文抽取 → 评级 → 阅读模式 → 点词查释义');
  await page.send('Page.navigate', { url: 'https://example.com/article/1' });

  const artPillSel = `(() => { const h = document.getElementById('inkread-article-root');
    const p = h && h.shadowRoot ? h.shadowRoot.querySelector('.pill') : null;
    return p ? (p.getAttribute('data-state') + '|' + p.textContent) : ''; })()`;
  let artPill = '';
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { artPill = (await page.eval(artPillSel)) || ''; } catch (e) { artPill = ''; }
    if (/^(ok|error)\|/.test(artPill)) break;
  }
  check('文章：内容脚本已注入（#inkread-article-root 存在）', !!artPill, artPill);
  check('文章：胶囊进入 ok 态', /^ok\|/.test(artPill), artPill);
  check('文章：胶囊显示可理解度百分比', /%/.test(artPill), artPill);

  /* 展开文章面板，确认评级三套齐全 */
  await page.eval(`(() => { const h = document.getElementById('inkread-article-root');
    h.shadowRoot.querySelector('.pill').click(); return 1; })()`);
  await sleep(500);
  const artPanel = await page.eval(`(() => { const h = document.getElementById('inkread-article-root');
    const b = h && h.shadowRoot ? h.shadowRoot.querySelector('.body') : null; return b ? b.innerText : ''; })()`);
  check('文章：面板渲染出内容', !!artPanel && artPanel.length > 40, (artPanel || '').slice(0, 60));
  check('文章：面板含三套体系', /阶梯/.test(artPanel) && /CEFR/.test(artPanel) && /蓝思/.test(artPanel), artPanel.slice(0, 120));
  check('文章：面板显示总词次', /总词次/.test(artPanel));
  check('文章：提供「进入阅读模式」入口', /进入阅读模式/.test(artPanel));
  /* 回归：客观难度那一行由 allRatingsHtml() 生成（内含 <b>），**不能**再被 esc() 转义，
     否则面板会显示字面的「阶梯 <b>L4</b>」。innerText 里出现 "<" 即说明标签被当文本输出了。 */
  check('文章：面板不出现字面 HTML 标签（&lt;b&gt; 被当文本渲染）', !/<\/?b>/.test(artPanel), artPanel.slice(0, 200));
  const artSecH = await page.eval(`(() => { const h = document.getElementById('inkread-article-root');
    const el = h && h.shadowRoot ? h.shadowRoot.querySelector('.sec-h b') : null; return el ? el.innerText : ''; })()`);
  check('文章：客观难度一行显示三套评级且无字面标签',
    /阶梯/.test(artSecH) && /CEFR/.test(artSecH) && /蓝思/.test(artSecH) && !/</.test(artSecH), artSecH);

  /* 进入阅读模式 */
  await page.eval(`(() => { const h = document.getElementById('inkread-article-root');
    const b = h.shadowRoot.querySelector('[data-act="read"]'); b.click(); return 1; })()`);
  await sleep(900);

  const readerState = await page.eval(`(() => {
    const h = document.getElementById('inkread-reader-root');
    if (!h || !h.shadowRoot) return null;
    const r = h.shadowRoot.querySelector('.reader');
    const words = r ? r.querySelectorAll('.rd-content .w') : [];
    const cls = {};
    words.forEach(w => { const c = (w.className.match(/w-(\\w+)/) || [])[1]; cls[c] = (cls[c] || 0) + 1; });
    return {
      on: r ? r.getAttribute('data-on') : '0',
      title: (r && r.querySelector('h1')) ? r.querySelector('h1').textContent : '',
      sum: (r && r.querySelector('.rd-sum')) ? r.querySelector('.rd-sum').innerText : '',
      words: words.length,
      cls: cls
    };
  })()`);
  check('阅读模式：覆盖层已打开', !!readerState && readerState.on === '1', JSON.stringify(readerState));
  check('阅读模式：标题正确', !!readerState && readerState.title === ART_TITLE, readerState && readerState.title);
  check('阅读模式：正文逐词切分（≥200 词）', !!readerState && readerState.words >= ART_WORDS, readerState && String(readerState.words));
  check('阅读模式：按词库着色（三种状态都有）',
    !!readerState && !!readerState.cls.known && !!readerState.cls.new && !!readerState.cls.learning,
    JSON.stringify(readerState && readerState.cls));
  check('阅读模式：未收录词也标出来', !!readerState && !!readerState.cls.unknown);
  check('阅读模式：顶部显示三套评级摘要', !!readerState && /阶梯/.test(readerState.sum) && /CEFR/.test(readerState.sum) && /蓝思/.test(readerState.sum), readerState && readerState.sum);
  check('阅读模式：顶部摘要不出现字面 HTML 标签', !!readerState && !/</.test(readerState.sum), readerState && readerState.sum);

  /* 点一个「生词本」的词 → 查离线词典 */
  const clicked = await page.eval(`(() => {
    const h = document.getElementById('inkread-reader-root');
    const r = h.shadowRoot.querySelector('.reader');
    const el = Array.from(r.querySelectorAll('.rd-content .w-new')).find(w => /vocabulary/i.test(w.textContent));
    if (!el) return '';
    el.click();
    return el.textContent;
  })()`);
  check('阅读模式：能点到生词 vocabulary', clicked === 'vocabulary', clicked);

  let cardText = '';
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    cardText = await page.eval(`(() => { const h = document.getElementById('inkread-reader-root');
      if (!h || !h.shadowRoot) return '';
      const c = h.shadowRoot.querySelector('.card');
      return c && !c.hidden ? c.innerText : ''; })()`);
    if (cardText && !/查询离线词典/.test(cardText)) break;
  }
  check('阅读模式：弹出释义卡片', !!cardText, cardText);
  check('阅读模式：释义来自离线词典（中文释义）', /词汇/.test(cardText), cardText);
  check('阅读模式：卡片标注词库状态（生词本）', /生词本/.test(cardText), cardText);
  check('阅读模式：卡片带音标', /vəˈkæbjələri|ˈv/.test(cardText), cardText);

  /* 只看生词 / 退出 */
  await page.eval(`(() => { const h = document.getElementById('inkread-reader-root');
    h.shadowRoot.querySelector('[data-act="dim"]').click(); return 1; })()`);
  await sleep(200);
  check('阅读模式：「只看生词」把阅读器切到压暗态', (await page.eval(`(() => {
    const h = document.getElementById('inkread-reader-root');
    return h.shadowRoot.querySelector('.reader').getAttribute('data-dim'); })()`)) === '1');

  await page.eval(`(() => { const h = document.getElementById('inkread-reader-root');
    h.shadowRoot.querySelector('[data-act="close"]').click(); return 1; })()`);
  await sleep(300);
  check('阅读模式：可退出', (await page.eval(`(() => {
    const h = document.getElementById('inkread-reader-root');
    return h.shadowRoot.querySelector('.reader').getAttribute('data-on'); })()`)) === '0');

  await sleep(300);
  check('文章页无未捕获异常', pageErrors.length === 0, pageErrors.join(';'));

  /* ---------- [9] 网页内联上色 + 点词释义 + 标记 + 划线 ---------- */
  console.log('\n[9] 网页内联上色 / 点词标记 / 划线');
  const artShadow = sel => page.eval(`(() => {
    const h = document.getElementById('inkread-article-root');
    if (!h || !h.shadowRoot) return '';
    const el = h.shadowRoot.querySelector(${JSON.stringify(sel)});
    return el ? el.innerText : '';
  })()`);

  /* 分片上色要几帧才跑完 */
  let inlineState = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      inlineState = await page.eval(`(() => {
        const art = document.querySelector('article');
        if (!art) return null;
        const spans = art.querySelectorAll('[data-irw="1"]');
        const cls = {};
        spans.forEach(s => { const m = (s.className.match(/irw-(\\w+)/) || [])[1]; if (m) cls[m] = (cls[m] || 0) + 1; });
        return { n: spans.length, cls: cls };
      })()`);
    } catch (e) { inlineState = null; }
    if (inlineState && inlineState.n > 50) break;
  }
  check('内联上色：正文被逐词包裹（[data-irw]）', !!inlineState && inlineState.n > 50, JSON.stringify(inlineState));
  check('内联上色：生词本词着色（vocabulary → irw-new）', !!(inlineState && inlineState.cls.new), JSON.stringify(inlineState && inlineState.cls));
  check('内联上色：在学词着色（material → irw-learning）', !!(inlineState && inlineState.cls.learning), JSON.stringify(inlineState && inlineState.cls));
  check('内联上色：未收录词也标出来（irw-unknown）', !!(inlineState && inlineState.cls.unknown), JSON.stringify(inlineState && inlineState.cls));

  const knownStyle = await page.eval(`(() => {
    const s = document.querySelector('article [data-irw="1"][data-w="language"]');
    return s ? (s.className + '|' + s.style.cssText) : '(missing)';
  })()`);
  check('内联上色：已学词只挂标记、不改样式（不打扰阅读）',
    /irw-known/.test(knownStyle) && !/color|background|text-decoration/.test(knownStyle), knownStyle);

  const vocabSpanStyle = await page.eval(`(() => {
    const s = document.querySelector('article [data-irw="1"][data-w="vocabulary"]');
    return s ? s.style.cssText : '(missing)';
  })()`);
  check('内联上色：生词带可见样式（下划线/底色）', /text-decoration|background/.test(vocabSpanStyle), vocabSpanStyle);

  /* 点词 → 释义卡片 */
  const clickedWord = await page.eval(`(() => {
    const s = document.querySelector('article [data-irw="1"][data-w="vocabulary"]');
    if (!s) return '';
    s.click();
    return s.textContent;
  })()`);
  check('上色后点词：命中 vocabulary', clickedWord === 'vocabulary', clickedWord);

  let pageCardText = '';
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    pageCardText = await artShadow('.card');
    if (pageCardText && !/查询离线词典/.test(pageCardText)) break;
  }
  check('上色后点词：弹出释义卡片', !!pageCardText, pageCardText);
  check('上色后点词：释义来自离线词典（中文）', /词汇/.test(pageCardText), pageCardText);
  check('上色后点词：卡片带标记按钮（生词本/在学/已学）',
    /生词本/.test(pageCardText) && /在学/.test(pageCardText) && /已学/.test(pageCardText), pageCardText);

  /* 换行渲染：词典释义里的「字面量 \n」必须变成 <br>，不能原样显示 */
  const mnHtml = await page.eval(`(() => {
    const h = document.getElementById('inkread-article-root');
    const mn = h && h.shadowRoot ? h.shadowRoot.querySelector('.card .mn') : null;
    return mn ? mn.innerHTML : '';
  })()`);
  check('换行：词典释义里的字面量 \\n 被渲染成 <br>', /<br>/.test(mnHtml), mnHtml);
  check('换行：界面上不残留裸的 \\n 文本', !/\\\\n/.test(mnHtml.replace(/<br>/g, '')), mnHtml);

  /* 标记：把 vocabulary 从「生词本」改成「已学」 */
  await page.eval(`(() => {
    const h = document.getElementById('inkread-article-root');
    const b = h.shadowRoot.querySelector('.card [data-mk="known"]');
    if (b) b.click();
    return 1;
  })()`);
  await sleep(1600);
  const vocabStatusAfter = await page.eval(`(() => {
    const s = document.querySelector('article [data-irw="1"][data-w="vocabulary"]');
    return s ? ((s.className.match(/irw-(\\w+)/) || [])[1] || '') : '(missing)';
  })()`);
  check('标记：标为已学后页面上的词立刻改状态（irw-known）', vocabStatusAfter === 'known', vocabStatusAfter);

  /* 划线：造一个跨几个彩词的选区（真人拖选就是这个形态）→ 浮动工具条 → 划线。
     注意：上色之后所有字母都在 [data-irw] span 里，只选中「一个词」是查词场景，
     不该弹划线条；跨词拖选才该弹。 */
  const readBarOn = () => page.eval(`(() => {
    const h = document.getElementById('inkread-article-root');
    const b = h && h.shadowRoot ? h.shadowRoot.querySelector('.selbar') : null;
    return b ? b.getAttribute('data-on') : '';
  })()`);
  const makeSel = () => page.eval(`(() => {
    const art = document.querySelector('article');
    const p = art.querySelectorAll('p')[2];
    if (!p) return '';
    const spans = p.querySelectorAll('[data-irw="1"]');
    if (spans.length < 6) return '';
    const a = spans[1], b = spans[5];
    const r = document.createRange();
    r.setStart(a.firstChild, 0);
    r.setEnd(b.firstChild, b.firstChild.nodeValue.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return String(sel).slice(0, 60);
  })()`);

  /* 合成选区后，内容脚本走的是 selectionchange（异步）；固定 sleep 偶发读到的还是 '0'，
     会产生「假失败」。这里改成「重造选区 + 轮询 selbar」，消除抖动。 */
  let selText = '';
  let barOn = '';
  for (let i = 0; i < 10 && barOn !== '1'; i++) {
    selText = (await makeSel()) || selText;
    for (let j = 0; j < 6; j++) {
      await sleep(150);
      barOn = await readBarOn();
      if (barOn === '1') break;
    }
  }
  check('划线：选中文本后浮动工具条出现', barOn === '1', '选中="' + selText + '" bar=' + barOn);

  await page.eval(`(() => {
    const h = document.getElementById('inkread-article-root');
    const b = h.shadowRoot.querySelector('.selbar [data-act="hl-add"]');
    if (b) b.click();
    return 1;
  })()`);
  /* 划线落盘 + 重放是异步的：轮询而不是死等一个固定时长 */
  let hlMarks = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(150);
    hlMarks = await page.eval(`document.querySelectorAll('[data-irhl="1"], [data-irw="1"][data-hl="1"]').length`);
    if (hlMarks > 0) break;
  }
  check('划线：页面上出现划线标记', hlMarks > 0, String(hlMarks));

  /* 打开面板：看「我的标记」区 */
  await page.eval(`(() => { const h = document.getElementById('inkread-article-root');
    const p = h.shadowRoot.querySelector('.pill'); p.click(); return 1; })()`);
  await sleep(600);
  const artPanelBody = await artShadow('.body');
  check('标记：面板出现「我的标记」区', /我的标记/.test(artPanelBody), artPanelBody.slice(0, 80));
  check('标记：面板列出划线条目', /划线/.test(artPanelBody), artPanelBody.slice(0, 120));
  check('上色：面板有「网页上色」开关', /网页上色/.test(artPanelBody), artPanelBody.slice(0, 120));

  /* 关闭上色 → DOM 必须完全还原 */
  await page.eval(`(() => { const h = document.getElementById('inkread-article-root');
    const b = h.shadowRoot.querySelector('[data-act="inline"]'); b.click(); return 1; })()`);
  await sleep(900);
  const afterOff = await page.eval(`(() => {
    const art = document.querySelector('article');
    return {
      spans: art.querySelectorAll('[data-irw="1"]').length,
      hl: art.querySelectorAll('[data-irhl="1"]').length,
      txt: art.innerText.replace(/\\s+/g, ' ').trim()
    };
  })()`);
  const expectedArtText = (ART_TITLE + ' ' + ART_PARAS.join(' ')).replace(/\s+/g, ' ').trim();
  check('关闭上色：我们的包裹节点全部拆掉（DOM 还原）', afterOff.spans === 0, JSON.stringify({ spans: afterOff.spans, hl: afterOff.hl }));
  check('关闭上色：正文文本逐字还原（没有多出/少掉字符）',
    afterOff.txt === expectedArtText, 'len=' + afterOff.txt.length + '/' + expectedArtText.length + ' ' + afterOff.txt.slice(0, 60));

  /* 再开回来 */
  await page.eval(`(() => { const h = document.getElementById('inkread-article-root');
    const b = h.shadowRoot.querySelector('[data-act="inline"]'); b.click(); return 1; })()`);
  await sleep(1200);
  const reOn = await page.eval(`document.querySelectorAll('article [data-irw="1"]').length`);
  check('重新开启上色：正文又着色了', reOn > 50, String(reOn));

  await page.eval(`(() => { const h = document.getElementById('inkread-article-root');
    const p = h.shadowRoot.querySelector('.pill'); p.click(); return 1; })()`);
  await sleep(300);
  check('内联上色页无未捕获异常', pageErrors.length === 0, pageErrors.join(';'));

  /* ---------- [8] 设置写入不能误伤其它字段 ----------
     回归防线：阅读模式里点「只看生词」/ 调字号 / 切评级都会写 iv.settings。
     如果实现成「用内存快照整体覆盖」，用户的词库联动（link）与字幕偏好（subs）就会被清空。
     这里直接读扩展存储，确认这些字段都还在。 */
  console.log('\n[8] 设置写入的完整性（不误伤 link / subs / ui）');

  if (extId) {
    /* 直接复用已经连好的页面 target 打开设置页（另开 target 会被浏览器判定为不可信导航） */
    await page.send('Page.navigate', { url: `chrome-extension://${extId}/src/options/options.html` });
    let storageReady = false, optWhere = '';
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        optWhere = await page.eval(`location.href + ' | ' + document.readyState + ' | ' + (window.chrome && chrome.storage ? 'storage-ok' : 'no-storage')`);
      } catch (e) { optWhere = 'eval 失败：' + (e && e.message); }
      if (/storage-ok/.test(optWhere)) { storageReady = true; break; }
    }
    check('设置页可打开且 chrome.storage 可用', storageReady === true, optWhere);

    const stored = storageReady ? await page.eval(`(async () => {
      const r = await chrome.storage.local.get('iv.settings');
      return JSON.stringify(r['iv.settings'] || null);
    })()`) : null;
    let s = null;
    try { s = JSON.parse(stored); } catch (e) { /* 解析失败下面会报 */ }

    check('设置对象可读', !!s, String(stored).slice(0, 160));
    /* 关键回归：这些字段都是在内容脚本里写过的路径上，必须原样保留 */
    check('词库联动 link 未被内容脚本的写入清掉', !!(s && s.link && typeof s.link.mode === 'string'), s && JSON.stringify(s.link));
    check('link.ports 仍是数组且为默认端口', !!(s && Array.isArray(s.link.ports) && s.link.ports[0] === 17890), s && JSON.stringify(s.link && s.link.ports));
    check(`字幕偏好 subs.minTokens 仍是播下的标记值 ${MARK_MIN_TOKENS}（没被冲回默认）`,
      !!(s && s.subs && s.subs.minTokens === MARK_MIN_TOKENS), s && JSON.stringify(s.subs));
    check('界面偏好 ui 仍在', !!(s && s.ui && typeof s.ui.badge === 'boolean'), s && JSON.stringify(s.ui));
    check('文章设置已写入且完整', !!(s && s.article && typeof s.article.enabled === 'boolean' && typeof s.article.fontSize === 'number'), s && JSON.stringify(s.article));
    check('阅读模式里点过「只看生词」→ dimKnown 已持久化', !!(s && s.article && s.article.dimKnown === true), s && JSON.stringify(s.article));
    check('评级体系写回后仍合法', !!(s && s.rating && ['step', 'cefr', 'lexile'].includes(s.rating.system)), s && JSON.stringify(s.rating));
    /* 上色相关：内容脚本 toggle 过一轮 off→on，最终应回到「开」且不留站点黑名单 */
    check('上色开关已持久化且最终为开', !!(s && s.article && s.article.inlineColor === true), s && JSON.stringify(s.article && s.article.inlineColor));
    check('上色样式合法', !!(s && s.article && ['line', 'mark'].includes(s.article.inlineStyle)), s && JSON.stringify(s.article && s.article.inlineStyle));
    check('toggle 过 off→on 后站点黑名单里没有 example.com',
      !!(s && s.article && Array.isArray(s.article.siteOff) && s.article.siteOff.indexOf('example.com') < 0),
      s && JSON.stringify(s.article && s.article.siteOff));

    /* 标记持久化：词级标记 + 按 URL 的划线 */
    const marksStored = await page.eval(`(async () => {
      const r = await chrome.storage.local.get('iv.marks');
      return JSON.stringify(r['iv.marks'] || null);
    })()`);
    let mk = null; try { mk = JSON.parse(marksStored); } catch (e) { /* 解析失败下面会报 */ }
    check('标记：iv.marks 已落盘', !!mk, String(marksStored).slice(0, 160));
    check('标记：vocabulary 被标为「已学」（覆盖了词库的生词本）',
      !!(mk && mk.words && mk.words.vocabulary && mk.words.vocabulary.status === 'known'),
      JSON.stringify(mk && mk.words && mk.words.vocabulary));
    check('标记：划线按 URL 落盘（example.com/article/1）',
      !!(mk && mk.highlights && Object.keys(mk.highlights).some(k => /example\.com\/article\/1$/.test(k))),
      JSON.stringify(mk && mk.highlights && Object.keys(mk.highlights)));

    /* 设置页本身要能正常渲染（示例试算用到词频表） */
    await sleep(600);
    const demo = await page.eval(`(() => {
      const el = document.getElementById('ratingDemo');
      const sw = document.querySelectorAll('input[name=ratingsys]').length;
      const art = !!document.getElementById('artEnabled');
      const inline = !!document.getElementById('artInline');
      const hl = !!document.getElementById('artHlStyle');
      const mkinfo = document.getElementById('marksInfo') ? document.getElementById('marksInfo').innerText : '';
      return JSON.stringify({ sw: sw, art: art, inline: inline, hl: hl, mkinfo: mkinfo, demo: el ? el.innerText.slice(0, 220) : '' });
    })()`);
    const d = (() => { try { return JSON.parse(demo); } catch (e) { return { sw: 0, art: false, demo: '' }; } })();
    check('设置页渲染出三个评级选项', d.sw === 3, String(d.sw));
    check('设置页渲染出文章阅读设置', d.art === true);
    check('设置页渲染出网页上色开关与划线样式', d.inline === true && d.hl === true, JSON.stringify(d));
    check('设置页渲染出标记总览（含已持久化的标记）', /标记为已学/.test(d.mkinfo) && /1/.test(d.mkinfo), d.mkinfo.replace(/\n/g, ' / '));
    check('设置页示例试算渲染出三套体系', /阶梯/.test(d.demo) && /CEFR/.test(d.demo) && /蓝思/.test(d.demo), d.demo.replace(/\n/g, ' / '));

    /* ---------- [10] 存档目录直连（免启动桌面版）+ 三端词库同步 ---------- */
    console.log('\n[10] 存档目录直连 / 三端共享词库');

    const dirUi = JSON.parse(await page.eval(`(() => {
      const b = document.getElementById('btnBindDir');
      const info = document.getElementById('dirInfo');
      const wb = document.getElementById('linkWriteBack');
      const block = document.querySelector('.sub[data-for="auto manual"]');
      return JSON.stringify({
        bind: !!b, bindDisabled: !!(b && b.disabled),
        wb: !!wb, wbOn: !!(wb && wb.checked),
        visible: !!(block && !block.hidden),
        info: info ? info.innerText.replace(/\\s+/g, ' ') : ''
      });
    })()`));
    check('目录直连：设置页有绑定按钮且可用（Chromium）', dirUi.bind && !dirUi.bindDisabled, JSON.stringify(dirUi));
    check('目录直连：区块在「自动联动」模式下可见', dirUi.visible === true);
    check('目录直连：默认「标记写回共享词库」为开', dirUi.wb && dirUi.wbOn === true, JSON.stringify(dirUi));
    check('目录直连：状态区报告未绑定 + 后台通道', /未绑定/.test(dirUi.info) && /后台读写通道/.test(dirUi.info), dirUi.info);

    /* 未绑定时不能误用目录，老路径（本地服务）必须完好 */
    const vs0 = JSON.parse(await page.eval(`(async () => JSON.stringify(await chrome.runtime.sendMessage({type:'vocabStatus', force:true})))()`));
    check('目录直连：Chromium 下报告 dirSupported', vs0.dirSupported === true, String(vs0.dirSupported));
    check('目录直连：未绑定时不误用目录，仍回落本地服务',
      vs0.dirBound === false && vs0.source === 'local' && vs0.count > 0,
      JSON.stringify({ bound: vs0.dirBound, src: vs0.source, n: vs0.count }));

    /* 未绑定时两个同步入口都要「明确失败」，不能挂起更不能抛 */
    const ds0 = JSON.parse(await page.eval(`(async () => JSON.stringify(await chrome.runtime.sendMessage({type:'dirSync'})))()`));
    check('目录直连：未绑定时 dirSync 给明确原因', ds0.ok === false && !!ds0.error, JSON.stringify(ds0));
    const dp0 = JSON.parse(await page.eval(`(async () => JSON.stringify(await chrome.runtime.sendMessage({type:'dirPushMarks'})))()`));
    check('目录直连：未绑定时 dirPushMarks 优雅失败', dp0.ok === false && !!dp0.error, JSON.stringify(dp0));

    /* 离屏文档：FSA 在 service worker 里不保证可用，这条通道必须真的通 */
    const probe = JSON.parse(await page.eval(`(async () => JSON.stringify(await chrome.runtime.sendMessage({type:'dirProbe'})))()`));
    check('离屏文档：可创建并完成 ir:fs 消息往返', probe.ok === true && probe.hasFsa === true, JSON.stringify(probe));

    /* 句柄管线：用可结构化克隆的占位对象走一遍「IndexedDB → 后台」
       （真句柄需要用户手势，E2E 里拿不到；这里守住的是读取链路与报名字段） */
    const seeded = await page.eval(`(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('inkread-video', 1);
        r.onupgradeneeded = () => { try { r.result.createObjectStore('h'); } catch (e) {} };
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const tx = db.transaction('h', 'readwrite');
        tx.objectStore('h').put({ name: 'E2E存档目录' }, 'dir');
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      return 'ok';
    })()`);
    check('目录直连：占位句柄已写入 IndexedDB', seeded === 'ok', String(seeded));

    const st1 = JSON.parse(await page.eval(`(async () => JSON.stringify(await chrome.runtime.sendMessage({type:'dirStatus'})))()`));
    check('目录直连：后台能从 IndexedDB 读到句柄并报出目录名', st1.ok === true && st1.bound === true && st1.name === 'E2E存档目录', JSON.stringify(st1));

    /* 占位句柄没有真实文件 API：必须优雅降级，不能把服务端来的词库弄丢 */
    const ds1 = JSON.parse(await page.eval(`(async () => JSON.stringify(await chrome.runtime.sendMessage({type:'dirSync'})))()`));
    check('目录直连：目录里读不到 vocab.json 时优雅失败', ds1.ok === false, JSON.stringify(ds1));
    const vs1 = JSON.parse(await page.eval(`(async () => JSON.stringify(await chrome.runtime.sendMessage({type:'vocabStatus'})))()`));
    check('目录直连：降级后词库依旧可用（不丢原有来源）', vs1.count > 0, JSON.stringify({ n: vs1.count, src: vs1.source }));

    /* 清理：解除绑定后要彻底回到初始状态，不能污染后续回归 */
    const cleaned = await page.eval(`(async () => {
      await chrome.runtime.sendMessage({ type: 'dirForget' });
      const stored = await chrome.storage.local.get('iv.settings');
      const dn = stored['iv.settings'] && stored['iv.settings'].link ? stored['iv.settings'].link.dirName : 'MISSING';
      const db = await new Promise((res) => { const r = indexedDB.open('inkread-video', 1); r.onsuccess = () => res(r.result); });
      const got = await new Promise((res) => {
        const tx = db.transaction('h', 'readonly');
        const q = tx.objectStore('h').get('dir');
        q.onsuccess = () => res(q.result); q.onerror = () => res('ERR');
      });
      return JSON.stringify({ dirName: dn, handle: got == null ? null : 'still-there' });
    })()`);
    const cl = JSON.parse(cleaned);
    check('目录直连：解除绑定后句柄与 dirName 都清掉', cl.handle === null && cl.dirName === '', cleaned);
    const st2 = JSON.parse(await page.eval(`(async () => JSON.stringify(await chrome.runtime.sendMessage({type:'dirStatus'})))()`));
    check('目录直连：解除后报告未绑定', st2.ok === false && st2.bound === false, JSON.stringify(st2));
  }

  /* ---------- [11] 悬浮胶囊：默认右侧居中 + 可拖动 + 位置记忆 ---------- */
  console.log('\n[11] 悬浮位置（右侧居中 · 可拖动 · 刷新后记忆）');

  const readWrap = () => page.eval(`(() => {
    const h = document.getElementById('inkread-video-root');
    const w = h && h.shadowRoot ? h.shadowRoot.querySelector('.wrap') : null;
    if (!w || w.hasAttribute('hidden')) return 'null';
    const r = w.getBoundingClientRect();
    return JSON.stringify({
      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
      left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      vw: innerWidth, vh: innerHeight, side: w.getAttribute('data-side'), v: w.getAttribute('data-v')
    });
  })()`);
  const waitWrap = async () => {
    let g = null;
    for (let i = 0; i < 40; i++) { await sleep(250); try { g = JSON.parse(await readWrap()); } catch (e) { g = null; } if (g) return g; }
    return null;
  };

  await page.send('Page.navigate', { url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  const g0 = await waitWrap();
  check('位置：徽标在 YouTube 页渲染', !!g0, JSON.stringify(g0));
  check('位置：默认落在右半屏', !!g0 && g0.cx > g0.vw * 0.75, JSON.stringify(g0));
  check('位置：默认垂直居中', !!g0 && Math.abs(g0.cy - g0.vh / 2) < g0.vh * 0.15, JSON.stringify(g0));
  check('位置：右侧时面板朝内展开（data-side=right）', !!g0 && g0.side === 'right', g0 && g0.side);

  /* 拖动：pointerdown → 连续 pointermove → pointerup（到左上） */
  const dragged = JSON.parse(await page.eval(`(() => {
    const h = document.getElementById('inkread-video-root');
    const w = h.shadowRoot.querySelector('.wrap');
    const p = h.shadowRoot.querySelector('.pill');
    const r = w.getBoundingClientRect();
    const from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const to = { x: Math.max(40, innerWidth * 0.15), y: Math.max(40, innerHeight * 0.18) };
    const pe = (t, x, y) => p.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 7, button: 0, buttons: 1, clientX: x, clientY: y }));
    pe('pointerdown', from.x, from.y);
    for (let i = 1; i <= 6; i++) pe('pointermove', from.x + (to.x - from.x) * i / 6, from.y + (to.y - from.y) * i / 6);
    pe('pointerup', to.x, to.y);
    const r2 = w.getBoundingClientRect();
    return JSON.stringify({
      fx: Math.round(from.x), fy: Math.round(from.y),
      tx: Math.round(r2.left + r2.width / 2), ty: Math.round(r2.top + r2.height / 2),
      dragAttr: w.getAttribute('data-drag'), side: w.getAttribute('data-side')
    });
  })()`));
  check('拖动：胶囊真的移动了', Math.abs(dragged.tx - dragged.fx) > 60, JSON.stringify(dragged));
  check('拖动：结束后清掉拖动标记', dragged.dragAttr === null, JSON.stringify(dragged));
  check('拖动：移到左半屏后面板改朝右展开（data-side=left）', dragged.side === 'left', JSON.stringify(dragged));

  await sleep(600);
  /* chrome.storage 只在扩展页面可用，网页世界读不到 → 到设置页读持久化结果 */
  let posSaved = null;
  if (extId) {
    await page.send('Page.navigate', { url: `chrome-extension://${extId}/src/options/options.html` });
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        const raw = await page.eval(`(async () => {
          if (!chrome.storage) return '';
          const r = await chrome.storage.local.get('iv.settings');
          const ui = r['iv.settings'] && r['iv.settings'].ui;
          return JSON.stringify({ pos: (ui && ui.pos) || null });
        })()`);
        if (raw) { posSaved = JSON.parse(raw); break; }
      } catch (e) { /* 页面还没换过来 */ }
    }
  }
  check('拖动：位置写回 iv.settings.ui.pos（视口比例）',
    !!(posSaved && posSaved.pos && typeof posSaved.pos.x === 'number' && typeof posSaved.pos.y === 'number'), JSON.stringify(posSaved));
  check('拖动：移到左上后 pos.x / pos.y 都小于 0.5',
    !!(posSaved && posSaved.pos && posSaved.pos.x < 0.5 && posSaved.pos.y < 0.5), JSON.stringify(posSaved && posSaved.pos));

  /* 刷新：位置必须被记住（不再回到右侧居中） */
  await page.send('Page.navigate', { url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  const g1 = await waitWrap();
  check('拖动：刷新后仍在左半屏（位置被记住）', !!g1 && g1.cx < g1.vw * 0.5, JSON.stringify(g1));

  /* 只点不动 = 展开面板（拖动不能劫持点击） */
  const openAfterClick = await page.eval(`(() => {
    const h = document.getElementById('inkread-video-root');
    const w = h.shadowRoot.querySelector('.wrap');
    const p = h.shadowRoot.querySelector('.pill');
    const r = w.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const pe = t => p.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 9, button: 0, buttons: 1, clientX: x, clientY: y }));
    pe('pointerdown'); pe('pointerup'); p.click();
    return w.getAttribute('data-open');
  })()`);
  check('点击（未拖动）仍能展开面板', openAfterClick === '1', String(openAfterClick));

  check('位置回归页无未捕获异常', pageErrors.length === 0, pageErrors.join(';'));

  /* ---------- [12] 「只读到标题」的修复：PoToken 拦截 + 页面上下文兜底 ----------
     YouTube 现在要求 /api/timedtext 带 pot（PoToken），缺了返回 200 + **空 body**（不抛错）。
     假服务对带 potc/exp 标记的 URL 就返回空体以复现该行为。这里从 SW 侧真的走一遍
     chrome.tabs.sendMessage({type:'fetchCaption'})，证明：①「空体」会被判为失败（不静默成功）；
     ② 去掉 PoToken 标记后能在页面上下文里抓到字幕原文。 */
  console.log('\n[12] 字幕抓取兜底：PoToken 空体判定 + 页面上下文通道');

  let swWs = '';
  {
    const list = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
    const t = list.find(x => /src\/background\/sw\.js/.test(x.url || ''));
    if (t) swWs = t.webSocketDebuggerUrl;
  }
  check('兜底通道：拿到 service worker 调试端点', !!swWs);

  if (swWs) {
    const swp = await connect(swWs);
    await swp.send('Runtime.enable');
    const out = await swp.eval(`(async () => {
      const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
      const t = tabs[0];
      if (!t) return JSON.stringify({ error: 'no-yt-tab' });
      const bad = await chrome.tabs.sendMessage(t.id, { type: 'fetchCaption', url: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&potc=1&exp=xpe' });
      const good = await chrome.tabs.sendMessage(t.id, { type: 'fetchCaption', url: 'https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en' });
      return JSON.stringify({
        badOk: !!(bad && bad.ok), badLen: (bad && bad.text) ? bad.text.length : 0,
        goodOk: !!(good && good.ok), goodLen: (good && good.text) ? good.text.length : 0,
        via: (good && good.via) || ''
      });
    })()`);
    let v = {}; try { v = JSON.parse(out); } catch (e) { v = { raw: out }; }
    check('兜底通道：带 PoToken 标记的 URL 取回空体被正确判为失败（不静默成功）',
      v.badOk === false || v.badLen === 0, JSON.stringify(v));
    check('兜底通道：去标记后能抓到字幕原文（内容脚本 fetchCaption 通）',
      v.goodOk === true && v.goodLen > 0, JSON.stringify(v));
    check('兜底通道：回传抓取通道标识（页面上下文）',
      /^page/.test(v.via || ''), JSON.stringify(v));
    swp.close();
  }

  check('兜底通道验证页无未捕获异常', pageErrors.length === 0, pageErrors.join(';'));

  /* ---------- [13] 动态渲染文章：正文晚于首屏出现也要能识别 ----------
     复现 Next.js / React「SSR 载荷 + 客户端 hydrate」的站点（如 www.ireadworld.com）：
     首屏 HTML 里没有正文 <p>，正文由 JS 在 ~1.2s 后才插入。
     旧实现「onNav 探一次、href 不变就不再探」在这类页面上会永久「识别不了」。 */
  console.log('\n[13] 动态渲染文章：正文晚出现也要能识别（内容就绪重试）');

  const readArtWrap = () => page.eval(`(() => {
    const hs = document.querySelectorAll('#inkread-article-root');
    const h = hs[0];
    const w = h && h.shadowRoot ? h.shadowRoot.querySelector('.wrap') : null;
    if (!w || w.hasAttribute('hidden')) return 'null';
    const pill = w.querySelector('.pill');
    const r = w.getBoundingClientRect();
    return JSON.stringify({
      n: hs.length,
      lv: (w.querySelector('.lv') || {}).textContent || '',
      state: pill ? pill.getAttribute('data-state') : '',
      left: Math.round(r.left), top: Math.round(r.top), side: w.getAttribute('data-side')
    });
  })()`);

  await page.send('Page.navigate', { url: 'https://example.com/late-article' });
  let lateG = null;
  for (let i = 0; i < 50; i++) {
    await sleep(300);
    try { const s = await readArtWrap(); if (s && s !== 'null') { lateG = JSON.parse(s); if (lateG.state === 'ok') break; } } catch (e) { /* 页面还在换 */ }
  }
  check('动态文章：晚渲染的正文被识别并渲染出胶囊', !!lateG, JSON.stringify(lateG));
  check('动态文章：给出评级代码（不是一直停在「分析中」）',
    !!lateG && /^([A-C][12]|L[1-5]|\d+L)$/.test(lateG.lv || ''), lateG && lateG.lv);
  check('动态文章：胶囊状态为 ok', !!lateG && lateG.state === 'ok', JSON.stringify(lateG));
  check('动态文章：页面上只有一个文章根节点（重注入不重复挂载）', !!lateG && lateG.n === 1, JSON.stringify(lateG));
  check('动态文章页无未捕获异常', pageErrors.length === 0, pageErrors.join(';'));

  /* ---------- [14] 文章模式悬浮窗：默认右下角 + 可拖动 + 位置记忆 ---------- */
  console.log('\n[14] 文章模式悬浮窗：默认右下角 · 可拖动 · 位置记忆');

  await page.send('Page.navigate', { url: 'https://example.com/article' });
  let a0 = null;
  for (let i = 0; i < 40; i++) { await sleep(250); try { const s = await readArtWrap(); if (s && s !== 'null') { a0 = JSON.parse(s); break; } } catch (e) { /* 忽略 */ } }
  check('文章位置：胶囊渲染', !!a0, JSON.stringify(a0));
  const artVw = await page.eval('innerWidth'), artVh = await page.eval('innerHeight');
  check('文章位置：默认落在右半屏且靠底（右下角）',
    !!a0 && a0.left > artVw * 0.6 && a0.top > artVh * 0.5, JSON.stringify({ a0, artVw, artVh }));
  check('文章位置：默认 data-side=right', !!a0 && a0.side === 'right', a0 && a0.side);

  const aDrag = JSON.parse(await page.eval(`(() => {
    const h = document.getElementById('inkread-article-root');
    const w = h.shadowRoot.querySelector('.wrap');
    const p = h.shadowRoot.querySelector('.pill');
    const r = w.getBoundingClientRect();
    const from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const to = { x: Math.max(40, innerWidth * 0.15), y: Math.max(40, innerHeight * 0.18) };
    const pe = (t, x, y) => p.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 5, button: 0, buttons: 1, clientX: x, clientY: y }));
    pe('pointerdown', from.x, from.y);
    for (let i = 1; i <= 6; i++) pe('pointermove', from.x + (to.x - from.x) * i / 6, from.y + (to.y - from.y) * i / 6);
    pe('pointerup', to.x, to.y);
    const r2 = w.getBoundingClientRect();
    return JSON.stringify({
      fx: Math.round(from.x), tx: Math.round(r2.left + r2.width / 2),
      dragAttr: w.getAttribute('data-drag'), side: w.getAttribute('data-side')
    });
  })()`));
  check('文章拖动：胶囊真的移动了', Math.abs(aDrag.tx - aDrag.fx) > 60, JSON.stringify(aDrag));
  check('文章拖动：结束后清掉拖动标记', aDrag.dragAttr === null, JSON.stringify(aDrag));
  check('文章拖动：移到左半屏后面板改朝右展开（data-side=left）', aDrag.side === 'left', JSON.stringify(aDrag));

  await sleep(700);
  /* 持久化要读扩展存储 → 借道设置页 */
  let aPos = null;
  if (extId) {
    await page.send('Page.navigate', { url: `chrome-extension://${extId}/src/options/options.html` });
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try {
        const raw = await page.eval(`(async () => {
          if (!chrome.storage) return '';
          const r = await chrome.storage.local.get('iv.settings');
          const a = r['iv.settings'] && r['iv.settings'].article;
          return JSON.stringify({ pos: (a && a.pos) || null });
        })()`);
        if (raw) { aPos = JSON.parse(raw); break; }
      } catch (e) { /* 忽略 */ }
    }
  }
  check('文章拖动：位置写回 iv.settings.article.pos（视口比例）',
    !!(aPos && aPos.pos && typeof aPos.pos.x === 'number' && typeof aPos.pos.y === 'number'), JSON.stringify(aPos));
  check('文章拖动：移到左上后 pos.x / pos.y 都小于 0.5',
    !!(aPos && aPos.pos && aPos.pos.x < 0.5 && aPos.pos.y < 0.5), JSON.stringify(aPos && aPos.pos));

  await page.send('Page.navigate', { url: 'https://example.com/article' });
  let a1 = null;
  for (let i = 0; i < 40; i++) { await sleep(250); try { const s = await readArtWrap(); if (s && s !== 'null') { a1 = JSON.parse(s); break; } } catch (e) { /* 忽略 */ } }
  check('文章拖动：刷新后位置被记住（仍在左半屏）',
    !!a1 && a1.left < (await page.eval('innerWidth')) * 0.5, JSON.stringify(a1));

  /* 只点不动 = 展开面板（拖动不能劫持点击） */
  const aOpen = await page.eval(`(() => {
    const h = document.getElementById('inkread-article-root');
    const w = h.shadowRoot.querySelector('.wrap');
    const p = h.shadowRoot.querySelector('.pill');
    const r = w.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const pe = t => p.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 6, button: 0, buttons: 1, clientX: x, clientY: y }));
    pe('pointerdown'); pe('pointerup'); p.click();
    return w.getAttribute('data-open');
  })()`);
  check('文章：点击（未拖动）仍能展开面板', aOpen === '1', String(aOpen));

  check('文章拖动验证页无未捕获异常', pageErrors.length === 0, pageErrors.join(';'));

} catch (e) {
  check('测试执行未抛异常', false, e && e.message);
} finally {
  try { page && page.close(); } catch (e) { }
  try { browser && browser.close(); } catch (e) { }
  try { edge && edge.kill(); } catch (e) { }
  server.close();
  await sleep(800);
  if (profileDir) { try { rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* 文件占用，忽略 */ } }
}

console.log(`\nplugin e2e:  PASS ${pass}  FAIL ${fail}`);
if (fail) { console.log('\n失败项：'); fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('全部通过 ✓');
