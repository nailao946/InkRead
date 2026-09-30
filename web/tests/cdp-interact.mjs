/* CDP 交互验证：目录开合 / 固定侧栏 / 翻页模式 / 字体面板 */
import { spawn } from 'child_process';
import { writeFileSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9224;
const PROFILE = path.join(__dirname, 'edge-prof-' + Date.now());  /* 唯一 profile，避免 Edge 单实例转发 */
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 新目录 */ }

const edge = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1280,900', 'about:blank'
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await res.json()).find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* 等待 */ }
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
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result?.result?.value;
};
const shot = async name => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(__dirname, name), Buffer.from(s.result.data, 'base64'));
};

await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8642/web/index.html?demo=1' });
for (let i = 0; i < 50; i++) { await sleep(400); if (await evl(`document.documentElement.dataset.boot`) === '1') break; }
/* 等 demo 文章真正渲染完（首次加载要创建书） */
for (let i = 0; i < 25; i++) {
  const n = await evl(`document.querySelectorAll('.article .w').length`);
  if (n > 0) break;
  await sleep(400);
}
await sleep(600);

const log = [];
try {
log.push('href=' + await evl('location.href'));
log.push('hasArticle=' + await evl(`!!document.querySelector('#article')`));
log.push('readingHidden=' + await evl(`document.querySelector('#readingView') ? document.querySelector('#readingView').hidden : 'noElem'`));
/* 1. 打开悬浮目录 */
await evl(`document.querySelector('#tocFab').click()`);
await sleep(500);
log.push('tocPanelOpen=' + !(await evl(`document.querySelector('#tocPanel').hidden`)));
await shot('cdp-1-toc-open.png');
/* 2. 点「固定到侧栏」 */
await evl(`document.querySelector('#btnTocPin').click()`);
await sleep(500);
log.push('tocSideVisible=' + !(await evl(`document.querySelector('#tocSide').hidden`)));
log.push('tocFabAfterPin=' + !(await evl(`document.querySelector('#tocFab').hidden`)));
await shot('cdp-2-toc-pinned.png');
/* 3. 切翻页模式 */
await evl(`document.querySelector('#btnMode').click()`);
await sleep(900);
log.push('pageMode=' + (await evl(`document.querySelector('#article').classList.contains('paged')`)));
log.push('pageIndicator=' + (await evl(`document.querySelector('#pageIndicator').textContent`)));
log.push('progress=' + (await evl(`document.querySelector('#readingProgressText').textContent`)));
await shot('cdp-3-page-mode.png');
/* 4. 下一页再切回滚动（验证进度换算） */
await evl(`document.querySelector('#btnNextPage').click()`);
await sleep(400);
log.push('afterNext=' + (await evl(`document.querySelector('#pageIndicator').textContent`)));
await evl(`document.querySelector('#btnMode').click()`);
await sleep(700);
log.push('backToScrollProgress=' + (await evl(`document.querySelector('#readingProgressText').textContent`)));
await shot('cdp-4-back-scroll.png');
/* 5. 字体面板 */
await evl(`document.querySelector('#btnFont').click()`);
await sleep(400);
log.push('fontPanelOpen=' + !(await evl(`document.querySelector('#fontPanel').hidden`)));
await evl(`document.querySelector('[data-fs="+1"]').click()`);
await sleep(300);
log.push('fontSize=' + (await evl(`document.querySelector('[data-fs-val]').textContent`)));
await shot('cdp-5-font-panel.png');
/* 6. 取消固定恢复悬浮 */
await evl(`document.querySelector('#btnTocUnpin').click()`);
await sleep(400);
log.push('tocFabBack=' + !(await evl(`document.querySelector('#tocFab').hidden`)));
log.push('tocSideHidden=' + (await evl(`document.querySelector('#tocSide').hidden`)));

console.log(log.join('\n'));
} catch (e) {
  log.push('FATAL: ' + (e && e.message || e));
}
writeFileSync(path.join(__dirname, 'interact-result.txt'), log.join('\n'));
try { ws.close(); } catch (e) { /* 忽略 */ }
try { edge.kill(); } catch (e) { /* 忽略 */ }
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 可能仍被锁定 */ }
