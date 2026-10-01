/* 第 9 轮真机（无头 Edge）验证：
   R1 词组弹窗「分开看」：点 chip → 切成单词弹窗且不被误关（第 9 轮 bug 修复）
   R2 剑桥词典：在「广告域被拦」的环境下（复现用户处境）不再出现「请在本站允许广告」墙，词条正常
   R3 广告墙兜底：人为注入一堵同文案的整屏遮罩 → 兜底脚本应把它摘掉并恢复滚动
   R4 应用内词典抽屉：正常打开、iframe 指向本地代理
   用法：node web/tests/cdp-round9.mjs */
import { spawn } from 'child_process';
import { writeFileSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9235, SRV = 8663;
const PROFILE = path.join(__dirname, 'edge-prof-round9-' + Date.now());
const SANDBOX = path.join(__dirname, '_store-sandbox-r9-' + Date.now());
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}

const server = spawn(process.env.PY || 'python', [path.join(ROOT, 'web/tools/serve.py'), String(SRV), '--no-open'], { stdio: 'ignore' });
const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
const killAll = () => {
  try { edge.kill(); } catch {}
  try { server.kill(); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  try { rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
};
process.on('exit', killAll);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = tabs.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('CDP 超时');
}
const ws = new WebSocket(await getWsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map(); const events = [];
ws.onmessage = ev => {
  const d = JSON.parse(ev.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method) events.push(d);
};
const send = (m, p = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const evl = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return '__ERR__ ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
const shot = async name => { const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(__dirname, name), Buffer.from(s.result.data, 'base64')); };
const res = [];
const check = (n, c, extra) => res.push((c ? 'PASS' : 'FAIL') + ' ' + n + (extra !== undefined ? ' | ' + extra : ''));
const j = s => {
  if (typeof s !== 'string') return { __err: 'no-result' };
  if (s.startsWith('__ERR__')) return { __err: s.slice(8, 260) };
  try { return JSON.parse(s); } catch (e) { return { __err: s.slice(0, 260) }; }
};

await send('Page.enable');
await send('Network.enable');
/* 模拟用户环境：广告/检测域名不可达（国内常见，触发反广告墙的条件） */
await send('Network.setBlockedURLs', { urls: [
  '*doubleclick.net*', '*googlesyndication.com*', '*googleadservices.com*',
  '*googletagservices.com*', '*html-load.com*', '*polarbyte.com*',
  '*ads-twitter.com*', '*analytics.twitter.com*', '*cookielaw.org*'
] });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  try { localStorage.setItem('ir.settings', JSON.stringify({ storageDir: ${JSON.stringify(SANDBOX)} })); } catch (e) {}
  try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (e) {}
` });

/* ---------- R1：词组弹窗「分开看」 ---------- */
await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/index.html?demo=1&_t=${Date.now()}` });
for (let i = 0; i < 60; i++) { await sleep(400); if (await evl(`document.documentElement.dataset.boot`) === '1') break; }
await sleep(900);
console.log('DIAG ' + await evl(`JSON.stringify({ boot: document.documentElement.dataset.boot,
  err: (document.querySelector('#js-error')||{}).textContent || '',
  perr: (document.querySelector('#js-promise-error')||{}).textContent || '' })`));
{
  const d = j(await evl(`(async()=>{
    const el = document.createElement('p');
    el.id = 'r9probe';
    document.querySelector('#article').appendChild(el);
    IR.vocab.statusMap = new Map();
    IR.reader._renderTokens(el, 'She was tearing down the old wall');
    const ph = el.querySelector('.ph');
    if (!ph) return JSON.stringify({ noPhrase: true, html: el.innerHTML.slice(0, 120) });
    ph.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 300 }));
    await new Promise(r => setTimeout(r, 350));
    const pop = document.querySelector('#wordPopup');
    const before = { mode: pop.dataset.mode, k: pop.dataset.k, chips: [...pop.querySelectorAll('.wp-chip')].map(c => c.textContent) };
    pop.querySelector('.wp-chip').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 450));
    const after = { mode: pop.dataset.mode, head: (pop.querySelector('.wp-word')||{}).textContent,
      hidden: pop.hidden, k: pop.dataset.k };
    /* 再点第二个 chip */
    pop.hidden = false;
    const pop2 = document.querySelector('#wordPopup');
    if (!pop2.querySelector('.wp-chip')) {   /* 已是单词弹窗 → 重新打开词组弹窗再点第二个 */
      ph.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
    }
    const chips = document.querySelectorAll('#wordPopup .wp-chip');
    if (chips[1]) chips[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const second = { mode: pop.dataset.mode, head: (pop.querySelector('.wp-word')||{}).textContent, hidden: pop.hidden };
    el.remove(); IR.reader._closePopup(pop); window.scrollTo(0, 0);
    return JSON.stringify({ before, after, second });
  })()`));
  if (d.__err) console.log('R1 RAW: ' + JSON.stringify(d));
  check('R1 点词组弹开（整组翻译，带 2 个「分开看」词）',
    d.before && d.before.mode === 'ph' && d.before.k === 'tear down' && d.before.chips.length === 2, JSON.stringify(d.before));
  check('R1 点第 1 个 chip → 切到单词弹窗且弹窗保持可见（不被误关）',
    d.after && d.after.mode === 'word' && d.after.head === 'tearing' && d.after.hidden === false, JSON.stringify(d.after));
  check('R1 点第 2 个 chip 同样生效', d.second && d.second.mode === 'word' && d.second.head === 'down' && d.second.hidden === false,
    JSON.stringify(d.second));
  await shot('cdp-round9-1-split.png');
}

/* ---------- R2：剑桥词典不再出现反广告墙（广告域被拦环境） ---------- */
events.length = 0;
const PROXY = `http://127.0.0.1:${SRV}/__proxy?url=` + encodeURIComponent('https://dictionary.cambridge.org/dictionary/english/test');
await send('Page.navigate', { url: PROXY });
await sleep(11000);
{
  const d = j(await evl(`(()=>{
    const txt = document.body.innerText || '';
    return JSON.stringify({
      wall: txt.indexOf('允许广告') >= 0 || /本站依靠广告收入/.test(txt),
      wallCount: document.querySelectorAll('[class*=wall],[id*=wall],[class*=blocker]').length,
      hasEntry: /Meaning of test|a way of discovering/.test(txt),
      defuser: !!document.querySelector('script[data-inkread="defuser"]'),
      blockedAttrs: document.querySelectorAll('[data-inkread-blocked]').length,
      leakedSdk: [...document.querySelectorAll('script[src]')].map(s => s.src).filter(u => /html-load|polarbyte/i.test(u)).length
    });
  })()`));
  if (d.__err) console.log('R2 RAW: ' + JSON.stringify(d));
  const sdkReq = events.filter(e => e.method === 'Network.requestWillBeSent' && /html-load\.com|polarbyte\.com/i.test(e.params.request.url)).length;
  check('R2 页面不再出现「请在本站允许广告」墙', d.wall === false, JSON.stringify({ wall: d.wall, wallCount: d.wallCount }));
  check('R2 词条正文正常显示', d.hasEntry === true);
  check('R2 广告检测脚本未加载（DOM 无残留 + 无网络请求）',
    d.leakedSdk === 0 && sdkReq === 0 && d.blockedAttrs > 0 && d.defuser === true,
    JSON.stringify({ leakedSdk: d.leakedSdk, sdkReq, blockedAttrs: d.blockedAttrs, defuser: d.defuser }));
  await shot('cdp-round9-2-cambridge.png');
}

/* ---------- R3：万一将来又弹墙，兜底脚本能摘掉 ---------- */
{
  const d = j(await evl(`(async()=>{
    /* 人为注入一堵同文案的「墙」：整屏固定定位 + 高 z-index + 广告解锁文案 */
    const wall = document.createElement('div');
    wall.id = 'r9-fake-wall';
    wall.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;display:flex;align-items:center;justify-content:center;font-size:22px';
    wall.textContent = '请在本站允许广告。本站依靠广告收入运营。为了持续提供优质内容，请在本站允许广告。感谢您的支持。';
    document.body.appendChild(wall);
    document.documentElement.style.overflow = 'hidden';
    const before = !!document.getElementById('r9-fake-wall');
    /* 兜底脚本每秒扫一次，等它动手 */
    let gone = false;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 300));
      if (!document.getElementById('r9-fake-wall')) { gone = true; break; }
    }
    return JSON.stringify({ before, gone,
      overflow: document.documentElement.style.overflow,
      bodyOverflow: document.body.style.overflow });
  })()`));
  if (d.__err) console.log('R3 RAW: ' + JSON.stringify(d));
  check('R3 兜底脚本能摘掉整屏广告墙（注入同文案遮罩 → 自动移除）',
    d.before === true && d.gone === true, JSON.stringify(d));
  check('R3 墙被摘后滚动恢复（不再锁死页面）',
    !d.overflow || d.overflow !== 'hidden', JSON.stringify({ overflow: d.overflow, body: d.bodyOverflow }));
}

/* ---------- R4：应用内词典抽屉 ---------- */
{
  await send('Page.navigate', { url: `http://127.0.0.1:${SRV}/index.html?demo=1&_t=${Date.now()}` });
  for (let i = 0; i < 60; i++) { await sleep(400); if (await evl(`document.documentElement.dataset.boot`) === '1') break; }
  await sleep(700);
  const d = j(await evl(`(async()=>{
    await IR.reader.dict.open('test');
    await new Promise(r => setTimeout(r, 9000));
    const panel = document.querySelector('#dictPanel'), frame = document.querySelector('#dictFrame');
    return JSON.stringify({
      panelShown: !panel.hidden, maskShown: !document.querySelector('#dictMask').hidden,
      src: (frame.getAttribute('src') || '').slice(0, 60), title: (document.querySelector('#dictTitle') || {}).textContent
    });
  })()`));
  check('R4 应用内词典抽屉正常打开（iframe 走本地代理）',
    d.panelShown === true && d.maskShown === true && /^__proxy\?url=/.test(d.src || '') && /剑桥/.test(d.title || ''),
    JSON.stringify(d));
  await shot('cdp-round9-4-drawer.png');
}

console.log(res.join('\n'));
console.log('FAILS=' + res.filter(r => r.startsWith('FAIL')).length + '/' + res.length);
console.log('STORE ' + await evl(`JSON.stringify({ dir: IR.filestore ? IR.filestore.dir() : 'n/a' })`));
try { ws.close(); } catch {}
killAll();
process.exit(res.some(r => r.startsWith('FAIL')) ? 1 : 0);
