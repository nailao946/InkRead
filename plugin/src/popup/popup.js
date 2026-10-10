/* InkRead Video — 扩展弹出面板 */
import { api } from '../shared/api.js';
import { getSettings } from '../shared/store.js';

const $ = s => document.querySelector(s);
const TONE = { 1: '#2e9e6b', 2: '#3b82f6', 3: '#d98a19', 4: '#d64545' };
const STATUS_TXT = { known: '已学', learning: '在学', new: '生词本', unknown: '生词' };
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let settings = null;
let last = null;

document.addEventListener('DOMContentLoaded', async () => {
  settings = await getSettings();
  $('#btnOptions').addEventListener('click', () => api.runtime.openOptionsPage());
  $('#btnSync').addEventListener('click', syncVocab);
  $('#btnReload').addEventListener('click', () => run(true));
  $('#btnPanel').addEventListener('click', openPagePanel);
  await syncVocab();
  await run(false);
});

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

  /* 先自查当前标签页：不是视频页就直接给友好空状态，不必惊动后台 */
  let r;
  try {
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    const url = (tabs && tabs[0] && tabs[0].url) || '';
    if (!/(bilibili\.com\/(video|bangumi\/play))|(youtube\.com\/(watch|shorts))/.test(url)) {
      $('#btnReload').disabled = false;
      last = { error: 'unsupported' };
      render(last);
      return;
    }
    r = await api.runtime.sendMessage({ type: 'analyzeActive', force: !!force });
  } catch (e) {
    r = { error: 'analyze-failed', message: String(e && e.message || e) };
  }
  $('#btnReload').disabled = false;
  last = r;
  render(r);
}

/* ---------- 渲染 ---------- */
function skeleton() {
  return `<div class="skel"><div class="skel-ring"></div><div class="skel-lines"><i></i><i></i><i></i></div></div>`;
}

function render(r) {
  if (!r) { $('#main').innerHTML = emptyState('分析结果为空', '请点击「重新分析」再试一次。'); return; }

  if (r.error === 'unsupported') {
    $('#main').innerHTML = emptyState('当前不是视频页', '打开一个视频页面后点击扩展图标，即可看到它的生词量分析。', [
      '哔哩哔哩：bilibili.com/video/…（或番剧 /bangumi/play/…）',
      'YouTube：youtube.com/watch?v=…（含 Shorts）'
    ]);
    $('#btnPanel').disabled = true;
    return;
  }
  if (r.error) {
    $('#main').innerHTML = emptyState('分析失败', esc(r.message || '未知错误'), ['确认页面已完全加载后重试']);
    return;
  }
  $('#btnPanel').disabled = false;

  const tone = TONE[r.level] || '#6b7280';
  const vcard = `
    <div class="vcard">
      <div style="flex:1;min-width:0">
        <div class="vc-site">${esc(r.siteLabel || '视频')}</div>
        <div class="vc-t">${esc(r.title || '(无标题)')}</div>
        <div class="vc-sub">${esc(subLine(r))}</div>
      </div>
    </div>`;

  if (!r.tokens) {
    $('#main').innerHTML = vcard + `
      <div class="note"><b>无法评估这个词视频</b><br>${esc((r.subtitle && r.subtitle.reason) || '没有取到可分析的文本')}</div>
      ${(r.subtitle && r.subtitle.tracks && r.subtitle.tracks.length) ? `<div class="sec" style="margin-top:12px"><div class="sec-h"><span>该视频现有字幕轨</span></div><div class="chips">${r.subtitle.tracks.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div></div>` : ''}`;
    return;
  }

  const pct = Math.round(r.coverage * 1000) / 10;
  const f = r.freq || { bandTok: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, level: 0, text: '—', tier: '' };
  const top = (r.topUnknown || []).slice(0, 16);

  $('#main').innerHTML = `
    ${vcard}
    <div class="hero">
      <div class="ring">
        ${ringSvg(r.coverage, tone)}
        <div class="mid"><div class="num">${pct}<i>%</i></div><div class="cap">可理解度</div></div>
      </div>
      <div class="hero-main">
        <span class="lvl" style="--tone:${tone}">L${r.level} · ${esc(r.levelText)}</span>
        <div class="tier">${esc(r.tier)}${r.wordsPerNew ? ` · 每 ${r.wordsPerNew} 词遇 1 生词` : ''}</div>
        <div class="verd ${r.verdict.ok ? 'ok' : 'no'}">${r.verdict.ok ? '✓ ' : '✕ '}${esc(r.verdict.title)}</div>
        <div class="vd">${esc(r.verdict.detail)}</div>
      </div>
    </div>

    <div class="grid">
      <div class="cell"><b>${r.tokens}</b><span>总词次</span></div>
      <div class="cell"><b>${r.unique}</b><span>独立词</span></div>
      <div class="cell"><b>${r.missTok}</b><span>生词词次</span></div>
      <div class="cell"><b>${r.density}</b><span>生词/百词</span></div>
    </div>

    <div class="sec">
      <div class="sec-h"><span>视频客观难度（脱离你的词库）</span><b>L${f.level} ${esc(f.text)}${f.tier ? ' · ' + esc(f.tier) : ''}</b></div>
      ${bandBar(f)}
    </div>

    <div class="sec">
      <div class="sec-h"><span>高频生词（先攻这些收益最大）</span><b>${top.length ? 'Top ' + top.length : ''}</b></div>
      ${top.length
      ? `<div class="chips">${top.map(t => `<span class="chip" data-s="${esc(t.s)}" title="${esc(STATUS_TXT[t.s] || t.s)}${t.bandName ? ' · ' + esc(t.bandName) + '词' : ''}"><b>${esc(t.w)}</b><em>×${t.c}</em></span>`).join('')}</div>`
      : `<div class="vd">没有生词——这个词视频对你几乎没有词汇门槛。</div>`}
    </div>

    ${r.lowSample ? `<div class="note">样本偏小（仅 ${r.tokens} 词），结果仅供参考。</div>` : ''}
    ${r.subtitle && r.subtitle.fallback ? `<div class="note">该视频没有字幕，以下结果基于<b>标题与简介</b>估算，样本很小、仅供粗略参考。</div>` : ''}`;
}

function subLine(r) {
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
  try { await api.tabs.sendMessage(t.id, { type: 'showPanel', report: last, open: true }); window.close(); }
  catch (e) { /* 内容脚本可能未注入 */ }
}
