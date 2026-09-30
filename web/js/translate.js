/* 墨读 InkRead — 翻译接口（M2）
   有道智云 v3（SHA-256 签名）+ 百度翻译（MD5 签名），key 在设置页配置
   + 三个免费内置引擎（MyMemory 国内直连 / 谷歌 gtx / 必应 Edge auth，均无需 Key）
   划词翻译句子用；单词释义仍走内置词库（M3 接 ECDICT） */
window.IR = window.IR || {};

IR.translate = {
  /* ---------- MD5（百度签名用，纯 JS，输入先转 UTF-8 字节串） ---------- */
  md5(str) {
    const s = unescape(encodeURIComponent(str));  /* 转 UTF-8 字节串 */
    function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
    function cmn(q, a, b, x, s, t) {
      a = add32(add32(a, q), add32(x, t));
      return add32((a << s) | (a >>> (32 - s)), b);
    }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
    function md5cycle(x, k) {
      let a = x[0], b = x[1], c = x[2], d = x[3];
      a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586);
      c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
      a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426);
      c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
      a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417);
      c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
      a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);
      c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
      a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632);
      c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
      a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083);
      c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
      a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690);
      c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
      a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
      c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
      a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463);
      c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
      a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353);
      c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
      a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222);
      c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
      a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835);
      c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
      a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415);
      c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
      a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606);
      c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
      a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744);
      c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
      a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379);
      c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
      x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
    }
    function md5blk(sb) {
      const blks = [];
      for (let i = 0; i < 64; i += 4) {
        blks[i >> 2] = sb.charCodeAt(i) + (sb.charCodeAt(i + 1) << 8) + (sb.charCodeAt(i + 2) << 16) + (sb.charCodeAt(i + 3) << 24);
      }
      return blks;
    }
    const state = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= s.length; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
    const tail = s.substring(i - 64);
    const t = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let j;
    for (j = 0; j < tail.length; j++) t[j >> 2] |= tail.charCodeAt(j) << ((j % 4) << 3);
    t[j >> 2] |= 0x80 << ((j % 4) << 3);
    if (j > 55) { md5cycle(state, t); for (j = 0; j < 16; j++) t[j] = 0; }
    t[14] = s.length * 8;
    md5cycle(state, t);
    const hexc = '0123456789abcdef';
    const rhex = n => { let out = ''; for (let k = 0; k < 4; k++) out += hexc[(n >> (k * 8 + 4)) & 15] + hexc[(n >> (k * 8)) & 15]; return out; };
    return state.map(rhex).join('');
  },

  /* ---------- SHA-256（有道 v3 签名用 Web Crypto） ---------- */
  async sha256Hex(str) {
    if (!(window.crypto && crypto.subtle)) throw new Error('当前环境不支持 Web Crypto（请用本地服务器或桌面版打开）');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  /* ---------- 签名工具（腾讯 TC3 / 阿里 HMAC-SHA1 / 华为 SDK-HMAC / 火山 v4 共用） ---------- */
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
     开通：机器翻译 TMT（每月 500 万字符免费额度） */
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

  /* ---------- 阿里云机器翻译（经典 RPC + HMAC-SHA1 签名） ----------
     控制台：ram.console.aliyun.com/manage/ak → AccessKey ID / AccessKey Secret
     开通：机器翻译 mt（每月 100 万字符免费额度） */
  async aliyun(q) {
    const c = IR.settings.data.api.aliyun || {};
    const ak = (c.accessKeyId || '').trim(), sk = (c.accessKeySecret || '').trim();
    if (!ak || !sk) throw new Error('未配置阿里云：设置 → 翻译接口 填 AccessKey ID / AccessKey Secret');
    const params = {
      AccessKeyId: ak,
      Action: 'TranslateGeneral',
      Format: 'JSON',
      RegionId: (c.region || 'cn-hangzhou').trim(),
      Scene: 'general',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: String(Date.now()) + Math.random().toString(36).slice(2, 8),
      SignatureVersion: '1.0',
      SourceLanguage: 'en',
      SourceText: q,
      TargetLanguage: 'zh',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: '2018-10-12'
    };
    /* 阿里云 RPC 签名：percentEncode 规则特殊（空格 %20、* %2A、~ 不编码） */
    const pe = s => encodeURIComponent(String(s)).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
    const canonical = Object.keys(params).sort().map(k => pe(k) + '=' + pe(params[k])).join('&');
    const stringToSign = 'GET&' + pe('/') + '&' + pe(canonical);
    const signature = this._b64(await this._hmac('SHA-1', sk + '&', stringToSign));
    const url = 'https://mt.aliyuncs.com/?Signature=' + pe(signature) + '&' + canonical;
    let j;
    try {
      const r = await this.apiFetch(url);
      j = await r.json();
    } catch (e) { throw new Error('阿里云请求失败（网络不通或未启用本地转发）'); }
    if (j.Code && String(j.Code) !== '200') throw new Error('阿里云 ' + j.Code + '：' + (j.Message || ''));
    const t = j.Data && (j.Data.Translated || j.Data.Translation);
    return { engine: '阿里云', text: String(t || '（无结果）').trim() };
  },

  /* ---------- 华为云机器翻译（SDK-HMAC-SHA256 签名；需要项目 ID） ----------
     控制台：console.huaweicloud.com → 我的凭证 → 访问密钥（AK/SK）+ 项目 ID
     开通：机器翻译 MT */
  async huawei(q) {
    const c = IR.settings.data.api.huawei || {};
    const ak = (c.ak || '').trim(), sk = (c.sk || '').trim(), pid = (c.projectId || '').trim();
    if (!ak || !sk || !pid) throw new Error('未配置华为云：设置 → 翻译接口 填 AK / SK / 项目ID');
    const region = (c.region || 'cn-north-4').trim();
    const host = 'mt.' + region + '.myhuaweicloud.com';
    const uri = '/v1/' + pid + '/machine-translation/text';
    const ct = 'application/json';
    const payload = JSON.stringify({ text: q, from: 'en', to: 'zh' });
    const xsd = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');   /* 20200930T120000Z */
    const hashedPayload = await this._sha256Hex(payload);
    const canonicalHeaders = 'content-type:' + ct + '\nhost:' + host + '\nx-sdk-date:' + xsd + '\n';
    const signedHeaders = 'content-type;host;x-sdk-date';
    const canonicalRequest = ['POST', uri, '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
    const stringToSign = ['SDK-HMAC-SHA256', xsd, await this._sha256Hex(canonicalRequest)].join('\n');
    const signature = this._hex(await this._hmac('SHA-256', sk, stringToSign));
    const headers = {
      'Content-Type': ct,
      'X-Sdk-Date': xsd,
      'Authorization': 'SDK-HMAC-SHA256 Access=' + ak + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
    };
    let j;
    try {
      const r = await this.apiFetch('https://' + host + uri, { method: 'POST', headers, body: payload });
      j = await r.json();
    } catch (e) { throw new Error('华为云请求失败（网络不通或未启用本地转发）'); }
    if (j.error_code) throw new Error('华为云 ' + j.error_code + '：' + (j.error_msg || ''));
    const t = j.translation || j.result || (j.translations && j.translations[0]);
    return { engine: '华为云', text: String(t || '（无结果）').trim() };
  },

  /* ---------- 火山引擎机器翻译（HMAC-SHA256 v4 签名） ----------
     控制台：console.volcengine.com/iam/keymanage → AccessKey / SecretKey
     开通：机器翻译 translate */
  async volcano(q) {
    const c = IR.settings.data.api.volcano || {};
    const ak = (c.accessKey || '').trim(), sk = (c.secretKey || '').trim();
    if (!ak || !sk) throw new Error('未配置火山引擎：设置 → 翻译接口 填 AccessKey / SecretKey');
    const region = (c.region || 'cn-north-1').trim();
    const service = 'translate', host = 'open.volcengineapi.com';
    const action = 'TranslateText', version = '2020-06-01';
    const ct = 'application/json';
    const payload = JSON.stringify({ SourceLanguage: 'en', TargetLanguage: 'zh', TextList: [q] });
    const xdate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');   /* 20200930T120000Z */
    const date = xdate.slice(0, 8);
    const hashedPayload = await this._sha256Hex(payload);
    const query = 'Action=' + action + '&Version=' + version;
    const canonicalHeaders = 'content-type:' + ct + '\nhost:' + host + '\n' +
      'x-content-sha256:' + hashedPayload + '\nx-date:' + xdate + '\n';
    const signedHeaders = 'content-type;host;x-content-sha256;x-date';
    const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders, hashedPayload].join('\n');
    const scope = date + '/' + region + '/' + service + '/request';
    const stringToSign = ['HMAC-SHA256', xdate, scope, await this._sha256Hex(canonicalRequest)].join('\n');
    const kDate = await this._hmac('SHA-256', sk, date);
    const kRegion = await this._hmac('SHA-256', kDate, region);
    const kService = await this._hmac('SHA-256', kRegion, service);
    const kSigning = await this._hmac('SHA-256', kService, 'request');
    const signature = this._hex(await this._hmac('SHA-256', kSigning, stringToSign));
    const headers = {
      'Content-Type': ct,
      'X-Date': xdate,
      'X-Content-Sha256': hashedPayload,
      'Authorization': 'HMAC-SHA256 Credential=' + ak + '/' + scope +
        ', SignedHeaders=' + signedHeaders + ', Signature=' + signature
    };
    let j;
    try {
      const r = await this.apiFetch('https://' + host + '/?' + query, { method: 'POST', headers, body: payload });
      j = await r.json();
    } catch (e) { throw new Error('火山引擎请求失败（网络不通或未启用本地转发）'); }
    if (j.ResponseMetadata && j.ResponseMetadata.Error) {
      const er = j.ResponseMetadata.Error;
      throw new Error('火山引擎 ' + (er.Code || '') + '：' + (er.Message || ''));
    }
    const t = (j.TranslationList && j.TranslationList[0] && j.TranslationList[0].Translation) ||
      j.Translation || (j.Data && j.Data.Translation);
    return { engine: '火山引擎', text: String(t || '（无结果）').trim() };
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
      return fetch('__proxy?url=' + encodeURIComponent(url), init);
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

  /* ---------- 百度智能云机器翻译（access_token 方式） ----------
     官网字段（百度智能云 cloud.baidu.com → 机器翻译 → 创建应用）：
       应用ID（AppID）+ API Key + 应用密钥（Secret Key）
     流程：用 API Key + Secret Key 换 access_token（缓存 30 天）→ 调 texttrans/v1 */
  _baiduErr: { '110': 'Access Token 无效或过期', '111': 'Access Token 过期', '2001': '获取 token 失败', '2002': '翻译失败（参数或服务）', '3001': 'q 为空', '3002': '语种错误', '3004': '未开通服务或欠费', '3005': '请求超长' },
  async _baiduToken(api) {
    const cacheKey = 'ir.baidu.token';
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cached && cached.token && cached.expire > Date.now()) return cached.token;
    } catch (e) { /* 无缓存 */ }
    const url = 'https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials' +
      '&client_id=' + encodeURIComponent(api.apiKey) +
      '&client_secret=' + encodeURIComponent(api.secretKey);
    let j;
    try {
      const r = await this.apiFetch(url, { method: 'POST' });
      j = await r.json();
    } catch (e) {
      if (e && /^转发失败/.test(e.message || '')) throw new Error('百度' + e.message);
      throw new Error('获取百度 access_token 失败（网络不通、CORS 拦截或未启用本地转发）');
    }
    if (!j.access_token) throw new Error('百度鉴权失败：' + (j.error_description || j.error || '未知'));
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ token: j.access_token, expire: Date.now() + (j.expires_in || 2592000) * 1000 - 60000 }));
    } catch (e) { /* 存储失败则每次现取 */ }
    return j.access_token;
  },
  async baidu(q) {
    const api = IR.settings.data.api.baidu;
    if (!api.apiKey || !api.secretKey) throw new Error('未配置百度：设置 → 翻译接口 填 API Key / 应用密钥');
    const token = await this._baiduToken(api);
    const url = 'https://aip.baidubce.com/rpc/2.0/mt/texttrans/v1?access_token=' + encodeURIComponent(token);
    let j;
    try {
      const r = await this.apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, from: 'auto', to: 'zh', appid: api.appid || undefined })
      });
      j = await r.json();
    } catch (e) {
      if (e && /^转发失败/.test(e.message || '')) throw new Error('百度' + e.message);
      throw new Error('百度请求失败（网络不通、CORS 拦截或未启用本地转发）');
    }
    if (j.error_code && j.error_code !== 0) throw new Error('百度 ' + j.error_code + '：' + (this._baiduErr[j.error_code] || j.error_msg || '未知错误'));
    const res = (j.result && j.result.trans_result) || j.trans_result || [];
    const out = res.map(t => t.dst).join('\n');
    return { engine: '百度', text: (out || '（无结果）').trim() };
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
  _engines: ['youdao', 'baidu', 'tencent', 'volcano', 'aliyun', 'huawei', 'google', 'bing', 'mymemory'],
  async run(q, engine) {
    const e = engine || IR.settings.data.api.engine || 'auto';
    if (this._engines.indexOf(e) >= 0) return this[e](q);
    /* auto：已配置的官方接口依次尝试（有道 → 百度 → 腾讯 → 火山 → 阿里 → 华为），最后兜底免费 MyMemory */
    const api = IR.settings.data.api;
    const chain = [];
    const y = api.youdao, b = api.baidu;
    if (y.secret && (y.key || y.apiKeys)) chain.push('youdao');
    if (b.apiKey && b.secretKey) chain.push('baidu');
    if (api.tencent.secretId && api.tencent.secretKey) chain.push('tencent');
    if (api.volcano.accessKey && api.volcano.secretKey) chain.push('volcano');
    if (api.aliyun.accessKeyId && api.aliyun.accessKeySecret) chain.push('aliyun');
    if (api.huawei.ak && api.huawei.sk && api.huawei.projectId) chain.push('huawei');
    chain.push('mymemory');

    const errs = [];
    for (const name of chain) {
      try { return await this[name](q); }
      catch (err) { errs.push(err.message); }
    }
    throw new Error(errs.join('；') || '没有可用的翻译引擎');
  }
};
