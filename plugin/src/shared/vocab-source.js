/* InkRead Video — 词表来源：本地服务（墨读自带）与文件导入
 *
 * 联动原理：墨读桌面版/网页版都内置本地服务，提供 /__store 端点（带 CORS `*`），
 *   记事本目录 = 存档目录，vocab.json = [{word,display,meaning,status,...}]。
 *   扩展探测端口 → 读 settings.json 拿到用户自定义 storageDir → 读 vocab.json。
 * 兜底：墨读没开时，用户可导入「导出备份 JSON / vocab.json / vocab.csv / 纯词表 txt」。
 */
import { fetchWithTimeout } from './api.js';

/* ---------- 本地服务探测 ---------- */
export const LINK_SOURCE = { local: '墨读本地服务', file: '导入文件', none: '未联动' };

function bases(custom, ports) {
  if (custom) return [String(custom).replace(/\/+$/, '')];
  const out = [];
  const seen = new Set();
  const push = u => { if (!seen.has(u)) { seen.add(u); out.push(u); } };
  for (const p0 of ports || []) {
    for (let i = 0; i < 10; i++) push(`http://127.0.0.1:${p0 + i}`);
  }
  return out;
}

/** 探测单个 base 是否为墨读本地服务 */
export async function probeBase(base, timeoutMs) {
  try {
    const r = await fetchWithTimeout(base + '/__store/ping', { cache: 'no-store' }, timeoutMs || 1500);
    if (!r.ok) return null;
    const j = await r.json();
    if (j && (j.store || j.store === 1)) return { base, root: j.root || '' };
  } catch (e) { /* 连接失败＝不是 */ }
  return null;
}

/** 依次探测候选端口，返回第一个可用的本地服务 */
export async function detectServer(opts) {
  const { custom, ports, timeoutMs } = opts || {};
  for (const b of bases(custom, ports)) {
    const hit = await probeBase(b, timeoutMs);
    if (hit) return hit;
  }
  return null;
}

/** 从本地服务读词表（自动带上用户自定义存档目录） */
export async function readVocabFromServer(base, timeoutMs) {
  /* 1) 先读 settings.json 拿 storageDir（用户可能改了存档目录） */
  let root = '';
  try {
    const r = await fetchWithTimeout(`${base}/__store/read?path=settings.json`, { cache: 'no-store' }, timeoutMs || 2500);
    if (r.ok) {
      const txt = await r.text();
      const data = JSON.parse(txt);
      root = (data && data.settings && data.settings.storageDir) || '';
    }
  } catch (e) { /* 用默认目录 */ }

  /* 2) 读 vocab.json */
  const url = `${base}/__store/read?path=vocab.json` + (root ? '&root=' + encodeURIComponent(root) : '');
  const r = await fetchWithTimeout(url, { cache: 'no-store' }, timeoutMs || 3000);
  if (!r.ok) throw new Error('读取 vocab.json 失败：HTTP ' + r.status);
  const txt = await r.text();
  const arr = JSON.parse(txt);
  const entries = toEntryPairs(Array.isArray(arr) ? arr : []);
  return { entries, count: entries.length, root, label: root ? `墨读 · ${root}` : '墨读 · 默认存档目录' };
}

/* ---------- 状态归一化 ---------- */
const STATUS_ALIAS = {
  known: 'known', learning: 'learning', new: 'new',
  已学: 'known', 已掌握: 'known', 熟词: 'known', 认识: 'known',
  在学: 'learning', 学习中: 'learning', 半熟: 'learning',
  生词: 'new', 生词本: 'new', 未知: 'new', unknown: 'new', 新增: 'new'
};

export function normalizeStatus(s, fallback) {
  const k = String(s == null ? '' : s).trim();
  if (!k) return fallback || 'new';
  return STATUS_ALIAS[k] || STATUS_ALIAS[k.toLowerCase()] || fallback || 'new';
}

/** 墨读词条数组 → [[word, status], …]（去重，后者覆盖前者） */
export function toEntryPairs(list) {
  const m = new Map();
  for (const e of list || []) {
    if (!e) continue;
    const w = String(e.word || e.display || '').trim().toLowerCase();
    if (!w) continue;
    m.set(w, normalizeStatus(e.status, 'new'));
  }
  return Array.from(m.entries());
}

/* ---------- 文件解析 ---------- */
/** 纯文本词表：每行 `单词` 或 `单词 释义`（空格/逗号/Tab 分隔），`#` 开头忽略 */
export function parseVocabLines(text, defaultStatus) {
  const out = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    line = line.split(/[\t,;]|\s{2,}|\s(?=[\u4e00-\u9fa5])/)[0];   /* 释义部分（含中文）切掉 */
    const w = line.split(/\s+/)[0].trim().toLowerCase();
    if (!/^[a-z][a-z'’\-]*$/i.test(w)) continue;
    out.set(w, defaultStatus || 'known');
  }
  return Array.from(out.entries());
}

/** 墨读词表 CSV（filestore.csvVocab 产物，UTF-8 BOM，列：单词,原形,释义,状态,来源,加入时间,更新时间） */
export function parseVocabCsv(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const lines = s.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const splitRow = line => {
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells;
  };
  const head = splitRow(lines[0]).map(h => h.trim());
  const ci = name => head.findIndex(h => h === name);
  const iWord = ci('原形') >= 0 ? ci('原形') : ci('单词');
  const iDisplay = ci('单词');
  const iStatus = ci('状态');
  if (iWord < 0 && iDisplay < 0) return [];       /* 不是墨读 CSV */
  const m = new Map();
  for (let i = 1; i < lines.length; i++) {
    const c = splitRow(lines[i]);
    const w = String((iWord >= 0 ? c[iWord] : '') || (iDisplay >= 0 ? c[iDisplay] : '') || '').trim().toLowerCase();
    if (!w) continue;
    m.set(w, normalizeStatus(iStatus >= 0 ? c[iStatus] : '', 'new'));
  }
  return Array.from(m.entries());
}

/**
 * 解析任意墨读词表文件。
 * @param {string} name 文件名
 * @param {string} text 内容
 * @param {object} opts { defaultStatus }
 * @returns {{entries:[[string,string][]], label:string, kind:string}}
 */
export function parseVocabFile(name, text, opts) {
  const defaultStatus = (opts && opts.defaultStatus) || 'known';
  const ext = (String(name).match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  let entries = [], kind = 'txt';

  /* 先试 JSON：墨读备份 / vocab.json 数组 */
  if (ext === 'json' || /^\s*[[{]/.test(String(text))) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data)) { entries = toEntryPairs(data); kind = 'vocab-json'; }
      else if (data && Array.isArray(data.vocab)) { entries = toEntryPairs(data.vocab); kind = data.kind === 'full' ? 'backup' : 'backup'; }
      else if (data && data.app && data.app !== 'inkread') throw new Error('不是墨读文件（app=' + data.app + '）');
      else if (data) throw new Error('JSON 里没有找到词表（需要 vocab 数组或墨读备份）');
    } catch (e) {
      if (kind !== 'txt' || /^[[{]/.test(String(text).trim())) throw e;
    }
  }

  if (!entries.length && (ext === 'csv' || /^单词|^word,/i.test(text))) {
    const e2 = parseVocabCsv(text);
    if (e2.length) { entries = e2; kind = 'vocab-csv'; }
  }

  if (!entries.length) { entries = parseVocabLines(text, defaultStatus); kind = 'txt'; }

  const labels = { backup: '墨读备份', 'vocab-json': 'vocab.json', 'vocab-csv': 'vocab.csv', txt: '纯词表' };
  return { entries, label: labels[kind] || kind, kind };
}
