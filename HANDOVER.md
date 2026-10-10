# InkRead 项目交接文档（HANDOVER）

> 面向后续接手的人 / AI 代理。读完这份文档应能独立定位代码、改动前端、构建桌面版、跑通测试。
> **English TL;DR** at the bottom of this file.

---

## 0. 一句话说明

**墨读 InkRead** 是一个本地优先的英语精读工具：把英文文本里的每个词按「你的词汇量」着色
（生词红 / 在学蓝 / 已学黑），点词即查（离线词典 + 在线翻译 + TTS 发音），并记录阅读进度与时长。

**同一套前端跑在两个壳里**：
1. **Web 版**：`web/` 纯静态（HTML/CSS/JS，无构建步骤、无 node_modules）；
2. **桌面版**：`wpf/` 的 WPF + WebView2 外壳，把 `web/` 全部**内嵌**进 exe，再通过内置本地服务喂给 WebView2。

---

## 1. 目录与文件职责

```
READ/
├─ web/                       Web 前端（改动 99% 发生在这里）
│  ├─ index.html              唯一页面：顶栏/书架/阅读/词库/生词本/设置 的静态骨架 + 脚本加载顺序
│  ├─ manifest.json,sw.js     PWA（network-first；桌面版同样会注册）
│  ├─ css/app.css             全部样式（走 CSS 变量，主题见 THEMES.md）
│  ├─ js/
│  │  ├─ util.js              DOM/转义/分词/词形还原/防抖；**IR.escLines()**：把字面量 \n 与真换行统一成 <br>
│  │  ├─ storage.js           IndexedDB(openDB/vocabStore/bookStore) + localStorage 设置(IR.settings)
│  │  ├─ dict.js              离线词典（ECDICT 分片：<script> 优先、fetch 兜底；IndexedDB 缓存）
│  │  ├─ themes.js            5 套主题定义与 applyTheme
│  │  ├─ importers.js         TXT/EPUB/MOBI/PDF 解析 → {title,author,cover,text,blocks,toc}
│  │  ├─ translate.js         翻译：6 家官方接口 + 3 家免费内置；签名、apiFetch(本地转发)、多行文本
│  │  ├─ vocab.js             词库页面 + 备份/配置导入导出（IR.exportBackup/exportConfig/importBackup/importConfig）
│  │  ├─ filestore.js         磁盘存档（/__store）：settings.json / vocab.csv+json / books/*.json + 自动挂钩
│  │  ├─ reader.js            书架（分组/进度/状态/详情）、阅读器、TTS(IR.tts)、朗读队列、词表弹窗
│  │  ├─ settings.js          设置页（主题/三色/TTS/翻译接口/存储与存档/数据与配置）
│  │  ├─ desktop-bridge.js    仅桌面版生效的兜底通道：把翻译请求转成 WebMessage 交宿主 HttpClient
│  │  └─ app.js               启动编排（IR.settings.load → openDB → vocab.reload → filestore.init+restore → 挂载 UI）
│  ├─ dict/*.js|json          ECDICT 分片（27 字母分片，共 ~51MB；**必须随仓库分发**）
│  ├─ lib/                    jszip / pdf.js / xlsx（前端依赖，全部本地）
│  ├─ tools/serve.py          网页版本地服务：静态 + /__proxy 翻译转发 + /__store 存档（零依赖，Python 3.6+）
│  ├─ start-server.bat        一键启动 serve.py（纯 ASCII 提示，避免 cmd 编码乱码）
│  └─ tests/                  自动化测试（见 §7）+ 小样本 samples/
├─ wpf/                       桌面壳（.NET 8 / WPF / WebView2）
│  ├─ InkRead.csproj          内嵌 web/** 为 EmbeddedResource（LogicalName=web/...）；无 CopyWeb 拷贝步骤；
│  │                          ApplicationIcon=Assets\InkRead.ico（任务栏/资源管理器图标，7 尺寸 16→256）
│  ├─ Assets/InkRead.ico      应用图标（BMP 16/24/32/48/64 + PNG 128/256）；gen-ico.mjs 生成 + 预览 PNG
│  ├─ MainWindow.xaml         自绘标题栏（深纸色+金徽标，与 web 同色系）+ WebView2 内容区 + Icon
│  ├─ MainWindow.xaml.cs      显式初始化 WebView2、导航、诊断日志、备用 WebMessage 桥、窗口按钮
│  ├─ LocalServer.cs          内置本地服务：静态(内嵌资源) + /__proxy 转发 + /__store 存档 + 固定端口
│  └─ 构建说明.md             构建/发布/排障说明（含白屏排查顺序）
├─ tools/
│  ├─ server-smoke/           LocalServer 的无 GUI 冒烟测试宿主（复用同一份 LocalServer.cs）
│  └─ store-test/             （临时）存档测试目录，测试结束自动清理
├─ plugin/                    浏览器扩展「InkRead Video」（Chrome/Edge/Firefox，MV3；详见其 README）
│  ├─ manifest.json           Chrome/Edge 清单（service_worker）
│  ├─ manifest.firefox.json   Firefox 清单（event page）
│  ├─ build.mjs               打包 → dist/<目标>/ + zip（自带零依赖 ZIP 写入器）
│  ├─ STORE.md                商店上架资料（文案/权限理由/隐私政策模板/截图清单/审核备注）
│  ├─ store/                  商店素材：logo-300 · promo-440x280 · marquee-1400x560 + preview.html（不进 zip）
│  ├─ gen-icons.mjs           （在 tools/ 内）生成 icons/*.png
│  ├─ data/freq-bands.json    高频词表 8107 词（双语料交集清洗，随仓库分发）
│  ├─ src/shared/             纯逻辑：text(分词/词形/等级) · freq(词频分层) · analyze · subs(字幕 json3/srv3) ·
│  │                          vocab-source(本地服务/文件) · vocab-sync(三端合并回写·纯函数) · store ·
│  │                          idb(IndexedDB 句柄持久化) · fsh(File System Access 封装) ·
│  │                          fssync(直连/离屏目录读写客户端) · api(浏览器垫片)
│  ├─ src/background/sw.js    编排：取播放器数据 → 抓字幕 → 分析 → 缓存 + 角标 + 词库回写
│  ├─ src/content/content.js  页面悬浮徽标 + 面板（Shadow DOM 隔离；可拖动、位置记忆）
│  ├─ src/offscreen/          离屏文档（`ir:fs` 中转，绕开 Service Worker 无 DOM 的限制）
│  ├─ src/popup · src/options 弹出面板 / 设置页（含「绑定存档目录」交互）
│  ├─ tests/                  test-core（232）· test-integration（276）· e2e-browser（158，真机 CDP）
│  └─ tools/                  make-freq · calibrate · gen-icons · gen-store · check-syntax
├─ THEMES.md                  主题规范与维护契约
├─ HANDOVER.md                本文件
├─ README.md / README.en.md   中英文说明
└─ (工作区根目录可能放真实电子书样本，已在 .gitignore 中排除)
```

---

## 2. 运行时架构

### Web 版
```
浏览器 ── HTTP ──> tools/serve.py（静态 + /__proxy + /__store）
   │                        │
   ├─ IndexedDB（词库/书籍/词典分片缓存）
   ├─ localStorage（设置 settings）
   └─ 磁盘存档 <我的文档>\InkRead（经 /__store）
浏览器 fetch ──> /__proxy?url=<翻译接口>  ──> 上游（有道/腾讯/…）   ← 绕开 CORS
```
直接双击 `index.html`（`file://`）也能用：词典走 `<script>` 分片、翻译走直连（会受 CORS 限制）、
无 `/__store`（自动退回浏览器存储）——**功能自动降级，不报错**。

### 桌面版
```
InkRead.exe
 ├─ 启动 LocalServer（127.0.0.1，优选端口 17890，占用则顺延）
 ├─ WebView2 显式初始化（CoreWebView2Environment.CreateAsync + EnsureCoreWebView2Async）
 └─ 导航 http://127.0.0.1:17890/index.html
        └─ 前端资源由 LocalServer 从「内嵌资源」读出（磁盘目录仅开发覆盖 INKREAD_WEB_DIR）
```
桌面版因此与网页版**共用同一套前端**，同时桌面独享：本地转发（无需 Python）、磁盘存档、系统代理跟随。

任务栏/资源管理器图标走 `Assets/InkRead.ico`（`ApplicationIcon` + `MainWindow.Icon` 双挂），由
`wpf/tools/gen-ico.mjs` 生成（BMP 16/24/32/48/64 + PNG 128/256，共 7 尺寸），并输出 `InkRead-preview.png` 供肉眼核对。

---

## 3. 数据模型

### IndexedDB（库名 `inkread`，版本 2）
| ObjectStore | keyPath | 记录字段 |
|---|---|---|
| `vocab` | `word` | `{word, display, meaning, status:'unknown'\|'learning'\|'known', source, addedAt, updatedAt}` |
| `books` | `id` | `{id, title, author, description, cover, fmt, text?, blocks:[{t:'p'\|'h'\|'img',text?,src?}], toc, wordCount, addedAt, progress:0..1, grpId?, readState?, readSeconds?, lastOpenedAt?, finishedAt?}` |
| `dict` | `letter` | 词典分片缓存 |

### localStorage `ir.settings`
```
{ theme, colors|null, tts:{voiceURI,rate,autoSpeak},
  api:{ engine:'auto'|引擎名,
        youdao:{key,apiKeys,secret}, baidu:{appid,secretKey,apiKey},
        tencent:{secretId,secretKey,region}, aliyun:{accessKeyId,accessKeySecret,region},
        huawei:{ak,sk,projectId,region}, volcano:{accessKey,secretKey,region},
        proxy:{on,url} },
  reader:{fontSize,lineHeight,fontFamily,autoTranslate},
  shelf:{groups:[{id,name,createdAt}]}, storageDir, tocPinned }
```
> 加载时 `IR.settings.load()` 对 `api.*` **逐家深合并**，缺字段用默认补齐（老配置升级不炸）。

### 磁盘存档（默认 `我的文档\InkRead`）
`settings.json`（＝配置文件格式）、`vocab.csv`（UTF-8 BOM 表格）、`vocab.json`、`books/<id>.json`、`logs/import-error-*.txt`。

---

## 4. 关键机制与不变量（改代码前必读）

1. **本地转发 `GET/POST /__proxy?url=<encoded>`**
   - 白名单（**三处必须同步**）：`LocalServer.AllowHosts/AllowHostSuffixes` ↔ `serve.py ALLOW_HOSTS/ALLOW_HOST_SUFFIXES`
     ↔ `desktop-bridge.js` 的 `HOSTS`。当前为：有道、腾讯、阿里百炼、火山方舟、DeepL(api-free/api)、微软翻译、
     LibreTranslate 公开实例（+ 后缀 `.aliyuncs.com`、`.libretranslate.com`）。
   - **用户自定义白名单**：`<存档目录>/proxy-allow.txt`（每行一个域名；`*.x.com` 后缀匹配），
     用于自建的 LibreTranslate 等；**按目录缓存 5 秒**（改完立即生效）；目录取自请求的 `root` 参数
     （`translate.js → apiFetch()` 会带上 `settings.storageDir`），缺省用默认目录。
   - 前端出口统一在 `translate.js → apiFetch()`：探测 `/__proxy?ping=1` 成功就走转发，否则直连。
   - 新增引擎时四件事一起改：白名单（三处）、`settings.js` 卡片与 `filled`、`translate.js` 实现、`_engines`/auto 链。
2. **翻译引擎选型约定**：优先「只要一个 API Key」的服务（阿里百炼、火山方舟、DeepL、微软、LibreTranslate）；
   不要引入需要 AccessKey/Secret 对或 AK/SK+项目 ID 的接口（已按要求移除百度、华为）——
   **例外**：阿里云机器翻译（alimt，RPC V1/HMAC-SHA1）与火山机器翻译（volmt，火山 V4/HMAC-SHA256）
   是用户 2026-09-30 明确要求加的。
   卡片文案不要写"免费额度"（会过期失真）；被移除的引擎（华为/百度）的介绍文案要一并清干净。
   火山方舟：翻译模型 doubao-seed-translation-* 只支持 `/api/v3/responses`（translation_options 必填、
   source 不支持 auto，固定 en→zh）；其他模型/接入点走 chat/completions。Key 形如 ark-<uuid>-尾缀。
   设置页卡片交互（2026-09-30 用户要求）：徽标三态（未配置灰 / 已配置灰 / 测试通过绿 / 测试未通过红，
   状态存在 `s.api.<name>._testOk`，保存配置时失效）；已配置卡片自动展开但用户手动收起过
   （`_collapsed`）就不再自动展开；密码框有「显示/隐藏」切换（`.pw-box` + `data-pw-eye`）。
2. **磁盘存档 `GET/POST /__store/{ping,read,write,list,open}`**
   - `root` 参数为空 → 默认「我的文档\InkRead」；相对路径禁止 `..`、盘符。
   - 前端 `filestore.js` 通过**挂钩**实现自动存档：包装 `IR.settings.save`、`IR.vocab.mark/removeWord/bulkMark/bulkRemove`、
     `IR.bookStore.put`。新增写库入口时务必也走这几个函数，否则不会被存档。
3. **WebView2 必须显式初始化**——`CreationProperties` 的隐式初始化在部分运行时（Edge 154 + SDK 1.0.2792.45）
   不会触发，表现为「白窗、无报错」。桌面壳一律用 `EnsureCoreWebView2Async` 并记录异常。
4. **桌面端口固定（17890）**——源（origin）稳定，localStorage / IndexedDB 才能跨重启保留。
5. **写入节流**：书籍对象很大（含正文），滚动/翻页时**只在内存更新进度**，`_saveProgressSoon()` 每 3 秒落库一次；
   阅读时长由 `_flushRead()` 每分钟落库，回到书架 / 页面隐藏 / 关闭时补落。新增高频写库逻辑必须同样节流。
6. **文本渲染统一用 `IR.escLines()`**——词典数据里存的是**字面量 `\r\n`**（不是真换行），
   直接 `esc()` 会显示成裸 `\n`（历史 bug）。
7. **书架两套布局**：`shelfFilter === 'all'` → 分组框（`_groupFrameHtml`，框内横排紧凑卡）；
   否则 → 网格（`_cardHtml(b,'full')`）。**卡片信息行高度固定**（书名 2.8em/作者 1.35em/meta 1.5em + 进度条 `margin-top:auto`），
   这样书名长短不同也不会错行——改卡片结构时务必保持固定高度。
8. **书籍难度统计**：`computeBookStats()` 按「已学=已知 / 在学=半知 / 词库外=生词」口径统计**词次**，
   `levelOf(coverage)` 给出 4 档（≥98% 轻松 / 95–98% i+1 理想 / 90–95% 教学挑战 / <90% 挫败）；
   结果缓存在 `book.stats`（含 `topUnknown` 高频生词），点「重新统计」重算。词汇口径依赖 `IR.vocab.statusMap`。
9. **分组带图标**：`shelf.groups = [{id,name,icon,createdAt}]`；`GROUP_ICONS` 为可选图标集（首项为空串＝无图标）；
   新建/编辑统一走 `openGroupDialog()`（不要再用 `prompt()`）。
10. **书架三级视图**（都在 `initShelf`）：分组条 chips（`shelfFilter`）→ `'all'` 渲染分组框（`_groupFrameHtml`）
    → 其他值渲染**封面宫格**（`_coverGridHtml`，`.sg-cell`）。事件全部走**委托**（`listEl.onclick`），
    识别 `[data-detail]` / `[data-goto]` / `[data-folder-menu]` / `.book-card|.sg-cell`。
11. **找书**：`FIND_SOURCES` 内置公版/信息站点，`openFindBook()` 用 `window.open` 打开站点自身搜索页
    （桌面壳的 `NewWindowRequested` 会转交系统浏览器）；自定义 URL 模板存 `settings.finder.custom`，`{q}` 为占位。
    **不应把影子图书馆（盗版）站内置成默认源**；自定义模板已足以让用户自行配置。
12. **UI 细节约定**：接口卡网格用 `align-items:start`（否则展开一张会拉伸同排）；弹窗内容统一走 `.modal`；
    阅读状态用 `.seg` 分段控件；滚动条已全局细圆角化（`*::-webkit-scrollbar`）。
13. **样式全部走 CSS 变量**（`--text/--bg-panel/--accent/--success/--danger` 等），不要写死颜色，
   否则主题切换会破。
14. **密钥永不入库**：API Key 只出现在 localStorage 与用户自己的 `settings.json`；`.gitignore` 排除构建产物与真实电子书。

---

## 5. 常用命令

```bash
# 前端语法检查（无构建步骤，改完刷新即可）
node --check web/js/reader.js

# 网页版：本地服务（静态 + 转发 + 存档）
python web/tools/serve.py 8642          # 或双击 web/start-server.bat

# 桌面版
dotnet build wpf/InkRead.slnx -c Release
wpf/bin/Release/net8.0-windows/InkRead.exe
dotnet publish wpf/InkRead.slnx -c Release -p:PublishSingleFile=true   # 单文件发布

# 无 GUI 冒烟测试内置服务（复用 LocalServer.cs）
cd tools/server-smoke && dotnet run --project server-smoke.csproj -- "..\..\web" "port.txt"

# 全部测试（见 §7）
```

**开发时改前端即时生效**：设 `INKREAD_WEB_DIR=<repo>\web` 再启动 exe，桌面壳会优先读磁盘文件；
不设则读内嵌资源（需重新 `dotnet build` 才会更新）。

**日志位置**：exe 同级 `InkRead.log`（不可写 → `%LOCALAPPDATA%\InkRead\inkread-desktop.log`），
含运行时版本 / 端口 / 内嵌资源数 / 导航结果 / 前端启动自检（`dataset.boot`）。
导入失败详情写入 `<存档目录>\logs\import-error-*.txt`。

---

## 6. 已知坑（踩过的）

| 现象 | 根因 | 处理 |
|---|---|---|
| 桌面版纯白窗口 | WebView2 隐式初始化不触发；或虚拟主机映射（`https://app.inkread`）异常 | 显式初始化；改用 localhost 本地服务加载（已实施） |
| 重开桌面版数据全丢 | LocalServer 曾用随机端口 → origin 变化 → localStorage/IndexedDB 视为新源 | 固定端口 17890 |
| 点词释义显示 `\n` 文本 | 词典分片里是字面量 `\r\n` | `IR.escLines()` |
| 网页版测试翻译必失败 | 浏览器 CORS（上游不返回跨域头） | 走 `/__proxy` 本地转发（桌面自带 / 网页用 start-server） |
| 启动弹「前端启动异常」 | 自检把 `ExecuteScriptAsync` 返回值当普通字符串匹配，但它是 JSON 转义串 | 只取标记值判断（`boot`） |
| 导入失败原因不明 | 报错信息缺上下文 | 报错自带〔文件·大小·扩展名〕/〔MOBI 头部自检〕+ 落盘日志 |
| KF8/AZW3 无法导入 | HUFF/CDIC 压缩未实现（DRM 亦无解） | 明确提示转 EPUB；若要原生支持需先拿到样本再实现 |

---

## 7. 测试清单（改完必跑）

| 命令 | 覆盖 |
|---|---|
| `node web/tests/test-importers.mjs` | TXT 编码 / EPUB / MOBI（PalmDOC 回溯、尾随裁剪、多字节重叠）/ 词表 / 词形还原 / 签名 |
| `node web/tests/test-shelf.mjs` | 阅读状态推断、分组增删改与图标、阅读时长累计、进度节流、分组框/网格渲染、词频统计与阶梯档位 |
| `node web/tests/test-web.mjs`（需先起 serve.py） | **web 端完整性**：index.html 引用资源可达性与 MIME、关键脚本齐全、转发/存档可用、转发白名单、页面结构、新特性就位、CSS 对齐规则 |
| `node web/tests/test-engines.mjs` | 6 引擎注册与分派、auto 链顺序、HMAC/hex/base64 与 Node crypto 对拍、多行渲染 |
| `node web/tests/test-store.mjs`（需先起 serve.py） | 存档：CSV 格式/转义/BOM、settings/书籍读写、路径穿越防护、启动还原、自动挂钩 |
| `node web/tests/test-proxy.mjs`（需先起 serve.py） | 转发：静态 MIME、有道经转发、白名单拦截、目录穿越 |
| `node web/tests/test-bridge.mjs` | 桌面 WebMessage 桥协议（拦截/体/头/状态/错误/并发/中文） |
| `node web/tests/test-dict.mjs` | 词典分片、lookup、词形还原、file:// 降级 |
| `node web/tests/mobi-repro.mjs [文件]` | 用真实 MOBI 复现导入问题（诊断工具） |
| `node plugin/tests/test-core.mjs` | **扩展核心**：分词/词形还原/覆盖率/等级档位/词频分层/站点识别/字幕解析（json3+srv3）/词表解析/三端词库合并回写 |
| `node plugin/tests/test-integration.mjs` | **扩展集成**：两份 manifest 字段与资源存在性、import 依赖图、HTML 资源、离屏文档接线、端到端分析管线、商店资料与品牌图 |
| `node plugin/tests/e2e-browser.mjs` | **扩展真机 E2E**：Edge + CDP 假视频页 + 假墨读本地服务，跑通「注入→抓字幕→比对词库→面板→存档目录直连→胶囊拖动与位置记忆（视频页 + 文章页）→晚渲染正文重试」 |
| `node plugin/tools/check-syntax.mjs` | 扩展源码语法检查（把 .js 按 ESM 解析） |

---

## 8. 待办 / 后续建议

- **KF8(AZW3)/HUFF-CDIC 支持**：需先取得一个真实 KF8 样本才能实现并验证（无样本不写未验证代码）。
- **书架拖拽分组**：目前通过详情弹窗指派分组，可加「拖书到分组条」。
- **分组多级**（文件夹 → 分组）：数据结构预留（`shelf.groups` 数组），加 `parentId` 即可。
- **阅读统计图表**：`readSeconds/lastOpenedAt/finishedAt` 已在记录里，可直接做阅读时长趋势。
- **词典分片瘦身**：`dict/*.js` 与 `dict/*.json` 两份内容重复（51MB），可只留其一。
- **WPF 壳原生菜单**（导入/设置快捷键）与托盘图标。

---

## 9. 约定

- 提交前跑 §7 的相关测试；`node --check` 保证语法。
- 新增第三方前端依赖 → 必须放进 `web/lib/`（本地文件），不要引 CDN（要求离线可用）。
- 新增翻译服务 → 同时改「白名单（两端）+ settings 卡片 + translate.js 实现 + auto 链」。
- 报错文案要能自证问题（带文件/参数/错误码），不要只说「失败」。
- 主题、三色、字号等一律走 CSS 变量与设置项，不要硬编码。

---

## 10. 浏览器扩展 `plugin/`（InkRead Video）

把墨读的「词汇分级」能力延伸到**视频**：在哔哩哔哩 / YouTube 上算一个视频的**生词量、等级、i+1 推荐**。

- **词库来源四选一，优先级从高到低**：
  1. **存档目录直连（推荐，v1.3.0 起）**：用 File System Access 绑定 `存档目录`（就是桌面/网页版写的那个
     `vocab.json` 所在目录），**不需要启动桌面版**，也不依赖任何本地服务。选中目录后句柄存进 IndexedDB
     （`inkread-video` 库 `h` store），Service Worker / 选项页 / 离屏文档三处共用。
  2. **本地服务**：复用本项目 `/__store`（已带 `Access-Control-Allow-Origin: *`），探测 17890（桌面版）/
     8642（网页版）起始端口 → 读 `settings.json` 拿自定义 `storageDir` → 读 `vocab.json`。墨读没开就没有这条。
  3. **导入文件**：墨读没开时的兜底 —— 导入「导出备份 JSON / vocab.json / vocab.csv / 纯词表 txt」。
  4. **旧版导入快照**：更早语法的导入结果直接当词库用。
- **MV3 取目录的坑 & 解**：Service Worker 没有 DOM，`showDirectoryPicker` 只能在有 UI 的上下文调。
  因此：选项页负责 `showDirectoryPicker` 拿句柄 → 写 IndexedDB；后台/离屏要读文件时，**通过离屏文档
  （`chrome.offscreen.createDocument`，reason `BLOBS`，页面 `src/offscreen/offscreen.html`）转发 `ir:fs` 消息**去执行
  `runOp()`（`status|list|exists|read|write`）。三级降级：直连 → 离屏 → 不支持（Firefox）→ 回退到本地服务/导入。
  离屏创建失败带 60s 冷却。目录操作每次 5s 超时。
- **三端同步、共用一个 `vocab.json`**：插件不再只读——在视频里标的词会**回写**到同一个 `vocab.json`。
  - 合并逻辑是纯函数 `plugin/src/shared/vocab-sync.js`（Node 可测）：`marksToChanges()` 把 `iv.marks.words`
    转成变更集 → `upsertEntries()` 按词 `upsert`，已存在的词**只更新 `status` + `updatedAt`、保留其它字段**，
    新词追加完整记录（`source='inkread-plugin'`）。写前用 `wouldChange()` 判空，**无变化不落盘**（幂等）。
    `stringifyVocab()` 用 1 空格缩进，跟 `web/js/filestore.js` 保持字节级一致；`parseVocabText()` 兼容 BOM 与
    `{vocab:[…]}` 两种形状。
  - 网页/桌面版在**每次启动 `restore()`** 时调 `web/js/filestore.js#mergeVocab()`：按每词 `updatedAt` 双向合并，
    磁盘更新→并入本地，本地更新→回写磁盘；没变化不写。设置页另给手动「并入磁盘词库」按钮。
  - 合并口径以 `updatedAt` 新旧为准（新的赢），因此三端任一处改动，其它两端下次启动/手动同步即对齐。
- **写回开关**：选项里 `link.writeBack`（默认开）。关掉就退回只读行为，只读不写。
- **权限与手势限制**：FSA 目录句柄的读写权限需要**用户手势**里 `requestPermission`；Firefox 无 FSA，
  直连那条不可用（离屏文档也不支持），自动降级到本地服务/导入。
- **口径必须一致**：`plugin/src/shared/text.js` 的分词正则、`lemmas()`、覆盖率公式、
  `levelOf()` 四档阈值，全部**逐行照搬** `web/js/util.js` + `web/js/reader.js`。
  改任何一边，另一边必须同步——否则「视频等级」和「书籍难度」就没法比较了。
- **字幕来源**：YouTube 的**真根因是 PoToken** —— 2024–2025 起 `/api/timedtext` 要求 `pot`，
  缺了返回 **200 + 空 body**（不抛错，静默退化成「只读标题」）。取轨优先级：
  `#movie_player.getAudioTrack().captionTracks`（**会话已签名**，多带有效 pot）→ `getPlayerResponse()`
  → `ytInitialPlayerResponse` → 都没有时用 **InnerTube `/youtubei/v1/player`（ANDROID 客户端）** 再要一份。
  每条轨经 `ytCaptionUrls` 生成候选（json3 → 去 pot 标记 → 原样 → 去 pot 原样）逐个试；
  通道为「内容脚本**页面上下文**（同源带 Cookie）→ SW 直连」，页面尝试带 **AbortController 硬超时**、
  SW 侧对消息再加**竞速超时**（**任何一条通道卡住都不挂死分析**）。
  凭据只用 `same-origin` / `omit`，**不用** `include`（对不回显凭据的跨域目标会长时间挂起）。
  面板头部标出 `播放器签名轨/播放器响应/InnerTube 兜底` + `页面通道/后台通道`。
  ⚠️ `ytCaptionUrls` / `stripPot` 是纯函数（`src/shared/subs.js`），改动须同步单测。
  哔哩哔哩走页面内嵌 `__INITIAL_STATE__.videoData.subtitle`（免登录）→ 兜底 `api.bilibili.com/x/player/v2`。
  取播放器数据优先 `scripting.executeScript({world:'MAIN'})`，且**只有真拿到 playerResponse 或签名轨才置 `ok`**，
  否则回退内容脚本扫 `<script>`（FF<128 也走这条）。
- **多行文本必须走 `escLines`**：内容脚本里 `esc()` 只做 HTML 转义；词典释义（ECDICT）里存的是
  **字面量 `\n`（反斜杠+n）**，要用 `escLines()`（与 `web/js/util.js#escLines` 同口径）把字面量 `\n` 与
  真实换行都转成换行，否则界面上会原样显示 `\n`。
- **悬浮胶囊位置**：默认**右侧垂直居中**；`ui.pos={x,y}` 按**视口可用空间比例**存（换分辨率不跑偏）；
  拖动用 pointer 事件 + 4px 抖动阈值区分点击；面板按胶囊所在半屏决定 `data-side`、按上方空间决定
  `data-v`（向上/向下展开）；设置页有「重置到右侧居中」。
- **上架资料在 `plugin/STORE.md`**（文案 / 权限理由 / 隐私政策模板 / 截图清单 / 审核备注 / 提交步骤），
  商店图由 `node plugin/tools/gen-store.mjs` 生成到 `plugin/store/`（300 店标 / 440×280 / 1400×560）。
  `store/` 与 `STORE.md` 属开发件，**不进 zip**（`build.mjs` 只收 `src/`、`icons/`、`data/`）。
- **客观难度**另有一条与用户无关的尺子：`data/freq-bands.json`（8107 词，双语料交集清洗）
  按排名分 5 档算「常用词占比」。阈值由 `tools/calibrate.mjs` 实测校准。
- **无构建步骤**：改完 `src/` 在扩展管理页点「重新加载」。`node plugin/build.mjs` 出 `dist/`。
  提交前跑三个测试：`test-core` / `test-integration` / `e2e-browser`。

---

## English TL;DR

**InkRead** is a local-first intensive English reading app. One front-end (`web/`, plain
HTML/CSS/JS, no build step) runs in two shells: a browser, and a WPF + WebView2 desktop app
(`wpf/`) that embeds the entire front-end into `InkRead.dll`.

Key facts:
- **Desktop**: `LocalServer.cs` serves embedded assets on `http://127.0.0.1:17890` and provides
  `/__proxy` (CORS bypass for translation APIs — whitelist mirrored in `web/tools/serve.py`) and
  `/__store` (on-disk archive under `Documents\InkRead`: `settings.json`, `vocab.csv`, `books/*.json`).
- **WebView2 must be initialised explicitly** (`EnsureCoreWebView2Async`) — implicit init silently
  fails on some runtimes and shows a blank window. The port is fixed so `localStorage`/IndexedDB
  survive restarts.
- **Data model**: IndexedDB stores `vocab` / `books` / `dict`; preferences in `localStorage`
  (`ir.settings`), deep-merged per API provider on load.
- **Gotchas**: dictionary shards store *literal* `\r\n` (use `IR.escLines()`); high-frequency
  progress writes must be throttled (books embed full text); translation needs the local proxy;
  never hardcode colours (use CSS variables / themes).
- **Tests** (`node web/tests/*.mjs`) cover importers, shelf, engines, store, proxy, bridge, dict.
- **Open items**: KF8/HUFF-CDIC support (needs a sample), drag-and-drop grouping, multi-level
  folders, reading-stat charts, deduplicating `dict/*.js` vs `dict/*.json`.
