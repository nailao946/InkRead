#!/usr/bin/env node
/* InkRead Video — 核心单测（Node 直接跑，不需要浏览器）
 *   node plugin/tests/test-core.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { tokens, lemmas, wordStatusOf, levelOf, analyzeText, verdictOf, LEVELS } from '../src/shared/text.js';
import { parseFreq, bandOf, intrinsicProfile, intrinsicLevelOf, BANDS } from '../src/shared/freq.js';
import { buildStatusMap, vocabSummary, analyze } from '../src/shared/analyze.js';
import {
  detectSite, pickYoutubeTrack, ytJson3Url, stripPot, absYtUrl, ytCaptionUrls, parseYoutubeJson3, parseYoutubeXml,
  pickBilibiliTrack, parseBilibiliSub, blAbsUrl, parseSubtitle, textSample
} from '../src/shared/subs.js';
import { parseVocabFile, parseVocabCsv, parseVocabLines, normalizeStatus, toEntryPairs } from '../src/shared/vocab-source.js';
import {
  RATING_SYSTEMS, RATING_IDS, DEFAULT_RATING, ratingSystem, cefrOfRatio, cefrOfCoverage,
  lexileOf, lexileBand, buildRatings, pickRating, ratingsLine, LEXILE_MAX, LEXILE_BANDS, CEFR_BANDS
} from '../src/shared/rating.js';
import {
  ARTICLE_MIN_WORDS, ARTICLE_MIN_PARAS, ARTICLE_MIN_LATIN_RATIO,
  cleanParagraphs, parasToText, scriptRatio, articleQuality, isArticleText,
  articleKey, articleStatuses, analyzeArticlePage
} from '../src/shared/article.js';
import {
  MARKS_KEY, MARK_STATUS, DEFAULT_MARKS, normalizeMarks, urlKeyOf,
  setWordMark, clearWordMark, wordMarkOf, countWordMarks, mergeWordMarks,
  hlId, addHighlight, delHighlight, listHighlights, countHighlights,
  locateHighlights, marksSummary, HL_MAX_LEN, HL_MAX_PER_PAGE
} from '../src/shared/marks.js';
import {
  PLUGIN_SOURCE, entryWord, entriesToStatusMap, marksToChanges,
  upsertEntries, wouldChange, stringifyVocab, parseVocabText
} from '../src/shared/vocab-sync.js';
import { buildPhraseIndex, createPhrases, tokenizeItems, scanPhrases } from '../src/shared/phrases.js';
import {
  AUTO_ENGINES, ENGINES, ENGINE_LABELS, detectEngine, engineConfigured, run as trRun, runOne
} from '../src/shared/translate.js';

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra ? '  → ' + extra : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const HERE = dirname(fileURLToPath(import.meta.url));
const FREQ_JSON = readFileSync(resolve(HERE, '..', 'data', 'freq-bands.json'), 'utf8');

/* ================= 1. 分词 / 词形还原（与墨读阅读端同口径） ================= */
check('分词：抽英文词并忽略标点', eq(tokens("Hello, world! It's a test-run."), ['Hello', 'world', "It's", 'a', 'test-run']));
check('分词：空文本 → []', eq(tokens(''), []));
check('分词：数字不算词', eq(tokens('3 apples and 2 pears'), ['apples', 'and', 'pears']));

check('lemmas：不规则 be 系', eq(lemmas('were'), ['were', 'be']));
check('lemmas：children → child', eq(lemmas('Children'), ['children', 'child']));
check('lemmas：stopped → stop', lemmas('stopped').includes('stop'));
check('lemmas：making → make', lemmas('making').includes('make'));
check('lemmas：running → run', lemmas('running').includes('run'));
check('lemmas：studies → study', lemmas('studies').includes('study'));
check('lemmas：短词不动', eq(lemmas('has'), ['has', 'have']));
check('lemmas：三字母及以下原样', eq(lemmas('the'), ['the']));

const smap = new Map([['be', 'known'], ['run', 'learning'], ['apple', 'new']]);
check('wordStatusOf：词形还原命中映射', wordStatusOf('running', smap).status === 'learning');
check('wordStatusOf：命中已学', wordStatusOf('is', smap).status === 'known');
check('wordStatusOf：未命中 → unknown', wordStatusOf('zebra', smap).status === 'unknown');

/* ================= 2. 等级档位（必须与 reader.js levelOf 完全一致） ================= */
check('levelOf：0.99 → L1 轻松', levelOf(0.99).level === 1 && levelOf(0.99).text === '轻松');
check('levelOf：0.98 边界 → L1', levelOf(0.98).level === 1);
check('levelOf：0.97 → L2 i+1 理想区', levelOf(0.97).level === 2 && levelOf(0.97).tier === 'i+1 理想区');
check('levelOf：0.95 边界 → L2', levelOf(0.95).level === 2);
check('levelOf：0.92 → L3 教学挑战区', levelOf(0.92).level === 3 && levelOf(0.92).tier === '教学挑战区');
check('levelOf：0.90 边界 → L3', levelOf(0.90).level === 3);
check('levelOf：0.60 → L4 挫败区', levelOf(0.60).level === 4 && levelOf(0.60).tier === '挫败区');
check('LEVELS 阈值与阅读端一致', eq(LEVELS.map(l => l.min), [0.98, 0.95, 0.90, 0]));
check('verdictOf：i+1 区间给出 ok', verdictOf(0.96, 4).ok === true && verdictOf(0.96, 4).kind === 'ideal');
check('verdictOf：<90% 不建议硬啃', verdictOf(0.80, 20).ok === false && verdictOf(0.80, 20).kind === 'fail');

/* ================= 3. 覆盖率统计 ================= */
{
  /* known: the/a/is ; learning: run ; unknown: zebra */
  const text = 'the a is run zebra';
  const m = new Map([['the', 'known'], ['a', 'known'], ['is', 'known'], ['run', 'learning']]);
  const r = analyzeText(text, m, { maxTop: 5 });
  check('analyzeText：总词次', r.tokens === 5);
  check('analyzeText：已学词次=3', r.knownTok === 3);
  check('analyzeText：在学词次=1', r.learningTok === 1);
  check('analyzeText：生词词次=1', r.unknownTok === 1);
  check('analyzeText：覆盖率=(3+1)/5=0.8', r.coverage === 0.8, 'got ' + r.coverage);
  check('analyzeText：生词密度=20/百词', r.density === 20);
  check('analyzeText：每 5 词遇 1 生词', r.wordsPerNew === 5);
  check('analyzeText：高频生词榜含 zebra（在学也上榜）', r.topUnknown.length === 2 && r.topUnknown.some(t => t.w === 'zebra'));
  check('analyzeText：已学词不上榜', !r.topUnknown.some(t => t.s === 'known'));
  check('analyzeText：覆盖率 0.8 → L4', r.level === 4);
}

{
  /* 词形还原参与统计：runs → run（在学） */
  const m = new Map([['run', 'learning']]);
  const r = analyzeText('runs runs runs', m, {});
  check('analyzeText：词形还原归并（runs→run）', r.learningTok === 3 && r.unique === 1);
}

{
  const r = analyzeText('', new Map(), {});
  check('analyzeText：空文本不炸', r.tokens === 0 && r.coverage === 0 && r.level === 4);
}

/* ================= 4. 词频分层 ================= */
const freq = parseFreq(FREQ_JSON);
check('freq：词表规模 > 5000', freq.top > 5000, 'top=' + freq.top);
check('freq：rank 从 1 开始', freq.rank.get(String(FREQ_JSON ? 'the' : '')) >= 1);
check('freq：高频词排前面', freq.rank.get('the') < 20 && freq.rank.get('you') < 20);
check('BANDS 共 5 档', BANDS.length === 5);

check('bandOf：top1000 → 1', bandOf(['the'], freq.rank) === 1);
check('bandOf：1001-2500 → 2', bandOf([freqWords(1500)], freq.rank) === 2);
check('bandOf：2501-5000 → 3', bandOf([freqWords(3000)], freq.rank) === 3);
check('bandOf：>5000 → 4', bandOf([freqWords(7000)], freq.rank) === 4);
check('bandOf：不在表 → 5', bandOf(['zzzzqqqxxx'], freq.rank) === 5);
check('bandOf：无词表 → 5', bandOf(['the'], null) === 5);
function freqWords(n) { return FREQ_JSON ? JSON.parse(FREQ_JSON).words.split(' ')[n - 1] : ''; }

{
  const ip = intrinsicProfile(tokens('the of and to a in is you that it'), lemmas, freq.rank);
  check('intrinsic：全高频词 coreRatio=1', ip.coreRatio === 1 && ip.level === 1);
}
{
  const ip = intrinsicProfile(tokens('zzzzqqqxxx yyyywwwvvv'), lemmas, freq.rank);
  check('intrinsic：全生僻词 coreRatio=0 → L5', ip.coreRatio === 0 && ip.level === 5);
}
check('intrinsicLevelOf 档位（0.88/0.76/0.62/0.48 阈值）',
  intrinsicLevelOf(0.95).level === 1 && intrinsicLevelOf(0.80).level === 2 &&
  intrinsicLevelOf(0.65).level === 3 && intrinsicLevelOf(0.50).level === 4 && intrinsicLevelOf(0.10).level === 5);

/* ================= 5. 站点识别 ================= */
check('detectSite：youtube watch', detectSite('https://www.youtube.com/watch?v=dQw4w9WgXcQ').site === 'youtube');
check('detectSite：youtube shorts', detectSite('https://www.youtube.com/shorts/abc123XYZ').site === 'youtube');
check('detectSite：youtu.be 短链', detectSite('https://youtu.be/dQw4w9WgXcQ').id === 'dQw4w9WgXcQ');
check('detectSite：m.youtube', detectSite('https://m.youtube.com/watch?v=abcdefghijk').site === 'youtube');
check('detectSite：bilibili BV', detectSite('https://www.bilibili.com/video/BV1xx411c7mD').id === 'BV1xx411c7mD');
check('detectSite：bilibili av', detectSite('https://www.bilibili.com/video/av170001').id === 'av170001');
check('detectSite：bilibili 番剧', detectSite('https://www.bilibili.com/bangumi/play/ep123456').kind === 'bangumi');
check('detectSite：幂等 key 一致', detectSite('https://www.bilibili.com/video/BV1AB').key === 'bl:bv1ab');
check('detectSite：非视频站 → null', detectSite('https://example.com/watch?v=x') === null);
check('detectSite：youtube 首页 → null', detectSite('https://www.youtube.com/') === null);
check('detectSite：bilibili 空间页 → null', detectSite('https://space.bilibili.com/123') === null);
check('detectSite：非法 URL → null', detectSite('not a url') === null);

/* ================= 6. YouTube 字幕 ================= */
check('ytJson3Url：追加 fmt=json3', /[?&]fmt=json3/.test(ytJson3Url('https://x/api?lang=en')));
/* 关键回归：YouTube baseUrl 默认带 &fmt=srv3，必须被覆盖成 json3，不能原样保留 */
check('ytJson3Url：覆盖已有 fmt=srv3 → json3', ytJson3Url('https://x/api?lang=en&fmt=srv3') === 'https://x/api?lang=en&fmt=json3');
check('ytJson3Url：覆盖后仍只有一个 fmt=', (ytJson3Url('https://x/api?fmt=srv3').match(/fmt=/g) || []).length === 1);
check('ytJson3Url：fmt 在中间也能覆盖', ytJson3Url('https://x/api?fmt=srv3&lang=en') === 'https://x/api?fmt=json3&lang=en');

/* PoToken（来源证明令牌）：页面的 baseUrl 常带 exp=xpe/potc/pot 标记，缺有效 token 时
   YouTube 返回 200+空 body。stripPot 负责去掉这些标记做兜底重试。 */
check('stripPot：去掉 potc/exp 标记', stripPot('https://x/api?lang=en&potc=1&exp=xpe') === 'https://x/api?lang=en');
check('stripPot：去掉 pot= 长标记', stripPot('https://x/api?v=A&pot=abcdef.123&lang=en') === 'https://x/api?v=A&lang=en');
check('stripPot：标记在问号后也不留空分隔符', stripPot('https://x/api?potc=1&lang=en') === 'https://x/api?lang=en');
check('stripPot：末尾标记清理干净（无悬挂 ? / &）', stripPot('https://x/api?lang=en&potc=1') === 'https://x/api?lang=en');
check('stripPot：无标记时原样返回', stripPot('https://x/api?lang=en&fmt=json3') === 'https://x/api?lang=en&fmt=json3');
check('stripPot：空值安全', stripPot('') === '' && stripPot(null) === '');

const ytCands = ytCaptionUrls('https://x/api?v=A&lang=en&potc=1&exp=xpe');
check('ytCaptionUrls：首选 fmt=json3', /[?&]fmt=json3/.test(ytCands[0]));
check('ytCaptionUrls：含去 pot 标记的 json3 候选',
  ytCands.some(u => /fmt=json3/.test(u) && !/potc|exp=/.test(u)));
check('ytCaptionUrls：含原始 URL 兜底', ytCands.includes('https://x/api?v=A&lang=en&potc=1&exp=xpe'));
check('ytCaptionUrls：候选去重且有序', new Set(ytCands).size === ytCands.length && ytCands.length >= 3);
check('absYtUrl：相对路径补成 youtube.com 绝对地址', absYtUrl('/api/timedtext?v=A&lang=en') === 'https://www.youtube.com/api/timedtext?v=A&lang=en');
check('absYtUrl：协议相对 // 补 https', absYtUrl('//www.youtube.com/api/timedtext?v=A') === 'https://www.youtube.com/api/timedtext?v=A');
check('absYtUrl：已是绝对地址原样返回', absYtUrl('https://x/y') === 'https://x/y' && absYtUrl('') === '');
check('ytCaptionUrls：相对 baseUrl 也能生成绝对候选', ytCaptionUrls('/api/timedtext?v=A&lang=en').every(u => u.startsWith('https://www.youtube.com/')));

const ytTracks = [
  { baseUrl: 'u1', languageCode: 'zh-Hans', kind: '' },
  { baseUrl: 'u2', languageCode: 'en', kind: 'asr' },
  { baseUrl: 'u3', languageCode: 'en', kind: '' }
];
check('pickYoutubeTrack：优先英文人工字幕', pickYoutubeTrack(ytTracks, true).baseUrl === 'u3');
check('pickYoutubeTrack：preferEn=false 时人工优先', pickYoutubeTrack(ytTracks, false).baseUrl === 'u3');
check('pickYoutubeTrack：无英文时取任意', pickYoutubeTrack([{ baseUrl: 'z', languageCode: 'ja' }], true).baseUrl === 'z');
check('pickYoutubeTrack：空列表 → null', pickYoutubeTrack([], true) === null);

const json3 = { events: [{ segs: [{ utf8: 'Hello' }, { utf8: ' world' }] }, { segs: [{ utf8: '\n' }] }, { segs: [{ utf8: 'Second line' }] }] };
check('parseYoutubeJson3：拼接并去换行', parseYoutubeJson3(json3) === 'Hello world\nSecond line');
check('parseYoutubeXml：解析并解码实体', parseYoutubeXml('<transcript><text start="0">A &amp; B</text><text start="1">C &#39;D&#39;</text></transcript>') === "A & B\nC 'D'");
/* srv3：YouTube 默认 baseUrl 返回的正是这种 <p><s> 结构 */
const srv3 = '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body><p t="0" d="1500"><s>Hello</s><s> world</s></p><p t="1500" d="1200">Second<s> line</s></p></body></timedtext>';
check('parseYoutubeXml：srv3（<p><s>）', parseYoutubeXml(srv3) === 'Hello world\nSecond line');
check('parseSubtitle：srv3 也能解析', parseSubtitle('youtube', srv3) === 'Hello world\nSecond line');
check('parseSubtitle：youtube 自动判别 JSON', parseSubtitle('youtube', JSON.stringify(json3)) === 'Hello world\nSecond line');
check('parseSubtitle：youtube XML 兜底', parseSubtitle('youtube', '<text>Hi</text>').includes('Hi'));
/* json3 解析为空时（events 为空）应继续尝试 XML，而不是直接返回空 */
check('parseSubtitle：json3 空结果 → 退回 XML', parseSubtitle('youtube', '{"events":[]}') === '');

/* ================= 7. 哔哩哔哩字幕 ================= */
check('blAbsUrl：协议相对 → https', blAbsUrl('//aisubtitle.hdslb.com/x.json') === 'https://aisubtitle.hdslb.com/x.json');
check('blAbsUrl：已是绝对地址不变', blAbsUrl('https://a/b') === 'https://a/b');
check('blAbsUrl：空 → 空', blAbsUrl('') === '');

const blList = [
  { lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//s/zh.json' },
  { lan: 'en-US', lan_doc: '英语（自动生成）', subtitle_url: '//s/en.json' },
  { lan: 'zh-CN', lan_doc: '中文（中国）', subtitle_url: '//s/zh2.json' }
];
check('pickBilibiliTrack：优先英文轨', pickBilibiliTrack(blList, true).lan === 'en-US');
{
  const only = pickBilibiliTrack([blList[0], blList[2]], true);
  check('pickBilibiliTrack：只有中文时标记 _noEnglish', only && only._noEnglish === true);
}
check('parseBilibiliSub：拼接 content', parseBilibiliSub({ body: [{ content: '你好' }, { content: '世界' }] }) === '你好\n世界');
check('parseSubtitle：bilibili JSON', parseSubtitle('bilibili', JSON.stringify({ body: [{ content: 'Hi' }] })) === 'Hi');
check('textSample：统计行数', textSample('a\nb\nc').lines === 3);

/* ================= 8. 词表解析 ================= */
check('normalizeStatus：中文 → 枚举', normalizeStatus('已学') === 'known' && normalizeStatus('在学') === 'learning' && normalizeStatus('生词本') === 'new');
check('normalizeStatus：英文直通', normalizeStatus('known') === 'known');
check('normalizeStatus：未知走兜底', normalizeStatus('???', 'learning') === 'learning');

check('toEntryPairs：去重且小写', eq(toEntryPairs([{ word: 'The', status: 'known' }, { word: 'the', status: 'new' }]), [['the', 'new']]));
check('toEntryPairs：跳过空词', eq(toEntryPairs([{ word: '' }, null, { display: 'cat', status: 'known' }]), [['cat', 'known']]));

{
  const backup = JSON.stringify({ app: 'inkread', version: 2, kind: 'full', vocab: [{ word: 'apple', status: 'known' }, { word: 'pear', status: 'new' }] });
  const r = parseVocabFile('inkread-backup-2026.json', backup);
  check('parseVocabFile：墨读备份 JSON', r.entries.length === 2 && r.kind === 'backup' && r.entries[0][1] === 'known');
}
{
  const vj = JSON.stringify([{ word: 'alpha', display: 'alpha', meaning: '', status: 'learning', source: 'reader' }]);
  const r = parseVocabFile('vocab.json', vj);
  check('parseVocabFile：vocab.json 数组', r.entries.length === 1 && r.entries[0][1] === 'learning');
}
{
  const csv = '\uFEFF单词,原形,释义,状态,来源,加入时间,更新时间\r\nApple,apple,"苹果；""果实""",已学,reader,2026-01-01,2026-01-02\r\npear,pear,梨,在学,reader,,\r\n';
  const r = parseVocabFile('vocab.csv', csv);
  check('parseVocabFile：vocab.csv（含引号转义）', r.entries.length === 2 && r.kind === 'vocab-csv');
  check('parseVocabCsv：状态中文映射', eq(r.entries, [['apple', 'known'], ['pear', 'learning']]));
}
{
  const txt = ['# 注释行', 'apple', 'banana 香蕉', 'cherry,樱桃', '', '123'].join('\n');
  const e = parseVocabLines(txt, 'known');
  check('parseVocabLines：忽略注释/数字，切掉释义', eq(e, [['apple', 'known'], ['banana', 'known'], ['cherry', 'known']]));
  check('parseVocabLines：默认状态可指定', parseVocabLines('dog', 'learning')[0][1] === 'learning');
}
{
  const r = parseVocabFile('words.txt', 'one\ntwo', { defaultStatus: 'new' });
  check('parseVocabFile：纯词表 txt', r.entries.length === 2 && r.entries[0][1] === 'new' && r.kind === 'txt');
}
{
  /* 通用 {vocab:[…]} 结构允许导入；但完全找不到词表的 JSON 必须明确报错，不能静默产出空词表 */
  check('parseVocabFile：通用 vocab 数组可导入', parseVocabFile('x.json', JSON.stringify({ vocab: [{ word: 'a', status: 'known' }] })).entries.length === 1);
  let threw = '';
  try { parseVocabFile('x.json', JSON.stringify({ app: 'other', foo: 1 })); }
  catch (e) { threw = e.message; }
  check('parseVocabFile：找不到词表的 JSON 抛错', /不是墨读文件|没有找到词表/.test(threw), threw);
}

/* ================= 9. analyze 组合与状态映射 ================= */
{
  const statusMap = buildStatusMap([
    { word: 'the', status: 'known' }, { word: 'run', status: 'learning' }, { word: 'zebra', status: 'new' }
  ]);
  const s = vocabSummary(statusMap);
  check('vocabSummary：分类计数', s.total === 3 && s.known === 1 && s.learning === 1 && s.new === 1);

  const r = analyze('the the run zebra', statusMap, freq, { maxTop: 10 });
  check('analyze：合并 text + freq', r.tokens === 4 && !!r.freq && r.freq.ready === true);
  check('analyze：生词榜带 band 标注', r.topUnknown.every(t => typeof t.band === 'number' && !!t.bandName));
  check('analyze：tone 映射', r.tone === 'bad' || r.tone === 'warn' || r.tone === 'good' || r.tone === 'ok');
  check('analyze：coverage=(2+1)/4', r.coverage === 0.75, 'got ' + r.coverage);
}
{
  /* display 与 word 不同的条目也能命中（大写/词组原形） */
  const m = buildStatusMap([{ word: 'the', display: 'The', status: 'known' }]);
  check('buildStatusMap：display 变体登记', m.get('the') === 'known');
}

/* ================= 10. 三套评级体系 ================= */
check('rating：系统清单 = step/cefr/lexile', eq(RATING_IDS, ['step', 'cefr', 'lexile']));
check('rating：默认体系合法', RATING_IDS.includes(DEFAULT_RATING));
check('rating：ratingSystem 未知 id 回落到第一套', ratingSystem('nope').id === RATING_SYSTEMS[0].id);
check('rating：每套都有 id/name/short/desc', RATING_SYSTEMS.every(s => s.id && s.name && s.short && s.desc));

check('cefr：阈值边界', [0.95, 0.94, 0.87, 0.86, 0.75, 0.74, 0.62, 0.61, 0.46, 0.45]
  .map(r => cefrOfRatio(r).code).join(' ') === 'A1 A1 A2 B1 B1 B2 B2 C1 C1 C2');
check('cefr：6 档齐全且递减', CEFR_BANDS.length === 6 && CEFR_BANDS.every((b, i) => i === 0 || CEFR_BANDS[i - 1].min > b.min));
check('cefr：个人舒适区（可理解度 → CEFR）',
  cefrOfCoverage(0.99) === 'C1' && cefrOfCoverage(0.95) === 'B2' && cefrOfCoverage(0.90) === 'B1' &&
  cefrOfCoverage(0.82) === 'A2' && cefrOfCoverage(0.5) === 'A1');
check('cefr：NaN 输入不炸', cefrOfRatio(undefined).code === 'C2' && cefrOfCoverage('x') === 'A1');

check('lexile：缺 meanLog → null', lexileOf(null) === null && lexileOf({}) === null);
check('lexile：代码/分值/对数三者自洽',
  (() => { const x = lexileOf({ meanLog: 4.5, contentMeanLog: 3.3 });
    return x.code === x.score + 'L' && x.score > 0 && x.score <= LEXILE_MAX; })());
check('lexile：难度单调递增', (() => {
  const s = [6, 5.5, 5, 4.5, 4, 3.5, 3].map(v => lexileOf({ meanLog: v, contentMeanLog: v - 1.2 }).score);
  return s.every((v, i) => i === 0 || v >= s[i - 1]);
})());
check('lexile：没有实词口径时退回全体口径',
  lexileOf({ meanLog: 4.2, contentMeanLog: null }).score === lexileOf({ meanLog: 4.2, contentMeanLog: 4.2 }).score);
check('lexile：分档单调且覆盖', LEXILE_BANDS.length >= 6 && lexileBand(-5).text === '启蒙' && lexileBand(99999).text === '母语高难');

{
  const r = buildRatings({ level: 2, levelText: '适中', tier: 'i+1 理想区', levelDesc: '黄金区间', coverage: 0.96,
    freq: { ready: true, coreRatio: 0.80, level: 2, text: '基础', tier: 'A2–B1', meanLog: 5.2, contentMeanLog: 4.0 } });
  check('buildRatings：三套齐全', !!(r.step && r.cefr && r.lexile));
  check('buildRatings：step 沿用原口径', r.step.code === 'L2' && r.step.tier === 'i+1 理想区' && r.step.tone === 'good');
  check('buildRatings：cefr 由 coreRatio 推出', r.cefr.code === 'B1', r.cefr.code);
  check('buildRatings：lexile 有分值与学段', /^\d+L$/.test(r.lexile.code) && !!r.lexile.text);
  check('buildRatings：三套都带「个人舒适区」', r.step.personal === 'B2' && r.cefr.personal === 'B2' && r.lexile.personal === 'B2');
  check('buildRatings：headline 均非空', [r.step, r.cefr, r.lexile].every(x => !!x.headline));
  check('pickRating：按 id 取', pickRating(r, 'lexile') === r.lexile && pickRating(r, 'cefr') === r.cefr);
  check('pickRating：未知回落到 step', pickRating(r, 'zzz') === r.step);
  check('pickRating：null ratings → null', pickRating(null, 'step') === null);
  check('ratingsLine：一行含三套', /阶梯 L2/.test(ratingsLine(r)) && /CEFR B1/.test(ratingsLine(r)) && /蓝思 \d+L/.test(ratingsLine(r)));
}
{
  /* 词频表未就绪：每套都要明确降级，不能给出误导性的高分 */
  const r = buildRatings({ level: 4, levelText: '困难', coverage: 0.3, freq: { ready: false, coreRatio: 0, meanLog: null, contentMeanLog: null } });
  check('buildRatings：无词频表时 cefr 标记不可用', r.cefr.code === '—' && r.cefr.ready === false);
  check('buildRatings：无词频表时 lexile 为 null', r.lexile === null);
}

/* ================= 11. 网页文章：识别与阅读模式数据 ================= */
check('article：阈值是显式常量', ARTICLE_MIN_WORDS === 200 && ARTICLE_MIN_PARAS === 3 && ARTICLE_MIN_LATIN_RATIO === 0.25);
check('article：cleanParagraphs 压空白', eq(cleanParagraphs(['  a   b ', '\tc\nd ']), ['a b', 'c d']));
check('article：cleanParagraphs 去重（大小写无关）', eq(cleanParagraphs(['One two', 'one TWO']), ['One two']));
check('article：cleanParagraphs 丢空段', eq(cleanParagraphs(['', '   ', 'ok']), ['ok']));
check('article：parasToText 用空行连接', parasToText(['a', 'b']) === 'a\n\nb');

check('article：scriptRatio 纯英文', scriptRatio('hello world').latinRatio === 1);
check('article：scriptRatio 纯中文', scriptRatio('你好世界').latinRatio === 0);
check('article：scriptRatio 中英混排', (() => { const r = scriptRatio('hello 世界'); return r.latin === 5 && r.cjk === 2; })());

const LONG = parasToText([
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
]);
check('article：质量画像字段齐全', (() => { const q = articleQuality(LONG);
  return q.words > ARTICLE_MIN_WORDS && q.paras === 12 && q.sentences === 12 && q.latinRatio === 1; })(), JSON.stringify(articleQuality(LONG)));
check('article：空文本 → 无正文明细', isArticleText('').reason === '页面上没有可读的正文');
check('article：中文页面 → 明确说中文', /中文/.test(isArticleText('你好世界。'.repeat(80)).reason));
check('article：英文但太短 → 提示词数', /至少需要 200 词/.test(isArticleText('Hello world. This is short.').reason));
check('article：只有一段的长文本 → 提示段数', (() => {
  const one = 'This is one very long paragraph about reading and vocabulary practice and it keeps going. '.repeat(14);
  const r = isArticleText(one);
  return r.ok === false && articleQuality(one).words > ARTICLE_MIN_WORDS && /段/.test(r.reason);
})());
check('article：正常英文长文 → ok', isArticleText(LONG).ok === true);

check('article：articleKey 幂等且带 host', articleKey('https://ex.com/a/b/?q=1') === articleKey('https://ex.com/a/b') &&
  articleKey('https://ex.com/a/b') === 'ar:ex.com/a/b');
check('article：articleKey 非法输入不炸', articleKey('not a url').startsWith('ar:not a url'));

{
  const sm = buildStatusMap([
    { word: 'language', status: 'known' }, { word: 'read', status: 'learning' }, { word: 'vocabulary', status: 'new' }
  ]);
  const st = articleStatuses('Reading languages, vocabulary and something else', sm);
  const m = new Map(st);
  check('article：statuses 的 key 是小写原形词形（reading → learning）', m.get('reading') === 'learning');
  check('article：statuses 命中生词本', m.get('vocabulary') === 'new');
  check('article：statuses 不收录未命中词', !m.has('something') && !m.has('else'));
  check('article：statuses 上限生效', articleStatuses(LONG, sm, 1).length === 1);
}

{
  const sm = buildStatusMap([{ word: 'language', status: 'known' }]);
  const page = analyzeArticlePage({ text: LONG, title: 'Reading Practice', href: 'https://ex.com/read/1', statusMap: sm, freq, opts: { maxTop: 8 } });
  check('article：analyzeArticlePage 端到端 ok', page.ok === true, page.reason);
  check('article：报告含三套评级', !!(page.report.ratings && page.report.ratings.cefr && page.report.ratings.lexile));
  check('article：报告 tokens > 200', page.report.tokens > ARTICLE_MIN_WORDS);
  check('article：返回 key/title/quality/text', page.key === 'ar:ex.com/read/1' && page.title === 'Reading Practice' && !!page.quality && page.text === LONG);
  check('article：返回着色表（数组的数组）', Array.isArray(page.statuses) && page.statuses.every(x => Array.isArray(x) && x.length === 2));
  check('article：标题计入分析样本', page.report.tokens >= (articleQuality(LONG).words));
  const bad = analyzeArticlePage({ text: 'nope', statusMap: new Map(), freq });
  check('article：不合格输入返回 ok=false', bad.ok === false && /正文太短|没有可读/.test(bad.reason));
}

/* ================= 12. 标记（词级标记 + 文本划线） ================= */
{
  check('marks：DEFAULT_MARKS 结构', eq(DEFAULT_MARKS().words, {}) && eq(DEFAULT_MARKS().highlights, {}) && DEFAULT_MARKS().v === 1);
  check('marks：MARK_STATUS 取值固定', eq(MARK_STATUS, ['known', 'learning', 'new']));
  check('marks：MARKS_KEY 稳定', MARKS_KEY === 'iv.marks');

  /* normalizeMarks：脏数据不该炸，非法状态应被丢掉 */
  const dirty = normalizeMarks({
    words: { Good: { status: 'known' }, bad: { status: 'nope' }, '': { status: 'new' }, ok: {} },
    highlights: { 'a.com/x': [{ text: 'hello world', at: 1 }, { text: 'hello world', at: 1 }, { text: '' }, null] }
  });
  check('marks：normalize 丢掉非法状态', !dirty.words.bad && !dirty.words.ok && !dirty.words['']);
  check('marks：normalize 词统一小写', !!dirty.words.good && !dirty.words.Good);
  check('marks：normalize 划线段内去重', listHighlights(dirty, 'a.com/x').length === 1);
  check('marks：normalize 非法输入返回默认', eq(normalizeMarks(null).words, {}) && eq(normalizeMarks('x').words, {}));
}

{
  /* urlKeyOf：去 www、去尾斜杠、丢查询串与锚点 */
  check('marks：urlKeyOf 归一化', urlKeyOf('https://www.Example.com/a/b/?q=1#x') === 'example.com/a/b');
  check('marks：urlKeyOf 根路径', urlKeyOf('https://ex.com/') === 'ex.com');
  check('marks：urlKeyOf 非法输入不炸', typeof urlKeyOf('nope') === 'string');
}

{
  /* 词级标记：设置 / 覆盖 / 取消 / 计数 */
  let m = DEFAULT_MARKS();
  m = setWordMark(m, 'Vocab', 'new', 111);
  check('marks：setWordMark 小写归一', wordMarkOf(m, 'VOCAB') === 'new' && wordMarkOf(m, 'vocab') === 'new');
  check('marks：setWordMark 计数', countWordMarks(m) === 1);
  m = setWordMark(m, 'vocab', 'known', 222);
  check('marks：重复标记覆盖状态', wordMarkOf(m, 'vocab') === 'known');
  m = clearWordMark(m, 'vocab');
  check('marks：clearWordMark 移除', wordMarkOf(m, 'vocab') === null && countWordMarks(m) === 0);
  check('marks：非法状态不会写入', countWordMarks(setWordMark(DEFAULT_MARKS(), 'x', 'bogus')) === 0);
  check('marks：setWordMark 不修改入参（纯函数）', countWordMarks(setWordMark(DEFAULT_MARKS(), 'x', 'new')) === 1);
}

{
  /* mergeWordMarks：标记优先于词库，且不污染原 Map */
  const base = buildStatusMap([{ word: 'language', status: 'known' }, { word: 'vocabulary', status: 'new' }]);
  const m = setWordMark(DEFAULT_MARKS(), 'language', 'new', 1);
  const merged = mergeWordMarks(base, m);
  check('marks：merge 用标记覆盖词库', merged.get('language') === 'new');
  check('marks：merge 保留未标记的词库状态', merged.get('vocabulary') === 'new');
  check('marks：merge 不修改原 Map', base.get('language') === 'known');
  check('marks：merge 容忍空输入', mergeWordMarks(null, null).size === 0);
}

{
  /* 划线：加 / 去重 / 删 / 按页隔离 */
  const key = 'ex.com/read/1', other = 'ex.com/read/2';
  let m = DEFAULT_MARKS();
  m = addHighlight(m, key, '  the   quick brown fox ', '', 1000);
  check('marks：加划线并压空白', listHighlights(m, key)[0].text === 'the quick brown fox');
  m = addHighlight(m, key, 'the quick brown fox', '', 1000);
  check('marks：同文本同时间 → 去重', countHighlights(m, key) === 1);
  m = addHighlight(m, key, 'a second phrase', 'note here', 2000);
  check('marks：不同文本各自成条', countHighlights(m, key) === 2);
  check('marks：划线按页隔离', countHighlights(m, other) === 0);
  check('marks：划线总数（跨页）', countHighlights(m, null) === 2);
  const id = listHighlights(m, key)[0].id;
  m = delHighlight(m, key, id);
  check('marks：delHighlight 删对条目', countHighlights(m, key) === 1 && listHighlights(m, key)[0].text === 'a second phrase');
  check('marks：hlId 稳定', hlId('abc', 5) === hlId('abc', 5) && hlId('abc', 5) !== hlId('abc', 6));
  const longHl = addHighlight(DEFAULT_MARKS(), key, 'x'.repeat(HL_MAX_LEN + 50), '', 1);
  check('marks：超长文本被截断', listHighlights(longHl, key)[0].text.length === HL_MAX_LEN);
  check('marks：每页划线上限', (() => {
    let big = DEFAULT_MARKS();
    for (let i = 0; i < HL_MAX_PER_PAGE + 12; i++) big = addHighlight(big, key, 'phrase number ' + i + ' unique', '', i + 1);
    return countHighlights(big, key) === HL_MAX_PER_PAGE;
  })());
}

{
  /* locateHighlights：在正文里定位划线，支持回绕 */
  const text = 'Alpha beta gamma. Alpha beta delta.';
  let m = addHighlight(DEFAULT_MARKS(), 'k', 'Alpha beta', '', 1);
  m = addHighlight(m, 'k', 'Alpha beta', '', 2);
  const hits = locateHighlights(text, listHighlights(m, 'k'));
  check('marks：locate 找到两处不同位置', hits.length === 2 && hits[0].start === 0 && hits[1].start > hits[0].start, JSON.stringify(hits.map(h => h.start)));
  check('marks：locate 记录 end', hits[0].end === 'Alpha beta'.length);
  const miss = locateHighlights('nothing here', listHighlights(m, 'k'));
  check('marks：locate 找不到就跳过', miss.length === 0);
}

{
  /* marksSummary */
  let m = setWordMark(DEFAULT_MARKS(), 'a', 'new', 1);
  m = setWordMark(m, 'b', 'known', 1);
  m = addHighlight(m, 'k', 'one', '', 1);
  m = addHighlight(m, 'k', 'two', '', 2);
  const s = marksSummary(m, 'k');
  check('marks：summary 统计正确', s.words === 2 && s.highlights === 2 && s.highlightsAll === 2);
  check('marks：summary 空输入', marksSummary(null, null).words === 0);
}

/* ================= 三端共享词库：vocab.json 合并 / 写回 ================= */
{
  const V = [
    { word: 'Apple', display: 'Apple', meaning: '苹果', status: 'known', source: '墨读', addedAt: 100, updatedAt: 100 },
    { word: 'pear', display: 'pear', meaning: '梨', status: 'learning', source: '墨读', addedAt: 200, updatedAt: 200 }
  ];

  check('sync：entryWord 取原形并小写', entryWord({ word: 'Apple' }) === 'apple' && entryWord({ display: 'Pear' }) === 'pear');
  check('sync：entryWord 容忍脏数据', entryWord(null) === '' && entryWord({}) === '' && entryWord('x') === '');

  const sm = entriesToStatusMap(V);
  check('sync：词条数组 → 状态表', sm.get('apple') === 'known' && sm.get('pear') === 'learning' && sm.size === 2);
  check('sync：容忍中文状态', entriesToStatusMap([{ word: 'x', status: '已学' }]).get('x') === 'known');

  /* 改已有词：只动 status/updatedAt，保留 meaning/display/addedAt */
  const r1 = upsertEntries(V, { apple: 'new' }, 999);
  check('sync：更新已有词的状态', r1.entries[0].status === 'new' && r1.updated === 1 && r1.added === 0);
  check('sync：更新保留释义与原字段', r1.entries[0].meaning === '苹果' && r1.entries[0].display === 'Apple' && r1.entries[0].addedAt === 100);
  check('sync：更新打上 updatedAt', r1.entries[0].updatedAt === 999);
  check('sync：更新不改动别的词', r1.entries[1].status === 'learning' && r1.entries[1].updatedAt === 200);
  check('sync：不改动入参数组', V[0].status === 'known' && V.length === 2);

  /* 新增词 */
  const r2 = upsertEntries(V, { Apple: 'known', zebra: 'new' }, 500);
  check('sync：新增不存在的词', r2.added === 1 && r2.updated === 0 && r2.entries.length === 3);
  const zebra = r2.entries[2];
  check('sync：新词字段完整',
    zebra.word === 'zebra' && zebra.display === 'zebra' && zebra.meaning === '' &&
    zebra.status === 'new' && zebra.source === PLUGIN_SOURCE && zebra.addedAt === 500 && zebra.updatedAt === 500);
  check('sync：词条 key 统一小写', r2.entries.every(e => entryWord(e) === entryWord(e).toLowerCase()));

  /* 幂等：状态没变就不动文件 */
  const r3 = upsertEntries(V, { apple: 'known', pear: 'learning' }, 777);
  check('sync：状态未变 → changed=0（幂等，不抖文件）', r3.changed === 0 && r3.entries[0].updatedAt === 100);
  check('sync：wouldChange 预判一致', wouldChange(V, { apple: 'known' }) === false && wouldChange(V, { apple: 'new' }) === true);

  /* 空 / 脏输入 */
  check('sync：空改动 → 原样返回', upsertEntries(V, {}, 1).changed === 0);
  check('sync：无入参 → 空数组', upsertEntries(null, null, 1).entries.length === 0);
  check('sync：非法状态被忽略', upsertEntries([], { ',': 'known', ok: 'nope' }, 1).changed === 0);
  check('sync：空词被忽略', upsertEntries([], { '': 'known', '   ': 'new' }, 1).changed === 0);

  /* marks.words → changes */
  const ch = marksToChanges(setWordMark(DEFAULT_MARKS(), 'Apple', 'new', 1).words);
  check('sync：marksToChanges 小写并只取 status', eq(ch, { apple: 'new' }));
  check('sync：marksToChanges 空输入', eq(marksToChanges(null), {}));

  /* 文本解析 / 序列化 */
  check('sync：parseVocabText 解数组', parseVocabText('[{"word":"a","status":"known"}]').length === 1);
  check('sync：parseVocabText 解备份对象', parseVocabText('{"app":"inkread","vocab":[{"word":"b"}]}')[0].word === 'b');
  check('sync：parseVocabText 去 BOM 且空文本 → []', parseVocabText('\uFEFF   ').length === 0);
  check('sync：stringifyVocab 为合法 JSON（1 空格缩进，与墨读一致）',
    stringifyVocab([{ word: 'a' }]) === JSON.stringify([{ word: 'a' }], null, 1));
  const round = parseVocabText(stringifyVocab(V));
  check('sync：序列化 → 解析 往返一致', eq(round, V));

  /* 端到端：插件标一个词 → 写回 → 用墨读那套解析器读出来 */
  const after = upsertEntries(V, { apple: 'known', zebra: 'new' }, 42).entries;
  const pairs = toEntryPairs(after);
  check('sync：写回后墨读侧能解析出新状态', new Map(pairs).get('apple') === 'known' && new Map(pairs).get('zebra') === 'new');

  /* 大词表下的性能与正确性（vocab.json 上万条很常见） */
  const big = Array.from({ length: 12000 }, (_, i) => ({ word: 'w' + i, status: 'known' }));
  const rb = upsertEntries(big, { w0: 'new', w11999: 'new', brandnew: 'learning' }, 9);
  check('sync：大词表合并正确', rb.changed === 3 && rb.added === 1 && rb.entries.length === 12001);
  check('sync：大词表未误伤其他词', rb.entries[5].status === 'known' && rb.entries[5].updatedAt === undefined);
}

/* ================= 词组库（shared/phrases.js） ================= */
{
  /* 分词 items：词/分隔符交替，带字符偏移（词组区间扫描靠它定位） */
  const src = 'He is tearing down the wall.';
  const its = tokenizeItems(src);
  check('词组：tokenizeItems 词项标 w',
    its.filter(x => x.t === 'w').map(x => x.s).join('|') === 'He|is|tearing|down|the|wall');
  check('词组：tokenizeItems 其余标 x', its.some(x => x.t === 'x' && /\s/.test(x.s)));
  check('词组：tokenizeItems 偏移能原地复原原文',
    its.map(x => src.slice(x.start, x.start + x.s.length)).join('') === src);
  check('词组：tokenizeItems 空输入 → []', tokenizeItems('').length === 0 && tokenizeItems(null).length === 0);

  /* load / get / match */
  const p = createPhrases();
  check('词组：未 load 时 isLoaded=false、size=0', p.isLoaded() === false && p.size() === 0);
  check('词组：load 非法入参 → false', p.load(null) === false);
  check('词组：load 合法表 → true',
    p.load({ 'tear down': '扯下, 拆卸', 'come up with': '想出', 'in spite of': '尽管' }) === true);
  check('词组：size 正确', p.size() === 3);
  check('词组：get 取释义（大小写不敏感）', p.get('tear down') === '扯下, 拆卸' && p.get('TEAR DOWN') === '扯下, 拆卸');
  check('词组：get 未收录 → 空串', p.get('no such phrase') === '');
  check('词组：match 走词形还原（tearing down → tear down）',
    (p.match(tokenizeItems('tearing down'), 0) || {}).base === 'tear down');
  check('词组：match 最长优先（3 词盖过 2 词）',
    (p.match(tokenizeItems('come up with an idea'), 0) || {}).n === 3);
  check('词组：夹了非空白分隔符不匹配', p.match(tokenizeItems('tear , down'), 0) === null);
  check('词组：当前项不是词 → null', p.match(tokenizeItems('  tear down'), 0) === null);
  check('词组：索引未就绪 → null', createPhrases().match(tokenizeItems('tear down'), 0) === null);

  /* 区间扫描 */
  const t1 = 'You should tear down that old shed.';
  const sp1 = scanPhrases(p, t1);
  check('词组：scanPhrases 命中 1 组', sp1.length === 1);
  check('词组：scanPhrases 区间取到原文', t1.slice(sp1[0][0], sp1[0][1]) === 'tear down');
  check('词组：scanPhrases 带基形与释义', sp1[0][2] === 'tear down' && /拆/.test(sp1[0][3]));
  check('词组：scanPhrases 区间互不重叠', sp1.every((s, i) => i === 0 || s[0] >= sp1[i - 1][1]));
  check('词组：scanPhrases 无词组 → []', scanPhrases(p, 'The quick brown fox jumps.').length === 0);
  check('词组：scanPhrases 未 load 实例 → []', scanPhrases(createPhrases(), 'tear down').length === 0);

  /* 真实词库：data/phrases.json 必须可解析，且条数与源表口径一致 */
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const raw = JSON.parse(readFileSync(resolve(ROOT, 'data/phrases.json'), 'utf8'));
  const real = createPhrases();
  check('词组：真实词库 load 成功', real.load(raw) === true);
  check('词组：真实词库条目数 > 20000', real.size() > 20000);
  const t2 = 'She had to put up with his nonsense for years.';
  const sp2 = scanPhrases(real, t2);
  check('词组：真实词库扫得出短语动词（put up with）', sp2.length >= 1);
  check('词组：真实词库的区间都落在原文范围内',
    sp2.every(s => s[0] >= 0 && s[1] > s[0] && s[1] <= t2.length));
  check('词组：真实词库命中项与原文切片一致',
    sp2.every(s => t2.slice(s[0], s[1]).trim() === t2.slice(s[0], s[1]) && /[A-Za-z]/.test(t2.slice(s[0], s[1]))));
}

/* ================= 在线翻译（shared/translate.js） ================= */
{
  check('翻译：引擎清单非空（含免费三件套）',
    ENGINES.length >= 13 && ['google', 'bing', 'mymemory'].every(e => ENGINES.indexOf(e) >= 0));
  check('翻译：每个引擎都有中文名', ENGINES.every(id => !!ENGINE_LABELS[id]));
  check('翻译：AUTO_ENGINES 都是已知引擎', AUTO_ENGINES.every(id => ENGINES.indexOf(id) >= 0));
  check('翻译：detectEngine 认识具体引擎', detectEngine({ engine: 'deepl' }) === 'deepl');
  check('翻译：detectEngine 对未知 id 回落 auto', detectEngine({ engine: 'nope' }) === 'auto' && detectEngine(null) === 'auto');

  const conf = engineConfigured({ engine: 'auto' });
  check('翻译：免费引擎恒可用', conf.google === true && conf.bing === true && conf.mymemory === true);
  check('翻译：付费引擎无 Key 时不可用',
    conf.deepl === false && conf.tencent === false && conf.youdao === false && conf.alimt === false);
  check('翻译：填了 Key 即判定可用',
    engineConfigured({ deepl: { apiKey: 'x' } }).deepl === true
    && engineConfigured({ ms: { apiKey: 'x' } }).ms === true
    && engineConfigured({ libre: { url: 'http://127.0.0.1:5000' } }).libre === true);

  /* run()：注入假 fetch，验证「请求出去 → 译文归一成 {engine,text}」 */
  const calls = [];
  const fakeFetch = async (u) => {
    calls.push(String(u));
    return {
      ok: true, status: 200,
      text: async () => '你好',
      json: async () => ({ responseData: { translatedText: '你好' } })
    };
  };
  const r = await trRun('hi', { api: { engine: 'mymemory' }, fetchImpl: fakeFetch });
  check('翻译：run 返回 {engine,text}', !!(r && r.text === '你好' && /mymemory/i.test(r.engine || '')));
  check('翻译：run 确实发了请求', calls.length >= 1 && /mymemory/i.test(calls[0]));

  /* 代理路由：给了 proxyBase 就必须改写成「墨读本地服务 /__proxy」 */
  const calls2 = [];
  const fakeFetch2 = async (u) => {
    calls2.push(String(u));
    return { ok: true, status: 200, text: async () => '好', json: async () => ({ responseData: { translatedText: '好' } }) };
  };
  await trRun('hi', {
    api: { engine: 'mymemory' }, fetchImpl: fakeFetch2,
    proxyBase: 'http://127.0.0.1:17890/', root: 'C:\\Users\\x\\InkRead'
  });
  check('翻译：走本地服务转发（/__proxy 且带 root）',
    /^http:\/\/127\.0\.0\.1:17890\/__proxy\?url=/.test(calls2[0]) && /root=/.test(calls2[0]));

  /* 未知引擎：必须明确报错，不能静默返回空（空文本的校验在后台 runTranslate 里做，
     这里只验证引擎这一层的行为边界） */
  let err1 = '';
  try { await runOne('不存在的引擎', 'hi', { api: {} }); } catch (e) { err1 = String(e && e.message || e); }
  check('翻译：未知引擎报错', /未知翻译引擎/.test(err1));

  /* 网络失败要翻译成人话（不能让上层拿到裸的 fetch 异常） */
  let err2 = '';
  try {
    await trRun('hi', { api: { engine: 'mymemory' }, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  } catch (e) { err2 = String(e && e.message || e); }
  check('翻译：网络失败给出可读错误', !!err2 && !/ECONNREFUSED/.test(err2));
}

/* ================= 汇总 ================= */
console.log(`\nplugin core tests:  PASS ${pass}  FAIL ${fail}`);
if (fail) { console.log('\n失败项：'); fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('全部通过 ✓');
