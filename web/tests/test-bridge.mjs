/* 桥接协议往返测试：Node 模拟 WebView2 宿主环境 */
import fs from 'fs';

let captured = [];
let origCalled = 0;

globalThis.window = globalThis;
globalThis.location = { href: 'https://app.inkread/index.html' };
globalThis.chrome = { webview: { postMessage(msg) { captured.push(JSON.parse(msg)); } } };
const realFetch = async () => { origCalled++; return 'ORIGINAL'; };
globalThis.fetch = realFetch;

eval(fs.readFileSync(new URL('../js/desktop-bridge.js', import.meta.url), 'utf8'));

const results = [];
const check = (name, cond) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + name);

/* 1. 非 API 域名 → 走原始 fetch */
const r1 = await fetch('https://app.inkread/js/util.js');
check('非API域名走原fetch', r1 === 'ORIGINAL' && captured.length === 0 && origCalled === 1);

/* 2. 有道式 POST（URLSearchParams body）→ 拦截进桥，回灌 JSON Response */
const p2 = fetch('https://openapi.youdao.com/api', {
  method: 'POST',
  body: new URLSearchParams({ q: 'hello', appKey: 'test', sign: 'abc' })
});
await new Promise(r => setTimeout(r, 30));
check('API请求被拦截且发出1条消息', captured.length === 1);
const m2 = captured[0];
check('消息含__ink/id/url', m2.__ink === 1 && /^ink\d+$/.test(m2.id) && m2.url === 'https://openapi.youdao.com/api');
check('方法为POST', m2.method === 'POST');
const bodyStr = Buffer.from(m2.bodyB64, 'base64').toString('utf8');
check('URLSearchParams体正确转发', bodyStr === 'q=hello&appKey=test&sign=abc');

window.__inkProxyDone({
  id: m2.id, status: 200, contentType: 'application/json',
  bodyB64: Buffer.from('{"errorCode":"0","translation":["你好"]}', 'utf8').toString('base64')
});
const resp2 = await p2;
check('回灌Response.ok', resp2.ok === true);
const j2 = await resp2.json();
check('回灌JSON可解析', j2.translation[0] === '你好');

/* 3. 必应式 POST（JSON body + Authorization 头） */
const p3 = fetch('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans', {
  method: 'POST',
  headers: { Authorization: 'Bearer tok123', 'Content-Type': 'application/json' },
  body: JSON.stringify([{ Text: 'hello' }])
});
await new Promise(r => setTimeout(r, 30));
const m3 = captured[1];
check('必应请求头被收集', m3 && m3.headers.Authorization === 'Bearer tok123' && m3.headers['Content-Type'] === 'application/json');
const body3 = Buffer.from(m3.bodyB64, 'base64').toString('utf8');
check('JSON体正确转发', body3 === '[{"Text":"hello"}]');

window.__inkProxyDone({ id: m3.id, status: 401, contentType: 'application/json', bodyB64: '' });
const resp3 = await p3;
check('401状态透传 ok=false', resp3.ok === false && resp3.status === 401);

/* 4. 错误路径：宿主失败 → reject（TypeError） */
const p4 = fetch('https://translate.googleapis.com/translate_a/single?client=gtx&q=x', { method: 'GET' });
await new Promise(r => setTimeout(r, 30));
const m4 = captured[2];
check('GET请求bodyB64为空', m4 && m4.bodyB64 === '' && m4.method === 'GET');
window.__inkProxyDone({ id: m4.id, error: '转发失败: 网络超时' });
let err4 = null;
try { await p4; } catch (e) { err4 = e; }
check('错误路径正常reject', err4 instanceof TypeError);

/* 5. 并发请求各自配对 */
const ps = [1, 2, 3].map(i => fetch('https://api.mymemory.translated.net/get?q=' + i));
await new Promise(r => setTimeout(r, 30));
const ms = captured.slice(3);
check('并发3条消息id互不相同', new Set(ms.map(x => x.id)).size === 3);
ms.forEach((mm, i) => window.__inkProxyDone({ id: mm.id, status: 200, contentType: 'text/plain', bodyB64: Buffer.from('r' + i).toString('base64') }));
const rs = await Promise.all(ps);
check('并发响应配对正确', (await rs[0].text()) === 'r0' && (await rs[1].text()) === 'r1' && (await rs[2].text()) === 'r2');

/* 6. 中文与特殊字符安全过 base64 */
const p6 = fetch('https://openapi.youdao.com/api', { method: 'POST', body: 'q=锚点&符号=+/=' });
await new Promise(r => setTimeout(r, 30));
const m6 = captured[captured.length - 1];
const b6 = Buffer.from(m6.bodyB64, 'base64').toString('utf8');
check('中文/特殊字符体无损', b6 === 'q=锚点&符号=+/=');

console.log(results.join('\n'));
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(`TOTAL=${results.length} FAILS=${fails}`);
process.exit(fails ? 1 : 0);
