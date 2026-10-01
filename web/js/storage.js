/* 墨读 InkRead — 本地存储
   词库 / 书架 → IndexedDB；偏好设置 → localStorage
   所有数据只存本机，不上传任何服务器 */
window.IR = window.IR || {};

IR.db = null;

/* M3：新增 'dict' objectStore 用于缓存离线词典分片（keyPath: letter） */
IR.openDB = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('inkread', 2);
  req.onupgradeneeded = e => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('vocab')) {
      const s = db.createObjectStore('vocab', { keyPath: 'word' });
      s.createIndex('status', 'status');
    }
    if (!db.objectStoreNames.contains('books')) {
      db.createObjectStore('books', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('dict')) {
      db.createObjectStore('dict', { keyPath: 'letter' });
    }
  };
  req.onsuccess = () => { IR.db = req.result; resolve(); };
  req.onerror = () => reject(req.error);
});

IR.req = r => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
IR.store = (name, mode) => IR.db.transaction(name, mode).objectStore(name);

/* ---------- 词库 ---------- */
IR.vocabStore = {
  async getAll() { return IR.req(IR.store('vocab').getAll()); },
  async get(word) { return IR.req(IR.store('vocab').get(word)); },
  async put(entry) { return IR.req(IR.store('vocab', 'readwrite').put(entry)); },
  async bulkPut(entries) {
    return new Promise((resolve, reject) => {
      const tx = IR.db.transaction('vocab', 'readwrite');
      const st = tx.objectStore('vocab');
      for (const e of entries) st.put(e);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
  async remove(word) { return IR.req(IR.store('vocab', 'readwrite').delete(word)); },
  async clear() { return IR.req(IR.store('vocab', 'readwrite').clear()); }
};

/* ---------- 书架 ---------- */
IR.bookStore = {
  async getAll() { return IR.req(IR.store('books').getAll()); },
  async get(id) { return IR.req(IR.store('books').get(id)); },
  async put(book) { return IR.req(IR.store('books', 'readwrite').put(book)); },
  async remove(id) { return IR.req(IR.store('books', 'readwrite').delete(id)); }
};

/* ---------- 偏好设置（localStorage） ---------- */
IR.settings = {
  data: { theme: '0', colors: null, tts: { voiceURI: '', rate: 0.9, autoSpeak: true }, api: {
    youdao: { key: '', apiKeys: '', secret: '' },
    tencent: { secretId: '', secretKey: '', region: 'ap-guangzhou' },
    aliyun: { apiKey: '', model: '' },
    alimt: { accessKeyId: '', accessKeySecret: '', edition: 'general', scene: 'social' },
    volcano: { apiKey: '', model: '' },
    volmt3: { apiKey: '', resourceId: 'volc.speech.mt' },
    volmt: { accessKeyId: '', accessKeySecret: '' },
    deepl: { apiKey: '' },
    ms: { apiKey: '', region: '' },
    libre: { url: '', apiKey: '' },
    proxy: { on: false, url: '' }, engine: 'auto'
  }, reader: { fontSize: 18, lineHeight: 2.0, fontFamily: 'serif', autoTranslate: true }, storageDir: '', shelf: { groups: [] }, finder: { custom: '', last: 'gutenberg' }, tocPinned: false },
  load() {
    try {
      const raw = localStorage.getItem('ir.settings');
      if (raw) {
        const saved = JSON.parse(raw);
        const merged = {
          ...this.data, ...saved,
          tts: { ...this.data.tts, ...(saved.tts || {}) },
          reader: { ...this.data.reader, ...(saved.reader || {}) }
        };
        /* api 逐家深合并：老配置缺的字段（如新增区域项）用默认值补齐 */
        const api = { ...this.data.api };
        const savedApi = saved.api || {};
        for (const k in savedApi) {
          const cur = api[k], val = savedApi[k];
          api[k] = (cur && typeof cur === 'object' && !Array.isArray(cur) && val && typeof val === 'object')
            ? { ...cur, ...val } : val;
        }
        merged.api = api;
        this.data = merged;
      }
    } catch (e) { /* 忽略损坏的设置 */ }
    return this.data;
  },
  save() { localStorage.setItem('ir.settings', JSON.stringify(this.data)); }
};
