# InkRead 墨读 · 浏览器扩展上架资料（Chrome / Edge / Firefox）

> 本文是**可直接复制粘贴**的上架材料包。所有字段都按各商店的硬限制校对过（名称 21 字符、简介 ≤132 字符）。
> 简介改动务必**同步 `manifest.json` 与 `manifest.firefox.json`**——集成测试会校验两处都 ≤132 字符。
> 品牌图已由 `node plugin/tools/gen-store.mjs` 生成到 `plugin/store/`；
> 1280×800 宣传图已由 `node plugin/tools/gen-screens.mjs` 用真机截图合成到 `plugin/store/screenshots/`。详见 §8、§9。

---

## 0. 上架前检查清单

- [ ] `node plugin/tools/check-syntax.mjs` → 全过
- [ ] `node plugin/tests/test-core.mjs` / `test-integration.mjs` / `e2e-browser.mjs` → 全过
- [ ] `node plugin/build.mjs` → 产出 `dist/chrome` / `dist/edge` / `dist/firefox` 与三个 zip
- [ ] `node plugin/tools/gen-icons.mjs` → 确认 `plugin/icons/*.png`（16/32/48/128）
- [ ] `node plugin/tools/gen-store.mjs` → 确认 `plugin/store/logo-300.png`、`promo-440x280.png`、`marquee-1400x560.png`
- [x] 截图 3–5 张（1280×800）→ `plugin/store/screenshots/01..03`（`node plugin/tools/gen-screens.mjs`），见 §8.1
- [ ] 隐私政策已托管到一个公开 URL（见 §6，可放仓库 `docs/privacy.html` + GitHub Pages）
- [ ] 支持/主页 URL 可访问
- [ ] `manifest.json` 与 `manifest.firefox.json` 的 `version` 递增
- [ ] 商店后台填写「权限理由」与「数据使用声明」（见 §5、§6）

---

## 1. 通用文案（中 / 英）

### 1.1 名称（Name）
| 场景 | 文案 | 长度 |
|---|---|---|
| manifest / Chrome / Firefox | `InkRead 墨读 — 视频与文章生词量` | 21 |
| Edge 备用（若超限） | `InkRead 墨读 — 生词量分析` | 16 |

### 1.2 一句话简介（Short description，≤132 字符）
**中文（97 字符，直接复用 manifest —— 改动务必同步两份 manifest 并保持 ≤132）**
```
识别哔哩哔哩 / YouTube 视频与网页文章的生词量：联动墨读词库给出 L1–L4 / CEFR / 蓝思三套评级；字幕与正文逐词上色、点词查离线释义与在线翻译，支持 2.4 万条常用词组。
```
**English（118 chars）**
```
Score Bilibili/YouTube subtitles and web articles for new words. Inline colouring, offline dictionary, online translation and 24k phrases — synced with your InkRead word list.
```

### 1.3 详细描述（Detailed description）

**中文**
```
InkRead 墨读 · 视频与文章生词量

看视频、读文章之前，先知道「这对我的词汇量到底难不难」。

■ 它能做什么
· 给哔哩哔哩 / YouTube 视频算「生词量、可理解度、等级」，并判断是否符合 i+1（黄金阅读区）
· 给任意英文网页文章做同样的分析，并支持「阅读模式」
· 三套可切换的评级体系：L1–L4 阶梯（与墨读阅读端同口径）、CEFR A1–C2、蓝思 Lexile
· 客观难度另有一条不依赖你词库的尺子：按 8000+ 高频词排名分层，算「常用词占比」
· ★ 视频字幕可直接逐词标记：YouTube / 哔哩哔哩 播放器字幕上的生词、在学、未收录词一眼可见，对着字幕点词就能查释义、改标记
· 网页正文可「逐词上色」：已学 / 在学 / 生词本一眼可见，不用切到别的工具
· 点词即查离线释义（ECDICT），并可直接标记：生词本 / 在学 / 已学
· ★ 在线翻译：13 个引擎（含免费的谷歌 / 必应 / MyMemory），可直接复用你墨读 PC 端已配好的翻译接口，无需重复填 Key
· ★ 段落翻译：阅读模式里每段一个「译」，一键出中文，译文按句分行
· ★ 词组识别：内置 2.4 万条常用词组，正文里整组画一条不断的线，点词组给整组中文并可「分开看各词」
· 选一段文字即可划线，标记按页面保存
· 视频面板给出「高频生词榜」，告诉你先攻哪些词收益最大
· 胶囊可拖动，位置自动记住；设置页左侧有悬浮目录，长设置一跳到对应项

■ 与「墨读 InkRead」联动（可选，但推荐）
· 扩展可直接读取你墨读的本地词库，让「生词」的判断完全基于你自己的进度
· 在视频/网页里标的词会写回同一个词库文件 —— 桌面版、网页版、扩展版三端共用一个 vocab.json，改一处三端同步
· 支持直接绑定本机「阅读存档目录」，不需要额外安装或启动任何程序
· 三种兜底：本地服务自动探测 / 导入导出文件（JSON、CSV、TXT）/ 独立使用（不联动也能用）

■ 隐私
· 不采集、不上传、不分享任何个人数据
· 所有设置、标记、缓存只存在你本机（浏览器扩展存储 / 你指定的本地文件夹）
· 没有账号、没有追踪、没有广告、没有远程代码

■ 说明
· 词库联动、离线词典为「墨读」桌面/网页版本地提供的能力；扩展自身也可脱离墨读独立使用
· 字幕来自视频站点公开的字幕/CC 接口；没有字幕的视频会明确提示「仅标题/简介」，不会硬凑结果
```

**English**
```
InkRead — vocabulary difficulty for videos and articles

Before you watch or read, know how hard it really is for *your* vocabulary.

WHAT IT DOES
· Scores Bilibili / YouTube videos for new-word count, comprehensibility and level, and tells you whether the video sits in your "i+1" sweet spot
· Does the same for any English web article, with a distraction-free Reading Mode
· Three switchable level systems: L1–L4 steps (same scale as the InkRead reader), CEFR A1–C2, and Lexile
· A vocabulary-independent difficulty axis: 8,000+ high-frequency words ranked into bands to measure "common word ratio"
· NEW: mark words directly on the player subtitles — new / learning / unknown words are colour-coded on YouTube and Bilibili captions, and clicking a word shows its definition and lets you re-mark it
· Inline colouring of the page: known / learning / new words at a glance
· Click any word for an offline dictionary definition, then mark it as new / learning / known
· NEW: online translation across 13 engines (including free Google / Bing / MyMemory), reusing the API keys you already configured in the InkRead desktop app
· NEW: paragraph translation — one "译" button per paragraph in Reading Mode, translated line by line
· NEW: 24,000 built-in phrases — a phrase is underlined as one continuous line; click it for the whole meaning, then "split" to inspect each word
· Select text to highlight; highlights are saved per page
· The video panel ranks the most valuable words to learn first
· Drag the floating badge anywhere; the position is remembered; a floating sidebar in the options page jumps straight to any setting

WORKS WITH INKREAD (optional, recommended)
· Read your existing InkRead vocabulary so "new word" means new *to you*
· Words you mark are written back to the same vocabulary file, so the desktop app, the web app and the extension share one vocabulary and stay in sync
· You can bind your local reading-archive folder directly — no extra app or server required
· Three fallbacks: auto-detected local server / imported files (JSON, CSV, TXT) / standalone mode

PRIVACY
· Collects nothing, uploads nothing, shares nothing
· Settings, marks and cache stay on your device (extension storage or a folder you pick)
· No account, no tracking, no ads, no remote code
```

### 1.4 分类（Category）
| 商店 | 首选 | 备选 |
|---|---|---|
| Chrome Web Store | **Productivity**（生产力工具） | Education |
| Microsoft Edge Add-ons | **Productivity** | Education |
| Firefox AMO | **Other** 或 **Education** | —（AMO 分类较粗） |

### 1.5 其他元数据
| 字段 | 值 |
|---|---|
| 默认语言 | 简体中文（`zh-CN`）；同时提供英文 |
| 收费 | 免费 |
| 含广告 | 否 |
| 账号要求 | 无 |
| 远程代码 | **无**（全部 JS 随包分发；不加载任何远程脚本） |
| 主页 / 支持 URL | `https://github.com/<you>/inkread`（换成你的仓库地址） |
| 隐私政策 URL | `https://<you>.github.io/inkread/privacy.html`（见 §6） |
| 最低浏览器版本 | Chrome/Edge ≥ 109（offscreen API）；Firefox ≥ 109 |

---

## 2. Chrome Web Store 提交字段

| 字段 | 值 / 位置 |
|---|---|
| 上传包 | `dist/chrome-<version>.zip`（或 `plugin/` 目录手动打包） |
| 名称 | `InkRead 墨读 — 视频与文章生词量` |
| 简短说明 | §1.2 中文（99 字符） |
| 详细说明 | §1.3 中文 |
| 类别 | Productivity |
| 语言 | 中文（简体） |
| 图标 128×128 | `plugin/icons/icon128.png` |
| 商店图标 128×128 | 同上（也可用 `store/logo-300.png` 缩） |
| 截图（1–5 张） | **必填**；1280×800 或 640×400，PNG/JPEG，见 §8 |
| 小型宣传图 440×280 | `plugin/store/promo-440x280.png`（选填） |
| 顶部宣传图 1400×560 | `plugin/store/marquee-1400x560.png`（选填） |
| 宣传视频 | 选填（YouTube 链接） |
| 单一用途说明 | §7 |
| 权限理由 | §5（逐条） |
| 数据使用 / 隐私 | §6（勾选「不收集数据」，并按 §6 填写流量说明） |
| 分发范围 | 公开 |
| 可见性 | 公开 |

---

## 3. Microsoft Edge Add-ons 提交字段

| 字段 | 值 / 位置 |
|---|---|
| 上传包 | `dist/edge-<version>.zip`（Edge 用 Chromium 包，无需单独构建） |
| 名称 | `InkRead 墨读 — 视频与文章生词量` |
| 简短说明 | §1.2 中文（99 字符） |
| 详细说明 | §1.3 中文 |
| 类别 | Productivity |
| 语言 | 中文（简体） |
| 商店徽标 300×300 | `plugin/store/logo-300.png` ✅ 已生成 |
| 小宣传图 440×280 | `plugin/store/promo-440x280.png` ✅ 已生成 |
| 大宣传图 1400×560 | `plugin/store/marquee-1400x560.png` ✅ 已生成 |
| 截图（1–10 张） | **必填**；1280×800 或 640×400，推荐 1280×800 |
| 搜索词（可选） | `生词量, 词汇量, 英语学习, YouTube, 哔哩哔哩, CEFR, 蓝思, 分级阅读, 单词` |
| 隐私政策 URL | **必填**（Edge 强制）→ §6 |
| 支持联系人 | 邮箱（必填） |
| 权限理由 | §5 |
| 数据使用 | §6 |
| 备注给审核 | §10 |

---

## 4. Firefox（AMO）提交字段

> Firefox 用**另一份清单** `manifest.firefox.json`（event page 而非 service_worker）。
> 注意：Firefox **不支持** File System Access，因此「绑定存档目录」在 FF 上会自动隐藏，降级为「本地服务 / 导入」两种联动方式。

| 字段 | 值 |
|---|---|
| 上传包 | `dist/firefox-<version>.zip`（或 `.xpi`） |
| 名称 | `InkRead 墨读 — 视频与文章生词量` |
| 摘要（Summary，≤250） | §1.2 中文 |
| 描述 | §1.3 中文（Markdown 可用） |
| 分类 | Other / Education |
| 标签 | `english`, `vocabulary`, `reading`, `youtube`, `bilibili` |
| 图标 128×128 | `plugin/icons/icon128.png` |
| 截图 | 1280×800，1–4 张 |
| 许可证 | 按仓库 LICENSE 选择 |
| 隐私政策 | 必填（AMO 强制）→ §6 |
| 权限说明 | §5（AMO 会在安装时逐条展示） |
| 数据收集声明 | AMO 表单里选「Does not collect data」 |

---

## 5. 权限逐条理由（审核直接看这段）

### 5.1 权限总表（自查用）

扩展只申请了 **4 个权限 + 4 类主机权限**，**每一个都对应一个用户可见的功能**：

| 权限 | 为什么需要 | 审核可直接验证的行为 |
|---|---|---|
| `storage` | 保存设置、词库缓存、词标记与划线、分析结果 | 打开扩展设置页即可看到；不联外网 |
| `scripting` | 在**主世界**读取页面自带的播放器数据（`ytInitialPlayerResponse` / `__INITIAL_STATE__` / `movie_player`），以取得字幕轨 URL | 只在 B 站/YouTube 页面、且只读该页已有的 JSON，不注入第三方代码 |
| `activeTab` | 用户点扩展图标时，分析**当前**这个标签页 | 不点不触发 |
| `offscreen` | MV3 的 Service Worker 没有 DOM，拿不到 File System Access 的目录句柄；需要一个离屏文档来读写**用户主动选择的本地文件夹** | 离屏文档只在「绑定存档目录」后按需创建，纯本地，无网络 |
| `*://*.bilibili.com/*`<br>`*://*.hdslb.com/*` | 读取 B 站页面数据与字幕文件（`aisubtitle.hdslb.com` 等 CDN） | 仅在这些域发起请求 |
| `*://*.youtube.com/*` | 读取 YouTube 页面数据与公开字幕（`/api/timedtext`） | 仅在该域发起请求 |
| `http://127.0.0.1/*`<br>`http://localhost/*` | **可选**联动：探测本机墨读服务（`/__store`）读取词库 | 探测失败即静默跳过，不影响任何功能 |

> 已知移除项：`*://*.googlevideo.com/*` 已在 v1.4.1 删除 —— 该域只承载视频流，本扩展从不下载视频，属无关权限。
>
> **v1.5.0 新增「在线翻译 / 词组」后权限零变化**：13 个翻译引擎（含谷歌、必应、有道、腾讯、DeepL 等）
> 的请求**不直接由扩展发出**，而是经用户本机墨读服务 `http://127.0.0.1:…/__proxy` 转发 ——
> 因此**没有新增任何主机权限**。词组库（950KB）也只由后台 Service Worker 读取，
> **未放进 `web_accessible_resources`**，不暴露给任何网站。

**内容脚本范围**：`youtube.com` / `bilibili.com` 上显示悬浮胶囊与面板；其余 `http(s)` 页面用于「文章分析 / 逐词上色 / 划线与标记」，可在设置里按站点关闭。
⚠️ **如实说明**：因为「网页文章分析」要覆盖用户实际阅读的任意网站，内容脚本声明了 `http(s)://*/*`，**安装时会显示「读取和更改你访问的所有网站上的数据」提示**。这不是主机权限里的 `<all_urls>`，但提示效果相近，必须在理由里讲清楚行为边界（见 5.2 ⑤）。

**不需要的权限（明确说明没申请）**：`tabs`（只用 activeTab）、`webRequest`、`<all_urls>` 主机权限、`downloads`、`cookies`、`history`、`management`。

### 5.2 商店「权限理由」表单 —— 逐框照抄

> 截图里那 5 个必填框（存储理由 / 脚本的合理性 / activeTab 对齐 / 幕后解释 / 主机权限的理由）直接粘贴下面这段；每个框都是独立的一段，无编号依赖。

**① 存储理由（`storage`）**
```
本扩展的唯一用途是：统计视频字幕与网页文章里的英文生词量，并结合用户自己的词库给出可读性评级。storage 权限用于在本地保存：用户设置项、词库缓存、每个视频/文章的分析结果、以及用户在网页上做的词标记与划线。这些数据只保存在用户本机的扩展存储（chrome.storage.local）中，不上传、不共享、不用于广告或行为分析。若不申请该权限，每次打开页面都要重新读取与分析，核心功能无法工作。
```

**② 脚本的合理性（`scripting`）**
```
用于在视频播放页（YouTube / 哔哩哔哩）的主世界执行一小段只读脚本，读取页面自身已加载的播放器数据（YouTube 的 ytInitialPlayerResponse 与 movie_player 实例、B 站的 __INITIAL_STATE__），据此得到该视频公开字幕轨的地址，再统计生词量。该脚本只读取页面里已有的 JSON 与当前页 DOM 文本，不修改页面、不注入任何第三方代码、不加载远程代码；在不支持主世界执行的浏览器上会自动降级为读取页面内联脚本的文本。
```

**③ activeTab 对齐（`activeTab`）**
```
扩展的入口是浏览器工具栏图标。activeTab 保证只有用户主动点击图标时，扩展才临时获得对当前这一个标签页的访问权，用来读取当前页地址并触发一次分析。扩展不会在后台持续读取标签页，也不遍历浏览历史；用户不点击时，扩展不访问任何标签页。
```

**④ 幕后解释（`offscreen`）**
```
MV3 的 Service Worker 没有 DOM，无法使用 File System Access API 获取目录句柄。当用户主动点击「绑定存档目录」并选定一个本地文件夹后，扩展会创建一个离屏文档来读写该文件夹中的 vocab.json（墨读桌面版/网页版共用的词库文件），实现桌面版、网页版、扩展版三端词库同步。离屏文档纯本地运行，不联网、不读取用户未选择的目录；未绑定目录时不会创建。
```

**⑤ 主机权限的理由（`host_permissions`）**
```
主机权限只覆盖三类目标，每条都对应一个具体功能：
1) *://*.youtube.com/*、*://*.bilibili.com/*、*://*.hdslb.com/*：读取这两个视频网站的公开字幕（YouTube 走 /api/timedtext；B 站的字幕文件存放在 hdslb.com 的 CDN 上），用于统计生词量。
2) http://127.0.0.1/*、http://localhost/*：可选功能，联动本机运行的墨读桌面版/网页版，读取用户自己的词库文件；探测不到就静默跳过。
3) 为了让「网页文章分析 / 逐词上色」能工作在用户实际阅读的任意网站上，内容脚本声明了 http://*/* 与 https://*/*。因此安装时会提示「读取和更改你访问的所有网站上的数据」。实际行为是：页面加载后只读取正文可见文本，在本地统计生词量并做上色标注，不与任何服务器通信，数据不离开浏览器，且可在设置页按站点一键关闭。
扩展未申请 <all_urls> 主机权限，也未申请 tabs、webRequest、cookies、history、downloads、management 等权限。v1.4.1 起已移除与功能无关的 googlevideo.com（该域只承载视频流，本扩展不下载视频）。
```

---

## 6. 隐私 / 数据使用声明

### 6.1 表单选择
- **是否收集或使用用户数据**：勾选「**否 / 不收集**」（No / Does not collect）
- **是否出售数据给第三方**：否
- **是否将数据用于与核心功能无关的用途**：否
- **是否使用远程代码**：否

> 说明依据：扩展不设账号、不上报任何标识符、不含分析 SDK、不含广告 SDK。
> 请求只发往 `youtube.com` / `bilibili.com`（取公开字幕）与 `127.0.0.1`（用户本机的墨读服务，可选）。
> 用户设置的本地文件夹只在本地读写，内容不会离开设备。

### 6.2 隐私政策（模板，托管到公开 URL）

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>InkRead 墨读 浏览器扩展 · 隐私政策</title>
  <style>body{max-width:720px;margin:48px auto;padding:0 20px;font:16px/1.75 system-ui,"PingFang SC","Microsoft YaHei",sans-serif;color:#222}
  code{background:#f3f4f6;padding:1px 5px;border-radius:4px}h2{margin-top:1.8em}</style>
</head>
<body>
  <h1>InkRead 墨读 浏览器扩展 · 隐私政策</h1>
  <p>最后更新：<strong>2026-10-10</strong></p>

  <h2>我们收集什么</h2>
  <p><strong>什么也不收集。</strong>本扩展不设账号、不采集设备标识、不采集浏览记录，
     不含任何统计或广告 SDK，不向开发者或任何第三方传输你的数据。</p>

  <h2>数据存在哪里</h2>
  <ul>
    <li>扩展设置、词标记、划线、分析缓存：保存在你本机的浏览器扩展存储
        （<code>chrome.storage.local</code> / <code>browser.storage.local</code>）。</li>
    <li>若你主动「绑定存档目录」，词库文件的读写仅发生在你选择的那个本地文件夹内。</li>
  </ul>

  <h2>会发起哪些网络请求</h2>
  <ul>
    <li>向你正在浏览的视频站点（<code>youtube.com</code> / <code>bilibili.com</code>）
        请求该视频<strong>公开的字幕/CC 文件</strong>，用于统计生词。这是扩展的核心功能。</li>
    <li>可选的本地联动：向 <code>http://127.0.0.1</code> 上的「墨读」本地服务读取你自己的词库；
        该服务不在你的机器上时，扩展会自动跳过，不影响使用。</li>
  </ul>
  <p>除此之外没有任何出站请求。</p>

  <h2>权限用途</h2>
  <ul>
    <li><code>storage</code>：保存设置与标记。</li>
    <li><code>scripting</code>：读取页面自带的播放器数据，以取得字幕轨地址。</li>
    <li><code>activeTab</code>：在你点击扩展图标时分析当前标签页。</li>
    <li><code>offscreen</code>：读写你主动指定的本地文件夹（Service Worker 无 DOM 限制的替代方案）。</li>
  </ul>

  <h2>儿童隐私</h2>
  <p>本扩展不面向 13 岁以下儿童，也不收集其任何信息。</p>

  <h2>变更</h2>
  <p>政策如有变更，会在本页更新「最后更新」日期。</p>

  <h2>联系方式</h2>
  <p>如有疑问，请联系：<strong>你的邮箱</strong></p>
</body>
</html>
```

> 落位建议：`docs/privacy.html` → GitHub Pages → `https://<you>.github.io/inkread/privacy.html`。

---

## 7. 单一用途说明（Chrome 必填）

```
本扩展只有一个用途：帮你判断正在看的视频 / 网页文章对你的词汇量有多难，并让你随手标记单词。

具体功能（都属于同一用途）：
1) 统计视频字幕或网页正文里的生词量，给出等级与 i+1 建议；
2) 在网页正文上按你已有的词库逐词上色，点词查看离线释义；
3) 允许标记/划线，并与你自己的墨读词库同步。

它不用来做广告、追踪、挖矿、劫持搜索或任何跨站行为。
所有权限都只为「读取当前页面的文本并做本地统计」这一用途服务。
```

**Single purpose (English)**
```
This extension has one single purpose: tell you how hard the video or web article you are reading is for your own vocabulary, and let you mark words as you go.

All features serve that purpose:
1) counting new words in video captions or article text and reporting a level / i+1 verdict;
2) colouring page text by your existing vocabulary and showing offline definitions on click;
3) letting you mark/highlight words and sync them with your own InkRead vocabulary.

It is not used for advertising, tracking, search hijacking, or any cross-site behaviour.
Every permission exists only to read the current page's text and analyse it locally.
```

---

## 8. 截图清单（1280×800）

抓图方式：装好扩展 → 打开对应页面 → 浏览器窗口设为 1280×800 → 截图 → 存为 `plugin/store/screenshots/01-*.png`。
（Windows：`Win+Shift+S` 或 `Win+PrtSc`；也可用 DevTools 的「Capture screenshot」精确出图。）

| # | 文件 | 页面 | 要展示的点 | 建议画面 |
|---|---|---|---|---|
| 01 | `01-video-panel.png` | 一个带英文字幕的 YouTube 视频 | 悬浮胶囊 + 展开面板：等级、可理解度环、i+1 结论、指标格、难度条、高频生词榜 | 面板全展开，胶囊在右侧居中 |
| 02 | `02-bilibili.png` | 一个带英文字幕的 B 站视频 | 同样的视频分析（证明双站支持） | 面板 + 视频标题清晰可见 |
| 03 | `03-inline-color.png` | 一篇英文长文（如维基百科/BBC） | **逐词上色**：已学/在学/生词不同色 | 正文中段，三种颜色都能看到 |
| 04 | `04-reader-mode.png` | 同一篇文章 → 阅读模式 | 阅读模式 + 顶部三套评级摘要 | 干净的阅读视图 |
| 05 | `05-dict-card.png` | 文章 → 点一个生词 | 释义卡片：音标、中文释义、标记按钮 | 卡片完整可见 |
| 06 | `06-options.png` | 扩展设置页 | 三套评级切换 + 存档目录绑定 + 词库状态 | 设置页整屏 |

**截图要避免**：真实个人信息（邮箱、书签栏、其它标签页标题）、第三方版权水印。
**推荐加字幕条**：可在图底部加一条深色说明（"① 视频难度一眼可见"），各商店都允许。

---

### 8.1 已生成的宣传图（1280×800）

```bash
node plugin/tools/gen-screens.mjs                                   # 默认读 C:/Users/admin/Pictures/read
node plugin/tools/gen-screens.mjs --src "D:/shots" --out "store/screenshots"
```

用**真机截图**合成：左栏放品牌 + 一句话卖点 + 三条编号要点，右侧截图满幅出血（cover）到上/右/下三边，
图上 ①②③ 金标与左侧要点一一对应；底栏一行「不采集 / 不上传」信任线。零 npm 依赖，调本机 Edge headless 出图。

| 文件 | 对应源图 | 主打卖点 |
|---|---|---|
| `store/screenshots/01-video-panel.png` | 视频页（YouTube） | 等级 + 可理解度环 + i+1 建议 + 高频生词榜 |
| `store/screenshots/02-article-lookup.png` | 文章页 + 点词弹窗 | 逐词上色 + 点词即查释义 |
| `store/screenshots/03-article-ratings.png` | 文章页 + 完整面板 | L1–L4 / CEFR / 蓝思三套评级 + 阅读模式 |

> 换源图只改脚本顶部 `SHOTS`：`src`（文件名）、`pos`（cover 裁切位置）、`points`/`marks`（要点文案 + ①②③ 的**原图百分比**坐标）。
> 圆标坐标由脚本按 cover 变换换算成卡片像素，改裁切时不用手调像素。

---

## 9. 品牌图（已生成）

```
node plugin/tools/gen-store.mjs
```

| 文件 | 尺寸 | 用途 | 状态 |
|---|---|---|---|
| `store/logo-300.png` | 300×300 | Edge 商店徽标 | ✅ 已生成 |
| `store/promo-440x280.png` | 440×280 | Edge 小宣传图 / Chrome 小图 | ✅ 已生成 |
| `store/marquee-1400x560.png` | 1400×560 | Chrome 精选横幅 / Edge 大宣传图 | ✅ 已生成 |
| `icons/icon16|32|48|128.png` | — | 扩展图标 | ✅ 已生成 |

> 品牌图为**无文字抽象图**：深墨底 + 金色品牌标 + 面板示意（可理解度环、难度条、生词词块）。
> 需要带营销文案的版本：两个尺寸走 `store/preview.html` 手工截图；
> 1280×800 的截图位走 `node plugin/tools/gen-screens.mjs`（§8.1，用真机截图合成，可重复生成）。

---

## 10. 给审核的备注（Notes to reviewer）

**中文**
```
感谢审核。本扩展无需登录、无需账号即可体验全部核心功能。

■ 快速测试路径（1 分钟）
1. 打开任意一个带英文字幕的 YouTube 视频（例如 TED 官方频道任意视频）。
2. 页面右侧中部会出现一个悬浮胶囊，显示等级（如 L2）与可理解度百分比；点它展开完整面板。
3. 打开任意英文长文网页（如 en.wikipedia.org 的任意条目），正文会被逐词上色；
   点任意一个带颜色的词，会弹出离线释义卡片。

■ 关于权限
· scripting：用于在页面的主世界读取播放器自带的字幕轨地址（只读，不修改页面）。
· offscreen：仅在你主动点击「绑定存档目录」后创建，用于读写你选择的本地文件夹；
  不绑定时不会创建。
· 主机权限：只覆盖 youtube.com / bilibili.com / hdslb.com（取公开字幕）与 127.0.0.1（可选的本地词库联动）。
  本地服务不存在时会静默跳过，不影响任何功能。

■ 关于隐私
不收集、不上传任何数据；无分析/广告 SDK；无远程代码。

■ 关于词库
「墨读 InkRead」是一个可选的本地配套工具。不安装它也可以正常使用全部核心功能
（此时扩展用内置的高频词表判断难度，并可导入 JSON/CSV/TXT 词表）。
```

**English**
```
No account or sign-in is required. All core features work out of the box.

QUICK TEST (1 minute)
1. Open any YouTube video that has English captions (e.g. any TED talk).
2. A floating badge appears on the right, vertically centred, showing a level (e.g. L2) and a
   comprehensibility percentage. Click it for the full panel.
3. Open any long English article (e.g. an en.wikipedia.org entry). The body text is coloured
   word by word; click any coloured word to see an offline dictionary card.

ABOUT PERMISSIONS
· scripting — reads the caption-track URLs from the page's own player data in the MAIN world. Read-only.
· offscreen — created only after you explicitly pick a local folder; used to read/write that folder.
· Host permissions — limited to youtube.com / bilibili.com / hdslb.com (public captions) and 127.0.0.1
  (optional local vocabulary sync). If no local service is running it is skipped silently.

PRIVACY
Collects nothing, uploads nothing. No analytics, no ads, no remote code.

VOCABULARY
The "InkRead" desktop/web app is an optional local companion. Everything works without it
(a built-in frequency list is used for difficulty, and JSON/CSV/TXT word lists can be imported).
```

---

## 11. 版本更新说明模板（What's new）

**1.5.0**
```
· 新增：视频字幕逐词标记 —— YouTube / 哔哩哔哩 播放器字幕上的生词（红）、在学（蓝）、
        未收录（橙）一眼可见；对着字幕点词即可查离线释义、直接改标记（生词本 / 在学 / 已学）。
        字幕样式两档（着色+下划线 / 半透明底色），可随时在面板或设置里开关
· 新增：在线翻译 —— 13 个引擎（含免费的谷歌 / 必应 / MyMemory），可直接从墨读 PC 端
        导入已配好的接口配置；请求经墨读本地服务转发，不需要新增任何主机权限
· 新增：段落翻译 —— 阅读模式每段末尾一个「译」按钮，一键出中文，译文按句分行
· 新增：词组识别 —— 内置 2.4 万条常用词组，正文中整组画一条不断的线（只在组内有生词时画），
        点词组给整组中文，并支持「分开看各词」
· 新增：设置页左侧悬浮目录，一键跳到对应设置项；新增「翻译接口」「关于」两节
· 优化：词库联动默认对齐墨读 PC 端的存档目录（一键「用墨读的目录」，不再需要手动找文件夹）；
        手动绑定时选择器起点也会跟着墨读目录走，并显示「与墨读是否同一目录」
· 优化：词组匹配只在后台做一次，页面侧拿字符区间渲染（避免两套实现漂移）；
        950KB 的词组库不通过 web_accessible_resources 暴露给网站
```

**1.4.3**
```
· 修复：文章面板「客观难度」一行把加粗标签当纯文本显示（会看到字面的 <b>L4</b>）。
        现在正确显示加粗的评级代码（阅读模式顶部摘要同样修复）
```

**1.4.2**
```
· 修复：扩展更新/重新加载后，已打开页面上的悬浮窗会提示「与扩展后台通信失败」。现在扩展更新
        时会就地重新注入内容脚本，点开扩展图标也会自动重连，无需手动刷新页面
· 修复：部分采用客户端渲染的网站（正文晚于首屏加载，如 ireadworld.com），文章识别不了。
        现在会在正文出现后自动补做分析
· 修复：文章模式下右下角的悬浮窗无法拖动。现在与视频页一致：可拖动、位置自动记忆
```

**1.4.1**
```
· 修复：YouTube 视频字幕抓取 —— 官方自 2024 起对字幕接口要求 PoToken，缺失时返回
        200 + 空 body，导致只能按「标题 + 简介」估算难度。现改为优先取「播放器当前
        会话已签名」的字幕轨，并支持去掉 PoToken 标记重试、InnerTube 兜底与页面上下文抓取
· 修复：字幕抓取通道可能长时间无响应（现已加硬超时，分析不会被挂死）
· 优化：面板头部显示字幕来源（播放器签名轨 / 播放器响应 / InnerTube 兜底）与通道
```

**1.4.0**
```
· 修复：词典释义里的换行在面板/卡片中不换行（现统一渲染为换行）
· 优化：悬浮胶囊默认显示在「右侧垂直居中」，并支持拖动移动、位置自动记忆
· 优化：面板会随胶囊位置自动朝屏幕内侧、向上或向下展开
```

**1.3.0**
```
· 新增：可直接绑定本机「阅读存档目录」，不启动桌面版也能用你的词库
· 新增：标记可写回共享词库 —— 桌面版 / 网页版 / 扩展版三端共用一个词库并保持同步
· 新增：网页正文「逐词上色」与划线的站点开关
```

**1.2.0**（历史）
```
· 新增：网页文章分析与阅读模式
· 新增：L1–L4 / CEFR / 蓝思 三套可切换评级
· 新增：正文逐词上色、点词查释义、词级标记与划线
```

---

## 12. 提交步骤

### Chrome Web Store
1. 打开 <https://chrome.google.com/webstore/devconsole>，付一次性开发者注册费。
2. 「新增项目」→ 上传 `dist/chrome-<version>.zip`。
3. 填 §2 表格；商店信息、隐私、权限理由分别对应 §1/§6/§5。
4. 上传截图与宣传图 → 提交审核（通常 1–3 个工作日）。

### Microsoft Edge Add-ons
1. 打开 <https://partner.microsoft.com/dashboard/microsoftedge>，用 Microsoft 账号注册（免费）。
2. 「新建扩展」→ 上传 `dist/edge-<version>.zip`。
3. 填 §3 表格（**隐私政策 URL 必填**）。
4. 上传 `store/logo-300.png` + 截图 + 宣传图 → 提交（通常 1–7 个工作日）。

### Firefox AMO
1. 打开 <https://addons.mozilla.org/developers/>。
2. 「Submit a New Add-on」→ 上传 `dist/firefox-<version>.zip`，选择「On this site」自托管或公开发布。
3. 填 §4 表格；源码上传可选（本扩展无构建混淆，可直接给源码）。
4. 提交审核。

---

## 13. 常见被拒原因 · 自查

| 风险点 | 我们的情况 | 处置 |
|---|---|---|
| 权限过度 | 只 4 个权限 + 4 类站点级主机权限（已删无关的 googlevideo） | §5.1 已逐条解释 |
| 单一用途不清晰 | 一个用途，功能同源 | §7 已写明 |
| 缺隐私政策 | **Edge / AMO 强制** | §6.2 模板 → 托管后填 URL |
| 远程代码 | 无 | 声明「No remote code」 |
| 主机权限过宽 | 主机权限只到 `youtube/bilibili/hdslb` 与本机；未申请 `<all_urls>` | ⚠️ 内容脚本为「文章分析」覆盖 `http(s)`，会触发「所有网站数据」提示——**必须如实说明**，理由见 §5.2 ⑤ |
| 截图含糊 | 6 张按 §8 | 每张一个明确卖点 |
| 描述含商品/竞品词 | 无 | 文案已避免 |
| 名称暗示官方 | 无 | 「InkRead 墨读」为自有品牌 |

> ⚠️ 唯一需要留意的一点：内容脚本覆盖全部 `http(s)` 页面（用于文章分析/上色），
> 与主机权限无关，但安装提示里会一并显示「读取和更改你访问的所有网站上的数据」。
> 若审核质询，按 §5.2 ⑤ 的说法解释「这是核心功能所必需、只在本地读取正文文本、不外传、可按站点关闭」，
> 并强调主机权限并未申请 `<all_urls>`，网络请求只发往视频站点与本机。
