/* 墨读 InkRead — 桌面版 API 桥接（CORS 绕行）
   原理：仅在 WebView2 桌面壳里生效（检测 window.chrome.webview）。
   拦截 window.fetch 里发往翻译 API 域名的跨域请求，改走宿主进程 HttpClient
   转发（无 CORS 限制），结果原样回灌成标准 Response 对象。
   普通浏览器（file:// 或 http://）加载本文件时自动空操作，行为不变。 */
(function () {
  'use strict';
  if (!window.chrome || !window.chrome.webview || !window.fetch) return;

  var HOSTS = [
    'openapi.youdao.com',
    'mt.aliyuncs.com',
    'tmt.tencentcloudapi.com',
    'dashscope.aliyuncs.com',
    'ark.cn-beijing.volces.com',
    'api-free.deepl.com',
    'api.deepl.com',
    'libretranslate.com',
    'edge.microsoft.com',
    'api.cognitive.microsofttranslator.com',
    'translate.googleapis.com',
    'api.mymemory.translated.net'
  ];
  var seq = 0;
  var pending = {};

  function bytesToB64(bytes) {
    var s = '', CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(s);
  }

  window.__inkProxyDone = function (r) {
    var p = pending[r.id];
    if (!p) return;
    delete pending[r.id];
    if (r.error) { p.reject(new TypeError(r.error)); return; }
    var bytes = r.bodyB64 ? Uint8Array.from(atob(r.bodyB64), function (c) { return c.charCodeAt(0); }) : null;
    var status = r.status || 200;
    if (status === 204 || status === 205) bytes = null;
    try { p.resolve(new Response(bytes, { status: status, headers: r.contentType ? { 'Content-Type': r.contentType } : {} })); }
    catch (e) { p.reject(e); }
  };

  var origFetch = window.fetch.bind(window);

  /* 读取设置页里的代理（供宿主转发时使用）；未启用返回空串 */
  function proxyUrl() {
    try {
      var p = window.IR && IR.settings && IR.settings.data && IR.settings.data.api && IR.settings.data.api.proxy;
      if (p && p.on && p.url) return String(p.url).trim();
    } catch (e) { /* 设置未就绪 */ }
    return '';
  }

  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var u = new URL(url, location.href);
      var hit = false;
      for (var i = 0; i < HOSTS.length; i++) if (u.hostname === HOSTS[i]) { hit = true; break; }
      if (!hit) return origFetch(input, init);

      init = init || {};
      var method = (init.method || (input && input.method) || 'GET').toUpperCase();

      /* 收集请求头 */
      var headers = {};
      var hIn = init.headers || (typeof input === 'object' && input && input.headers) || null;
      if (hIn) {
        if (typeof hIn.forEach === 'function') hIn.forEach(function (v, k) { headers[k] = v; });
        else for (var k in hIn) headers[k] = hIn[k];
      }

      /* 归一化请求体为 Uint8Array */
      var bodyP;
      if (init.body != null) {
        if (typeof init.body === 'string') bodyP = Promise.resolve(new TextEncoder().encode(init.body));
        else if (init.body instanceof URLSearchParams) bodyP = Promise.resolve(new TextEncoder().encode(init.body.toString()));
        else if (init.body instanceof Uint8Array) bodyP = Promise.resolve(init.body);
        else if (init.body instanceof ArrayBuffer) bodyP = Promise.resolve(new Uint8Array(init.body));
        else bodyP = Promise.resolve(new TextEncoder().encode(String(init.body)));
      } else if (typeof input === 'object' && input && typeof input.clone === 'function' && input.bodyUsed !== undefined) {
        bodyP = input.clone().arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
      } else bodyP = Promise.resolve(null);

      var id = 'ink' + (++seq);
      return bodyP.then(function (bytes) {
        return new Promise(function (resolve, reject) {
          pending[id] = { resolve: resolve, reject: reject };
          window.chrome.webview.postMessage(JSON.stringify({
            __ink: 1, id: id, url: u.href, method: method,
            headers: headers, bodyB64: bytes ? bytesToB64(bytes) : '',
            proxy: proxyUrl()
          }));
        });
      });
    } catch (e) { return Promise.reject(e); }
  };
})();
