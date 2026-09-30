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
check('桌面桥覆盖官方接口域名', ['tmt.tencentcloudapi.com', 'dashscope.aliyuncs.com', 'ark.cn-beijing.volces.com', 'api.mymemory.translated.net']
  .every(h => bridge.indexOf(h) >= 0));

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
check('reader 含分组文件夹卡渲染', readerSrc.indexOf('_folderCellHtml') >= 0);
check('reader 含难度评估（阶梯阅读法）', readerSrc.indexOf('levelOf') >= 0 && readerSrc.indexOf('i+1 理想区') >= 0);
check('reader 含分组图标选择', readerSrc.indexOf('GROUP_ICONS') >= 0 && readerSrc.indexOf('openGroupDialog') >= 0);
check('reader 含词频统计', readerSrc.indexOf('computeBookStats') >= 0);
const css = readFileSync(path.join(ROOT, 'css/app.css'), 'utf8');
check('样式含分组文件夹卡与加粗进度条', css.indexOf('.folder-cell') >= 0 && /\.book-prog \{[^}]*height: 8px/.test(css));
check('卡片信息行固定高度（对齐）', /\.book-title \{[^}]*height: 2\.8em/.test(css) && /\.book-author \{[^}]*height: 1\.35em/.test(css));

/* 7. 设置页挂载冒烟：settings.js 的 mount() 必须不抛错且关键结构齐全
   （防回归：曾在真机报 "extra is not defined" 而测试全绿——本节补上这层覆盖） */
{
  globalThis.window = globalThis;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  const fakeEl = () => ({
    innerHTML: '', textContent: '', value: '', type: 'text', className: '', dataset: {}, style: {},
    addEventListener() {}, appendChild() {}, removeChild() {}, querySelector: () => fakeEl(), querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {} }, closest: () => null, parentElement: null
  });
  globalThis.document = {
    documentElement: { dataset: {}, style: {} },
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => fakeEl(), body: fakeEl()
  };
  const els = {};
  const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const IR = globalThis.IR = {
    $: (sel) => els[sel] || (els[sel] = fakeEl()),
    $$: () => [],
    el: () => fakeEl(),
    esc,
    THEMES: [{ id: '0', name: '纸墨', desc: '默认', swatch: {} }],
    applyTheme() {}, toast() {},
    tts: { voices: [], speak() {} },
    filestore: { ready: false, probe: async () => false, storeNow: async () => ({}), restore: async () => ({}), list: async () => [] },
    settings: {
      data: {
        theme: '0', colors: null, tts: { voiceURI: '', rate: 0.9, autoSpeak: true }, storageDir: '', reader: {},
        api: {
          engine: 'auto',
          youdao: { key: '', apiKeys: '', secret: '' },
          tencent: { secretId: '', secretKey: '', region: 'ap-guangzhou' },
          aliyun: { apiKey: '', model: '' },
          alimt: { accessKeyId: '', accessKeySecret: '', edition: 'general', scene: 'social' },
          volcano: { apiKey: '', model: '' },
          volmt: { accessKeyId: '', accessKeySecret: '' },
          deepl: { apiKey: '' }, ms: { apiKey: '', region: '' }, libre: { url: '', apiKey: '' },
          proxy: { on: false, url: '' }
        }
      },
      save() {}
    },
    translate: {
      AUTO_ENGINES: ['youdao', 'aliyun', 'alimt', 'volcano', 'volmt', 'deepl', 'ms', 'libre', 'tencent'],
      localProxyAvailable: async () => false
    }
  };
  const mountEl = fakeEl();
  try {
    eval(readFileSync(path.join(ROOT, 'js/settings.js'), 'utf8'));
    IR.settingsPage.mount(mountEl);
    check('设置页 mount 不抛错', true);
  } catch (e) {
    check('设置页 mount 不抛错', false, e.message);
  }
  const src = mountEl.innerHTML;
  check('设置页含默认引擎下拉与 8+ 引擎选项', /data-engine/.test(src) && (src.match(/<option value="/g) || []).length >= 12);
  check('设置页含 alimt 版本切换与场景下拉', src.indexOf('data-api-in="alimt.edition"') >= 0 && src.indexOf('data-api-in="alimt.scene"') >= 0);
  check('设置页含密码显隐控件', src.indexOf('data-pw-eye') >= 0);
  check('设置页含自动模式排序 UI', src.indexOf('data-order-list') >= 0 && src.indexOf('data-order-reset') >= 0);
  const orderHtml = els['[data-order-list]'] ? els['[data-order-list]'].innerHTML : '';
  const names = [...orderHtml.matchAll(/order-name">([^<]+)</g)].map(m => m[1]);
  check('排序列表渲染 9 个引擎且腾讯垫底', names.length === 9 && names[names.length - 1] === '腾讯云 TMT', names.join(','));
  check('排序行含上移/下移按钮', (orderHtml.match(/data-order-up/g) || []).length === 9 && (orderHtml.match(/data-order-down/g) || []).length === 9);
}

console.log(results.join('\n'));
console.log('FAILS=' + results.filter(r => r.startsWith('FAIL')).length + '/' + results.length);
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
