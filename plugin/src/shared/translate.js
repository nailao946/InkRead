/* ============================================================================
 * 墨读 InkRead — 翻译引擎（扩展移植版）
 * ----------------------------------------------------------------------------
 * 本文件是 web/js/translate.js 的扩展（MV3 浏览器扩展）移植版，目标是让翻译能力
 * 以「零依赖 ESM 纯模块」形态暴露，既能在 Service Worker 里 import，也能在 Node 里
 * 直接 import 做单元测试。
 *
 * 与网页版（web/js/translate.js）的差异点（务必同步维护，改一边要同步另一边）：
 *   1) 配置注入：网页版读 IR.settings.data.api；本模块一律从 opts.api 读取，
 *      键路径与网页版完全一致（如 api.volcano.apiKey / api.youdao.secret）。
 *      删除了所有 window.IR / IR.settings / IR.esc* 依赖。
 *   2) fetch 注入：所有网络请求都走 opts.fetchImpl（默认 globalThis.fetch），
 *      便于测试与 Service Worker 内自定义出口。
 *   3) 代理路由：网页版在 apiFetch 内自动探测本地服务 __proxy?ping=1；本模块
 *      「不做探测」，改为接收调用方传入的 opts.proxyBase。若给了 proxyBase，则把
 *      请求改发到 `${proxyBase}/__proxy?url=<编码后目标URL>${root?'&root='+编码root:''}`，
 *      方法/头/体原样透传（GET 的 query 已含在 url 中一并发出，POST 保留 body/headers）。
 *      若没给 proxyBase，则直接 fetchImpl(目标url, init)（可能 CORS 被拦，由调用方决定）。
 *      不再发送 x-ink-proxy 头（扩展侧不需要出口代理）。
 *   4) 超时：网页版无超时；移植版给每个请求加 AbortController 硬超时
 *      （默认 12000ms，可被 opts.timeoutMs 覆盖），超时抛 new Error('翻译超时')。
 *   5) Web Crypto：签名/哈希继续走 globalThis.crypto.subtle（SW 与 Node18+ 均有）。
 *      对 Node18 默认未暴露 globalThis.crypto 的情况做了 webcrypto 兜底。
 *   6) 删除 UI 相关：localStorage 缓存、IR.toast、任何 DOM 操作一律删除；
 *      Bing 免费 token 改为模块内内存缓存（非 localStorage）。
 *   7) 引擎与签名逻辑逐字保留：有道(SHA-256+双鉴权key)、腾讯云TMT(TC3-HMAC-SHA256)、
 *      阿里云百炼(DashScope)、阿里云机翻(RPC HMAC-SHA1)、火山方舟(Ark/Responses)、
 *      火山机翻v3(openspeech matx_translate)、火山机翻经典(V4)、DeepL(api-free/api 轮换)、
 *      微软、LibreTranslate、Google、Bing(Edge token+8分钟缓存)、MyMemory。
 * ==========================================================================*/

/* Node18 默认未暴露 globalThis.crypto（只有 globalThis.webcrypto）；兜底让代码统一用
   globalThis.crypto.subtle。不触碰 window / document / chrome。 */
if (typeof globalThis.crypto === 'undefined' && typeof globalThis.webcrypto !== 'undefined') {
  try {
    Object.defineProperty(globalThis, 'crypto', { value: globalThis.webcrypto, configurable: true, writable: true });
  } catch (_) { /* 某些运行时 crypto 已存在但不可写，忽略 */ }
}

/* ===================== 基础工具（Web Crypto / 编码） ===================== */

function _enc(s) { return new TextEncoder().encode(s); }
function _hex(bytes) { return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''); }
function _b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }

async function sha256Hex(str) {
  if (!(globalThis.crypto && globalThis.crypto.subtle)) throw new Error('当前环境不支持 Web Crypto（请用 Node18+ 或浏览器/SW 运行）');
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function _sha256Hex(str) { return _hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', _enc(str)))); }

/* HMAC 签名，返回字节数组；key/msg 可为字符串或 Uint8Array */
async function _hmac(hash, key, msg) {
  const keyBytes = typeof key === 'string' ? _enc(key) : key;
  const msgBytes = typeof msg === 'string' ? _enc(msg) : msg;
  const k = await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: hash }, false, ['sign']);
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, msgBytes));
}

/* Key 清洗：去掉误粘的 Bearer 前缀 / 引号 / 首尾空白 */
function _cleanKey(s) {
  return String(s || '').trim()
    .replace(/^bearer\s+/i, '')
    .replace(/^["'`]+/, '').replace(/["'`]+$/, '')
    .trim();
}

/* ===================== 请求出口（fetch 注入 / 代理路由 / 超时） ===================== */

/* 统一出口：把目标 url 转成实际要 fetch 的地址。
   - 给了 opts.proxyBase：改写为 `${proxyBase}/__proxy?url=<编码url>${root?'&root='+编码root:''}`
   - 否则：直连目标 url（可能被 CORS 拦，由调用方决定） */
function _resolveTarget(url, opts) {
  const pb = opts.proxyBase ? String(opts.proxyBase).replace(/\/+$/, '') : '';
  if (pb) {
    const root = opts.root ? '&root=' + encodeURIComponent(opts.root) : '';
    return pb + '/__proxy?url=' + encodeURIComponent(url) + root;
  }
  return url;
}

/* 带硬超时的 fetch 封装。超时抛 new Error('翻译超时')（带 isTimeout 标记，供上层透传）。 */
async function _request(url, init, opts) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('未提供可用的 fetch 实现（请传入 opts.fetchImpl）');
  const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : 12000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const realInit = Object.assign({}, init);
  realInit.signal = ctl.signal;
  try {
    return await fetchImpl(url, realInit);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const te = new Error('翻译超时');
      te.isTimeout = true;
      throw te;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* 引擎统一调用入口：先路由（代理或直连），再带超时发请求。 */
async function _doFetch(url, init, opts) {
  return _request(_resolveTarget(url, opts), init, opts);
}

/* 网络失败统一包装：超时错误原样上抛，其余翻译成「X 请求失败…」 */
function _netErr(e, msg) {
  if (e && e.isTimeout) throw e;
  throw new Error(msg);
}

/* ===================== 引擎实现（逐字保留签名/编码/清洗逻辑） ===================== */

/* ---------- 有道智云（SHA-256 签名；应用ID 失败时换 API Keys 重试） ---------- */
const _youdaoErr = { '101': '缺少必填参数', '102': '不支持的语言类型', '103': '翻译文本过长', '108': 'appKey 无效', '110': '无接口访问权限', '111': '账户余额不足', '112': '请求过于频繁', '202': '签名检验失败', '401': '账户已经欠费停用' };
async function _youdaoCall(q, appKey, secret, opts) {
  const salt = Date.now();
  const curtime = Math.floor(Date.now() / 1000);
  const input = q.length <= 20 ? q : q.slice(0, 10) + q.length + q.slice(-10);
  const sign = await sha256Hex(appKey + input + salt + curtime + secret);
  const body = new URLSearchParams({ q, from: 'auto', to: 'zh-CHS', appKey, salt, curtime, sign, signType: 'v3' });
  let j;
  try {
    const r = await _doFetch('https://openapi.youdao.com/api', { method: 'POST', body }, opts);
    j = await r.json();
  } catch (e) {
    if (e && e.isTimeout) throw e;
    if (e && /^转发失败/.test(e.message || '')) throw new Error('有道' + e.message);
    throw new Error('有道请求失败（网络不通、CORS 拦截或未启用本地转发；网页版请用 start-server 启动以便走本地转发）');
  }
  if (j.errorCode && j.errorCode !== '0') throw new Error('有道 ' + j.errorCode + '：' + (_youdaoErr[j.errorCode] || '未知错误'));
  let out = (j.translation || []).join('；');
  if (j.basic && j.basic.explains) out += (out ? '\n' : '') + j.basic.explains.join('；');
  return { engine: '有道', text: (out || '（无结果）').trim() };
}
async function youdao(q, api, opts) {
  const a = api.youdao || {};
  const appId = (a.key || '').trim();
  const apiKey = (a.apiKeys || '').trim();
  const secret = (a.secret || '').trim();
  if (!secret || (!appId && !apiKey)) throw new Error('未配置有道：设置 → 翻译接口 填 应用ID（或 API Keys）/ 应用密钥');
  if (appId) {
    try { return await _youdaoCall(q, appId, secret, opts); }
    catch (e) {
      if (apiKey && /108|202/.test(e.message)) return await _youdaoCall(q, apiKey, secret, opts);
      throw e;
    }
  }
  return _youdaoCall(q, apiKey, secret, opts);
}

/* ---------- 腾讯云机器翻译（TC3-HMAC-SHA256 签名） ---------- */
const _tcErr = { AuthFailure: '签名或密钥错误', 'AuthFailure.SignatureFailure': '签名错误', LimitExceeded: '超出配额', FailedOperation: '操作失败', InvalidParameter: '参数错误' };
async function _tencentCall(q, secretId, secretKey, region, opts) {
  const service = 'tmt', host = 'tmt.tencentcloudapi.com', action = 'TextTranslate';
  const payload = JSON.stringify({ SourceText: q, Source: 'en', Target: 'zh', ProjectId: 0 });
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const ct = 'application/json; charset=utf-8';
  const hashedPayload = await _sha256Hex(payload);
  const canonicalHeaders = 'content-type:' + ct + '\n' + 'host:' + host + '\n' + 'x-tc-action:' + action.toLowerCase() + '\n';
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
  const scope = date + '/' + service + '/tc3_request';
  const stringToSign = ['TC3-HMAC-SHA256', String(ts), scope, await _sha256Hex(canonicalRequest)].join('\n');
  const kDate = await _hmac('SHA-256', 'TC3' + secretKey, date);
  const kService = await _hmac('SHA-256', kDate, service);
  const kSigning = await _hmac('SHA-256', kService, 'tc3_request');
  const signature = _hex(await _hmac('SHA-256', kSigning, stringToSign));
  const headers = {
    'Content-Type': ct,
    'X-TC-Action': action,
    'X-TC-Version': '2018-03-21',
    'X-TC-Region': region,
    'X-TC-Timestamp': String(ts),
    'Authorization': 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + scope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
  };
  let j;
  try {
    const r = await _doFetch('https://' + host + '/', { method: 'POST', headers, body: payload }, opts);
    j = await r.json();
  } catch (e) { _netErr(e, '腾讯云请求失败（网络不通或未启用本地转发）'); }
  const resp = j.Response || {};
  if (resp.Error) throw new Error('腾讯云 ' + resp.Error.Code + '：' + resp.Error.Message);
  return { engine: '腾讯云', text: String(resp.TargetText || '（无结果）').trim() };
}
async function tencent(q, api, opts) {
  const c = api.tencent || {};
  const sid = (c.secretId || '').trim(), skey = (c.secretKey || '').trim();
  if (!sid || !skey) throw new Error('未配置腾讯云：设置 → 翻译接口 填 SecretId / SecretKey');
  return _tencentCall(q, sid, skey, (c.region || 'ap-guangzhou').trim(), opts);
}

/* ---------- 大模型翻译共用实现（OpenAI 兼容端点：阿里云百炼 / 火山方舟） ---------- */
async function _chatTranslate(q, cfg, opts) {
  const useModel = (cfg.model || '').trim() || cfg.defModel;
  const body = JSON.stringify({
    model: useModel,
    temperature: 0.2,
    messages: [
      { role: 'system', content: '你是专业翻译引擎。把用户给出的内容翻译成简体中文，只输出译文本身，不要解释、不要引号、不要任何多余前后缀。' },
      { role: 'user', content: q }
    ]
  });
  let j;
  try {
    const r = await _doFetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body
    }, opts);
    j = await r.json();
  } catch (e) { _netErr(e, cfg.label + '请求失败（网络不通、未启用本地转发，或 Key 无效）'); }
  if (j.error) {
    const m = j.error.message || j.error.code || JSON.stringify(j.error);
    const code = String(j.error.code || '');
    if (/format is incorrect|invalidapikey|authentication|invalid api key|incorrect api key/i.test(m + ' ' + code)) {
      throw new Error(cfg.label + '：' + m + '（Key 无效或格式不对。' + (cfg.keyHint || '请核对 API Key 是否完整、是否来自该平台') + '）');
    }
    throw new Error(cfg.label + '：' + m + '（若提示模型不存在/未开通，请把设置里的「模型」改成你已开通的模型名或接入点 ID）');
  }
  const t = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return { engine: cfg.label, text: String(t || '（无结果）').trim() };
}

/* ---------- 阿里云百炼（只要 API Key，OpenAI 兼容端点） ---------- */
async function aliyun(q, api, opts) {
  const c = api.aliyun || {};
  const key = _cleanKey(c.apiKey);
  if (!key) throw new Error('未配置阿里云百炼：设置 → 翻译接口 填 API Key');
  return _chatTranslate(q, {
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    apiKey: key, model: c.model, label: '阿里云百炼', defModel: 'qwen-plus',
    keyHint: '百炼 Key 以 sk- 开头，在 bailian.console.aliyun.com → API-KEY 管理 复制；其他平台的 Key 不能混用'
  }, opts);
}

/* ---------- 阿里云机器翻译（RPC V1，HMAC-SHA1） ---------- */
function _aliPct(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}
const _alimtErr = {
  '10001': '请求超时，请重试', '10002': '系统错误，请重试', '10003': '原文解码失败',
  '10005': '语向不支持（该语言对不可翻译）', '10006': '语种识别失败', '10007': '翻译失败',
  '10008': '字符过长（单次上限 5000 字符）', '10009': '子账号没有权限（请给 RAM 子账号授权）',
  '10010': '账号没有开通机器翻译服务', '10011': '子账号服务失败', '10012': '翻译服务调用失败',
  '10013': '账号服务没有开通或欠费'
};
async function alimt(q, api, opts) {
  const c = api.alimt || {};
  const akId = _cleanKey(c.accessKeyId), akSecret = _cleanKey(c.accessKeySecret);
  if (!akId || !akSecret) throw new Error('未配置阿里云机器翻译：设置 → 翻译接口 填 AccessKeyId / AccessKeySecret');
  const pro = c.edition === 'pro';
  const label = '阿里云机器翻译' + (pro ? '（专业版）' : '');
  const ts = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const nonce = String(Date.now()) + Math.floor(Math.random() * 1e6);
  const params = {
    Action: pro ? 'Translate' : 'TranslateGeneral', Format: 'JSON', Version: '2018-10-12',
    AccessKeyId: akId, SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0',
    SignatureNonce: nonce, Timestamp: ts,
    FormatType: 'text',
    Scene: pro ? (c.scene || 'social') : 'general',
    SourceLanguage: 'auto', SourceText: q, TargetLanguage: 'zh'
  };
  const canon = Object.keys(params).sort().map(k => _aliPct(k) + '=' + _aliPct(params[k])).join('&');
  const stringToSign = 'GET&%2F&' + _aliPct(canon);
  const sign = _b64(await _hmac('SHA-1', akSecret + '&', stringToSign));
  const url = 'https://mt.aliyuncs.com/?' + canon + '&Signature=' + _aliPct(sign);
  let j;
  try {
    const r = await _doFetch(url, { method: 'GET' }, opts);
    j = await r.json();
  } catch (e) { _netErr(e, label + '请求失败（网络不通或未启用本地转发）'); }
  const resp = (j && (j.TranslateResponse || j.TranslateGeneralResponse)) || j || {};
  const code = String(resp.Code || '200');
  if (code !== '200') {
    const m = _alimtErr[code] || resp.Message || ('错误码 ' + code);
    const suffix = /10010|10013/.test(code) ? '（请到阿里云机器翻译控制台开通' + (pro ? '专业版' : '通用版') + '服务后再试）' : '';
    throw new Error(label + ' ' + code + '：' + m + suffix);
  }
  const text = resp.Data && resp.Data.Translated;
  return { engine: label, text: String(text || '（无结果）').trim() };
}

/* ---------- 火山方舟（只要 API Key；专用翻译模型走 Responses，通用走 chat/completions） ---------- */
async function volcano(q, api, opts) {
  const c = api.volcano || {};
  const key = _cleanKey(c.apiKey);
  if (!key) throw new Error('未配置火山方舟：设置 → 翻译接口 填 API Key');
  if (/^ep-/i.test(key)) throw new Error('火山方舟：你填的是「接入点 ID」（ep-…），那是填在「模型」一栏的，不能当 API Key。' +
    '请到 console.volcengine.com/ark → API Key 管理，创建并复制 API Key（形如 ark-xxxxxxxx-xxxx-…）');
  if (!/^(ark-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-[0-9a-z]+)?$/i.test(key))
    throw new Error('火山方舟：API Key 格式不对——方舟的 Key 形如 ark-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx（或一串带连字符的 UUID）。' +
      'sk- 开头的是阿里百炼的 Key，AKLT 开头的是访问密钥，都不能用在这里。' +
      '请到 console.volcengine.com/ark → API Key 管理重新复制');
  const useModel = (c.model || '').trim() || 'doubao-seed-translation-250915';
  if (/translation/i.test(useModel)) return _arkResponsesTranslate(key, useModel, q, opts);
  return _chatTranslate(q, {
    url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    apiKey: key, model: useModel, label: '火山方舟', defModel: 'doubao-seed-translation-250915',
    keyHint: '方舟 Key 形如 ark-<UUID>，在 console.volcengine.com/ark → API Key 管理复制；ep-… 是接入点 ID（填「模型」栏），不能当 Key'
  }, opts);
}
async function _arkResponsesTranslate(key, model, q, opts) {
  const body = JSON.stringify({
    model,
    input: [{
      role: 'user',
      content: [{ type: 'input_text', text: q, translation_options: { source_language: 'en', target_language: 'zh' } }]
    }]
  });
  let j;
  try {
    const r = await _doFetch('https://ark.cn-beijing.volces.com/api/v3/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body
    }, opts);
    j = await r.json();
  } catch (e) { _netErr(e, '火山方舟请求失败（网络不通、未启用本地转发，或 Key 无效）'); }
  if (j.error) {
    const m = j.error.message || j.error.code || JSON.stringify(j.error);
    const code = String(j.error.code || '');
    if (/format is incorrect|invalidapikey|authentication|invalid api key|incorrect api key/i.test(m + ' ' + code)) {
      throw new Error('火山方舟：' + m + '（Key 无效或格式不对。方舟 Key 形如 ark-<UUID>，在 console.volcengine.com/ark → API Key 管理复制）');
    }
    if (/does not support this api|not support this api/i.test(m)) {
      throw new Error('火山方舟：' + m + '（doubao-seed-translation 系列只能走 Responses 接口，请把「模型」留空或填翻译模型名；通用对话模型请填模型名如 doubao-seed-1-6-250615）');
    }
    if (/does not exist or you do not have access/i.test(m)) {
      throw new Error('火山方舟：' + m + '（你未开通这个模型。到 console.volcengine.com/ark 开通「Doubao-翻译模型」，或把「模型」改成已开通的模型名 / 留空用默认翻译模型）');
    }
    throw new Error('火山方舟：' + m + '（若提示模型不存在/无权访问，请到方舟控制台开通对应模型后再试）');
  }
  let text = '';
  const outs = Array.isArray(j.output) ? j.output : [];
  for (const it of outs) {
    if (it && Array.isArray(it.content)) {
      for (const cc of it.content) {
        if (cc && (cc.type === 'output_text' || typeof cc.text === 'string')) { text = cc.text; break; }
      }
    }
    if (text) break;
  }
  return { engine: '火山方舟', text: String(text || '').trim() || '（无结果）' };
}

/* ---------- 火山机器翻译（经典版，V4 HMAC-SHA256 签名） ---------- */
async function volmt(q, api, opts) {
  const c = api.volmt || {};
  let ak = _cleanKey(c.accessKeyId), sk = _cleanKey(c.accessKeySecret);
  if (!ak || !sk) throw new Error('未配置火山机器翻译：设置 → 翻译接口 填 AccessKey / SecretKey');
  if (/^AKLT/.test(sk) && !/^AKLT/.test(ak)) { const t = ak; ak = sk; sk = t; }
  const host = 'translate.volcengineapi.com', region = 'cn-north-1', service = 'translate';
  const qs = 'Action=TranslateText&Version=2020-06-01';
  const body = JSON.stringify({ TargetLanguage: 'zh', TextList: [q] });
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const xDate = d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  const date = xDate.slice(0, 8);
  const canonicalHeaders = 'host:' + host + '\n' + 'x-date:' + xDate + '\n';
  const signedHeaders = 'host;x-date';
  const canonicalRequest = ['POST', '/', qs, canonicalHeaders, signedHeaders, await _sha256Hex(body)].join('\n');
  const scope = date + '/' + region + '/' + service + '/request';
  const stringToSign = ['HMAC-SHA256', xDate, scope, await _sha256Hex(canonicalRequest)].join('\n');
  const kDate = await _hmac('SHA-256', sk, date);
  const kRegion = await _hmac('SHA-256', kDate, region);
  const kService = await _hmac('SHA-256', kRegion, service);
  const kSigning = await _hmac('SHA-256', kService, 'request');
  const signature = _hex(await _hmac('SHA-256', kSigning, stringToSign));
  const headers = {
    'Content-Type': 'application/json',
    'X-Date': xDate,
    'Authorization': 'HMAC-SHA256 Credential=' + ak + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
  };
  let j;
  try {
    const r = await _doFetch('https://' + host + '/?' + qs, { method: 'POST', headers, body }, opts);
    j = await r.json();
  } catch (e) { _netErr(e, '火山机器翻译请求失败（网络不通或未启用本地转发）'); }
  const meta = j.ResponseMetadata || {};
  if (meta.Error) {
    const code = String(meta.Error.Code || ''), m = meta.Error.Message || code;
    const hint = /415|not.*language|unsupported/i.test(code + ' ' + m) ? '（该语向不支持，检查源文本语言）'
      : /429/.test(code) ? '（请求过于频繁，请稍后再试）'
      : /signature|sign/i.test(code + ' ' + m) ? '（签名失败：请核对 AccessKey / SecretKey 是否正确；火山 AccessKey 以 AKLT 开头，别和 Secret 填反）'
      : /unsynchronized/i.test(m) ? '（账号状态未同步：通常是机器翻译服务未开通或刚开通还没生效，到火山引擎控制台开通后等几分钟再试）'
      : /open|auth|permission|account/i.test(code + ' ' + m) ? '（可能是服务未开通或账号无权限：到火山引擎控制台开通机器翻译）'
      : '';
    throw new Error('火山机器翻译 ' + code + '：' + m + hint);
  }
  const t = j.TranslationList && j.TranslationList[0] && j.TranslationList[0].Translation;
  return { engine: '火山机器翻译', text: String(t || '（无结果）').trim() };
}

/* ---------- 火山机器翻译 v3（openspeech，只要 API Key） ---------- */
async function volmt3(q, api, opts) {
  const c = api.volmt3 || {};
  const key = _cleanKey(c.apiKey);
  if (!key) throw new Error('未配置火山机器翻译（API Key）：设置 → 翻译接口 填 API Key');
  const rid = (c.resourceId || '').trim() || 'volc.speech.mt';
  const body = JSON.stringify({
    source_language: 'auto', target_language: 'zh',
    text_list: [String(q == null ? '' : q).slice(0, 2000)]
  });
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'X-Api-Resource-Id': rid,
    'X-Api-Request-Id': _reqId()
  };
  let j;
  try {
    const r = await _doFetch('https://openspeech.bytedance.com/api/v3/machine_translation/matx_translate',
      { method: 'POST', headers, body }, opts);
    j = await r.json();
  } catch (e) { _netErr(e, '火山机器翻译请求失败（网络不通或未启用本地转发）'); }
  const code = String((j && j.code) || '');
  const msg = String((j && j.message) || '').trim();
  if (code && code !== '20000000') {
    const hint = /Invalid X-Api-Key|api-?key/i.test(msg) ? '（API Key 无效：到火山引擎控制台 → 机器翻译 → API Key 重新复制）'
      : /resource/i.test(code + ' ' + msg) ? '（资源 ID 不对：默认应填 volc.speech.mt）'
      : /quota|limit|exceed|balance/i.test(msg) ? '（额度不足或超出限制：到控制台查看用量）'
      : /open|activat|service|unsynchron/i.test(code + ' ' + msg) ? '（服务未开通或账号未同步：到火山引擎控制台开通「机器翻译」后再试）'
      : '';
    throw new Error('火山机器翻译 ' + (code || '（无错误码）') + '：' + (msg || '未知错误') + hint);
  }
  const item = j && j.data && Array.isArray(j.data.translation_list) ? j.data.translation_list[0] : null;
  const t = item && (typeof item === 'string' ? item : item.translation);
  return { engine: '火山机器翻译v3', text: String(t || '（无结果）').trim() };
}

/* 请求 ID：官方要求每次唯一（32 位十六进制）；无 Web Crypto 时退化为时间戳 + 随机数 */
function _reqId() {
  try {
    const b = new Uint8Array(16);
    const c = (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) ? globalThis.crypto : null;
    if (c) {
      c.getRandomValues(b);
      return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) { /* 退化路径 */ }
  return (Date.now().toString(16) + Math.random().toString(16).slice(2) + '0'.repeat(32)).slice(0, 32);
}

/* ---------- DeepL（API Free / Pro 自动判断，只要一个 API Key） ---------- */
async function deepl(q, api, opts) {
  const c = api.deepl || {};
  const key = (c.apiKey || '').trim();
  if (!key) throw new Error('未配置 DeepL：设置 → 翻译接口 填 API Key');
  const hosts = key.endsWith(':fx')
    ? ['https://api-free.deepl.com', 'https://api.deepl.com']
    : ['https://api.deepl.com', 'https://api-free.deepl.com'];
  const body = new URLSearchParams({ text: q, source_lang: 'EN', target_lang: 'ZH' });
  let lastErr = '未知错误';
  for (const base of hosts) {
    let j;
    try {
      const r = await _doFetch(base + '/v2/translate', {
        method: 'POST',
        headers: { 'Authorization': 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      }, opts);
      if (r.status === 401 || r.status === 403) { lastErr = 'API Key 无效（HTTP ' + r.status + '）'; continue; }
      if (r.status === 456) { lastErr = '本月额度已用完（HTTP 456）'; continue; }
      if (!r.ok) { lastErr = 'HTTP ' + r.status; continue; }
      j = await r.json();
    } catch (e) { _netErr(e, 'DeepL 请求失败（网络不通或未启用本地转发）'); }
    const t = j.translations && j.translations[0] && j.translations[0].text;
    if (!t) { lastErr = '返回空结果'; continue; }
    return { engine: 'DeepL', text: String(t).trim() };
  }
  throw new Error('DeepL：' + lastErr);
}

/* ---------- 微软翻译（Azure 认知服务：Key + 可选区域） ---------- */
async function ms(q, api, opts) {
  const c = api.ms || {};
  const key = (c.apiKey || '').trim();
  if (!key) throw new Error('未配置微软翻译：设置 → 翻译接口 填 API Key');
  const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': key };
  const region = (c.region || '').trim();
  if (region) headers['Ocp-Apim-Subscription-Region'] = region;
  let j;
  try {
    const r = await _doFetch(
      'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans',
      { method: 'POST', headers, body: JSON.stringify([{ Text: q }]) }, opts);
    j = await r.json();
  } catch (e) { _netErr(e, '微软翻译请求失败（网络不通或未启用本地转发）'); }
  if (j && j.error) {
    const code = j.error.code || '';
    const hint = code === 401001 || code === 401000
      ? '（Key 无效或区域不匹配：多服务/区域资源必须在设置里填区域，如 eastasia）' : '';
    throw new Error('微软翻译 ' + code + '：' + (j.error.message || '') + hint);
  }
  const t = j && j[0] && j[0].translations && j[0].translations[0] && j[0].translations[0].text;
  return { engine: '微软翻译', text: String(t || '（无结果）').trim() };
}

/* ---------- LibreTranslate（开源，可自建；公开实例通常需要 Key） ---------- */
async function libre(q, api, opts) {
  const c = api.libre || {};
  let base = (c.url || '').trim() || 'https://libretranslate.com';
  base = base.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
  const body = { q, source: 'en', target: 'zh', format: 'text' };
  const key = (c.apiKey || '').trim();
  if (key) body.api_key = key;
  let j;
  try {
    const r = await _doFetch(base + '/translate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, opts);
    j = await r.json();
  } catch (e) {
    _netErr(e, 'LibreTranslate 请求失败（地址不通、未启用本地转发，或该域名不在转发白名单内）');
  }
  if (j.error) throw new Error('LibreTranslate：' + j.error);
  if (!j.translatedText) throw new Error('LibreTranslate 返回空结果（公开实例可能需要 API Key）');
  return { engine: 'LibreTranslate', text: String(j.translatedText).trim() };
}

/* ---------- 免费内置引擎（无需 Key） ---------- */
async function mymemory(q, api, opts) {
  const u = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q.slice(0, 500)) + '&langpair=en|zh-CN';
  let j;
  try {
    const r = await _doFetch(u, {}, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    j = await r.json();
  } catch (e) { _netErr(e, 'MyMemory 请求失败（网络不通）'); }
  const t = j.responseData && j.responseData.translatedText;
  if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(t)) throw new Error('MyMemory：' + (j.responseDetails || t || '无结果'));
  return { engine: 'MyMemory', text: t.trim() };
}

async function google(q, api, opts) {
  const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' + encodeURIComponent(q);
  let j;
  try {
    const r = await _doFetch(u, {}, opts);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    j = await r.json();
  } catch (e) { _netErr(e, '谷歌翻译不可达（免费接口国内网络通常不通，需代理或在设置里填代理地址）'); }
  const text = (j[0] || []).map(s => s && s[0]).filter(Boolean).join('');
  return { engine: '谷歌', text: (text || '（无结果）').trim() };
}

let _bingToken = null, _bingTokenExp = 0;
async function bing(q, api, opts) {
  if (!_bingToken || Date.now() > _bingTokenExp) {
    let r;
    try { r = await _doFetch('https://edge.microsoft.com/translate/auth', {}, opts); }
    catch (e) { _netErr(e, '必应翻译不可达（网络不通）'); }
    if (!r.ok) throw new Error('必应令牌获取失败（该接口对大陆网络有地区限制，需海外网络或代理）');
    _bingToken = (await r.text()).trim();
    _bingTokenExp = Date.now() + 8 * 60 * 1000;
  }
  let j;
  try {
    const r = await _doFetch('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + _bingToken, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ Text: q.slice(0, 1000) }])
    }, opts);
    if (!r.ok) {
      if (r.status === 401) { _bingToken = null; throw new Error('必应令牌过期，请重试'); }
      throw new Error('必应 HTTP ' + r.status);
    }
    j = await r.json();
  } catch (e) {
    if (e && e.isTimeout) throw e;
    if (e && e.message && e.message.startsWith('必应')) throw e;
    _netErr(e, '必应翻译请求失败（网络不通或 CORS 拦截）');
  }
  const text = j[0] && j[0].translations && j[0].translations[0].text;
  return { engine: '必应', text: (text || '（无结果）').trim() };
}

/* ===================== 导出 API ===================== */

/* auto 模式默认尝试顺序（腾讯垫底）；用户可在设置里自定义 */
export const AUTO_ENGINES = ['youdao', 'aliyun', 'alimt', 'volcano', 'volmt3', 'volmt', 'deepl', 'ms', 'libre', 'tencent'];

/* 所有引擎 id 列表（含免费与付费） */
export const ENGINES = ['youdao', 'tencent', 'aliyun', 'alimt', 'volcano', 'volmt3', 'volmt', 'deepl', 'ms', 'libre', 'google', 'bing', 'mymemory'];

/* id → 中文名 */
export const ENGINE_LABELS = {
  youdao: '有道智云',
  tencent: '腾讯云 TMT',
  aliyun: '阿里云百炼',
  alimt: '阿里云机器翻译',
  volcano: '火山方舟',
  volmt3: '火山机器翻译v3',
  volmt: '火山机器翻译',
  deepl: 'DeepL',
  ms: '微软翻译',
  libre: 'LibreTranslate',
  google: '谷歌翻译',
  bing: '必应翻译',
  mymemory: 'MyMemory'
};

/* 各引擎是否已配置（照搬源文件 run() 里的 configured 判定；免费引擎恒为 true） */
export function engineConfigured(api) {
  api = api || {};
  const y = api.youdao || {};
  const t = api.tencent || {};
  const al = api.aliyun || {};
  const am = api.alimt || {};
  const v = api.volcano || {};
  const vmt3 = api.volmt3 || {};
  const vmt = api.volmt || {};
  const dp = api.deepl || {};
  const ms = api.ms || {};
  const lb = api.libre || {};
  return {
    youdao: !!(y.secret && (y.key || y.apiKeys)),
    tencent: !!(t.secretId && t.secretKey),
    aliyun: !!al.apiKey,
    alimt: !!(am.accessKeyId && am.accessKeySecret),
    volcano: !!v.apiKey,
    volmt3: !!vmt3.apiKey,
    volmt: !!(vmt.accessKeyId && vmt.accessKeySecret),
    deepl: !!dp.apiKey,
    ms: !!ms.apiKey,
    libre: !!(lb.url || lb.apiKey),
    google: true,
    bing: true,
    mymemory: true
  };
}

/* 当前该用哪个引擎 id（api.engine==='auto' 时返回 'auto'；非法/未知 id 也回落为 'auto'） */
export function detectEngine(api) {
  api = api || {};
  const e = api.engine || 'auto';
  if (e === 'auto') return 'auto';
  if (ENGINES.indexOf(e) >= 0) return e;
  return 'auto';
}

/* 引擎名 → 实现函数 */
const _ENGINE_FNS = { youdao, tencent, aliyun, alimt, volcano, volmt3, volmt, deepl, ms, libre, google, bing, mymemory };
function _dispatch(name, q, api, opts) {
  const fn = _ENGINE_FNS[name];
  if (!fn) throw new Error('未知翻译引擎：' + name);
  return fn(q, api, opts);
}

/* 调单个引擎，供设置页「测试」用 */
export async function runOne(name, q, opts) {
  opts = opts || {};
  const api = opts.api || {};
  return _dispatch(name, q, api, opts);
}

/* 统一入口：engine 指定则直跑；auto 则按已配置引擎链 + mymemory 兜底；全失败抛聚合错误 */
export async function run(q, opts) {
  opts = opts || {};
  const api = opts.api || {};
  const engine = opts.engine || api.engine || 'auto';
  if (ENGINES.indexOf(engine) >= 0) return _dispatch(engine, q, api, opts);

  /* auto：已配置的官方接口依次尝试（默认腾讯垫底），最后兜底免费 MyMemory */
  const configured = engineConfigured(api);
  let order = Array.isArray(api.autoOrder) && api.autoOrder.length
    ? api.autoOrder.filter(n => AUTO_ENGINES.indexOf(n) >= 0) : AUTO_ENGINES.slice();
  for (const k of AUTO_ENGINES) if (order.indexOf(k) < 0) order.push(k);
  const chain = [];
  for (const n of order) if (configured[n]) chain.push(n);
  chain.push('mymemory');

  const errs = [];
  for (const name of chain) {
    try { return await _dispatch(name, q, api, opts); }
    catch (err) { errs.push(err.message); }
  }
  throw new Error(errs.join('；') || '没有可用的翻译引擎');
}
