/* 端到端验证本地转发服务（需先启动 tools/serve.py） */
import crypto from 'crypto';

const PORT = process.env.PORT || 8644;
const BASE = 'http://127.0.0.1:' + PORT;

const results = [];
const check = (name, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + extra : ''));

/* 1. 探针 */
try {
  const r = await fetch(BASE + '/__proxy?ping=1');
  const j = await r.json();
  check('探针 /__proxy?ping=1', r.status === 200 && j.inkproxy === 1, JSON.stringify(j));
} catch (e) { check('探针 /__proxy?ping=1', false, e.message); }

/* 2. 静态文件 */
for (const [p, expect] of [['/index.html', 'text/html'], ['/js/translate.js', 'text/javascript'], ['/css/app.css', 'text/css'], ['/dict/a.json', 'application/json']]) {
  try {
    const r = await fetch(BASE + p);
    const ct = r.headers.get('content-type') || '';
    check('静态 ' + p, r.status === 200 && ct.indexOf(expect) === 0, r.status + ' ' + ct);
  } catch (e) { check('静态 ' + p, false, e.message); }
}

/* 3. 有道（签名 POST 走转发） */
try {
  const q = 'hello';
  const salt = Date.now();
  const curtime = Math.floor(Date.now() / 1000);
  const appKey = process.env.YD_ID, secret = process.env.YD_SECRET;
  const input = q.length <= 20 ? q : q.slice(0, 10) + q.length + q.slice(-10);
  const sign = crypto.createHash('sha256').update(appKey + input + salt + curtime + secret).digest('hex');
  const body = new URLSearchParams({ q, from: 'auto', to: 'zh-CHS', appKey, salt, curtime, sign, signType: 'v3' });
  const target = 'https://openapi.youdao.com/api';
  const r = await fetch(BASE + '/__proxy?url=' + encodeURIComponent(target), { method: 'POST', body });
  const j = await r.json();
  check('有道经转发', j.errorCode === '0' && (j.translation || []).length > 0, 'errorCode=' + j.errorCode + ' 译文=' + (j.translation || []).join(''));
} catch (e) { check('有道经转发', false, e.message); }

/* 4. MyMemory（GET 走转发） */
try {
  const target = 'https://api.mymemory.translated.net/get?q=hello&langpair=en|zh-CN';
  const r = await fetch(BASE + '/__proxy?url=' + encodeURIComponent(target));
  const j = await r.json();
  check('MyMemory 经转发', !!(j.responseData && j.responseData.translatedText), j.responseData && j.responseData.translatedText);
} catch (e) { check('MyMemory 经转发', false, e.message); }

/* 5. 白名单：非翻译域名应被拒 */
try {
  const r = await fetch(BASE + '/__proxy?url=' + encodeURIComponent('https://example.com/'));
  check('白名单拦截', r.status === 403, 'status=' + r.status);
} catch (e) { check('白名单拦截', false, e.message); }

/* 6. 目录穿越防护 */
try {
  const r = await fetch(BASE + '/../README.md');
  check('目录穿越防护', r.status === 404 || r.status === 400, 'status=' + r.status);
} catch (e) { check('目录穿越防护', false, e.message); }

console.log(results.join('\n'));
console.log('FAILS=' + results.filter(r => r.startsWith('FAIL')).length + '/' + results.length);
