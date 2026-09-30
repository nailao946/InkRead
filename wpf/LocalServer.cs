using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace InkRead
{
    /// <summary>
    /// 内置本地服务：静态文件服务 + 翻译 API 转发。
    ///
    /// 为什么需要它：
    ///  1) 用真实 http://127.0.0.1 源加载前端，Service Worker / IndexedDB / Worker 都按标准行为工作；
    ///  2) 浏览器直连翻译官方接口会被 CORS 拦截，这里提供 /__proxy 由宿主代发请求（无 CORS 限制），
    ///     因此桌面版可直接使用有道、百度等官方接口。
    ///
    /// 实现：TcpListener 手写极简 HTTP/1.1（每个连接处理一个请求后关闭），
    /// 避免 HTTP.sys 前缀注册所需的管理员权限/URL ACL。
    /// </summary>
    internal sealed class LocalServer : IDisposable
    {
        /* 只允许转发到这些翻译服务域名（避免被当成任意开放代理）
           HostSuffixes 里的后缀用于「地域化域名」，例如 mt.cn-north-4.myhuaweicloud.com */
        private static readonly string[] AllowHosts =
        {
            "openapi.youdao.com",
            "aip.baidubce.com",
            "edge.microsoft.com",
            "api.cognitive.microsofttranslator.com",
            "translate.googleapis.com",
            "api.mymemory.translated.net",
            "tmt.tencentcloudapi.com",
            "open.volcengineapi.com",
            "mt.aliyuncs.com"
        };

        private static readonly string[] AllowHostSuffixes =
        {
            ".myhuaweicloud.com",   /* 华为云机器翻译：mt.{region}.myhuaweicloud.com */
            ".aliyuncs.com"         /* 阿里云：mt.{region}.aliyuncs.com */
        };

        private static readonly Dictionary<string, string> Mime =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".html", "text/html; charset=utf-8" },
            { ".js", "text/javascript; charset=utf-8" },
            { ".mjs", "text/javascript; charset=utf-8" },
            { ".css", "text/css; charset=utf-8" },
            { ".json", "application/json; charset=utf-8" },
            { ".txt", "text/plain; charset=utf-8" },
            { ".xml", "application/xml; charset=utf-8" },
            { ".png", "image/png" },
            { ".jpg", "image/jpeg" },
            { ".jpeg", "image/jpeg" },
            { ".gif", "image/gif" },
            { ".svg", "image/svg+xml" },
            { ".webp", "image/webp" },
            { ".ico", "image/x-icon" },
            { ".woff", "font/woff" },
            { ".woff2", "font/woff2" },
            { ".ttf", "font/ttf" },
            { ".pdf", "application/pdf" },
            { ".epub", "application/epub+zip" },
            { ".mobi", "application/octet-stream" },
            { ".mp3", "audio/mpeg" },
            { ".wasm", "application/wasm" }
        };

        private const string CorsHeaders =
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
            "Access-Control-Allow-Headers: authorization, content-type, x-ink-proxy\r\n" +
            "Access-Control-Max-Age: 600";

        private readonly string _root;              /* 可选：磁盘开发目录（环境变量 INKREAD_WEB_DIR） */
        private readonly Assembly _asm;             /* 内嵌前端资源所在程序集 */
        private readonly Dictionary<string, string> _embedded;   /* 相对路径 → 资源名 */
        private TcpListener _listener;
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();

        /* 固定首选端口：保证每次启动的源（origin）一致，
           这样 localStorage / IndexedDB 才能跨重启保留（桌面版数据不丢的关键之一） */
        private const int PreferredPort = 17890;

        /* 直连客户端（默认会跟随系统代理）；带代理的客户端按代理地址缓存 */
        private static readonly HttpClient Direct = MakeClient(null);
        private static readonly ConcurrentDictionary<string, HttpClient> Clients =
            new ConcurrentDictionary<string, HttpClient>(StringComparer.OrdinalIgnoreCase);

        public int Port { get; }

        /// <summary>仅从内嵌资源提供前端（自包含，推荐）。</summary>
        public LocalServer(Assembly resources) : this(null, resources) { }

        /// <summary>
        /// diskRoot：可选的磁盘目录（开发覆盖，设了就用它优先）；
        /// resources：内嵌了 web/** 资源的程序集（编译时已打包进 exe）。
        /// </summary>
        public LocalServer(string diskRoot, Assembly resources)
        {
            _root = string.IsNullOrWhiteSpace(diskRoot) ? null : Path.GetFullPath(diskRoot);
            _asm = resources;
            _embedded = resources != null ? BuildResourceMap(resources) : new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            /* 先试固定端口（源稳定 → 本地存储可跨重启），占用则顺延，最后退回系统分配 */
            for (int p = PreferredPort; p < PreferredPort + 20 && _listener == null; p++)
            {
                try
                {
                    var l = new TcpListener(IPAddress.Loopback, p);
                    l.Start();
                    _listener = l;
                }
                catch { /* 端口占用，试下一个 */ }
            }
            if (_listener == null)
            {
                _listener = new TcpListener(IPAddress.Loopback, 0);
                _listener.Start();
            }
            Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            Task.Run(AcceptLoop);
        }

        /// <summary>
        /// 扫描内嵌资源：把 "web/js/app.js"（或 web\js\app.js）这类资源名
        /// 归一化成相对路径 "js/app.js" 作为键。
        /// </summary>
        private static Dictionary<string, string> BuildResourceMap(Assembly asm)
        {
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string name in asm.GetManifestResourceNames())
            {
                string norm = name.Replace('\\', '/');
                int idx = norm.IndexOf("web/", StringComparison.OrdinalIgnoreCase);
                if (idx < 0) continue;
                string rel = norm.Substring(idx + 4);
                if (rel.Length == 0) continue;
                map[rel] = name;
            }
            return map;
        }

        /// <summary>内嵌资源数量（用于启动诊断）。</summary>
        public int EmbeddedCount { get { return _embedded.Count; } }

        private static HttpClient MakeClient(string proxyUrl)
        {
            var handler = new HttpClientHandler
            {
                AutomaticDecompression = DecompressionMethods.All,
                AllowAutoRedirect = true,
                UseCookies = false
            };
            if (!string.IsNullOrWhiteSpace(proxyUrl))
            {
                string u = proxyUrl.Trim();
                if (u.IndexOf("://", StringComparison.Ordinal) < 0) u = "http://" + u;
                try { handler.Proxy = new WebProxy(u); handler.UseProxy = true; }
                catch { handler.UseProxy = false; }   /* 代理地址非法 → 退回直连 */
            }
            return new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(25) };
        }

        private static HttpClient Client(string proxyUrl) =>
            string.IsNullOrWhiteSpace(proxyUrl) ? Direct : Clients.GetOrAdd(proxyUrl.Trim(), MakeClient);

        private async Task AcceptLoop()
        {
            while (!_cts.IsCancellationRequested)
            {
                TcpClient client;
                try { client = await _listener.AcceptTcpClientAsync(); }
                catch { break; }
                _ = Task.Run(() => Handle(client));
            }
        }

        private async Task Handle(TcpClient client)
        {
            using (client)
            {
                try
                {
                    client.NoDelay = true;
                    using (var stream = client.GetStream())
                    {
                        Req req = await ReadRequest(stream);
                        if (req == null) return;
                        if (req.Path.StartsWith("/__proxy", StringComparison.OrdinalIgnoreCase))
                            await HandleProxy(stream, req);
                        else if (req.Path.StartsWith("/__store", StringComparison.OrdinalIgnoreCase))
                            await HandleStore(stream, req);
                        else
                            await ServeStatic(stream, req);
                    }
                }
                catch { /* 连接异常（对端提前关闭等）：忽略 */ }
            }
        }

        /* ---------- 文件存档（/__store/*）：把生词表 / 书籍 / 设置落到磁盘 ----------
           端点（均为本地 127.0.0.1 专用）：
             GET  /__store/ping                         → {store:1, root:"…"}
             GET  /__store/read?root=&path=vocab.json   → 文件内容
             POST /__store/write?root=&path=vocab.csv   → 写入（body 为内容）
             GET  /__store/list?root=&path=books        → {files:[…]}
             POST /__store/open?root=                   → 在资源管理器中打开目录
           root 为空则用默认目录（我的文档\InkRead）。 */
        private static string DefaultStoreRoot()
        {
            string docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            if (string.IsNullOrEmpty(docs))
                docs = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(docs, "InkRead");
        }

        private static string ResolveRoot(string root)
        {
            string dir = string.IsNullOrWhiteSpace(root) ? DefaultStoreRoot() : root.Trim().Trim('"');
            dir = Path.GetFullPath(dir);
            Directory.CreateDirectory(dir);
            return dir;
        }

        /* 相对路径清洗：禁止 ..、盘符、绝对路径 */
        private static bool SafeRelPath(string rel, out string clean)
        {
            clean = null;
            if (string.IsNullOrEmpty(rel)) return false;
            rel = Uri.UnescapeDataString(rel).Replace('\\', '/').TrimStart('/');
            if (rel.IndexOf("..", StringComparison.Ordinal) >= 0) return false;
            if (rel.Length > 1 && rel[1] == ':') return false;
            clean = rel.Replace('/', Path.DirectorySeparatorChar);
            return clean.Length > 0;
        }

        private async Task HandleStore(Stream s, Req req)
        {
            string action = req.Path.Substring("/__store".Length).Trim('/').ToLowerInvariant();
            string rootArg = GetQuery(req.Query, "root");
            string root;
            try { root = ResolveRoot(rootArg); }
            catch (Exception ex)
            {
                await Json(s, 400, "{\"ok\":false,\"error\":\"存档目录不可用: " + JsonEscape(ex.Message) + "\"}");
                return;
            }

            switch (action)
            {
                case "ping":
                    await Json(s, 200, "{\"store\":1,\"root\":\"" + JsonEscape(root) + "\"}");
                    return;

                case "open":
                    try
                    {
                        Process.Start(new ProcessStartInfo("explorer.exe", "\"" + root + "\"") { UseShellExecute = true });
                        await Json(s, 200, "{\"ok\":true,\"root\":\"" + JsonEscape(root) + "\"}");
                    }
                    catch (Exception ex) { await Json(s, 500, "{\"ok\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}"); }
                    return;

                case "read":
                    {
                        if (!SafeRelPath(GetQuery(req.Query, "path"), out string rel))
                        { await Json(s, 400, "{\"ok\":false,\"error\":\"path 非法\"}"); return; }
                        string full = Path.Combine(root, rel);
                        if (!File.Exists(full)) { await Json(s, 404, "{\"ok\":false,\"error\":\"文件不存在\"}"); return; }
                        byte[] body = File.ReadAllBytes(full);
                        await WriteResponse(s, 200, "OK", "application/json; charset=utf-8", body,
                            "Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *");
                        return;
                    }

                case "write":
                    {
                        if (!SafeRelPath(GetQuery(req.Query, "path"), out string rel))
                        { await Json(s, 400, "{\"ok\":false,\"error\":\"path 非法\"}"); return; }
                        string full = Path.Combine(root, rel);
                        Directory.CreateDirectory(Path.GetDirectoryName(full));
                        File.WriteAllBytes(full, req.Body ?? new byte[0]);
                        await Json(s, 200, "{\"ok\":true,\"file\":\"" + JsonEscape(full) + "\",\"bytes\":" +
                            (req.Body == null ? 0 : req.Body.Length) + "}");
                        return;
                    }

                case "list":
                    {
                        if (!SafeRelPath(GetQuery(req.Query, "path"), out string rel))
                        { await Json(s, 400, "{\"ok\":false,\"error\":\"path 非法\"}"); return; }
                        string dir = Path.Combine(root, rel);
                        if (!Directory.Exists(dir)) { await Json(s, 200, "{\"ok\":true,\"files\":[]}"); return; }
                        var names = new List<string>();
                        foreach (string f in Directory.GetFiles(dir)) names.Add(Path.GetFileName(f));
                        await Json(s, 200, "{\"ok\":true,\"files\":" + JsonArray(names) + "}");
                        return;
                    }

                default:
                    await Json(s, 404, "{\"ok\":false,\"error\":\"未知的存档操作\"}");
                    return;
            }
        }

        private static string JsonEscape(string s)
        {
            var sb = new StringBuilder();
            foreach (char c in s ?? "")
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        private static string JsonArray(List<string> items)
        {
            var sb = new StringBuilder("[");
            for (int i = 0; i < items.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append('"').Append(JsonEscape(items[i])).Append('"');
            }
            return sb.Append(']').ToString();
        }

        private static Task Json(Stream s, int status, string json)
        {
            return WriteResponse(s, status, "OK", "application/json; charset=utf-8",
                Encoding.UTF8.GetBytes(json),
                "Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *");
        }

        /* ---------- 请求解析（极简 HTTP/1.1） ---------- */
        private sealed class Req
        {
            public string Method = "GET";
            public string Path = "/";
            public string Query = "";
            public readonly Dictionary<string, string> Headers =
                new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            public byte[] Body = new byte[0];
        }

        private static async Task<Req> ReadRequest(Stream rawStream)
        {
            var stream = new BufferedStream(rawStream, 8192);
            var head = new MemoryStream();
            int state = 0;   /* 匹配 \r\n\r\n */
            while (true)
            {
                int b = stream.ReadByte();
                if (b < 0) return null;
                head.WriteByte((byte)b);
                if (state == 0 && b == '\r') state = 1;
                else if (state == 1 && b == '\n') state = 2;
                else if (state == 2 && b == '\r') state = 3;
                else if (state == 3 && b == '\n') break;
                else state = (b == '\r') ? 1 : 0;
                if (head.Length > 64 * 1024) return null;
            }

            string text = Encoding.UTF8.GetString(head.ToArray());
            string[] lines = text.Split(new[] { "\r\n" }, StringSplitOptions.None);
            if (lines.Length == 0) return null;
            string[] parts = lines[0].Split(' ');
            if (parts.Length < 2) return null;

            var req = new Req { Method = parts[0].ToUpperInvariant() };
            string target = parts[1];
            int q = target.IndexOf('?');
            req.Path = q < 0 ? target : target.Substring(0, q);
            req.Query = q < 0 ? "" : target.Substring(q + 1);

            for (int i = 1; i < lines.Length; i++)
            {
                int c = lines[i].IndexOf(':');
                if (c <= 0) continue;
                req.Headers[lines[i].Substring(0, c).Trim()] = lines[i].Substring(c + 1).Trim();
            }

            if (req.Headers.TryGetValue("Content-Length", out string cl) &&
                int.TryParse(cl, out int len) && len > 0)
            {
                var body = new byte[len];
                int read = 0;
                while (read < len)
                {
                    int n = await stream.ReadAsync(body, read, len - read);
                    if (n <= 0) break;
                    read += n;
                }
                req.Body = body;
            }
            return req;
        }

        /* ---------- 静态文件（优先内嵌资源，磁盘目录仅作开发覆盖） ---------- */
        private async Task ServeStatic(Stream s, Req req)
        {
            if (req.Method != "GET" && req.Method != "HEAD")
            {
                await WriteResponse(s, 405, "Method Not Allowed", "text/plain; charset=utf-8",
                    Encoding.UTF8.GetBytes("405"), null);
                return;
            }

            string rel = Uri.UnescapeDataString(req.Path);
            if (string.IsNullOrEmpty(rel) || rel == "/") rel = "/index.html";
            rel = rel.TrimStart('/').Replace('\\', '/');

            /* 目录穿越防护 */
            if (rel.IndexOf("..", StringComparison.Ordinal) >= 0)
            {
                await WriteResponse(s, 404, "Not Found", "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("404"), null);
                return;
            }

            byte[] body = null;

            /* 1) 开发覆盖：磁盘目录（设置了 INKREAD_WEB_DIR 时） */
            if (_root != null)
            {
                try
                {
                    string full = Path.GetFullPath(Path.Combine(_root, rel.Replace('/', Path.DirectorySeparatorChar)));
                    if (full.StartsWith(_root, StringComparison.OrdinalIgnoreCase) && File.Exists(full))
                        body = File.ReadAllBytes(full);
                }
                catch { /* 读盘失败则回落到内嵌资源 */ }
            }

            /* 2) 内嵌资源（默认路径，自包含） */
            if (body == null && _asm != null && _embedded.TryGetValue(rel, out string resName))
            {
                try
                {
                    using (Stream rs = _asm.GetManifestResourceStream(resName))
                    {
                        if (rs != null)
                        {
                            using (var ms = new MemoryStream())
                            {
                                rs.CopyTo(ms);
                                body = ms.ToArray();
                            }
                        }
                    }
                }
                catch { /* 资源读取失败 → 404 */ }
            }

            if (body == null)
            {
                await WriteResponse(s, 404, "Not Found", "text/plain; charset=utf-8",
                    Encoding.UTF8.GetBytes("404 Not Found: " + rel), null);
                return;
            }

            Mime.TryGetValue(Path.GetExtension(rel), out string ct);
            if (string.IsNullOrEmpty(ct)) ct = "application/octet-stream";

            await WriteResponse(s, 200, "OK", ct, body,
                "Cache-Control: no-store\r\n" +
                "Access-Control-Allow-Origin: *");
        }

        /* ---------- 翻译 API 转发（/__proxy?url=...） ---------- */
        private async Task HandleProxy(Stream s, Req req)
        {
            if (req.Method == "OPTIONS")
            {
                await WriteResponse(s, 204, "No Content", "text/plain; charset=utf-8", new byte[0], CorsHeaders);
                return;
            }

            /* 探测端点：前端用它判断「本地转发可用」 */
            if (req.Query.IndexOf("ping=1", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                await WriteResponse(s, 200, "OK", "application/json; charset=utf-8",
                    Encoding.UTF8.GetBytes("{\"inkproxy\":1}"), CorsHeaders);
                return;
            }

            string target = GetQuery(req.Query, "url");
            if (string.IsNullOrEmpty(target) ||
                !Uri.TryCreate(target, UriKind.Absolute, out Uri uri) ||
                (uri.Scheme != "http" && uri.Scheme != "https") ||
                !IsAllowed(uri.Host))
            {
                await WriteResponse(s, 403, "Forbidden", "application/json; charset=utf-8",
                    Encoding.UTF8.GetBytes("{\"error\":\"url 缺失或不在白名单内\"}"), CorsHeaders);
                return;
            }

            var msg = new HttpRequestMessage(new HttpMethod(req.Method), uri);
            if (req.Body.Length > 0 && req.Method != "GET" && req.Method != "HEAD")
            {
                msg.Content = new ByteArrayContent(req.Body);
                if (req.Headers.TryGetValue("Content-Type", out string ct))
                    msg.Content.Headers.TryAddWithoutValidation("Content-Type", ct);
            }
            foreach (KeyValuePair<string, string> kv in req.Headers)
            {
                string k = kv.Key;
                if (SkipHeader(k)) continue;
                try { msg.Headers.TryAddWithoutValidation(k, kv.Value); } catch { }
            }

            req.Headers.TryGetValue("x-ink-proxy", out string proxyUrl);
            using (HttpResponseMessage resp = await Client(proxyUrl).SendAsync(msg, _cts.Token))
            {
                byte[] body = null;
                string respCt = null;
                if (resp.Content != null)
                {
                    respCt = resp.Content.Headers.ContentType?.ToString();
                    if (resp.StatusCode != HttpStatusCode.NoContent)
                        body = await resp.Content.ReadAsByteArrayAsync();
                }
                await WriteResponse(s, (int)resp.StatusCode, resp.ReasonPhrase ?? "OK",
                    string.IsNullOrEmpty(respCt) ? "application/json; charset=utf-8" : respCt,
                    body, CorsHeaders);
            }
        }

        private static bool SkipHeader(string name)
        {
            return name.Equals("Host", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("Content-Type", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("Connection", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("Accept-Encoding", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("Origin", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("Referer", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("User-Agent", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("Accept", StringComparison.OrdinalIgnoreCase) ||
                   name.Equals("Accept-Language", StringComparison.OrdinalIgnoreCase) ||
                   name.StartsWith("Sec-", StringComparison.OrdinalIgnoreCase) ||
                   name.StartsWith("x-ink", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsAllowed(string host)
        {
            if (string.IsNullOrEmpty(host)) return false;
            foreach (string h in AllowHosts)
                if (string.Equals(host, h, StringComparison.OrdinalIgnoreCase)) return true;
            foreach (string suffix in AllowHostSuffixes)
                if (host.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private static string GetQuery(string query, string key)
        {
            foreach (string pair in query.Split('&'))
            {
                int eq = pair.IndexOf('=');
                if (eq <= 0) continue;
                if (!string.Equals(pair.Substring(0, eq), key, StringComparison.OrdinalIgnoreCase)) continue;
                return Uri.UnescapeDataString(pair.Substring(eq + 1).Replace("+", " "));
            }
            return null;
        }

        /* ---------- 响应 ---------- */
        private static async Task WriteResponse(Stream s, int status, string reason,
            string contentType, byte[] body, string extraHeaders)
        {
            body = body ?? new byte[0];
            var sb = new StringBuilder();
            sb.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason).Append("\r\n");
            sb.Append("Content-Type: ").Append(contentType).Append("\r\n");
            sb.Append("Content-Length: ").Append(body.Length).Append("\r\n");
            sb.Append("Connection: close\r\n");
            if (!string.IsNullOrEmpty(extraHeaders)) sb.Append(extraHeaders).Append("\r\n");
            sb.Append("\r\n");

            byte[] head = Encoding.UTF8.GetBytes(sb.ToString());
            await s.WriteAsync(head, 0, head.Length);
            if (body.Length > 0) await s.WriteAsync(body, 0, body.Length);
            await s.FlushAsync();
        }

        public void Dispose()
        {
            try { _cts.Cancel(); } catch { }
            try { _listener.Stop(); } catch { }
            try { _cts.Dispose(); } catch { }
        }
    }
}
