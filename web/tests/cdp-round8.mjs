/* 第 8 轮改动的真机（无头 Edge）验证：
   R1 返回书架后翻页控件不再残留（翻页箭头 / 页码 / 目录按钮一并收起；重开书恢复）
   R2 右键分组文件夹卡 → 打开分组管理弹窗（重命名 / 图标 / 删除），改名保存生效
   R3 设置页左侧悬浮 tab 栏（6 个分区锚点、点击跳转、滚动联动高亮）
   用法：node web/tests/cdp-round8.mjs   （自己拉起 serve.py 8650 与无头 Edge） */
import { spawn } from 'child_process';
import { writeFileSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9228, SRV = 8650;
const PROFILE = path.join(__dirname, 'edge-prof-round8-' + Date.now());   /* 唯一：避免 Edge 单实例复用旧页面 */
/* 存档沙箱：应用会把设置/书籍/词库写入「存档目录」（默认 = 用户文档\InkRead）。
   测试必须隔离——否则测试书和分组会写进用户真实存档，且新 profile 的空 localStorage
   会触发 restore() 从磁盘还原，把上次的测试数据带进来（跨运行污染）。 */
const SANDBOX = path.join(__dirname, '_store-sandbox-' + Date.now());
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
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* Edge 还没完全退出，留着下次清 */ }
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* 同上 */ }
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
  if (s.startsWith('__ERR__')) return { __err: s.slice(8, 260) };
  try { return JSON.parse(s); } catch (e) { return { __err: s.slice(0, 260) }; }
};

await send('Page.enable');
/* 在页面任何脚本执行前种入 settings：存档目录指向本次运行的沙箱（空目录 → 无旧状态可还原） */
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  try {
    localStorage.setItem('ir.settings', JSON.stringify({ storageDir: ${JSON.stringify(SANDBOX)} }));
  } catch (e) {}
` });
await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/index.html?demo=1&_t=${Date.now()}` });
for (let i = 0; i < 60; i++) { await sleep(400); if (await evl(`document.documentElement.dataset.boot`) === '1') break; }
for (let i = 0; i < 25; i++) { if (await evl(`document.querySelectorAll('.article .w').length`) > 0) break; await sleep(400); }
await sleep(900);

/* 环境自检 */
console.log('DIAG ' + await evl(`JSON.stringify({
  boot: document.documentElement.dataset.boot,
  err: (document.querySelector('#js-error')||{}).textContent || '',
  perr: (document.querySelector('#js-promise-error')||{}).textContent || '',
  book: (IR.reader.currentBook||{}).title,
  mode: IR.reader.mode
})`));

/* ---------- R1：返回书架后翻页控件不再残留 ---------- */
{
  const d = j(await evl(`(async()=>{
    /* 造一本长书（带标题 → 有目录，目录悬浮按钮才会出现）并切到翻页模式 */
    const blocks = Array.from({length:60},(_,i)=>({ t: i % 10 === 0 ? 'h' : 'p', text: (i % 10 === 0 ? 'Chapter ' + (i/10+1) : 'Paragraph '+i+'. ') + (i % 10 === 0 ? '' : 'The quick brown fox jumps over the lazy dog. '.repeat(3)) }));
    await IR.bookStore.put({ id:'r8long', title:'R8长书', blocks, text:'', blocksCount:60, toc: IR.importers.buildToc(blocks), addedAt: Date.now() });
    await IR.reader.openBook('r8long');
    if (IR.reader.mode !== 'page') IR.reader.toggleMode();
    await new Promise(r => setTimeout(r, 500));
    const vis = sel => { const e = document.querySelector(sel); return !!(e && !e.hidden && getComputedStyle(e).display !== 'none'); };
    const before = { pageNav: vis('#pageNav'), indicator: vis('#pageIndicator'), tocFab: vis('#tocFab') };
    /* 点「← 书架」返回 */
    document.querySelector('#btnBackShelf').dispatchEvent(new MouseEvent('click', { bubbles:true }));
    await new Promise(r => setTimeout(r, 700));
    const after = { pageNav: vis('#pageNav'), indicator: vis('#pageIndicator'), tocFab: vis('#tocFab'),
      selTrans: vis('#selTransBtn'), popup: vis('#wordPopup'),
      shelfShown: !document.querySelector('#shelfView').hidden,
      readHidden: document.querySelector('#readingView').hidden };
    return JSON.stringify({ before, after });
  })()`));
  await shot('cdp-round8-1-shelfreturn.png');   /* 此刻正在书架上：控件应已全部收起 */
  const re = j(await evl(`(async()=>{
    /* 重开同一本书：翻页控件应回来，且仍是翻页模式 */
    await IR.reader.openBook('r8long');
    await new Promise(r => setTimeout(r, 500));
    const vis = sel => { const e = document.querySelector(sel); return !!(e && !e.hidden && getComputedStyle(e).display !== 'none'); };
    const reopen = { mode: IR.reader.mode, pageNav: vis('#pageNav'), indicator: vis('#pageIndicator'),
      pageIdx: IR.reader.pageIndex, pages: IR.reader.pageEls.length };
    return JSON.stringify(reopen);
  })()`));
  if (d.__err) console.log('R1 RAW: ' + JSON.stringify(d));
  if (re.__err) console.log('R1 REOPEN RAW: ' + JSON.stringify(re));
  check('R1 翻页模式下控件正常显示（箭头 / 页码 / 目录按钮）',
    d.before.pageNav && d.before.indicator && d.before.tocFab, JSON.stringify(d.before));
  check('R1 返回书架后翻页控件全部收起（箭头 / 页码 / 目录 / 划词按钮 / 弹窗）',
    d.after.pageNav === false && d.after.indicator === false && d.after.tocFab === false &&
    d.after.selTrans === false && d.after.popup === false, JSON.stringify(d.after));
  check('R1 书架视图已显示、阅读视图已隐藏',
    d.after.shelfShown === true && d.after.readHidden === true, JSON.stringify({ s: d.after.shelfShown, r: d.after.readHidden }));
  check('R1 重开书后翻页控件恢复、且仍是翻页模式（记忆生效）',
    re.mode === 'page' && re.pageNav && re.indicator && re.pages > 1,
    JSON.stringify(re));
}

/* ---------- R2：右键分组 → 管理编辑分组 ---------- */
{
  const gid = await evl(`(async()=>{
    /* 造书 + 分组，回到书架 */
    const mk = (i, title) => ({ id:'r8b'+i, title, text:'Alpha beta gamma '+(i+1)+'.\\n\\nSecond paragraph here.', progress: i*0.3, addedAt: Date.now()+i });
    for (const b of [mk(1,'甲'), mk(2,'乙'), mk(3,'丙')]) await IR.bookStore.put(b);   /* 丙不进组：验证右键书籍仍是书籍详情 */
    const g = IR.reader.newGroup('R8右键测试组');
    await IR.reader.assignGroup('r8b1', g.id);
    await IR.reader.assignGroup('r8b2', g.id);
    IR.reader.showShelf();
    IR.reader.shelfFilter = 'all';
    await IR.reader.initShelf();
    await new Promise(r => setTimeout(r, 400));
    return g.id;
  })()`);
  const box = j(await evl(`(async()=>{
    const cell = document.querySelector('#shelfList .folder-cell[data-goto="' + ${JSON.stringify('GID_PLACEHOLDER')} + '"]');
    if (!cell) return JSON.stringify({ noCell: true, folders: document.querySelectorAll('#shelfList .folder-cell').length });
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
    await new Promise(r => setTimeout(r, 400));
    const mask = document.querySelector('#modalMask');
    const nameInput = document.querySelector('#modalBox [data-gname]');
    return JSON.stringify({
      dialogOpen: !!(mask && !mask.hidden),
      title: (document.querySelector('#modalBox h3')||{}).textContent,
      nameVal: nameInput ? nameInput.value : null,
      hasDel: !!document.querySelector('#modalBox [data-gdel]'),
      icons: document.querySelectorAll('#modalBox [data-ic]').length
    });
  })()`.replace('GID_PLACEHOLDER', gid)));
  check('R2 右键分组卡 → 打开「编辑分组」弹窗',
    box.dialogOpen === true && /编辑分组/.test(box.title || ''), JSON.stringify(box));
  check('R2 弹窗内含原名称（可重命名）、图标选择、删除分组按钮',
    box.nameVal === 'R8右键测试组' && box.icons > 0 && box.hasDel === true, JSON.stringify(box));
  await shot('cdp-round8-2-groupedit.png');

  /* 改名并保存 → 分组列表应更新 */
  const renamed = j(await evl(`(async()=>{
    const input = document.querySelector('#modalBox [data-gname]');
    input.value = 'R8改名后的组';
    document.querySelector('#modalBox [data-gsave]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    const names = IR.reader.groups().map(g => g.name);
    const dialogClosed = document.querySelector('#modalMask').hidden;
    return JSON.stringify({ names, dialogClosed });
  })()`));
  check('R2 重命名保存生效（弹窗关闭、分组列表出现新名）',
    renamed.dialogClosed === true && renamed.names.includes('R8改名后的组') &&
    !renamed.names.includes('R8右键测试组'), JSON.stringify(renamed));

  /* 右键普通书籍卡 → 仍是书籍详情（不误伤） */
  const bk = j(await evl(`(async()=>{
    const cell = document.querySelector('[data-id="r8b3"]');   /* 未分组的书在「全部」视图里是封面卡 */
    if (!cell) return JSON.stringify({ noCell: true });
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 400));
    const out = { dialogOpen: !document.querySelector('#modalMask').hidden,
      hasGdel: !!document.querySelector('#modalBox [data-gdel]') };
    /* 详情弹窗有「删除书籍」而非「删除分组」；关掉避免影响后续 */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    return JSON.stringify(out);
  })()`));
  check('R2 右键书籍卡仍是书籍详情（删除的是书不是分组）',
    bk.noCell === true || (bk.dialogOpen === true && bk.hasGdel === false), JSON.stringify(bk));
}

/* ---------- R3：设置页左侧悬浮 tab 栏 ---------- */
{
  const d = j(await evl(`(async()=>{
    document.querySelector('.nav-btn[data-page="settings"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const tabs = [...document.querySelectorAll('.settings-tabs button')];
    const nav = document.querySelector('.settings-tabs');
    const cs = nav ? getComputedStyle(nav) : null;
    const secs = [...document.querySelectorAll('.settings-body [data-sec]')].map(e => e.dataset.sec);
    return JSON.stringify({
      pageActive: document.querySelector('#page-settings').classList.contains('active'),
      tabCount: tabs.length, tabNames: tabs.map(t => t.dataset.tab),
      sticky: cs ? cs.position : null, secs,
      firstActive: tabs.find(t => t.classList.contains('active'))?.dataset.tab || null
    });
  })()`));
  check('R3 设置页有左侧悬浮 tab 栏（6 个分区、sticky 定位）',
    d.pageActive === true && d.tabCount === 6 && d.sticky === 'sticky' &&
    ['theme','colors','tts','translate','storage','data'].every(t => d.tabNames.includes(t)) &&
    d.secs.length >= 6, JSON.stringify({ n: d.tabCount, sticky: d.sticky, secs: d.secs }));

  /* 点击「翻译接口」tab → 该分区滚动到视口顶部附近，且高亮同步 */
  const jump = j(await evl(`(async()=>{
    const btn = document.querySelector('.settings-tabs button[data-tab="translate"]');
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    /* smooth 滚动需要时间落地：轮询等分区接近视口顶 */
    let top = null;
    for (let i = 0; i < 40; i++) {
      const sec = document.querySelector('.settings-body [data-sec="translate"]');
      top = Math.round(sec.getBoundingClientRect().top);
      if (top > -20 && top < 150) break;
      await new Promise(r => setTimeout(r, 80));
    }
    await new Promise(r => setTimeout(r, 350));   /* 等防抖高亮同步跑完 */
    const active = document.querySelector('.settings-tabs button.active');
    return JSON.stringify({ top, activeTab: active ? active.dataset.tab : null });
  })()`));
  check('R3 点击「翻译接口」tab → 平滑跳到该分区且高亮联动',
    jump.top !== null && jump.top > -20 && jump.top < 150 && jump.activeTab === 'translate',
    `分区距顶 ${jump.top}px，高亮=${jump.activeTab}`);
  await shot('cdp-round8-3-settingstabs.png');

  /* 滚到底部 → 最后一个 tab（数据与配置）应高亮 */
  const bot = j(await evl(`(async()=>{
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(r => setTimeout(r, 600));   /* 防抖 120ms + 余量 */
    const active = document.querySelector('.settings-tabs button.active');
    return JSON.stringify({ activeTab: active ? active.dataset.tab : null,
      y: Math.round(scrollY) });
  })()`));
  check('R3 滚到底部 → 「数据与配置」tab 高亮',
    bot.activeTab === 'data', JSON.stringify(bot));

  /* 收尾：回到阅读页（顺便确认设置页滚动不影响其他页） */
  await evl(`(async()=>{
    document.querySelector('.nav-btn[data-page="reader"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 1;
  })()`);
}

/* ---------- 收尾：清理造出来的测试数据 ---------- */
await evl(`(async()=>{
  for (const id of ['r8b1','r8b2','r8b3','r8long']) { try { await IR.bookStore.remove(id); } catch(e){} }
  const gs = IR.settings.data.shelf.groups || [];
  IR.settings.data.shelf.groups = gs.filter(g => !/^R8/.test(g.name));
  IR.settings.save();
  return 1;
})()`);
await sleep(1500);   /* 等 filestore 防抖（700ms）把最后的存档写进沙箱 */
/* 健全性检查：应用实际使用的存档目录必须是本次沙箱（没碰用户文档\InkRead） */
console.log('STORE ' + await evl(`JSON.stringify({ dir: IR.filestore.dir() })`));

console.log(res.join('\n'));
console.log('FAILS=' + res.filter(r => r.startsWith('FAIL')).length + '/' + res.length);
try { ws.close(); } catch {}
killAll();
process.exit(res.some(r => r.startsWith('FAIL')) ? 1 : 0);
