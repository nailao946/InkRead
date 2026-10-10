/* InkRead Video — File System Access 封装（「拿到句柄之后」的读写）
 *
 * 分工：
 *   · 选择目录（showDirectoryPicker）必须由用户在扩展页面上点击触发 → 放在 options.js。
 *   · 句柄持久化在 IndexedDB（idb.js），扩展页面 / 离屏文档 / service worker 同源共享。
 *   · 本模块只做「用句柄读 / 写 / 列 / 查文件」，不含任何 UI，也不弹选择器，
 *     因此可以原样跑在离屏文档（offscreen）里 —— 那也是 Chrome 里唯一稳妥能跑 FSA 的后台上下文。
 *
 * 存档约定（与墨读桌面版 / 网页版 serve.py 完全一致）：
 *   <存档目录>/vocab.json      词表数组 [{word,display,meaning,status,source,addedAt,updatedAt}]
 *   <存档目录>/settings.json   墨读设置（含 storageDir）
 *   <存档目录>/books/          导入的书籍
 *   默认目录：我的文档\InkRead
 */
import { idbGet, idbPut, idbDel, DIR_KEY } from './idb.js';

/** 句柄类型在这个上下文里存不存在（service worker 里可能没有） */
export function fsaPresent() {
  try { return typeof FileSystemDirectoryHandle !== 'undefined'; } catch (e) { return false; }
}

/** 能不能弹目录选择器（只有扩展页面 / 弹窗这种有 DOM 的上下文才行） */
export function canPickDir() {
  try { return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'; } catch (e) { return false; }
}

/** 弹出目录选择器（必须在用户手势里调用）。mode='readwrite' 才能写回词库。 */
export async function pickDir(mode, startIn) {
  const opts = { id: 'inkread-store', mode: mode || 'readwrite' };
  /* startIn 只接受 'desktop' | 'documents' | 'downloads' | … 这类 WellKnownDirectory，
     或一个 FileSystemHandle —— 浏览器不允许按绝对路径跳转，所以「默认对齐墨读目录」
     只能尽量落在其父目录（通常是「文档」）。 */
  try { opts.startIn = startIn || 'documents'; } catch (e) { /* 旧版本不认 */ }
  try {
    return await window.showDirectoryPicker(opts);
  } catch (e) {
    if (e && e.name === 'TypeError') return await window.showDirectoryPicker({ mode: opts.mode });
    throw e;
  }
}

/* ---------- 句柄持久化 ---------- */
export async function getDir() {
  try { return (await idbGet(DIR_KEY)) || null; } catch (e) { return null; }
}
export async function setDir(h) { return idbPut(DIR_KEY, h); }
export async function forgetDir() { try { return await idbDel(DIR_KEY); } catch (e) { return false; } }

/* ---------- 权限 ---------- */
const permMode = mode => ({ mode: mode === 'read' ? 'read' : 'readwrite' });

/** 只查询，不弹窗（离屏文档 / service worker 用这个） */
export async function permQuery(dir, mode) {
  try {
    if (!dir || typeof dir.queryPermission !== 'function') return 'granted';
    return await dir.queryPermission(permMode(mode));
  } catch (e) { return 'denied'; }
}

/** 主动申请（必须在用户手势里调用，扩展页面用） */
export async function permRequest(dir, mode) {
  const st = await permQuery(dir, mode);
  if (st === 'granted') return 'granted';
  try {
    if (!dir || typeof dir.requestPermission !== 'function') return st;
    return await dir.requestPermission(permMode(mode));
  } catch (e) { return 'denied'; }
}

/* ---------- 文件操作 ---------- */
export async function hasFile(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch (e) { return false; }
}

export async function readText(dir, name) {
  const fh = await dir.getFileHandle(name);
  return await (await fh.getFile()).text();
}

export async function writeText(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try { await w.write(text); } finally { await w.close(); }
  return true;
}

export async function listNames(dir) {
  const out = [];
  for await (const e of dir.values()) out.push(e.name);
  return out;
}

/* ---------- 统一操作入口（离屏文档与直接调用共用同一份实现） ---------- */
/**
 * @param {FileSystemDirectoryHandle} dir
 * @param {'status'|'list'|'read'|'write'|'exists'} op
 * @param {{name?:string,text?:string}} p
 * @returns {Promise<{ok:boolean, [k:string]:any}>}
 */
export async function runOp(dir, op, p) {
  p = p || {};
  switch (op) {
    case 'status':
      return { ok: true, bound: true, name: dir.name || '', perm: await permQuery(dir, 'readwrite') };
    case 'list':
      return { ok: true, files: await listNames(dir) };
    case 'exists':
      return { ok: true, exists: await hasFile(dir, p.name) };
    case 'read': {
      const text = await readText(dir, p.name);
      return { ok: true, text };
    }
    case 'write':
      await writeText(dir, p.name, p.text == null ? '' : p.text);
      return { ok: true };
    default:
      return { ok: false, error: 'unknown-op: ' + op };
  }
}
