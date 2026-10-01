/* 书架新功能测试：阅读状态推断 / 分组增删改 / 时长累计 / 进度节流 / 卡片渲染 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/* ---- 最小 DOM 桩（可捕获 innerHTML 与点击回调） ---- */
const makeEl = (tag = 'div') => {
  const el = {
    tagName: tag, _html: '', style: {}, dataset: {}, children: [], listeners: {}, attrs: {},
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      /* 记录 data-* → dataset，便于断言词组包层等结构 */
      if (k.indexOf('data-') === 0) {
        this.dataset[k.slice(5).replace(/-(\w)/g, (m, c) => c.toUpperCase())] = String(v);
      }
    },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    closest() { return null; }, click() {}, remove() {},
    querySelector(sel) { return (store[sel] = store[sel] || makeEl()); },
    querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, toggle() {} }
  };
  return el;
};
const store = {};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = {
  addEventListener() {}, dispatchEvent() {},
  createElement: t => makeEl(t),
  createTextNode: t => ({ nodeType: 3, textContent: String(t), nodeValue: String(t) }),
  querySelector: sel => (store[sel] = store[sel] || makeEl()),
  querySelectorAll: () => []
};
globalThis.prompt = () => null;
globalThis.confirm = () => true;
globalThis.addEventListener = () => {};

new Function('window', readFileSync(path.join(ROOT, 'js/util.js'), 'utf8'))(globalThis);
new Function('window', readFileSync(path.join(ROOT, 'js/reader.js'), 'utf8'))(globalThis);
const IR = globalThis.IR;
const R = IR.reader;

/* 设置 / 存储桩 */
IR.settings = {
  data: { shelf: { groups: [] }, reader: {} },
  save() { this._saved = (this._saved || 0) + 1; }
};
IR.bookStore = {
  _books: new Map(),
  async put(b) { this._books.set(b.id, b); this._puts = (this._puts || 0) + 1; },
  async get(id) { return this._books.get(id) || null; },
  async getAll() { return Array.from(this._books.values()); },
  async remove(id) { this._books.delete(id); }
};
IR.toast = () => {};
IR.modal = { open() { this._opened = true; }, close() {} };
IR.$$ = (sel, root) => [];       /* 详情弹窗内部元素：本测试不驱动 */
IR.vocab = { cache: [], statusMap: new Map(), statusText: { known: '已学', learning: '在学', new: '生词' } };
IR.lemmas = IR.lemmas || (w => [String(w).toLowerCase()]);

const results = [];
const check = (n, c, extra) => results.push((c ? 'PASS' : 'FAIL') + ' ' + n + (extra ? ' | ' + extra : ''));

/* 1. 阅读状态推断 */
check('未读（无进度无记录）', R.readStateOf({ progress: 0 }) === 'unread');
check('在读（有进度）', R.readStateOf({ progress: 0.3 }) === 'reading');
check('在读（仅打开过）', R.readStateOf({ progress: 0, lastOpenedAt: Date.now() }) === 'reading');
check('已读（进度≥99.5%）', R.readStateOf({ progress: 0.996 }) === 'done');
check('手动优先（已读压过低进度）', R.readStateOf({ progress: 0.1, readState: 'done' }) === 'done');
check('手动优先（未读压过高进度）', R.readStateOf({ progress: 0.9, readState: 'unread' }) === 'unread');

/* 2. 分组增删改 */
const g1 = R.newGroup('奇幻小说');
const g2 = R.newGroup('科幻');
check('新建分组', R.groups().length === 2 && g1.id !== g2.id, R.groups().map(g => g.name).join(','));
R.renameGroup(g1.id, '奇幻');
check('重命名分组', R.groupName(g1.id) === '奇幻');
check('分组写入设置', (IR.settings._saved || 0) >= 3, 'saves=' + IR.settings._saved);

/* 3. 指派分组 / 删除分组（组内书回到未分组） */
await IR.bookStore.put({ id: 'b1', title: 'A', progress: 0.42, addedAt: 1 });
await IR.bookStore.put({ id: 'b2', title: 'B', progress: 1, addedAt: 2 });
await R.assignGroup('b1', g1.id);
check('指派分组', (await IR.bookStore.get('b1')).grpId === g1.id);
R.removeGroup(g1.id);
await new Promise(r => setTimeout(r, 30));
check('删除分组后书籍回未分组', (await IR.bookStore.get('b1')).grpId === '' && R.groups().length === 1);

/* 4. 时长格式化 */
check('时长：秒', R.fmtDuration(45) === '45 秒');
check('时长：分钟', R.fmtDuration(600) === '10 分钟');
check('时长：小时', R.fmtDuration(3900) === '1 小时 5 分钟');
check('时长：空', R.fmtDuration(0) === '—');
check('时间：格式化', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(R.fmtTime(Date.now())));

/* 5. 阅读时长累计（_flushRead 把秒数累加到书上并落库） */
R.currentBook = await IR.bookStore.get('b1');
R._readStart = Date.now() - 90 * 1000;          /* 假装已读 90 秒 */
const putsBefore = IR.bookStore._puts || 0;
R._flushRead();
check('累计时长写入 90 秒', R.currentBook.readSeconds === 90, 'readSeconds=' + R.currentBook.readSeconds);
check('落库一次', (IR.bookStore._puts || 0) === putsBefore + 1);
check('记录最后阅读时间', !!R.currentBook.lastOpenedAt);
check('自动置为在读', R.currentBook.readState === 'reading');

/* 6. 进度节流：3 秒内多次调用只落库一次 */
R.currentBook = await IR.bookStore.get('b2');
R.currentBook.progress = 0.5;
const before = IR.bookStore._puts || 0;
R._saveProgressSoon(); R._saveProgressSoon(); R._saveProgressSoon();
check('节流期未立即落库', (IR.bookStore._puts || 0) === before);
await new Promise(r => setTimeout(r, 3400));
check('节流后落库一次', (IR.bookStore._puts || 0) === before + 1, 'puts=' + ((IR.bookStore._puts || 0) - before));

/* 7. 读完自动标记已读 */
R.currentBook.progress = 1;
R._saveProgressSoon();
await new Promise(r => setTimeout(r, 3400));
const b2 = await IR.bookStore.get('b2');
check('进度 100% 自动标为已读', b2.readState === 'done' && !!b2.finishedAt);

/* 8. 全部视图：手机桌面式 —— 分组＝文件夹卡 + 未分组的书平铺在同一宫格 */
R.shelfFilter = 'all';
IR.settings.data.shelf.groups = [{ id: 'gx', name: '待读', icon: '📚', createdAt: 1 }];
await IR.bookStore.put({ id: 'b3', title: 'Boundless', author: 'R. A. Salvatore', fmt: 'MOBI', wordCount: 117743, progress: 0.42, addedAt: Date.now(), grpId: 'gx', stats: { level: 2, levelText: '适中', tier: 'i+1 理想区' } });
store['#shelfList'] = makeEl();
store['#shelfGroups'] = makeEl();
store['#shelfCrumb'] = makeEl();
store['#shelfEmptyActions'] = makeEl();
await R.initShelf();
const grid2 = store['#shelfList'].innerHTML;
const bar1 = store['#shelfGroups'].innerHTML;
check('分组条保留（全部/未分组/自定义/新建）',
  bar1.indexOf('全部') >= 0 && bar1.indexOf('未分组') >= 0 && bar1.indexOf('📚 待读') >= 0 && bar1.indexOf('新建分组') >= 0);
check('全部视图是封面宫格（统一网格）', /class="shelf-grid"/.test(grid2) && /sg-cell/.test(grid2));
check('分组渲染为文件夹卡（占一个书位）', /folder-cell/.test(grid2) && /folder-icons/.test(grid2) && /data-goto="gx"/.test(grid2));
check('文件夹卡有图标徽章与数量', grid2.indexOf('📚') >= 0 && /sg-pct">1 本/.test(grid2) && /data-folder-menu="gx"/.test(grid2));
check('文件夹卡有分组菜单按钮', /data-folder-menu="gx"/.test(grid2));
check('未分组的书平铺在网格中', /data-id="b1"/.test(grid2) && /data-id="b2"/.test(grid2));
check('书卡含状态徽章与进度百分比', /book-state (done|reading|unread)/.test(grid2) && /sg-pct">42%/.test(grid2));
check('全部视图隐藏面包屑', store['#shelfCrumb'].hidden === true);

/* 9. 分组视图：封面宫格 */
R.shelfFilter = 'gx';
store['#shelfList'] = makeEl();
store['#shelfGroups'] = makeEl();
store['#shelfCrumb'] = makeEl();
await R.initShelf();
const grid = store['#shelfList'].innerHTML;
check('分组视图是封面宫格', /class="shelf-grid"/.test(grid) && /sg-cell/.test(grid) && /sg-cover/.test(grid));
check('宫格含状态徽章与百分比', /book-state/.test(grid) && /sg-pct">42%/.test(grid));
check('宫格含详情入口', /sg-more" data-detail/.test(grid));
check('面包屑显示分组名', store['#shelfCrumb'].innerHTML.indexOf('待读') >= 0 && store['#shelfCrumb'].hidden === false);
check('只显示该组书籍', (grid.match(/sg-cell/g) || []).length === 1);
/* 未分组宫格 */
R.shelfFilter = '__none__';
store['#shelfList'] = makeEl();
store['#shelfCrumb'] = makeEl();
await R.initShelf();
check('「未分组」也是宫格视图', /shelf-grid/.test(store['#shelfList'].innerHTML) && store['#shelfCrumb'].innerHTML.indexOf('未分组') >= 0);

/* 9b. 找书搜索源 */
check('找书内置公版/信息站点', R.FIND_SOURCES.length >= 4 &&
  R.FIND_SOURCES.some(x => x.id === 'gutenberg') && R.FIND_SOURCES.some(x => x.id === 'custom') &&
  R.FIND_SOURCES.every(x => x.id === 'custom' || x.url.indexOf('{q}') >= 0));

/* 10. 词频统计与阶梯难度 */
IR.vocab.statusMap = new Map([['the', 'known'], ['cat', 'learning']]);
const fake = { id: 'bx', text: 'the cat sat on the mat the cat' };
const s1 = await R.computeBookStats(fake);
check('统计词次 8 / 不同词 5', s1.tokens === 8 && s1.unique === 5, JSON.stringify({ t: s1.tokens, u: s1.unique }));
check('生词 3 / 在学 1 / 已学 1（按不同单词去重：the 出现 3 次只算 1 个）', s1.unknown === 3 && s1.learning === 1 && s1.known === 1);
check('可理解度 = 5/8', Math.abs(s1.coverage - 0.625) < 0.001, 'coverage=' + s1.coverage);
check('低可理解度判为困难（挫败区）', s1.level === 4 && s1.levelText === '困难' && s1.tier === '挫败区');
check('高频词只含未学 + 生词本 + 在学，已学不进榜（4 个，最高频是在学的 cat ×2）',
  s1.topUnknown.length === 4 && s1.topUnknown[0].w === 'cat' && s1.topUnknown[0].c === 2 && s1.topUnknown[0].s === 'learning',
  JSON.stringify(s1.topUnknown));
check('高频词统计的是出现次数（不是去重后的 1）', s1.topUnknown.every(t => t.c >= 1) && s1.topUnknown.reduce((s, t) => s + t.c, 0) === 5);
check('统计口径版本号已升级（老数据会重算）', s1.v === 2);
check('阶梯档位阈值正确',
  R.levelOf(0.99).level === 1 && R.levelOf(0.96).level === 2 && R.levelOf(0.92).level === 3 && R.levelOf(0.5).level === 4);
/* 全部词语都已知 → 轻松 */
IR.vocab.statusMap = new Map([['the', 'known'], ['cat', 'known'], ['sat', 'known'], ['on', 'known'], ['mat', 'known']]);
const s2 = await R.computeBookStats(fake);
check('全已知 → 轻松 + 可理解度 100%', s2.level === 1 && s2.coverage === 1 && s2.topUnknown.length === 0);
/* 缓存写回 */
await IR.bookStore.put(fake);
await R.refreshBookStats(fake);
check('统计结果缓存到书籍记录', !!(await IR.bookStore.get('bx')).stats.level);

/* 10b. 词组识别（多个词一条不断的线） */
const itemsOf = s => IR.tokenize(s).map(x => ({ t: IR.WORD_RE.test(x) ? 'w' : 'x', s: x }));
check('词组识别：tearing down 连成一个词组',
  IR.phraseLen(itemsOf('tearing down the wall'), 0) === 2);
check('词组识别：三词 come up with',
  IR.phraseLen(itemsOf('we come up with a plan'), 2) === 3);
check('词组识别：词形还原（tearing → tear）',
  IR.phraseLen(itemsOf('he is tearing off the cover'), 4) === 2, IR.lemmas('tearing').join('/'));
check('词组不跨标点', IR.phraseLen(itemsOf('tearing. down'), 0) === 0);
check('非短语动词不成组', IR.phraseLen(itemsOf('garden river stone path'), 0) === 0);
check('普通介词搭配不成组（不在小品词表里）', IR.phraseLen(itemsOf('the summit lay within reach'), 2) === 0);

/* 10c. 阅读视图：统计按【不同单词】去重，词组整组一条线 */
R.counts = { total: 0, unknown: 0, learning: 0, known: 0 };
R._seenKeys = new Map();
IR.vocab.statusMap = new Map([['the', 'known']]);
const host1 = makeEl('p');
R._renderTokens(host1, 'the the the cat cat the');
check('阅读统计去重：词次 6 / 已学 1（the 三次算一个）/ 生词 1（cat 两次算一个）',
  R.counts.total === 6 && R.counts.known === 1 && R.counts.unknown === 1, JSON.stringify(R.counts));

R.counts = { total: 0, unknown: 0, learning: 0, known: 0 };
R._seenKeys = new Map();
IR.vocab.statusMap = new Map();
const host2 = makeEl('p');
R._renderTokens(host2, 'tearing down the wall');
const ph = host2.children.find(c => c.className && String(c.className).indexOf('ph') >= 0);
check('含生词时词组包一层 .ph（组内 3 个子节点，含中间空格）',
  !!ph && ph.children.length === 3 && ph.dataset.ph === 'tearing down',
  ph ? ph.dataset.ph + ' / ' + ph.children.length : '没有 .ph');
check('组内单词自身不再各自画线（.ph 内仍保留 .w 可点）',
  !!ph && ph.children.filter(c => c.className && /(^|\s)w(\s|$)/.test(c.className)).length === 2);

IR.vocab.statusMap = new Map([['tear', 'known'], ['down', 'known'], ['wall', 'known'], ['the', 'known']]);
R.counts = { total: 0, unknown: 0, learning: 0, known: 0 };
R._seenKeys = new Map();
const host3 = makeEl('p');
R._renderTokens(host3, 'tearing down the wall');
check('词组里的词都已知 → 不包 .ph（不给已掌握的词白画线）',
  !host3.children.some(c => c.className && String(c.className).indexOf('ph') >= 0));

IR.vocab.statusMap = new Map([['the', 'known'], ['cat', 'learning']]);   /* 还原，供后续用例 */

/* 11. 分组图标 */
IR.settings.data.shelf.groups = [];
const gi = R.newGroup('带图标', '🚀');
check('新建分组可带图标', gi.icon === '🚀' && R.groupIcon(gi.id) === '🚀');
R.updateGroup(gi.id, '改名了', '');
check('可改名称与清空图标', R.groupName(gi.id) === '改名了' && R.groupIcon(gi.id) === '');
check('可选图标列表含"无图标"项', R.GROUP_ICONS[0] === '' && R.GROUP_ICONS.length > 5);

/* 12. 点词即入生词本 + 释义回存词表（不再消耗翻译接口） */
{
  globalThis.innerWidth = 1200; globalThis.innerHeight = 800;
  /* 加载真实 vocab.js（覆盖前面的桩） */
  new Function('window', readFileSync(path.join(ROOT, 'js/vocab.js'), 'utf8'))(globalThis);
  IR.vocabStore = {
    _m: new Map(),
    async get(w) { return this._m.get(w) || null; },
    async put(e) { this._m.set(e.word, e); this._puts = (this._puts || 0) + 1; },
    async remove(w) { this._m.delete(w); },
    async getAll() { return Array.from(this._m.values()); }
  };
  await IR.vocab.reload();
  IR.dict = { lookup: async () => ({ phonetic: 'rʌn', pos: 'v.', meaning: '跑；运转' }) };
  let transCalls = 0;
  IR.translate = { run: async () => { transCalls++; return { engine: '测试引擎', text: '跑（译文）' }; } };
  IR.tts = { voices: [], speak() {} };
  IR.settings.data.tts = { autoSpeak: false, voiceURI: '', rate: 1 };
  IR.settings.data.reader = {};
  IR.vocab.statusMap = new Map(IR.vocab.cache.map(e => [e.word, e.status]));

  const popup = makeEl();
  popup.hidden = true;
  popup.style = {};
  popup.dataset = {};
  const span = makeEl();
  span.dataset = { w: 'running', k: 'run' };
  span.getBoundingClientRect = () => ({ left: 10, top: 10, right: 20, bottom: 20, width: 10 });

  /* 首次点词：自动入生词本 */
  R._openPopup(span, popup);
  await new Promise(r => setTimeout(r, 60));
  let e1 = IR.vocab.cache.find(e => e.word === 'run');
  check('点词即入生词本（status=new）', !!e1 && e1.status === 'new', JSON.stringify(e1 && { s: e1.status }));
  check('词典释义回存词表', e1 && e1.meaning.indexOf('跑') >= 0, e1 && e1.meaning);
  check('首次点词消耗一次翻译', transCalls === 1, 'transCalls=' + transCalls);
  const puts1 = IR.vocabStore._puts;

  /* 再次点词：词表已有中文，不再调翻译接口、不再重复入库 */
  popup.hidden = true;
  popup.dataset = {};
  R._openPopup(span, popup);
  await new Promise(r => setTimeout(r, 60));
  check('再点同一词不再消耗翻译', transCalls === 1, 'transCalls=' + transCalls);
  check('再点同一词不再重复入库', IR.vocabStore._puts === puts1, 'puts=' + (IR.vocabStore._puts - puts1));
  const r2 = await R._translateWord('running');
  check('_translateWord 命中词表', r2.engine === '词表' && r2.text.indexOf('跑') >= 0, JSON.stringify(r2));

  /* 标记为在学：释义保留 */
  await IR.vocab.mark('run', 'running', 'learning');
  const e2 = IR.vocab.cache.find(e => e.word === 'run');
  check('改标在学后释义保留', e2.status === 'learning' && e2.meaning.indexOf('跑') >= 0, JSON.stringify(e2));

  /* fillMeaning 不覆盖已有释义 */
  await IR.vocab.fillMeaning('run', '别的翻译');
  const e3 = IR.vocab.cache.find(e => e.word === 'run');
  check('fillMeaning 不覆盖已有释义', e3.meaning.indexOf('跑') >= 0, e3.meaning);

  /* 生词本（new）在阅读里按生词样式着色 */
  IR.vocab.statusMap.set('run', 'new');
  check('生词本词条按生词样式（w-unknown）', R._wordStatus('running').status === 'unknown' && R._wordStatus('running').key === 'run');
  IR.vocab.statusMap.set('run', 'learning');
  check('在学词条样式 w-learning', R._wordStatus('running').status === 'learning');
}

console.log(results.join('\n'));
console.log('FAILS=' + results.filter(r => r.startsWith('FAIL')).length + '/' + results.length);
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
