/* 验证：点词自动翻译 + 设置页新卡片（代理/自动翻译开关） */
import { spawn } from 'child_process';
import { writeFileSync, rmSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9226;
const BASE = process.env.BASE || 'http://127.0.0.1:8643/web/index.html';
const PROFILE = path.join(__dirname, 'edge-prof-' + Date.now());
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}

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
    } catch (e) {}
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
  return r.result?.result?.value;
};
const shot = async name => {
  try {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(__dirname, name), Buffer.from(s.result.data, 'base64'));
  } catch (e) {}
};

const log = [];
await send('Page.enable');
try {
  /* ---------- A. 点词自动翻译 ---------- */
  await send('Page.navigate', { url: BASE + '?demo=1' });
  for (let i = 0; i < 60; i++) { await sleep(400); if (await evl(`document.documentElement.dataset.boot`) === '1') break; }
  for (let i = 0; i < 30; i++) { if ((await evl(`document.querySelectorAll('#article .w').length`)) > 0) break; await sleep(400); }
  await sleep(600);

  log.push('words=' + await evl(`document.querySelectorAll('#article .w').length`));
  log.push('engine_setting=' + await evl(`IR.settings.data.api.engine || 'auto'`));
  /* 点第 6 个词（尽量避开常见词） */
  await evl(`(function(){var ws=document.querySelectorAll('#article .w');var w=ws[Math.min(5,ws.length-1)];w.click();return w.dataset.w;})()`);
  let transText = '', tries = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(400); tries++;
    transText = await evl(`(function(){var e=document.querySelector('#wordPopup [data-trans]');return e?e.textContent.trim():'';})()`);
    if (transText && transText !== '翻译中…' && transText.indexOf('翻译中') < 0) break;
  }
  log.push('popup_hidden=' + await evl(`document.querySelector('#wordPopup').hidden`));
  log.push('auto_trans_after_' + (tries * 0.4) + 's=' + transText);
  log.push('dict_text=' + await evl(`(function(){var e=document.querySelector('#wordPopup [data-res]');return e?e.textContent.trim().slice(0,60):'';})()`));
  await shot('v-1-popup.png');

  /* 关闭自动翻译后再点词：不应出译文 */
  await evl(`(function(){IR.settings.data.reader=IR.settings.data.reader||{};IR.settings.data.reader.autoTranslate=false;IR.settings.save();document.body.click();})()`);
  await sleep(300);
  await evl(`(function(){var ws=document.querySelectorAll('#article .w');ws[Math.min(8,ws.length-1)].click();return 1;})()`);
  await sleep(2500);
  log.push('auto_off_trans_hidden=' + await evl(`document.querySelector('#wordPopup [data-trans]').hidden`));
  await evl(`(function(){IR.settings.data.reader.autoTranslate=true;IR.settings.save();return 1;})()`);
  await evl(`document.querySelector('#wordPopup .wp-close').click()`);
  await sleep(200);

  /* ---------- B. 设置页新卡片 ---------- */
  await send('Page.navigate', { url: BASE + '#settings' });
  await sleep(1500);
  log.push('proxy_card=' + await evl(`!!document.querySelector('[data-card="proxy"]')`));
  log.push('proxy_toggle=' + await evl(`!!document.querySelector('[data-proxy-on]')`));
  log.push('proxy_input_ph=' + await evl(`(function(){var e=document.querySelector('[data-proxy-url]');return e?e.placeholder:'';})()`));
  log.push('auto_trans_switch=' + await evl(`(function(){var e=document.querySelector('[data-auto-trans]');return e?e.checked:'noElem';})()`));
  log.push('free_card=' + await evl(`!!document.querySelector('[data-card="free"]')`));
  log.push('engine_opts=' + await evl(`Array.from(document.querySelectorAll('[data-engine] option')).map(o=>o.value).join(',')`));
  /* 滚动到代理卡片截图 */
  await evl(`document.querySelector('[data-card="proxy"]').scrollIntoView({block:'center'})`);
  await sleep(400);
  await shot('v-2-proxy-card.png');
} catch (e) {
  log.push('FATAL: ' + (e && e.message || e));
}

writeFileSync(path.join(__dirname, 'verify-popup.txt'), log.join('\n'));
try { ws.close(); } catch (e) {}
try { edge.kill(); } catch (e) {}
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
console.log(log.join('\n'));
