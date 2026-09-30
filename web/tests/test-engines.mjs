/* 新增翻译引擎与文本渲染的单元验证（无需真实凭证） */
import fs from 'fs';
import crypto from 'crypto';

globalThis.window = globalThis;
/* util.js 顶层会绑 document 事件：给个最小桩 */
globalThis.document = {
  documentElement: { dataset: {} },
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() {
    return {
      style: {}, dataset: {}, setAttribute() {}, appendChild() {}, addEventListener() {},
      remove() {}, classList: { add() {}, remove() {}, toggle() {} }
    };
  },
  body: { appendChild() {} }
};
const read = p => fs.readFileSync(new URL('../js/' + p, import.meta.url), 'utf8');
eval(read('util.js'));
eval(read('translate.js'));

/* 最小 settings 桩（四家官方接口：有道 / 腾讯 / 阿里百炼 / 火山方舟） */
IR.settings = {
  data: {
    api: {
      engine: 'auto',
      youdao: { key: '', apiKeys: '', secret: '' },
      tencent: { secretId: '', secretKey: '', region: 'ap-guangzhou' },
      aliyun: { apiKey: '', model: '' },
      alimt: { accessKeyId: '', accessKeySecret: '', edition: 'general', scene: 'social' },
      volcano: { apiKey: '', model: '' },
      volmt: { accessKeyId: '', accessKeySecret: '' },
      deepl: { apiKey: '' },
      ms: { apiKey: '', region: '' },
      libre: { url: '', apiKey: '' },
      proxy: { on: false, url: '' }
    }
  }
};

const results = [];
const check = (name, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));

/* 1. 换行渲染：字面量 \n（词典数据形式）与真实换行都要变 <br> */
check('escLines 字面量 \\n', IR.escLines('a\\nb') === 'a<br>b', IR.escLines('a\\nb'));
check('escLines 字面量 \\r\\n', IR.escLines('a\\r\\nb') === 'a<br>b', IR.escLines('a\\r\\nb'));
check('escLines 真实换行', IR.escLines('a\nb') === 'a<br>b', IR.escLines('a\nb'));
check('escLines 转义 + 换行', IR.escLines('<x>\\ny') === '&lt;x&gt;<br>y', IR.escLines('<x>\\ny'));

/* 2. HMAC / hex / base64 工具与 Node crypto 对齐 */
const T = IR.translate;
check('_hex', T._hex(new Uint8Array([0, 15, 255])) === '000fff', T._hex(new Uint8Array([0, 15, 255])));
check('_b64', T._b64(new TextEncoder().encode('hello')) === Buffer.from('hello').toString('base64'));
for (const algo of ['SHA-256', 'SHA-1']) {
  const mine = T._hex(await T._hmac(algo, 'secretKey', 'message'));
  const ref = crypto.createHmac(algo === 'SHA-256' ? 'sha256' : 'sha1', 'secretKey').update('message').digest('hex');
  check('_hmac ' + algo, mine === ref, mine.slice(0, 16) + '…');
}
check('_sha256Hex', (await T._sha256Hex('abc')) === crypto.createHash('sha256').update('abc').digest('hex'));

/* 3. 官方/自建引擎已注册 + 未配置时报错可读 */
const OFFICIAL = [['youdao', '有道'], ['tencent', '腾讯云'], ['aliyun', '阿里云百炼'], ['alimt', '阿里云机器翻译'], ['volcano', '火山方舟'], ['volmt', '火山机器翻译'],
  ['deepl', 'DeepL'], ['ms', '微软翻译'], ['libre', 'LibreTranslate']];
for (const [name, label] of OFFICIAL) {
  check('引擎已注册 ' + name, typeof T[name] === 'function');
}
for (const [name, label] of OFFICIAL.slice(1).filter(x => x[0] !== 'libre' && x[0] !== 'alimt' && x[0] !== 'volmt')) {   /* libre 可零配置；alimt/volmt 是双字段，单独测 */
  let msg = '';
  try { await T[name]('hello'); } catch (e) { msg = e.message; }
  check('未配置提示 ' + name, msg.indexOf(label) >= 0 && msg.indexOf('未配置') === 0, msg);
}
check('已删除的引擎不再存在', !T.baidu && !T.huawei && !T._baiduToken);

/* 3b. 只要 API Key（或自建地址）的引擎：报错里不得出现 AccessKey */
IR.settings.data.api.aliyun = { apiKey: '', model: '' };
IR.settings.data.api.volcano = { apiKey: '', model: '' };
IR.settings.data.api.deepl = { apiKey: '' };
IR.settings.data.api.ms = { apiKey: '', region: '' };
for (const [name, label] of [['aliyun', '阿里云百炼'], ['volcano', '火山方舟'], ['deepl', 'DeepL'], ['ms', '微软翻译']]) {
  let msg = '';
  try { await T[name]('hello'); } catch (e) { msg = e.message; }
  check(name + ' 只要求填 API Key', /未配置/.test(msg) && msg.indexOf('API Key') >= 0 && msg.indexOf('AccessKey') < 0, msg);
}

/* 3b2. 火山方舟 Key 清洗 / 格式预检 / Responses 接口路由 */
{
  const of = T.apiFetch;
  let vm = '';
  IR.settings.data.api.volcano = { apiKey: ' Bearer ep-20240910 ', model: '' };
  try { await T.volcano('hello'); } catch (e) { vm = e.message; }
  check('火山方舟：ep- 不能当 Key（误粘 Bearer 前缀也被清掉）', vm.indexOf('接入点 ID') >= 0, vm);
  IR.settings.data.api.volcano = { apiKey: 'sk-not-ark-key', model: '' };
  vm = '';
  try { await T.volcano('hello'); } catch (e) { vm = e.message; }
  check('火山方舟：非方舟 Key 提示格式', vm.indexOf('ark-') >= 0 && vm.indexOf('sk-') >= 0, vm);
  IR.settings.data.api.volcano = { apiKey: '123e4567-e89b-12d3-a456-426614174000', model: '' };
  T.apiFetch = async () => ({ ok: true, status: 200, json: async () => ({ error: { message: 'The API key format is incorrect. Request id: x' } }) });
  vm = '';
  try { await T.volcano('hello'); } catch (e) { vm = e.message; }
  check('火山方舟：Key 类错误给专属提示（不误导去改模型）', vm.indexOf('Key 无效') >= 0 && vm.indexOf('ark-') >= 0 && vm.indexOf('模型不存在') < 0, vm);

  /* ark- 前缀 Key（豆包新版形态）+ 翻译模型 → Responses 接口 */
  let cap = null;
  T.apiFetch = async (url, opts) => {
    cap = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '敏捷的棕色狐狸' }] }
    ] }) };
  };
  IR.settings.data.api.volcano = { apiKey: 'ark-123e4567-e89b-12d3-a456-426614174000-be732', model: '' };
  const rv = await T.volcano('The quick brown fox.');
  check('火山方舟：ark- Key + 翻译模型走 Responses 接口',
    cap.url === 'https://ark.cn-beijing.volces.com/api/v3/responses' &&
    cap.body.model === 'doubao-seed-translation-250915' &&
    cap.body.input[0].content[0].translation_options.target_language === 'zh', cap.url + ' | ' + JSON.stringify(cap.body.model));
  check('火山方舟：Responses 译文解析', rv.engine === '火山方舟' && rv.text === '敏捷的棕色狐狸', JSON.stringify(rv));

  /* 显式填通用模型 → 仍走 chat/completions */
  cap = null;
  IR.settings.data.api.volcano = { apiKey: 'ark-123e4567-e89b-12d3-a456-426614174000-be732', model: 'ep-2024' };
  await T.volcano('hi');
  check('火山方舟：非翻译模型走 chat/completions', cap.url.indexOf('chat/completions') >= 0 && cap.body.model === 'ep-2024', cap.url);

  /* 「模型不存在/无权访问」错误给开通指引 */
  T.apiFetch = async () => ({ ok: true, status: 200, json: async () => ({ error: { code: 'InvalidEndpointOrModel.NotFound', message: 'The model or endpoint doubao-seed-1-6-250615 does not exist or you do not have access to it.' } }) });
  vm = '';
  try { await T.volcano('hello'); } catch (e) { vm = e.message; }
  check('火山方舟：模型不存在给开通指引', vm.indexOf('未开通') >= 0, vm);

  T.apiFetch = of;
  IR.settings.data.api.volcano = { apiKey: '', model: '' };
}

/* 3b3. 阿里云机器翻译（TranslateGeneral，RPC V1 签名，HMAC-SHA1） */
{
  const of = T.apiFetch;
  let vm = '';
  try { await T.alimt('hello'); } catch (e) { vm = e.message; }
  check('alimt 未配置提示', vm.indexOf('阿里云机器翻译') >= 0 && vm.indexOf('未配置') === 0 && vm.indexOf('AccessKeyId') >= 0, vm);

  let cap = null;
  T.apiFetch = async (url, opts) => {
    cap = { url, method: opts.method };
    return { ok: true, status: 200, json: async () => ({ TranslateGeneralResponse: { Code: 200, Data: { Translated: '你好' } } }) };
  };
  IR.settings.data.api.alimt = { accessKeyId: 'LTAI5tTEST', accessKeySecret: 'testSecret' };
  const am = await T.alimt('hello world');
  check('alimt 请求结构（GET + mt.aliyuncs.com + TranslateGeneral + auto→zh）',
    cap.method === 'GET' &&
    cap.url.indexOf('https://mt.aliyuncs.com/?') === 0 &&
    cap.url.indexOf('Action=TranslateGeneral') >= 0 &&
    cap.url.indexOf('SourceLanguage=auto') >= 0 && cap.url.indexOf('TargetLanguage=zh') >= 0, cap.url);
  /* 参数按 key 排序（规范化查询串） */
  const qs1 = cap.url.slice(cap.url.indexOf('?') + 1);
  const canonPart = qs1.slice(0, qs1.indexOf('&Signature='));
  const keysSorted = canonPart.split('&').map(kv => kv.slice(0, kv.indexOf('=')));
  const sortedOk = keysSorted.every((k, i) => i === 0 || keysSorted[i - 1] <= k);
  check('alimt 参数按 key 排序', sortedOk, keysSorted.join(','));
  /* 签名独立校验：Node crypto 按 RPC V1 规则重算比对 */
  const sig = decodeURIComponent(qs1.slice(qs1.indexOf('&Signature=') + '&Signature='.length));
  const pct = s => encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const expect = crypto.createHmac('sha1', 'testSecret&').update('GET&%2F&' + pct(canonPart)).digest('base64');
  check('alimt RPC V1 签名与 Node crypto 一致', sig === expect, sig + ' vs ' + expect);
  check('alimt 译文解析（包装结构）', am.engine === '阿里云机器翻译' && am.text === '你好', JSON.stringify(am));

  T.apiFetch = async () => ({ ok: true, status: 200, json: async () => ({ Code: 200, Data: { Translated: '你好（平铺）' } }) });
  const am2 = await T.alimt('hello');
  check('alimt 译文解析（平铺结构）', am2.text === '你好（平铺）', JSON.stringify(am2));

  T.apiFetch = async () => ({ ok: true, status: 200, json: async () => ({ TranslateGeneralResponse: { Code: 10010, Message: 'no service' } }) });
  let e2 = '';
  try { await T.alimt('hello'); } catch (err) { e2 = err.message; }
  check('alimt 未开通错误给指引', e2.indexOf('10010') >= 0 && e2.indexOf('开通') >= 0, e2);

  /* auto 链：只配 alimt 时走 alimt */
  IR.settings.data.api.youdao = { key: '', apiKeys: '', secret: '' };
  IR.settings.data.api.tencent = { secretId: '', secretKey: '', region: 'ap-guangzhou' };
  IR.settings.data.api.aliyun = { apiKey: '', model: '' };
  T.apiFetch = async () => ({ ok: true, status: 200, json: async () => ({ Code: 200, Data: { Translated: '汽车' } }) });
  const am3 = await T.run('car', 'auto');
  check('auto 只配 alimt 时走 alimt', am3.engine === '阿里云机器翻译', JSON.stringify(am3));

  /* 专业版：Action=Translate + Scene */
  cap = null;
  T.apiFetch = async (url) => { cap = { url }; return { ok: true, status: 200, json: async () => ({ Code: 200, Data: { Translated: '诊断' } }) }; };
  IR.settings.data.api.alimt = { accessKeyId: 'LTAI5tTEST', accessKeySecret: 'testSecret', edition: 'pro', scene: 'medical' };
  const am4 = await T.alimt('diagnosis');
  check('alimt 专业版走 Translate + Scene + 平铺响应',
    cap.url.indexOf('Action=Translate&') >= 0 && cap.url.indexOf('Scene=medical') >= 0 &&
    am4.engine.indexOf('专业版') >= 0 && am4.text === '诊断', cap.url + ' | ' + JSON.stringify(am4));

  T.apiFetch = of;
  IR.settings.data.api.alimt = { accessKeyId: '', accessKeySecret: '' };
}

/* 3b4. 火山机器翻译（TranslateText，V4 签名，HMAC-SHA256） */
{
  const of = T.apiFetch;
  let vm = '';
  try { await T.volmt('hello'); } catch (e) { vm = e.message; }
  check('volmt 未配置提示', vm.indexOf('火山机器翻译') >= 0 && vm.indexOf('未配置') === 0 && vm.indexOf('AccessKey') >= 0, vm);

  let cap = null;
  T.apiFetch = async (url, opts) => {
    cap = { url, headers: opts.headers, body: opts.body };
    return { ok: true, status: 200, json: async () => ({ TranslationList: [{ Translation: '你好世界', DetectedSourceLanguage: 'en' }], ResponseMetadata: { Action: 'TranslateText' } }) };
  };
  IR.settings.data.api.volmt = { accessKeyId: 'AKTEST', accessKeySecret: 'skTest' };
  const rv = await T.volmt('Hello world');
  check('volmt 请求结构（POST + Action=TranslateText + auto→zh + TextList）',
    cap.url === 'https://translate.volcengineapi.com/?Action=TranslateText&Version=2020-06-01' &&
    /"TargetLanguage":"zh"/.test(cap.body) && /"TextList":\["Hello world"\]/.test(cap.body), cap.url + ' | ' + cap.body);
  check('volmt 译文解析', rv.engine === '火山机器翻译' && rv.text === '你好世界', JSON.stringify(rv));
  /* V4 签名交叉验证：用 Node crypto 按官方文档规则独立重算 */
  const xDate = cap.headers['X-Date'];
  const H = (k, m) => crypto.createHmac('sha256', k).update(m).digest();
  const hexB = b => Buffer.from(b).toString('hex');
  const kDate = H('skTest', xDate.slice(0, 8));
  const kRegion = H(hexB(kDate), 'cn-north-1');
  const kService = H(hexB(kRegion), 'translate');
  const kSigning = H(hexB(kService), 'request');
  const canonical = ['POST', '/', 'Action=TranslateText&Version=2020-06-01',
    'host:translate.volcengineapi.com\nx-date:' + xDate + '\n', 'host;x-date',
    crypto.createHash('sha256').update(cap.body).digest('hex')].join('\n');
  const sts = ['HMAC-SHA256', xDate, xDate.slice(0, 8) + '/cn-north-1/translate/request',
    crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const expectSig = crypto.createHmac('sha256', hexB(kSigning)).update(sts).digest('hex');
  const sig = ((cap.headers['Authorization'] || '').match(/Signature=([0-9a-f]+)/) || [])[1];
  check('volmt V4 签名与 Node crypto 一致', sig === expectSig, sig + ' vs ' + expectSig);
  check('volmt Authorization 头格式', /^HMAC-SHA256 Credential=AKTEST\/\d{8}\/cn-north-1\/translate\/request, SignedHeaders=host;x-date, Signature=[0-9a-f]+$/.test(cap.headers['Authorization']), cap.headers['Authorization'].slice(0, 60));

  /* 错误映射：ResponseMetadata.Error */
  T.apiFetch = async () => ({ ok: true, status: 200, json: async () => ({ ResponseMetadata: { Error: { Code: '415', Message: 'unsupported language pair' } } }) });
  let ev = '';
  try { await T.volmt('hello'); } catch (err) { ev = err.message; }
  check('volmt 错误带提示', ev.indexOf('415') >= 0 && ev.indexOf('语向') >= 0, ev);

  /* auto 链：只配 volmt 时走 volmt */
  IR.settings.data.api.volcano = { apiKey: '', model: '' };
  T.apiFetch = async () => ({ ok: true, status: 200, json: async () => ({ TranslationList: [{ Translation: '汽车' }], ResponseMetadata: {} }) });
  const rv2 = await T.run('car', 'auto');
  check('auto 只配 volmt 时走 volmt', rv2.engine === '火山机器翻译', JSON.stringify(rv2));

  T.apiFetch = of;
  IR.settings.data.api.volmt = { accessKeyId: '', accessKeySecret: '' };
}

/* 3c. DeepL 按 Key 后缀自动选端点（:fx → api-free 优先） */
let deeplUrls = [];
const origFetchApi = T.apiFetch;
T.apiFetch = async (url) => { deeplUrls.push(url); return { ok: true, status: 200, json: async () => ({ translations: [{ text: '你好' }] }) }; };
IR.settings.data.api.deepl = { apiKey: 'xxx:fx' };
check('DeepL 免费 Key 走 api-free', (await T.deepl('hello')).text === '你好' && deeplUrls[0].indexOf('api-free.deepl.com') >= 0, deeplUrls[0]);
deeplUrls = [];
IR.settings.data.api.deepl = { apiKey: 'pro-key' };
await T.deepl('hello');
check('DeepL 付费 Key 走 api', deeplUrls[0].indexOf('//api.deepl.com') >= 0, deeplUrls[0]);
IR.settings.data.api.deepl = { apiKey: '' };

/* 3d. LibreTranslate：留空地址用官方实例，自建地址原样使用 */
let libreUrls = [];
T.apiFetch = async (url) => { libreUrls.push(url); return { ok: true, status: 200, json: async () => ({ translatedText: '你好' }) }; };
IR.settings.data.api.libre = { url: '', apiKey: '' };
await T.libre('hello');
check('Libre 默认用官方实例', libreUrls[0] === 'https://libretranslate.com/translate', libreUrls[0]);
libreUrls = [];
IR.settings.data.api.libre = { url: 'http://localhost:5000/', apiKey: '' };
await T.libre('hello');
check('Libre 自建地址被采用（去尾斜杠）', libreUrls[0] === 'http://localhost:5000/translate', libreUrls[0]);
IR.settings.data.api.libre = { url: 'my-libre.example.com', apiKey: 'k' };
libreUrls = [];
await T.libre('hello');
check('Libre 无协议时补 https', libreUrls[0] === 'https://my-libre.example.com/translate', libreUrls[0]);
IR.settings.data.api.libre = { url: '', apiKey: '' };
T.apiFetch = origFetchApi;

/* 4. 引擎分派：指定引擎走对应实现 */
T.mymemory = async () => ({ engine: 'MyMemory', text: '桩' });
check('run 指定 mymemory', (await T.run('x', 'mymemory')).engine === 'MyMemory');
check('run 指定 tencent 走 tencent', /未配置/.test(await T.run('x', 'tencent').catch(e => e.message)));

/* 5. auto 链：只配置腾讯云时应优先走腾讯云 */
IR.settings.data.api.tencent = { secretId: 'id', secretKey: 'key', region: 'ap-guangzhou' };
let called = [];
for (const n of ['youdao', 'tencent', 'aliyun', 'volcano', 'mymemory']) {
  T[n] = async () => { called.push(n); if (n === 'tencent') return { engine: '腾讯云', text: 'ok' }; throw new Error(n + ' 失败'); };
}
const autoRes = await T.run('x', 'auto');
check('auto 优先命中已配置的腾讯云', autoRes.engine === '腾讯云' && called[0] === 'tencent', called.join('→'));

/* 6. auto 顺序：有道 → 腾讯 → 阿里（三家都配置时） */
called = [];
IR.settings.data.api.youdao = { key: 'k', apiKeys: '', secret: 's' };
IR.settings.data.api.aliyun = { apiKey: 'sk-x', model: '' };
for (const n of ['youdao', 'tencent', 'aliyun', 'volcano', 'mymemory']) {
  const label = n;
  T[n] = async () => { called.push(label); if (label === 'aliyun') return { engine: '阿里云百炼', text: 'ok' }; throw new Error(label); };
}
const r6 = await T.run('x', 'auto');
check('auto 顺序 有道→阿里（腾讯默认垫底）', r6.engine === '阿里云百炼' && called.join(',') === 'youdao,aliyun', called.join(','));

/* 6b. 自动模式顺序用户可自定义（s.api.autoOrder） */
called = [];
IR.settings.data.api.deepl = { apiKey: 'k' };
IR.settings.data.api.autoOrder = ['deepl', 'youdao'];
T.deepl = async () => { called.push('deepl'); throw new Error('deepl 失败'); };
T.youdao = async () => { called.push('youdao'); return { engine: '有道', text: 'ok' }; };
T.tencent = async () => { called.push('tencent'); throw new Error('tencent 失败'); };
const r7 = await T.run('x', 'auto');
check('auto 自定义顺序生效', r7.engine === '有道' && called.join(',') === 'deepl,youdao', called.join(','));
IR.settings.data.api.autoOrder = null;
IR.settings.data.api.deepl = { apiKey: '' };

console.log(results.join('\n'));
console.log('FAILS=' + results.filter(r => r.startsWith('FAIL')).length + '/' + results.length);
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
