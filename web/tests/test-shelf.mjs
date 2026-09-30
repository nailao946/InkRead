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

/* 8. 卡片渲染（真实走 initShelf，捕获生成的 HTML） */
R.shelfFilter = 'all';
IR.settings.data.shelf.groups = [{ id: 'gx', name: '待读', createdAt: 1 }];
await IR.bookStore.put({ id: 'b3', title: 'Boundless', author: 'R. A. Salvatore', fmt: 'MOBI', wordCount: 117743, progress: 0.42, addedAt: Date.now(), grpId: 'gx' });
store['#shelfList'] = makeEl();
store['#shelfGroups'] = makeEl();
store['#shelfEmptyActions'] = makeEl();
await R.initShelf();
const listHtml = store['#shelfList'].children.map(c => c.innerHTML).join('');
const barHtml = store['#shelfGroups'].innerHTML;
check('卡片含状态徽章', /book-state (done|reading|unread)/.test(listHtml));
check('卡片含进度百分比', listHtml.indexOf('已读 <b>42%</b>') >= 0);
check('卡片含详情入口', listHtml.indexOf('book-detail-hint') >= 0 && listHtml.indexOf('book-more') >= 0);
check('卡片显示分组名', listHtml.indexOf('待读') >= 0);
check('分组条含全部/未分组/自定义', barHtml.indexOf('全部') >= 0 && barHtml.indexOf('未分组') >= 0 && barHtml.indexOf('待读') >= 0 && barHtml.indexOf('新建分组') >= 0);

/* 9. 分组筛选生效 */
R.shelfFilter = '__none__';
store['#shelfList'] = makeEl();
await R.initShelf();
check('筛选「未分组」时隐藏已分组书籍', store['#shelfList'].children.length === 2, 'cards=' + store['#shelfList'].children.length);
R.shelfFilter = 'gx';
store['#shelfList'] = makeEl();
await R.initShelf();
check('筛选某分组只显示该组', store['#shelfList'].children.length === 1);

console.log(results.join('\n'));
console.log('FAILS=' + results.filter(r => r.startsWith('FAIL')).length + '/' + results.length);
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
