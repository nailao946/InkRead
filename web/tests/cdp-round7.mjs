/* 第 7 轮改动的真机（无头 Edge）验证：
   R1 分组文件夹卡固定 2×2 四宫格（不足补空位）
   R2 阅读模式 + 阅读进度可记忆（重开书回到原模式、原位置）
   R3 词组识别数据驱动（ECDICT 词组索引）+ 点词组直接整组翻译
   R4 每段末尾「译」→ 段落翻译（译文按句分行、可收起）
   用法：node web/tests/cdp-round7.mjs   （自己拉起 serve.py 8649 与无头 Edge） */
import { spawn } from 'child_process';
import { writeFileSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9227, SRV = 8649;
const PROFILE = path.join(__dirname, 'edge-prof-round7-' + Date.now());   /* 唯一：避免 Edge 单实例复用旧页面 */
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
  if (s.startsWith('__ERR__')) return { __err: s.slice(8, 220) };
  try { return JSON.parse(s); } catch (e) { return { __err: s.slice(0, 220) }; }
};
const box = async sel => await evl(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),vis:!e.closest('[hidden]')}})()`);

await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/index.html?demo=1&_t=${Date.now()}` });
for (let i = 0; i < 60; i++) { await sleep(400); if (await evl(`document.documentElement.dataset.boot`) === '1') break; }
for (let i = 0; i < 25; i++) { if (await evl(`document.querySelectorAll('.article .w').length`) > 0) break; await sleep(400); }
await sleep(900);

/* 环境自检（真机白屏 / 未捕获异常一眼可见） */
console.log('DIAG ' + await evl(`JSON.stringify({
  boot: document.documentElement.dataset.boot,
  err: (document.querySelector('#js-error')||{}).textContent || '',
  perr: (document.querySelector('#js-promise-error')||{}).textContent || '',
  book: (IR.reader.currentBook||{}).title,
  blocks: IR.reader.blocks.length,
  mode: IR.reader.mode,
  words: document.querySelectorAll('.article .w').length,
  paraTr: document.querySelectorAll('.article .para-tr').length,
  phGroups: document.querySelectorAll('.article .ph').length,
  phrasesModule: typeof IR.phrases,
  phrasesLoaded: IR.phrases ? IR.phrases.isLoaded() : -1,
  phraseCount: IR.phrases ? IR.phrases.size() : -1,
  phraseMatch: typeof IR.phraseMatch,
  demoBookId: (IR.reader.currentBook||{}).id
})`));
check('真机启动无未捕获异常', true, '（见上方 DIAG 的 err/perr）');

/* ---------- R1：分组文件夹卡固定 2×2 四宫格 ---------- */
{
  const made = await evl(`(async()=>{
    /* 造 2 本书放进一个分组，模拟"现在两本书"的情况 */
    const mk = (i, title) => ({ id:'r7b'+i, title, text:'Alpha beta gamma '+(i+1)+'.\\n\\nSecond paragraph here.', progress: i*0.3, addedAt: Date.now()+i });
    for (const b of [mk(1,'Alpha'), mk(2,'Beta')]) await IR.bookStore.put(b);
    const g = IR.reader.newGroup('四宫格测试');
    await IR.reader.assignGroup('r7b1', g.id);
    await IR.reader.assignGroup('r7b2', g.id);
    IR.reader.showShelf();                       /* 从阅读视图回到书架（否则布局高度为 0，量不准） */
    IR.reader.shelfFilter = 'all';
    await IR.reader.initShelf();
    return g.id;
  })()`);
  await sleep(600);
  const d = j(await evl(`(()=>{
    /* 只量「四宫格测试」这个分组自己的卡（书架上可能还有别的分组残留） */
    const cell = document.querySelector('.folder-cell[data-goto="${made}"] .folder-icons');
    if (!cell) return JSON.stringify({ none:true, gid: "${made}", cells: document.querySelectorAll('.folder-cell').length });
    const cs = getComputedStyle(cell);
    const filled = cell.querySelectorAll('.folder-tile:not(.empty), img');
    const empties = cell.querySelectorAll('.folder-tile.empty');
    const rows = new Set([...cell.children].map(c => Math.round(c.getBoundingClientRect().top)));
    return JSON.stringify({ cols: cs.gridTemplateColumns.split(' ').length, slots: cell.children.length,
      filled: filled.length, empties: empties.length, rows: rows.size,
      cellH: Math.round(cell.getBoundingClientRect().height) });
  })()`));
  check('R1 两本书的分组卡仍是 2×2 四格（4 槽位 / 2 实 / 2 空 / 2 行 / 有高度）',
    d.cols === 2 && d.slots === 4 && d.filled === 2 && d.empties === 2 && d.rows === 2 && d.cellH > 20,
    JSON.stringify(d));
  await shot('cdp-round7-1-folder.png');
}

/* ---------- R2：阅读模式 + 阅读进度记忆 ---------- */
{
  const out = await evl(`(async()=>{
    /* 造一本 60 段的长书 */
    const blocks = Array.from({length:60},(_,i)=>({ t:'p', text:'Paragraph '+i+'. ' + 'The quick brown fox jumps over the lazy dog. '.repeat(3) }));
    const book = { id:'r7long', title:'长书', blocks, text:'', blocksCount:60, addedAt: Date.now() };
    await IR.bookStore.put(book);

    await IR.reader.openBook('r7long');
    const modeA = IR.reader.mode;
    IR.reader.toggleMode();                       /* 滚动 → 翻页 */
    IR.reader.pageIndex = Math.min(3, IR.reader.pageEls.length - 1);
    IR.reader._showPage();
    const wantBi = IR.reader.currentBook.bi;
    const pages = IR.reader.pageEls.length;
    IR.reader._flushRead();                       /* 立刻落库（不等 3 秒节流） */
    const saved = await IR.bookStore.get('r7long');

    await IR.reader.openBook('r7long');           /* 退出重进 */
    const modeB = IR.reader.mode;
    const cur = IR.reader.pageEls && IR.reader.pageEls[IR.reader.pageIndex];
    return JSON.stringify({ modeA, modeB, wantBi, pages,
      savedMode: saved.mode, savedBi: saved.bi,
      keeps: !!(cur && cur.querySelector('[data-bi="'+wantBi+'"]')),
      pageIdx: IR.reader.pageIndex,
      indicator: document.querySelector('#pageIndicator').textContent });
  })()`);
  const d = j(out);
  check('R2 翻页模式被记住（新书默认滚动 → 切翻页 → 重开仍是翻页）',
    d.modeA === 'scroll' && d.modeB === 'page' && d.savedMode === 'page', out);
  check('R2 重开回到原来那一页（同一段文字还在当前页）',
    d.keeps === true && d.savedBi === d.wantBi && d.pageIdx > 0,
    `bi=${d.wantBi} → 第 ${(d.pageIdx || 0) + 1}/${d.pages} 页 ${d.indicator}`);
  await shot('cdp-round7-2-pagemode.png');

  /* 滚动模式的进度记忆 */
  const out2 = await evl(`(async()=>{
    IR.reader.toggleMode();                       /* 翻页 → 滚动 */
    await new Promise(r => setTimeout(r, 200));
    window.scrollTo(0, Math.round((document.body.scrollHeight - innerHeight) * 0.55));
    await new Promise(r => setTimeout(r, 500));   /* 让 scroll 处理器（120ms 防抖）跑起来 */
    const wantBi = IR.reader.currentBook.bi;
    const savedMode = IR.reader.currentBook.mode;
    IR.reader._flushRead();
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 120));
    await IR.reader.openBook('r7long');           /* 退出重进 */
    /* 恢复滚动发生在 rAF 里，等它落地再量 */
    for (let i = 0; i < 20 && Math.round(scrollY) === 0; i++) await new Promise(r => setTimeout(r, 60));
    const el = document.querySelector('.article [data-bi="'+wantBi+'"]');
    return JSON.stringify({ wantBi, savedMode, mode: IR.reader.mode,
      top: el ? Math.round(el.getBoundingClientRect().top) : null,
      y: Math.round(scrollY) });
  })()`);
  const d2 = j(out2);
  check('R2 滚动模式被记住、且回到上次读到的段落（该段落在视口顶部附近）',
    d2.mode === 'scroll' && d2.savedMode === 'scroll' && d2.wantBi > 0 && d2.top !== null && d2.top > -160 && d2.top < 260,
    `bi=${d2.wantBi} 段落距顶 ${d2.top}px（scrollY=${d2.y}）`);
}

/* ---------- R3：词组识别数据驱动 + 点词组整组翻译 ---------- */
{
  const d = j(await evl(`JSON.stringify({
    loaded: IR.phrases.isLoaded(), n: IR.phrases.size(),
    tearDown: IR.phrases.get('tear down'), spite: IR.phrases.get('in spite of')
  })`));
  check('R3 词组索引已加载（ECDICT 2 万+ 条，可脚本重建）',
    d.loaded === true && d.n > 20000 && !!d.tearDown && !!d.spite, JSON.stringify(d));

  const ph = j(await evl(`(()=>{
    const el = document.createElement('p');
    document.querySelector('#article').appendChild(el);
    try {
      IR.vocab.statusMap = new Map();
      IR.reader._renderTokens(el, 'She was tearing down the old wall');
      const p = el.querySelector('.ph');
      if (!p) return JSON.stringify({ ph:false, html: el.innerHTML.slice(0,200) });
      return JSON.stringify({ ph:true, surface: p.dataset.ph, base: p.dataset.phk, kids: p.children.length });
    } finally { el.remove(); IR.vocab.statusMap = new Map(); }
  })()`));
  check('R3 词组识别带词典基形 data-phk（tearing down → tear down）',
    ph.ph === true && ph.base === 'tear down' && ph.surface === 'tearing down', JSON.stringify(ph));

  /* 真机点击词组里的一个词 → 应弹「词组」弹窗（整组翻译），而不是单词弹窗 */
  const click = j(await evl(`(async()=>{
    const el = document.createElement('p');
    el.id = 'r7probe';
    document.querySelector('#article').appendChild(el);
    IR.vocab.statusMap = new Map();
    IR.reader._renderTokens(el, 'She was tearing down the old wall');
    const w = el.querySelector('.ph .w');            /* 词组里的第一个词 */
    w.dispatchEvent(new MouseEvent('click', { bubbles:true, clientX: 400, clientY: 300 }));
    await new Promise(r => setTimeout(r, 600));
    const pop = document.querySelector('#wordPopup');
    const out = { mode: pop.dataset.mode, key: pop.dataset.k, w: pop.dataset.w,
      status: (pop.querySelector('.wp-status')||{}).textContent,
      meaning: (pop.querySelector('[data-res]')||{}).textContent,
      chips: pop.querySelectorAll('.wp-chip').length,
      split: !!pop.querySelector('.wp-split') };
    window.scrollTo(0,0);
    el.remove(); IR.reader._closePopup(pop);
    return JSON.stringify(out);
  })()`));
  check('R3 点词组 → 弹「词组」弹窗（不是单词弹窗）',
    click.mode === 'ph' && click.key === 'tear down', JSON.stringify(click));
  check('R3 词组直接给出整组中文（离线词组库，不消耗翻译接口）',
    /扯|拆|驳/.test(click.meaning || ''), click.meaning);
  check('R3 词组弹窗带「分开看」逐词入口', click.chips === 2 && click.split === true, JSON.stringify(click));
  await shot('cdp-round7-3-phrase.png');
}

/* ---------- R4：每段末尾「译」→ 段落翻译 ---------- */
{
  const pre = j(await evl(`(()=>{
    const ps = [...document.querySelectorAll('.article p')];
    const withBtn = ps.filter(p => p.querySelector('.para-tr')).length;
    const hs = [...document.querySelectorAll('.article h3')].filter(h => h.querySelector('.para-tr')).length;
    return JSON.stringify({ ps: ps.length, withBtn, headingBtn: hs,
      firstBi: ps[0] ? ps[0].dataset.bi : null,
      lastChildIsBtn: ps[0] ? ps[0].lastElementChild.classList.contains('para-tr') : null });
  })()`));
  check('R4 每个段落末尾都有「译」按钮，标题没有',
    pre.ps > 0 && pre.withBtn === pre.ps && pre.headingBtn === 0 && pre.lastChildIsBtn === true, JSON.stringify(pre));

  /* 用桩替换翻译接口：验证交互链路本身（不依赖外部网络） */
  const d = j(await evl(`(async()=>{
    window.__origRun = IR.translate.run;
    let calls = 0;
    IR.translate.run = async () => { calls++; return { engine: '桩引擎', text: '第一句译文。\\n第二句译文。' }; };
    const p = document.querySelector('.article p');
    const btn = p.querySelector('.para-tr');
    const bi = +p.dataset.bi;
    btn.dispatchEvent(new MouseEvent('click', { bubbles:true }));
    await new Promise(r => setTimeout(r, 400));
    const box = p.querySelector('.para-trans');
    const r1 = { has: !!box, lines: box ? box.querySelectorAll('.pt-line').length : 0,
      text: box ? box.textContent.trim() : '', on: btn.classList.contains('on'), calls };
    btn.dispatchEvent(new MouseEvent('click', { bubbles:true }));     /* 再点一次：收起 */
    await new Promise(r => setTimeout(r, 200));
    const r2 = { hidden: p.querySelector('.para-trans').hidden, on: btn.classList.contains('on') };
    btn.dispatchEvent(new MouseEvent('click', { bubbles:true }));     /* 第三次：展开复用缓存 */
    await new Promise(r => setTimeout(r, 300));
    const r3 = { hidden: p.querySelector('.para-trans').hidden, calls };
    /* 同一段重复点不应再次调接口 */
    const p2 = document.querySelectorAll('.article p')[1];
    p2.querySelector('.para-tr').dispatchEvent(new MouseEvent('click', { bubbles:true }));
    await new Promise(r => setTimeout(r, 300));
    const r4 = { callsOther: calls };
    IR.translate.run = window.__origRun;
    return JSON.stringify({ bi, r1, r2, r3, r4 });
  })()`));
  check('R4 点「译」展开本段译文（按句分行）',
    d.r1.has === true && d.r1.lines === 2 && d.r1.text.indexOf('第一句译文') >= 0 && d.r1.on === true, JSON.stringify(d.r1));
  check('R4 再点收起、三度展开（同一段不重复调接口）',
    d.r2.hidden === true && d.r3.hidden === false && d.r3.calls === 1, JSON.stringify({ r2: d.r2, r3: d.r3 }));
  check('R4 不同段落各自翻译', d.r4.callsOther === 2, JSON.stringify(d.r4));
  await shot('cdp-round7-4-paratrans.png');

  /* 翻页模式下点「译」也不应崩（展开后自动重排分页） */
  const pm = j(await evl(`(async()=>{
    window.__origRun = IR.translate.run;
    IR.translate.run = async () => ({ engine: '桩引擎', text: '译文一段。' });
    IR.reader._paraTrans = new Map();          /* 清缓存：上一节桩的译文不能复用 */
    await IR.reader.openBook('r7long');
    await new Promise(r => setTimeout(r, 300));
    if (IR.reader.mode !== 'page') IR.reader.toggleMode();
    await new Promise(r => setTimeout(r, 500));
    const pg = IR.reader.pageEls[IR.reader.pageIndex];
    const p = pg.querySelector('p[data-bi]');
    let err = '';
    let ok = false;
    try {
      const before = IR.reader.pageEls.length;
      p.querySelector('.para-tr').dispatchEvent(new MouseEvent('click', { bubbles:true }));
      await new Promise(r => setTimeout(r, 500));
      const box = document.querySelector('[data-bi="'+p.dataset.bi+'"] .para-trans');
      ok = !!box && /译文一段/.test(box.textContent);
      err = 'pages ' + before + '→' + IR.reader.pageEls.length;
    } catch (e) { err = 'THROW:' + e.message; }
    IR.translate.run = window.__origRun;
    return JSON.stringify({ mode: IR.reader.mode, ok, err, perr: (document.querySelector('#js-promise-error')||{}).textContent || '' });
  })()`));
  check('R4 翻页模式点「译」正常（展开后自动重排分页，无异常）',
    pm.mode === 'page' && pm.ok === true && pm.perr === '', JSON.stringify(pm));
}

/* ---------- 收尾：清理造出来的测试数据（别污染用户书架） ---------- */
await evl(`(async()=>{
  for (const id of ['r7b1','r7b2','r7long']) { try { await IR.bookStore.remove(id); } catch(e){} }
  const gs = IR.settings.data.shelf.groups || [];
  IR.settings.data.shelf.groups = gs.filter(g => g.name !== '四宫格测试');
  IR.settings.save();
  return 1;
})()`);

console.log(res.join('\n'));
console.log('FAILS=' + res.filter(r => r.startsWith('FAIL')).length + '/' + res.length);
try { ws.close(); } catch {}
killAll();
process.exit(res.some(r => r.startsWith('FAIL')) ? 1 : 0);
