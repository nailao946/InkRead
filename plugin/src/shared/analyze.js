/* InkRead Video — 分析编排：把「文本分析内核」与「词频分层」合成一份完整报告 */
import { tokens, lemmas, analyzeText, LEVEL_TONE } from './text.js';
import { intrinsicProfile, bandOf } from './freq.js';

/** 词库条目数组 → statusMap（word → status）。status: known | learning | new */
export function buildStatusMap(entries) {
  const m = new Map();
  for (const e of entries || []) {
    if (!e || !e.word) continue;
    const w = String(e.word).toLowerCase();
    if (e.status) m.set(w, e.status);
    /* display 若与 word 不同（如词组/大写原形），也登记一份，提升命中率 */
    if (e.display && e.display.toLowerCase() !== w) {
      const d = e.display.toLowerCase();
      if (!m.has(d)) m.set(d, e.status);
    }
  }
  return m;
}

/** 词库统计：各类状态计数（UI 展示用） */
export function vocabSummary(statusMap) {
  let known = 0, learning = 0, brandNew = 0;
  statusMap.forEach(s => {
    if (s === 'known') known++;
    else if (s === 'learning') learning++;
    else if (s === 'new') brandNew++;
  });
  return { total: statusMap.size, known, learning, new: brandNew };
}

/**
 * 主分析。
 * @param {string} text       字幕/标题等纯文本
 * @param {Map}    statusMap  buildStatusMap() 的产物
 * @param {object} freq       parseFreq() 的产物（可空）
 * @param {object} opts       { maxTop }
 * @returns 完整报告
 */
export function analyze(text, statusMap, freq, opts) {
  const report = analyzeText(text, statusMap, opts);
  const tokenList = tokens(text);
  const rankMap = freq && freq.rank ? freq.rank : null;
  const intrin = intrinsicProfile(tokenList, lemmas, rankMap);

  /* 逐词给出分层（供生词榜展示「难度」标签） */
  const topUnknown = report.topUnknown.map(t => ({
    ...t,
    band: bandOf(lemmas(t.w), rankMap),
    bandName: ['', '核心', '常用', '进阶', '高阶', '生僻'][bandOf(lemmas(t.w), rankMap)]
  }));

  return {
    ...report,
    topUnknown,
    tone: LEVEL_TONE[report.level] || 'warn',
    freq: intrin,
    freqMeta: freq ? freq.meta : null,
    at: Date.now(),
    engine: 'inkread-video/1'
  };
}
