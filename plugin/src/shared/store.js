/* InkRead Video — 设置与缓存（chrome.storage.local） */
import { get, set, del } from './api.js';
import { MARKS_KEY, DEFAULT_MARKS, normalizeMarks } from './marks.js';

export const DEFAULT_SETTINGS = {
  v: 2,
  link: {
    mode: 'auto',          /* auto=自动探测本地服务并读取词表 | manual=只用导入的词表 | off=不联动（空词库） */
    serverUrl: '',         /* 自定义本地服务地址（留空＝自动探测 17890 / 8642 起） */
    ports: [17890, 8642],  /* 起始端口：桌面版 17890，网页版 serve.py 8642 */
    dirName: '',           /* 已绑定的存档目录名（句柄本体存 IndexedDB；这里只做展示） */
    pcRoot: '',            /* 探测到的「墨读」PC 端存档根目录（绝对路径）——绑定目录时的默认起点 */
    autoBind: true,        /* 绑定时默认跳到 pcRoot（= PC 端同一个目录），并用同一份 vocab.json */
    writeBack: true        /* 插件里的词标记是否写回共享 vocab.json（三端一致的关键开关） */
  },
  ui: {
    badge: true,
    badgeSide: 'right',    /* 旧字段：仅在没存过拖动位置时决定默认靠哪边（right=右，left=左） */
    pos: null              /* 拖动后的位置，视口比例 {x,y}（0–1）；null=默认「右侧垂直居中」 */
  },
  subs: {
    preferEn: true,       /* 有多条字幕轨时优先英文轨 */
    autoAnalyze: true,    /* 进视频页自动分析 */
    minTokens: 80,        /* 字幕词数低于此值认为样本不足 */
    mark: true,           /* 播放器字幕逐词上色（点词查释义 / 改标记） */
    markStyle: 'line'     /* 字幕上色样式：line=着色+下划线 | mark=加半透明底 */
  },
  /* 在线翻译：引擎配置形状与「墨读」网页版 settings.json 的 settings.api 完全一致，
     所以能直接把 PC 端的 API Key 导入过来（设置页 → 翻译接口 → 从墨读导入）。
     请求统一走墨读本地服务的 /__proxy 转发（联动 PC 端，且零新增主机权限）。 */
  api: {
    engine: 'auto',            /* auto=按 autoOrder 依次尝试已配置的引擎 | 具体 id=只用它 */
    autoOrder: [],             /* 自定义尝试顺序（留空＝用默认 AUTO_ENGINES 顺序） */
    youdao: { key: '', apiKeys: '', secret: '' },
    tencent: { secretId: '', secretKey: '', region: 'ap-guangzhou' },
    aliyun: { apiKey: '', model: '' },
    alimt: { accessKeyId: '', accessKeySecret: '', edition: 'general', scene: 'social' },
    volcano: { apiKey: '', model: '' },
    volmt3: { apiKey: '', resourceId: 'volc.speech.mt' },
    volmt: { accessKeyId: '', accessKeySecret: '' },
    deepl: { apiKey: '' },
    ms: { apiKey: '', region: '' },
    libre: { url: '', apiKey: '' },
    proxy: { on: false, url: '' },
    importedAt: 0              /* 上次从墨读 settings.json 导入的时间戳 */
  },
  translate: {
    enabled: true,             /* 在线翻译总开关 */
    viaLocal: true,            /* 优先走墨读本地服务转发（关掉则直连，可能被 CORS 拦） */
    paraTrans: true,           /* 文章阅读模式显示「译」按钮（逐段翻译） */
    phraseAuto: true           /* 词组离线库未命中时，自动在线翻译整组 */
  },
  phrases: {
    enabled: true,             /* 启用离线词组库（2.4 万条）：识别词组 + 给出整组中文 */
    underline: true            /* 词组在正文里画一条不断的线 */
  },
  /* 评级体系：step=L1–L4 | cefr=A1–C2 | lexile=蓝思。（同一份结果三套都能算，这里只是默认展示哪套） */
  rating: { system: 'step' },
  /* 网页文章：内容脚本一律注入，这里控制「显不显示胶囊 / 怎么阅读 / 要不要在页面上色」 */
  article: {
    enabled: true,         /* 关掉后就完全不分析网页文章 */
    autoPill: true,        /* 自动在文章页显示悬浮胶囊 */
    dimKnown: false,       /* 阅读模式里把「已学」的词压暗，突出未掌握的词 */
    fontSize: 17,          /* 阅读模式正文字号（px） */
    inlineColor: true,     /* 直接在网页正文上逐词着色（不用进阅读模式） */
    inlineStyle: 'line',   /* 内联上色样式：line=下划线 | mark=底色 | dim=仅压暗生词外的词 */
    hlStyle: 'mark',       /* 划线样式：mark=黄底 | line=波浪线 */
    siteOff: [],           /* 手动关掉内联上色的站点（host 列表），避免在特定站点上打扰 */
    pos: null              /* 文章胶囊拖动后的位置，视口比例 {x,y}（0–1）；null=默认「右下角」 */
  },
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

/* ---------- 标记（词级标记 + 文本划线） ----------
   词级标记全局生效、优先于墨读词库；划线按 URL 存。见 shared/marks.js */
export async function getMarks() {
  const r = await get('local', MARKS_KEY);
  return normalizeMarks(r[MARKS_KEY]);
}

export async function setMarks(marks) {
  const next = normalizeMarks(marks);
  await set('local', { [MARKS_KEY]: next });
  return next;
}

export async function clearMarks() {
  await del('local', MARKS_KEY);
  return DEFAULT_MARKS();
}

export { MARKS_KEY, DEFAULT_MARKS };

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
