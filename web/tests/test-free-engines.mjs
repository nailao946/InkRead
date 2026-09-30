/* 临时验证脚本：有道凭证 / 谷歌 gtx / 必应 Edge auth / MyMemory */
import crypto from 'crypto';

const YD = { id: process.env.YD_ID, keys: process.env.YD_KEYS, secret: process.env.YD_SECRET };

/* 1. 有道（服务端直连，无 CORS） */
async function youdao(appKey, secret) {
  const q = 'hello';
  const salt = Date.now();
  const curtime = Math.floor(Date.now() / 1000);
  const input = q.length <= 20 ? q : q.slice(0, 10) + q.length + q.slice(-10);
  const sign = crypto.createHash('sha256').update(appKey + input + salt + curtime + secret).digest('hex');
  const body = new URLSearchParams({ q, from: 'auto', to: 'zh-CHS', appKey, salt, curtime, sign, signType: 'v3' });
  const r = await fetch('https://openapi.youdao.com/api', { method: 'POST', body });
  const acao = r.headers.get('access-control-allow-origin');
  const j = await r.json();
  return { status: r.status, acao, errorCode: j.errorCode, translation: j.translation };
}

/* 2. 谷歌 gtx 免费接口 */
async function google() {
  const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' + encodeURIComponent('hello world');
  const r = await fetch(u);
  const acao = r.headers.get('access-control-allow-origin');
  const j = await r.json();
  return { status: r.status, acao, text: j[0].map(s => s[0]).join(''), detected: j[2] };
}

/* 3. 必应：Edge auth token + MS Translator */
async function bing() {
  const ar = await fetch('https://edge.microsoft.com/translate/auth');
  const acao1 = ar.headers.get('access-control-allow-origin');
  const token = await ar.text();
  const tr = await fetch('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ Text: 'hello world' }])
  });
  const acao2 = tr.headers.get('access-control-allow-origin');
  const j = await tr.json();
  return { authOk: ar.status, acao1, acao2, status: tr.status, text: j[0] && j[0].translations && j[0].translations[0].text };
}

/* 3b. 必应预检（浏览器 CORS 是否放行 POST+JSON+Authorization） */
async function bingPreflight() {
  const r = await fetch('https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans', {
    method: 'OPTIONS',
    headers: {
      'Origin': 'http://127.0.0.1:8642',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type'
    }
  });
  return {
    status: r.status,
    acao: r.headers.get('access-control-allow-origin'),
    acam: r.headers.get('access-control-allow-methods'),
    acah: r.headers.get('access-control-allow-headers')
  };
}

/* 4. MyMemory 免费接口 */
async function mymemory() {
  const r = await fetch('https://api.mymemory.translated.net/get?q=hello&langpair=en|zh-CN');
  const acao = r.headers.get('access-control-allow-origin');
  const j = await r.json();
  return { status: r.status, acao, text: j.responseData && j.responseData.translatedText };
}

const out = {};
try { out.youdao_id = await youdao(YD.id, YD.secret); } catch (e) { out.youdao_id = 'ERR: ' + e.cause?.code + ' ' + e.message; }
try { out.youdao_keys = await youdao(YD.keys, YD.secret); } catch (e) { out.youdao_keys = 'ERR: ' + e.cause?.code + ' ' + e.message; }
try { out.google = await google(); } catch (e) { out.google = 'ERR: ' + e.cause?.code + ' ' + e.message; }
try { out.bing = await bing(); } catch (e) { out.bing = 'ERR: ' + e.cause?.code + ' ' + e.message; }
try { out.bing_preflight = await bingPreflight(); } catch (e) { out.bing_preflight = 'ERR: ' + e.cause?.code + ' ' + e.message; }
try { out.mymemory = await mymemory(); } catch (e) { out.mymemory = 'ERR: ' + e.cause?.code + ' ' + e.message; }
console.log(JSON.stringify(out, null, 2));
