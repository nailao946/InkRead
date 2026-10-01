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
  .filter(u => !u.startsWith('data:') && !u.startsWith('about:'));   /* about:blank 是词典小窗 iframe 的占位 src */
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
check('桌面桥覆盖官方接口域名', ['tmt.tencentcloudapi.com', 'dashscope.aliyuncs.com', 'ark.cn-beijing.volces.com', 'api.mymemory.translated.net', 'openspeech.bytedance.com']
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

/* 5. 页面关键结构（书架分组条 / 阅读视图 / 设置挂载点 / 剑桥词典小窗） */
for (const [name, re] of [
  ['书架分组条 #shelfGroups', /id="shelfGroups"/],
  ['书架列表 #shelfList', /id="shelfList"/],
  ['阅读视图 #readingView', /id="readingView"/],
  ['设置挂载点 #settingsMount', /id="settingsMount"/],
  ['剑桥词典小窗 #dictPanel', /id="dictPanel"/],
  ['剑桥词典 iframe #dictFrame', /id="dictFrame"/]
]) check('页面结构：' + name, re.test(html));
check('书架不再有导入格式提示条（dropzone 已删）', html.indexOf('id="dropzone"') < 0 && html.indexOf('class="dropzone"') < 0);
check('词典小窗 iframe 带 sandbox（disable 同源与顶层跳转）',
  /id="dictFrame"[\s\S]{0,200}sandbox="allow-scripts/.test(html) && /sandbox="[^"]*"/.test(html) && !/sandbox="[^"]*allow-same-origin/.test(html));
check('样式含词典小窗抽屉', /\.dict-panel\s*\{/.test(readFileSync(path.join(ROOT, 'css/app.css'), 'utf8')));

/* 6. 新版前端代码已就位（分组框 / 难度统计 / 图标选择） */
const readerSrc = readFileSync(path.join(ROOT, 'js/reader.js'), 'utf8');
check('reader 含分组文件夹卡渲染', readerSrc.indexOf('_folderCellHtml') >= 0);
check('reader 含难度评估（阶梯阅读法）', readerSrc.indexOf('levelOf') >= 0 && readerSrc.indexOf('i+1 理想区') >= 0);
check('reader 含分组图标选择', readerSrc.indexOf('GROUP_ICONS') >= 0 && readerSrc.indexOf('openGroupDialog') >= 0);
check('reader 含词频统计', readerSrc.indexOf('computeBookStats') >= 0);
check('reader 含剑桥词典小窗逻辑（走本地转发）',
  readerSrc.indexOf('dictionary.cambridge.org') >= 0 &&
  readerSrc.indexOf('dict: {') >= 0 &&
  readerSrc.indexOf('__proxy?url=') >= 0);
const css = readFileSync(path.join(ROOT, 'css/app.css'), 'utf8');
check('样式含分组文件夹卡与加粗进度条', css.indexOf('.folder-cell') >= 0 && /\.book-prog \{[^}]*height: 8px/.test(css));
check('卡片信息行固定高度（对齐）', /\.book-title \{[^}]*height: 2\.8em/.test(css) && /\.book-author \{[^}]*height: 1\.35em/.test(css));

/* 6b. 本轮改动：统计去重口径 / 词组连线 / 目录按钮不再压住左翻页 / 帮助文案配色 */
const utilSrc = readFileSync(path.join(ROOT, 'js/util.js'), 'utf8');
check('词组识别在 util 里（词形还原后匹配短语动词 + 小品词）',
  utilSrc.indexOf('IR.phraseLen') >= 0 && utilSrc.indexOf('PHRASAL_VERBS') >= 0 && utilSrc.indexOf('PHRASE_PARTICLES') >= 0);
check('统计按【不同单词】去重（100 个 the 只算 1 个）',
  readerSrc.indexOf('_seenKeys') >= 0 && readerSrc.indexOf('按【不同单词】') >= 0);
check('高频词只统计未学 / 生词本 / 在学（已学不进榜）',
  /filter\(e => e\.status !== 'known'\)/.test(readerSrc));
check('词组整组一条不断的线（.ph，组内词不再各自画线）',
  /\.article \.ph \{[\s\S]{0,200}text-decoration: underline dotted/.test(css) &&
  /\.article \.ph \.w-unknown[\s\S]{0,80}text-decoration: none/.test(css));
check('目录按钮移到左下（不再与左翻页按钮重叠）',
  /\.toc-fab \{[\s\S]{0,120}bottom: 22px/.test(css) && !/\.toc-fab \{[\s\S]{0,120}top: 50%/.test(css));
check('翻页页高跟窗口走（dvh + resize 重排分页）',
  css.indexOf('calc(100dvh - 175px)') >= 0 &&
  readerSrc.indexOf('_repaginate') >= 0 && readerSrc.indexOf("addEventListener('resize'") >= 0);
check('申请 Key 帮助文案不再用深蓝（走主题副色 --accent-2）',
  /\.api-help-body a \{[\s\S]{0,200}var\(--accent-2\)/.test(css) &&
  /\.api-help-body code \{[\s\S]{0,160}var\(--accent-2\)/.test(css) &&
  css.indexOf('--bg-sunken') < 0);

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
          volmt3: { apiKey: '', resourceId: 'volc.speech.mt' },
          volmt: { accessKeyId: '', accessKeySecret: '' },
          deepl: { apiKey: '' }, ms: { apiKey: '', region: '' }, libre: { url: '', apiKey: '' },
          proxy: { on: false, url: '' }
        }
      },
      save() {}
    },
    translate: {
      AUTO_ENGINES: ['youdao', 'aliyun', 'alimt', 'volcano', 'volmt3', 'volmt', 'deepl', 'ms', 'libre', 'tencent'],
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
  check('设置页含 volmt3 卡片（API Key + 资源 ID）',
    src.indexOf('data-card="volmt3"') >= 0 && src.indexOf('data-api-in="volmt3.apiKey"') >= 0 && src.indexOf('data-api-in="volmt3.resourceId"') >= 0);
  check('默认引擎下拉含 volmt3 选项', src.indexOf('<option value="volmt3"') >= 0);
  check('设置页含密码显隐控件', src.indexOf('data-pw-eye') >= 0);
  check('设置页含自动模式排序 UI', src.indexOf('data-order-list') >= 0 && src.indexOf('data-order-reset') >= 0);
  const orderHtml = els['[data-order-list]'] ? els['[data-order-list]'].innerHTML : '';
  const names = [...orderHtml.matchAll(/order-name">([^<]+)</g)].map(m => m[1]);
  check('排序列表渲染 10 个引擎且腾讯垫底', names.length === 10 && names[names.length - 1] === '腾讯云 TMT', names.join(','));
  check('排序行含上移/下移按钮', (orderHtml.match(/data-order-up/g) || []).length === 10 && (orderHtml.match(/data-order-down/g) || []).length === 10);
  check('分组标题显示已配置计数', src.indexOf('api-group-count') >= 0);
}

console.log(results.join('\n'));
console.log('FAILS=' + results.filter(r => r.startsWith('FAIL')).length + '/' + results.length);
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
