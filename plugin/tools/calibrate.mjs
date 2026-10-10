#!/usr/bin/env node
/* calibrate.mjs —— 客观难度阈值校准（开发工具）
 *
 * freq.js 里 INTRINSIC_LEVELS 的阈值就是照这组样本文本定的。
 * 改动阈值或更换词表后，跑一遍确认各档仍然分开：
 *   node plugin/tools/calibrate.mjs
 */
import { readFileSync } from 'node:fs';
import { parseFreq, intrinsicProfile } from '../src/shared/freq.js';
import { tokens, lemmas, analyzeText, levelOf } from '../src/shared/text.js';

const freq = parseFreq(readFileSync(new URL('../data/freq-bands.json', import.meta.url), 'utf8'));

/* 各档代表样本：从最难到最易，期望分别落在 L5 → L1 */
const SAMPLES = {
  '⑤ 学术论文': `The epistemological foundations of contemporary cognitive neuroscience remain contested.
Notwithstanding substantial empirical advances, the ontological status of representational constructs
is frequently interrogated. Proponents of embodied cognition contend that sensorimotor contingencies
constitute the substrate of conceptual apprehension, thereby undermining the classical computational
paradigm. Conversely, representationalists maintain that hierarchical predictive processing furnishes
a unifying framework wherein Bayesian inference operationalises both perception and action.`,

  '④ 新闻/科普': `Scientists have discovered that deep sea creatures use bioluminescence to communicate in the dark.
The phenomenon, which was observed off the coast of Japan, suggests that marine organisms have evolved
sophisticated signalling mechanisms. Researchers deployed autonomous underwater vehicles equipped with
high-resolution cameras to capture the behaviour. The emitted light patterns may serve multiple purposes,
including attracting prey and deterring predators, according to a peer-reviewed study.`,

  '③ 教程/讲解': `In this tutorial, we're going to build a simple application from scratch. Let's start by creating
a new folder and opening it in our editor. Next, we'll install the dependencies we need. Once that's done,
I'll show you how to configure the settings. If you run into any errors, don't worry, we'll walk through
the solution together. By the end of this video, you should have a working prototype you can customise.`,

  '② 日常口语': `Hey guys, welcome back to my channel. Today I'm going to show you how I make my morning coffee.
First, I boil some water. Then I put the coffee beans in the grinder and grind them up. I like to add
a little milk and sugar. It's really simple and it tastes so good. If you enjoyed this video, please
hit the like button and subscribe. See you in the next one.`,

  '① 演讲/vlog': `So I want to talk to you today about a question that has puzzled me for years. Why do some ideas
spread while others fade away? I spent a decade studying how information travels through communities,
and what I found surprised me. It turns out that the stories we tell each other shape the way we think
about the world. That's why we need to be careful about what we share.`
};

console.log(`词表：top=${freq.top}  源=${(freq.meta.corpora || [freq.meta.source]).join(' ∩ ')}\n`);
const rows = [];
for (const [name, text] of Object.entries(SAMPLES)) {
  const tk = tokens(text);
  const ip = intrinsicProfile(tk, lemmas, freq.rank);
  const r = analyzeText(text, new Map(), {});
  rows.push({ name, tokens: tk.length, uniq: r.unique, bandTok: ip.bandTok, core: ip.coreRatio, lv: ip.level, text: ip.text });
}
for (const r of rows) {
  console.log(
    `${r.name.padEnd(12)} tokens=${String(r.tokens).padEnd(4)} uniq=${String(r.uniq).padEnd(4)} ` +
    `b1..b5=${r.bandTok[1]}/${r.bandTok[2]}/${r.bandTok[3]}/${r.bandTok[4]}/${r.bandTok[5]}  ` +
    `core=${r.core}  →  L${r.lv} ${r.text}`
  );
}
const levels = rows.map(r => r.lv);
console.log('\n档位序列（期望单调不增）：' + levels.join(' → '));
const ok = levels.every((v, i) => i === 0 || v <= levels[i - 1]) && new Set(levels).size >= 3;
console.log(ok ? '✅ 阈值分布合理' : '⚠️ 阈值需要调整：分布不单调或区分度不足');
process.exit(ok ? 0 : 1);
