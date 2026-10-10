/* InkRead Video — IndexedDB 小工具
 *
 * 为什么单独抽出来：扩展页面（设置页 / 弹窗）和离屏文档（offscreen）同属扩展源，
 * 共用同一份 IndexedDB。目录句柄（FileSystemDirectoryHandle）是可结构化克隆的，
 * 存进来之后重启浏览器仍然指向同一个目录——这是「免启动桌面版直读存档目录」的基础。
 *
 * 兼容既有数据：库名 inkread-video、对象仓 h（与早期 options.js 内联实现一致，不能改）。
 */
const DB_NAME = 'inkread-video';
const DB_VER = 1;
const STORE = 'h';

/** 已绑定存档目录句柄的键名 */
export const DIR_KEY = 'dir';

let _db = null;

export function idbOpen() {
  if (_db) return Promise.resolve(_db);
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('当前环境没有 indexedDB'));
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => { _db = req.result; res(_db); };
    req.onerror = () => rej(req.error || new Error('打开 IndexedDB 失败'));
  });
}

export async function idbGet(k) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const q = tx.objectStore(STORE).get(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

export async function idbPut(k, v) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(v, k);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

export async function idbDel(k) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(k);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}
