#!/usr/bin/env node
/* make-freq.mjs —— 生成「词频分层表」plugin/data/freq-bands.json
 *
 * 用途：给扩展一份「脱离用户词库」的客观难度参照——单词在表里排名越靠前＝越常见。
 *       扩展据此算「核心词汇占比」估算视频的客观难度（L1–L5）。
 *
 * 语料：两套独立语料取交集，去掉专名/拼写噪声：
 *   ① hermitdave/FrequencyWords 2018 en（OpenSubtitles 字幕语料，口语向，与视频场景吻合）
 *   ② first20hours/google-10000-english（Google 网页语料，无脏词版）
 * 交集后按 ① 的频次排序 —— 既保留「字幕语感」，又滤掉 gwen / whoa 这类只在单一语料里高频的噪声。
 *
 * 离线运行：仅在开发期跑一次，产物随仓库分发；运行时扩展不联网。
 *   node plugin/tools/make-freq.mjs                  # 优先读本地缓存，缺失才联网
 *   node plugin/tools/make-freq.mjs --refresh        # 强制重新下载
 *   node plugin/tools/make-freq.mjs --offline a.txt b.txt
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOP_N = 12000;                 // 字幕语料里取多少候选
const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(HERE, '_cache');
const OUT = resolve(HERE, '..', 'data', 'freq-bands.json');

const SUB_URL = 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt';
const GGL_URL = 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/google-10000-english-usa-no-swears.txt';

const argv = process.argv.slice(2);
const refresh = argv.includes('--refresh');
const offIdx = argv.indexOf('--offline');

async function get(url, cacheName) {
  const p = resolve(CACHE, cacheName);
  if (!refresh && existsSync(p)) { console.log(`  cache  ${cacheName}`); return readFileSync(p, 'utf8'); }
  let lastErr;
  for (let i = 1; i <= 4; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      if (t.length < 1000) throw new Error('内容过短，疑似被拦截');
      mkdirSync(CACHE, { recursive: true });
      writeFileSync(p, t, 'utf8');
      console.log(`  fetch  ${cacheName} (${t.length} bytes)`);
      return t;
    } catch (e) {
      lastErr = e;
      console.log(`  retry ${i}/4  ${cacheName}: ${e.message}`);
      await new Promise(r => setTimeout(r, 700 * i));
    }
  }
  throw lastErr;
}

let subText, gglText, sourceDesc;
if (offIdx >= 0) {
  subText = readFileSync(argv[offIdx + 1], 'utf8');
  gglText = readFileSync(argv[offIdx + 2], 'utf8');
  sourceDesc = 'offline:' + argv[offIdx + 1];
} else {
  subText = await get(SUB_URL, 'en_50k.txt');
  gglText = await get(GGL_URL, 'google-10000.txt');
  sourceDesc = SUB_URL + ' ∩ ' + GGL_URL;
}

/* ① 字幕语料：`word count` 按频次降序，只留纯字母词 */
const seen = new Set();
const sub = [];
let lastCount = 0;
for (const line of subText.split(/\r?\n/)) {
  if (!line) continue;
  const sp = line.indexOf(' ');
  const w = (sp < 0 ? line : line.slice(0, sp)).trim().toLowerCase();
  if (!/^[a-z]+$/.test(w) || w.length > 24) continue;
  if (seen.has(w)) continue;
  seen.add(w);
  if (sp >= 0) lastCount = parseInt(line.slice(sp + 1), 10) || lastCount;
  sub.push(w);
  if (sub.length >= 20000) break;
}

/* ② 网页语料白名单 */
const ggl = new Set(
  gglText.split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(w => /^[a-z]+$/.test(w))
);

/* 交集：按字幕频次排序，保留两套语料都认的词 */
const words = sub.filter(w => ggl.has(w)).slice(0, TOP_N);
if (words.length < 3000) throw new Error('交集过小（' + words.length + '），语料可能损坏');

const out = {
  v: 1,
  kind: 'en-frequency-bands',
  source: sourceDesc,
  corpora: ['OpenSubtitles 2018 (en, hermitdave/FrequencyWords)', 'google-10000-english (no-swears)'],
  method: 'intersection, ordered by subtitle frequency',
  generated: new Date().toISOString(),
  top: words.length,
  note: '按频次降序的高频英语词表（纯字母词）。扩展用排名分档估算视频客观难度。',
  words: words.join(' ')
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out), 'utf8');

const band = n => (words.length > n ? words[n - 1] : '-');
console.log(`\nOK  ${OUT}`);
console.log(`    top=${words.length}  bytes=${JSON.stringify(out).length}  minSubCount≈${lastCount}`);
for (const n of [1, 100, 500, 1000, 2000, 3000, 5000, 8000, 12000]) {
  console.log(`    #${String(n).padEnd(5)} ${band(n)}`);
}
