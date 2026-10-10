/* InkRead Video — 设置与缓存（chrome.storage.local） */
import { get, set, del } from './api.js';

export const DEFAULT_SETTINGS = {
  v: 1,
  link: {
    mode: 'auto',          /* auto=自动探测本地服务并读取词表 | manual=只用导入的词表 | off=不联动（空词库） */
    serverUrl: '',         /* 自定义本地服务地址（留空＝自动探测 17890 / 8642 起） */
    ports: [17890, 8642]   /* 起始端口：桌面版 17890，网页版 serve.py 8642 */
  },
  ui: { badge: true, badgeSide: 'right' },
  subs: { preferEn: true, autoAnalyze: true, minTokens: 80 },
  cache: { ttlHours: 6, maxReports: 60 }
};

const SETTINGS_KEY = 'iv.settings';
const VOCAB_KEY = 'iv.vocab';
const AN_PREFIX = 'an.';
const AN_INDEX = 'iv.anIndex';

function deepMerge(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k], bv = base[k];
    out[k] = (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv))
      ? deepMerge(bv, pv) : pv;
  }
  return out;
}

export async function getSettings() {
  const r = await get('local', SETTINGS_KEY);
  return deepMerge(DEFAULT_SETTINGS, r[SETTINGS_KEY] || {});
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = deepMerge(cur, patch || {});
  await set('local', { [SETTINGS_KEY]: next });
  return next;
}

export async function resetSettings() {
  await del('local', SETTINGS_KEY);
  return getSettings();
}

/* ---------- 词库缓存 ----------
   结构：{ at, source, label, entries: [[word, status], …] }
   entries 存数组对最省空间；status ∈ known | learning | new  */
export async function getVocab() {
  const r = await get('local', VOCAB_KEY);
  return r[VOCAB_KEY] || null;
}

export async function setVocab(source, label, entries) {
  const rec = { at: Date.now(), source, label, count: entries.length, entries };
  await set('local', { [VOCAB_KEY]: rec });
  return rec;
}

export async function clearVocab() { await del('local', VOCAB_KEY); }

/** entries:[[w,s]] → Map<word, status>（扩展内的统一词库表示） */
export function vocabToMap(rec) {
  const m = new Map();
  if (rec && Array.isArray(rec.entries)) {
    for (const pair of rec.entries) {
      if (Array.isArray(pair) && pair[0]) m.set(String(pair[0]).toLowerCase(), pair[1] || 'new');
    }
  }
  return m;
}

/* ---------- 分析结果缓存 ---------- */
export async function getReport(key) {
  const r = await get('local', AN_PREFIX + key);
  return r[AN_PREFIX + key] || null;
}

export async function putReport(key, report, settings) {
  const s = settings || await getSettings();
  const r = await get('local', AN_INDEX);
  const idx = r[AN_INDEX] || {};
  idx[key] = Date.now();
  /* 先清理过期，再按数量上限裁剪最旧的 */
  const ttl = (s.cache.ttlHours || 6) * 3600 * 1000;
  const now = Date.now();
  const keys = Object.keys(idx).sort((a, b) => idx[b] - idx[a]);
  const drop = [];
  keys.forEach((k, i) => { if (now - idx[k] > ttl || i >= (s.cache.maxReports || 60)) drop.push(k); });
  if (drop.length) {
    await del('local', drop.map(k => AN_PREFIX + k));
    drop.forEach(k => delete idx[k]);
  }
  await set('local', { [AN_PREFIX + key]: report, [AN_INDEX]: idx });
  return report;
}

export async function clearReports() {
  const r = await get('local', AN_INDEX);
  const idx = r[AN_INDEX] || {};
  const keys = Object.keys(idx).map(k => AN_PREFIX + k);
  if (keys.length) await del('local', keys);
  await del('local', AN_INDEX);
}

export async function clearAll() {
  await clearReports();
  await clearVocab();
}

/** 报告是否仍然新鲜 */
export function isFresh(report, settings, ttlMs) {
  if (!report || !report.at) return false;
  const ttl = ttlMs || ((settings && settings.cache.ttlHours) || 6) * 3600 * 1000;
  return Date.now() - report.at < ttl;
}
