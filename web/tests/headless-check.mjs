/* 无头验证工具：启动 Edge(CDP)，等页面 boot 标记后再截图/取证
   用法：node tests/headless-check.mjs <url> [screenshot.png] [waitMs] */
import { spawn } from 'child_process';
import { writeFileSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9223;
const PROFILE = path.join(__dirname, 'edge-profile-cdp');
const url = process.argv[2] || 'http://127.0.0.1:8642/web/index.html?demo=1';
const shotPath = process.argv[3] || '';
const waitMs = +(process.argv[4] || 20000);

try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* 新 profile */ }

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
      const tabs = await res.json();
      const page = tabs.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) { /* Edge 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 连接超时');
}

const ws = new WebSocket(await getWsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = ev => {
  const d = JSON.parse(ev.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
};
const send = (method, params = {}) => new Promise(resolve => {
  const id = ++msgId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });

/* 轮询 boot 标记（最多 waitMs） */
let booted = false, jsErr = '', stage = '';
const t0 = Date.now();
while (Date.now() - t0 < waitMs) {
  await sleep(400);
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      boot: document.documentElement.dataset.boot || '',
      stage: document.documentElement.dataset.stage || '',
      err: (document.querySelector('#js-error') || {}).textContent || '',
      perr: (document.querySelector('#js-promise-error') || {}).textContent || '',
      words: document.querySelectorAll('.article .w').length,
      reading: !document.querySelector('#readingView').hidden
    })`,
    returnByValue: true
  });
  const s = JSON.parse(r.result?.result?.value || '{}');
  stage = s.stage; jsErr = s.err || s.perr;
  if (s.boot === '1') { booted = true; break; }
}
await sleep(800);  /* 渲染余量 */

const state = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    boot: document.documentElement.dataset.boot || '',
    stage: document.documentElement.dataset.stage || '',
    err: (document.querySelector('#js-error') || {}).textContent || '',
    perr: (document.querySelector('#js-promise-error') || {}).textContent || '',
    words: document.querySelectorAll('.article .w').length,
    reading: !document.querySelector('#readingView').hidden,
    stats: (document.querySelector('#readingStats') || {}).textContent || '',
    progress: (document.querySelector('#readingProgressText') || {}).textContent || '',
    tocItems: document.querySelectorAll('.toc-item').length,
    tocFabVisible: !document.querySelector('#tocFab').hidden,
    mode: document.querySelector('#btnMode') ? document.querySelector('#btnMode').textContent : ''
  })`,
  returnByValue: true
});
const out = state.result?.result?.value || '{}';
console.log('BOOTED=' + booted);
console.log(out);

if (shotPath) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
  console.log('SHOT=' + shotPath);
}

ws.close();
edge.kill();
process.exit(booted && !jsErr ? 0 : 1);
