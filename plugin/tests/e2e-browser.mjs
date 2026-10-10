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
        { baseUrl: `http://127.0.0.1:${PORT}/yt.json?lang=zh`, languageCode: 'zh-Hans', vssId: '.zh', kind: '', name: { simpleText: '中文' } },
        { baseUrl: `http://127.0.0.1:${PORT}/yt.json?lang=en`, languageCode: 'en', vssId: 'a.en', kind: 'asr', name: { simpleText: 'English (auto-generated)' } }
      ]
    }
  }
})};
</script>
</body></html>`;

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
    /* YouTube json3 字幕体：events[].segs[].utf8 */
    return json({ wireMagic: 'pb3', events: YT_TEXT.split('\n').map(l => ({ segs: [{ utf8: l }] })) });
  }
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
      { urlPattern: 'https://www.youtube.com/watch*', requestStage: 'Request' }
    ]
  });

  page.on(async m => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    const html = /^https:\/\/www\.bilibili\.com\/video\//.test(request.url) ? PAGE_HTML
      : /^https:\/\/www\.youtube\.com\/watch/.test(request.url) ? YT_PAGE_HTML : null;
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
  check('面板显示客观难度分层（视频客观难度）', /视频客观难度/.test(body));
  check('面板显示字数分层图例（核心/常用/进阶）', /核心|常用|进阶/.test(body));

  console.log('\n[3] 墨读词库联动');
  check('面板显示词库来源段', /词库：/.test(body), (body.match(/词库：[^\n]*/) || [''])[0]);
  check('词库来源为墨读本地服务', /墨读/.test(body), (body.match(/词库：[^\n]*/) || [''])[0]);
  check(`词库词条数与假服务一致（${FIXTURE_VOCAB.length}）`, new RegExp('\\b' + FIXTURE_VOCAB.length + '\\b').test(body), (body.match(/词库：[^\n]*/) || [''])[0]);
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

  await page.eval(`(() => { const h = document.getElementById('inkread-video-root'); h.shadowRoot.querySelector('.pill').click(); return 1; })()`);
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
  check('YouTube：仍联动词库（墨读）', /墨读/.test(ytBody), (ytBody.match(/词库：[^\n]*/) || [''])[0]);
  check('YouTube：客观难度分层已渲染', /视频客观难度/.test(ytBody));
  await sleep(300);
  check('YouTube 页无未捕获异常', pageErrors.length === 0, pageErrors.join(';'));

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
