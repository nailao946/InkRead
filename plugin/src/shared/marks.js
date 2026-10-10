/* InkRead 墨读 — 标记（词级标记 + 文本划线）
 *
 * 两件事分开存：
 *   · words      —— 词级标记，**全局**生效（一个词在任何页面都算这个词），相当于「手动校正词库」。
 *                   状态沿用词库那套：known（已学）| learning（在学）| new（生词本）。
 *                   标记优先于墨读词库——用户亲手标的说了算。
 *   · highlights —— 文本划线，**按 URL** 存（同一篇文章的划线只属于这篇文章），像微信读书/多看那样。
 *
 * 纯逻辑、无 DOM、无 chrome.*，Node 可直接单测；DOM 侧（src/content/article.js）只负责渲染与还原。
 */

export const MARKS_KEY = 'iv.marks';

/** 可标记的词状态（与词库/阅读模式的状态取值保持一致，避免第三套语义） */
export const MARK_STATUS = ['known', 'learning', 'new'];
export const MARK_STATUS_TXT = { known: '已学', learning: '在学', new: '生词本' };

/** 单条划线的文本长度上限（防止误选整页时把存储撑爆） */
export const HL_MAX_LEN = 400;
/** 单个页面保留的划线条数上限 */
export const HL_MAX_PER_PAGE = 200;

export function DEFAULT_MARKS() {
  return { v: 1, words: {}, highlights: {} };
}

const clone = o => JSON.parse(JSON.stringify(o || {}));

/** 规范化一个 marks 对象，补全缺失字段（读旧数据/脏数据时用） */
export function normalizeMarks(m) {
  const base = DEFAULT_MARKS();
  if (!m || typeof m !== 'object') return base;
  const out = base;
  if (m.words && typeof m.words === 'object') {
    for (const k of Object.keys(m.words)) {
      const w = String(k || '').toLowerCase().trim();
      if (!w) continue;
      const e = m.words[k];
      const st = e && MARK_STATUS.indexOf(e.status) >= 0 ? e.status : null;
      if (!st) continue;
      out.words[w] = { status: st, at: (e && e.at) || 0, note: (e && e.note) || '' };
    }
  }
  if (m.highlights && typeof m.highlights === 'object') {
    for (const k of Object.keys(m.highlights)) {
      const list = m.highlights[k];
      if (!Array.isArray(list)) continue;
      const seen = new Set();
      const keep = [];
      for (const h of list) {
        if (!h || typeof h !== 'object') continue;
        const text = String(h.text || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > HL_MAX_LEN) continue;
        const id = h.id || hlId(text, h.at || 0);
        if (seen.has(id)) continue;
        seen.add(id);
        keep.push({ id, text, at: h.at || 0, note: (h.note || '') });
        if (keep.length >= HL_MAX_PER_PAGE) break;
      }
      if (keep.length) out.highlights[k] = keep;
    }
  }
  return out;
}

/** 页面 key：host（去 www）+ path（去尾斜杠）。查询串/锚点不参与，避免同文多参被拆开。 */
export function urlKeyOf(href) {
  try {
    const u = new URL(String(href || ''));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return host + u.pathname.replace(/\/+$/, '');
  } catch (e) {
    return String(href || '').slice(0, 200).toLowerCase();
  }
}

/* ===================== 词级标记 ===================== */

/** 设置/更新一个词的标记；status 传空则删除该标记 */
export function setWordMark(marks, word, status, at) {
  const w = String(word || '').toLowerCase().trim();
  const next = normalizeMarks(clone(marks));
  if (!w) return next;
  if (!status || MARK_STATUS.indexOf(status) < 0) { delete next.words[w]; return next; }
  next.words[w] = { status, at: at || 0, note: '' };
  return next;
}

export function clearWordMark(marks, word) { return setWordMark(marks, word, null); }

export function wordMarkOf(marks, word) {
  const w = String(word || '').toLowerCase().trim();
  const e = marks && marks.words ? marks.words[w] : null;
  return e ? e.status : null;
}

export function countWordMarks(marks) {
  return marks && marks.words ? Object.keys(marks.words).length : 0;
}

/**
 * 把词级标记合并进 statusMap（标记优先）。
 * @param {Map<string,string>} statusMap 词库状态
 * @param {object} marks                normalizeMarks 的产物
 * @returns {Map<string,string>} 新的 Map（不修改入参）
 */
export function mergeWordMarks(statusMap, marks) {
  const out = new Map(statusMap || []);
  const w = (marks && marks.words) || {};
  for (const k of Object.keys(w)) out.set(k, w[k].status);
  return out;
}

/* ===================== 文本划线 ===================== */

/** 稳定 id：同文本同时间戳 → 同 id（重复添加会被去重） */
export function hlId(text, at) {
  const s = String(text || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(36) + '-' + String(at || 0).toString(36);
}

/**
 * 加一条划线。
 * @returns {object} 新的 marks 对象
 */
export function addHighlight(marks, key, text, note, at) {
  const next = normalizeMarks(clone(marks));
  const k = String(key || '');
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, HL_MAX_LEN);
  if (!k || !t) return next;
  const now = at || 0;
  const id = hlId(t, now);
  const list = next.highlights[k] || (next.highlights[k] = []);
  if (list.some(h => h.id === id)) return next;
  list.push({ id, text: t, at: now, note: (note || '').slice(0, 200) });
  if (list.length > HL_MAX_PER_PAGE) list.splice(0, list.length - HL_MAX_PER_PAGE);
  return next;
}

export function delHighlight(marks, key, id) {
  const next = normalizeMarks(clone(marks));
  const k = String(key || '');
  const list = next.highlights[k];
  if (list) {
    next.highlights[k] = list.filter(h => h.id !== id);
    if (!next.highlights[k].length) delete next.highlights[k];
  }
  return next;
}

export function listHighlights(marks, key) {
  const list = marks && marks.highlights ? marks.highlights[String(key || '')] : null;
  return Array.isArray(list) ? list.slice() : [];
}

export function countHighlights(marks, key) {
  if (key != null) return listHighlights(marks, key).length;
  let n = 0;
  const h = (marks && marks.highlights) || {};
  for (const k of Object.keys(h)) n += (h[k] || []).length;
  return n;
}

/**
 * 在一段正文里找出所有划线的出现区间（按文本匹配，第一次出现为准）。
 * DOM 侧拿这个区间去加 class，不必自己再实现一遍匹配。
 * @param {string} text        当前页面的正文（用于定位）
 * @param {Array}  highlights  listHighlights 的结果
 * @returns {Array<{id, text, start, end}>} start/end 是「在 text 里」的字符下标
 */
export function locateHighlights(text, highlights) {
  const s = String(text || '');
  const out = [];
  let cursor = 0;         /* 只往后找，避免同一短语被反复匹配到同一处 */
  for (const h of (highlights || [])) {
    const t = h && h.text;
    if (!t) continue;
    let idx = s.indexOf(t, cursor);
    if (idx < 0) idx = s.indexOf(t);        /* 允许回绕一次（段落顺序可能与拼接顺序不同） */
    if (idx < 0) continue;
    out.push({ id: h.id, text: t, at: h.at || 0, note: h.note || '', start: idx, end: idx + t.length });
    cursor = idx + t.length;
  }
  return out;
}

/** 标记总览（面板/设置页展示用） */
export function marksSummary(marks, key) {
  return {
    words: countWordMarks(marks),
    highlights: countHighlights(marks, key),
    highlightsAll: countHighlights(marks, null)
  };
}
