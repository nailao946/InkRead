/* 端到端验证本地转发服务（需先启动 tools/serve.py） */
import crypto from 'crypto';

const PORT = process.env.PORT || 8644;
const BASE = process.env.BASE || ('http://127.0.0.1:' + PORT);

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

/* 3. 有道（签名 POST 走转发）—— 无凭证时跳过（不记为失败） */
if (!process.env.YD_ID || !process.env.YD_SECRET) {
  results.push('SKIP 有道经转发（未提供 YD_ID/YD_SECRET 环境变量）');
} else try {
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

/* 7. 用户自定义白名单（<存档目录>/proxy-allow.txt）：精确域名与后缀两种形式 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'ink-proxy-allow-'));
writeFileSync(path.join(tmpRoot, 'proxy-allow.txt'), '# 自定义允许\nself-hosted.example\n*.wild.example\n');
const rootQ = '&root=' + encodeURIComponent(tmpRoot);
try {
  /* 7a. 默认（不带 root）时仍是 403 */
  const r0 = await fetch(BASE + '/__proxy?url=' + encodeURIComponent('https://self-hosted.example/'));
  check('未带存档目录时仍拒绝', r0.status === 403, 'status=' + r0.status);
  /* 7b. 带 root 且域名在 proxy-allow.txt 里 → 放行（域名不通会 502，关键是不再是 403） */
  const r1 = await fetch(BASE + '/__proxy?url=' + encodeURIComponent('https://self-hosted.example/') + rootQ);
  check('自定义白名单放行精确域名', r1.status !== 403, 'status=' + r1.status);
  /* 7c. 后缀形式：sub.wild.example 也应放行 */
  const r2 = await fetch(BASE + '/__proxy?url=' + encodeURIComponent('https://sub.wild.example/') + rootQ);
  check('自定义白名单放行后缀域名', r2.status !== 403, 'status=' + r2.status);
  /* 7d. 不在文件里的域名仍拒绝 */
  const r3 = await fetch(BASE + '/__proxy?url=' + encodeURIComponent('https://other.example/') + rootQ);
  check('未列入的域名仍拒绝', r3.status === 403, 'status=' + r3.status);
} catch (e) { check('自定义白名单', false, e.message); }
rmSync(tmpRoot, { recursive: true, force: true });

/* 8. 界面内嵌网页（剑桥词典小窗）：白名单放行 + 根相对链接被改写成上游绝对地址
   （不改写的话页面样式/脚本会指向本地服务而 404；上游不可达时记为 SKIP） */
const CAMB = 'https://dictionary.cambridge.org/dictionary/english/undaunted';
try {
  const r = await fetch(BASE + '/__proxy?url=' + encodeURIComponent(CAMB));
  if (r.status !== 200) {
    results.push('SKIP 剑桥小窗经转发（上游不可达 status=' + r.status + '）');
  } else {
    const html = await r.text();
    const ct = r.headers.get('content-type') || '';
    check('剑桥小窗：转发返回 HTML', /text\/html/.test(ct) && /undaunted/i.test(html), ct);
    check('剑桥小窗：无 X-Frame-Options（可被 iframe 内嵌）', !r.headers.get('x-frame-options'));
    const relLeft = (html.match(/(?:href|src)="\/(?!\/)/g) || []).length;
    const rewritten = (html.match(/="https:\/\/dictionary\.cambridge\.org\//g) || []).length;
    check('剑桥小窗：根相对链接已改写成绝对地址', rewritten > 0 && relLeft === 0, '改写 ' + rewritten + ' 条 / 残留 ' + relLeft + ' 条');
  }
} catch (e) { check('剑桥小窗经转发', false, e.message); }

/* 9. 自定义鉴权头必须透传到上游。
   回归背景：旧实现只放行了 authorization/content-type/accept/accept-language 四个头，
   于是 x-api-key（火山机器翻译 v3）、Ocp-Apim-Subscription-Key（微软翻译）等会被静默丢掉，
   表现是「网页版经转发报缺参数、桌面版直连正常」这种极难定位的故障。
   这里用无效 Key 打火山 v3 接口：透传成功 → 上游回 “Invalid X-Api-Key”；被吞掉 → 回 “missing X-Api-Key”。 */
const OPENSPEECH = 'https://openspeech.bytedance.com/api/v3/machine_translation/matx_translate';
try {
  const r = await fetch(BASE + '/__proxy?url=' + encodeURIComponent(OPENSPEECH), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'invalid-key-for-test',
      'X-Api-Resource-Id': 'volc.speech.mt',
      'X-Api-Request-Id': 'test-request-id-0123456789abcdef'
    },
    body: JSON.stringify({ source_language: 'auto', target_language: 'zh', text_list: ['hello'] })
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* 非 JSON */ }
  const msg = String((j && j.message) || '');
  if (!msg) {
    results.push('SKIP 自定义鉴权头透传（上游无响应 status=' + r.status + '）');
  } else {
    check('自定义鉴权头透传：x-api-key 到达上游',
      !/missing/i.test(msg) && /key/i.test(msg), msg);
    check('自定义鉴权头透传：X-Api-Request-Id 到达上游', !/missing X-Api-Request-Id/i.test(msg), msg);
  }
} catch (e) { check('自定义鉴权头透传', false, e.message); }

console.log(results.join('\n'));
console.log('FAILS=' + results.filter(r => r.startsWith('FAIL')).length + '/' + results.length);
