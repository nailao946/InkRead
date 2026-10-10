/* InkRead Video — 三端共享词库（vocab.json）的合并 / 写回纯逻辑
 *
 * 「一个位置、三端同步」的落点就是存档目录里的 vocab.json：
 *   桌面版（WPF 内置服务） / 网页版（start-server → serve.py） / 浏览器扩展
 *   三者读写同一份 <存档目录>/vocab.json。
 *
 * 托盘格式（与 web/js/filestore.js 的 IR.vocab.cache 完全一致）：
 *   [ { word, display, meaning, status, source, addedAt, updatedAt }, … ]
 *
 * 本模块只做纯函数（不碰 chrome.* / DOM / 磁盘），Node 可直接单测。
 */
import { normalizeStatus, statusStrict } from './vocab-source.js';

/** 插件写回时打的来源标记，便于在 Excel / 桌面版里区分 */
export const PLUGIN_SOURCE = 'inkread-plugin';

/** 合法词形：至少含一个字母/数字的词（挡住 ','、'   ' 这类脏 key 写进词库） */
const WORD_RE = /^[\p{L}\p{N}'’\-]{1,64}$/u;

/** 取词条的原形 key（小写）。桌面版写的是 word，个别备份只有 display。 */
export function entryWord(e) {
  if (!e || typeof e !== 'object') return '';
  return String(e.word || e.display || '').trim().toLowerCase();
}

/** 词条数组 → Map<word, status>（复用墨读那套状态归一，容忍中文状态） */
export function entriesToStatusMap(list) {
  const m = new Map();
  for (const e of list || []) {
    const w = entryWord(e);
    if (!w) continue;
    m.set(w, normalizeStatus(e.status, 'new'));
  }
  return m;
}

/** 标记模型里的 words（{word:{status}}）→ {word: status} */
export function marksToChanges(words) {
  const out = {};
  const src = words || {};
  for (const k of Object.keys(src)) {
    const w = String(k || '').trim().toLowerCase();
    if (!w) continue;
    const st = src[k] && src[k].status;
    if (!st) continue;
    out[w] = st;
  }
  return out;
}

/**
 * 把 {word: status} 的改动合并进墨读词条数组（原地不动，返回新数组）。
 *   · 已存在的词：只改 status + updatedAt（保留 meaning / display / addedAt 等原字段）
 *   · 新词：追加 {word, display, meaning:'', status, source:'inkread-plugin', addedAt, updatedAt}
 * 状态未变化的词会被跳过，因此「重复推送同一批标记」不会造成文件抖动。
 *
 * @param {Array} list      现有 vocab.json 内容（可为 null）
 * @param {object} changes  {word: status}
 * @param {number} now      时间戳
 * @returns {{entries:Array, added:number, updated:number, changed:number}}
 */
export function upsertEntries(list, changes, now) {
  const src = Array.isArray(list) ? list.filter(e => e && typeof e === 'object') : [];
  const at = now || Date.now();
  const idx = new Map();
  src.forEach((e, i) => { const w = entryWord(e); if (w && !idx.has(w)) idx.set(w, i); });

  let added = 0, updated = 0;
  for (const raw of Object.keys(changes || {})) {
    const w = String(raw || '').trim().toLowerCase();
    if (!w || !WORD_RE.test(w)) continue;
    const st = statusStrict(changes[raw], '');
    if (!st) continue;
    const i = idx.get(w);
    if (i == null) {
      idx.set(w, src.length);
      src.push({
        word: w, display: w, meaning: '', status: st,
        source: PLUGIN_SOURCE, addedAt: at, updatedAt: at
      });
      added++;
    } else if (statusStrict(src[i].status, '') !== st) {
      src[i] = { ...src[i], status: st, updatedAt: at };
      updated++;
    }
  }
  return { entries: src, added, updated, changed: added + updated };
}

/** 只做比对，不产出新数组：判断一次推送会不会真的改文件 */
export function wouldChange(list, changes) {
  return upsertEntries(list, changes, 0).changed > 0;
}

/** 存档目录里 vocab.json 写的格式（与 filestore.writeJson 一致：1 空格缩进） */
export function stringifyVocab(entries) {
  return JSON.stringify(entries || [], null, 1);
}

/** 从文本解析 vocab.json；容忍 BOM 与墨读备份对象（{vocab:[…]}） */
export function parseVocabText(text) {
  let s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  s = s.trim();
  if (!s) return [];
  const data = JSON.parse(s);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.vocab)) return data.vocab;
  return [];
}
