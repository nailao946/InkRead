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
  detectSite, pickYoutubeTrack, ytJson3Url, parseYoutubeJson3, parseYoutubeXml,
  pickBilibiliTrack, parseBilibiliSub, blAbsUrl, parseSubtitle, textSample
} from '../src/shared/subs.js';
import { parseVocabFile, parseVocabCsv, parseVocabLines, normalizeStatus, toEntryPairs } from '../src/shared/vocab-source.js';

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
check('ytJson3Url：已有 fmt 不重复', (ytJson3Url('https://x/api?fmt=srv3').match(/fmt=/g) || []).length === 1);

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
check('parseSubtitle：youtube 自动判别 JSON', parseSubtitle('youtube', JSON.stringify(json3)) === 'Hello world\nSecond line');
check('parseSubtitle：youtube XML 兜底', parseSubtitle('youtube', '<text>Hi</text>').includes('Hi'));

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

/* ================= 汇总 ================= */
console.log(`\nplugin core tests:  PASS ${pass}  FAIL ${fail}`);
if (fail) { console.log('\n失败项：'); fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('全部通过 ✓');
