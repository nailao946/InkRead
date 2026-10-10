/* InkRead Video — 存档目录读写客户端（带离屏文档兜底）
 *
 * 问题：MV3 的 service worker 没有 DOM，File System Access 在它里面不保证可用；
 *       而「标记一个词就写回 vocab.json」这件事必须由后台完成。
 * 方案：三级降级
 *   ① 直接在当前上下文用句柄读写（扩展页面 / 支持 FSA 的 SW 都能走这条）
 *   ② 不行就交给「离屏文档」（offscreen document，本质是个隐藏的扩展页面，一定支持 FSA）
 *   ③ 都不行（Firefox 没有 offscreen，也没有 showDirectoryPicker）→ 返回 unsupported，
 *      上层自动回落到本地服务 / 导入文件
 *
 * 消息约定：SW ↔ 离屏文档走 runtime.sendMessage，type = 'ir:fs'。
 */
import { api, IS_FIREFOX } from './api.js';
import * as fsh from './fsh.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';
const DEFAULT_TIMEOUT = 8000;

let _creating = null;
let _offFailAt = 0;                      /* 离屏文档创建失败后的冷却（60s），避免每次标记都白试一遍 */
const OFF_FAIL_COOLDOWN = 60 * 1000;

export function offscreenSupported() {
  return !!(api && api.offscreen && typeof api.offscreen.createDocument === 'function');
}

/** 这个环境有没有可能直连存档目录（Chromium 系） */
export function dirSupported() {
  return !IS_FIREFOX && (fsh.fsaPresent() || offscreenSupported());
}

/* ---------- 离屏文档生命周期 ---------- */
async function hasOffscreen() {
  try {
    if (api.runtime && typeof api.runtime.getContexts === 'function') {
      const list = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return !!(list && list.length);
    }
  } catch (e) { /* 旧版本 / Firefox：没有 getContexts */ }
  return false;
}

async function ensureOffscreen() {
  if (!offscreenSupported()) return false;
  if (await hasOffscreen()) return true;
  if (_offFailAt && Date.now() - _offFailAt < OFF_FAIL_COOLDOWN) return false;
  if (_creating) { try { await _creating; return await hasOffscreen(); } catch (e) { return false; } }
  _creating = (async () => {
    try {
      await api.offscreen.createDocument({
        url: api.runtime.getURL(OFFSCREEN_PATH),
        reasons: ['BLOBS'],
        justification: '读写墨读存档目录里的 vocab.json（File System Access 只能在文档上下文里使用）'
      });
    } catch (e) {
      /* 「Only a single offscreen document may be created」＝已经有了，视作成功 */
      const msg = String((e && e.message) || e);
      if (!/single offscreen/i.test(msg)) throw e;
    }
  })();
  try { await _creating; return true; } catch (e) { _offFailAt = Date.now(); return false; } finally { _creating = null; }
}

async function viaOffscreen(op, payload, timeoutMs) {
  if (!await ensureOffscreen()) return { ok: false, error: 'no-offscreen' };
  try {
    const res = await Promise.race([
      api.runtime.sendMessage({ type: 'ir:fs', op, payload: payload || {} }),
      new Promise(r => setTimeout(() => r({ ok: false, error: 'timeout' }), timeoutMs || DEFAULT_TIMEOUT))
    ]);
    return res && typeof res === 'object' ? res : { ok: false, error: 'no-reply' };
  } catch (e) {
    return { ok: false, error: 'offscreen-msg: ' + String((e && e.message) || e) };
  }
}

/* ---------- 直连（当前上下文） ---------- */
async function viaDirect(op, payload) {
  let dir = null;
  try { dir = await fsh.getDir(); } catch (e) { return { ok: false, error: 'idb: ' + String((e && e.message) || e) }; }
  if (!dir) return { ok: false, error: 'no-dir' };
  try {
    return await fsh.runOp(dir, op, payload);
  } catch (e) {
    return { ok: false, error: 'direct: ' + String((e && e.name ? e.name + ': ' : '') + ((e && e.message) || e)) };
  }
}

/**
 * 对绑定的存档目录执行一次操作。
 * @returns {Promise<{ok:boolean, error?:string, [k:string]:any}>}
 */
export async function fsCall(op, payload, opts) {
  const direct = await viaDirect(op, payload);
  if (direct.ok) return direct;

  /* 没有句柄＝根本没绑定，离屏文档同样没有，不必绕一圈 */
  if (direct.error === 'no-dir') return direct;

  const via = await viaOffscreen(op, payload, opts && opts.timeoutMs);
  if (via.ok) return via;
  return { ok: false, error: via.error || direct.error || 'fs-unavailable', direct: direct.error };
}

/** 探针：确认离屏文档能起来、模块加载正常、消息通道通（设置页「诊断」用） */
export async function probeOffscreen() {
  if (!offscreenSupported()) return { ok: false, error: 'unsupported' };
  const r = await viaOffscreen('ping', {}, 5000);
  return { ok: !!(r && r.ok && r.pong), error: (r && r.error) || '', hasFsa: !!(r && r.hasFsa) };
}

/* ---------- 面向调用方的高层快捷方式 ---------- */
const MS = 5000;   /* 单次文件操作用不了太久；超时就当失败，绝不让标记交互卡住 */
export const dirStatus = (opts) => fsCall('status', null, { timeoutMs: MS, ...(opts || {}) });
export const dirRead = (name, opts) => fsCall('read', { name }, { timeoutMs: MS, ...(opts || {}) });
export const dirWrite = (name, text, opts) => fsCall('write', { name, text }, { timeoutMs: MS, ...(opts || {}) });
export const dirList = (name, opts) => fsCall('list', { name }, { timeoutMs: MS, ...(opts || {}) });
export const dirExists = (name, opts) => fsCall('exists', { name }, { timeoutMs: MS, ...(opts || {}) });
export const dirForget = () => fsh.forgetDir();

/* ---------- 句柄 / 权限：直接透传（设置页用，必须在扩展页面里调） ---------- */
export const canPickDir = fsh.canPickDir;
export const pickDir = (mode, startIn) => fsh.pickDir(mode || 'readwrite', startIn);
export const getDir = () => fsh.getDir();
export const setDir = h => fsh.setDir(h);
export const forgetDir = () => fsh.forgetDir();
export const permQuery = (h, mode) => fsh.permQuery(h, mode);
export const permRequest = (h, mode) => fsh.permRequest(h, mode);
