/* InkRead Video — 网页文章：识别、清洗与「阅读模式」的数据准备
 *
 * 设计分工：
 *   · 内容脚本（src/content/article.js）只做「薄抽取」——把页面上的候选段落抓成 string[]（它必须接触 DOM）。
 *   · 本模块做「纯逻辑」——判断这是不是一篇文章、清洗段落、跑与视频同一套分析内核、产出阅读模式需要的
 *     逐词状态表。放这里的好处：Node 可直接单测，background 里也能直接复用（内容脚本 → 消息 → 本模块）。
 *
 * 为什么不在内容脚本里直接分析：MV3 内容脚本是经典脚本，不能 import ESM；
 * 而且抽文本、算词频、查词库这些活儿放 background 做完再回传，页面侧更轻。
 */
import { tokens, lemmas, wordStatusOf } from './text.js';
import { analyze } from './analyze.js';

/* 认作「文章」的下限：词数 + 段落数。太高会漏掉短评，太低会把导航/列表页也算进来。 */
export const ARTICLE_MIN_WORDS = 200;
export const ARTICLE_MIN_PARAS = 3;
/* 英文（拉丁字母）占比低于此值就认为「不是英文材料」，不做生词分析 */
export const ARTICLE_MIN_LATIN_RATIO = 0.25;
/* 回传给阅读模式的逐词状态上限（防止极端长文把消息撑爆） */
export const STATUS_LIMIT = 4000;

/* 阅读模式下哪些状态需要高亮（其余按正文显示） */
export const HIGHLIGHT_STATUS = { learning: 'learning', new: 'new', unknown: 'unknown' };

/**
 * 清洗从 DOM 抽出来的候选段落。
 * @param {string[]} list
 * @returns {string[]}
 */
export function cleanParagraphs(list) {
  const out = [];
  for (const raw of list || []) {
    /* 软换行并成一个空格；连续空白压成一个；去掉不可见字符 */
    let s = String(raw == null ? '' : raw)
      .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) continue;
    out.push(s);
  }
  /* 去掉整段重复（很多站点会把同一段塞进多处） */
  const seen = new Set();
  const dedup = [];
  for (const s of out) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(s);
  }
  /* 去掉明显的导航/页脚噪声：极短且不含句末标点的行 */
  return dedup.filter(s => s.length >= 2);
}

export function parasToText(paras) {
  return (paras || []).join('\n\n');
}

/** 统计拉丁字母与中日韩字符的比例，用来判断「这是不是英文材料」 */
export function scriptRatio(text) {
  const s = String(text || '');
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const total = latin + cjk;
  return { latin, cjk, latinRatio: total ? latin / total : 0 };
}

/**
 * 文本画像：词数 / 段落数 / 句数 / 平均句长。
 * 平均句长不参与分级，但能提示「这块文本是不是被压扁了」（例如只有一行）。
 */
export function articleQuality(text) {
  const s = String(text || '');
  const paras = s.split(/\n{2,}/).filter(x => x.trim());
  const bare = s.replace(/\n/g, ' ');
  const sentences = bare.split(/[.!?]+(?:\s|$)/).filter(x => x.trim().length > 1).length || (bare.trim() ? 1 : 0);
  const words = tokens(s).length;
  const sc = scriptRatio(s);
  return {
    words,
    paras: paras.length,
    sentences,
    avgSentence: sentences ? Math.round(words / sentences * 10) / 10 : 0,
    latin: sc.latin,
    cjk: sc.cjk,
    latinRatio: Math.round(sc.latinRatio * 1000) / 1000,
    chars: s.length
  };
}

/**
 * 是不是一篇值得分析的英文文章。
 * @returns {{ok:boolean, reason:string, quality:object}}
 */
export function isArticleText(text) {
  const q = articleQuality(text);
  /* 顺序有讲究：先看「有没有字」，再看「是不是中文」，最后才看「够不够长」——
     这样每种失败都能给出最贴切的解释，而不是一律「太短」。 */
  if (!q.latin && !q.cjk) return { ok: false, reason: '页面上没有可读的正文', quality: q };
  if (q.latinRatio < ARTICLE_MIN_LATIN_RATIO) {
    return { ok: false, reason: '这个页面以中文为主，无法评估英文生词量', quality: q };
  }
  if (!q.words) return { ok: false, reason: '页面上没有可读的英文正文', quality: q };
  if (q.words < ARTICLE_MIN_WORDS) {
    return { ok: false, reason: `正文太短（${q.words} 词，至少需要 ${ARTICLE_MIN_WORDS} 词）`, quality: q };
  }
  if (q.paras < ARTICLE_MIN_PARAS) {
    return { ok: false, reason: `正文只有 ${q.paras} 段，看着不像文章`, quality: q };
  }
  return { ok: true, reason: '', quality: q };
}

/** 缓存 key：与视频用同一套命名（`ar:host+path`），host 参与以免同路径站点互撞 */
export function articleKey(href) {
  try {
    const u = new URL(href);
    return 'ar:' + u.hostname.toLowerCase() + u.pathname.replace(/\/+$/, '');
  } catch (e) {
    return 'ar:' + String(href || '').slice(0, 200);
  }
}

/**
 * 文章里出现的词 → 词库状态（只回传命中的，压缩体积）。
 *
 * 关键约定：**key 用小写「原形词形」本身，而不是词形还原后的词元**。
 * 这样阅读模式只做一次 `word.toLowerCase()` 查表就能着色，内容脚本里不需要再复制一份
 * 词形还原逻辑（否则两处实现一旦漂移，就会出现「标了生词但查的是另一个词」的鬼故事）。
 * 状态在后台已经用 text.js 的 lemmas 解析完毕。
 *
 * @returns {[string,string][]} 形如 [['running','learning'], …]
 */
export function articleStatuses(text, statusMap, limit) {
  const cap = limit || STATUS_LIMIT;
  const uniq = new Set(tokens(text).map(t => String(t).toLowerCase()));
  const out = [];
  for (const w of uniq) {
    if (out.length >= cap) break;
    const { status } = wordStatusOf(w, statusMap);
    if (status && status !== 'unknown') out.push([w, status]);
  }
  return out;
}

/**
 * 文章主分析（background 调用）。
 * @param {object} p { text, title, href, statusMap, freq, opts }
 * @returns {object} 报告 + 阅读模式数据
 */
export function analyzeArticlePage(p) {
  const text = String((p && p.text) || '');
  const hit = isArticleText(text);
  const quality = hit.quality;
  if (!hit.ok) return { ok: false, reason: hit.reason, quality, title: (p && p.title) || '' };

  const title = String((p && p.title) || '').trim();
  /* 标题也算进分析样本：它往往含主题词，且用户第一眼看到的就是它 */
  const sample = title ? title + '\n' + text : text;

  const report = analyze(sample, p.statusMap || new Map(), p.freq || null, (p.opts) || { maxTop: 40 });

  return {
    ok: true,
    kind: 'article',
    title,
    href: (p && p.href) || '',
    key: articleKey((p && p.href) || ''),
    quality,
    report,
    /* 阅读模式着色用：只含文章里出现过的词 */
    statuses: articleStatuses(sample, p.statusMap || new Map()),
    text
  };
}

/* 供测试与内容脚本对齐：一篇「像文章」的最短样本 */
export function articleSample(paras) {
  return cleanParagraphs(paras).slice(0, 3).join('\n\n');
}
