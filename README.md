# 墨读 InkRead

**中文** | [English](./README.en.md)

一款**本地优先**的电脑/手机英语精读工具：以你自己的词汇量为基准，给文章里的每个词着色——
**生词红色、在学蓝色、已学黑色**（三色可自定义），点词即查，配合本地 TTS 发音与剑桥词典跳转。

## 目录结构（双端并行）

```
READ/
├── web/          Web 版（HTML/CSS/JS，浏览器直接用，手机电脑通吃）
│   ├── index.html
│   ├── css/ js/ lib/ dict/ tests/ tools/
│   └── start-server.bat
├── wpf/          WPF 桌面版（WPF + WebView2 壳，见 wpf/构建说明.md）
│   ├── InkRead.slnx / InkRead.sln   （VS 2022 17.10+ 用 slnx，老版本用 sln）
│   └── bin/Release/net8.0-windows/InkRead.exe（已编译，可直接双击）
├── THEMES.md     5 套主题规范 + 维护契约（所有端共用）
└── README.md     本文件
```

## 当前版本 v0.5（M1–M4 全量 + 五批用户反馈）

- **5 套主题**，一键切换（规范见 [THEMES.md](./THEMES.md)）
- **词库**：TXT / CSV / Excel(.xls/.xlsx) / 剪贴板导入；导出词表(.xlsx)；三态标记；批量操作；搜索筛选；备份
- **书架**：**分组条 + 分组框 + 封面宫格**（微信读书式）+ 封面（EPUB/MOBI 自动提取）+ 作者 + 词数
  - **分组条**：`全部 / 未分组 / 各分组 / ＋新建分组`，点任意一项进入该分组
  - **分组框**：「全部」视图里每个分组单开一行——框内横排该书封面，框头显示**图标 + 名称 + 本数**；
    点框头即进入该组
  - **封面宫格**：点进分组后是封面宫格（自动换列），每格显示封面、状态徽章、进度条与百分比；
    右上角「⋯」或右键看详情
  - **分组图标**：新建/编辑弹窗里可从 14 个图标中选，或选「无图标」
  - **信息对齐**：书卡的书名固定两行、作者/元信息固定单行 → 无论书名长短，进度条与百分比都在同一水平线上
  - **阅读进度**：加粗圆角渐变进度条（未读灰 / 在读琥珀 / 已读绿）+ **已读百分比**；点进度或「详情 ›」看详情
  - **阅读详情**：封面、**进度条下方即「继续阅读」**、阅读状态用**分段控件**（未读/在读/已读）一键切换、
    紧凑的分组选择、累计阅读时长、最后阅读 / 加入 / 读完时间
  - **词汇难度（阶梯阅读法）**：统计全书 **生词 / 在学 / 已学** 词数 + 词次覆盖率（可理解度），
    自动给出难度档（轻松 ≥98% / 适中 i+1 95–98% / 偏难 90–95% / 困难 <90%）与阅读建议，
    并列出**高频生词 Top 12**（一键加入生词本，先攻高频词收益最大）
  - **🔍 找书**：输入书名/作者，直接打开站点自己的搜索结果（Project Gutenberg、Standard Ebooks、
    Open Library、豆瓣读书），也可在「自定义搜索源」里填任意站点 URL 模板（`{q}` 代表关键词）
- **阅读器**：EPUB / MOBI / TXT / PDF（含书内图片）；三色着色 + 词形还原 + 点词弹窗
- **MOBI 解析（v0.5 深度修复）**：PalmDOC distance 回溯、backward-encoded 尾随条目、多字节字符重叠
  三处规范级 bug 修复——真实 Kindle 书（如 Boundless）**完整导入**：标题/作者/封面/89 章目录/书内图片/68 万字正文
- **离线词典（M3）**：内置 ECDICT（40 万词，25.7MB 分片），点词秒出**音标/词性/中文释义**
  **双击 index.html（file://）也能用**——分片用 `<script>` 标签加载，不依赖 fetch/HTTP
- **阅读模式**：滚动 / 翻页（微信读书式竖向分页 + 点击/键盘/滑动翻页）；**目录**（悬浮三条杠 + 可固定左侧栏）
- **字体排版**：字号 / 行距 / 字体（衬线·无衬线·楷体）实时调整；**阅读进度条**（底部百分比，双模式记忆）
- **全文朗读**：句级队列 + 当前段高亮；**点词自动发音**（可设置开关）
- **划词翻译**（双端可用）：
  - 官方接口 7 家：**有道智云**（三字段 + 签名）、**腾讯云 TMT**（SecretId/SecretKey）、
    **阿里云百炼**（**只要一个 API Key**，默认 qwen-plus）、
    **阿里云机器翻译**（AccessKeyId/AccessKeySecret，需先开通通用版服务）、
    **火山方舟 · 豆包**（**只要一个 API Key**，默认豆包翻译模型走 Responses 接口）、
    **DeepL**（**只要一个 API Key**，Free/Pro 自动判断）、**微软翻译 Azure**（**Key + 可选区域**）
  - 开源自建 1 家：**LibreTranslate**（填地址即可，自建域名可写进 `存档目录/proxy-allow.txt` 放行）
  - 免费内置 3 家（无需 Key）：MyMemory（国内直连）、谷歌、必应
  - 自动模式：已配置的官方接口依次试（有道 → 腾讯 → 阿里百炼 → 阿里机器翻译 → 火山 → DeepL → 微软 → Libre），失败兜底 MyMemory
  - 每张接口卡可折叠，卡内提供**可点击的「去获取 Key ↗」直达链接**；
    展开一张卡不会影响其他卡（网格顶部对齐，不再互相拉伸）
  - **能用 API Key 的都用 API Key**：阿里、火山只需一个 Key，不用 AccessKey/Secret 对
  - **点词自动翻译**：点单词弹窗后自动出译文（设置里可关；带内存缓存）
  - **本地转发（关键）**：浏览器直连翻译接口会被 CORS 拦截。桌面版自带转发服务；
    网页版双击 `web/start-server.bat`（`tools/serve.py`）即可——本地服务提供 `/__proxy` 转发端点，
    前端探测到就自动改走它，因此**网页版同样能用官方接口**
  - 代理访问：桌面版可填本地代理（`http://` 或 `socks5://`）让谷歌/必应走加速线路
  - **桌面版内置 API 转发桥**（js/desktop-bridge.js + 宿主 HttpClient）：官方接口在桌面版不会被浏览器 CORS 拦截；网页版才有 CORS 限制
  - 保存 / 测试按钮 + 连接状态显示（官方接口 + 免费引擎各带独立测试）
- **本篇生词清单**、统计三色（生词红/在学蓝/已学灰）
- **桌面版（M4）**：WPF + WebView2 壳（`wpf/`，内置本地服务加载前端，免 VS 直接双击 exe）
- **PWA（M4）**：`manifest.json` + Service Worker（network-first，改动即时生效），可安装到桌面/手机主屏
- **示例文章**：`index.html?demo=1`

## 如何运行（Web 版）

- **最简单**：双击 `web/index.html`。TXT / EPUB / MOBI / 词库导入 + **离线词典查词** 全部可用。
- **要用官方翻译接口**：双击 `web/start-server.bat`（内置本地转发服务，绕开浏览器 CORS）。
  浏览器不允许网页直连官方接口，本地服务代为转发，因此**网页版也能用官方接口**。
  也可手动运行：`python web/tools/serve.py [端口]`。
- **PDF 导入建议**：同样用 `web/start-server.bat`，PDF 解析 worker 需要 HTTP 环境。
- **快速体验**：打开 `web/index.html?demo=1` 自动载入示例文章。

## 如何运行（WPF 桌面版）

- **免 VS**：直接双击 `wpf/bin/Release/net8.0-windows/InkRead.exe`。
- **自包含**：前端资源（含 51MB 词典分片）在编译时全部内嵌进 `InkRead.dll`，
  运行时不需要 web 文件夹、不依赖外部服务器；内置本地服务把内嵌资源以 `http://127.0.0.1:端口`
  提供给 WebView2（因此 Service Worker / IndexedDB / PDF Worker / TTS 均为标准行为），
  同一服务还提供 `/__proxy` 转发端点，桌面版可直接使用官方翻译接口。
- **要编译**：VS 2022 打开 `wpf/InkRead.slnx`（17.10+）或 `InkRead.sln`（老版本），F5 运行；
  或命令行 `dotnet build wpf/InkRead.slnx -c Release`。
  发布单文件：`dotnet publish wpf/InkRead.slnx -c Release -p:PublishSingleFile=true`。
- **开发时想改前端即时生效**：设环境变量 `INKREAD_WEB_DIR` 指向 `web` 目录，桌面壳会优先用磁盘文件。
- 词库/生词数据存 `%LOCALAPPDATA%\InkRead\WebView2`，升级不丢。
- **启动日志**（排查白屏等问题）：exe 同级 `InkRead.log`（不可写时退回 `%LOCALAPPDATA%\InkRead\inkread-desktop.log`），
  日志含 WebView2 运行时版本、本地服务端口、内嵌资源数、导航结果与前端启动自检。

## 支持的电子书格式与限制

| 格式 | 支持情况 |
|---|---|
| TXT | ✅ 自动识别 UTF-8 / UTF-16 / GBK·GB18030，**不会乱码** |
| EPUB | ✅ 标准 EPUB（ZIP + OPF + XHTML） |
| MOBI | ✅ 无压缩 / PalmDOC LZ77（含 backward 尾随条目、多字节重叠，实测真实 Kindle 书全对）；❌ DRM、HUFF/CDIC（AZW3/KF8）明确提示（建议转 EPUB） |
| PDF | ✅ 有文本层的 PDF；❌ 扫描图片版（无文本层）会明确提示，需 OCR（暂不支持） |

## 数据与隐私

所有数据（词库 / 书架 / 设置 / API key）只保存在**本机**，不联网、不上传。

### 磁盘存档（自动，重开即还原）

桌面版与 `start-server.bat` 启动的网页版都会把进度真正写到磁盘文件（默认 `我的文档\InkRead`，
可在「设置 → 存储与存档」改成任意目录）：

| 文件 | 内容 |
|---|---|
| `vocab.csv` | 生词 / 在学 / 已学全量表格（UTF-8 BOM，Excel、WPS 双击即开） |
| `vocab.json` | 同上，供程序无损读回 |
| `books/<书名>.json` | 每本已导入书籍的正文与阅读进度 |
| `settings.json` | 全部设置 + 翻译接口 Key（**换端只需替换这个文件**） |

写入时机：标记单词状态、批量操作、导入书籍、修改设置（防抖 0.7s）、退出前补存一次；
启动时若本机为空则自动从存档还原。直接双击 `index.html` 时无本地服务，自动退回浏览器存储。

换设备也可用「设置 → 导出配置 / 导入配置」（仅配置）或「导出全量备份 / 恢复全量备份」（含词库）。

## 测试

```
node tests/test-importers.mjs   # 20/20：TXT 编码、EPUB、MOBI（PalmDOC 回溯+尾随裁剪+多字节重叠）、词表、词形还原、翻译签名
node tests/test-bridge.mjs      # 15/15：桌面版 API 转发桥（拦截/请求体/请求头/状态码/错误路径/并发配对/中文安全）
node tests/test-engines.mjs     # 24/24：4 家官方引擎注册与分派、auto 链顺序、只填 API Key 的两家、HMAC 与 Node crypto 对拍
node tests/test-store.mjs       # 18/18：磁盘存档（真实写文件）——CSV 格式/转义/BOM、settings/书籍读写、路径穿越防护、启动还原、自动挂钩
node tests/test-dict.mjs        # 8/8：词典分片、lookup、词形还原、file:// 降级
node tests/test-shelf.mjs       # 46/46：状态推断、分组增删改与图标、阅读时长、进度节流、分组框渲染、词频难度与阶梯档位
node tests/test-web.mjs         # 18/18：web 端完整性（资源可达与 MIME、关键脚本、转发/存档可用、页面结构与新特性就位）
```

> 项目整体架构、模块职责、数据模型与接手须知见 [HANDOVER.md](./HANDOVER.md)（供后续开发者 / AI 快速接续）。

## 推送到 GitHub（首次）

```bash
cd READ
git init -b main
git add .
git commit -m "feat: 墨读 InkRead — Web 版 + WPF 桌面版"
git remote add origin <你的仓库地址>
git push -u origin main
```

`.gitignore` 已排除构建产物（`wpf/bin`、`wpf/obj`）、运行日志、测试临时文件与真实电子书样本
（`web/tests/samples/` 下的小样本为测试所需，已保留）。
