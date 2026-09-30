/* 用真实凭证验证 volmt 签名实现（端到端，直连不走代理）
   用法：设置环境变量 VOLMT_AK / VOLMT_SK 后运行（凭据不入库）：
     $env:VOLMT_AK='AKLT...'; $env:VOLMT_SK='...'; node test-volmt-real.mjs */
import fs from 'fs';
globalThis.window = globalThis;
globalThis.document = { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {} }), body: { appendChild() {} } };
eval(fs.readFileSync(new URL('../js/util.js', import.meta.url), 'utf8'));
eval(fs.readFileSync(new URL('../js/translate.js', import.meta.url), 'utf8'));
const AK = process.env.VOLMT_AK || '';
const SK = process.env.VOLMT_SK || '';
if (!AK || !SK) { console.log('SKIP：未设置 VOLMT_AK / VOLMT_SK 环境变量'); process.exit(0); }
IR.settings = { data: { api: { volmt: { accessKeyId: AK, accessKeySecret: SK } } } };
try {
  const r = await IR.translate.volmt('The quick brown fox jumps over the lazy dog.');
  console.log('OK engine=' + r.engine + ' text=' + r.text);
} catch (e) {
  console.log('ERR ' + e.message);
}
