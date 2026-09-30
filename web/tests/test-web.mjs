/* Web 端完整性检查：静态资源可达性 + 模块齐备 + 关键能力探测
   用法：先 `python web/tools/serve.py 8647 --no-open`，再 `node web/tests/test-web.mjs` */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8647';

const results = [];
const check = (n, c, extra) => results.push((c ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + String(extra).slice(0, 160) : ''));

/* 1. index.html 引用的资源全部可达且 MIME 正确 */
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="((?!https?:|#)[^"]+)"/g)].map(m => m[1])
  .filter(u => !u.startsWith('data:'));
check('index.html 引用资源数 ≥ 15', refs.length >= 15, refs.length + ' 个');

let bad = [];
for (const u of refs) {
  const r = await fetch(BASE + '/' + u);
  const ct = (r.headers.get('content-type') || '').split(';')[0];
  const okMime = /\.js$/.test(u) ? ct === 'text/javascript' : /\.css$/.test(u) ? ct === 'text/css' : true;
  if (!r.ok || !okMime) bad.push(`${u} → ${r.status} ${ct}`);
}
check('引用资源全部 200 且 MIME 正确', bad.length === 0, bad.join(' ; '));

/* 2. 关键脚本都存在（含本轮新增） */
const need = ['js/util.js', 'js/storage.js', 'js/dict.js', 'js/themes.js', 'js/importers.js',
  'js/translate.js', 'js/vocab.js', 'js/filestore.js', 'js/reader.js', 'js/settings.js',
  'js/app.js', 'js/desktop-bridge.js', 'sw.js', 'manifest.json'];
const missing = [];
for (const f of need) {
  const r = await fetch(BASE + '/' + f);
  if (!r.ok) missing.push(f + ':' + r.status);
}
check('关键脚本/清单齐全', missing.length === 0, missing.join(','));

/* 3. 桌面桥在纯浏览器下必须"不接管"（避免网页版走错通道） */
const bridge = readFileSync(path.join(ROOT, 'js/desktop-bridge.js'), 'utf8');
check('桌面桥有 chrome.webview 守卫', /if \(!window\.chrome \|\| !window\.chrome\.webview/.test(bridge));
check('桌面桥覆盖 6 家云厂商域名', ['tmt.tencentcloudapi.com', 'open.volcengineapi.com', 'api.mymemory.translated.net']
  .every(h => bridge.indexOf(h) >= 0) || /HOSTS = \[/.test(bridge));

/* 4. 本地服务能力：转发 + 存档 + 白名单 */
try {
  const ping = await (await fetch(BASE + '/__proxy?ping=1')).json();
  check('翻译转发可用', ping.inkproxy === 1, JSON.stringify(ping));
} catch (e) { check('翻译转发可用', false, e.message); }
try {
  const st = await (await fetch(BASE + '/__store/ping')).json();
  check('磁盘存档可用', st.store === 1 && !!st.root, st.root);
} catch (e) { check('磁盘存档可用', false, e.message); }
try {
  const r = await fetch(BASE + '/__proxy?url=' + encodeURIComponent('https://example.com/'));
  check('转发白名单生效（非翻译域名 403）', r.status === 403, 'status=' + r.status);
} catch (e) { check('转发白名单生效（非翻译域名 403）', false, e.message); }

/* 5. 页面关键结构（书架分组条 / 阅读视图 / 设置挂载点） */
for (const [name, re] of [
  ['书架分组条 #shelfGroups', /id="shelfGroups"/],
  ['书架列表 #shelfList', /id="shelfList"/],
  ['阅读视图 #readingView', /id="readingView"/],
  ['设置挂载点 #settingsMount', /id="settingsMount"/]
]) check('页面结构：' + name, re.test(html));

/* 6. 新版前端代码已就位（分组框 / 难度统计 / 图标选择） */
const readerSrc = readFileSync(path.join(ROOT, 'js/reader.js'), 'utf8');
check('reader 含分组框渲染', readerSrc.indexOf('_groupFrameHtml') >= 0);
check('reader 含难度评估（阶梯阅读法）', readerSrc.indexOf('levelOf') >= 0 && readerSrc.indexOf('i+1 理想区') >= 0);
check('reader 含分组图标选择', readerSrc.indexOf('GROUP_ICONS') >= 0 && readerSrc.indexOf('openGroupDialog') >= 0);
check('reader 含词频统计', readerSrc.indexOf('computeBookStats') >= 0);
const css = readFileSync(path.join(ROOT, 'css/app.css'), 'utf8');
check('样式含分组框与加粗进度条', css.indexOf('.group-frame') >= 0 && /\.book-prog \{[^}]*height: 8px/.test(css));
check('卡片信息行固定高度（对齐）', /\.book-title \{[^}]*height: 2\.8em/.test(css) && /\.book-author \{[^}]*height: 1\.35em/.test(css));

console.log(results.join('\n'));
console.log('FAILS=' + results.filter(r => r.startsWith('FAIL')).length + '/' + results.length);
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
