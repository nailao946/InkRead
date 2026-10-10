/* InkRead Video — 文本分析内核（与墨读阅读端逐字对齐）
 *
 * 这里的分词正则、词形还原、覆盖率口径、难度档位，全部照搬 web/js/util.js + web/js/reader.js，
 * 目的是让「视频等级」与「书籍难度」用同一把尺子量——否则两端口径不一致，联动就失去意义。
 * 改动本文件时请同步 web/js/{util,reader}.js，反之亦然。
 */

/* ---- 分词：连续英文字母（含撇号/连字符），与 IR.WORD_RE 一致 ---- */
export const WORD_RE = /[A-Za-z][A-Za-z'’\-]*/g;

/** 抽取文本中的所有英文单词（含重复），与 reader.js computeBookStats 的 match 完全一致 */
export function tokens(text) {
  return String(text || '').match(WORD_RE) || [];
}

/* ---- 不规则词形（与 util.js IRREG 一致） ---- */
const IRREG = {
  were: 'be', was: 'be', is: 'be', are: 'be', been: 'be', being: 'be', am: 'be',
  has: 'have', had: 'have', having: 'have',
  does: 'do', did: 'do', doing: 'do', done: 'do',
  says: 'say', said: 'say',
  children: 'child', men: 'man', women: 'woman', people: 'person',
  feet: 'foot', teeth: 'tooth', mice: 'mouse', geese: 'goose',
  better: 'good', best: 'good', worse: 'bad', worst: 'bad',
  further: 'far', farther: 'far', furthest: 'far',
  wives: 'wife', knives: 'knife', lives: 'life', leaves: 'leaf',
  ourselves: 'ourself', themselves: 'themself'
};

/** 词形还原候选（原词在前，逐步剥离后缀），与 IR.lemmas 逐行一致 */
export function lemmas(word) {
  const w = String(word || '').toLowerCase();
  const out = [w];
  if (IRREG[w]) { out.push(IRREG[w]); return out; }
  if (w.length <= 3) return out;
  const vowel = c => /[aeiou]/.test(c);
  const push = s => { if (s.length >= 2 && !out.includes(s)) out.push(s); };
  /* 复数 / 三单 */
  if (w.endsWith('ies') && w.length > 4) push(w.slice(0, -3) + 'y');
  if (w.endsWith('ses') && w.length > 4) push(w.slice(0, -2));
  if (w.endsWith('es') && w.length > 4) push(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) push(w.slice(0, -1));
  /* 过去式 / 过去分词 */
  if (w.endsWith('ied') && w.length > 4) push(w.slice(0, -3) + 'y');
  if (w.endsWith('ed') && w.length > 4) {
    const stem = w.slice(0, -2);
    push(stem);
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) push(stem.slice(0, -1)); /* stopped → stop */
    push(w.slice(0, -1)); /* liked → like */
  }
  /* 进行时 */
  if (w.endsWith('ing') && w.length > 5) {
    const stem = w.slice(0, -3);
    push(stem);
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) push(stem.slice(0, -1)); /* running → run */
    if (vowel(stem[stem.length - 1] || '')) push(stem + 'e'); /* making → make */
    push(w.slice(0, -3) + 'e');
  }
  /* 比较级 / 最高级 */
  if (w.endsWith('est') && w.length > 5) push(w.slice(0, -3));
  if (w.endsWith('er') && w.length > 4) push(w.slice(0, -2));
  return out;
}

/** 词 → 状态：按候选顺序在词库里查第一个命中的（与 reader.js wordStatusOf 一致） */
export function wordStatusOf(word, statusMap) {
  for (const c of lemmas(word)) {
    const st = statusMap && statusMap.get ? statusMap.get(c) : undefined;
    if (st) return { key: c, status: st };
  }
  return { key: String(word || '').toLowerCase(), status: 'unknown' };
}

/* ---- 阶梯阅读法档位（可理解输入阈值）——与 reader.js levelOf 完全一致 ---- */
export const LEVELS = [
  { level: 1, min: 0.98, text: '轻松', tier: '自由阅读区', desc: '可理解度 ≥98%：几乎不用查词，适合泛读、提速与保持语感。' },
  { level: 2, min: 0.95, text: '适中', tier: 'i+1 理想区', desc: '可理解度 95–98%：阶梯阅读法的黄金区间，少量生词正好用来扩展词汇。' },
  { level: 3, min: 0.90, text: '偏难', tier: '教学挑战区', desc: '可理解度 90–95%：需要边看边查，建议先攻高频生词再看，或每天只看一小段。' },
  { level: 4, min: 0, text: '困难', tier: '挫败区', desc: '可理解度 <90%：远超当前词汇量，建议先看更简单的内容，或先把高频生词加入生词本。' }
];

export function levelOf(coverage) {
  for (const l of LEVELS) if (coverage >= l.min) return l;
  return LEVELS[LEVELS.length - 1];
}

/* ---- 覆盖率 → 一句话结论（面向「这个视频值不值得看」） ---- */
export function verdictOf(coverage, unknownTok) {
  const l = levelOf(coverage);
  const density = coverage > 0 || unknownTok === 0 ? '' : '';
  void density;
  if (l.level === 1) return { ok: true, kind: 'easy', title: '太简单了，可当泛看/精听素材', detail: '几乎没有生词，适合练听力与语速，词汇收益有限。' };
  if (l.level === 2) return { ok: true, kind: 'ideal', title: '符合 i+1（理想）', detail: '生词占比恰到好处——这正是「跳一跳够得着」的黄金区间，最值得看。' };
  if (l.level === 3) return { ok: false, kind: 'hard', title: '偏难，建议先攻高频生词', detail: '生词偏多，可以看，但最好先扫一遍生词表，或配合字幕精看。' };
  return { ok: false, kind: 'fail', title: '超出当前水平，不建议硬啃', detail: '生词密度过高，理解负担大，容易变成「看了个寂寞」，建议换更简单的内容。' };
}

/* ---- 主分析：文本 + 词库状态映射 → 视频词汇画像 ---- */
export function analyzeText(text, statusMap, opts) {
  const maxTop = (opts && opts.maxTop) || 20;
  const toks = tokens(text);

  const uniq = new Map();
  let knownTok = 0, learningTok = 0, newTok = 0, unknownTok = 0;

  for (const t of toks) {
    const { key, status } = wordStatusOf(t, statusMap);
    let e = uniq.get(key);
    if (!e) { e = { display: t, count: 0, status }; uniq.set(key, e); }
    e.count++;
    if (status === 'known') knownTok++;
    else if (status === 'learning') learningTok++;
    else if (status === 'new') newTok++;
    else unknownTok++;
  }

  let known = 0, learning = 0, nw = 0, uu = 0;
  uniq.forEach(e => {
    if (e.status === 'known') known++;
    else if (e.status === 'learning') learning++;
    else if (e.status === 'new') nw++;
    else uu++;
  });

  const total = toks.length;
  const coverage = total ? (knownTok + learningTok) / total : 0;
  const lv = levelOf(coverage);
  const missTok = unknownTok + newTok;                 /* 真正的「生词」词次（含生词本） */

  /* 高频生词榜：与阅读端一致——只统计非「已学」，按词次降序 */
  const topUnknown = Array.from(uniq.values())
    .filter(e => e.status !== 'known')
    .sort((a, b) => b.count - a.count)
    .slice(0, maxTop)
    .map(e => ({ w: e.display, c: e.count, s: e.status }));

  return {
    tokens: total,
    unique: uniq.size,
    known, learning, new: nw, unknown: uu,
    knownTok, learningTok, newTok, unknownTok,
    missTok,
    coverage: Math.round(coverage * 1000) / 1000,
    density: total ? Math.round((missTok / total) * 1000) / 10 : 0,        /* 生词密度（每百词） */
    wordsPerNew: missTok ? Math.round(total / missTok) : 0,               /* 平均每多少词遇 1 个生词 */
    level: lv.level, levelText: lv.text, tier: lv.tier, levelDesc: lv.desc,
    verdict: verdictOf(coverage, missTok),
    topUnknown
  };
}

/** 供 UI 展示：把 L1–L4 映射成颜色语义 */
export const LEVEL_TONE = { 1: 'ok', 2: 'good', 3: 'warn', 4: 'bad' };
