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
      volcano: { apiKey: '', model: '' },
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

/* 3. 四家官方引擎已注册 + 未配置时报错可读 */
const OFFICIAL = [['youdao', '有道'], ['tencent', '腾讯云'], ['aliyun', '阿里云百炼'], ['volcano', '火山方舟']];
for (const [name, label] of OFFICIAL) {
  check('引擎已注册 ' + name, typeof T[name] === 'function');
}
for (const [name, label] of OFFICIAL.slice(1).concat([['youdao', '有道']])) {
  let msg = '';
  try { await T[name]('hello'); } catch (e) { msg = e.message; }
  check('未配置提示 ' + name, msg.indexOf(label) >= 0 && msg.indexOf('未配置') === 0, msg);
}
check('已删除的引擎不再存在', !T.baidu && !T.huawei && !T._baiduToken);

/* 3b. 只要 API Key 的两家：字段就是 apiKey */
IR.settings.data.api.aliyun = { apiKey: '', model: '' };
IR.settings.data.api.volcano = { apiKey: '', model: '' };
for (const [name, label] of [['aliyun', '阿里云百炼'], ['volcano', '火山方舟']]) {
  let msg = '';
  try { await T[name]('hello'); } catch (e) { msg = e.message; }
  check(name + ' 只要求填 API Key', /未配置/.test(msg) && msg.indexOf('API Key') >= 0 && msg.indexOf('AccessKey') < 0, msg);
}

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
check('auto 顺序 有道→腾讯→阿里', r6.engine === '阿里云百炼' && called.join(',') === 'youdao,tencent,aliyun', called.join(','));

console.log(results.join('\n'));
console.log('FAILS=' + results.filter(r => r.startsWith('FAIL')).length + '/' + results.length);
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
