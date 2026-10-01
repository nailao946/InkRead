/* 本轮 5 项改动的真机（无头 Edge）验证：
   B1 统计去重口径 · B2 词组一条线 · B3 目录按钮/左翻页不重叠
   B4 翻页按窗口大小重排 · B5 申请 Key 帮助文案用主题副色（不是深蓝）
   用法：node web/tests/cdp-roundb.mjs   （自己拉起 serve.py 8648 与无头 Edge） */
import { spawn } from 'child_process';
import { writeFileSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9226, SRV = 8648;
const PROFILE = path.join(__dirname, 'edge-prof-roundb-' + Date.now());   /* 每次唯一：避免 Edge 单实例复用旧页面 */
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 新目录 */ }

const PY = process.env.PY || 'python';
const server = spawn(PY, [path.join(ROOT, 'web/tools/serve.py'), String(SRV), '--no-open'], { stdio: 'ignore' });
const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1280,900', 'about:blank'
], { stdio: 'ignore' });
const killAll = () => {
  try { edge.kill(); } catch { /* 已退出 */ }
  try { server.kill(); } catch { /* 已退出 */ }
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch { /* Edge 还没完全退出，留着下次清 */ }
};
process.on('exit', killAll);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = tabs.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* 等 Edge 起 */ }
    await sleep(250);
  }
  throw new Error('CDP 超时');
}
const ws = new WebSocket(await getWsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = ev => { const d = JSON.parse(ev.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (m, p = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evl = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    const e = r.result.exceptionDetails;
    return '__ERR__ ' + (e.exception?.description || e.text);
  }
  return r.result?.result?.value;
};
const shot = async name => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(__dirname, name), Buffer.from(s.result.data, 'base64'));
};

const res = [];
const check = (n, c, extra) => res.push((c ? 'PASS' : 'FAIL') + ' ' + n + (extra !== undefined ? ' | ' + extra : ''));
const j = s => {
  if (typeof s !== 'string') return { __err: 'no-result' };
  if (s.startsWith('__ERR__')) return { __err: s.slice(8, 180) };
  try { return JSON.parse(s); } catch (e) { return { __err: s.slice(0, 180) }; }
};
const box = async sel => await evl(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),r:Math.round(r.right),b:Math.round(r.bottom),w:Math.round(r.width),h:Math.round(r.height),vis:!e.closest('[hidden]')}})()`);
const hit = (a, b) => !!a && !!b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/index.html?demo=1&_t=${Date.now()}` });
for (let i = 0; i < 60; i++) { await sleep(400); if (await evl(`document.documentElement.dataset.boot`) === '1') break; }
for (let i = 0; i < 25; i++) { if (await evl(`document.querySelectorAll('.article .w').length`) > 0) break; await sleep(400); }
await sleep(600);

/* 环境自检：把页面侧的真实错误暴露出来（避免把加载失败误判成改动失败） */
console.log('DIAG ' + await evl(`JSON.stringify({
  boot: document.documentElement.dataset.boot,
  err: (document.querySelector('#js-error')||{}).textContent || '',
  perr: (document.querySelector('#js-promise-error')||{}).textContent || '',
  reading: !document.querySelector('#readingView').hidden,
  book: (IR.reader.currentBook||{}).title,
  blocks: IR.reader.blocks.length,
  rendered: IR.reader.rendered,
  words: document.querySelectorAll('.article .w').length,
  stats: (document.querySelector('#readingStats')||{}).textContent,
  seen: IR.reader._seenKeys.size,
  counts: JSON.stringify(IR.reader.counts),
  domUniq: new Set([...document.querySelectorAll('.article .w')].map(w=>w.dataset.k)).size,
  phGroups: document.querySelectorAll('.article .ph').length,
  hasPhraseLen: typeof IR.phraseLen,
  verbs: IR.PHRASAL_VERBS ? IR.PHRASAL_VERBS.size : -1,
  renderErr: (()=>{ try { const el=document.createElement('p'); document.querySelector('#article').appendChild(el); IR.reader._renderTokens(el,'She was tearing down the old wall'); const r=el.innerHTML.slice(0,120); el.remove(); return 'ok:'+r; } catch(e){ return 'THROW:'+e.message; } })()
})`));

/* ---------- B1：统计按不同单词去重，高频词含未学/在学、排除已学 ---------- */
{
  const s = await evl(`(async()=>{
    IR.vocab.statusMap = new Map([['the','known'],['cat','learning']]);
    const st = await IR.reader.computeBookStats({ id:'probe', text:'the cat sat on the mat the cat' });
    return JSON.stringify({ u:st.unknown, l:st.learning, k:st.known, uniq:st.unique, tokens:st.tokens,
      top: st.topUnknown.map(t=>t.w+':'+t.c+':'+t.s), v: st.v });
  })()`);
  const d = j(s);
  check('B1 生词/在学/已学按不同单词去重（the×3 只算 1）', d.u === 3 && d.l === 1 && d.k === 1, s);
  check('B1 高频词含未学+在学、已学不进榜（4 个，cat×2 在学）',
    (d.top || []).length === 4 && d.top[0] === 'cat:2:learning', JSON.stringify(d.top));
  /* 阅读视图右键统计同样去重 */
  const live = await evl(`(()=>{
    const c = document.querySelector('#readingStats').textContent.replace(/\\s+/g,' ').trim();
    const uniq = new Set([...document.querySelectorAll('.article .w')].map(w=>w.dataset.k)).size;
    return JSON.stringify({ c, uniq });
  })()`);
  const lv = j(live);
  const nums = (lv.c || '').match(/生词\s*([\d,]+)\s*·\s*在学\s*([\d,]+)\s*·\s*已学\s*([\d,]+)/);
  const sum = nums ? (+nums[1].replace(/,/g, '') + +nums[2].replace(/,/g, '') + +nums[3].replace(/,/g, '')) : -1;
  check('B1 阅读顶部三色统计之和 = 不同单词数（去重生效）', sum === lv.uniq, lv.c + ' vs uniq=' + lv.uniq);
}

/* ---------- B2：词组一条不断的线 ---------- */
{
  const out = await evl(`(()=>{
    const el = document.createElement('p');
    document.querySelector('#article').appendChild(el);
    try {
      IR.reader._renderTokens(el, 'She was tearing down the old wall');
      const ph = el.querySelector('.ph');
      if (!ph) return JSON.stringify({ ph:false, html:el.innerHTML.slice(0,200) });
      const w1 = ph.querySelector('.w');
      return JSON.stringify({
        ph: true, phText: ph.dataset.ph, nodes: ph.childNodes.length, kids: ph.children.length,
        outer: getComputedStyle(ph).textDecorationLine + '/' + getComputedStyle(ph).textDecorationStyle,
        innerDeco: getComputedStyle(w1).textDecorationLine, innerClass: w1.className
      });
    } finally { el.remove(); }
  })()`);
  const d = j(out);
  check('B2 词组 tearing down 包成一层 .ph（2 个 word span + 1 个空格文本）',
    d.ph === true && d.kids === 2 && d.nodes === 3 && d.phText === 'tearing down', out);
  check('B2 .ph 上画一条连续的线，组内单词自身不再画线',
    d.ph === true && d.outer === 'underline/dotted' && d.innerDeco === 'none', d.outer + ' / inner=' + d.innerDeco);
  /* 词组不跨标点、不含生词时不包层 */
  const neg = await evl(`(()=>{
    const a=document.createElement('p'); const b=document.createElement('p');
    document.querySelector('#article').append(a); document.querySelector('#article').append(b);
    try {
      IR.reader._renderTokens(a,'tearing. down');
      IR.vocab.statusMap = new Map([['tear','known'],['down','known'],['she','known'],['was','known'],['the','known'],['old','known'],['wall','known']]);
      IR.reader._renderTokens(b,'She was tearing down the old wall');
      IR.vocab.statusMap = new Map();
      return JSON.stringify({ crossPunct: !!a.querySelector('.ph'), allKnown: !!b.querySelector('.ph') });
    } finally { a.remove(); b.remove(); }
  })()`);
  const n = j(neg);
  check('B2 词组不跨标点 / 组内词都已知时不画线', n.crossPunct === false && n.allKnown === false, neg);
}

/* ---------- B3：目录按钮和「上一页」按钮不再重叠 ---------- */
{
  await evl(`(()=>{
    const b = IR.reader.currentBook;
    if (!b.toc || !b.toc.length) { b.toc = [{title:'第 1 章', bi:0},{title:'第 2 章', bi:1}]; IR.reader._renderToc(); }
    return 1;
  })()`);
  await sleep(300);
  const fabPlain = await box('#tocFab'), prevPlain = await box('#btnPrevPage');
  check('B3 滚动模式：目录按钮可见、翻页按钮隐藏（不再叠加）',
    fabPlain && fabPlain.vis && !(prevPlain && prevPlain.vis), JSON.stringify({ fab: fabPlain, prev: prevPlain }));

  await evl(`document.querySelector('#btnMode').click()`);       /* 进翻页模式 */
  await sleep(700);
  const fab = await box('#tocFab'), prev = await box('#btnPrevPage'), next = await box('#btnNextPage');
  check('B3 翻页模式：目录按钮与上一页按钮不再相交',
    !!fab && !!prev && !hit(fab, prev), JSON.stringify({ fab, prev }));
  check('B3 目录按钮也没跑到左下角外面', !!fab && fab.l >= 0 && fab.b <= 900, JSON.stringify(fab));
  await shot('cdp-roundb-1-pagemode.png');

  /* 切页时目录按钮要收起来（fixed 元素不会随页面切换自动隐藏） */
  await evl(`document.querySelector('.nav-btn[data-page="settings"]').click()`);
  await sleep(400);
  const fabAway = await box('#tocFab');
  check('B3 离开阅读页后目录按钮自动隐藏（不再挂在别的页面上）', !!fabAway && fabAway.vis === false, JSON.stringify(fabAway));
  const navAway = await evl(`document.querySelector('#pageNav').hidden && document.querySelector('#pageIndicator').hidden`);
  check('B3 翻页箭头 / 页码也不会留在别的页面', navAway === true, 'pageNav+indicator hidden=' + navAway);
  await evl(`document.querySelector('.nav-btn[data-page="reader"]').click()`);
  await sleep(500);
  const fabBack = await box('#tocFab');
  check('B3 回到阅读页目录按钮恢复', !!fabBack && fabBack.vis === true, JSON.stringify(fabBack));
}

/* ---------- B4：翻页页数跟着窗口大小走 ---------- */
{
  /* demo 文章只有 6 段，1 页就装下了；换成 60 段长文才好比较页数 */
  const made = await evl(`(()=>{
    IR.reader.blocks = Array.from({length:60},(_,i)=>({ t:'p', text:'Paragraph '+i+'. ' + 'The quick brown fox jumps over the lazy dog. '.repeat(3) }));
    IR.reader.rendered = 0;
    IR.reader.articleEl.innerHTML = '';
    IR.reader.pageEls = null; IR.reader.pages = [];
    IR.reader.counts = { total:0, unknown:0, learning:0, known:0 };
    IR.reader._seenKeys = new Map();
    IR.reader._toPageMode();
    return IR.reader.pageEls.length;
  })()`);
  check('B4 长文在翻页模式下分成多页', typeof made === 'number' && made > 3, 'pages=' + made);

  const pagesNow = async () => {
    const t = await evl(`document.querySelector('#pageIndicator').textContent`);
    return +(String(t).split('/')[1] || 0);
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const big = await pagesNow();
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 560, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const small = await pagesNow();
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1200, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  const taller = await pagesNow();
  check('B4 窗口越小页数越多、窗口越高页数越少（按窗口重排）',
    small > big && taller < big, `1200px=${taller} 页 / 900px=${big} 页 / 560px=${small} 页`);

  /* 重排后停在同一段文字上 */
  const anchor = await evl(`(()=>{
    IR.reader.pageIndex = Math.floor(IR.reader.pageEls.length * 0.6);
    IR.reader._showPage();
    return +IR.reader.pageEls[IR.reader.pageIndex].querySelector('[data-bi]').dataset.bi;
  })()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false });
  await sleep(900);
  const after = j(await evl(`(()=>{
    const pg = IR.reader.pageEls[IR.reader.pageIndex];
    return JSON.stringify({ idx: IR.reader.pageIndex, total: IR.reader.pageEls.length,
      keeps: !!pg.querySelector('[data-bi="${anchor}"]'), first: +pg.querySelector('[data-bi]').dataset.bi });
  })()`));
  check('B4 重排后仍停在原来的段落上（不会跳回第一页）',
    after.keeps === true && after.idx > 0, `锚点段落 bi=${anchor} → 重排后在第 ${(after.idx || 0) + 1}/${after.total} 页（首段 bi=${after.first}）`);
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);
}

/* ---------- B5：申请 Key 帮助文案用主题副色（不是浏览器默认深蓝） ---------- */
{
  await evl(`document.querySelector('.nav-btn[data-page="settings"]').click()`);
  await sleep(400);
  await evl(`document.querySelectorAll('details.api-help').forEach(d => d.open = true)`);
  await sleep(300);
  /* 滚到「怎么申请 Key」那一段再截图 */
  await evl(`[...document.querySelectorAll('.api-help')].find(d => d.textContent.indexOf('怎么申请') >= 0).scrollIntoView({ block:'center' })`);
  await sleep(400);
  const out = await evl(`(()=>{
    const cs = getComputedStyle(document.documentElement);
    const accent2 = cs.getPropertyValue('--accent-2').trim(), accent = cs.getPropertyValue('--accent').trim();
    const a = document.querySelector('.api-help-body a');
    const code = document.querySelector('.api-help-body code');
    const rgb = s => { const c = document.createElement('span'); c.style.color = s; document.body.appendChild(c);
      const v = getComputedStyle(c).color; c.remove(); return v; };
    return JSON.stringify({
      accent2, accent, aColor: getComputedStyle(a).color, codeBg: getComputedStyle(code).backgroundColor,
      codeColor: getComputedStyle(code).color, accent2Rgb: rgb(accent2), accentRgb: rgb(accent)
    });
  })()`);
  const d = j(out);
  const defaultLinkBlue = 'rgb(0, 0, 238)';
  check('B5 帮助里的链接不再用默认深蓝', d.aColor !== defaultLinkBlue && d.aColor === d.accent2Rgb,
    `a=${d.aColor} accent-2=${d.accent2Rgb} (${d.accent2})`);
  check('B5 行内 code 用主题副色调（不是旧灰底、不是深蓝）',
    d.codeColor === d.accentRgb && d.codeBg !== 'rgba(0, 0, 0, 0)' && !/127,\s*127,\s*127/.test(d.codeBg),
    `bg=${d.codeBg} color=${d.codeColor} accent=${d.accentRgb}`);
  await shot('cdp-roundb-2-apihelp.png');
}

console.log(res.join('\n'));
console.log('FAILS=' + res.filter(r => r.startsWith('FAIL')).length + '/' + res.length);
try { ws.close(); } catch {}
killAll();
process.exit(res.some(r => r.startsWith('FAIL')) ? 1 : 0);
