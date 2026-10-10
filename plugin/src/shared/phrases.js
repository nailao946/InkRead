/* 墨读 InkRead — 插件端词组索引（纯 ESM，零浏览器依赖）
 * ============================================================================
 * 数据来源
 *   源：web/dict/phrases.js（window.IR_PHRASES = {...}）
 *   落盘：plugin/data/phrases.json（由 tools 脚本把上述单行文件 JSON.parse 后紧凑写出）
 *   词源：ECDICT「多词条目」经 tools/build_phrases.py 两级过滤产出——
 *     ① 剔除领域术语（译文以 [医]/[化]/[机]/[计]… 领起）；
 *     ② 要求词组含功能词（介词/小品词/冠词/代词/连词…），剔除名词性复合词。
 *
 * 同步约束（重要）
 *   web/dict/phrases.js 与 plugin/data/phrases.json 是同一份词组表的两个形态。
 *   源表只由 tools/build_phrases.py 重建，二选一改了，另一个必须用脚本同步重建，
 *   不要手改其中一份——否则网页端与插件端词组识别出现不一致。
 *
 * match 匹配规则（与 web/js/phrases.js 逐字对齐）
 *   1) 从 items[i] 当前词出发，按其词形还原候选 [原形, 基形1…] 查「首词索引」，做最长匹配；
 *   2) 数组按 t.length 降序，优先命中更长的词组；
 *   3) 同长度时让「基形」盖过「原形」：tearing down 与 tear down 都在词典里时取 tear down
 *      （释义更全，且不同时态归到同一基形）。判定依据：候选下标 ci>0 视为基形；
 *   4) 分隔符必须是纯空白（/^\s+$/）：'tear , down' 这种夹非空白的，不匹配；
 *   5) 逐词用 lemmas() 做词形还原（tearing → tear），命中整组才成立；
 *   6) 不属于词组 / 索引未就绪 / 当前项不是词(w) → 返回 null。
 *
 * items 形状：[{ t: 'w' | 'x', s: string }]（词/分隔符交替），与 web 端 IR.tokenize 一致。
 * ==========================================================================*/

import { lemmas } from './text.js';

/* 按「首词」建索引，便于从当前 token 出发做最长匹配。
 * 与 web/js/phrases.js buildIndex 完全一致：index = Map<首词, [{t:[tokens], w:base, m:meaning}]>，按 t.length 降序。 */
export function buildPhraseIndex(obj) {
  const idx = new Map();
  for (const w in obj) {
    const toks = w.split(' ');
    const arr = idx.get(toks[0]) || [];
    arr.push({ t: toks, w: w, m: obj[w] });
    idx.set(toks[0], arr);
  }
  for (const arr of idx.values()) arr.sort((a, b) => b.t.length - a.t.length);  // 长的在前
  return idx;
}

/* 与渲染侧共用的口语化分词正则（带 /g，仅在 tokenizeItems 里按次重置 lastIndex 使用） */
const TOK_RE = /[A-Za-z][A-Za-z'’\-]*/g;

/**
 * 把一段文本切成 items：词 / 分隔符交替，并带**字符偏移**。
 * 形状与 web/js/reader.js 的 IR.tokenize 完全一致（[文本,单词,文本,…]），
 * 多的 start 只是给「词组区间扫描」定位用，不参与匹配。
 * @returns {Array<{t:'w'|'x', s:string, start:number}>}
 */
export function tokenizeItems(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  TOK_RE.lastIndex = 0;
  let last = 0, m;
  while ((m = TOK_RE.exec(s))) {
    if (m.index > last) out.push({ t: 'x', s: s.slice(last, m.index), start: last });
    out.push({ t: 'w', s: m[0], start: m.index });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'x', s: s.slice(last), start: last });
  return out;
}

/**
 * 扫描一段文本，返回词组在**原文里的字符区间**：[[start, end, base, meaning], …]
 *   · 已按出现顺序排列，且互不重叠（后一个匹配从上一次的末尾之后继续）；
 *   · end 为独占下标，`text.slice(start, end)` 即词组的原文形态；
 *   · 只返回词典收录的常用词组（启发式短语动词不在本函数职责内）。
 *
 * 之所以把「扫描」放后台而不是内容脚本：
 *   content script 是经典脚本、不能 import ESM，若在页面侧再写一份匹配器，
 *   两处实现迟早漂移；而词组表 950KB 也只应该在 SW 里解析一次、给所有页面共用。
 *
 * @param {{isLoaded:Function, match:Function}} phr createPhrases() 的实例
 * @param {string} text
 */
export function scanPhrases(phr, text) {
  if (!phr || typeof phr.match !== 'function' || typeof phr.isLoaded !== 'function' || !phr.isLoaded()) return [];
  const items = tokenizeItems(text);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.t !== 'w') continue;
    const m = phr.match(items, i);
    if (!m || m.n < 2) continue;
    const lastIdx = i + m.n * 2 - 2;
    const last = items[lastIdx];
    if (!last || last.t !== 'w') continue;
    out.push([it.start, last.start + last.s.length, m.base, m.meaning]);
    i = lastIdx;                 /* 消费掉整组，避免词组内部再起匹配 */
  }
  return out;
}

/* 创建一个词组识别实例。返回 { load, isLoaded, size, get, match }。 */
export function createPhrases() {
  let map = null;                 // { "tear down": "扯下, 拆卸", ... }
  let index = null;               // firstToken → [{ t:[tokens], w:base, m:meaning }]

  /* 注入词组表（来自 JSON），建索引 */
  function load(obj) {
    if (!obj || typeof obj !== 'object') return false;
    map = obj;
    index = buildPhraseIndex(obj);
    return true;
  }

  const isLoaded = () => !!map;
  const size = () => (map ? Object.keys(map).length : 0);   /* 诊断用：收录了多少条词组 */

  /* 某个词组基形（全小写、单词间单空格）的离线释义；没有返回 '' */
  function get(base) {
    if (!map || !base) return '';
    return map[String(base).toLowerCase()] || '';
  }

  /* 文本 token 是否与词组逐词对应：支持词形还原（tearing → tear），分隔符必须是纯空白 */
  function fits(items, i, toks) {
    for (let k = 0; k < toks.length; k++) {
      const at = items[i + k * 2];
      if (!at || at.t !== 'w') return false;
      if (k) {
        const sep = items[i + k * 2 - 1];
        if (!sep || sep.t !== 'x' || !/^\s+$/.test(sep.s)) return false;
      }
      const cands = lemmas(at.s);
      if (!cands.some(x => x === toks[k])) return false;
    }
    return true;
  }

  /* 返回从第 i 项起的最长词组匹配：{ n: 单词数, base: 基形, meaning: 中文 } 或 null */
  function match(items, i) {
    if (!index || i >= items.length || items[i].t !== 'w') return null;
    /* lemmas 顺序 [原形, 基形1, 基形2…]；同长度时让「基形」盖过「原形」 */
    let best = null;
    const cands = lemmas(items[i].s);
    for (let ci = 0; ci < cands.length; ci++) {
      const arr = index.get(cands[ci]);
      if (!arr) continue;
      for (const ph of arr) {
        if (best) {
          if (ph.t.length < best.n) continue;                 // 比现有匹配短
          if (ph.t.length === best.n && !(ci > 0 && !best.isBase)) continue;  // 同长只让基形翻盘
        }
        if (fits(items, i, ph.t)) best = { n: ph.t.length, base: ph.w, meaning: ph.m, isBase: ci > 0 };
      }
    }
    return best ? { n: best.n, base: best.base, meaning: best.meaning } : null;
  }

  return { load, isLoaded, size, get, match };
}
