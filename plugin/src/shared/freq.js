/* InkRead Video — 词频分层（客观难度参照）
 *
 * 数据文件：data/freq-bands.json —— 按频次降序的高频英语词表（两套语料交集清洗，见 tools/make-freq.mjs）。
 *   words  : 空格分隔，按频次降序（rank = 下标 + 1）
 *   counts : 空格分隔，与 words 同序等长，来自 OpenSubtitles 2018 的原始词次
 *
 * 作用：给出一个【与用户词库无关】的难度参照。
 *   ① 排名分档（band 1–5）→「核心词占比」→ 客观难度 L1–L5
 *   ② 平均词频对数（meanLog）→ 蓝思（Lexile）估算值
 * 与 text.js 的「可理解度」互补：一个衡量「文本本身」，一个衡量「文本对你」。
 */

export const BANDS = [
  { band: 1, from: 1, to: 1000, name: '核心词', hint: '最高频 1000 词（功能词 + 基础词）' },
  { band: 2, from: 1001, to: 2500, name: '常用词', hint: '日常高频 1001–2500' },
  { band: 3, from: 2501, to: 5000, name: '进阶词', hint: '一般书面/媒体 2501–5000' },
  { band: 4, from: 5001, to: 99999, name: '进阶高阶词', hint: '表尾词（5001+）' },
  { band: 5, from: 99999, to: 99999, name: '生僻词', hint: '不在高频表内：专名 / 专业词 / 罕见词' }
];

/* 表外词（专名、术语、超低频词）在「平均词频对数」里按这个等价频次计。
   词表尾巴的频次约 780，取 200 表示「比表尾更罕见但仍属常见英文词」——
   若取太小（如 1），任何一个术语都会把整篇的蓝思值顶到上限。 */
export const OOV_COUNT = 200;

/* 客观难度档（估算）：按「常用词占比」——前 2500 词覆盖的【词次】比例。
   阈值经实测样本校准（见 tools/calibrate.mjs：电影 0.93 / TED 0.91 / vlog 0.88 / 教程 0.74 / 新闻科普 0.53 / 学术 0.30）。 */
export const INTRINSIC_LEVELS = [
  { level: 1, min: 0.88, text: '入门', tier: 'A1–A2', desc: '口语化、生活场景为主，几乎全是最高频词汇。' },
  { level: 2, min: 0.76, text: '基础', tier: 'A2–B1', desc: '日常话题与 vlog，用词常规，偶尔出现中频词。' },
  { level: 3, min: 0.62, text: '进阶', tier: 'B1–B2', desc: '讲解/教程/科普类，中高频词混用，需要一定词汇量。' },
  { level: 4, min: 0.48, text: '高阶', tier: 'B2–C1', desc: '新闻/专业话题，低频词与术语占比明显。' },
  { level: 5, min: 0, text: '学术/母语', tier: 'C1+', desc: '专有名词、术语、抽象表达密集，接近母语材料。' }
];

export function intrinsicLevelOf(coreRatio) {
  for (const l of INTRINSIC_LEVELS) if (coreRatio >= l.min) return l;
  return INTRINSIC_LEVELS[INTRINSIC_LEVELS.length - 1];
}

/**
 * 解析 freq-bands.json → { rank: Map<word, rank>, count: Map<word, 原始词次>, top, meta }
 * rank 从 1 开始；count 缺失（旧版数据）时为 null。
 */
export function parseFreq(jsonText) {
  const data = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
  const words = String(data.words || '').split(' ').filter(Boolean);
  const rawCounts = data.counts ? String(data.counts).split(' ') : null;
  const rank = new Map();
  const count = new Map();
  let ok = 0;
  for (let i = 0; i < words.length; i++) {
    rank.set(words[i], i + 1);
    const c = rawCounts ? parseInt(rawCounts[i], 10) : NaN;
    if (c > 0) { count.set(words[i], c); ok++; }
  }
  /* counts 与 words 必须基本对齐，否则蓝思模型会拿错值——宁可当作没有 */
  const hasCounts = !!rawCounts && ok >= words.length * 0.99;
  return {
    rank,
    count: hasCounts ? count : null,
    top: words.length,
    meta: {
      source: data.source, corpus: data.corpus, corpora: data.corpora, method: data.method,
      generated: data.generated, note: data.note, version: data.v
    }
  };
}

/** 单词 → 分层（1..5）。走词形还原候选，取最靠前的命中。 */
export function bandOf(wordLemmas, rankMap) {
  if (!rankMap) return 5;
  for (const c of wordLemmas) {
    const r = rankMap.get(c);
    if (r) {
      if (r <= 1000) return 1;
      if (r <= 2500) return 2;
      if (r <= 5000) return 3;
      return 4;
    }
  }
  return 5;
}

/** 单词 → 语料词次（走词形还原候选，取最大的那个）；表外返回 OOV_COUNT。 */
export function countOf(wordLemmas, countMap) {
  if (!countMap) return OOV_COUNT;
  let best = 0;
  for (const c of wordLemmas) {
    const v = countMap.get(c);
    if (v && v > best) best = v;
  }
  return best > 0 ? best : OOV_COUNT;
}

/**
 * 客观词汇画像（脱离用户词库）。
 * @param {string[]} tokenList 词次序列（可含重复）
 * @param {Function} lemmaFn   词形还原函数 (word) => string[]
 * @param {Map} rankMap        parseFreq().rank
 * @param {Map} [countMap]     parseFreq().count（有则算 meanLog，可算蓝思）
 */
export function intrinsicProfile(tokenList, lemmaFn, rankMap, countMap) {
  const bandTok = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const bandUniq = { 1: new Set(), 2: new Set(), 3: new Set(), 4: new Set(), 5: new Set() };
  let logSum = 0, logN = 0, contentLogSum = 0, contentLogN = 0;

  for (const t of tokenList) {
    const lem = lemmaFn(t);
    const b = bandOf(lem, rankMap);
    bandTok[b]++;
    bandUniq[b].add(lem[0]);
    if (countMap) {
      const c = countOf(lem, countMap);
      const lg = Math.log10(c);
      logSum += lg; logN++;
      /* 只统计「实词」（band 2–5）用于第二口径：功能词占比高的口语文本
         会让含全部词的平均值虚高，实词口径更贴近「用词难度」。 */
      if (b >= 2) { contentLogSum += lg; contentLogN++; }
    }
  }

  const total = tokenList.length || 1;
  const coreRatio = (bandTok[1] + bandTok[2]) / total;
  const lv = intrinsicLevelOf(coreRatio);
  const meanLog = logN ? round(logSum / logN, 3) : null;
  const contentMeanLog = contentLogN ? round(contentLogSum / contentLogN, 3) : null;

  return {
    ready: !!rankMap,
    bandTok,
    bandUniq: { 1: bandUniq[1].size, 2: bandUniq[2].size, 3: bandUniq[3].size, 4: bandUniq[4].size, 5: bandUniq[5].size },
    coreRatio: round(coreRatio, 3),
    meanLog,
    contentMeanLog,
    counted: logN,
    level: lv.level, text: lv.text, tier: lv.tier, desc: lv.desc
  };
}

function round(n, d) {
  const p = Math.pow(10, d || 0);
  return Math.round(n * p) / p;
}
