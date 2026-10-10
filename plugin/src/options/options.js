/* InkRead Video — 设置页 */
import { api, get, IS_CHROMIUM } from '../shared/api.js';
import { getSettings, saveSettings, getVocab, clearReports, clearVocab } from '../shared/store.js';
import { detectServer, readVocabFromServer, parseVocabFile, LINK_SOURCE } from '../shared/vocab-source.js';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
let settings = null;
let dirHandle = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  settings = await getSettings();
  $('#ver').textContent = 'v' + api.runtime.getManifest().version;
  $('#footVer').textContent = 'v' + api.runtime.getManifest().version;

  bindModes();
  bindRows();
  bindImport();
  bindFs();
  await hydrate();
  await refreshVocabInfo(true);
  await renderDataInfo();
}

/* ---------- 表单回填 ---------- */
async function hydrate() {
  const s = settings;
  $$('input[name=linkmode]').forEach(r => { r.checked = r.value === s.link.mode; });
  $('#serverUrl').value = s.link.serverUrl || '';
  $('#ports').value = (s.link.ports || []).join(', ');
  $('#uiBadge').checked = s.ui.badge !== false;
  $('#autoAnalyze').checked = s.subs.autoAnalyze !== false;
  $('#preferEn').checked = s.subs.preferEn !== false;
  $('#minTokens').value = s.subs.minTokens ?? 80;
  $$('#segSide button').forEach(b => b.classList.toggle('active', b.dataset.v === (s.ui.badgeSide || 'right')));
  syncSubVisibility();
}

function syncSubVisibility() {
  const mode = currentMode();
  $$('.sub[data-for]').forEach(el => { el.hidden = el.dataset.for !== mode; });
}

function currentMode() {
  const r = $$('input[name=linkmode]').find(x => x.checked);
  return r ? r.value : 'auto';
}

/* ---------- 模式切换 ---------- */
function bindModes() {
  $$('input[name=linkmode]').forEach(r => {
    r.addEventListener('change', async () => {
      syncSubVisibility();
      await saveSettings({ link: { mode: r.value } });
      settings = await getSettings();
      await api.runtime.sendMessage({ type: 'settingsChanged' }).catch(() => { });
      await refreshVocabInfo(true);
      toast('已切换为：' + ({ auto: '自动联动', manual: '只用导入词表', off: '关闭联动' }[r.value]), 'ok');
    });
  });
}

/* ---------- 各输入项 ---------- */
function bindRows() {
  $('#serverUrl').addEventListener('change', async e => {
    await saveSettings({ link: { serverUrl: e.target.value.trim() } });
    settings = await getSettings();
    await refreshVocabInfo(true);
  });
  $('#ports').addEventListener('change', async e => {
    const ports = e.target.value.split(/[,\s]+/).map(x => parseInt(x, 10)).filter(n => n > 0 && n < 65536);
    e.target.value = ports.join(', ');
    await saveSettings({ link: { ports } });
    settings = await getSettings();
  });

  $('#btnTest').addEventListener('click', testConnection);
  $('#btnRefreshVocab').addEventListener('click', () => refreshVocabInfo(true, true));

  $('#uiBadge').addEventListener('change', async e => { await saveSettings({ ui: { badge: e.target.checked } }); broadcast(); });
  $('#autoAnalyze').addEventListener('change', async e => { await saveSettings({ subs: { autoAnalyze: e.target.checked } }); broadcast(); });
  $('#preferEn').addEventListener('change', async e => { await saveSettings({ subs: { preferEn: e.target.checked } }); broadcast(); });
  $('#minTokens').addEventListener('change', async e => {
    const n = Math.max(0, Math.min(5000, parseInt(e.target.value, 10) || 0));
    e.target.value = n; await saveSettings({ subs: { minTokens: n } }); broadcast();
  });
  $$('#segSide button').forEach(b => b.addEventListener('click', async () => {
    $$('#segSide button').forEach(x => x.classList.toggle('active', x === b));
    await saveSettings({ ui: { badgeSide: b.dataset.v } }); broadcast();
  }));

  $('#defaultStatus') && ($('#defaultStatus').value = 'known');
}

async function broadcast() {
  settings = await getSettings();
  const tabs = await api.tabs.query({ url: ['*://*.bilibili.com/*', '*://*.youtube.com/*'] }).catch(() => []);
  for (const t of tabs) {
    try { await api.tabs.sendMessage(t.id, { type: 'settings', settings: { ui: settings.ui, subs: settings.subs } }); }
    catch (e) { /* 无内容脚本 */ }
  }
  await api.runtime.sendMessage({ type: 'settingsChanged' }).catch(() => { });
}

/* ---------- 本地服务测试 ---------- */
async function testConnection() {
  const out = $('#testOut');
  const btn = $('#btnTest');
  btn.disabled = true;
  out.hidden = false;
  out.removeAttribute('data-ok');
  out.textContent = '正在探测…';
  const custom = $('#serverUrl').value.trim();
  const ports = $('#ports').value.split(/[,\s]+/).map(x => parseInt(x, 10)).filter(Boolean);
  try {
    const hit = await detectServer({ custom, ports: ports.length ? ports : [17890, 8642], timeoutMs: 2000 });
    if (!hit) {
      out.dataset.ok = '0';
      out.innerHTML = `未检测到墨读本地服务。<br>请确认：① 墨读桌面版正在运行，或网页版已用 <code>start-server.bat</code> 启动；② 地址/端口正确。`;
      return;
    }
    const got = await readVocabFromServer(hit.base, 4000);
    out.dataset.ok = '1';
    out.innerHTML = `✓ 连接成功 <code>${hit.base}</code>　词表 <b>${got.count}</b> 个词（${got.label}）`;
  } catch (e) {
    out.dataset.ok = '0';
    out.innerHTML = `连接失败：${String(e && e.message || e)}`;
  } finally { btn.disabled = false; }
}

/* ---------- 词库状态 ---------- */
async function refreshVocabInfo(force, reSync) {
  const banner = $('#linkBanner');
  let v = null;
  try { v = await api.runtime.sendMessage({ type: 'vocabStatus', force: !!reSync }); } catch (e) { /* 后台未响应 */ }

  const ok = !!(v && v.ok && v.count);
  banner.setAttribute('data-ok', ok ? '1' : '0');
  if (!v) { $('#bannerTitle').textContent = '无法连接扩展后台'; $('#bannerDesc').textContent = '请重新加载扩展后重试'; }
  else if (v.mode === 'off') { $('#bannerTitle').textContent = '联动已关闭'; $('#bannerDesc').textContent = '所有词都会按「生词」计算，只看客观难度'; }
  else if (ok) { $('#bannerTitle').textContent = `已联动词库 · ${v.count} 词`; $('#bannerDesc').textContent = v.label || LINK_SOURCE.local; }
  else if (v.count) { $('#bannerTitle').textContent = `离线词表 · ${v.count} 词`; $('#bannerDesc').textContent = (v.label || '导入文件') + '（未连接墨读服务，使用缓存）'; }
  else { $('#bannerTitle').textContent = '未联动词库'; $('#bannerDesc').textContent = v.error || '请启动墨读或导入词表'; }

  const rec = await getVocab();
  const kv = $('#vocabInfo');
  if (!rec) { kv.innerHTML = `<div class="k"><span>当前词表</span><b class="small">尚未导入或同步</b></div>`; return; }
  const s = v && v.summary;
  kv.innerHTML = `
    <div class="k"><span>词条总数</span><b>${rec.count || 0}</b></div>
    <div class="k"><span>已学</span><b>${s ? s.known : '—'}</b></div>
    <div class="k"><span>在学</span><b>${s ? s.learning : '—'}</b></div>
    <div class="k"><span>生词本</span><b>${s ? s.new : '—'}</b></div>
    <div class="k"><span>来源</span><b class="small">${esc(rec.label || rec.source)}</b></div>
    <div class="k"><span>同步时间</span><b class="small">${fmt(rec.at)}</b></div>`;
}

/* ---------- 文件导入 ---------- */
function bindImport() {
  const drop = $('#drop'), file = $('#file');
  drop.addEventListener('click', () => file.click());
  file.addEventListener('change', () => { if (file.files[0]) importFile(file.files[0]); file.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) importFile(f); });
}

async function importFile(f) {
  const out = $('#impOut');
  out.hidden = false;
  out.removeAttribute('data-ok');
  out.textContent = '正在解析 ' + f.name + ' …';
  try {
    const text = await f.text();
    const def = ($('#defaultStatus') && $('#defaultStatus').value) || 'known';
    const parsed = parseVocabFile(f.name, text, { defaultStatus: def });
    if (!parsed.entries.length) throw new Error('没有解析到任何单词（检查文件格式）');
    const r = await api.runtime.sendMessage({ type: 'setVocab', source: 'file', label: parsed.label + ' · ' + f.name, entries: parsed.entries });
    out.dataset.ok = '1';
    out.innerHTML = `✓ 已导入 <b>${r.count}</b> 个词（${parsed.label}）。` +
      (currentMode() === 'auto' ? `<br>⚠ 当前是「自动联动本地服务」模式，下次同步会被墨读词库覆盖。若要固定用这个文件，请选择上面的「只用导入的词表」。` : '');
    await refreshVocabInfo(false);
    await renderDataInfo();
  } catch (e) {
    out.dataset.ok = '0';
    out.textContent = '导入失败：' + String(e && e.message || e);
  }
}

/* ---------- 目录绑定（File System Access，Chrome/Edge） ---------- */
const IDB = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((res, rej) => {
      const r = indexedDB.open('inkread-video', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('h');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.db;
  },
  async put(k, v) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('h', 'readwrite');
      tx.objectStore('h').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  },
  async get(k) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('h', 'readonly');
      const q = tx.objectStore('h').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  }
};

function bindFs() {
  if (!IS_CHROMIUM || !window.showDirectoryPicker) {
    $('#dirHint').textContent = '当前浏览器不支持目录绑定（Firefox 用「导入文件」即可）。';
    $('#btnPickDir').disabled = true;
    return;
  }
  $('#fsRow').hidden = false;
  $('#btnPickDir').addEventListener('click', pickDir);
  $('#btnSyncDir').addEventListener('click', syncDir);
  IDB.get('dir').then(h => { if (h) { dirHandle = h; $('#btnSyncDir').hidden = false; } }).catch(() => { });
}

async function pickDir() {
  try {
    const dir = await window.showDirectoryPicker({ mode: 'read' });
    dirHandle = dir;
    await IDB.put('dir', dir);
    $('#btnSyncDir').hidden = false;
    toast('已绑定目录：' + dir.name, 'ok');
    await syncDir();
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('选择目录失败：' + e.message, 'err');
  }
}

async function syncDir() {
  const out = $('#impOut');
  out.hidden = false;
  try {
    if (!dirHandle) dirHandle = await IDB.get('dir');
    if (!dirHandle) throw new Error('尚未绑定目录');
    if (dirHandle.queryPermission && await dirHandle.queryPermission({ mode: 'read' }) !== 'granted') {
      const p = await dirHandle.requestPermission({ mode: 'read' });
      if (p !== 'granted') throw new Error('未获得目录读取权限');
    }
    const fh = await dirHandle.getFileHandle('vocab.json');
    const file = await fh.getFile();
    const text = await file.text();
    const { entries } = parseVocabFile('vocab.json', text, { defaultStatus: 'new' });
    if (!entries.length) throw new Error('vocab.json 里没有词条');
    const r = await api.runtime.sendMessage({ type: 'setVocab', source: 'file', label: '目录绑定 · ' + dirHandle.name, entries });
    out.dataset.ok = '1';
    out.innerHTML = `✓ 已从「${esc(dirHandle.name)}/vocab.json」同步 <b>${r.count}</b> 个词。`;
    await refreshVocabInfo(false);
    await renderDataInfo();
  } catch (e) {
    out.dataset.ok = '0';
    out.innerHTML = `目录同步失败：${esc(String(e && e.message || e))}<br>提示：请选择墨读的<b>存档目录</b>（默认 <code>文档\\InkRead</code>），其中应有 vocab.json。`;
  }
}

/* ---------- 数据信息 ---------- */
async function renderDataInfo() {
  const rec = await getVocab();
  const idx = (await get('local', 'iv.anIndex'))['iv.anIndex'] || {};
  const n = Object.keys(idx).length;
  const bytes = (JSON.stringify(rec || {}).length + JSON.stringify(idx).length);
  $('#dataInfo').innerHTML = `
    <div class="k"><span>词库缓存</span><b class="small">${rec ? (rec.count + ' 词 · ' + esc(rec.label || rec.source)) : '无'}</b></div>
    <div class="k"><span>分析缓存</span><b>${n}</b></div>
    <div class="k"><span>占用估算</span><b class="small">${(bytes / 1024).toFixed(1)} KB</b></div>`;
  $('#btnClearReports').onclick = async () => { await clearReports(); await renderDataInfo(); toast('已清除分析缓存', 'ok'); };
  $('#btnClearAll').onclick = async () => {
    await clearReports(); await clearVocab();
    await api.runtime.sendMessage({ type: 'settingsChanged' }).catch(() => { });
    await refreshVocabInfo(true); await renderDataInfo();
    toast('已清除词库与分析缓存', 'ok');
  };
}

/* ---------- 工具 ---------- */
function fmt(ts) {
  if (!ts) return '—';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let toastTimer;
function toast(msg, t) {
  const el = $('#toast');
  el.textContent = msg;
  el.setAttribute('data-t', t || '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}
