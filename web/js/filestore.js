/* 墨读 InkRead — 磁盘存档（走本地服务的 /__store 端点）
   目的：把生词/已学状态、导入的书籍、设置与接口配置真正存到磁盘文件，
   重开程序自动还原；换端只需替换 settings.json。
   可用场景：桌面版（内置服务）、网页版（start-server.bat / tools/serve.py）。
   纯 file:// 或无本地转发时自动跳过（仍走浏览器 IndexedDB/localStorage）。 */
window.IR = window.IR || {};

IR.filestore = {
  ready: null,        /* null 未探测 / true 可用 / false 不可用 */
  root: '',           /* 服务端实际使用的存档目录 */
  _restoring: false,  /* 恢复过程中不回写 */
  _timers: {},
  _lastMsg: '',

  /* ---------- 基础请求 ---------- */
  dir() {
    const d = (IR.settings.data.storageDir || '').trim();
    return d;
  },
  _q(path, extra) {
    const root = this.dir();
    return '__store/' + path + '?' + (root ? 'root=' + encodeURIComponent(root) + '&' : '') + (extra || '');
  },
  async probe() {
    if (this.ready !== null) return this.ready;
    try {
      const r = await fetch('__store/ping', { cache: 'no-store' });
      const j = await r.json();
      this.ready = !!(j && j.store);
      this.root = (j && j.root) || '';
    } catch (e) { this.ready = false; }
    return this.ready;
  },
  async read(path) {
    if (!await this.probe()) return null;
    try {
      const r = await fetch(this._q('read', 'path=' + encodeURIComponent(path)), { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.text();
    } catch (e) { return null; }
  },
  async write(path, text) {
    if (!await this.probe()) return false;
    try {
      const r = await fetch(this._q('write', 'path=' + encodeURIComponent(path)), { method: 'POST', body: text });
      const j = await r.json();
      if (j && j.ok) { this.lastSaved = Date.now(); return true; }
      return false;
    } catch (e) { return false; }
  },
  async writeJson(path, obj) { return this.write(path, JSON.stringify(obj, null, 1)); },
  async list(dir) {
    if (!await this.probe()) return [];
    try {
      const r = await fetch(this._q('list', 'path=' + encodeURIComponent(dir)), { cache: 'no-store' });
      const j = await r.json();
      return (j && j.files) || [];
    } catch (e) { return []; }
  },
  async openFolder() {
    if (!await this.probe()) { IR.toast('存档不可用：请用桌面版或 start-server 启动', 'err'); return; }
    try { await fetch(this._q('open'), { method: 'POST' }); } catch (e) { /* 忽略 */ }
  },

  /* ---------- 序列化 ---------- */
  _ts(ms) {
    if (!ms) return '';
    const d = new Date(ms), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  /* 表格文件：UTF-8 BOM + CRLF，Excel/WPS 双击不乱码 */
  csvVocab(entries) {
    const cell = v => '"' + String(v == null ? '' : v)
      .replace(/"/g, '""')
      .replace(/\\r\\n|\\n|\\r/g, '；')
      .replace(/\r\n|\r|\n/g, '；') + '"';
    const head = ['单词', '原形', '释义', '状态', '来源', '加入时间', '更新时间'];
    const rows = entries.map(e => [
      e.display || e.word, e.word, e.meaning || '',
      (IR.vocab.statusText[e.status] || e.status || ''), e.source || '',
      this._ts(e.addedAt), this._ts(e.updatedAt)
    ].map(cell).join(','));
    return '\uFEFF' + head.join(',') + '\r\n' + rows.join('\r\n') + '\r\n';
  },
  configFile() {
    return {
      app: 'inkread', version: 2, kind: 'config', savedAt: new Date().toISOString(),
      settings: IR.settings.data
    };
  },

  /* ---------- 存档动作 ---------- */
  async saveSettings() {
    if (this._restoring) return false;
    return this.writeJson('settings.json', this.configFile());
  },
  async saveVocab() {
    if (this._restoring) return false;
    const entries = IR.vocab.cache || [];
    const okCsv = await this.write('vocab.csv', this.csvVocab(entries));
    const okJson = await this.writeJson('vocab.json', entries);
    return okCsv || okJson;
  },
  async saveBook(book) {
    if (this._restoring || !book || !book.id) return false;
    return this.writeJson('books/' + String(book.id).replace(/[\\/:*?"<>|]/g, '_') + '.json', book);
  },

  /* 导入/解析失败时把详情写到存档目录 logs/，便于事后定位（控制台也打一份） */
  async logImportError(info) {
    try {
      const stamp = this._ts(Date.now()).replace(/[: ]/g, '-');
      const text = [
        '时间: ' + new Date().toString(),
        '文件: ' + (info.file || ''),
        '大小: ' + (info.size || 0) + ' 字节',
        '扩展名: ' + (info.ext || ''),
        '错误: ' + (info.error || ''),
        '环境: ' + (navigator.userAgent || ''),
        '堆栈:\n' + (info.stack || '(无)')
      ].join('\n') + '\n';
      await this.write('logs/import-error-' + stamp + '.txt', text);
      return true;
    } catch (e) { return false; }
  },
  async saveAll() {
    const a = await this.saveSettings();
    const b = await this.saveVocab();
    const books = await IR.bookStore.getAll().catch(() => []);
    let n = 0;
    for (const bk of books) { if (await this.saveBook(bk)) n++; }
    return { settings: a, vocab: b, books: n };
  },

  /* 防抖存档（高频操作不卡界面） */
  soon(kind, fn, ms) {
    clearTimeout(this._timers[kind]);
    this._timers[kind] = setTimeout(() => { this[kind === 'cfg' ? 'saveSettings' : 'saveVocab'](); }, ms || 700);
  },

  /* ---------- 启动恢复：本地为空则从磁盘读回 ---------- */
  async restore() {
    if (!await this.probe()) return null;
    this._restoring = true;
    const out = { settings: false, vocab: 0, books: 0 };
    try {
      if (!localStorage.getItem('ir.settings')) {
        const txt = await this.read('settings.json');
        if (txt) {
          const data = JSON.parse(txt);
          if (data && data.settings) { IR.mergeSettings(data.settings); out.settings = true; }
        }
      }
    } catch (e) { /* 忽略损坏存档 */ }

    try {
      if (!(IR.vocab.cache || []).length) {
        const txt = await this.read('vocab.json');
        if (txt) {
          const arr = JSON.parse(txt);
          if (Array.isArray(arr) && arr.length) {
            await IR.vocabStore.bulkPut(arr);
            await IR.vocab.reload();
            out.vocab = arr.length;
          }
        }
      }
    } catch (e) { /* 忽略 */ }

    try {
      const files = await this.list('books');
      for (const f of files) {
        if (!/\.json$/i.test(f)) continue;
        const id = f.replace(/\.json$/i, '');
        const existed = await IR.bookStore.get(id).catch(() => null);
        if (existed) continue;
        const txt = await this.read('books/' + f);
        if (!txt) continue;
        try {
          const book = JSON.parse(txt);
          if (book && book.id) { await IR.bookStore.put(book); out.books++; }
        } catch (e) { /* 跳过损坏文件 */ }
      }
      if (out.books && IR.reader && IR.reader.initShelf) IR.reader.initShelf();
    } catch (e) { /* 忽略 */ }

    this._restoring = false;
    return out;
  },

  /* ---------- 初始化：探针 + 挂钩自动存档 ---------- */
  async init() {
    const ok = await this.probe();

    /* 设置保存 → settings.json */
    const origSave = IR.settings.save.bind(IR.settings);
    IR.settings.save = function () {
      origSave();
      IR.filestore.soon('cfg');
    };

    /* 生词/已学等状态变化 → vocab.csv + vocab.json */
    ['mark', 'removeWord', 'bulkMark', 'bulkRemove'].forEach(fn => {
      if (typeof IR.vocab[fn] !== 'function') return;
      const orig = IR.vocab[fn].bind(IR.vocab);
      IR.vocab[fn] = async function (...args) {
        const r = await orig(...args);
        IR.filestore.soon('vocab');
        return r;
      };
    });

    /* 书籍写入（导入 / 阅读进度）→ books/*.json */
    const origBookPut = IR.bookStore.put.bind(IR.bookStore);
    IR.bookStore.put = async function (book) {
      const r = await origBookPut(book);
      IR.filestore.saveBook(book);
      return r;
    };

    /* 关闭页面前把未落盘的写入补上（best-effort） */
    window.addEventListener('pagehide', () => {
      try { IR.filestore.saveSettings(); } catch (e) { /* 忽略 */ }
    });

    return ok;
  }
};
