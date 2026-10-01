#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
墨读 InkRead — 本地服务（静态文件 + 翻译 API 转发）

为什么需要它：
  浏览器直连翻译官方接口（有道/腾讯/阿里/火山/DeepL/微软等）会被 CORS 拦截（浏览器安全策略，无法从网页内部绕过）。
  本服务在本地提供一个转发端点 /__proxy?url=<目标地址>，由它代为请求并补上跨域头，
  因此网页版也能正常使用官方翻译接口。

用法：
  python tools/serve.py [端口]        # 默认 8642，端口被占用会自动往后找
  python tools/serve.py 8642 --no-open
或直接双击 web/start-server.bat

转发安全：只允许白名单内的翻译服务域名，避免变成任意开放代理。
代理：请求头 x-ink-proxy（设置页里填的代理地址）优先；未提供时自动读取 Windows 系统代理。
"""

import json
import os
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import mimetypes

try:
    from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
except ImportError:  # Python 3.6 兜底
    import socketserver
    from http.server import HTTPServer, SimpleHTTPRequestHandler

    class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
        daemon_threads = True


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PORT = 8642

# 允许转发的目标域名（与桌面版 LocalServer.cs 保持一致）
ALLOW_HOSTS = {
    'openapi.youdao.com',
    'mt.aliyuncs.com',
    'translate.volcengineapi.com',
    'openspeech.bytedance.com',
    'dictionary.cambridge.org',
    'edge.microsoft.com',
    'api.cognitive.microsofttranslator.com',
    'translate.googleapis.com',
    'api.mymemory.translated.net',
    'tmt.tencentcloudapi.com',
    'dashscope.aliyuncs.com',
    'ark.cn-beijing.volces.com',
    'api-free.deepl.com',
    'api.deepl.com',
    'libretranslate.com',
    'libretranslate.de',
    'translate.terraprint.co',
    'lt.vern.cc',
    'translate.fedilab.app',
}

# 地域化域名的后缀白名单（如 dashscope-intl.aliyuncs.com、LibreTranslate 公开实例）
ALLOW_HOST_SUFFIXES = (
    '.aliyuncs.com',
    '.libretranslate.com',
)

# 用户自定义白名单：<存档目录>/proxy-allow.txt（每行一个域名；*.x.com 表示后缀匹配），按目录缓存 5 秒
_extra_allow = {}   # root -> [hosts]
_extra_allow_at = {}  # root -> timestamp


def extra_allow(root=None):
    import time as _t
    base = os.path.abspath(root) if root else default_store_root()
    now = _t.time()
    if now - _extra_allow_at.get(base, 0) < 5:
        return _extra_allow.get(base, [])
    _extra_allow_at[base] = now
    out = []
    try:
        fp = os.path.join(base, 'proxy-allow.txt')
        if os.path.isfile(fp):
            with open(fp, 'r', encoding='utf-8') as f:
                for line in f:
                    s = line.strip()
                    if s and not s.startswith('#'):
                        out.append(s.lower())
    except Exception:
        out = []
    _extra_allow[base] = out
    return out


def host_allowed(host, root=None):
    if not host:
        return False
    h = host.lower()
    if h in ALLOW_HOSTS:
        return True
    if any(h.endswith(suffix) for suffix in ALLOW_HOST_SUFFIXES):
        return True
    for e in extra_allow(root):
        if e.startswith('*.'):
            if h.endswith(e[1:]):
                return True
        elif h == e:
            return True
    return False

CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, x-ink-proxy',
    'Access-Control-Max-Age': '600',
}

# 转发时忽略的请求头（其余一律透传，与桌面版 LocalServer.cs 的 SkipHeader 保持一致）。
# 为什么用黑名单：各家接口的鉴权头五花八门（x-api-key / X-Api-Resource-Id / Ocp-Apim-Subscription-Key …），
# 白名单漏一个就会变成「本地转发下报缺参数、直连却正常」的隐蔽故障。
SKIP_HEADERS = {
    'host', 'content-length', 'connection', 'accept-encoding',   # accept-encoding 必须去掉：上游压缩后我们不解压
    'origin', 'referer', 'cookie',
    'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'range',
    'te', 'upgrade', 'expect', 'proxy-authorization', 'proxy-connection',
    'content-encoding', 'transfer-encoding',
}

# 默认 User-Agent：部分站点（如剑桥词典的 Cloudflare 防护）会直接拒绝 Python-urllib 的默认 UA
DEFAULT_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

# 需要重写根相对链接的站点（界面内嵌网页用，如剑桥词典小窗）：
# 通过本地转发打开的外部页面，其 <link href="/..."> <script src="/..."> 会指向本地服务而 404，
# 重写成上游绝对地址后即可正常加载样式与脚本。
REWRITE_ROOT_REL_HOSTS = ('dictionary.cambridge.org',)

# 广告检测（反广告墙）脚本域名：剑桥词典靠这些 SDK 判断「广告是否被拦截」，
# 一旦判定被拦（装了广告拦截插件、或 doubleclick 等广告域不可达，国内很常见），
# 就弹整屏「请在本站允许广告」遮罩，把词典内容完全盖住。
# 内嵌小窗里用户无法也不需要「允许广告」，因此在转发时直接剥掉这些纯广告/检测脚本，
# 保留正文、样式与发音资源（已实测：这些脚本不加载时词条内容完全正常）。
AD_DETECT_HOSTS = ('html-load.com', 'polarbyte.com')

# 注入到被代理页面 <head> 开头的兜底脚本（两件事）：
#   ① 给沙箱 iframe 补 localStorage/sessionStorage/document.cookie 垫片（无 allow-same-origin 时访问会抛错）
#   ② 万一将来换了检测方案又弹墙，用「文案 + 整屏遮罩特征」把墙摘掉并恢复滚动
# 注意：桌面版 LocalServer.cs 里有一份等价实现，改动需同步。
AD_DEFUSER_JS = r"""
(function () {
  /* ① 沙箱 iframe（无 allow-same-origin）里访问 storage / cookie 会抛 SecurityError，
        部分检测脚本会把它当成「被拦截」的信号，这里补内存垫片让访问不再抛错。 */
  function shimStorage(name) {
    try { void window[name]; return; } catch (e) {}
    try {
      var m = {};
      var api = {
        getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
        setItem: function (k, v) { m[String(k)] = String(v); },
        removeItem: function (k) { delete m[String(k)]; },
        clear: function () { m = {}; },
        key: function (i) { return Object.keys(m)[i] || null; }
      };
      Object.defineProperty(api, 'length', { get: function () { return Object.keys(m).length; } });
      Object.defineProperty(window, name, { get: function () { return api; }, configurable: true });
    } catch (e) {}
  }
  shimStorage('localStorage'); shimStorage('sessionStorage');
  try { void document.cookie; } catch (e) {
    try {
      Object.defineProperty(document, 'cookie', {
        get: function () { return ''; }, set: function () {}, configurable: true
      });
    } catch (e2) {}
  }

  /* ② 反广告墙清除：只摘「文案像墙 + 像整屏遮罩」的元素，不动正常正文 */
  var WALL_TEXT = /允许广告|本站依靠广告收入|允许我们显示广告|allow ads on|ad block|adblock detected|广告拦截/i;
  function isWall(el) {
    var t = (el.innerText || '').trim();
    if (!t || t.length > 600 || !WALL_TEXT.test(t)) return false;
    var cs = window.getComputedStyle ? getComputedStyle(el) : null;
    var pos = cs ? cs.position : '';
    var z = cs ? parseInt(cs.zIndex || '0', 10) : 0;
    var r = el.getBoundingClientRect();
    var covers = r.width * r.height > innerWidth * innerHeight * 0.25;
    return covers || ((pos === 'fixed' || pos === 'absolute') && z >= 50);
  }
  function sweep() {
    var list = document.querySelectorAll('div,section,aside,dialog,main');
    for (var i = 0; i < list.length; i++) {
      if (isWall(list[i])) {
        try { list[i].remove(); } catch (e) { list[i].style.display = 'none'; }
        try {
          if (document.body && (document.body.style.overflow === 'hidden' || document.body.style.overflowY === 'hidden')) {
            document.body.style.overflow = ''; document.body.style.overflowY = '';
          }
          if (document.documentElement && document.documentElement.style.overflow === 'hidden') {
            document.documentElement.style.overflow = '';
          }
        } catch (e) {}
      }
    }
  }
  var n = 0;
  var iv = setInterval(function () { sweep(); if (++n > 40) clearInterval(iv); }, 1000);
  try { document.addEventListener('DOMContentLoaded', sweep); } catch (e) {}
  sweep();
})();
"""

def strip_ad_detect(html):
    """让广告检测脚本不加载（反广告墙就不会出现）。

    只做「属性级中和」：把命中域名的 src/href 改名成 data-inkread-blocked（标签还在，
    但没有 src 就不会加载），HTML 结构保持原样。
    为什么不做标签级解析：剑桥页面里存在畸形片段（如 src="…6.0.83"" 多一个引号），
    任何依赖标签边界的解析都会被带偏，属性级替换天然免疫。"""
    pat = re.compile(r'(?i)\b(src|href)\s*=\s*(["\'])(https?://[^"\']*)\2')

    def is_blocked(url):
        try:
            h = (urllib.parse.urlparse(url).hostname or '').lower()
        except Exception:
            return False
        return bool(h) and any(h == b or h.endswith('.' + b) for b in AD_DETECT_HOSTS)

    def repl(m):
        if not is_blocked(m.group(3)):
            return m.group(0)
        return 'data-inkread-blocked=' + m.group(2) + m.group(3) + m.group(2)

    return pat.sub(repl, html)


def inject_defuser(html):
    """把兜底脚本插到 <head> 最前面（尽早生效）。"""
    block = '<script data-inkread="defuser">' + AD_DEFUSER_JS + '</script>'
    m = re.search(r'(?i)<head\b[^>]*>', html)
    if m:
        return html[:m.end()] + block + html[m.end():]
    return block + html


def rewrite_root_relative(html, host):
    """把 HTML 里的根相对链接（href="/x"、src="/x"、url(/x)）改写为上游绝对地址。"""
    base = 'https://' + host

    def sub_attr(m):
        quote, path = m.group(2), m.group(3)
        if path.startswith('//'):
            return m.group(0)
        return m.group(1) + '=' + quote + base + path + quote

    out = re.sub(r'(?i)\b(href|src)\s*=\s*(["\'])(/[^"\']*)', sub_attr, html)
    out = re.sub(r'(?i)url\(\s*(["\']?)/(?!/)', lambda m: 'url(' + (m.group(1) or '') + base + '/', out)
    return out


def prepare_embedded_page(html, host):
    """内嵌第三方页面的统一预处理：根相对链接改写 → 剥离广告检测 → 注入兜底脚本。"""
    return inject_defuser(strip_ad_detect(rewrite_root_relative(html, host)))


def default_store_root():
    """默认存档目录：我的文档\\InkRead（与桌面版一致）。"""
    home = os.path.expanduser('~')
    docs = os.path.join(home, 'Documents')
    if not os.path.isdir(docs):
        docs = home
    return os.path.join(docs, 'InkRead')


def system_proxy():
    """读取 Windows 系统代理（Clash/v2rayN 开「系统代理」后生效）。"""
    try:
        import winreg  # 仅 Windows
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r'Software\Microsoft\Windows\CurrentVersion\Internet Settings')
        enabled, _ = winreg.QueryValueEx(key, 'ProxyEnable')
        if not enabled:
            return None
        server, _ = winreg.QueryValueEx(key, 'ProxyServer')
        if not server:
            return None
        # 形如 "127.0.0.1:7890" 或 "http=127.0.0.1:7890;https=127.0.0.1:7891"
        if '=' in server:
            parts = dict(p.split('=', 1) for p in server.split(';') if '=' in p)
            server = parts.get('https') or parts.get('http') or next(iter(parts.values()))
        server = server.strip()
        if '://' not in server:
            server = 'http://' + server
        return server
    except Exception:
        return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        kwargs['directory'] = ROOT
        SimpleHTTPRequestHandler.__init__(self, *args, **kwargs)

    # 安静模式（不刷日志）
    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        SimpleHTTPRequestHandler.end_headers(self)

    def do_OPTIONS(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/__proxy' or parsed.path.startswith('/__store'):
            self.send_response(204)
            for k, v in CORS_HEADERS.items():
                self.send_header(k, v)
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/__proxy':
            return self._proxy()
        if path.startswith('/__store'):
            return self._store()
        SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/__proxy':
            return self._proxy()
        if path.startswith('/__store'):
            return self._store()
        self.send_error(405)

    # ---------- 文件存档（/__store/*） ----------
    def _store(self):
        parsed = urllib.parse.urlparse(self.path)
        action = parsed.path[len('/__store'):].strip('/').lower()
        qs = urllib.parse.parse_qs(parsed.query)

        root = (qs.get('root') or [''])[0].strip().strip('"') or default_store_root()
        try:
            root = os.path.abspath(root)
            os.makedirs(root, exist_ok=True)
        except Exception as e:
            return self._json(400, {'ok': False, 'error': '存档目录不可用: %s' % e})

        if action == 'ping':
            return self._json(200, {'store': 1, 'root': root})

        if action == 'open':
            try:
                if sys.platform.startswith('win'):
                    os.startfile(root)  # noqa: S606
                else:
                    import subprocess
                    subprocess.Popen(['xdg-open', root])
                return self._json(200, {'ok': True, 'root': root})
            except Exception as e:
                return self._json(500, {'ok': False, 'error': str(e)})

        rel = (qs.get('path') or [''])[0]
        rel = urllib.parse.unquote(rel).replace('\\', '/').lstrip('/')
        if not rel or '..' in rel or (len(rel) > 1 and rel[1] == ':'):
            return self._json(400, {'ok': False, 'error': 'path 非法'})
        full = os.path.join(root, *rel.split('/'))

        if action == 'read':
            if not os.path.isfile(full):
                return self._json(404, {'ok': False, 'error': '文件不存在'})
            with open(full, 'rb') as f:
                data = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            for k, v in CORS_HEADERS.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)
            return

        if action == 'write':
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                length = 0
            body = self.rfile.read(length) if length > 0 else b''
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, 'wb') as f:
                f.write(body)
            return self._json(200, {'ok': True, 'file': full, 'bytes': len(body)})

        if action == 'list':
            if not os.path.isdir(full):
                return self._json(200, {'ok': True, 'files': []})
            return self._json(200, {'ok': True, 'files': sorted(os.listdir(full))})

        return self._json(404, {'ok': False, 'error': '未知的存档操作'})

    # ---------- 转发 ----------
    def _proxy(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        # 探针：前端用它判断「本地转发可用」
        if 'ping' in qs:
            return self._json(200, {'inkproxy': 1})

        target = (qs.get('url') or [None])[0]
        if not target:
            return self._json(403, {'error': 'url 缺失'})
        try:
            t = urllib.parse.urlparse(target)
        except Exception:
            return self._json(403, {'error': 'url 非法'})
        # 自定义白名单（proxy-allow.txt）从请求的存档目录读取；缺省用默认目录
        proxy_root = (qs.get('root') or [''])[0] or None
        if t.scheme not in ('http', 'https') or not host_allowed(t.hostname, proxy_root):
            return self._json(403, {'error': 'url 不在白名单内'})

        body = None
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = 0
        if length > 0:
            body = self.rfile.read(length)

        req = urllib.request.Request(target, data=body, method=self.command)
        # 除跳过列表外一律透传（自定义鉴权头如 x-api-key / Ocp-Apim-Subscription-Key 都在其中）
        for name, val in self.headers.items():
            low = name.lower()
            if low in SKIP_HEADERS or low.startswith('sec-') or low.startswith('x-ink'):
                continue
            req.add_header(name, val)
        # 调用方没带 UA 时补一个浏览器 UA（否则 Cloudflare 等会按 UA 直接拒绝）
        if not self.headers.get('User-Agent'):
            req.add_header('User-Agent', DEFAULT_UA)

        proxy = (self.headers.get('x-ink-proxy') or '').strip() or system_proxy()
        handlers = []
        if proxy:
            handlers.append(urllib.request.ProxyHandler({'http': proxy, 'https': proxy}))
        opener = urllib.request.build_opener(*handlers)

        try:
            resp = opener.open(req, timeout=25)
        except urllib.error.HTTPError as e:
            resp = e  # 上游返回 4xx/5xx：把原样响应透传
        except Exception as e:
            return self._json(502, {'error': '转发失败: %s' % e})

        try:
            data = resp.read()
            status = getattr(resp, 'status', None) or getattr(resp, 'code', 200)
            ctype = resp.headers.get('Content-Type') or 'application/json; charset=utf-8'
        finally:
            try:
                resp.close()
            except Exception:
                pass

        # 内嵌网页（如剑桥词典小窗）：根相对资源改写 + 剥离广告检测脚本 + 注入兜底，
        # 样式/脚本才不 404，也不会被「请在本站允许广告」整屏遮罩盖住
        if 'text/html' in ctype.lower() and (t.hostname or '').lower() in REWRITE_ROOT_REL_HOSTS:
            charset = 'utf-8'
            m = re.search(r'charset=([\w-]+)', ctype)
            if m:
                charset = m.group(1)
            text = data.decode(charset, 'replace')
            text = prepare_embedded_page(text, t.hostname)
            data = text.encode('utf-8')
            if 'charset' in ctype.lower():
                ctype = re.sub(r'(?i)charset=[\w-]+', 'charset=utf-8', ctype)
            else:
                ctype = ctype + '; charset=utf-8'

        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()
        if data:
            self.wfile.write(data)

    def _json(self, status, obj):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)


# 明确 MIME（避免某些 Python 版本把 .js 识别成 application/javascript 之外的类型）
Handler.extensions_map.update({
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.html': 'text/html',
    '.wasm': 'application/wasm',
})

mimetypes.add_type('text/javascript', '.js')
mimetypes.add_type('text/css', '.css')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    no_open = '--no-open' in sys.argv
    port = DEFAULT_PORT
    if args:
        try:
            port = int(args[0])
        except ValueError:
            print('端口参数无效，使用默认 %d' % DEFAULT_PORT)

    httpd = None
    for p in range(port, port + 20):
        try:
            httpd = ThreadingHTTPServer(('127.0.0.1', p), Handler)
            port = p
            break
        except OSError:
            continue
    if httpd is None:
        print('端口 %d~%d 都被占用，请先关闭占用程序后重试。' % (port, port + 19))
        input('按回车退出…')
        return

    url = 'http://127.0.0.1:%d/index.html' % port
    print('墨读 InkRead 本地服务已启动：' + url)
    print('（已内置翻译转发，网页版可直接使用官方翻译接口）')
    print('关闭本窗口即停止服务。')

    if not no_open:
        try:
            import webbrowser
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        except Exception:
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止。')
    finally:
        try:
            httpd.server_close()
        except Exception:
            pass


if __name__ == '__main__':
    main()
