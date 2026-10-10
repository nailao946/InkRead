/* InkRead Video — 三套评级体系（可切换）
 *
 * 同一份分析结果，可以按三种「尺子」展示。它们衡量的东西并不相同，切换只是换个视角：
 *
 *   ① step  阶梯阅读法 L1–L4  —— 与墨读阅读端同口径，衡量「这篇对你」的可理解度（i+1 理想区）。
 *   ② cefr  CEFR A1–C2      —— 衡量「文本本身」的用词难度（前 2500 词的覆盖率），国际通用、可横向比较。
 *   ③ lexile 蓝思 Lexile     —— 衡量「文本本身」的词频难度（平均词频对数 + 实词口径），给出 ###L 数值。
 *
 * 为什么口径不同却放在一起：学习者常常需要跟不同的材料/同学/老师对齐评级——
 * 「这本书 CEFR B1 / 780L / i+1 理想区」三句话说的是同一本书，但方便对接不同的体系。
 *
 * 纯逻辑模块：不依赖 DOM / 浏览器 API，Node 可直测。
 */
import { LEVEL_TONE } from './text.js';

export const RATING_SYSTEMS = [
  {
    id: 'step',
    name: '阶梯 L1–L4',
    short: 'L1–L4',
    tag: '对你',
    desc: '可理解度分档，与墨读阅读端同口径；95–98% 为 i+1 理想区。'
  },
  {
    id: 'cefr',
    name: 'CEFR A1–C2',
    short: 'CEFR',
    tag: '看文本',
    desc: '按文本客观用词难度分档（前 2500 高频词覆盖率），国际通用参考标准。'
  },
  {
    id: 'lexile',
    name: '蓝思 Lexile',
    short: '蓝思',
    tag: '看文本',
    desc: '按平均词频对数估算的蓝思值（###L），北美图书常用的阅读难度标尺。'
  }
];

export const RATING_IDS = RATING_SYSTEMS.map(s => s.id);
export const DEFAULT_RATING = 'step';

export function ratingSystem(id) {
  return RATING_SYSTEMS.find(s => s.id === id) || RATING_SYSTEMS[0];
}

/* ============================================================
   ① CEFR（客观）——按「前 2500 高频词覆盖率」分 6 档
   ------------------------------------------------------------
   这套阈值是 freq.js 里 INTRINSIC_LEVELS（L1–L5，标注 A1–A2 / A2–B1 / …）
   的六档细化：A1/A2 分界 0.87 ≈ 原 0.88，B2 下界 0.62 与原一致，C1 下界 0.46 ≈ 原 0.48。
   */
export const CEFR_BANDS = [
  { code: 'A1', min: 0.94, text: '入门', tone: 'ok', desc: '几乎全是最高频词汇，短句为主。' },
  { code: 'A2', min: 0.87, text: '基础', tone: 'ok', desc: '日常话题，用词常规，偶有中频词。' },
  { code: 'B1', min: 0.75, text: '中级', tone: 'good', desc: '能读懂要点，需要一定的词汇量。' },
  { code: 'B2', min: 0.62, text: '中高级', tone: 'warn', desc: '抽象话题与低频词明显增多。' },
  { code: 'C1', min: 0.46, text: '高级', tone: 'bad', desc: '书面/专业语域，术语与抽象表达密集。' },
  { code: 'C2', min: 0, text: '精通', tone: 'bad', desc: '接近母语学术/文学材料。' }
];

export const CEFR_ORDER = CEFR_BANDS.map(b => b.code);

export function cefrOfRatio(coreRatio) {
  const r = num(coreRatio, 0);
  for (const b of CEFR_BANDS) if (r >= b.min) return b;
  return CEFR_BANDS[CEFR_BANDS.length - 1];
}

/* 个人舒适区：把「可理解度」翻译成你当前能轻松应付的 CEFR 阅读水平。
   口径与 L1–L4 一致（已学 + 在学 的词次占比），只是换成 CEFR 的说法。 */
export function cefrOfCoverage(coverage) {
  const c = num(coverage, 0);
  if (c >= 0.98) return 'C1';
  if (c >= 0.95) return 'B2';
  if (c >= 0.90) return 'B1';
  if (c >= 0.82) return 'A2';
  return 'A1';
}

/* ============================================================
   ② 蓝思 Lexile —— 平均词频对数 → ###L
   ------------------------------------------------------------
   说明：MetaMetrics 的蓝思公式未公开，官方也没有个人可用的离线计算器。
   这里用的是公开研究里常见的「平均词频对数（mean log word frequency）」近似法：
     ① 对每个词取语料词次的对数（log10），表外词按 OOV_COUNT 计；
     ② 混合两个口径：全部词（含功能词）0.45 + 实词（band≥2）0.55
        —— 只算功能词会把口语文本的难度整体压平，只算实词又会高估短句难度；
     ③ 用一组锚点做分段线性插值，锚点取自公开的蓝思—学段对应关系。
   校验样本（见 tools/calibrate-rating.mjs）：
        儿童句子 ≈360L · 日常 vlog ≈470L · TED 演讲 ≈730L · 新闻社论 ≈1300L · 学术论文 ≈1460L
   */
const LEXILE_ANCHORS = [
  { log: 5.60, lx: 0 },
  { log: 5.40, lx: 100 },
  { log: 5.10, lx: 200 },
  { log: 4.95, lx: 400 },
  { log: 4.75, lx: 700 },
  { log: 4.55, lx: 900 },
  { log: 4.30, lx: 1050 },
  { log: 4.00, lx: 1200 },
  { log: 3.70, lx: 1320 },
  { log: 3.40, lx: 1420 },
  { log: 3.10, lx: 1500 },
  { log: 2.60, lx: 1600 }
];

export const LEXILE_MAX = 1600;

/** 词频对数（混合口径）→ 蓝思值。freq 为 intrinsicProfile() 的产物。 */
export function lexileOf(freq) {
  const ml = freq && freq.meanLog;
  if (ml == null) return null;
  const cl = (freq.contentMeanLog == null) ? ml : freq.contentMeanLog;
  const log = 0.45 * ml + 0.55 * cl;
  const lx = Math.round(interpolate(log, LEXILE_ANCHORS));
  return { score: lx, code: lx + 'L', log: Math.round(log * 1000) / 1000 };
}

/** 蓝思值 → 学段（贴近北美 grade band 的通俗说法） */
export const LEXILE_BANDS = [
  { max: 200, text: '启蒙', grade: 'GK–G1', tone: 'ok', desc: '幼儿园–一年级：绘本、极短句。' },
  { max: 400, text: '小学低段', grade: 'G2–G3', tone: 'ok', desc: '二–三年级：分级读物、简单故事。' },
  { max: 600, text: '小学高段', grade: 'G4–G5', tone: 'good', desc: '四–五年级：章节书、少儿科普。' },
  { max: 800, text: '初中', grade: 'G6–G8', tone: 'good', desc: '六–八年级：青少年小说、通俗读物。' },
  { max: 1000, text: '高中', grade: 'G9–G10', tone: 'warn', desc: '九–十年级：新闻、传记、一般科普。' },
  { max: 1350, text: '大学/成人', grade: 'G11–C', tone: 'warn', desc: '十一–十二年级 / 大学：社论、专业文章。' },
  { max: 99999, text: '母语高难', grade: 'College+', tone: 'bad', desc: '大学以上：学术论文、文学经典。' }
];

export function lexileBand(score) {
  const s = num(score, 0);
  for (const b of LEXILE_BANDS) if (s <= b.max) return b;
  return LEXILE_BANDS[LEXILE_BANDS.length - 1];
}

/* ============================================================
   ③ 组装：把一份分析结果翻译成三套体系下的评级
   ============================================================ */

/**
 * @param {object} report analyze() 的产物（至少要 level/coverage/freq）
 * @returns {{step:object, cefr:object, lexile:object|null}}
 */
export function buildRatings(report) {
  const cov = num(report && report.coverage, 0);
  const f = (report && report.freq) || {};
  const lv = (report && report.level) || 4;

  /* ---- step：沿用原有口径，不做任何加工 ---- */
  const step = {
    system: 'step',
    code: 'L' + lv,
    name: 'L' + lv,
    text: (report && report.levelText) || '',
    tier: (report && report.tier) || '',
    tone: LEVEL_TONE[lv] || 'warn',
    desc: (report && report.levelDesc) || '',
    objective: 'L' + (f.level || 0),
    objectiveText: f.text || '',
    personal: cefrOfCoverage(cov),
    headline: 'L' + lv + ((report && report.levelText) ? ' · ' + report.levelText : '')
  };

  /* ---- cefr：客观用词难度（词频表没加载出来时明确标注不可用，不瞎给分） ---- */
  const ready = !!f.ready;
  const cb = ready ? cefrOfRatio(f.coreRatio) : null;
  const cefr = {
    system: 'cefr',
    code: cb ? cb.code : '—',
    name: cb ? cb.code : 'CEFR',
    text: cb ? cb.text : '词频表未就绪',
    tier: cb ? '≈ ' + (f.tier || cb.text) : '',
    tone: cb ? cb.tone : 'warn',
    desc: cb ? cb.desc : '未能加载 data/freq-bands.json，无法估算文本客观难度。',
    coreRatio: f.coreRatio,
    ready,
    objective: cb ? cb.code : '—',
    personal: cefrOfCoverage(cov),
    headline: cb ? cb.code + ' · ' + cb.text : 'CEFR —'
  };

  /* ---- lexile：词频难度（数据文件没有 counts 时为 null） ---- */
  let lexile = null;
  const lx = lexileOf(f);
  if (lx) {
    const band = lexileBand(lx.score);
    lexile = {
      system: 'lexile',
      code: lx.code,
      name: lx.code,
      text: band.text,
      tier: band.grade + ' · ' + band.text,
      tone: band.tone,
      desc: band.desc,
      score: lx.score,
      log: lx.log,
      objective: lx.code,
      personal: cefrOfCoverage(cov),
      headline: lx.code + ' · ' + band.text
    };
  }

  return { step, cefr, lexile };
}

/** 从三套评级里取用户选中的那套；缺失时回落到 step。 */
export function pickRating(ratings, system) {
  if (!ratings) return null;
  const r = ratings[system];
  return r || ratings.step || null;
}

/** 把三套评级压成一行紧凑文本，用于 tooltip / 导出。 */
export function ratingsLine(ratings) {
  if (!ratings) return '';
  const out = [];
  if (ratings.step) out.push('阶梯 ' + ratings.step.code);
  if (ratings.cefr) out.push('CEFR ' + ratings.cefr.code);
  if (ratings.lexile) out.push('蓝思 ' + ratings.lexile.code);
  return out.join(' · ');
}

/** 分段线性插值（anchors 必须按 log 降序） */
function interpolate(log, anchors) {
  if (log >= anchors[0].log) return anchors[0].lx;
  const last = anchors[anchors.length - 1];
  if (log <= last.log) return last.lx;
  for (let i = 1; i < anchors.length; i++) {
    const hi = anchors[i - 1], lo = anchors[i];
    if (log <= hi.log && log >= lo.log) {
      const t = (hi.log - log) / (hi.log - lo.log || 1);
      return hi.lx + t * (lo.lx - hi.lx);
    }
  }
  return last.lx;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
