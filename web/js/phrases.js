/* 墨读 InkRead — 常用词组索引（数据驱动的词组识别 + 词组离线翻译）
   数据源：与离线词典同源的 ECDICT「多词条目」，由 tools/build_phrases.py 两级过滤后
   产出 web/dict/phrases.js → window.IR_PHRASES = { "tear down": "扯下, 拆卸", ... }
     ① 剔除领域术语（译文以 [医]/[化]/[机]/[计]… 领起）；
     ② 要求词组含功能词（介词 / 小品词 / 冠词 / 代词 / 连词…），剔除名词性复合词。
   —— 数据驱动的好处：词组表来自真实词典，覆盖 2 万+ 条，且可随时用脚本重建 / 增补，
      不用手写词表。识别不到时再由 util.js 的短语动词启发式兜底（IR.phraseLen）。
   用途：
     1) 阅读渲染时识别词组 → 一条不断的线（IR.phraseMatch）；
     2) 点词组直接给整组中文（离线，不消耗翻译接口）。
   加载：IndexedDB 缓存 → <script> 载入 dict/phrases.js（file:// 与 http:// 均可用）。 */
window.IR = window.IR || {};

IR.phrases = (function () {
  const KEY = '__phrases__';     // 与词典分片共用 dict 对象仓，用固定 key 区分
  let map = null;                // { "tear down": "扯下, 拆卸", ... }
  let index = null;              // firstToken → [{ t:[tokens], w:base, m:meaning }]
  let loading = null;

  /* 按「首词」建索引，便于从当前 token 出发做最长匹配 */
  function buildIndex(obj) {
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

  function adopt(obj, cache) {
    if (!obj || typeof obj !== 'object') return false;
    map = obj;
    index = buildIndex(obj);
    if (cache) idbPut(obj);
    return true;
  }

  function idbPut(obj) {
    try {
      if (!IR.db || typeof indexedDB === 'undefined') return;
      IR.db.transaction('dict', 'readwrite').objectStore('dict').put({ letter: KEY, data: obj });
    } catch (e) { /* 忽略：仅少一层离线缓存 */ }
  }

  function idbGet() {
    return new Promise(resolve => {
      try {
        if (!IR.db || typeof indexedDB === 'undefined') return resolve(null);
        const req = IR.db.transaction('dict', 'readonly').objectStore('dict').get(KEY);
        req.onsuccess = () => resolve(req.result ? req.result.data : null);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  /* 用 <script> 载入 dict/phrases.js（file:// 下 fetch 会被 CORS 拦，script 不会）。
     注意：动态插入的 <script> 是异步执行的，插完立刻读 window.IR_PHRASES 一定是 undefined，
     必须等 onload —— 所以这里返回 Promise。 */
  function viaScript() {
    return new Promise(resolve => {
      if (window.IR_PHRASES) return resolve(window.IR_PHRASES);
      let s;
      try { s = document.createElement('script'); } catch (e) { return resolve(null); }  /* Node 测试环境 */
      let settled = false;
      const finish = obj => {
        if (settled) return;
        settled = true;
        resolve(obj || window.IR_PHRASES || null);
      };
      s.src = 'dict/phrases.js';
      s.async = true;
      s.onload = () => finish(window.IR_PHRASES);
      s.onerror = () => finish(null);
      setTimeout(() => finish(window.IR_PHRASES), 8000);   /* 兜底：别把"打开书"卡死 */
      try { document.head.appendChild(s); } catch (e) { finish(null); }
    });
  }

  /* 确保词组索引就绪（幂等）；失败返回 false，词组识别退回启发式 */
  function ensure() {
    if (map) return Promise.resolve(true);
    if (loading) return loading;
    loading = (async () => {
      try {
        const cached = await idbGet();
        if (cached && adopt(cached, false)) return true;
        const obj = await viaScript();
        if (obj && adopt(obj, true)) return true;
      } catch (e) { /* 静默降级 */ }
      return false;
    })();
    return loading;
  }

  const isLoaded = () => !!map;
  const size = () => (map ? Object.keys(map).length : 0);   /* 诊断用：收录了多少条词组 */

  /* 某个词组基形（全小写、单词间单空格）的离线释义；没有返回 '' */
  function get(base) {
    if (!map || !base) return '';
    return map[String(base).toLowerCase()] || '';
  }

  /* items: [{t:'w'|'x', s}]（见 IR.tokenize）。返回从第 i 项起的最长词组匹配：
     { n: 单词数, base: 基形, meaning: 中文 } 或 null（不是词组 / 索引未就绪） */
  function match(items, i) {
    if (!index || i >= items.length || items[i].t !== 'w') return null;
    /* IR.lemmas 的顺序是 [原形, 基形1, 基形2…]（如 tearing → tearing / tear / teare）。
       同长度时让「基形」盖过「原形」：tearing down 与 tear down 都在词典里时，
       取 tear down（释义更全，且不同时态的出现会归到同一个基形上）。 */
    let best = null;
    const cands = IR.lemmas(items[i].s);
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

  /* 文本 token 是否与词组逐词对应：支持词形还原（tearing → tear），分隔符必须是纯空白 */
  function fits(items, i, toks) {
    for (let k = 0; k < toks.length; k++) {
      const at = items[i + k * 2];
      if (!at || at.t !== 'w') return false;
      if (k) {
        const sep = items[i + k * 2 - 1];
        if (!sep || sep.t !== 'x' || !/^\s+$/.test(sep.s)) return false;
      }
      const cands = IR.lemmas(at.s);
      if (!cands.some(x => x === toks[k])) return false;
    }
    return true;
  }

  /* 测试辅助：直接注入词组表 */
  function _set(obj) { return adopt(obj, false); }
  function _reset() { map = null; index = null; loading = null; }

  return { ensure, isLoaded, size, get, match, _set, _reset };
})();
