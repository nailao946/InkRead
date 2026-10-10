/* InkRead Video — 词频分层（客观难度参照）
 *
 * 数据文件：data/freq-bands.json —— 按频次降序的高频英语词表（两套语料交集清洗，见 tools/make-freq.mjs）。
 * 作用：给出一个【与用户词库无关】的难度参照——一个视频的字幕里，常用词占比越高，视频越简单。
 *       与 text.js 的「可理解度」互补：一个衡量「视频本身」，一个衡量「视频对你」。
 */

export const BANDS = [
  { band: 1, from: 1, to: 1000, name: '核心词', hint: '最高频 1000 词（功能词 + 基础词）' },
  { band: 2, from: 1001, to: 2500, name: '常用词', hint: '日常高频 1001–2500' },
  { band: 3, from: 2501, to: 5000, name: '进阶词', hint: '一般书面/媒体 2501–5000' },
  { band: 4, from: 5001, to: 99999, name: '进阶高阶词', hint: '表尾词（5001+）' },
  { band: 5, from: 99999, to: 99999, name: '生僻词', hint: '不在高频表内：专名 / 专业词 / 罕见词' }
];

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

/** 解析 freq-bands.json 文本 → { rank: Map<word, rank>, top, meta }（rank 从 1 开始） */
export function parseFreq(jsonText) {
  const data = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
  const words = String(data.words || '').split(' ').filter(Boolean);
  const rank = new Map();
  for (let i = 0; i < words.length; i++) rank.set(words[i], i + 1);
  return {
    rank,
    top: words.length,
    meta: { source: data.source, corpus: data.corpus, corpora: data.corpora, method: data.method, generated: data.generated, note: data.note }
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

/**
 * 客观词汇分层画像。
 * @param {string[]} tokenList 词次序列（可含重复）
 * @param {Function} lemmaFn   词形还原函数 (word) => string[]
 * @param {Map} rankMap        parseFreq().rank
 */
export function intrinsicProfile(tokenList, lemmaFn, rankMap) {
  const bandTok = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const bandUniq = { 1: new Set(), 2: new Set(), 3: new Set(), 4: new Set(), 5: new Set() };
  for (const t of tokenList) {
    const lem = lemmaFn(t);
    const b = bandOf(lem, rankMap);
    bandTok[b]++;
    bandUniq[b].add(lem[0]);
  }
  const total = tokenList.length || 1;
  const coreRatio = (bandTok[1] + bandTok[2]) / total;
  const lv = intrinsicLevelOf(coreRatio);
  return {
    ready: !!rankMap,
    bandTok,
    bandUniq: { 1: bandUniq[1].size, 2: bandUniq[2].size, 3: bandUniq[3].size, 4: bandUniq[4].size, 5: bandUniq[5].size },
    coreRatio: Math.round(coreRatio * 1000) / 1000,
    level: lv.level, text: lv.text, tier: lv.tier, desc: lv.desc
  };
}
