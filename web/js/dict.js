/* 墨读 InkRead — M3 离线英汉词典
   命名空间 IR.dict：基于 ECDICT 的分片 JSON + IndexedDB 缓存，无需联网 / API key。
   分片文件：dict/a.json … dict/z.json + dict/other.json（按首字母分片）
   单条结构：{ p: 音标, t: 中文释义, pos: 词性 }（字段名简短以省体积；word 全小写为 key）
   查询流程：内存缓存 → IndexedDB（首次按需 fetch 对应分片并批量入库）→ 命中返回
   支持词形还原（复用 IR.lemmas 思路：复数 / 时态 / 进行时 / 比较级等）
   file:// 协议下 fetch 会失败，这里静默降级（返回 null，不抛未捕获异常） */
window.IR = window.IR || {};

IR.dict = (function () {
  const mem = new Map();        // word(lowercase) -> { p, t, pos }
  const loaded = new Set();     // 已加载到内存的分片字母
  const pending = new Map();    // 正在加载的分片字母 -> Promise（避免并发重复加载）
  let dbReady = null;
  const DICT_STORE = 'dict';

  function shardName(word) {
    const c = (word[0] || '').toLowerCase();
    return (c >= 'a' && c <= 'z') ? c : 'other';
  }

  function normalize(w) {
    return String(w == null ? '' : w).toLowerCase().replace(/[’]/g, "'").trim();
  }

  /* 确保 IndexedDB 已就绪（可选；失败/不可用时降级为纯内存） */
  function ensureDB() {
    if (dbReady) return dbReady;
    dbReady = (async () => {
      try {
        if (typeof IR.openDB === 'function') await IR.openDB();
      } catch (e) { /* 忽略：降级为内存模式 */ }
      return !!(IR.db && typeof indexedDB !== 'undefined');
    })();
    return dbReady;
  }

  function idbGet(letter) {
    return new Promise((resolve) => {
      try {
        const tx = IR.db.transaction(DICT_STORE, 'readonly');
        const req = tx.objectStore(DICT_STORE).get(letter);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  function idbPut(letter, data) {
    return new Promise((resolve) => {
      try {
        const tx = IR.db.transaction(DICT_STORE, 'readwrite');
        tx.objectStore(DICT_STORE).put({ letter, data });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  }

  /* 加载某个首字母分片到内存（先查 IndexedDB，未命中再加载）
     优先用 <script> 标签加载 dict/<letter>.js（file:// 双击打开也能用），
     fetch JSON 仅在 HTTP 下作为兜底。 */
  async function loadShard(letter) {
    if (loaded.has(letter)) return true;
    if (pending.has(letter)) return pending.get(letter);

    const p = (async () => {
      try {
        await ensureDB();
        if (IR.db && typeof indexedDB !== 'undefined') {
          const rec = await idbGet(letter);
          if (rec && rec.data) {
            for (const k in rec.data) mem.set(k, rec.data[k]);
            loaded.add(letter);
            return true;
          }
        }
        let data = loadShardViaScript(letter);
        if (data == null) data = await loadShardViaFetch(letter);
        if (!data || typeof data !== 'object') {
          loaded.add(letter);   // 标记“已尝试”，避免同会话内反复加载失败
          return false;
        }
        for (const k in data) mem.set(k, data[k]);
        loaded.add(letter);
        if (IR.db && typeof indexedDB !== 'undefined') idbPut(letter, data);  // 回填缓存，二次查询秒回
        return true;
      } catch (e) {
        return false;
      } finally {
        pending.delete(letter);
      }
    })();
    pending.set(letter, p);
    return p;
  }

  /* 用 <script> 标签同步/异步加载 dict/<letter>.js（window.IR_DICT_<letter> = {...}）
     file:// 下 fetch 被 CORS 拦截，但 <script> 可加载同目录 JS，故离线也能用。 */
  function loadShardViaScript(letter) {
    const gname = 'IR_DICT_' + letter;
    if (window[gname]) return window[gname];
    try {
      const s = document.createElement('script');
      s.src = 'dict/' + letter + '.js';
      s.async = false;
      document.head.appendChild(s);
      if (window[gname]) return window[gname];
    } catch (e) { /* document 不可用（Node 测试环境） */ }
    return null;
  }

  async function loadShardViaFetch(letter) {
    try {
      const res = await fetch('dict/' + letter + '.json', { cache: 'force-cache' });
      if (res && res.ok) return await res.json();
    } catch (e) { /* file:// 下 fetch 失败，静默降级 */ }
    return null;
  }

  /* ---------- 公开 API ---------- */

  /* ready() → Promise：初始化（打开）词典用的 IndexedDB 存储；失败不 reject */
  function ready() { return ensureDB().then(() => undefined); }

  /* lookup(word) → Promise<{word, phonetic, meaning, pos} | null>
     先查内存缓存，再按需加载分片（含词形还原候选），返回 null 表示未查到 */
  async function lookup(rawWord) {
    const w = normalize(rawWord);
    if (!w) return null;
    const cands = (typeof IR.lemmas === 'function') ? IR.lemmas(w) : [w];
    if (!cands || !cands.length) return null;
    const letters = Array.from(new Set(cands.map(shardName)));
    await Promise.all(letters.map(loadShard));
    for (const c of cands) {
      const e = mem.get(c);
      if (e) {
        return { word: c, phonetic: e.p || '', meaning: e.t || '', pos: e.pos || '' };
      }
    }
    return null;
  }

  /* 测试辅助：直接注入内存缓存 / 计算分片名（不依赖 fetch/IDB） */
  function _setMem(obj) { for (const k in obj) mem.set(k, obj[k]); }
  function _resetCache() { mem.clear(); loaded.clear(); pending.clear(); }

  return { ready, lookup, _shardName: shardName, _normalize: normalize, _setMem, _resetCache };
})();
