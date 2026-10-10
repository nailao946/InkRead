#!/usr/bin/env node
/* InkRead Video — 集成测试（Node 下跑，不需要浏览器）
 *
 *   A. 两份 manifest 的字段与资源引用是否都真实存在
 *   B. 源码 import 依赖图是否闭合（没有指向不存在的文件）
 *   C. popup / options HTML 引用的 css/js 是否存在
 *   D. 端到端分析管线：真实形状的 YouTube json3 字幕 + 墨读词表 → 报告 → i+1 判定
 *   E. store 的纯函数（跨端词表映射、缓存新鲜度）
 *
 *   node plugin/tests/test-integration.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFreq } from '../src/shared/freq.js';
import { buildStatusMap, analyze, vocabSummary } from '../src/shared/analyze.js';
import { detectSite, parseSubtitle, pickYoutubeTrack, ytJson3Url, pickBilibiliTrack } from '../src/shared/subs.js';
import { vocabToMap, isFresh } from '../src/shared/store.js';
import { makeZip, walkFiles, readZipEntries } from '../tools/zip.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0; const fails = [];
const check = (name, cond, extra) => { if (cond) pass++; else { fail++; fails.push(name + (extra ? '  → ' + extra : '')); } };

/* ================= A. manifest 校验 ================= */
const CHROME_HOSTS = ['*://*.bilibili.com/*', '*://*.hdslb.com/*', '*://*.youtube.com/*', 'http://127.0.0.1/*'];

for (const mf of ['manifest.json', 'manifest.firefox.json']) {
  const p = resolve(ROOT, mf);
  check(`${mf}：存在`, existsSync(p));
  if (!existsSync(p)) continue;
  let m; try { m = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { check(`${mf}：JSON 合法`, false, e.message); continue; }
  check(`${mf}：JSON 合法`, true);
  check(`${mf}：manifest_version=3`, m.manifest_version === 3);
  check(`${mf}：有 name / version / description`, !!m.name && !!m.version && !!m.description);
  check(`${mf}：声明 storage+scripting+activeTab`, ['storage', 'scripting', 'activeTab'].every(x => (m.permissions || []).includes(x)));
  check(`${mf}：不申请 tabs（避免「读取浏览历史」警告）`, !(m.permissions || []).includes('tabs'));
  check(`${mf}：host_permissions 覆盖三端`, CHROME_HOSTS.every(h => (m.host_permissions || []).includes(h)));

  const bg = m.background || {};
  const bgFile = bg.service_worker || (bg.scripts && bg.scripts[0]);
  check(`${mf}：background 指向存在的脚本`, !!bgFile && existsSync(resolve(ROOT, bgFile)), bgFile);
  check(`${mf}：background 为 ESM（源码用了 import）`, bg.type === 'module');
  if (mf.includes('firefox')) check('firefox：用 event page（scripts）而非 service_worker', Array.isArray(bg.scripts) && !!m.browser_specific_settings?.gecko?.id);
  else check('chrome：用 service_worker', typeof bg.service_worker === 'string');

  check(`${mf}：action.default_popup 存在`, !!m.action && existsSync(resolve(ROOT, m.action.default_popup)));
  const opt = m.options_page || (m.options_ui && m.options_ui.page);
  check(`${mf}：options 页存在`, !!opt && existsSync(resolve(ROOT, opt)), opt);
  for (const k of ['16', '32', '48', '128']) check(`${mf}：icon${k} 存在`, existsSync(resolve(ROOT, m.icons[k])), m.icons[k]);
  for (const cs of m.content_scripts || []) {
    for (const js of cs.js || []) check(`${mf}：内容脚本存在 ${js}`, existsSync(resolve(ROOT, js)));
    check(`${mf}：内容脚本匹配 bilibili+youtube`, (cs.matches || []).some(x => x.includes('bilibili')) && (cs.matches || []).some(x => x.includes('youtube')));
  }
}

/* ================= B. import 依赖图 ================= */
function walk(abs, out = []) {
  for (const n of readdirSync(abs)) {
    const p = join(abs, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
for (const f of walk(resolve(ROOT, 'src'))) {
  const src = readFileSync(f, 'utf8');
  const re = /(?:^|\s)(?:import|export)[^'"\n]*from\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const target = resolve(dirname(f), m[1]);
    check(`import 可解析：${posix.relative(ROOT, f)} → ${m[1]}`, existsSync(target), target);
  }
}
/* 内容脚本是经典脚本，不允许出现 import（MV3 内容脚本不支持 ESM） */
{
  const c = readFileSync(resolve(ROOT, 'src/content/content.js'), 'utf8');
  check('content.js 不含 import（内容脚本不能是 ESM）', !/^\s*import\s/m.test(c));
}

/* ================= C. HTML 资源引用 ================= */
for (const rel of ['src/popup/popup.html', 'src/options/options.html']) {
  const html = readFileSync(resolve(ROOT, rel), 'utf8');
  const base = dirname(resolve(ROOT, rel));
  const refs = [...html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)].map(m => m[1]).filter(u => !/^(https?:|data:|#)/.test(u));
  check(`${rel}：引用资源数量 > 0`, refs.length > 0);
  for (const u of refs) check(`${rel}：资源存在 ${u}`, existsSync(resolve(base, u)), u);
  check(`${rel}：无内联 <script> 逻辑（走外部文件）`, !/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html));
}

/* ================= D. 端到端分析管线 ================= */
const freq = parseFreq(readFileSync(resolve(ROOT, 'data/freq-bands.json'), 'utf8'));

/* 模拟一份真实形状的 YouTube json3 字幕（含自动生成轨） */
const ytInfo = {
  title: 'How I Learned English in 6 Months',
  captions: [
    { baseUrl: 'https://www.youtube.com/api/timedtext?v=X&lang=zh&name=%E4%B8%AD%E6%96%87', languageCode: 'zh-Hans', kind: '', vssId: '.zh' },
    { baseUrl: 'https://www.youtube.com/api/timedtext?v=X&lang=en&kind=asr', languageCode: 'en', kind: 'asr', vssId: 'a.en' }
  ]
};
{
  const site = detectSite('https://www.youtube.com/watch?v=abc123DEF45');
  check('管线：识别 YouTube 视频', site && site.site === 'youtube');

  const track = pickYoutubeTrack(ytInfo.captions, true);
  check('管线：挑中英文字幕轨', track.languageCode === 'en');
  check('管线：自动补 fmt=json3', /fmt=json3/.test(ytJson3Url(track.baseUrl)));

  const subtitleText = [
    'So today I want to talk about how I actually learned English.',
    'The biggest mistake people make is trying to memorise long vocabulary lists.',
    'Instead, you should read and listen to things you genuinely enjoy.',
    'Comprehensible input means the material should be just slightly above your level.',
    'That is why I recommend stories and conversations rather than textbooks.'
  ].join('\n');
  check('管线：字幕解析出文本', subtitleText.length > 100);

  /* 模拟墨读词库：高频词设为已学，少数进阶词设生词 */
  const learned = 'so today i want to talk about how actually learned english the biggest mistake people make is trying memorise long vocabulary lists instead you should read and listen things genuinely enjoy means material slightly above your level that why recommend stories conversations rather than textbooks'.split(' ');
  const entries = learned.map(w => ({ word: w, status: 'known' }));
  entries.push({ word: 'comprehensible', status: 'new' }, { word: 'input', status: 'learning' });
  const statusMap = buildStatusMap(entries);
  check('管线：词库映射构建', statusMap.size >= 40);
  check('管线：vocabSummary 合计一致', vocabSummary(statusMap).total === statusMap.size);

  const report = analyze(subtitleText, statusMap, freq, { maxTop: 24 });
  check('管线：总词次 > 50', report.tokens > 50, 'tokens=' + report.tokens);
  check('管线：覆盖率在 0..1', report.coverage >= 0 && report.coverage <= 1);
  check('管线：等级 1..4', report.level >= 1 && report.level <= 4);
  check('管线：i+1 判定存在', !!report.verdict && typeof report.verdict.ok === 'boolean');
  check('管线：词频分层就绪', report.freq && report.freq.ready === true);
  check('管线：分层词次守恒', [1, 2, 3, 4, 5].reduce((s, b) => s + report.freq.bandTok[b], 0) === report.tokens);
  check('管线：生词榜每项有 band', report.topUnknown.every(t => !!t.bandName));
  check('管线：已学词不进生词榜', !report.topUnknown.some(t => t.s === 'known'));
  check('管线：可理解度与分档自洽', report.level === (report.coverage >= 0.98 ? 1 : report.coverage >= 0.95 ? 2 : report.coverage >= 0.90 ? 3 : 4));
}

/* 模拟一份哔哩哔哩字幕（含中英双轨） */
{
  const blInfo = {
    subtitleTracks: [
      { lan: 'zh-CN', lan_doc: '中文（中国）', subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/z.json' },
      { lan: 'en-US', lan_doc: '英语（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/e.json' }
    ]
  };
  const t = pickBilibiliTrack(blInfo.subtitleTracks, true);
  check('管线：B 站挑中英文轨', t.lan === 'en-US' && !t._noEnglish);
  const body = JSON.stringify({ body: [{ from: 0, to: 2, content: 'Hello everyone welcome back' }, { from: 2, to: 4, content: 'today we build a small project' }] });
  const text = parseSubtitle('bilibili', body);
  check('管线：B 站字幕解析', text === 'Hello everyone welcome back\ntoday we build a small project');
  const r = analyze(text, buildStatusMap([{ word: 'hello', status: 'known' }]), freq, {});
  check('管线：B 站文本可分析', r.tokens === 10, 'tokens=' + r.tokens);
}

/* ================= D2. 打包正确性（ZIP 结构） =================
   踩过的坑：Windows 的 path.relative() 返回反斜杠，直接写进 ZIP 条目名
   → 从 zip 安装的扩展会按 `src\background\sw.js` 找不到文件。这里守住。 */
{
  const entries = [{ name: 'manifest.json', data: readFileSync(resolve(ROOT, 'manifest.json')) }];
  for (const item of ['src', 'icons', 'data']) {
    for (const f of walkFiles(resolve(ROOT, item), ROOT)) entries.push({ name: f.rel, data: readFileSync(f.abs) });
  }
  check('打包：条目名不含反斜杠（ZIP 规范要求正斜杠）', !entries.some(e => e.name.includes('\\')),
    entries.find(e => e.name.includes('\\'))?.name);
  check('打包：manifest.json 是第一个条目', entries[0].name === 'manifest.json');
  check('打包：包含背景脚本与内容脚本',
    entries.some(e => e.name === 'src/background/sw.js') && entries.some(e => e.name === 'src/content/content.js'));
  check('打包：不含开发件（tests/tools/build）',
    !entries.some(e => /^(tests|tools)\//.test(e.name) || e.name === 'build.mjs'));

  const buf = makeZip(entries);
  const read = readZipEntries(buf);
  check('打包：ZIP 条目数与写入一致', read.length === entries.length, `${read.length}/${entries.length}`);
  check('打包：全部条目 CRC + 解压校验通过', read.every(e => e.crcOk), read.filter(e => !e.crcOk).map(e => e.name).join(','));
  const manEntry = read.find(e => e.name === 'manifest.json');
  check('打包：包内 manifest 可解析且与源一致', !!manEntry && JSON.parse(manEntry.content.toString('utf8')).name === JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8')).name);
  check('打包：Firefox 变体存在且引用同一批资源',
    (() => { const fm = JSON.parse(readFileSync(resolve(ROOT, 'manifest.firefox.json'), 'utf8'));
      return Array.isArray(fm.background.scripts) && fm.background.scripts.every(s => entries.some(e => e.name === s)); })());
}

/* ================= E. store 纯函数 ================= */
{
  const rec = { at: Date.now(), source: 'local', label: '墨读', entries: [['Apple', 'known'], ['pear', 'new'], ['', 'known']] };
  const m = vocabToMap(rec);
  check('vocabToMap：小写化并跳空词', m.size === 2 && m.get('apple') === 'known' && m.get('pear') === 'new');
  check('isFresh：新鲜报告为真', isFresh({ at: Date.now() }, { cache: { ttlHours: 6 } }) === true);
  check('isFresh：过期报告为假', isFresh({ at: Date.now() - 7 * 3600 * 1000 }, { cache: { ttlHours: 6 } }) === false);
  check('isFresh：空报告为假', isFresh(null, { cache: { ttlHours: 6 } }) === false);
}

/* ================= 汇总 ================= */
console.log(`\nplugin integration tests:  PASS ${pass}  FAIL ${fail}`);
if (fail) { console.log('\n失败项：'); fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('全部通过 ✓');
