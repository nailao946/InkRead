/* InkRead Video — 设置页 */
import { api, get, url } from '../shared/api.js';
import { getSettings, saveSettings, getVocab, clearReports, clearVocab, getMarks } from '../shared/store.js';
import { detectServer, readVocabFromServer, parseVocabFile, LINK_SOURCE } from '../shared/vocab-source.js';
import { parseFreq } from '../shared/freq.js';
import { analyze } from '../shared/analyze.js';
import { marksSummary } from '../shared/marks.js';
import { canPickDir, pickDir, getDir, setDir, forgetDir, permQuery, permRequest, dirSupported } from '../shared/fssync.js';
import { ENGINES, ENGINE_LABELS, engineConfigured } from '../shared/translate.js';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
let settings = null;
let dirHandle = null;
let _freq = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  settings = await getSettings();
  $('#ver').textContent = 'v' + api.runtime.getManifest().version;
  $('#footVer').textContent = 'v' + api.runtime.getManifest().version;

  bindModes();
  bindRatings();
  bindArticle();
  bindRows();
  bindImport();
  bindFs();
  bindTranslate();
  bindSettingTabs();
  renderAbout();
  await hydrate();
  await refreshVocabInfo(true);
  await renderDataInfo();
  await renderDirState();
  await renderMarksInfo();
  renderRatingDemo();
  renderTranslate();
  await renderTranslatePc();
  await renderPcDir();
}

/* ---------- 墨读存档目录（绑定目录的默认位置） ----------
   插件不需要用户手动去「找文件夹」：只要墨读本地服务在，读的就是 PC 端同一个
   <存档目录>/vocab.json。这里把该路径显出来，并提供「打开目录」。
   注意：浏览器的目录选择器不允许直接跳到任意绝对路径（只能在用户手势里由用户选），
   所以走 FSA 手动绑定时默认落在「文档」——也就是「文档\InkRead」的父目录。 */
async function renderPcDir() {
  const out = $('#pcDirOut');
  const btn = $('#btnOpenPcDir');
  let r = _pcInfo;
  if (!r) { try { r = await api.runtime.sendMessage({ type: 'pcInfo' }); } catch (e) { r = null; } _pcInfo = r; }
  if (!r || !r.ok) {
    out.innerHTML = '没连上墨读本地服务。手动绑定时请选 <code>文档\\InkRead</code>'
      + '（与 PC 端同一个目录），三端就共用一份 <code>vocab.json</code>。';
    btn.disabled = true;
    return;
  }
  const dir = r.storageDir || r.root || '（墨读默认目录）';
  out.innerHTML = `墨读正在用：<code>${esc(dir)}</code><br>`
    + '插件读的就是<b>这个目录</b>下的 <code>vocab.json</code>，三端共用一份，无需另外指定。';
  btn.disabled = false;
}

async function openPcDir() {
  const base = (_pcInfo && _pcInfo.base) || '';
  if (!base) { toast('没连上墨读本地服务', 'err'); return; }
  const root = (_pcInfo && _pcInfo.storageDir) || (_pcInfo && _pcInfo.root) || '';
  try {
    const r = await fetch(base + '/__store/open' + (root ? '?root=' + encodeURIComponent(root) : ''), { cache: 'no-store' });
    const j = await r.json().catch(() => null);
    if (j && j.ok) toast('已在资源管理器里打开：' + (j.root || root), 'ok');
    else toast('打开失败：' + ((j && j.error) || ('HTTP ' + r.status)), 'err');
  } catch (e) {
    toast('打开失败：' + String(e && e.message || e), 'err');
  }
}

/* ---------- 表单回填 ---------- */
async function hydrate() {
  const s = settings;
  $$('input[name=linkmode]').forEach(r => { r.checked = r.value === s.link.mode; });
  $('#serverUrl').value = s.link.serverUrl || '';
  $('#ports').value = (s.link.ports || []).join(', ');
  if ($('#linkWriteBack')) $('#linkWriteBack').checked = s.link.writeBack !== false;
  $('#uiBadge').checked = s.ui.badge !== false;
  $('#autoAnalyze').checked = s.subs.autoAnalyze !== false;
  $('#preferEn').checked = s.subs.preferEn !== false;
  $('#minTokens').value = s.subs.minTokens ?? 80;
  if ($('#subsMark')) $('#subsMark').checked = s.subs.mark !== false;
  if ($('#subsMarkStyle')) $('#subsMarkStyle').value = s.subs.markStyle || 'line';

  $$('input[name=ratingsys]').forEach(r => { r.checked = r.value === (s.rating.system || 'step'); });
  $('#artEnabled').checked = s.article.enabled !== false;
  $('#artAutoPill').checked = s.article.autoPill !== false;
  $('#artDim').checked = s.article.dimKnown === true;
  $('#artFont').value = s.article.fontSize || 17;
  if ($('#artInline')) $('#artInline').checked = s.article.inlineColor !== false;
  if ($('#artInlineStyle')) $('#artInlineStyle').value = s.article.inlineStyle || 'line';
  if ($('#artHlStyle')) $('#artHlStyle').value = s.article.hlStyle || 'mark';
  renderSiteOff();

  syncSubVisibility();
}

/* ---------- 评级体系 ---------- */
function bindRatings() {
  $$('input[name=ratingsys]').forEach(r => {
    r.addEventListener('change', async () => {
      settings = await saveSettings({ rating: { system: r.value } });
      await broadcast();
      const name = { step: '阶梯 L1–L4', cefr: 'CEFR A1–C2', lexile: '蓝思 Lexile' }[r.value];
      toast('默认评级已切换为：' + name, 'ok');
      renderRatingDemo();
    });
  });
}

/* 用一段固定示例演示三套评级，顺便在设置页里验证分析管线是通的 */
async function renderRatingDemo() {
  const box = $('#ratingDemo');
  if (!box) return;
  const SAMPLE = 'The central bank signalled a more restrictive monetary stance on Thursday, citing persistent '
    + 'inflationary pressures and a resilient labour market. Analysts cautioned that the tightening cycle could '
    + 'amplify refinancing risks for highly leveraged corporations across the region.';
  try {
    if (!_freq) _freq = parseFreq(await (await fetch(url('data/freq-bands.json'))).text());
    const rep = analyze(SAMPLE, new Map(), _freq, { maxTop: 5 });
    const cur = settings.rating.system || 'step';
    box.innerHTML = `
      <div class="k"><span>当前默认</span><b class="small">${esc((rep.ratings[cur] || rep.ratings.step).headline)}</b></div>
      <div class="k"><span>阶梯 L1–L4</span><b class="small">${esc(rep.ratings.step.headline)}</b></div>
      <div class="k"><span>CEFR</span><b class="small">${esc(rep.ratings.cefr.headline)}</b></div>
      <div class="k"><span>蓝思 Lexile</span><b class="small">${esc(rep.ratings.lexile ? rep.ratings.lexile.headline : '数据未就绪')}</b></div>`;
  } catch (e) {
    box.innerHTML = `<div class="k"><span>示例试算</span><b class="small">加载词频表失败：${esc(String(e && e.message || e))}</b></div>`;
  }
}

/* ---------- 网页文章 ---------- */
function bindArticle() {
  $('#artEnabled').addEventListener('change', async e => {
    settings = await saveSettings({ article: { enabled: e.target.checked } });
    await broadcast();
    toast(e.target.checked ? '已开启网页文章分析' : '已关闭网页文章分析', 'ok');
  });
  $('#artAutoPill').addEventListener('change', async e => {
    settings = await saveSettings({ article: { autoPill: e.target.checked } }); await broadcast();
  });
  $('#artDim').addEventListener('change', async e => {
    settings = await saveSettings({ article: { dimKnown: e.target.checked } }); await broadcast();
  });
  $('#artFont').addEventListener('change', async e => {
    const n = Math.max(13, Math.min(26, parseInt(e.target.value, 10) || 17));
    e.target.value = n;
    settings = await saveSettings({ article: { fontSize: n } }); await broadcast();
  });

  /* ---- 网页上色与标记 ---- */
  const ai = $('#artInline');
  if (ai) ai.addEventListener('change', async e => {
    settings = await saveSettings({ article: { inlineColor: e.target.checked } });
    await broadcast();
    toast(e.target.checked ? '已在网页正文上着色' : '已关闭网页上色', 'ok');
  });
  const ais = $('#artInlineStyle');
  if (ais) ais.addEventListener('change', async e => {
    settings = await saveSettings({ article: { inlineStyle: e.target.value } });
    await broadcast();
  });
  const ahs = $('#artHlStyle');
  if (ahs) ahs.addEventListener('change', async e => {
    settings = await saveSettings({ article: { hlStyle: e.target.value } });
    await broadcast();
  });
  const cso = $('#btnClearSiteOff');
  if (cso) cso.addEventListener('click', async () => {
    settings = await saveSettings({ article: { siteOff: [] } });
    renderSiteOff();
    await broadcast();
    toast('已恢复所有站点的网页上色', 'ok');
  });
  const csm = $('#btnClearMarks');
  if (csm) csm.addEventListener('click', async () => {
    try { await api.runtime.sendMessage({ type: 'marksClear' }); } catch (e) { /* 忽略 */ }
    await renderMarksInfo();
    toast('已清空词标记与划线', 'ok');
  });
}

/* ---- 已关闭上色的站点 ---- */
function renderSiteOff() {
  const box = $('#siteOffInfo');
  if (!box) return;
  const off = (settings.article.siteOff || []);
  box.textContent = off.length ? off.join('、') : '（暂无，所有站点都上色）';
}

/* ---- 标记总览 ---- */
async function renderMarksInfo() {
  const box = $('#marksInfo');
  if (!box) return;
  let m = null;
  try { m = await getMarks(); } catch (e) { m = null; }
  const sum = marksSummary(m || null, null);
  const by = { known: 0, learning: 0, new: 0 };
  const words = (m && m.words) || {};
  for (const k of Object.keys(words)) { const s = words[k].status; if (by[s] != null) by[s]++; }
  box.innerHTML = `
    <div class="k"><span>标记为已学</span><b>${by.known}</b></div>
    <div class="k"><span>标记为在学</span><b>${by.learning}</b></div>
    <div class="k"><span>标记为生词本</span><b>${by.new}</b></div>
    <div class="k"><span>文本划线</span><b>${sum.highlightsAll}</b></div>
    <div class="k"><span>写回共享词库</span><b class="small">${
      !dirHandle ? '未绑定目录'
        : (settings && settings.link && settings.link.writeBack === false) ? '已关闭' : '开启（标记即写 vocab.json）'
    }</b></div>`;
}

function syncSubVisibility() {
  const mode = currentMode();
  $$('.sub[data-for]').forEach(el => {
    el.hidden = !String(el.dataset.for || '').split(/\s+/).includes(mode);
  });
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
  if ($('#subsMark')) $('#subsMark').addEventListener('change', async e => {
    await saveSettings({ subs: { mark: e.target.checked } });
    await broadcast();
    toast('字幕逐词标记已' + (e.target.checked ? '开启' : '关闭'), 'ok');
  });
  if ($('#subsMarkStyle')) $('#subsMarkStyle').addEventListener('change', async e => {
    await saveSettings({ subs: { markStyle: e.target.value } });
    await broadcast();
  });
  const posReset = $('#posReset');
  if (posReset) posReset.addEventListener('click', async () => {
    /* 清掉拖动记录 → 视频胶囊回「右侧垂直居中」，文章胶囊回「右下角」 */
    await saveSettings({ ui: { pos: null, badgeSide: 'right' }, article: { pos: null } });
    await broadcast();
    toast('已重置：视频胶囊右上居中 · 文章胶囊右下角', 'ok');
  });

  $('#defaultStatus') && ($('#defaultStatus').value = 'known');
}

async function broadcast() {
  settings = await getSettings();
  const msg = { type: 'settings', settings: { ui: settings.ui, subs: settings.subs, rating: settings.rating, article: settings.article, translate: settings.translate, phrases: settings.phrases } };
  /* 不按 url 过滤：内容脚本覆盖视频站与普通网页两类，
     而 tabs.query({url}) 的过滤依赖 host 权限（普通网页我们没有）。
     直接广播给所有标签页，没有内容脚本的会抛错，忽略即可。 */
  const tabs = await api.tabs.query({}).catch(() => []);
  for (const t of tabs) {
    if (t.id == null) continue;
    try { await api.tabs.sendMessage(t.id, msg); } catch (e) { /* 无内容脚本 */ }
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
  else if (ok && v.source === 'dir') { $('#bannerTitle').textContent = `已直连存档目录 · ${v.count} 词`; $('#bannerDesc').textContent = (v.label || '') + '（无需启动桌面版）'; }
  else if (ok) { $('#bannerTitle').textContent = `已联动词库 · ${v.count} 词`; $('#bannerDesc').textContent = v.label || LINK_SOURCE.local; }
  else if (v.count) { $('#bannerTitle').textContent = `离线词表 · ${v.count} 词`; $('#bannerDesc').textContent = (v.label || '导入文件') + '（未连接墨读服务，使用缓存）'; }
  else { $('#bannerTitle').textContent = '未联动词库'; $('#bannerDesc').textContent = v.error || '请启动墨读、绑定存档目录，或导入词表'; }

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

/* ---------- 存档目录直连（File System Access，Chrome/Edge） ----------
   绑定一次 → 句柄存 IndexedDB → 后台（必要时经离屏文档）直接读写 vocab.json。
   这样插件不再依赖「桌面版 / start-server 是否在运行」，且和桌面 / 网页读写同一个文件。 */

function bindFs() {
  /* 「用墨读的目录」只依赖本地服务，与 FSA 支持无关 —— 所以在能力判断之前绑定 */
  const usePc = $('#btnUsePcDir');
  if (usePc) usePc.addEventListener('click', usePcDir);
  if (!dirSupported() || !canPickDir()) {
    $('#dirHint').innerHTML = '当前浏览器不支持目录直连（Firefox 没有 File System Access）。'
      + '请用「自动联动」连桌面版 / start-server，或「导入文件」。';
    $('#btnBindDir').disabled = true;
    $('#linkWriteBack').disabled = true;
    return;
  }
  $('#btnBindDir').addEventListener('click', bindDirNow);
  $('#btnSyncDir').addEventListener('click', () => doDirSync(true));
  $('#btnPushMarks').addEventListener('click', () => doPushMarks());
  $('#btnUnbindDir').addEventListener('click', unbindDirNow);
  const wb = $('#linkWriteBack');
  if (wb) wb.addEventListener('change', async e => {
    settings = await saveSettings({ link: { writeBack: e.target.checked } });
    toast(e.target.checked ? '标记会写回共享词库' : '已关闭写回（标记只留在插件本地）', 'ok');
  });
}

/** 「用墨读的目录（推荐）」：直接读 PC 端**同一个**存档目录 —— 不用选文件夹、也无需 FSA 绑定。
 *  本质是切到「自动联动」，由后台经墨读本地服务读 <存档目录>/vocab.json，
 *  这样插件与 PC 端永远共用同一份词库，天然就是「默认绑定目录 = PC 存储目录」。 */
async function usePcDir() {
  let r = _pcInfo;
  if (!r) { try { r = await api.runtime.sendMessage({ type: 'pcInfo' }); } catch (e) { r = null; } _pcInfo = r; }
  if (!r || !r.ok) { toast('没探测到「墨读」本地服务：请先启动墨读，或手动绑定存档目录', 'err'); return; }
  await forgetDir();
  dirHandle = null;
  settings = await saveSettings({ link: { mode: 'auto', dirName: '' } });
  $$('input[name=linkmode]').forEach(x => { x.checked = x.value === 'auto'; });
  syncSubVisibility();
  await renderDirState();
  await api.runtime.sendMessage({ type: 'settingsChanged' }).catch(() => { });
  await refreshVocabInfo(true);
  await renderDataInfo();
  const dir = r.storageDir || r.root || '（墨读默认目录）';
  const out = $('#impOut');
  out.hidden = false; out.dataset.ok = '1';
  out.innerHTML = `✓ 已切到墨读的存档目录：<code>${esc(dir)}</code>，插件读的就是 PC 端同一份 <code>vocab.json</code>。`;
  toast('已使用墨读的目录', 'ok');
}

/** 读 IndexedDB 里的句柄，刷新按钮显隐与状态行 */
async function renderDirState() {
  const box = $('#dirInfo');
  let h = null;
  try { h = await getDir(); } catch (e) { h = null; }
  dirHandle = h;

  const bound = !!h;
  $('#btnSyncDir').hidden = !bound;
  $('#btnPushMarks').hidden = !bound;
  $('#btnUnbindDir').hidden = !bound;
  $('#btnBindDir').textContent = bound ? '重新绑定其他目录…' : '绑定存档目录…';

  let probe = null;
  try { probe = await api.runtime.sendMessage({ type: 'dirProbe' }); } catch (e) { probe = null; }
  const bridge = !probe ? '未知' : probe.offscreen ? (probe.ok ? '可用（离屏文档）' : '不可用') : '浏览器不支持';

  if (!bound) {
    $('#dirHint').innerHTML = 'Chrome / Edge 支持。绑定「文档\\InkRead」后，插件直接读该目录里的 '
      + '<code>vocab.json</code>——<b>不必启动桌面版</b>。';
    if (box) {
      box.innerHTML = `
        <div class="k"><span>存档目录</span><b class="small">未绑定（走本地服务 / 导入词表）</b></div>
        <div class="k"><span>后台读写通道</span><b class="small">${esc(bridge)}</b></div>`;
    }
    return;
  }

  let perm = '';
  try { perm = await permQuery(h, 'readwrite'); } catch (e) { perm = 'unknown'; }
  const markCount = await getMarks().then(m => marksSummary(m, null).words).catch(() => 0);
  if (!_pcInfo) { try { _pcInfo = await api.runtime.sendMessage({ type: 'pcInfo' }); } catch (e) { _pcInfo = null; } }
  const pcDir = (_pcInfo && (_pcInfo.storageDir || _pcInfo.root)) || '';
  const pcLeaf = pcDir ? String(pcDir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
  const sameDir = !!(pcLeaf && h && h.name && String(h.name).toLowerCase() === pcLeaf.toLowerCase());
  $('#dirHint').innerHTML = perm === 'granted'
    ? '已直连该目录：无需桌面版即可读词库，标记也会写回。'
    : `目录权限为「${perm}」，点「立即读取」重新授权（浏览器会弹一次确认）。`;
  if (box) {
    box.innerHTML = `
      <div class="k"><span>存档目录</span><b class="small">${esc(h.name)}</b></div>
      <div class="k"><span>与墨读是否同一目录</span><b class="small">${sameDir
        ? '是 ✓（三端共用一份 vocab.json）'
        : (pcDir ? '否 —— 墨读用的是「' + esc(pcLeaf || pcDir) + '」，建议改用「用墨读的目录」' : '无法判断（没连上墨读）')}</b></div>
      <div class="k"><span>读写权限</span><b class="small">${perm === 'granted' ? '已授予（可写回）' : esc(perm || '未知')}</b></div>
      <div class="k"><span>后台读写通道</span><b class="small">${esc(bridge)}</b></div>
      <div class="k"><span>本地词标记</span><b>${markCount}</b></div>
      <div class="k"><span>写回开关</span><b class="small">${settings.link.writeBack === false ? '已关闭' : '开启'}</b></div>`;
  }
}

/** 选目录（必须由点击触发）→ 存句柄 → 读一次 → 把已有标记补写进去 */
async function bindDirNow() {
  const out = $('#impOut');
  try {
    /* 「默认对齐墨读目录」：选择器的起始位置跟着墨读的存档目录走 ——
       在「文档」下（最常见的 文档\InkRead）就用 documents，在桌面/下载则对应跟进。
       浏览器不允许按绝对路径跳转，这是能做到的最大程度的「默认落到同一个目录」。 */
    let startIn = 'documents';
    if (!_pcInfo) { try { _pcInfo = await api.runtime.sendMessage({ type: 'pcInfo' }); } catch (e) { _pcInfo = null; } }
    const pcDir = (_pcInfo && (_pcInfo.storageDir || _pcInfo.root)) || '';
    if (pcDir) {
      if (/桌面|Desktop/i.test(pcDir)) startIn = 'desktop';
      else if (/下载|Downloads/i.test(pcDir)) startIn = 'downloads';
    }
    const dir = await pickDir('readwrite', startIn);
    await setDir(dir);
    dirHandle = dir;
    settings = await saveSettings({ link: { dirName: dir.name } });
    await renderDirState();
    await permRequest(dir, 'readwrite');
    out.hidden = false;
    out.removeAttribute('data-ok');
    out.textContent = `已绑定「${dir.name}」，正在读取 vocab.json …`;
    const got = await doDirSync(false, true);
    if (got !== false) await doPushMarks(true);     /* 把之前在插件里标的词补进共享词库 */
    toast('已绑定存档目录：' + dir.name, 'ok');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    out.hidden = false;
    out.dataset.ok = '0';
    out.textContent = '绑定失败：' + String((e && e.message) || e);
    toast('绑定目录失败', 'err');
  }
}

async function unbindDirNow() {
  await forgetDir();
  dirHandle = null;
  settings = await saveSettings({ link: { dirName: '' } });
  await renderDirState();
  /* 让后台重新按「本地服务 / 导入」决定词库来源 */
  await api.runtime.sendMessage({ type: 'settingsChanged' }).catch(() => { });
  await refreshVocabInfo(true);
  toast('已解除目录绑定', 'ok');
}

/** 让后台从绑定的目录读一次 vocab.json */
async function doDirSync(showToast, keepOut) {
  const out = $('#impOut');
  if (!keepOut) { out.hidden = false; out.removeAttribute('data-ok'); out.textContent = '正在读取存档目录…'; }
  let r = null;
  try { r = await api.runtime.sendMessage({ type: 'dirSync' }); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (r && r.ok) {
    if (!keepOut) { out.dataset.ok = '1'; out.innerHTML = `✓ 已从「${esc(r.name || '存档目录')}」读取 <b>${r.count}</b> 个词。`; }
    await refreshVocabInfo(false);
    await renderDataInfo();
    if (showToast) toast(`已同步 ${r.count} 个词`, 'ok');
    return true;
  }
  out.hidden = false;
  out.dataset.ok = '0';
  out.innerHTML = `读取存档目录失败：${esc((r && r.error) || '未知错误')}<br>`
    + `提示：请选择墨读的<b>存档目录</b>（默认 <code>文档\\InkRead</code>，桌面版与网页版共用），其中应有 <code>vocab.json</code>。`;
  if (showToast) toast('读取失败', 'err');
  return false;
}

/** 把本地的词标记一次性推回共享 vocab.json */
async function doPushMarks(silent) {
  const out = $('#impOut');
  let marks = null;
  try { marks = await getMarks(); } catch (e) { marks = null; }
  const words = (marks && marks.words) || {};
  const n = Object.keys(words).length;
  if (!n) { if (!silent) toast('还没有任何词标记', 'ok'); return; }

  let r = null;
  try { r = await api.runtime.sendMessage({ type: 'dirPushMarks' }); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
  if (r && r.ok) {
    if (!silent) {
      out.hidden = false; out.dataset.ok = '1';
      out.innerHTML = `✓ 已把 <b>${n}</b> 个词标记写回共享词库（新增 ${r.added}，更新 ${r.updated}）。`
        + (r.changed ? '' : '<br>共享词库已与此一致，无需改动。');
      toast('词库已更新', 'ok');
    }
  } else if (!silent) {
    out.hidden = false; out.dataset.ok = '0';
    out.innerHTML = `写回失败：${esc((r && (r.error || r.skipped)) || '未知错误')}`;
    toast('写回失败', 'err');
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

const escAttr = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ================= 左侧悬浮 tab 栏 =================
   点击平滑滚到对应分区；滚动时按「分区顶部是否越过阈值」高亮当前 tab。
   滚到页面最底时直接高亮最后一个 —— 最后一个分区下方往往不足一屏，永远到不了阈值。 */
let _tabOff = null;
function bindSettingTabs() {
  const tabs = $$('.settings-tabs button');
  if (!tabs.length) return;
  tabs.forEach(b => b.addEventListener('click', () => {
    const sec = document.querySelector(`.settings-body [data-sec="${b.dataset.tab}"]`);
    if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  const sync = () => {
    const secs = $$('.settings-body .settings-section');
    if (!secs.length) return;
    let cur = 0;
    const doc = document.documentElement;
    const atBottom = (window.scrollY || doc.scrollTop || 0) + window.innerHeight >= doc.scrollHeight - 4;
    if (atBottom) cur = secs.length - 1;
    else secs.forEach((sec, i) => { if (sec.getBoundingClientRect().top <= 140) cur = i; });
    tabs.forEach((b, i) => b.classList.toggle('active', i === cur));
  };
  if (_tabOff) { window.removeEventListener('scroll', _tabOff); window.removeEventListener('resize', _tabOff); }
  let tm = 0;
  _tabOff = () => { clearTimeout(tm); tm = setTimeout(sync, 120); };
  window.addEventListener('scroll', _tabOff, { passive: true });
  window.addEventListener('resize', _tabOff, { passive: true });
  sync();
}

/* ================= 关于 ================= */
function renderAbout() {
  const m = api.runtime.getManifest();
  $('#abVer').textContent = 'v' + m.version;
  const ua = navigator.userAgent || '';
  const hit = ua.match(/(Edg|EdgA|Chrome|Firefox)\/([\d.]+)/);
  $('#abUa').textContent = hit ? `${hit[1]} ${String(hit[2]).split('.')[0]}` : '未知浏览器';
}

/* ================= 翻译接口 ================= */
/* 每个引擎要填哪些字段（id → [[字段, 中文标签], …]）；形状与墨读网页版 IR.settings.data.api 完全一致 */
const API_FIELDS = [
  ['youdao', [['key', '应用 ID'], ['apiKeys', 'API Keys'], ['secret', '应用密钥']]],
  ['tencent', [['secretId', 'SecretId'], ['secretKey', 'SecretKey'], ['region', '地域（默认 ap-guangzhou）']]],
  ['aliyun', [['apiKey', '百炼 API Key'], ['model', '模型（留空 = qwen-plus）']]],
  ['alimt', [['accessKeyId', 'AccessKeyId'], ['accessKeySecret', 'AccessKeySecret'], ['edition', '版本（general）'], ['scene', '场景（social）']]],
  ['volcano', [['apiKey', '方舟 API Key'], ['model', '模型（留空 = doubao-seed-translation）']]],
  ['volmt3', [['apiKey', 'openspeech API Key'], ['resourceId', '资源 ID（volc.speech.mt）']]],
  ['volmt', [['accessKeyId', 'AccessKeyId'], ['accessKeySecret', 'AccessKeySecret']]],
  ['deepl', [['apiKey', 'API Key']]],
  ['ms', [['apiKey', 'API Key'], ['region', 'Region']]],
  ['libre', [['url', '实例地址'], ['apiKey', 'API Key（可空）']]]
];
const engineName = id => ENGINE_LABELS[id] || id;

let _pcInfo = null;

function bindTranslate() {
  const save = async (patch, msgText) => {
    settings = await saveSettings(patch);
    renderTrEngineHint();
    if (msgText) toast(msgText, 'ok');
  };
  $('#trEnabled').addEventListener('change', e => save({ translate: { enabled: e.target.checked } }, '在线翻译已' + (e.target.checked ? '开启' : '关闭')));
  $('#trViaLocal').addEventListener('change', e => save({ translate: { viaLocal: e.target.checked } }));
  $('#trPara').addEventListener('change', e => save({ translate: { paraTrans: e.target.checked } }, '段落翻译已' + (e.target.checked ? '开启' : '关闭')));
  $('#trPhrase').addEventListener('change', e => save({ translate: { phraseAuto: e.target.checked } }));
  $('#phEnabled').addEventListener('change', e => save({ phrases: { enabled: e.target.checked } }, '词组库已' + (e.target.checked ? '开启' : '关闭')));
  $('#phUnderline').addEventListener('change', e => save({ phrases: { underline: e.target.checked } }));
  $('#trEngine').addEventListener('change', e => save({ api: { engine: e.target.value } }, '翻译引擎已切换'));
  $('#btnImportApi').addEventListener('click', importApiFromPc);
  $('#btnTrTest').addEventListener('click', testTranslate);
  $('#btnOpenPcDir').addEventListener('click', openPcDir);
}

function renderTranslate() {
  const s = settings;
  $('#trEnabled').checked = s.translate.enabled !== false;
  $('#trViaLocal').checked = s.translate.viaLocal !== false;
  $('#trPara').checked = s.translate.paraTrans !== false;
  $('#trPhrase').checked = s.translate.phraseAuto !== false;
  $('#phEnabled').checked = s.phrases.enabled !== false;
  $('#phUnderline').checked = s.phrases.underline !== false;
  $('#trEngine').innerHTML = ['<option value="auto">自动（按顺序挑已配置的引擎）</option>']
    .concat(ENGINES.map(id => `<option value="${id}">${engineName(id)}</option>`)).join('');
  $('#trEngine').value = s.api.engine || 'auto';
  renderKeyGrid();
  renderTrEngineHint();
}

function renderKeyGrid() {
  const api = settings.api || {};
  $('#trKeys').innerHTML = API_FIELDS.map(([id, fields]) =>
    `<div class="kg-h">${engineName(id)}</div>` + fields.map(([k, label]) =>
      `<label>${label}</label><input data-api="${id}.${k}" type="text" spellcheck="false" value="${escAttr((api[id] || {})[k] || '')}">`
    ).join('')
  ).join('');
  $$('#trKeys input').forEach(inp => {
    inp.addEventListener('change', async () => {
      const [id, k] = inp.dataset.api.split('.');
      settings = await saveSettings({ api: { [id]: { [k]: inp.value.trim() } } });
      renderTrEngineHint();
      toast('已保存：' + engineName(id), 'ok');
    });
  });
}

function renderTrEngineHint() {
  const api = settings.api || {};
  const conf = engineConfigured(api);
  const configured = ENGINES.filter(id => conf[id]);
  const cur = api.engine || 'auto';
  const proxy = !!(_pcInfo && _pcInfo.ok);
  $('#trEngineHint').innerHTML =
    `已配置：<b>${configured.map(engineName).join(' / ') || '（无，只能用免费引擎）'}</b>`
    + `　·　转发通道：<b>${proxy ? '墨读本地服务' : '未连接（付费引擎可能被 CORS 拦）'}</b>`
    + (cur === 'auto' ? '' : `　·　当前锁定：<b>${engineName(cur)}</b>`);
}

async function renderTranslatePc() {
  const box = $('#trPc'), body = $('#trPcBody'), btn = $('#btnImportApi');
  body.textContent = '正在检测墨读本地服务…';
  let r = null;
  try { r = await api.runtime.sendMessage({ type: 'pcInfo' }); } catch (e) { r = null; }
  _pcInfo = r || null;
  if (!r || !r.ok) {
    box.dataset.ok = '0';
    body.innerHTML = '没探测到「墨读」本地服务。免费引擎（Google / MyMemory / 必应）仍可用，'
      + '但付费引擎的 Key 需要先在墨读里配好才能导入。<br><span class="hint">'
      + esc((r && r.message) || '后台未响应') + '</span>';
    btn.disabled = true;
  } else {
    box.dataset.ok = '1';
    body.innerHTML = `✓ 已连接墨读：<code>${esc(r.base)}</code><br>`
      + `存档目录：<code>${esc(r.storageDir || r.root || '（墨读默认目录）')}</code><br>`
      + (r.hasApi ? '检测到翻译接口配置，可直接导入。' : '墨读里还没配翻译接口（先去墨读设置页填 Key 再回来导入）。')
      + (r.err ? `<br><span class="hint">${esc(r.err)}</span>` : '');
    btn.disabled = !r.hasApi;
  }
  renderTrEngineHint();
}

async function importApiFromPc() {
  const btn = $('#btnImportApi');
  btn.disabled = true;
  try {
    const r = await api.runtime.sendMessage({ type: 'pcImportApi' });
    if (!r || !r.ok) { toast((r && (r.message || r.error)) || '导入失败', 'err'); return; }
    settings = await getSettings();
    renderTranslate();
    toast('已导入墨读的翻译接口配置', 'ok');
  } catch (e) {
    toast('导入失败：' + String(e && e.message || e), 'err');
  } finally {
    btn.disabled = false;
  }
}

async function testTranslate() {
  const out = $('#trTestOut'), btn = $('#btnTrTest');
  btn.disabled = true;
  out.textContent = '翻译中…';
  try {
    const r = await api.runtime.sendMessage({ type: 'translate', q: 'hello' });
    if (r && r.ok) out.innerHTML = `✓ <b>${esc(r.engine)}</b> → ${esc(r.text)}`;
    else out.textContent = '✗ ' + ((r && (r.message || r.error)) || '后台未响应');
  } catch (e) {
    out.textContent = '✗ ' + String(e && e.message || e);
  } finally {
    btn.disabled = false;
  }
}
