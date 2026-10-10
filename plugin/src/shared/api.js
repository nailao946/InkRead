/* InkRead Video — 跨浏览器扩展 API 垫片
 *
 * Chrome/Edge 用 chrome.*（MV3 已 Promise 化）；Firefox 暴露 browser.*（同样是 Promise）。
 * 统一取「带 Promise 的那个」，就能一套代码三端跑，不必引入 webextension-polyfill。
 */
/* 注意：本文件允许在 Node 下被 import（单元测试会直接引共享模块），
   因此这里对 chrome/browser 都做存在性检查，绝不在模块求值期直接引用。 */
export const api = (typeof browser !== 'undefined' && browser && browser.runtime)
  ? browser
  : (typeof chrome !== 'undefined' && chrome && chrome.runtime ? chrome : {});

export const IS_FIREFOX = (() => {
  try { return /firefox/i.test(navigator.userAgent); } catch (e) { return false; }
})();

export const IS_CHROMIUM = !IS_FIREFOX;

/** 扩展内资源 URL */
export const url = p => api.runtime.getURL(p);

/* ---- storage 便捷封装（promise 语义） ---- */
export async function get(area, keys) {
  const r = await api.storage[area].get(keys);
  return r || {};
}
export async function set(area, obj) {
  return api.storage[area].set(obj);
}
export async function del(area, keys) {
  return api.storage[area].remove(keys);
}

/* ---- 消息 ---- */
export function send(msg) { return api.runtime.sendMessage(msg); }
export function onMessage(handler) {
  api.runtime.onMessage.addListener((msg, sender, reply) => {
    let done = false;
    const answer = v => { if (!done) { done = true; try { reply(v); } catch (e) { /* 通道已关闭 */ } } };
    const ret = handler(msg, sender, answer);
    if (ret && typeof ret.then === 'function') { ret.then(answer); return true; }   /* 异步：保持通道 */
    if (ret !== undefined) { answer(ret); }
    return false;
  });
}

/** 带超时的 fetch（探测本地服务时避免长时间挂起） */
export async function fetchWithTimeout(input, init, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 3000);
  try {
    return await fetch(input, { ...(init || {}), signal: ctl.signal });
  } finally { clearTimeout(t); }
}
