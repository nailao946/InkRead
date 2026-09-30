/* 书架新功能测试：阅读状态推断 / 分组增删改 / 时长累计 / 进度节流 / 卡片渲染 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

/* ---- 最小 DOM 桩（可捕获 innerHTML 与点击回调） ---- */
const makeEl = (tag = 'div') => {
  const el = {
    tagName: tag, _html: '', style: {}, dataset: {}, children: [], listeners: {},
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    setAttribute() {}, appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    closest() { return null; }, click() {}, remove() {},
    classList: { add() {}, remove() {}, toggle() {} }
  };
  return el;
};
const store = {};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = {
  addEventListener() {},
  createElement: t => makeEl(t),
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

/* 8. 全部视图：分组框（微信读书式）+ 对齐卡片 */
R.shelfFilter = 'all';
IR.settings.data.shelf.groups = [{ id: 'gx', name: '待读', icon: '📚', createdAt: 1 }];
await IR.bookStore.put({ id: 'b3', title: 'Boundless', author: 'R. A. Salvatore', fmt: 'MOBI', wordCount: 117743, progress: 0.42, addedAt: Date.now(), grpId: 'gx', stats: { level: 2, levelText: '适中', tier: 'i+1 理想区' } });
store['#shelfList'] = makeEl();
store['#shelfGroups'] = makeEl();
store['#shelfEmptyActions'] = makeEl();
await R.initShelf();
const frames = store['#shelfList'].innerHTML;
const bar1 = store['#shelfGroups'].innerHTML;
check('全部视图渲染分组框', /group-frame/.test(frames) && /frame-row/.test(frames));
check('分组框标题带图标与数量', frames.indexOf('📚 待读') >= 0 && /frame-count">1 本/.test(frames));
check('未分组框存在', frames.indexOf('未分组') >= 0);
check('框内卡片为紧凑型', /book-card compact/.test(frames));
check('卡片含状态徽章', /book-state (done|reading|unread)/.test(frames));
check('卡片含进度百分比', frames.indexOf('已读 <b>42%</b>') >= 0);
check('卡片含难度徽标', /diff-badge d2/.test(frames) && frames.indexOf('适中') >= 0);
check('卡片含详情入口', /data-detail/.test(frames));
check('全部视图工具条含新建分组', bar1.indexOf('新建分组') >= 0);

/* 9. 分组视图：网格 + 返回 */
R.shelfFilter = 'gx';
store['#shelfList'] = makeEl();
store['#shelfGroups'] = makeEl();
await R.initShelf();
const grid = store['#shelfList'].innerHTML;
const bar2 = store['#shelfGroups'].innerHTML;
check('分组视图用网格卡片', /book-card full/.test(grid));
check('分组视图有返回全部', bar2.indexOf('‹ 全部') >= 0 && bar2.indexOf('待读') >= 0);
check('只显示该组书籍', (grid.match(/book-card/g) || []).length === 1);

/* 10. 词频统计与阶梯难度 */
IR.vocab.statusMap = new Map([['the', 'known'], ['cat', 'learning']]);
const fake = { id: 'bx', text: 'the cat sat on the mat the cat' };
const s1 = await R.computeBookStats(fake);
check('统计词次 8 / 不同词 5', s1.tokens === 8 && s1.unique === 5, JSON.stringify({ t: s1.tokens, u: s1.unique }));
check('生词 3 / 在学 1 / 已学 1（按词形）', s1.unknown === 3 && s1.learning === 1 && s1.known === 1);
check('可理解度 = 5/8', Math.abs(s1.coverage - 0.625) < 0.001, 'coverage=' + s1.coverage);
check('低可理解度判为困难（挫败区）', s1.level === 4 && s1.levelText === '困难' && s1.tier === '挫败区');
check('高频生词列表给出 3 个', s1.topUnknown.length === 3 && s1.topUnknown[0].c === 1);
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

/* 11. 分组图标 */
IR.settings.data.shelf.groups = [];
const gi = R.newGroup('带图标', '🚀');
check('新建分组可带图标', gi.icon === '🚀' && R.groupIcon(gi.id) === '🚀');
R.updateGroup(gi.id, '改名了', '');
check('可改名称与清空图标', R.groupName(gi.id) === '改名了' && R.groupIcon(gi.id) === '');
check('可选图标列表含"无图标"项', R.GROUP_ICONS[0] === '' && R.GROUP_ICONS.length > 5);

console.log(results.join('\n'));
console.log('FAILS=' + results.filter(r => r.startsWith('FAIL')).length + '/' + results.length);
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
