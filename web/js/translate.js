/* 墨读 InkRead — 翻译接口
   官方接口 6 家：
     有道智云（v3，SHA-256 签名）· 腾讯云 TMT（TC3-HMAC-SHA256）
     阿里云百炼（只要 API Key，OpenAI 兼容端点）· 阿里云机器翻译（通用/专业版）
     火山方舟 · 豆包大模型（只要 API Key）· 火山机器翻译（v3 / 经典，两种鉴权）
   免费内置 3 家：MyMemory（国内直连）· 谷歌 gtx · 必应 Edge token（均无需 Key）
   浏览器直连会被 CORS 拦截 —— 统一走 apiFetch()，由本地转发（桌面版内置 / 网页版 serve.py）代发。
   划词/点词句子翻译用；单词释义仍走内置词库（ECDICT） */
window.IR = window.IR || {};

IR.translate = {
  /* ---------- SHA-256（有道 v3 签名用 Web Crypto） ---------- */
  async sha256Hex(str) {
    if (!(window.crypto && crypto.subtle)) throw new Error('当前环境不支持 Web Crypto（请用本地服务器或桌面版打开）');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  /* ---------- 签名/编码工具（有道 SHA-256、腾讯 TC3 用） ---------- */
  _enc(s) { return new TextEncoder().encode(s); },
  _hex(bytes) { return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''); },
  _b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); },
  async _sha256Hex(str) { return this._hex(new Uint8Array(await crypto.subtle.digest('SHA-256', this._enc(str)))); },
  /* HMAC 签名，返回字节数组；key/msg 可为字符串或 Uint8Array */
  async _hmac(hash, key, msg) {
    const keyBytes = typeof key === 'string' ? this._enc(key) : key;
    const msgBytes = typeof msg === 'string' ? this._enc(msg) : msg;
    const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: hash }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, msgBytes));
  },

  /* ---------- 腾讯云机器翻译（TC3-HMAC-SHA256 签名） ----------
     控制台：console.cloud.tencent.com/cam/capi → SecretId / SecretKey
     （腾讯云没有纯 API Key 方案，只能用 API 密钥；开通机器翻译 TMT 后按量计费） */
  _tcErr: { AuthFailure: '签名或密钥错误', 'AuthFailure.SignatureFailure': '签名错误', LimitExceeded: '超出配额', FailedOperation: '操作失败', InvalidParameter: '参数错误' },
  async _tencentCall(q, secretId, secretKey, region) {
    const service = 'tmt', host = 'tmt.tencentcloudapi.com', action = 'TextTranslate';
    const payload = JSON.stringify({ SourceText: q, Source: 'en', Target: 'zh', ProjectId: 0 });
    const ts = Math.floor(Date.now() / 1000);
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    const ct = 'application/json; charset=utf-8';
    const hashedPayload = await this._sha256Hex(payload);
    const canonicalHeaders = 'content-type:' + ct + '\n' + 'host:' + host + '\n' + 'x-tc-action:' + action.toLowerCase() + '\n';
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
    const scope = date + '/' + service + '/tc3_request';
    const stringToSign = ['TC3-HMAC-SHA256', String(ts), scope, await this._sha256Hex(canonicalRequest)].join('\n');
    const kDate = await this._hmac('SHA-256', 'TC3' + secretKey, date);
    const kService = await this._hmac('SHA-256', kDate, service);
    const kSigning = await this._hmac('SHA-256', kService, 'tc3_request');
    const signature = this._hex(await this._hmac('SHA-256', kSigning, stringToSign));
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
      const r = await this.apiFetch('https://' + host + '/', { method: 'POST', headers, body: payload });
      j = await r.json();
    } catch (e) { throw new Error('腾讯云请求失败（网络不通或未启用本地转发）'); }
    const resp = j.Response || {};
    if (resp.Error) throw new Error('腾讯云 ' + resp.Error.Code + '：' + resp.Error.Message);
    return { engine: '腾讯云', text: String(resp.TargetText || '（无结果）').trim() };
  },
  async tencent(q) {
    const c = IR.settings.data.api.tencent || {};
    const sid = (c.secretId || '').trim(), skey = (c.secretKey || '').trim();
    if (!sid || !skey) throw new Error('未配置腾讯云：设置 → 翻译接口 填 SecretId / SecretKey');
    return this._tencentCall(q, sid, skey, (c.region || 'ap-guangzhou').trim());
  },

  /* ---------- Key 清洗：去掉误粘的 Bearer 前缀 / 引号 / 首尾空白 ---------- */
  /* auto 模式默认尝试顺序（腾讯垫底）；用户可在设置 → 翻译接口 → 自动模式顺序里自定义 */
  AUTO_ENGINES: ['youdao', 'aliyun', 'alimt', 'volcano', 'volmt3', 'volmt', 'deepl', 'ms', 'libre', 'tencent'],
  _cleanKey(s) {
    return String(s || '').trim()
      .replace(/^bearer\s+/i, '')
      .replace(/^["'`]+/, '').replace(/["'`]+$/, '')
      .trim();
  },

  /* ---------- 大模型翻译共用实现（OpenAI 兼容端点：阿里云百炼 / 火山方舟） ----------
     两家都只要一个 API Key，请求体与响应结构一致（chat/completions）。 */
  async _chatTranslate(opts) {
    const useModel = (opts.model || '').trim() || opts.defModel;
    const body = JSON.stringify({
      model: useModel,
      temperature: 0.2,
      messages: [
        { role: 'system', content: '你是专业翻译引擎。把用户给出的内容翻译成简体中文，只输出译文本身，不要解释、不要引号、不要任何多余前后缀。' },
        { role: 'user', content: opts.q }
      ]
    });
    let j;
    try {
      const r = await this.apiFetch(opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + opts.apiKey },
        body
      });
      j = await r.json();
    } catch (e) {
      throw new Error(opts.label + '请求失败（网络不通、未启用本地转发，或 Key 无效）');
    }
    if (j.error) {
      const m = j.error.message || j.error.code || JSON.stringify(j.error);
      const code = String(j.error.code || '');
      /* Key 类错误（格式不对 / 无效 / 认证失败）给 Key 专属提示，不再误导用户去改模型 */
      if (/format is incorrect|invalidapikey|authentication|invalid api key|incorrect api key/i.test(m + ' ' + code)) {
        throw new Error(opts.label + '：' + m + '（Key 无效或格式不对。' +
          (opts.keyHint || '请核对 API Key 是否完整、是否来自该平台') + '）');
      }
      throw new Error(opts.label + '：' + m +
        '（若提示模型不存在/未开通，请把设置里的「模型」改成你已开通的模型名或接入点 ID）');
    }
    const t = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return { engine: opts.label, text: String(t || '（无结果）').trim() };
  },

  /* ---------- 阿里云百炼（只要 API Key，OpenAI 兼容端点） ----------
     API Key：bailian.console.aliyun.com → API-KEY（形如 sk-xxxx）
     不需要 AccessKey/Secret，也不需要单独开通机器翻译产品。 */
  async aliyun(q) {
    const c = IR.settings.data.api.aliyun || {};
    const key = this._cleanKey(c.apiKey);
    if (!key) throw new Error('未配置阿里云百炼：设置 → 翻译接口 填 API Key');
    return this._chatTranslate({
      url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      apiKey: key, model: c.model, q, label: '阿里云百炼', defModel: 'qwen-plus',
      keyHint: '百炼 Key 以 sk- 开头，在 bailian.console.aliyun.com → API-KEY 管理 复制；其他平台的 Key 不能混用'
    });
  },

  /* ---------- 阿里云机器翻译（通用版 TranslateGeneral / 专业版 Translate，经典 RPC 接口） ----------
     需要一对 AccessKeyId / AccessKeySecret（建议 RAM 子账号只授权机器翻译）。
     通用版：Scene=general，全领域；专业版：Scene 必填（title/description/communication/medical/social/finance），
     电商/医疗/社交/金融垂类引擎更准。两版都要先在机器翻译控制台开通对应服务。
     签名：阿里云 RPC V1（HMAC-SHA1）；源语言 auto 自动检测。 */
  _aliPct(s) {
    /* RFC3986 严格百分号编码：encodeURIComponent 之外再补 ! ' ( ) * */
    return encodeURIComponent(String(s)).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  },
  _alimtErr: {
    '10001': '请求超时，请重试', '10002': '系统错误，请重试', '10003': '原文解码失败',
    '10005': '语向不支持（该语言对不可翻译）', '10006': '语种识别失败', '10007': '翻译失败',
    '10008': '字符过长（单次上限 5000 字符）', '10009': '子账号没有权限（请给 RAM 子账号授权）',
    '10010': '账号没有开通机器翻译服务', '10011': '子账号服务失败', '10012': '翻译服务调用失败',
    '10013': '账号服务没有开通或欠费'
  },
  async alimt(q) {
    const c = IR.settings.data.api.alimt || {};
    const akId = this._cleanKey(c.accessKeyId), akSecret = this._cleanKey(c.accessKeySecret);
    if (!akId || !akSecret) throw new Error('未配置阿里云机器翻译：设置 → 翻译接口 填 AccessKeyId / AccessKeySecret');
    const pro = c.edition === 'pro';
    const label = '阿里云机器翻译' + (pro ? '（专业版）' : '');
    /* 1. 公共参数 + 业务参数（两版只差 Action 与 Scene） */
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
    /* 2. 按 key 排序构造规范化查询串 */
    const canon = Object.keys(params).sort().map(k => this._aliPct(k) + '=' + this._aliPct(params[k])).join('&');
    /* 3. 签名：StringToSign = GET&%2F&percentEncode(canon)，HMAC-SHA1(secret + '&') */
    const stringToSign = 'GET&%2F&' + this._aliPct(canon);
    const sign = this._b64(await this._hmac('SHA-1', akSecret + '&', stringToSign));
    const url = 'https://mt.aliyuncs.com/?' + canon + '&Signature=' + this._aliPct(sign);
    let j;
    try {
      const r = await this.apiFetch(url, { method: 'GET' });
      j = await r.json();
    } catch (e) {
      throw new Error(label + '请求失败（网络不通或未启用本地转发）');
    }
    /* 响应可能包一层（TranslateResponse / TranslateGeneralResponse），也可能平铺 */
    const resp = (j && (j.TranslateResponse || j.TranslateGeneralResponse)) || j || {};
    const code = String(resp.Code || '200');
    if (code !== '200') {
      const m = this._alimtErr[code] || resp.Message || ('错误码 ' + code);
      const suffix = /10010|10013/.test(code) ? '（请到阿里云机器翻译控制台开通' + (pro ? '专业版' : '通用版') + '服务后再试）' : '';
      throw new Error(label + ' ' + code + '：' + m + suffix);
    }
    const text = resp.Data && resp.Data.Translated;
    return { engine: label, text: String(text || '（无结果）').trim() };
  },

  /* ---------- 火山引擎 · 豆包大模型（只要 API Key） ----------
     API Key：console.volcengine.com/ark → API Key（只需要这一个；形如 ark-<uuid>-xxxx 或纯 UUID）
     模型：留空默认 doubao-seed-translation-250915（专用翻译模型，走 Responses 接口）；
     也可填其他已开通的通用模型名（doubao-…，走 chat/completions）或推理接入点 ID（ep-…）。
     实测：翻译模型不支持 chat/completions（报 does not support this api），
     translation_options 必填且 source_language 不支持 auto → 锁定 en → zh。 */
  async volcano(q) {
    const c = IR.settings.data.api.volcano || {};
    const key = this._cleanKey(c.apiKey);
    if (!key) throw new Error('未配置火山方舟：设置 → 翻译接口 填 API Key');
    /* 客户端格式预检：方舟 Key 为带连字符的 UUID，可带 ark- 前缀与短尾缀（官方两种形态都见过） */
    if (/^ep-/i.test(key)) throw new Error('火山方舟：你填的是「接入点 ID」（ep-…），那是填在「模型」一栏的，不能当 API Key。' +
      '请到 console.volcengine.com/ark → API Key 管理，创建并复制 API Key（形如 ark-xxxxxxxx-xxxx-…）');
    if (!/^(ark-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-[0-9a-z]+)?$/i.test(key))
      throw new Error('火山方舟：API Key 格式不对——方舟的 Key 形如 ark-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx（或一串带连字符的 UUID）。' +
        'sk- 开头的是阿里百炼的 Key，AKLT 开头的是访问密钥，都不能用在这里。' +
        '请到 console.volcengine.com/ark → API Key 管理重新复制');
    const useModel = (c.model || '').trim() || 'doubao-seed-translation-250915';
    /* 专用翻译模型只支持 Responses 接口；通用模型 / 接入点走 chat/completions */
    if (/translation/i.test(useModel)) return this._arkResponsesTranslate(key, useModel, q);
    return this._chatTranslate({
      url: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
      apiKey: key, model: useModel, q, label: '火山方舟', defModel: 'doubao-seed-translation-250915',
      keyHint: '方舟 Key 形如 ark-<UUID>，在 console.volcengine.com/ark → API Key 管理复制；ep-… 是接入点 ID（填「模型」栏），不能当 Key'
    });
  },

  /* ---------- 方舟 Responses 接口（doubao-seed-translation 专用翻译模型） ----------
     POST /api/v3/responses，translation_options 必填（source 不支持 auto，本应用固定 en → zh）。
     输出取 output[] 里 type=message 项的 content[] 中 output_text。 */
  async _arkResponsesTranslate(key, model, q) {
    const body = JSON.stringify({
      model,
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: q, translation_options: { source_language: 'en', target_language: 'zh' } }]
      }]
    });
    let j;
    try {
      const r = await this.apiFetch('https://ark.cn-beijing.volces.com/api/v3/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body
      });
      j = await r.json();
    } catch (e) {
      throw new Error('火山方舟请求失败（网络不通、未启用本地转发，或 Key 无效）');
    }
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
  },

  /* ---------- 火山引擎 · 机器翻译（TranslateText，经典机翻，非大模型） ----------
     凭证：AccessKey / SecretKey 对（console.volcengine.com → 右上角头像 → 访问密钥；
     建议用 IAM 子账号只授权机器翻译）。需先在控制台开通机器翻译服务。
     签名：火山 V4（HMAC-SHA256，与腾讯 TC3 同思路）：
     kDate=HMAC(Secret, date) → kRegion=HMAC(hex(kDate), region) → kService=HMAC(hex(kRegion), 'translate')
     → kSigning=HMAC(hex(kService), 'request')；Authorization: HMAC-SHA256 Credential=AK/scope,…
     源语言不填 = 自动检测；TextList 单次总长 ≤5000 字符。 */
  async volmt(q) {
    const c = IR.settings.data.api.volmt || {};
    let ak = this._cleanKey(c.accessKeyId), sk = this._cleanKey(c.accessKeySecret);
    if (!ak || !sk) throw new Error('未配置火山机器翻译：设置 → 翻译接口 填 AccessKey / SecretKey');
    /* 填反了自动纠正：火山 AccessKeyId 以 AKLT 开头，Secret 常以 == 结尾 */
    if (/^AKLT/.test(sk) && !/^AKLT/.test(ak)) { const t = ak; ak = sk; sk = t; }
    const host = 'translate.volcengineapi.com', region = 'cn-north-1', service = 'translate';
    const qs = 'Action=TranslateText&Version=2020-06-01';
    const body = JSON.stringify({ TargetLanguage: 'zh', TextList: [q] });   /* SourceLanguage 留空 = 自动检测 */
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const xDate = d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
    const date = xDate.slice(0, 8);
    const canonicalHeaders = 'host:' + host + '\n' + 'x-date:' + xDate + '\n';
    const signedHeaders = 'host;x-date';
    const canonicalRequest = ['POST', '/', qs, canonicalHeaders, signedHeaders, await this._sha256Hex(body)].join('\n');
    const scope = date + '/' + region + '/' + service + '/request';
    const stringToSign = ['HMAC-SHA256', xDate, scope, await this._sha256Hex(canonicalRequest)].join('\n');
    /* 密钥派生链（与 AWS SigV4 / 腾讯 TC3 同思路）：每层 HMAC 的 key 是上一层的原始字节 */
    const kDate = await this._hmac('SHA-256', sk, date);
    const kRegion = await this._hmac('SHA-256', kDate, region);
    const kService = await this._hmac('SHA-256', kRegion, service);
    const kSigning = await this._hmac('SHA-256', kService, 'request');
    const signature = this._hex(await this._hmac('SHA-256', kSigning, stringToSign));
    const headers = {
      'Content-Type': 'application/json',
      'X-Date': xDate,
      'Authorization': 'HMAC-SHA256 Credential=' + ak + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
    };
    let j;
    try {
      const r = await this.apiFetch('https://' + host + '/?' + qs, { method: 'POST', headers, body });
      j = await r.json();
    } catch (e) {
      throw new Error('火山机器翻译请求失败（网络不通或未启用本地转发）');
    }
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
  },

  /* ---------- 火山引擎 · 机器翻译 v3（openspeech，只要 API Key） ----------
     官方调用（控制台：console.volcengine.com → 机器翻译 / 语音技术 → API Key）：
       POST https://openspeech.bytedance.com/api/v3/machine_translation/matx_translate
       x-api-key: <API Key> · X-Api-Resource-Id: volc.speech.mt · X-Api-Request-Id: <每次唯一>
       { "source_language": "auto", "target_language": "zh", "text_list": ["…"] }
     响应：{ "code": 20000000, "data": { "translation_list": [ { "translation": "…" } ] }, "message": "ok" }
     实测：source_language 支持 auto（自动识别语种）；错误码 55000000 = Invalid X-Api-Key。
     与上面的「经典版」（translate.volcengineapi.com + AccessKey 签名）是两个不同产品，互不影响。 */
  async volmt3(q) {
    const c = IR.settings.data.api.volmt3 || {};
    const key = this._cleanKey(c.apiKey);
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
      'X-Api-Request-Id': this._reqId()
    };
    let j;
    try {
      const r = await this.apiFetch('https://openspeech.bytedance.com/api/v3/machine_translation/matx_translate',
        { method: 'POST', headers, body });
      j = await r.json();
    } catch (e) {
      throw new Error('火山机器翻译请求失败（网络不通或未启用本地转发）');
    }
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
  },

  /* 请求 ID：官方要求每次唯一（32 位十六进制）；无 Web Crypto 时退化为时间戳 + 随机数 */
  _reqId() {
    try {
      const b = new Uint8Array(16);
      const c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : null;
      if (c) {
        c.getRandomValues(b);
        return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) { /* 退化路径 */ }
    return (Date.now().toString(16) + Math.random().toString(16).slice(2) + '0'.repeat(32)).slice(0, 32);
  },

  /* ---------- 本地转发（/__proxy） ----------
     浏览器直连翻译官方接口会被 CORS 拦截。桌面版内置了转发服务；
     网页版可通过随附的本地服务（tools/serve.py / start-server.bat）打开，
     两者都暴露同一个探针 GET /__proxy?ping=1，前端探测到就自动改走它。 */
  _proxyProbe: null,
  async localProxyAvailable() {
    if (this._proxyProbe !== null) return this._proxyProbe;
    try {
      const r = await fetch('__proxy?ping=1', { cache: 'no-store' });
      const j = await r.json();
      this._proxyProbe = !!(j && j.inkproxy);
    } catch (e) { this._proxyProbe = false; }
    return this._proxyProbe;
  },
  _proxySetting() {
    const p = IR.settings.data.api && IR.settings.data.api.proxy;
    return p && p.on && p.url ? String(p.url).trim() : '';
  },
  /* 统一出口：本地转发可用 → 走 /__proxy；否则直连（可能被 CORS 拦） */
  async apiFetch(url, opts) {
    opts = opts || {};
    if (await this.localProxyAvailable()) {
      const headers = Object.assign({}, opts.headers || {});
      const px = this._proxySetting();
      if (px) headers['x-ink-proxy'] = px;
      const init = { method: opts.method || 'GET', headers: headers };
      if (opts.body != null) {
        init.body = opts.body;
        if (!headers['Content-Type'] && !headers['content-type']) {
          init.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        }
      }
      /* 带上存档目录：让 /__proxy 的自定义白名单（proxy-allow.txt）跟随用户设置的存储路径 */
      const dir = ((IR.settings.data.storageDir || '') + '').trim();
      const rootQ = dir ? '&root=' + encodeURIComponent(dir) : '';
      return fetch('__proxy?url=' + encodeURIComponent(url) + rootQ, init);
    }
    return fetch(url, opts);
  },

  /* ---------- 有道智云 ----------
     官网控制台三字段（ai.youdao.com → 应用总览 → 查看应用）：
       应用ID（AppID）+ API Keys（点「查看」获取）+ 应用密钥（Secret）
     文本翻译签名：sign = sha256(appKey + input + salt + curtime + 应用密钥)。
     appKey 优先用「应用ID」（官方文档语义）；若控制台新体系要求 API Key，
     鉴权失败（108 appKey 无效 / 202 签名失败）时自动换 API Keys 重试一次。 */
  _youdaoErr: { '101': '缺少必填参数', '102': '不支持的语言类型', '103': '翻译文本过长', '108': 'appKey 无效', '110': '无接口访问权限', '111': '账户余额不足', '112': '请求过于频繁', '202': '签名检验失败', '401': '账户已经欠费停用' },
  async _youdaoCall(q, appKey, secret) {
    const salt = Date.now();
    const curtime = Math.floor(Date.now() / 1000);
    const input = q.length <= 20 ? q : q.slice(0, 10) + q.length + q.slice(-10);
    const sign = await this.sha256Hex(appKey + input + salt + curtime + secret);
    const body = new URLSearchParams({ q, from: 'auto', to: 'zh-CHS', appKey, salt, curtime, sign, signType: 'v3' });
    let j;
    try {
      const r = await this.apiFetch('https://openapi.youdao.com/api', { method: 'POST', body });
      j = await r.json();
    } catch (e) {
      if (e && /^转发失败/.test(e.message || '')) throw new Error('有道' + e.message);
      throw new Error('有道请求失败（网络不通、CORS 拦截或未启用本地转发；网页版请用 start-server 启动以便走本地转发）');
    }
    if (j.errorCode && j.errorCode !== '0') throw new Error('有道 ' + j.errorCode + '：' + (this._youdaoErr[j.errorCode] || '未知错误'));
    let out = (j.translation || []).join('；');
    if (j.basic && j.basic.explains) out += (out ? '\n' : '') + j.basic.explains.join('；');
    return { engine: '有道', text: (out || '（无结果）').trim() };
  },
  async youdao(q) {
    const api = IR.settings.data.api.youdao;
    const appId = (api.key || '').trim();
    const apiKey = (api.apiKeys || '').trim();
    const secret = (api.secret || '').trim();
    if (!secret || (!appId && !apiKey)) throw new Error('未配置有道：设置 → 翻译接口 填 应用ID（或 API Keys）/ 应用密钥');
    if (appId) {
      try { return await this._youdaoCall(q, appId, secret); }
      catch (e) {
        /* 鉴权类错误且填了 API Keys → 换 API Keys 作为 appKey 重试 */
        if (apiKey && /108|202/.test(e.message)) return await this._youdaoCall(q, apiKey, secret);
        throw e;
      }
    }
    return this._youdaoCall(q, apiKey, secret);
  },

  /* ---------- DeepL（API Free / Pro 自动判断，只要一个 API Key） ----------
     API Key：deepl.com → 账户 → API 密钥（免费版 Key 以 :fx 结尾）
     自动按 Key 后缀选 api-free / api，失败再换另一个。 */
  async deepl(q) {
    const c = IR.settings.data.api.deepl || {};
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
        const r = await this.apiFetch(base + '/v2/translate', {
          method: 'POST',
          headers: { 'Authorization': 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        });
        if (r.status === 401 || r.status === 403) { lastErr = 'API Key 无效（HTTP ' + r.status + '）'; continue; }
        if (r.status === 456) { lastErr = '本月额度已用完（HTTP 456）'; continue; }
        if (!r.ok) { lastErr = 'HTTP ' + r.status; continue; }
        j = await r.json();
      } catch (e) { throw new Error('DeepL 请求失败（网络不通或未启用本地转发）'); }
      const t = j.translations && j.translations[0] && j.translations[0].text;
      if (!t) { lastErr = '返回空结果'; continue; }
      return { engine: 'DeepL', text: String(t).trim() };
    }
    throw new Error('DeepL：' + lastErr);
  },

  /* ---------- 微软翻译（Azure 认知服务：Key + 可选区域） ----------
     Azure 门户 → 翻译服务资源 → 「密钥和终结点」里的 KEY 1；多服务/区域资源需填区域（如 eastasia）。 */
  async ms(q) {
    const c = IR.settings.data.api.ms || {};
    const key = (c.apiKey || '').trim();
    if (!key) throw new Error('未配置微软翻译：设置 → 翻译接口 填 API Key');
    const headers = { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': key };
    const region = (c.region || '').trim();
    if (region) headers['Ocp-Apim-Subscription-Region'] = region;
    let j;
    try {
      const r = await this.apiFetch(
        'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans',
        { method: 'POST', headers, body: JSON.stringify([{ Text: q }]) });
      j = await r.json();
    } catch (e) { throw new Error('微软翻译请求失败（网络不通或未启用本地转发）'); }
    if (j && j.error) {
      const code = j.error.code || '';
      const hint = code === 401001 || code === 401000
        ? '（Key 无效或区域不匹配：多服务/区域资源必须在设置里填区域，如 eastasia）' : '';
      throw new Error('微软翻译 ' + code + '：' + (j.error.message || '') + hint);
    }
    const t = j && j[0] && j[0].translations && j[0].translations[0] && j[0].translations[0].text;
    return { engine: '微软翻译', text: String(t || '（无结果）').trim() };
  },

  /* ---------- LibreTranslate（开源，可自建；公开实例通常需要 Key） ----------
     地址可填公开实例或你自建的实例（如 http://localhost:5000）；
     自建实例可留空 API Key。自建域名若不在转发白名单内，
     把它加到 <存档目录>/proxy-allow.txt（每行一个域名，后缀写 *.example.com）。 */
  async libre(q) {
    const c = IR.settings.data.api.libre || {};
    let base = (c.url || '').trim() || 'https://libretranslate.com';
    base = base.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    const body = { q, source: 'en', target: 'zh', format: 'text' };
    const key = (c.apiKey || '').trim();
    if (key) body.api_key = key;
    let j;
    try {
      const r = await this.apiFetch(base + '/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      j = await r.json();
    } catch (e) {
      throw new Error('LibreTranslate 请求失败（地址不通、未启用本地转发，或该域名不在转发白名单内）');
    }
    if (j.error) throw new Error('LibreTranslate：' + j.error);
    if (!j.translatedText) throw new Error('LibreTranslate 返回空结果（公开实例可能需要 API Key）');
    return { engine: 'LibreTranslate', text: String(j.translatedText).trim() };
  },

  /* ---------- 免费内置引擎（无需 Key） ----------
     实测（2026-09，大陆网络）：
       MyMemory —— CORS 全开（*），国内直连可用，免费额度约 5000 字/天/IP
       谷歌 gtx  —— translate_a/single 官方免费接口，CORS 全开，但国内网络不可达（需代理）
       必应      —— Edge auth token + api.cognitive.microsofttranslator.com，CORS 预检全放行，
                    但 edge.microsoft.com 的 token 接口对大陆 IP 返回 404（需海外网络）
     桌面版（WPF）内置了 API 转发，可解除部分限制 */
  async mymemory(q) {
    /* 注意：不要带 de 参数——MyMemory 会校验邮箱，任意占位邮箱会被拒（INVALID EMAIL PROVIDED） */
    const u = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q.slice(0, 500)) + '&langpair=en|zh-CN';
    let j;
    try {
      const r = await this.apiFetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      j = await r.json();
    } catch (e) { throw new Error('MyMemory 请求失败（网络不通）'); }
    const t = j.responseData && j.responseData.translatedText;
    if (!t || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(t)) throw new Error('MyMemory：' + (j.responseDetails || t || '无结果'));
    return { engine: 'MyMemory', text: t.trim() };
  },

  async google(q) {
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' + encodeURIComponent(q);
    let j;
    try {
      const r = await this.apiFetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      j = await r.json();
    } catch (e) { throw new Error('谷歌翻译不可达（免费接口国内网络通常不通，需代理或在设置里填代理地址）'); }
    const text = (j[0] || []).map(s => s && s[0]).filter(Boolean).join('');
    return { engine: '谷歌', text: (text || '（无结果）').trim() };
  },

  async bing(q) {
    /* 免费令牌（Edge 浏览器同款接口），有效期约 10 分钟，缓存 8 分钟 */
    if (!this._bingToken || Date.now() > this._bingTokenExp) {
      let r;
      try { r = await this.apiFetch('https://edge.microsoft.com/translate/auth'); }
      catch (e) { throw new Error('必应翻译不可达（网络不通）'); }
      if (!r.ok) throw new Error('必应令牌获取失败（该接口对大陆网络有地区限制，需海外网络或代理）');
      this._bingToken = (await r.text()).trim();
      this._bingTokenExp = Date.now() + 8 * 60 * 1000;
    }
    let j;
    try {
      const r = await this.apiFetch('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + this._bingToken, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ Text: q.slice(0, 1000) }])
      });
      if (!r.ok) {
        if (r.status === 401) { this._bingToken = null; throw new Error('必应令牌过期，请重试'); }
        throw new Error('必应 HTTP ' + r.status);
      }
      j = await r.json();
    } catch (e) {
      if (e.message && e.message.startsWith('必应')) throw e;
      throw new Error('必应翻译请求失败（网络不通或 CORS 拦截）');
    }
    const text = j[0] && j[0].translations && j[0].translations[0].text;
    return { engine: '必应', text: (text || '（无结果）').trim() };
  },

  /* ---------- 统一入口 ---------- */
  _engines: ['youdao', 'tencent', 'aliyun', 'alimt', 'volcano', 'volmt3', 'volmt', 'deepl', 'ms', 'libre', 'google', 'bing', 'mymemory'],
  async run(q, engine) {
    const e = engine || IR.settings.data.api.engine || 'auto';
    if (this._engines.indexOf(e) >= 0) return this[e](q);
    /* auto：已配置的官方接口依次尝试（有道 → 阿里百炼 → 阿里机器翻译 → 火山方舟 → 火山机器翻译 v3 → 火山机器翻译经典
       → DeepL → 微软 → LibreTranslate），最后兜底免费 MyMemory */
    const api = IR.settings.data.api;
    /* 各引擎是否已配置（配置了才参与 auto） */
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
    const configured = {
      youdao: !!(y.secret && (y.key || y.apiKeys)),
      tencent: !!(t.secretId && t.secretKey),
      aliyun: !!al.apiKey,
      alimt: !!(am.accessKeyId && am.accessKeySecret),
      volcano: !!v.apiKey,
      volmt3: !!vmt3.apiKey,
      volmt: !!(vmt.accessKeyId && vmt.accessKeySecret),
      deepl: !!dp.apiKey,
      ms: !!ms.apiKey,
      libre: !!(lb.url || lb.apiKey)
    };
    /* 尝试顺序：用户自定义（设置 → 翻译接口 → 自动模式顺序）优先；
       默认腾讯垫底；用户列表里漏掉的引擎补到末尾，保证新增引擎仍可用 */
    const AUTO_ENGINES = this.AUTO_ENGINES;
    let order = Array.isArray(api.autoOrder) && api.autoOrder.length
      ? api.autoOrder.filter(n => AUTO_ENGINES.indexOf(n) >= 0) : AUTO_ENGINES.slice();
    for (const k of AUTO_ENGINES) if (order.indexOf(k) < 0) order.push(k);
    const chain = [];
    for (const n of order) if (configured[n]) chain.push(n);
    chain.push('mymemory');

    const errs = [];
    for (const name of chain) {
      try { return await this[name](q); }
      catch (err) { errs.push(err.message); }
    }
    throw new Error(errs.join('；') || '没有可用的翻译引擎');
  }
};
