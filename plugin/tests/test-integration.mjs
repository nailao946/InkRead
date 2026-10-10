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

import { parseFreq, intrinsicProfile } from '../src/shared/freq.js';
import { buildStatusMap, analyze, vocabSummary, ratingOf } from '../src/shared/analyze.js';
import { detectSite, parseSubtitle, pickYoutubeTrack, ytJson3Url, stripPot, ytCaptionUrls, pickBilibiliTrack } from '../src/shared/subs.js';
import { vocabToMap, isFresh, DEFAULT_SETTINGS } from '../src/shared/store.js';
import { toEntryPairs } from '../src/shared/vocab-source.js';
import { upsertEntries, stringifyVocab } from '../src/shared/vocab-sync.js';
import {
  RATING_SYSTEMS, RATING_IDS, DEFAULT_RATING, cefrOfRatio, cefrOfCoverage,
  lexileOf, lexileBand, buildRatings, pickRating, ratingsLine, LEXILE_MAX
} from '../src/shared/rating.js';
import {
  ARTICLE_MIN_WORDS, ARTICLE_MIN_PARAS, cleanParagraphs, scriptRatio, articleQuality,
  isArticleText, articleKey, articleStatuses, analyzeArticlePage, parasToText
} from '../src/shared/article.js';
import { tokens, lemmas } from '../src/shared/text.js';
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
  /* 审核最爱挑「申请了与功能无关的权限」：googlevideo 只承载视频流，本扩展不下载视频 */
  check(`${mf}：不申请无关主机权限（googlevideo）`, !(m.host_permissions || []).some(h => /googlevideo/.test(h)));

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
  const csList = m.content_scripts || [];
  for (const cs of csList) {
    for (const js of cs.js || []) check(`${mf}：内容脚本存在 ${js}`, existsSync(resolve(ROOT, js)));
  }
  check(`${mf}：有内容脚本同时匹配 bilibili+youtube`,
    csList.some(cs => (cs.matches || []).some(x => x.includes('bilibili')) && (cs.matches || []).some(x => x.includes('youtube'))));
  check(`${mf}：有覆盖普通网页的文章内容脚本`,
    csList.some(cs => (cs.matches || []).some(x => /^https?:\/\/\*\/\*$/.test(x)) && (cs.js || []).some(j => /article\.js$/.test(j))));
  check(`${mf}：文章内容脚本匹配不能含 file://（避免读本地文件）`,
    !csList.some(cs => (cs.matches || []).some(x => /^file:/.test(x))));
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
for (const rel of ['src/content/content.js', 'src/content/article.js']) {
  const c = readFileSync(resolve(ROOT, rel), 'utf8');
  check(`${rel} 不含 import（内容脚本不能是 ESM）`, !/^\s*import\s/m.test(c));
}

/* ================= B2. 标记模块与消息路由 ================= */
{
  check('marks.js 存在', existsSync(resolve(ROOT, 'src/shared/marks.js')));
  const sw = readFileSync(resolve(ROOT, 'src/background/sw.js'), 'utf8');
  for (const t of ['marksGet', 'markSet', 'hlAdd', 'hlDel', 'marksClear']) {
    check(`后台注册消息：${t}`, new RegExp("'" + t + "'").test(sw));
  }
  check('后台把词标记合并进文章词库（mergeWordMarks）', /mergeWordMarks\s*\(/.test(sw));
  const st = readFileSync(resolve(ROOT, 'src/shared/store.js'), 'utf8');
  check('store 暴露 getMarks/setMarks/clearMarks', /getMarks/.test(st) && /setMarks/.test(st) && /clearMarks/.test(st));
  check('设置默认值含网页上色项', /inlineColor\s*:/.test(st) && /inlineStyle\s*:/.test(st) && /hlStyle\s*:/.test(st) && /siteOff\s*:/.test(st));
  const art = readFileSync(resolve(ROOT, 'src/content/article.js'), 'utf8');
  check('内容脚本有内联上色引擎（data-irw 包裹）', /data-irw/.test(art));
  check('内容脚本可还原 DOM（unwrapAll/normalize）', /unwrapAll/.test(art) && /normalize\(\)/.test(art));
  check('内容脚本支持划线（data-irhl）', /data-irhl/.test(art));
  check('内容脚本内置阅读器站点规则（微信读书 / zlib）', /weread/.test(art) && /z-lib/.test(art));
}

/* ================= B3. 存档目录直连 + 三端词库同步 =================
   这一块守的是「不启动桌面版也能拿到词库」与「一个位置、三端同步」的实现是否接全。 */
{
  for (const f of ['src/shared/idb.js', 'src/shared/fsh.js', 'src/shared/fssync.js',
    'src/shared/vocab-sync.js', 'src/offscreen/offscreen.html', 'src/offscreen/offscreen.js']) {
    check(`目录直连：${f} 存在`, existsSync(resolve(ROOT, f)));
  }

  const fss = readFileSync(resolve(ROOT, 'src/shared/fssync.js'), 'utf8');
  check('目录直连：离屏文档 URL 指向真实文件',
    (() => { const m = fss.match(/OFFSCREEN_PATH\s*=\s*'([^']+)'/); return !!m && existsSync(resolve(ROOT, m[1])); })(),
    (fss.match(/OFFSCREEN_PATH\s*=\s*'([^']+)'/) || [, ''])[1]);
  check('目录直连：fssync 会创建离屏文档', /offscreen\.createDocument/.test(fss));
  check('目录直连：fssync 先试直连再退化到离屏', /viaDirect/.test(fss) && /viaOffscreen/.test(fss));
  check('目录直连：消息类型统一为 ir:fs', /'ir:fs'/.test(fss));

  const off = readFileSync(resolve(ROOT, 'src/offscreen/offscreen.js'), 'utf8');
  check('离屏文档：只处理 ir:fs 消息', /'ir:fs'/.test(off) && /reply\(/.test(off));
  const offCode = off.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('离屏文档：不依赖 chrome.storage（离屏里不可用）', !/chrome\.storage|api\.storage/.test(offCode));

  const fsh = readFileSync(resolve(ROOT, 'src/shared/fsh.js'), 'utf8');
  check('FSA：封装了 showDirectoryPicker（用户手势）', /showDirectoryPicker/.test(fsh));
  check('FSA：写文件用 createWritable', /createWritable/.test(fsh));
  check('FSA：句柄持久化走 IndexedDB', /DIR_KEY/.test(readFileSync(resolve(ROOT, 'src/shared/idb.js'), 'utf8')));

  const sw = readFileSync(resolve(ROOT, 'src/background/sw.js'), 'utf8');
  check('后台：词库来源优先直连存档目录', /readVocabFromDir/.test(sw) && /source = 'dir'/.test(sw));
  check('后台：直连不可用才回落到本地服务', /if \(!done\)/.test(sw) && /detectServer/.test(sw));
  check('后台：标记写回共享 vocab.json', /pushMarksToDir/.test(sw) && /upsertEntries/.test(sw));
  for (const t of ['dirStatus', 'dirSync', 'dirPushMarks', 'dirForget']) {
    check(`后台注册消息：${t}`, new RegExp("'" + t + "'").test(sw));
  }
  check('后台：直连来源标记为 dir（设置页/弹窗据此显示）', /setVocab\('dir'/.test(sw) && /\bdir:\s*'/.test(readFileSync(resolve(ROOT, 'src/shared/vocab-source.js'), 'utf8')));

  const st = readFileSync(resolve(ROOT, 'src/shared/store.js'), 'utf8');
  check('store 默认设置含目录直连字段', /dirName\s*:/.test(st) && /writeBack\s*:/.test(st));

  const opt = readFileSync(resolve(ROOT, 'src/options/options.js'), 'utf8');
  check('设置页：可绑定/解绑/立即读取/写回', ['bindDirNow', 'unbindDirNow', 'doDirSync', 'doPushMarks'].every(f => new RegExp(f).test(opt)));
  check('设置页：多模式区块（data-for 支持空格分隔）', /split\(\/\\s\+\//.test(opt));

  /* 写回协议：mes/desktop/web 读的都是同一个数组结构 */
  const list = [{ word: 'apple', display: 'apple', meaning: '苹果', status: 'known', source: '墨读', addedAt: 1, updatedAt: 1 }];
  const merged = upsertEntries(list, { apple: 'new', mango: 'learning' }, 7);
  check('写回：已有词改状态且保留释义', merged.entries[0].status === 'new' && merged.entries[0].meaning === '苹果');
  check('写回：新词补全墨读字段', (() => { const e = merged.entries[1]; return e.word === 'mango' && 'display' in e && 'meaning' in e && 'source' in e && 'addedAt' in e && 'updatedAt' in e; })());
  check('写回：结果能被墨读解析器读回', new Map(toEntryPairs(merged.entries)).get('mango') === 'learning');
  check('写回：输出是合法 JSON（墨读 JSON.parse 可直接吃）',
    JSON.parse(stringifyVocab(merged.entries)).length === 2);
}

/* ================= B4. R14：换行渲染 / YouTube 字幕格式 / 悬浮位置 =================
   守三件事：① 词典释义里的字面量 \n 要换行；② YouTube 的 srv3 字幕不能漏读；
   ③ 悬浮胶囊默认右侧居中、可拖动并记忆。 */
{
  /* ---------- ① 多行文本换行 ---------- */
  const cj = readFileSync(resolve(ROOT, 'src/content/content.js'), 'utf8');
  check('换行：content.js 定义 escLines', /const escLines\s*=/.test(cj));
  check('换行：escLines 同时处理「字面量 \\n」与真实换行',
    cj.includes('\\\\r\\\\n|\\\\n|\\\\r') && cj.includes('\\r\\n|\\r|\\n'));
  check('换行：面板 reason / verdict 用 escLines 渲染',
    /escLines\(reason\)/.test(cj) && /escLines\(r\.verdict\.detail\)/.test(cj));

  const aj = readFileSync(resolve(ROOT, 'src/content/article.js'), 'utf8');
  check('换行：article.js 定义 escLines', /const escLines\s*=/.test(aj));
  check('换行：词典释义用 escLines（ECDICT 的 \\n 才会换行）', /escLines\(meaning\)/.test(aj));

  /* ---------- ② YouTube 字幕：格式 + 抓取通道 ---------- */
  const srv3xml = '<?xml version="1.0"?><timedtext format="3"><body><p t="0" d="1200"><s>Hello</s><s> world</s></p><p t="1200" d="900">Second line</p></body></timedtext>';
  check('YouTube：fmt 存在时也被覆盖成 json3',
    ytJson3Url('https://www.youtube.com/api/timedtext?v=X&lang=en&fmt=srv3') === 'https://www.youtube.com/api/timedtext?v=X&lang=en&fmt=json3');
  check('YouTube：无 fmt 时追加 json3（页面 baseUrl 的实际形态）',
    ytJson3Url('https://www.youtube.com/api/timedtext?v=X&lang=en') === 'https://www.youtube.com/api/timedtext?v=X&lang=en&fmt=json3');
  check('YouTube：srv3（<p><s>）可解析出文本', parseSubtitle('youtube', srv3xml) === 'Hello world\nSecond line');
  const swSrc = readFileSync(resolve(ROOT, 'src/background/sw.js'), 'utf8');
  check('YouTube：字幕抓取有「页面上下文」兜底（fetchCaptionText）',
    /async function fetchCaptionText/.test(swSrc) && /'fetchCaption'/.test(swSrc));
  check('YouTube：走「候选 URL 列表」逐个尝试（ytCaptionUrls）',
    /ytCaptionUrls\(track\.baseUrl\)/.test(swSrc) && /fetchCaptionText\(u, tabId, \d+, true\)/.test(swSrc));
  check('YouTube：getSubtitle 拿到 tabId（用于页面上下文重抓）', /getSubtitle\(site\.site, info, settings, tabId\)/.test(swSrc));
  check('YouTube：主世界探测「拿到 playerResponse 或签名轨」才 ok', /out\.ok = !!pr \|\| !!signed/.test(swSrc));
  check('YouTube：主世界优先取活动播放器已签名轨（movie_player.getAudioTrack）',
    /getElementById\('movie_player'\)/.test(swSrc) && /getAudioTrack\(\)/.test(swSrc) && /getPlayerResponse\(\)/.test(swSrc));
  check('YouTube：InnerTube(ANDROID) 兜底通道存在', /function innertubeCaptions/.test(swSrc) && /youtubei\/v1\/player/.test(swSrc) && /clientName: 'ANDROID'/.test(swSrc));
  /* 这是「只读到标题」的关键修复：YouTube 现在要求 PoToken，缺了返回 200+空 body；
     URL 候选必须包含「去掉 pot 标记」的版本，且内容脚本要能在页面上下文重抓、逐凭据降级 */
  check('YouTube：URL 候选含「去 PoToken 标记」的兜底',
    stripPot('https://x/api/timedtext?v=A&lang=en&potc=1&exp=xpe') === 'https://x/api/timedtext?v=A&lang=en' &&
    ytCaptionUrls('https://x/api/timedtext?v=A&lang=en&potc=1').some(u => /fmt=json3/.test(u) && !/potc=/.test(u)));
  check('YouTube：内容脚本提供 fetchCaption 通道（页面 Origin + 凭据降级）',
    /'fetchCaption'/.test(cj) && /credentials:\s*'same-origin'/.test(cj) && /credentials:\s*'omit'/.test(cj));
  check('YouTube：fetchCaption 每次尝试带 AbortController 硬超时（通道不会挂死）',
    /new AbortController\(\)/.test(cj) && /ctrl\.abort\(\)/.test(cj));
  check('YouTube：SW 侧对内容脚本消息也有竞速超时（不因一条消息挂死分析）',
    /Promise\.race\(\[/.test(swSrc) && /setTimeout\(\(\) => res\(null\), wait\)/.test(swSrc));
  check('YouTube：fetchCaption 取到「非空」才算成功（200+空体不能当成功）',
    /if \(t && t\.trim\(\)\) \{ reply\(\{ ok: true, text: t/.test(cj) && /err = 'empty'/.test(cj));

  /* ---------- ③ 悬浮位置：右侧居中 + 可拖动记忆 ---------- */
  const stSrc = readFileSync(resolve(ROOT, 'src/shared/store.js'), 'utf8');
  check('位置：默认设置含 ui.pos（null=右侧居中）', /pos:\s*null/.test(stSrc));
  check('位置：content.js 有拖动绑定（pointer 事件）',
    /function bindDrag/.test(cj) && /pointerdown/.test(cj) && /pointermove/.test(cj) && /pointerup/.test(cj));
  check('位置：拖动结束按视口比例落盘', /function savePos/.test(cj) && /x:\s*\+clampNum/.test(cj));
  check('位置：默认就是右侧·垂直居中',
    /badgeSide === 'left'\) \? 0 : 1, y: 0\.5/.test(cj));
  check('位置：面板方向随位置自适应', /setAttribute\('data-side'/.test(cj) && /setAttribute\('data-v'/.test(cj));
  check('位置：拖动后抑制误触（suppressClick）', /suppressClick/.test(cj));
  const optHtml = readFileSync(resolve(ROOT, 'src/options/options.html'), 'utf8');
  check('位置：设置页提供「重置到右侧居中」', /id="posReset"/.test(optHtml));
  const optJs = readFileSync(resolve(ROOT, 'src/options/options.js'), 'utf8');
  check('位置：重置按钮清空 pos 并广播', /posReset/.test(optJs) && /pos:\s*null/.test(optJs));
}

/* ================= B6. R17：上下文自愈 / 动态文章识别 / 文章胶囊可拖动 ================= */
{
  const cj2 = readFileSync(resolve(ROOT, 'src/content/content.js'), 'utf8');
  const aj2 = readFileSync(resolve(ROOT, 'src/content/article.js'), 'utf8');
  const sw2 = readFileSync(resolve(ROOT, 'src/background/sw.js'), 'utf8');
  const pj2 = readFileSync(resolve(ROOT, 'src/popup/popup.js'), 'utf8');
  const st2 = readFileSync(resolve(ROOT, 'src/shared/store.js'), 'utf8');
  const opt2 = readFileSync(resolve(ROOT, 'src/options/options.js'), 'utf8');

  /* ① 「与扩展后台通信失败：Cannot read properties of undefined (reading 'sendMessage')」
     根因是扩展更新/重载后旧内容脚本被孤立（chrome.runtime 变 undefined）。 */
  check('自愈：两个内容脚本都做上下文存活检测（api.runtime.id）',
    /function ctxAlive\(\)/.test(cj2) && /api\.runtime\.id/.test(cj2) &&
    /function ctxAlive\(\)/.test(aj2) && /api\.runtime\.id/.test(aj2));
  check('自愈：孤立时自毁（清定时器 + 摘掉自己的根节点）',
    /function selfDestruct\(\)/.test(cj2) && /clearInterval\(navTimer\)/.test(cj2) &&
    /function selfDestruct\(\)/.test(aj2) && /removeChild\(host\)/.test(aj2));
  check('自愈：mount 幂等（重注入时先摘掉旧根节点，页面不会出现两个胶囊）',
    /getElementById\('inkread-video-root'\)/.test(cj2) && /removeChild\(stale\)/.test(cj2) &&
    /getElementById\('inkread-article-root'\)/.test(aj2) && /removeChild\(stale\)/.test(aj2));
  check('自愈：上下文失效时不再把裸 TypeError 抛给用户',
    /reading 'sendMessage'/.test(cj2) && /selfDestruct\(\); return;/.test(cj2) &&
    /reading 'sendMessage'/.test(aj2));
  check('自愈：后台在「更新」时就地重注入内容脚本（用户无需手动刷新页面）',
    /onInstalled\.addListener/.test(sw2) && /d\.reason === 'update'/.test(sw2) &&
    /function reinjectContentScripts/.test(sw2) &&
    /'src\/content\/content\.js'/.test(sw2) && /'src\/content\/article\.js'/.test(sw2));
  check('自愈：弹窗发消息失败 → 重注入再重试（scripting + activeTab）',
    /async function sendToTab/.test(pj2) && /Receiving end does not exist/.test(pj2) &&
    /api\.scripting\.executeScript/.test(pj2) && /sendToTab\(/.test(pj2));
  check('自愈：视频页分析后顺手唤醒页面上的悬浮窗',
    /sendToTab\(tab\.id, 'video', \{ type: 'refresh' \}\)/.test(pj2));

  /* ② 「文章有些识别不了」：SPA / 客户端 hydrate 的正文晚于首屏出现。 */
  check('动态文章：有「内容就绪」退避重试（scheduleRetry + MAX_RETRY）',
    /function scheduleRetry\(\)/.test(aj2) && /MAX_RETRY/.test(aj2) && /probe\(false\)/.test(aj2));
  check('动态文章：MutationObserver 观察 DOM 变化后重探（含次数上限）',
    /new MutationObserver/.test(aj2) && /MAX_MO_RUNS/.test(aj2) && /mo\.observe\(/.test(aj2));
  check('动态文章：成功后停掉重试与观察（markReady → mo.disconnect）',
    /function markReady\(\)/.test(aj2) && /mo\.disconnect\(\)/.test(aj2));
  check('动态文章：去掉「首屏 p 数量不足就永久放弃」的早退',
    !/querySelectorAll\('p, article, main'\)[\s\S]{0,120}?hidePill\(\);\s*return;/.test(aj2));
  check('动态文章：probe 失败分支会调度重试（不是直接 return）',
    /hidePill\(\);\s*\n\s*scheduleRetry\(\);/.test(aj2));

  /* ③ 「文章模式右下角悬浮窗不能拖动」。 */
  check('文章拖动：article.js 有 pointer 拖动绑定',
    /function bindDrag\(wrap, pill\)/.test(aj2) && /pointerdown/.test(aj2) &&
    /pointermove/.test(aj2) && /pointerup/.test(aj2) && /setPointerCapture/.test(aj2));
  check('文章拖动：位置按视口比例落盘到 article.pos',
    /function savePos/.test(aj2) && /patchSettings\(\{ article: \{ pos \} \}\)/.test(aj2));
  check('文章拖动：默认右下角（x=1,y=1）',
    /return \{ x: 1, y: 1 \}/.test(aj2) && /function readPos/.test(aj2));
  check('文章拖动：面板方向随位置自适应 + 拖动时抑制误触',
    /setAttribute\('data-side'/.test(aj2) && /setAttribute\('data-v'/.test(aj2) && /suppressClick/.test(aj2));
  check('文章拖动：CSS 改为 JS 定位（left/top），并带拖动/朝向样式',
    /\.wrap\[data-drag="1"\]/.test(aj2) && /\.wrap\[data-side="left"\] \.panel/.test(aj2) && /\.wrap\[data-v="down"\] \.panel/.test(aj2));
  check('文章拖动：store 默认设置含 article.pos', /pos:\s*null/.test(st2) && /article:\s*\{/.test(st2));
  check('文章拖动：设置页「重置位置」同时清 article.pos', /article:\s*\{ pos: null \}/.test(opt2));

  /* ④ 面板把 HTML 当纯文本输出：allRatingsHtml() 本身含 <b>，调用方不能再 esc() */
  check('渲染：allRatingsHtml 返回值含 <b>（是 HTML 片段，不是纯文本）',
    /function allRatingsHtml\(r\)/.test(aj2) && /阶梯 <b>\$\{esc\(x\.step\.code\)\}<\/b>/.test(aj2));
  check('渲染：调用处不得再对 allRatingsHtml 做 esc()（否则显示字面 <b>）',
    !/esc\(allRatingsHtml\(/.test(aj2));
  check('渲染：视频侧同口径（content.js 直接插入 allRatings）',
    /\$\{allRatings\(r\)\}/.test(cj2) && !/esc\(allRatings\(/.test(cj2));
}

/* ================= B5. 商店上架资料与品牌图 ================= */
{
  const storeMd = resolve(ROOT, 'STORE.md');
  check('商店：STORE.md 存在', existsSync(storeMd));
  if (existsSync(storeMd)) {
    const md = readFileSync(storeMd, 'utf8');
    for (const k of ['Chrome Web Store', 'Microsoft Edge Add-ons', 'Firefox', '隐私政策', '权限', '单一用途', '截图']) {
      check(`商店：STORE.md 覆盖「${k}」`, md.includes(k));
    }
    check('商店：给出可直接粘贴的英文说明', /Short description/.test(md) && /Single purpose/.test(md));
  }

  /* 品牌图：必须是尺寸正确的合法 PNG */
  const pngSize = p => {
    const b = readFileSync(p);
    const sig = b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG';
    return sig ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
  };
  const assets = [
    ['store/logo-300.png', 300, 300],
    ['store/promo-440x280.png', 440, 280],
    ['store/marquee-1400x560.png', 1400, 560]
  ];
  for (const [rel, W, H] of assets) {
    const abs = resolve(ROOT, rel);
    const ok = existsSync(abs);
    check(`商店：${rel} 存在`, ok);
    if (ok) {
      const d = pngSize(abs);
      check(`商店：${rel} 是 ${W}×${H} 合法 PNG`, !!d && d.w === W && d.h === H, d ? `${d.w}x${d.h}` : 'not-png');
    }
  }
  check('商店：带文案的宣传图模板存在', existsSync(resolve(ROOT, 'store/preview.html')));
  check('商店：生成器存在（gen-store.mjs）', existsSync(resolve(ROOT, 'tools/gen-store.mjs')));

  /* 打包必须把开发件排除在外，否则 zip 会白白变大 */
  const buildSrc = readFileSync(resolve(ROOT, 'build.mjs'), 'utf8');
  check('商店：打包不含 store/（开发件不进包）', !/['"]store['"]/.test(buildSrc) && /INCLUDE\s*=\s*\[[^\]]*'src'/.test(buildSrc));
}

/* ================= C. HTML 资源引用 ================= */
for (const rel of ['src/popup/popup.html', 'src/options/options.html', 'src/offscreen/offscreen.html']) {
  const html = readFileSync(resolve(ROOT, rel), 'utf8');
  const base = dirname(resolve(ROOT, rel));
  const refs = [...html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)].map(m => m[1]).filter(u => !/^(https?:|data:|#|mailto:|tel:)/.test(u));
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

/* ================= F. 三套评级体系 ================= */
{
  check('评级：系统清单含 step / cefr / lexile',
    RATING_IDS.join(',') === 'step,cefr,lexile' && RATING_SYSTEMS.length === 3);
  check('评级：默认体系存在且合法', RATING_IDS.includes(DEFAULT_RATING));
  check('store 默认设置含 rating.system', !!(DEFAULT_SETTINGS.rating && RATING_IDS.includes(DEFAULT_SETTINGS.rating.system)));
  check('store 默认设置含 article 开关', !!(DEFAULT_SETTINGS.article && typeof DEFAULT_SETTINGS.article.enabled === 'boolean'));

  /* CEFR 阈值单调：覆盖率越高，等级越简单 */
  const seq = [0.99, 0.94, 0.90, 0.87, 0.80, 0.75, 0.68, 0.62, 0.55, 0.46, 0.30].map(r => cefrOfRatio(r).code);
  check('CEFR：覆盖率递减 → 等级递减（单调）',
    seq.join(' ') === 'A1 A1 A2 A2 B1 B1 B2 B2 C1 C1 C2', seq.join(' '));
  check('CEFR：≥0.94 为 A1', cefrOfRatio(0.94).code === 'A1');
  check('CEFR：<0.46 为 C2', cefrOfRatio(0.459).code === 'C2');
  check('CEFR：个人舒适区（可理解度）映射',
    cefrOfCoverage(0.99) === 'C1' && cefrOfCoverage(0.96) === 'B2' && cefrOfCoverage(0.91) === 'B1' &&
    cefrOfCoverage(0.85) === 'A2' && cefrOfCoverage(0.60) === 'A1');

  /* 蓝思：难 → 分高；缺 counts 时不可用 */
  const lxA = lexileOf({ meanLog: 6.0, contentMeanLog: 4.8 }).score;
  const lxZ = lexileOf({ meanLog: 3.0, contentMeanLog: 1.8 }).score;
  check('蓝思：难的文本分值更高', lxZ > lxA, `${lxA} → ${lxZ}`);
  check('蓝思：分值被夹在 [0, LEXILE_MAX]', lxA >= 0 && lxZ <= LEXILE_MAX);
  check('蓝思：没有 counts 时返回 null', lexileOf({ meanLog: null, contentMeanLog: null }) === null);
  check('蓝思：学段分档覆盖两端', lexileBand(0).text === '启蒙' && lexileBand(2000).text === '母语高难');
  check('蓝思：代码格式为 ###L', /^\d+L$/.test(lexileOf({ meanLog: 4.5, contentMeanLog: 3.3 }).code));

  /* 真实数据：报告里三套评级同时就绪，且互相自洽 */
  const sample = [
    'So today I want to talk about how I actually learned English.',
    'The biggest mistake people make is trying to memorise long vocabulary lists.',
    'Instead, you should read and listen to things you genuinely enjoy.'
  ].join(' ');
  const rep = analyze(sample, new Map(), freq, { maxTop: 10 });
  check('评级：报告带 ratings 三件套', !!(rep.ratings && rep.ratings.step && rep.ratings.cefr && rep.ratings.lexile));
  check('评级：ratingsLine 同时含三套', /阶梯/.test(rep.ratingsLine) && /CEFR/.test(rep.ratingsLine) && /蓝思/.test(rep.ratingsLine));
  check('评级：step 代码为 L1–L4', /^L[1-4]$/.test(rep.ratings.step.code));
  check('评级：cefr 代码为 A1–C2', /^[ABC][12]$/.test(rep.ratings.cefr.code));
  check('评级：lexile 代码为 ###L', /^\d+L$/.test(rep.ratings.lexile.code));
  check('评级：tone 取值合法', [rep.ratings.step, rep.ratings.cefr, rep.ratings.lexile]
    .every(r => ['ok', 'good', 'warn', 'bad'].includes(r.tone)));
  check('评级：pickRating 可切换', pickRating(rep.ratings, 'cefr') === rep.ratings.cefr && pickRating(rep.ratings, 'lexile') === rep.ratings.lexile);
  check('评级：未知体系回落到 step', pickRating(rep.ratings, 'nope') === rep.ratings.step);
  check('评级：ratingOf 从报告直接取', ratingOf(rep, 'cefr').code === rep.ratings.cefr.code);
  check('评级：三套口径互相自洽（简单文本不会同时是 C2）',
    !(rep.ratings.cefr.code === 'C2' && rep.ratings.lexile.score > 1300 && rep.freq.coreRatio > 0.9));

  /* 词频表带 counts 才能算蓝思 */
  const intrin = intrinsicProfile(tokens(sample), lemmas, freq.rank, freq.count);
  check('词频：meanLog 由真实 counts 算出', typeof intrin.meanLog === 'number' && intrin.meanLog > 2 && intrin.meanLog < 8);
  check('词频：内容词 meanLog 不高于全体均值', intrin.contentMeanLog <= intrin.meanLog + 0.001,
    `${intrin.contentMeanLog} vs ${intrin.meanLog}`);
  const noCounts = intrinsicProfile(tokens(sample), lemmas, freq.rank, null);
  check('词频：缺 counts 时 meanLog=null（蓝思降级）', noCounts.meanLog === null && lexileOf(noCounts) === null);
}

/* ================= G. 网页文章管线 ================= */
{
  const paras = [
    'Learning a language is mostly about the amount of comprehensible input you get every single day.',
    'If you read material that is slightly above your current level, your brain will gradually pick up new words.',
    'The most important thing is to keep going, even when a paragraph feels difficult at the beginning.',
    'Over time, the same vocabulary shows up again and again, and it finally sticks without memorisation.',
    'Many learners give up because they try to understand every word instead of enjoying the story itself.',
    'When you meet a new word in a meaningful context, you remember it far better than a word from a list.',
    'So choose articles and videos about subjects you genuinely care about, and read a little every day.',
    'That simple habit will carry you further than any short burst of intensive study ever could.',
    'A short article about a topic you already understand is perfect practice material for this approach.',
    'You already know the background, so your attention goes to the language rather than the subject.',
    'Keep a small notebook of the words that keep appearing, and review them once a week or so.',
    'After a few months you will be surprised how much easier the same article feels to read.'
  ];
  const text = parasToText(paras);

  check('文章：cleanParagraphs 压平空白并去重',
    cleanParagraphs(['  a   b ', 'a b', '']).length === 1);
  check('文章：scriptRatio 识别纯英文', scriptRatio('hello world').latinRatio === 1);
  check('文章：scriptRatio 识别中文为主', scriptRatio('你好世界').latinRatio === 0);

  const q = articleQuality(text);
  check('文章：质量画像统计词数/段数', q.words > ARTICLE_MIN_WORDS && q.paras === paras.length && q.sentences >= paras.length, JSON.stringify(q));

  const r1 = isArticleText('Too short.');
  check('文章：太短不认作文章', r1.ok === false && new RegExp(String(ARTICLE_MIN_WORDS)).test(r1.reason));
  const r2 = isArticleText('你好世界。'.repeat(60));
  check('文章：中文页面不认作英文文章', r2.ok === false && /中文/.test(r2.reason));
  const r3 = isArticleText(text);
  check('文章：正常英文段落认作文章', r3.ok === true && r3.quality.paras >= ARTICLE_MIN_PARAS);

  check('文章：articleKey 用 host+path 且幂等',
    articleKey('https://example.com/post/1?x=2') === articleKey('https://example.com/post/1') &&
    /^ar:example\.com\/post\/1$/.test(articleKey('https://example.com/post/1')));

  /* statuses 的 key 必须是「小写原形词形」，阅读模式才能一次查表着色 */
  const sm = buildStatusMap([
    { word: 'language', status: 'known' }, { word: 'read', status: 'learning' }, { word: 'vocabulary', status: 'new' }
  ]);
  const st = articleStatuses('Reading and reading languages about vocabulary', sm);
  const map = new Map(st);
  check('文章：statuses 命中已学（Reading → 原形 read 的状态挂在 reading 上）', map.get('reading') === 'learning', JSON.stringify(st));
  check('文章：statuses 命中生词', map.get('vocabulary') === 'new');
  check('文章：statuses 不回传未收录词', !map.has('about'));

  const page = analyzeArticlePage({ text, title: 'Comprehensible Input', href: 'https://example.com/post/1', statusMap: sm, freq, opts: { maxTop: 10 } });
  check('文章：端到端产出报告', page.ok === true && page.report.tokens > ARTICLE_MIN_WORDS, page.reason || ('tokens=' + (page.report && page.report.tokens)));
  check('文章：报告带三套评级', !!(page.report.ratings && page.report.ratings.cefr));
  check('文章：报告 kind=article 由调用方标注前保持纯分析', !page.report.kind);
  check('文章：标题计入样本', page.report.topUnknown.every(t => typeof t.w === 'string'));
  check('文章：返回阅读模式着色表', Array.isArray(page.statuses) && page.statuses.length > 0);
  check('文章：返回正文供阅读模式渲染', typeof page.text === 'string' && page.text.length > 100);

  const bad = analyzeArticlePage({ text: 'hi', title: 'x', href: 'https://e.com/', statusMap: new Map(), freq });
  check('文章：不合格页面返回 ok=false + 原因', bad.ok === false && !!bad.reason);

  /* 词典分片路径：必须在墨读本地服务上真实存在（web/dict/<字母>.json 已内嵌进桌面版） */
  const dictShard = resolve(ROOT, '..', 'web', 'dict', 'a.json');
  check('词典：web/dict/a.json 存在于墨读工程内（本地服务会以 /dict/a.json 提供）', existsSync(dictShard));
}

/* ================= F. 功能接线（字幕标记 / 翻译 / 词组 / 目录联动） ================= */
{
  const sw = readFileSync(resolve(ROOT, 'src/background/sw.js'), 'utf8');
  const cjs = readFileSync(resolve(ROOT, 'src/content/content.js'), 'utf8');
  const ajs = readFileSync(resolve(ROOT, 'src/content/article.js'), 'utf8');
  const ohtml = readFileSync(resolve(ROOT, 'src/options/options.html'), 'utf8');
  const ojss = readFileSync(resolve(ROOT, 'src/options/options.js'), 'utf8');
  const store = readFileSync(resolve(ROOT, 'src/shared/store.js'), 'utf8');

  /* --- 后台消息通道 --- */
  for (const h of ['pcInfo', 'pcImportApi', 'translateStatus', 'translate', 'wordStatuses', 'phraseInfo', 'phraseScan']) {
    check(`接线：后台有 ${h} 消息处理器`, new RegExp("case\\s+'" + h + "'").test(sw));
  }
  check('接线：wordStatuses 回传 linked（页面据此决定要不要给字幕上色）', /linked/.test(sw));
  check('接线：词组只由后台加载（内容脚本不自己 fetch phrases.json）',
    /ensurePhrases/.test(sw) && /data\/phrases\.json/.test(sw) && !/phrases\.json/.test(cjs) && !/phrases\.json/.test(ajs));

  /* --- 字幕逐词标记（content.js） --- */
  check('接线：字幕容器选择器覆盖 YouTube 与哔哩哔哩',
    /ytp-caption-window-container/.test(cjs) && /bpx-player-subtitle-panel/.test(cjs));
  check('接线：字幕标记用 data-ism 包裹并在自毁时还原',
    /data-ism/.test(cjs) && /subsUnwrap/.test(cjs) && /subsMarkStop\(\);/.test(cjs));
  const clickTail = cjs.split('document.addEventListener(\'click\'')[1] || '';
  check('接线：字幕点击走 capture 并放行自家面板（Shadow DOM 会重定向 target）',
    /,\s*true\s*\)/.test(clickTail) && /t === host/.test(cjs));
  check('接线：正文与字幕共用同一套状态语义（known/learning/new/unknown）',
    /ism-known/.test(cjs) && /ism-learning/.test(cjs) && /ism-new/.test(cjs) && /ism-unknown/.test(cjs));
  check('接线：字幕标记开关写回 storage 且面板可切换', /subsmark/.test(cjs) && /setSubsMark/.test(cjs));

  /* --- 文章：词组 + 段落翻译（article.js） --- */
  check('接线：阅读模式渲染词组包层 .ph', /className = 'ph'/.test(ajs) && /dataset\.phk/.test(ajs));
  check('接线：词组线只在组内有生词时画', /hasUnknown/.test(ajs));
  check('接线：词组卡片有「分开看」', /分开看/.test(ajs) && /data-op="split"/.test(ajs));
  check('接线：段落「译」按钮 + 译文容器（para-tr / para-trans）',
    /para-tr/.test(ajs) && /para-trans/.test(ajs) && /toggleParaTrans/.test(ajs));
  check('接线：段落译文按句分行（pt-line）', /pt-line/.test(ajs));
  check('接线：阅读模式渲染前先取词组区间', /await scanPhrases\(payload\.text\)/.test(ajs));
  check('接线：换页时词组区间与译文缓存一起作废', /_phSpans = null/.test(ajs) && /_paraTrans\.clear\(\)/.test(ajs));

  /* --- 设置项形状（store） --- */
  check('接线：设置含 api.engine 与 proxy（与墨读 settings.json 同形）',
    /api:\s*\{/.test(store) && /engine:\s*'auto'/.test(store) && /proxy:\s*\{/.test(store));
  check('接线：设置含 translate（enabled/viaLocal/paraTrans/phraseAuto）',
    /translate:\s*\{[\s\S]{0,220}paraTrans/.test(store) && /phraseAuto/.test(store));
  check('接线：设置含 phrases（enabled/underline）', /phrases:\s*\{[\s\S]{0,160}underline/.test(store));
  check('接线：设置含 subs.mark / subs.markStyle', /subs:\s*\{[\s\S]{0,320}mark:/.test(store) && /markStyle/.test(store));
  check('接线：设置含 link.pcRoot / link.autoBind（默认对齐 PC 目录）',
    /pcRoot/.test(store) && /autoBind/.test(store));

  /* --- 设置页 --- */
  check('接线：设置页有悬浮 tab 导航', /settings-tabs/.test(ohtml) && /settings-section/.test(ohtml));
  check('接线：设置页有翻译接口与关于两节', /data-sec="translate"/.test(ohtml) && /data-sec="about"/.test(ohtml));
  check('接线：设置页含作者 GitHub 与邮箱',
    /github\.com\/nailao946/.test(ohtml) && /hyperola8@gmail\.com/.test(ohtml));
  check('接线：设置页有字幕标记两项', /id="subsMark"/.test(ohtml) && /id="subsMarkStyle"/.test(ohtml));
  check('接线：设置页有「用墨读的目录」一键对齐', /id="btnUsePcDir"/.test(ohtml) && /usePcDir/.test(ojss));
  check('接线：绑定目录时把选择器起点对齐墨读目录', /startIn/.test(ojss) && /pickDir\('readwrite', startIn\)/.test(ojss));
  check('接线：目录状态显示「与墨读是否同一目录」', /与墨读是否同一目录/.test(ojss));
  check('接线：settings 广播带上 translate 与 phrases',
    /translate:\s*settings\.translate/.test(ojss) && /phrases:\s*settings\.phrases/.test(ojss));

  /* --- 打包与暴露面 --- */
  const bin = readFileSync(resolve(ROOT, 'build.mjs'), 'utf8');
  check('接线：打包包含 data/（词组库进包）', /INCLUDE\s*=\s*\[[^\]]*'data'/.test(bin));
  check('接线：词组库确实存在且不是空文件', existsSync(resolve(ROOT, 'data/phrases.json')) && statSync(resolve(ROOT, 'data/phrases.json')).size > 400000);
  for (const mf of ['manifest.json', 'manifest.firefox.json']) {
    const m = JSON.parse(readFileSync(resolve(ROOT, mf), 'utf8'));
    /* 950KB 的词组库不该暴露给任意网站：它只由 SW 读，页面走 phraseScan 拿区间 */
    const war = JSON.stringify(m.web_accessible_resources || []);
    check(`接线：${mf} 不通过 web_accessible_resources 暴露词组库`, !/phrases\.json/.test(war), war);
    check(`接线：${mf} 版本 ≥ 1.5.0`, /^1\.\d+\.\d+$/.test(m.version) && m.version >= '1.5.0');
    /* Chrome / Edge / AMO 对 description 的上限都是 132 字符，超了会吃审核警告 */
    const dlen = [...(m.description || '')].length;
    check(`接线：${mf} description ≤ 132 字符`, dlen > 0 && dlen <= 132, String(dlen));
  }
}

/* ================= 汇总 ================= */
console.log(`\nplugin integration tests:  PASS ${pass}  FAIL ${fail}`);
if (fail) { console.log('\n失败项：'); fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('全部通过 ✓');
