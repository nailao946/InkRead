using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace InkRead
{
    /// <summary>
    /// 墨读 InkRead 桌面壳。
    ///
    /// 设计要点（自包含，编译即可用）：
    ///  1) 前端资源（web/**）在编译时全部内嵌进 exe，运行时无需 web 文件夹、无需外部依赖；
    ///  2) 内置本地服务（LocalServer）把内嵌资源以 http://127.0.0.1:端口 提供，
    ///     于是 Service Worker / IndexedDB / Web Worker(pdf.js) / TTS 都按标准行为工作；
    ///  3) 同一服务提供 /__proxy 转发端点，前端可借此调用官方翻译接口（绕开 CORS）；
    ///  4) 初始化全程写日志（exe 同级 InkRead.log + %LOCALAPPDATA%\InkRead\），
    ///     失败时弹窗给出具体原因，并在页面内注入诊断信息，避免“纯白窗口、无从下手”。
    ///
    /// 开发时若想直接用磁盘上的 web 目录（改完刷新即生效），
    /// 设置环境变量 INKREAD_WEB_DIR 指向该目录即可。
    /// </summary>
    public partial class MainWindow : Window
    {
        private const string APP_NAME = "InkRead";

        private LocalServer _server;
        private int _navRetried;
        private bool _bootChecked;

        private static readonly HttpClient ProxyHttp = new HttpClient(
            new HttpClientHandler
            {
                AutomaticDecompression = DecompressionMethods.All,
                AllowAutoRedirect = true,
                UseCookies = false
            })
        { Timeout = TimeSpan.FromSeconds(25) };

        private static readonly ConcurrentDictionary<string, HttpClient> ProxyClients =
            new ConcurrentDictionary<string, HttpClient>(StringComparer.OrdinalIgnoreCase);

        public MainWindow()
        {
            Log("===== 启动 =====");
            Log("exe: " + AppContext.BaseDirectory);

            InitializeComponent();
            Log("XAML 已加载");

            // 显式初始化（不用 CreationProperties 的隐式初始化，便于捕获并上报错误）
            Loaded += MainWindow_Loaded;
        }

        /* ---------- 自绘标题栏：窗口按钮 / 最大化适配 ---------- */
        private void btnMin_Click(object sender, RoutedEventArgs e) { WindowState = WindowState.Minimized; }

        private void btnMax_Click(object sender, RoutedEventArgs e)
        {
            WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
        }

        private void btnClose_Click(object sender, RoutedEventArgs e) { Close(); }

        protected override void OnStateChanged(EventArgs e)
        {
            base.OnStateChanged(e);
            bool max = WindowState == WindowState.Maximized;
            if (maxGlyph != null) maxGlyph.Text = max ? "\u2750" : "\u25A1";
            /* 最大化时留出边框厚度，避免内容被窗口边框裁掉 */
            if (rootGrid != null)
                rootGrid.Margin = max
                    ? SystemParameters.WindowResizeBorderThickness
                    : new Thickness(0);
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            var source = PresentationSource.FromVisual(this) as HwndSource;
            source?.AddHook(WndProc);
        }

        private const int WM_GETMINMAXINFO = 0x0024;

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MINMAXINFO
        {
            public POINT ptReserved, ptMaxSize, ptMaxPosition, ptMinTrackSize, ptMaxTrackSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public int dwFlags; }

        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);

        [DllImport("user32.dll")]
        private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

        /// <summary>无边框窗口最大化时贴合「工作区」（不遮任务栏）。</summary>
        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == WM_GETMINMAXINFO)
            {
                MINMAXINFO mmi = (MINMAXINFO)Marshal.PtrToStructure(lParam, typeof(MINMAXINFO));
                IntPtr monitor = MonitorFromWindow(hwnd, 2 /* MONITOR_DEFAULTTONEAREST */);
                if (monitor != IntPtr.Zero)
                {
                    var mi = new MONITORINFO { cbSize = Marshal.SizeOf(typeof(MONITORINFO)) };
                    if (GetMonitorInfo(monitor, ref mi))
                    {
                        RECT work = mi.rcWork, mon = mi.rcMonitor;
                        mmi.ptMaxPosition.X = work.Left - mon.Left;
                        mmi.ptMaxPosition.Y = work.Top - mon.Top;
                        mmi.ptMaxSize.X = work.Right - work.Left;
                        mmi.ptMaxSize.Y = work.Bottom - work.Top;
                    }
                }
                Marshal.StructureToPtr(mmi, lParam, true);
                handled = true;
            }
            return IntPtr.Zero;
        }

        private void SetStatus(string text)
        {
            try { if (statusText != null) statusText.Text = text; } catch { }
        }

        private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
        {
            Loaded -= MainWindow_Loaded;

            /* 1. WebView2 运行时是否可用 */
            try
            {
                string ver = CoreWebView2Environment.GetAvailableBrowserVersionString();
                Log("WebView2 运行时版本: " + ver);
            }
            catch (Exception ex)
            {
                Log("未检测到 WebView2 运行时: " + ex.Message);
                MessageBox.Show(
                    "未检测到 WebView2 运行时，界面无法显示。\n\n" +
                    "Windows 11 通常自带；Windows 10 请到微软官网下载安装“WebView2 Runtime”（免费）。\n\n" +
                    "安装后重新打开本程序即可。\n\n详情：" + ex.Message,
                    "缺少组件", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }

            /* 2. 启动内置服务（内嵌前端资源 + 翻译转发） */
            string url;
            try
            {
                string diskRoot = Environment.GetEnvironmentVariable("INKREAD_WEB_DIR");
                _server = string.IsNullOrWhiteSpace(diskRoot)
                    ? new LocalServer(typeof(LocalServer).Assembly)
                    : new LocalServer(diskRoot, typeof(LocalServer).Assembly);
                Log("本地服务端口: " + _server.Port + "，内嵌资源: " + _server.EmbeddedCount + " 项" +
                    (string.IsNullOrWhiteSpace(diskRoot) ? "" : "，磁盘覆盖目录: " + diskRoot));
                url = "http://127.0.0.1:" + _server.Port + "/index.html";
            }
            catch (Exception ex)
            {
                Log("本地服务启动失败: " + ex);
                MessageBox.Show("本地服务启动失败：\n" + ex.Message + "\n\n详情：" + LogPath(),
                    "启动错误", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }

            /* 3. 显式创建 WebView2 环境并初始化控件 */
            try
            {
                Log("创建 WebView2 环境（用户数据目录: " + GetUserDataFolder() + "）…");
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, GetUserDataFolder());
                Log("环境就绪，初始化 WebView2 控件…");
                await webView.EnsureCoreWebView2Async(env);
                Log("CoreWebView2 就绪");

                webView.CoreWebView2.NewWindowRequested += CoreWebView2_NewWindowRequested;
                webView.CoreWebView2.WebMessageReceived += CoreWebView2_WebMessageReceived;
                webView.CoreWebView2.NavigationCompleted += CoreWebView2_NavigationCompleted;
                webView.CoreWebView2.ProcessFailed += (s2, e2) => Log("WebView2 进程异常: " + e2.ProcessFailedKind);

                Log("导航: " + url);
                SetStatus("正在加载界面…");
                webView.CoreWebView2.Navigate(url);
            }
            catch (Exception ex)
            {
                Log("WebView2 初始化失败: " + ex);
                SetStatus("初始化失败");
                MessageBoxResult r = MessageBox.Show(
                    "WebView2 初始化失败，界面无法显示：\n" + ex.Message +
                    "\n\n是否改用系统默认浏览器打开？（功能相同，只是不在本窗口内）\n\n详情：" + LogPath(),
                    "初始化失败", MessageBoxButton.YesNo, MessageBoxImage.Error);
                if (r == MessageBoxResult.Yes)
                {
                    try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
                }
            }
        }

        private void CoreWebView2_NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            Log("导航完成: success=" + e.IsSuccess + " status=" + e.WebErrorStatus);
            if (e.IsSuccess)
            {
                if (!_bootChecked) { _bootChecked = true; _ = VerifyBootAsync(); }
                return;
            }

            if (_navRetried++ == 0 && _server != null)
            {
                try
                {
                    webView.CoreWebView2.Navigate("http://127.0.0.1:" + _server.Port + "/index.html");
                    return;
                }
                catch { }
            }

            MessageBox.Show(
                "页面加载失败：\n" + e.WebErrorStatus +
                "\n\n本地服务端口 = " + (_server != null ? _server.Port : 0) +
                "\n\n详见日志：" + LogPath(),
                "加载失败", MessageBoxButton.OK, MessageBoxImage.Error);
            SetStatus("页面加载失败");
        }

        /// <summary>
        /// 导航成功后检查前端是否真正启动完成（dataset.boot === '1'）。
        /// 注意：ExecuteScriptAsync 返回的是 JSON 编码后的结果（字符串会被转义成 \"…\"），
        /// 所以这里只取 boot 标记本身判断，不要拿整段 JSON 去匹配未转义的引号。
        /// 未启动完成时把 DOM 诊断信息写进日志并弹窗。
        /// </summary>
        /// <summary>前端启动自检探针（诊断用）：返回 boot/stage/JS 错误/书架渲染情况。</summary>
        private const string ProbeScript =
            "(function(){var d=document.documentElement;" +
            "var e=document.getElementById('js-error');var p=document.getElementById('js-promise-error');" +
            "return JSON.stringify({boot:d.dataset.boot||'',stage:d.dataset.stage||''," +
            "bodyLen:(document.body?document.body.innerHTML.length:0)," +
            "scripts:document.scripts.length," +
            "shelfCells:document.querySelectorAll('#shelfList .sg-cell').length," +
            "folderCells:document.querySelectorAll('#shelfList .folder-cell').length," +
            "newGroupBtn:document.querySelectorAll('#shelfGroups .group-new').length," +
            "store:!!(window.IR&&IR.filestore&&IR.filestore.ready)," +
            "jsErr:e?e.textContent:'',promiseErr:p?p.textContent:''});})()";

        private async Task VerifyBootAsync()
        {
            try
            {
                for (int attempt = 0; attempt < 2; attempt++)
                {
                    await Task.Delay(attempt == 0 ? 6000 : 5000);
                    string boot = await webView.CoreWebView2.ExecuteScriptAsync(
                        "(document.documentElement.dataset.boot || '')");
                    Log("启动自检: boot=" + boot);
                    if (boot != null && boot.IndexOf('1') >= 0)
                    {
                        /* 启动成功也记一条详情：便于确认前端无 JS 错误、书架已渲染 */
                        string ok = await webView.CoreWebView2.ExecuteScriptAsync(ProbeScript);
                        Log("启动自检详情: " + ok);
                        SetStatus("已就绪 · 官方接口走本地转发");
                        return;
                    }   /* 返回形如 "1" */
                }

                string detail = await webView.CoreWebView2.ExecuteScriptAsync(ProbeScript);
                Log("启动自检详情: " + detail);

                MessageBox.Show(
                    "界面已加载但前端未启动完成，诊断信息：\n" + detail +
                    "\n\n详见日志：" + LogPath(),
                    "前端启动异常", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            catch (Exception ex)
            {
                Log("启动自检失败: " + ex.Message);
            }
        }

        /* ---------- 备用通道：desktop-bridge.js 的 WebMessage 转发 ---------- */
        private async void CoreWebView2_WebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string msg;
            try { msg = e.TryGetWebMessageAsString(); }
            catch { return; }
            if (string.IsNullOrEmpty(msg) || msg.IndexOf("\"__ink\"") < 0) return;

            string id = null;
            string reply = null;
            try
            {
                using (JsonDocument doc = JsonDocument.Parse(msg))
                {
                    JsonElement root = doc.RootElement;
                    if (root.ValueKind != JsonValueKind.Object ||
                        !root.TryGetProperty("id", out JsonElement idEl)) return;
                    id = idEl.GetString();
                    reply = await ProxyOneAsync(root);
                }
            }
            catch (Exception ex)
            {
                reply = "{\"id\":" + JsonSerializer.Serialize(id ?? "") +
                        ",\"error\":" + JsonSerializer.Serialize("转发失败: " + ex.Message) + "}";
            }
            if (string.IsNullOrEmpty(reply)) return;

            try { await webView.CoreWebView2.ExecuteScriptAsync("window.__inkProxyDone(" + reply + ");"); }
            catch (Exception ex) { Log("代理回传失败: " + ex.Message); }
        }

        private static async Task<string> ProxyOneAsync(JsonElement root)
        {
            string url = root.GetProperty("url").GetString();
            string method = root.TryGetProperty("method", out var mEl) && !string.IsNullOrEmpty(mEl.GetString())
                ? mEl.GetString().ToUpperInvariant() : "GET";

            byte[] body = null;
            if (root.TryGetProperty("bodyB64", out var bEl))
            {
                string b64 = bEl.GetString();
                if (!string.IsNullOrEmpty(b64)) body = Convert.FromBase64String(b64);
            }

            var request = new HttpRequestMessage(new HttpMethod(method), url);
            string contentType = null;
            if (root.TryGetProperty("headers", out var hEl) && hEl.ValueKind == JsonValueKind.Object)
            {
                foreach (JsonProperty h in hEl.EnumerateObject())
                {
                    if (string.Equals(h.Name, "content-type", StringComparison.OrdinalIgnoreCase))
                    {
                        contentType = h.Value.GetString();
                        continue;
                    }
                    if (!string.Equals(h.Name, "host", StringComparison.OrdinalIgnoreCase) &&
                        !string.Equals(h.Name, "content-length", StringComparison.OrdinalIgnoreCase))
                    {
                        try { request.Headers.TryAddWithoutValidation(h.Name, h.Value.GetString()); } catch { }
                    }
                }
            }
            if (body != null && method != "GET" && method != "HEAD")
            {
                request.Content = new ByteArrayContent(body);
                if (!string.IsNullOrEmpty(contentType))
                    request.Content.Headers.TryAddWithoutValidation("Content-Type", contentType);
            }

            using (var cts = new CancellationTokenSource(TimeSpan.FromSeconds(20)))
            {
                string proxyUrl = root.TryGetProperty("proxy", out var pEl) &&
                                  pEl.ValueKind == JsonValueKind.String ? pEl.GetString() : null;
                HttpClient client = GetClient(proxyUrl);
                using (HttpResponseMessage resp = await client.SendAsync(request, cts.Token))
                {
                    byte[] respBody = null;
                    string respCt = null;
                    if (resp.Content != null)
                    {
                        respCt = resp.Content.Headers.ContentType?.ToString();
                        if (resp.StatusCode != HttpStatusCode.NoContent)
                            respBody = await resp.Content.ReadAsByteArrayAsync(cts.Token);
                    }

                    var sb = new StringBuilder();
                    sb.Append("{\"id\":").Append(JsonSerializer.Serialize(root.GetProperty("id").GetString()));
                    sb.Append(",\"status\":").Append((int)resp.StatusCode);
                    sb.Append(",\"contentType\":").Append(JsonSerializer.Serialize(respCt));
                    sb.Append(",\"bodyB64\":").Append(JsonSerializer.Serialize(
                        respBody == null ? "" : Convert.ToBase64String(respBody)));
                    sb.Append("}");
                    return sb.ToString();
                }
            }
        }

        private static HttpClient GetClient(string proxyUrl)
        {
            if (string.IsNullOrWhiteSpace(proxyUrl)) return ProxyHttp;
            return ProxyClients.GetOrAdd(proxyUrl.Trim(), k => new HttpClient(
                new HttpClientHandler
                {
                    AutomaticDecompression = DecompressionMethods.All,
                    AllowAutoRedirect = true,
                    UseCookies = false,
                    Proxy = MakeProxy(k),
                    UseProxy = true
                })
            { Timeout = TimeSpan.FromSeconds(25) });
        }

        private static IWebProxy MakeProxy(string proxyUrl)
        {
            string u = proxyUrl.Trim();
            if (u.IndexOf("://", StringComparison.Ordinal) < 0) u = "http://" + u;
            try { return new WebProxy(u); } catch { return null; }
        }

        private void CoreWebView2_NewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            try
            {
                var psi = new ProcessStartInfo(e.Uri) { UseShellExecute = true };
                Process.Start(psi);
            }
            catch (Exception ex) { Log("打开外部链接失败: " + ex.Message); }
        }

        private static string GetUserDataFolder()
        {
            string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            return Path.Combine(localApp, APP_NAME, "WebView2");
        }

        /* ---------- 日志：同时写 exe 同级（便于排查）与 %LOCALAPPDATA% ---------- */
        private static string LogPath()
        {
            try
            {
                string beside = Path.Combine(AppContext.BaseDirectory, "InkRead.log");
                File.AppendAllText(beside, "", Encoding.UTF8);   /* 试写，失败则退回用户目录 */
                return beside;
            }
            catch
            {
                string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                return Path.Combine(localApp, APP_NAME, "inkread-desktop.log");
            }
        }

        private static void Log(string line)
        {
            string text = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine;
            try
            {
                File.AppendAllText(LogPath(), text, Encoding.UTF8);
            }
            catch
            {
                try
                {
                    string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                    string p = Path.Combine(localApp, APP_NAME, "inkread-desktop.log");
                    Directory.CreateDirectory(Path.GetDirectoryName(p));
                    File.AppendAllText(p, text, Encoding.UTF8);
                }
                catch { }
            }
            Debug.WriteLine("[InkRead] " + line);
        }

        protected override void OnClosed(EventArgs e)
        {
            try { _server?.Dispose(); } catch { }
            base.OnClosed(e);
        }
    }
}
