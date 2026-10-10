/* InkRead 墨读 — 扩展弹出面板 */
import { api } from '../shared/api.js';
import { getSettings, saveSettings } from '../shared/store.js';

const $ = s => document.querySelector(s);
const TONE = { 1: '#2e9e6b', 2: '#3b82f6', 3: '#d98a19', 4: '#d64545' };
const TONE_BY_NAME = { ok: '#2e9e6b', good: '#3b82f6', warn: '#d98a19', bad: '#d64545' };
const RATING_ITEMS = [['step', 'L1–L4'], ['cefr', 'CEFR'], ['lexile', '蓝思']];
const STATUS_TXT = { known: '已学', learning: '在学', new: '生词本', unknown: '生词' };
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const VIDEO_RE = /(bilibili\.com\/(video|bangumi\/play))|(youtube\.com\/(watch|shorts))/;

let settings = null;
let last = null;          /* 当前展示的报告（视频或文章） */
let isArticle = false;    /* 当前页是文章模式 */

document.addEventListener('DOMContentLoaded', async () => {
  settings = await getSettings();
  $('#btnOptions').addEventListener('click', () => api.runtime.openOptionsPage());
  $('#btnSync').addEventListener('click', syncVocab);
  $('#btnReload').addEventListener('click', () => run(true));
  $('#btnPanel').addEventListener('click', openPagePanel);
  $('#btnReader').addEventListener('click', openReader);
  await syncVocab();
  await run(false);
});

/* 当前评级体系下的那套结果 */
function ratingOf(r) {
  const rs = (r && r.ratings) || {};
  return rs[(settings && settings.rating && settings.rating.system) || 'step'] || rs.step ||
    { code: 'L' + (r && r.level), text: (r && r.levelText) || '', tier: (r && r.tier) || '', tone: null, desc: '' };
}
function toneColor(r) {
  const sys = (settings && settings.rating && settings.rating.system) || 'step';
  const rating = ratingOf(r);
  if (sys !== 'step' && TONE_BY_NAME[rating.tone]) return TONE_BY_NAME[rating.tone];
  return TONE[r && r.level] || '#6b7280';
}
function allRatingsHtml(r) {
  const x = (r && r.ratings) || {};
  const out = [];
  if (x.step) out.push(`阶梯 <b>${x.step.code}</b>`);
  if (x.cefr) out.push(`CEFR <b>${x.cefr.code}</b>`);
  if (x.lexile) out.push(`蓝思 <b>${x.lexile.code}</b>`);
  return out.join(' · ') || '—';
}
function switcherHtml() {
  const cur = (settings.rating && settings.rating.system) || 'step';
  return `<div class="sw">${RATING_ITEMS.map(([id, label]) =>
    `<button data-rate="${id}" data-on="${cur === id ? 1 : 0}">${label}</button>`).join('')}</div>`;
}
function bindSwitcher(scope) {
  (scope || document).querySelectorAll('[data-rate]').forEach(b =>
    b.addEventListener('click', () => setRating(b.dataset.rate)));
}
async function setRating(id) {
  settings = await saveSettings({ rating: { system: id } });
  render(last);
}

/* 给标签页发消息；若内容脚本已被孤立（扩展更新/重载后旧脚本失效，sendMessage 抛
   「Receiving end does not exist」）→ 就地从新上下文重注入一次再重试。
   这正是「悬浮窗报通信失败、但点开插件又能评估」的修法：弹窗拥有 scripting + activeTab。 */
async function sendToTab(tabId, kind, msg) {
  try {
    return await api.tabs.sendMessage(tabId, msg);
  } catch (e) {
    const file = kind === 'video' ? 'src/content/content.js' : 'src/content/article.js';
    if (api.scripting && api.scripting.executeScript) {
      try { await api.scripting.executeScript({ target: { tabId }, files: [file] }); } catch (e2) { /* 无主机权限 */ }
    }
    await new Promise(r => setTimeout(r, 150));
    return await api.tabs.sendMessage(tabId, msg);   /* 仍失败则照常抛出，由调用方兜底 */
  }
}

async function openReader() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  const t = tabs && tabs[0];
  if (!t) return;
  try { await sendToTab(t.id, 'article', { type: 'openReader', force: true }); window.close(); }
  catch (e) { /* 内容脚本不在（例如受限页面） */ }
}

async function syncVocab(force) {
  const btn = $('#btnSync');
  btn.disabled = true;
  try {
    const v = await api.runtime.sendMessage({ type: 'vocabStatus', force: !!force });
    renderLink(v);
  } catch (e) {
    renderLink({ ok: false, error: '后台未响应' });
  } finally { btn.disabled = false; }
}

function renderLink(v) {
  const bar = $('#linkBar');
  const ok = !!(v && v.ok && v.count);
  bar.setAttribute('data-ok', ok ? '1' : '0');
  let txt;
  if (!v) txt = '无法获取词库状态';
  else if (v.mode === 'off') txt = '联动已关闭（按空词库分析）';
  else if (ok) txt = `${v.label || '墨读词库'} · ${v.count} 词`;
  else if (v.count) txt = `${v.label || '导入词表'} · ${v.count} 词（离线）`;
  else txt = v.error || '未联动词库';
  $('#linkText').textContent = txt;

  if (v && v.summary && v.count) {
    $('#footNote').textContent = `已学 ${v.summary.known} · 在学 ${v.summary.learning} · 生词本 ${v.summary.new}`;
  } else {
    $('#footNote').textContent = ok ? '' : '去「设置」联动词库';
  }
}

async function run(force) {
  $('#main').innerHTML = skeleton();
  $('#btnReload').disabled = true;
  $('#btnReader').hidden = true;

  let tabs = [];
  try { tabs = await api.tabs.query({ active: true, currentWindow: true }); } catch (e) { /* 忽略 */ }
  const tab = tabs && tabs[0];
  const url = (tab && tab.url) || '';

  let r;
  if (VIDEO_RE.test(url)) {
    /* ---- 视频页：走后台的播放器/字幕管线 ---- */
    isArticle = false;
    try { r = await api.runtime.sendMessage({ type: 'analyzeActive', force: !!force }); }
    catch (e) { r = { error: 'analyze-failed', message: String(e && e.message || e) }; }
    /* 顺手把页面上的悬浮窗也救回来：扩展更新后旧内容脚本会被孤立，
       sendToTab 检测到收不到就重注入（弹窗有 scripting + activeTab）。 */
    if (tab && tab.id != null) {
      try { await sendToTab(tab.id, 'video', { type: 'refresh' }); } catch (e) { /* 忽略 */ }
    }
  } else {
    /* ---- 其它页：交给页面的文章内容脚本抽正文 ---- */
    isArticle = true;
    const res = await runArticle(tab, force);
    if (res && res.ok && res.report) { r = res.report; $('#btnReader').hidden = false; }
    else r = { error: 'unsupported-article', message: (res && res.reason) || '未能抽取正文' };
  }

  $('#btnReload').disabled = false;
  last = r;
  render(r);
}

async function runArticle(tab, force) {
  if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) {
    return { ok: false, reason: '当前页面不可读取（请在普通网页上使用）' };
  }
  try {
    const res = await sendToTab(tab.id, 'article', { type: 'articleSummary', force: !!force });
    return res || { ok: false, reason: '页面没有响应' };
  } catch (e) {
    return { ok: false, reason: '这个页面上没有找到可分析的正文' };
  }
}

/* ---------- 渲染 ---------- */
function skeleton() {
  return `<div class="skel"><div class="skel-ring"></div><div class="skel-lines"><i></i><i></i><i></i></div></div>`;
}

function render(r) {
  if (!r) { $('#main').innerHTML = emptyState('分析结果为空', '请点击「重新分析」再试一次。'); return; }
  $('#btnPanel').disabled = !!r.error;

  if (r.error === 'unsupported') {
    $('#main').innerHTML = emptyState('当前不是视频页', '打开一个视频页面后点击扩展图标，即可看到它的生词量分析。', [
      '哔哩哔哩：bilibili.com/video/…（或番剧 /bangumi/play/…）',
      'YouTube：youtube.com/watch?v=…（含 Shorts）'
    ]);
    return;
  }
  if (r.error === 'unsupported-article') {
    $('#main').innerHTML = articleEmptyState(r.message);
    return;
  }
  if (r.error) {
    $('#main').innerHTML = emptyState('分析失败', esc(r.message || '未知错误'), ['确认页面已完全加载后重试']);
    return;
  }

  const tone = toneColor(r);
  const rating = ratingOf(r);
  const isStep = ((settings.rating && settings.rating.system) || 'step') === 'step';
  const kindLabel = r.kind === 'article' ? '文章' : '视频';

  const vcard = `
    <div class="vcard">
      <div style="flex:1;min-width:0">
        <div class="vc-site">${esc(r.siteLabel || kindLabel)}</div>
        <div class="vc-t">${esc(r.title || '(无标题)')}</div>
        <div class="vc-sub">${esc(subLine(r))}</div>
      </div>
    </div>`;

  if (!r.tokens) {
    $('#main').innerHTML = vcard + `
      <div class="note"><b>无法评估这个${kindLabel}</b><br>${esc((r.subtitle && r.subtitle.reason) || '没有取到可分析的文本')}</div>
      ${(r.subtitle && r.subtitle.tracks && r.subtitle.tracks.length) ? `<div class="sec" style="margin-top:12px"><div class="sec-h"><span>现有字幕轨</span></div><div class="chips">${r.subtitle.tracks.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div></div>` : ''}`;
    return;
  }

  const pct = Math.round(r.coverage * 1000) / 10;
  const f = r.freq || { bandTok: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, level: 0, text: '—', tier: '' };
  const top = (r.topUnknown || []).slice(0, 16);

  $('#main').innerHTML = `
    ${vcard}
    ${switcherHtml()}
    <div class="hero">
      <div class="ring">
        ${ringSvg(r.coverage, tone)}
        <div class="mid"><div class="num">${pct}<i>%</i></div><div class="cap">可理解度</div></div>
      </div>
      <div class="hero-main">
        <span class="lvl" style="--tone:${tone}">${esc(rating.code)} · ${esc(rating.text || r.levelText)}</span>
        <div class="tier">${esc(rating.tier || r.tier)}${r.wordsPerNew ? ` · 每 ${r.wordsPerNew} 词遇 1 生词` : ''}</div>
        ${isStep
          ? `<div class="verd ${r.verdict.ok ? 'ok' : 'no'}">${r.verdict.ok ? '✓ ' : '✕ '}${esc(r.verdict.title)}</div>
             <div class="vd">${esc(r.verdict.detail)}</div>`
          : `<div class="vd" style="margin-top:6px">${esc(rating.desc || '')}</div>`}
        <div class="allrate">三套体系：${allRatingsHtml(r)}</div>
      </div>
    </div>

    <div class="grid">
      <div class="cell"><b>${r.tokens}</b><span>总词次</span></div>
      <div class="cell"><b>${r.unique}</b><span>独立词</span></div>
      <div class="cell"><b>${r.missTok}</b><span>生词词次</span></div>
      <div class="cell"><b>${r.density}</b><span>生词/百词</span></div>
    </div>

    <div class="sec">
      <div class="sec-h"><span>客观难度（脱离你的词库）</span><b>${allRatingsHtml(r)}</b></div>
      ${bandBar(f)}
    </div>

    <div class="sec">
      <div class="sec-h"><span>高频生词（先攻这些收益最大）</span><b>${top.length ? 'Top ' + top.length : ''}</b></div>
      ${top.length
      ? `<div class="chips">${top.map(t => `<span class="chip" data-s="${esc(t.s)}" title="${esc(STATUS_TXT[t.s] || t.s)}${t.bandName ? ' · ' + esc(t.bandName) + '词' : ''}"><b>${esc(t.w)}</b><em>×${t.c}</em></span>`).join('')}</div>`
      : `<div class="vd">没有生词——这个${kindLabel}对你几乎没有词汇门槛。</div>`}
    </div>

    ${isArticle ? `<div class="note">正文已按你的词库<b>直接上色</b>（点词看释义、可标记）；想看逐词大纲点底部<b>「阅读模式」</b>。</div>` : ''}
    ${r.lowSample ? `<div class="note">样本偏小（仅 ${r.tokens} 词），结果仅供参考。</div>` : ''}
    ${r.subtitle && r.subtitle.fallback ? `<div class="note">该视频没有字幕，以下结果基于<b>标题与简介</b>估算，样本很小、仅供粗略参考。</div>` : ''}`;

  bindSwitcher($('#main'));
}

function articleEmptyState(reason) {
  return `<div class="empty">
    <div class="ic">📄</div>
    <h3>这个页面没有可分析的文章</h3>
    <p>${esc(reason || '正文太短或不是英文材料')}</p>
    <ul class="tips">
      <li>文章正文至少需要 200 个英文词</li>
      <li>页面以中文为主时不做英文生词分析</li>
      <li>视频页请用哔哩哔哩 / YouTube</li>
    </ul>
  </div>`;
}

function subLine(r) {
  if (r.kind === 'article') {
    const q = r.quality || {};
    return `网页正文 · ${q.paras || 0} 段 · ${q.words || r.tokens} 词`;
  }
  const s = r.subtitle || {};
  if (s.ok && s.label) return '字幕：' + s.label + (s.asr ? '（自动生成）' : '');
  if (s.fallback) return '无字幕 · 基于标题/简介估算';
  return s.reason || '无字幕';
}

function ringSvg(cov, tone) {
  const R = 40, C = 2 * Math.PI * R;
  const off = C * (1 - Math.max(0, Math.min(1, cov)));
  return `<svg width="96" height="96" viewBox="0 0 96 96">
    <circle class="bg" cx="48" cy="48" r="${R}" fill="none" stroke-width="8"></circle>
    <circle class="fg" cx="48" cy="48" r="${R}" fill="none" stroke-width="8" style="stroke:${tone}"
      stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"></circle></svg>`;
}

function bandBar(f) {
  const t = f.bandTok, sum = Math.max(1, t[1] + t[2] + t[3] + t[4] + t[5]);
  const pc = n => (n / sum * 100).toFixed(2) + '%';
  const names = { 1: '核心 1000', 2: '常用 2500', 3: '进阶 5000', 4: '高阶 5000+', 5: '生僻/专名' };
  const colors = { 1: '#2e9e6b', 2: '#4a9be8', 3: '#d98a19', 4: '#d97757', 5: '#8b5cf6' };
  return `<div class="bar">${[1, 2, 3, 4, 5].map(b => `<i class="b${b}" style="width:${pc(t[b])}"></i>`).join('')}</div>
    <div class="legend">${[1, 2, 3, 4, 5].map(b => `<span><em style="background:${colors[b]}"></em>${names[b]} ${Math.round(t[b] / sum * 100)}%</span>`).join('')}</div>`;
}

function emptyState(title, text, tips) {
  return `<div class="empty">
    <div class="ic">📺</div>
    <h3>${esc(title)}</h3>
    <p>${text}</p>
    ${tips && tips.length ? `<ul class="tips">${tips.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

async function openPagePanel() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  const t = tabs && tabs[0];
  if (!t) return;
  try { await sendToTab(t.id, isArticle ? 'article' : 'video', { type: 'showPanel', report: last, open: true }); window.close(); }
  catch (e) { /* 内容脚本可能未注入 */ }
}
