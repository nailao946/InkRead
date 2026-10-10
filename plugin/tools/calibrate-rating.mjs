#!/usr/bin/env node
/* calibrate-rating.mjs —— 校验「三套评级」在已知难度的样本上是否落在合理区间。
 *
 * 为什么需要它：rating.js 里的 CEFR 阈值与蓝思锚点不能凭空写——量出来才算数。
 * 每次改动 rating.js / freq.js 的公式或阈值，跑一遍这个脚本看是否仍然自洽。
 *   node plugin/tools/calibrate-rating.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tokens, lemmas } from '../src/shared/text.js';
import { parseFreq, intrinsicProfile } from '../src/shared/freq.js';
import { buildRatings, cefrOfRatio, lexileOf, lexileBand } from '../src/shared/rating.js';
import { analyze } from '../src/shared/analyze.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const freq = parseFreq(readFileSync(resolve(ROOT, 'data', 'freq-bands.json'), 'utf8'));

/* 样本：按「公认难度」从易到难排列；每项给出期望的 CEFR 与蓝思区间 */
const SAMPLES = [
  {
    name: '儿童句子',
    text: 'The cat sat on the mat. I like my dog. We go to the park every day. My mom and dad are here. It is a good day.',
    cefr: ['A1', 'A2'], lexile: [150, 500]
  },
  {
    name: '日常 vlog',
    text: 'Hey guys welcome back to my channel. Today I want to show you how I make my morning coffee and talk about some small habits that help me feel better every single day.',
    cefr: ['A1', 'A2'], lexile: [300, 650]
  },
  {
    name: 'TED 演讲',
    text: 'So today I want to talk about how I actually learned English. The biggest mistake people make is trying to memorise long vocabulary lists instead of reading things they enjoy. Comprehensible input means the material should be just slightly above your level.',
    cefr: ['A2', 'B1'], lexile: [550, 950]
  },
  {
    name: '新闻社论',
    text: 'The central bank signalled a more restrictive monetary stance on Thursday, citing persistent inflationary pressures and a resilient labour market. Analysts cautioned that the tightening cycle could amplify refinancing risks for highly leveraged corporations.',
    cefr: ['B2', 'C1', 'C2'], lexile: [1000, 1600]
  },
  {
    name: '学术论文',
    text: 'The epistemological ramifications of poststructuralist discourse have been contested within contemporary historiography. The conceptualisation of biopower delineates a genealogy of disciplinary institutions, whose manifestations resist straightforward periodisation.',
    cefr: ['C1', 'C2'], lexile: [1200, 1600]
  }
];

let bad = 0;
console.log('\n样本              核心占比  meanLog 实词Log  蓝思    学段      CEFR  期望');
console.log('─'.repeat(88));
for (const s of SAMPLES) {
  const p = intrinsicProfile(tokens(s.text), lemmas, freq.rank, freq.count);
  const r = buildRatings({ coverage: 0.5, level: 2, levelText: '适中', tier: 'i+1 理想区', freq: p });
  const lx = r.lexile ? r.lexile.score : null;
  const band = lx != null ? lexileBand(lx).text : '—';
  const cefrOk = s.cefr.includes(r.cefr.code);
  const lexOk = lx != null && lx >= s.lexile[0] && lx <= s.lexile[1];
  if (!cefrOk || !lexOk) bad++;
  const mark = (cefrOk && lexOk) ? '✓' : '✗';
  console.log(
    `${s.name.padEnd(8)} ${String(p.coreRatio).padEnd(9)} ${String(p.meanLog).padEnd(8)} ${String(p.contentMeanLog).padEnd(8)} ` +
    `${String(lx != null ? lx + 'L' : '—').padEnd(7)} ${band.padEnd(9)} ${r.cefr.code.padEnd(6)} ${s.cefr.join('/')} ${mark}`
  );
}

/* 阈值边界自检 */
const edges = [
  [0.95, 'A1'], [0.94, 'A1'], [0.93, 'A2'], [0.87, 'A2'], [0.86, 'B1'],
  [0.75, 'B1'], [0.74, 'B2'], [0.62, 'B2'], [0.61, 'C1'], [0.46, 'C1'], [0.45, 'C2']
];
console.log('\nCEFR 阈值边界：');
for (const [ratio, want] of edges) {
  const got = cefrOfRatio(ratio).code;
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${String(ratio).padEnd(6)} → ${got.padEnd(3)} 期望 ${want.padEnd(3)} ${ok ? '✓' : '✗'}`);
}

/* 蓝思单调性：词频越低（越难）→ 分值越高 */
console.log('\n蓝思单调性（meanLog 递减 → 分值应递增）：');
let prev = -1, mono = true;
for (const ml of [6.0, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0]) {
  const lx = lexileOf({ meanLog: ml, contentMeanLog: ml - 1.2 }).score;
  if (lx < prev) mono = false;
  prev = lx;
  console.log(`  meanLog=${ml}  →  ${lx}L`);
}
if (!mono) { bad++; console.log('  ✗ 非单调！'); }

/* 端到端：空词库下 analyze 也要给出完整三套评级 */
{
  const rep = analyze(SAMPLES[2].text, new Map(), freq, {});
  const ok = !!(rep.ratings && rep.ratings.step && rep.ratings.cefr && rep.ratings.lexile);
  if (!ok) bad++;
  console.log(`\n端到端 ratings 完整：${ok ? '✓' : '✗'}  ${rep.ratingsLine}`);
}

console.log(bad ? `\n✗ ${bad} 项未达预期` : '\n✓ 全部落在预期区间');
process.exit(bad ? 1 : 0);
