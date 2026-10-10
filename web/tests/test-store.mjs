/* 磁盘存档端到端测试：跑真实 filestore.js，写入真实文件再读回校验
   前置：先启动本地服务（node 侧用 BASE 指向它） */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE || 'http://127.0.0.1:8645';
const STORE = path.join(__dirname, '..', '..', 'tools', 'store-test');
fs.rmSync(STORE, { recursive: true, force: true });

/* ---- 最小环境桩 ---- */
globalThis.window = globalThis;
globalThis.addEventListener = () => {};   /* Node 无语义：仅避免 init 里的 pagehide 绑定报错 */
globalThis.document = { addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
const mem = {};
globalThis.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};

/* 相对 URL 重定向到本地服务 */
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = String(url);
  return realFetch(u.startsWith('__store') ? BASE + '/' + u : u, init);
};

const read = p => fs.readFileSync(new URL('../js/' + p, import.meta.url), 'utf8');
globalThis.IR = {};
globalThis.IR.toast = () => {};
globalThis.IR.mergeSettings = () => {};
globalThis.IR.settings = {
  data: { storageDir: STORE, api: { engine: 'auto', youdao: { key: 'appid-x', apiKeys: '', secret: 'sec-1' } } },
  save() { localStorage.setItem('ir.settings', JSON.stringify(this.data)); }
};
globalThis.IR.vocab = {
  statusText: { known: '已学', learning: '在学', new: '生词' },
  cache: [
    { word: 'trepidation', display: 'trepidation', meaning: 'n. 惶恐\\n不安\n第三行', status: 'learning', source: 'reader', addedAt: Date.now() - 60000, updatedAt: Date.now() },
    { word: 'he said, "hi"', display: 'he said, "hi"', meaning: '他说“你好”', status: 'known', source: '导入', addedAt: Date.now(), updatedAt: Date.now() }
  ],
  mark: async () => {}, removeWord: async () => {}, bulkMark: async () => {}, bulkRemove: async () => {}, reload: async () => {}
};
const books = new Map();
globalThis.IR.bookStore = {
  async put(b) { books.set(b.id, b); },
  async get(id) { return books.get(id) || null; },
  async getAll() { return Array.from(books.values()); }
};
/* 词库存储桩：用 Map 模拟 IndexedDB 对象仓（bulkPut 是 upsert，不是整体覆盖） */
const storeMap = new Map();
globalThis.IR.vocabStore = {
  async put(e) { storeMap.set(e.word, e); },
  async bulkPut(arr) { for (const e of arr || []) storeMap.set(e.word, e); },
  async getAll() { return Array.from(storeMap.values()); }
};
IR.vocab.cache.forEach(e => storeMap.set(e.word, e));
IR.vocab.reload = async function () { this.cache = Array.from(storeMap.values()); };
globalThis.IR.reader = {};

eval(read('filestore.js'));
const FS = IR.filestore;

const results = [];
const check = (name, cond, extra) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' | ' + String(extra).slice(0, 120) : ''));

/* 0. 初始化：装挂钩（真实用法就是在 app 启动时调用） */
await FS.init();

/* 1. 探针 */
const ok = await FS.probe();
check('探针可用', ok === true, FS.root);

/* 2. 设置存档：settings.json 写入并可读回 */
await FS.saveSettings();
const cfgTxt = await FS.read('settings.json');
let cfg = null;
try { cfg = JSON.parse(cfgTxt); } catch (e) {}
check('settings.json 可读回', !!(cfg && cfg.settings), cfgTxt && cfgTxt.slice(0, 60));
check('settings.json 含 API Key', !!(cfg && cfg.settings.api.youdao.secret === 'sec-1'));
check('磁盘上确实存在文件', fs.existsSync(path.join(STORE, 'settings.json')));

/* 3. 生词表：vocab.csv（表格）与 vocab.json */
await FS.saveVocab();
const csv = fs.readFileSync(path.join(STORE, 'vocab.csv'), 'utf8');
check('CSV 带 BOM（Excel 不乱码）', csv.charCodeAt(0) === 0xFEFF);
check('CSV 表头正确', csv.split('\r\n')[0].replace('\uFEFF', '') === '单词,原形,释义,状态,来源,加入时间,更新时间', csv.split('\r\n')[0]);
check('CSV 状态为中文', csv.includes('"在学"') && csv.includes('"已学"'));
check('CSV 转义双引号', csv.includes('""hi""'), csv.split('\r\n')[2]);
check('CSV 换行被压成；', csv.includes('惶恐；不安；第三行'), csv.split('\r\n')[1]);
const vjson = JSON.parse(fs.readFileSync(path.join(STORE, 'vocab.json'), 'utf8'));
check('vocab.json 无损（2 条）', vjson.length === 2 && vjson[0].word === 'trepidation');

/* 4. 书籍存档 + 列表 */
await FS.saveBook({ id: 'Boundless (R. A. Salvatore)', title: 'Boundless', blocks: [{ t: 'p', text: 'x' }] });
const files = await FS.list('books');
check('books 列表含书籍', files.length === 1 && /Boundless/.test(files[0]), files.join(','));

/* 5. saveAll（含书籍遍历） */
books.set('b2', { id: 'b2', title: 'Book2' });
const all = await FS.saveAll();
check('saveAll 覆盖设置/生词/书籍', all.settings && all.vocab && all.books === books.size, JSON.stringify(all) + ' 库内书籍=' + books.size);

/* 6. 路径穿越被拒 */
const evil = await FS.write('../evil.txt', 'x');
check('路径穿越被拒', evil === false);
check('未生成越权文件', !fs.existsSync(path.join(STORE, '..', 'evil.txt')));

/* 7. 恢复流程：清空本地（localStorage + 内存）后从存档读回 */
delete mem['ir.settings'];
IR.vocab.cache = [];
storeMap.clear();
books.clear();
const restored = await FS.restore();
check('restore 读回词库', restored && restored.vocab === 2 && IR.vocab.cache.length === 2, JSON.stringify(restored));
check('restore 读回书籍', restored && restored.books === 2 && books.size === 2, 'books=' + books.size);
check('restore 应用设置', localStorage.getItem('ir.settings') !== null || restored.settings === true);

/* 7b. 三端共享词库：与磁盘 vocab.json 双向合并
       （浏览器扩展 / 另一台机器改了同一个 vocab.json，本端要能拿到；本端较新的也要写回去） */
{
  const t0 = Date.now();
  IR.vocab.cache = [
    { word: 'trepidation', display: 'trepidation', meaning: 'n. 惶恐', status: 'learning', source: 'reader', addedAt: t0 - 60000, updatedAt: t0 - 1000 },
    { word: 'he said, "hi"', display: 'he said, "hi"', meaning: '他说“你好”', status: 'known', source: '导入', addedAt: t0 - 4000, updatedAt: t0 - 4000 },
    { word: 'quixotic', display: 'quixotic', meaning: '', status: 'new', source: 'reader', addedAt: t0, updatedAt: t0 }
  ];
  storeMap.clear();
  IR.vocab.cache.forEach(e => storeMap.set(e.word, e));

  /* 磁盘侧：扩展刚标的词（更新）· 本机没有的词（新增）· 比本机旧的记录（不该覆盖本机） */
  const disk = [
    { word: 'trepidation', display: 'trepidation', meaning: 'n. 惶恐', status: 'new', source: 'inkread-plugin', addedAt: t0 - 60000, updatedAt: t0 },
    { word: 'obsidian', display: 'obsidian', meaning: '黑曜石', status: 'learning', source: 'inkread-plugin', addedAt: t0, updatedAt: t0 },
    { word: 'he said, "hi"', display: 'he said, "hi"', meaning: '他说“你好”', status: 'known', source: '导入', addedAt: t0 - 9000, updatedAt: t0 - 9000 }
  ];
  await FS.write('vocab.json', JSON.stringify(disk, null, 1));

  const mv = await FS.mergeVocab();
  check('合并：返回成功与统计', !!(mv && mv.ok), JSON.stringify(mv));
  check('合并：磁盘新增词被并入', mv.added === 1, JSON.stringify(mv));
  check('合并：磁盘较新的词覆盖本机', mv.updated === 1, JSON.stringify(mv));
  check('合并：本机较新的词写回磁盘', mv.pushed === 1, JSON.stringify(mv));
  check('合并：合计为两端并集（3 本机词 + 1 磁盘新词）', mv.total === 4, JSON.stringify(mv));

  const byW = new Map(IR.vocab.cache.map(e => [e.word, e]));
  check('合并：扩展标的词在本机生效（learning → new）', byW.get('trepidation').status === 'new', JSON.stringify(byW.get('trepidation')));
  check('合并：磁盘旧数据不会覆盖本机较新的编辑', byW.get('he said, "hi"').updatedAt === t0 - 4000, JSON.stringify(byW.get('he said, "hi"')));
  check('合并：磁盘新增词带释义落到本机', byW.get('obsidian').meaning === '黑曜石');

  const back = JSON.parse(fs.readFileSync(path.join(STORE, 'vocab.json'), 'utf8'));
  const backMap = new Map(back.map(e => [e.word, e]));
  check('合并：写回后磁盘含本机新增词', backMap.has('quixotic'), back.map(e => e.word).join(','));
  check('合并：写回保留磁盘原有释义', backMap.get('obsidian').meaning === '黑曜石');
  check('合并：写回后磁盘上扩展标的词仍是 new', backMap.get('trepidation').status === 'new');

  /* 幂等：再合一次不应该有任何改动 */
  const mv2 = await FS.mergeVocab();
  check('合并：二次合并幂等（无新增/更新/写回）',
    mv2.ok && mv2.added === 0 && mv2.updated === 0 && mv2.pushed === 0, JSON.stringify(mv2));

  /* 磁盘没有 vocab.json 时：明确报原因，不炸 */
  fs.rmSync(path.join(STORE, 'vocab.json'), { force: true });
  const mv3 = await FS.mergeVocab();
  check('合并：磁盘无 vocab.json 时返回 no-file', mv3.ok === false && mv3.reason === 'no-file', JSON.stringify(mv3));
  await FS.write('vocab.json', JSON.stringify(back, null, 1));
}

/* 8. 自动挂钩：settings.save 会触发存档 */
FS._timers = {};
let saved = 0;
const origWrite = FS.writeJson.bind(FS);
FS.writeJson = async (p, o) => { if (p === 'settings.json') saved++; return origWrite(p, o); };
IR.settings.save();
await new Promise(r => setTimeout(r, 1100));
check('挂钩：保存设置自动存档', saved >= 1, 'writes=' + saved);

console.log(results.join('\n'));
console.log('FAILS=' + results.filter(r => r.startsWith('FAIL')).length + '/' + results.length);
fs.rmSync(STORE, { recursive: true, force: true });
process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
